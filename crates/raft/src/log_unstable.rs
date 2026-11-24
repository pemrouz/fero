// Copyright 2015 The etcd Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This file is a Rust port of etcd raft (go.etcd.io/raft/v3) at commit
// c51f010c851edd0dada5af41bafbf68e54617767. See ../NOTICE (or ../../NOTICE).

//! Port of `log_unstable.go`.

use crate::logger::LoggerRef;
use crate::num::{ix, len64};
use crate::raftpb as pb;
use crate::types::EntryID;
use alloc::vec::Vec;
use core::cmp::{max, min};

/// unstable contains "unstable" log entries and snapshot state that has
/// not yet been written to Storage. The type serves two roles. First, it
/// holds on to new log entries and an optional snapshot until they are
/// handed to a Ready struct for persistence. Second, it continues to
/// hold on to this state after it has been handed off to provide raftLog
/// with a view of the in-progress log entries and snapshot until their
/// writes have been stabilized and are guaranteed to be reflected in
/// queries of Storage. After this point, the corresponding log entries
/// and/or snapshot can be cleared from unstable.
///
/// unstable.entries[i] has raft log position i+unstable.offset.
/// Note that unstable.offset may be less than the highest log
/// position in storage; this means that the next write to storage
/// might need to truncate the log before persisting unstable.entries.
pub(crate) struct Unstable {
    /// the incoming unstable snapshot, if any.
    pub(crate) snapshot: Option<pb::Snapshot>,
    /// all entries that have not yet been written to storage.
    pub(crate) entries: Vec<pb::Entry>,
    /// entries[i] has raft log position i+offset.
    pub(crate) offset: u64,

    /// if true, snapshot is being written to storage.
    pub(crate) snapshot_in_progress: bool,
    /// entries[:offsetInProgress-offset] are being written to storage.
    /// Like offset, offsetInProgress is exclusive, meaning that it
    /// contains the index following the largest in-progress entry.
    /// Invariant: offset <= offsetInProgress
    pub(crate) offset_in_progress: u64,

    pub(crate) logger: LoggerRef,
}

impl Unstable {
    /// maybeFirstIndex returns the index of the first possible entry in entries
    /// if it has a snapshot.
    pub(crate) fn maybe_first_index(&self) -> Option<u64> {
        if let Some(snapshot) = &self.snapshot {
            return Some(snapshot.get_metadata_index() + 1);
        }
        None
    }

    /// maybeLastIndex returns the last index if it has at least one
    /// unstable entry or snapshot.
    pub(crate) fn maybe_last_index(&self) -> Option<u64> {
        let l = len64(&self.entries);
        if l != 0 {
            return Some(self.offset + l - 1);
        }
        if let Some(snapshot) = &self.snapshot {
            return Some(snapshot.get_metadata_index());
        }
        None
    }

    /// maybeTerm returns the term of the entry at index i, if there
    /// is any.
    pub(crate) fn maybe_term(&self, i: u64) -> Option<u64> {
        if i < self.offset {
            if let Some(snapshot) = &self.snapshot {
                if snapshot.get_metadata_index() == i {
                    return Some(snapshot.get_metadata_term());
                }
            }
            return None;
        }

        let last = self.maybe_last_index()?;
        if i > last {
            return None;
        }

        Some(self.entries[ix(i - self.offset)].get_term())
    }

    /// nextEntries returns the unstable entries that are not already in the process
    /// of being written to storage.
    pub(crate) fn next_entries(&self) -> &[pb::Entry] {
        let in_progress = self.offset_in_progress - self.offset;
        if len64(&self.entries) == in_progress {
            return &[];
        }
        &self.entries[ix(in_progress)..]
    }

    /// nextSnapshot returns the unstable snapshot, if one exists that is not already
    /// in the process of being written to storage.
    pub(crate) fn next_snapshot(&self) -> Option<pb::Snapshot> {
        if self.snapshot.is_none() || self.snapshot_in_progress {
            return None;
        }
        self.snapshot.clone()
    }

    /// Go's `nextSnapshot() != nil`, without the copy.
    pub(crate) fn has_next_snapshot(&self) -> bool {
        self.snapshot.is_some() && !self.snapshot_in_progress
    }

    /// acceptInProgress marks all entries and the snapshot, if any, in the unstable
    /// as having begun the process of being written to storage. The entries/snapshot
    /// will no longer be returned from nextEntries/nextSnapshot. However, new
    /// entries/snapshots added after a call to acceptInProgress will be returned
    /// from those methods, until the next call to acceptInProgress.
    pub(crate) fn accept_in_progress(&mut self) {
        if let Some(last) = self.entries.last() {
            // NOTE: +1 because offsetInProgress is exclusive, like offset.
            self.offset_in_progress = last.get_index() + 1;
        }
        if self.snapshot.is_some() {
            self.snapshot_in_progress = true;
        }
    }

    /// stableTo marks entries up to the entry with the specified (index, term) as
    /// being successfully written to stable storage.
    ///
    /// The method should only be called when the caller can attest that the entries
    /// can not be overwritten by an in-progress log append. See the related comment
    /// in newStorageAppendRespMsg.
    pub(crate) fn stable_to(&mut self, id: EntryID) {
        let Some(gt) = self.maybe_term(id.index) else {
            // Unstable entry missing. Ignore.
            self.logger.infof(format_args!("entry at index {} missing from unstable log; ignoring", id.index));
            return;
        };
        if id.index < self.offset {
            // Index matched unstable snapshot, not unstable entry. Ignore.
            self.logger.infof(format_args!("entry at index {} matched unstable snapshot; ignoring", id.index));
            return;
        }
        if gt != id.term {
            // Term mismatch between unstable entry and specified entry. Ignore.
            // This is possible if part or all of the unstable log was replaced
            // between that time that a set of entries started to be written to
            // stable storage and when they finished.
            self.logger.infof(format_args!(
                "entry at (index,term)=({},{}) mismatched with entry at ({},{}) in unstable log; ignoring",
                id.index, id.term, id.index, gt
            ));
            return;
        }
        let num = id.index + 1 - self.offset;
        self.entries.drain(..ix(num));
        self.offset = id.index + 1;
        self.offset_in_progress = max(self.offset_in_progress, self.offset);
        self.shrink_entries_array();
    }

    /// shrinkEntriesArray discards the underlying array used by the entries slice
    /// if it isn't being used. This avoids holding references to a bunch of
    /// potentially large entries that aren't needed anymore. Simply clearing the
    /// entries wouldn't be safe because clients might still be using them.
    fn shrink_entries_array(&mut self) {
        if self.entries.is_empty() {
            self.entries = Vec::new();
        }
    }

    pub(crate) fn stable_snap_to(&mut self, i: u64) {
        if let Some(snapshot) = &self.snapshot {
            if snapshot.get_metadata_index() == i {
                self.snapshot = None;
                self.snapshot_in_progress = false;
            }
        }
    }

    pub(crate) fn restore(&mut self, s: &pb::Snapshot) {
        self.offset = s.get_metadata_index() + 1;
        self.offset_in_progress = self.offset;
        self.entries = Vec::new();
        self.snapshot = Some(s.clone());
        self.snapshot_in_progress = false;
    }

    pub(crate) fn truncate_and_append(&mut self, ents: &[pb::Entry]) {
        let from_index = ents[0].get_index();
        if from_index == self.offset + len64(&self.entries) {
            // fromIndex is the next index in the u.entries, so append directly.
            self.entries.extend_from_slice(ents);
        } else if from_index <= self.offset {
            self.logger.infof(format_args!("replace the unstable entries from index {from_index}"));
            // The log is being truncated to before our current offset
            // portion, so set the offset and replace the entries.
            self.entries = ents.to_vec();
            self.offset = from_index;
            self.offset_in_progress = self.offset;
        } else {
            // Truncate to fromIndex (exclusive), and append the new entries.
            self.logger.infof(format_args!("truncate the unstable entries before index {from_index}"));
            self.must_check_out_of_bounds(self.offset, from_index);
            self.entries.truncate(ix(from_index - self.offset));
            self.entries.extend_from_slice(ents);
            // Only in-progress entries before fromIndex are still considered to be
            // in-progress.
            self.offset_in_progress = min(self.offset_in_progress, from_index);
        }
    }

    /// slice returns the entries from the unstable log with indexes in the range
    /// [lo, hi). The entire range must be stored in the unstable log or the method
    /// will panic.
    pub(crate) fn slice(&self, lo: u64, hi: u64) -> &[pb::Entry] {
        self.must_check_out_of_bounds(lo, hi);
        &self.entries[ix(lo - self.offset)..ix(hi - self.offset)]
    }

    /// u.offset <= lo <= hi <= u.offset+len(u.entries)
    fn must_check_out_of_bounds(&self, lo: u64, hi: u64) {
        if lo > hi {
            self.logger.panicf(format_args!("invalid unstable.slice {lo} > {hi}"));
        }
        let upper = self.offset + len64(&self.entries);
        if lo < self.offset || hi > upper {
            self.logger.panicf(format_args!("unstable.slice[{},{}) out of bound [{},{}]", lo, hi, self.offset, upper));
        }
    }
}
