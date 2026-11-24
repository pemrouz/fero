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

//! Port of `log.go`.
//!
//! Go hands out slices that share the log's memory (`[]*pb.Entry`). Here a
//! method that hands entries out returns its own `Vec` (a copy), or a
//! borrowed slice where the caller only reads. The contents are the same.

use crate::log_unstable::Unstable;
use crate::logger::LoggerRef;
use crate::num::len64;
use crate::raft::noLimit;
use crate::raftpb as pb;
use crate::storage::{Error, Storage};
use crate::types::{pb_entry_id, EntryID, LogSlice};
use crate::util::{ents_size, extend, limit_size, EntryEncodingSize};
use alloc::vec::Vec;
use core::cmp::{max, min};
use core::fmt;

pub(crate) struct RaftLog<S: Storage> {
    /// storage contains all stable entries since the last snapshot.
    pub(crate) storage: S,

    /// unstable contains all unstable entries and snapshot.
    /// they will be saved into storage.
    pub(crate) unstable: Unstable,

    /// committed is the highest log position that is known to be in
    /// stable storage on a quorum of nodes.
    pub(crate) committed: u64,
    /// applying is the highest log position that the application has
    /// been instructed to apply to its state machine. Some of these
    /// entries may be in the process of applying and have not yet
    /// reached applied.
    /// Use: The field is incremented when accepting a Ready struct.
    /// Invariant: applied <= applying && applying <= committed
    pub(crate) applying: u64,
    /// applied is the highest log position that the application has
    /// successfully applied to its state machine.
    /// Use: The field is incremented when advancing after the committed
    /// entries in a Ready struct have been applied (either synchronously
    /// or asynchronously).
    /// Invariant: applied <= committed
    pub(crate) applied: u64,

    pub(crate) logger: LoggerRef,

    /// maxApplyingEntsSize limits the outstanding byte size of the messages
    /// returned from calls to nextCommittedEnts that have not been acknowledged
    /// by a call to appliedTo.
    pub(crate) max_applying_ents_size: EntryEncodingSize,
    /// applyingEntsSize is the current outstanding byte size of the messages
    /// returned from calls to nextCommittedEnts that have not been acknowledged
    /// by a call to appliedTo.
    pub(crate) applying_ents_size: EntryEncodingSize,
    /// applyingEntsPaused is true when entry application has been paused until
    /// enough progress is acknowledged.
    pub(crate) applying_ents_paused: bool,
}

/// newLog returns log using the given storage and default options. It
/// recovers the log to the state that it just commits and applies the
/// latest snapshot.
// Only Go's tests call this. It is kept for when they are ported.
#[allow(dead_code)]
pub(crate) fn new_log<S: Storage>(storage: S, logger: LoggerRef) -> RaftLog<S> {
    new_log_with_size(storage, logger, noLimit)
}

/// newLogWithSize returns a log using the given storage and max
/// message size.
pub(crate) fn new_log_with_size<S: Storage>(
    storage: S,
    logger: LoggerRef,
    max_applying_ents_size: EntryEncodingSize,
) -> RaftLog<S> {
    let first_index = match storage.first_index() {
        Ok(i) => i,
        Err(err) => panic!("{err}"), // TODO(bdarnell)
    };
    let last_index = match storage.last_index() {
        Ok(i) => i,
        Err(err) => panic!("{err}"), // TODO(bdarnell)
    };
    RaftLog {
        storage,
        unstable: Unstable {
            snapshot: None,
            entries: Vec::new(),
            offset: last_index + 1,
            snapshot_in_progress: false,
            offset_in_progress: last_index + 1,
            logger: logger.clone(),
        },
        max_applying_ents_size,

        // Initialize our committed and applied pointers to the time of the last compaction.
        committed: first_index - 1,
        applying: first_index - 1,
        applied: first_index - 1,

        logger,

        applying_ents_size: 0,
        applying_ents_paused: false,
    }
}

/// Go's `(l *raftLog) String()`.
impl<S: Storage> fmt::Display for RaftLog<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "committed={}, applied={}, applying={}, unstable.offset={}, unstable.offsetInProgress={}, len(unstable.Entries)={}",
            self.committed,
            self.applied,
            self.applying,
            self.unstable.offset,
            self.unstable.offset_in_progress,
            self.unstable.entries.len()
        )
    }
}

impl<S: Storage> RaftLog<S> {
    /// maybeAppend returns (0, false) if the entries cannot be appended. Otherwise,
    /// it returns (last index of new entries, true).
    pub(crate) fn maybe_append(&mut self, a: &LogSlice, committed: u64) -> Option<u64> {
        if !self.match_term(a.prev) {
            return None;
        }
        // TODO(pav-kv): propagate logSlice down the stack. It will be used all the
        // way down in unstable, for safety checks, and for useful bookkeeping.

        let lastnewi = a.prev.index + len64(&a.entries);
        let ci = self.find_conflict(&a.entries);
        if ci == 0 {
        } else if ci <= self.committed {
            self.logger
                .panicf(format_args!("entry {} conflict with committed entry [committed({})]", ci, self.committed));
        } else {
            let offset = a.prev.index + 1;
            // Go's ci-offset wraps when ci < offset, and the check below then
            // panics; so does this.
            if ci.wrapping_sub(offset) > len64(&a.entries) {
                self.logger.panicf(format_args!(
                    "index, {}, is out of range [{}]",
                    ci.wrapping_sub(offset),
                    a.entries.len()
                ));
            }
            self.append(&a.entries[crate::num::ix(ci - offset)..]);
        }
        self.commit_to(min(committed, lastnewi));
        Some(lastnewi)
    }

    pub(crate) fn append(&mut self, ents: &[pb::Entry]) -> u64 {
        if ents.is_empty() {
            return self.last_index();
        }
        // Go's Index-1 wraps for index 0, and the check then passes; so does this.
        let after = ents[0].get_index().wrapping_sub(1);
        if after < self.committed {
            self.logger.panicf(format_args!("after({}) is out of range [committed({})]", after, self.committed));
        }
        self.unstable.truncate_and_append(ents);
        self.last_index()
    }

    /// findConflict finds the index of the conflict.
    /// It returns the first pair of conflicting entries between the existing
    /// entries and the given entries, if there are any.
    /// If there is no conflicting entries, and the existing entries contains
    /// all the given entries, zero will be returned.
    /// If there is no conflicting entries, but the given entries contains new
    /// entries, the index of the first new entry will be returned.
    /// An entry is considered to be conflicting if it has the same index but
    /// a different term.
    /// The index of the given entries MUST be continuously increasing.
    pub(crate) fn find_conflict(&self, ents: &[pb::Entry]) -> u64 {
        for e in ents {
            let id = pb_entry_id(e);
            if !self.match_term(id) {
                if id.index <= self.last_index() {
                    // TODO(pav-kv): can simply print %+v of the id. This will change the
                    // log format though.
                    self.logger.infof(format_args!(
                        "found conflict at index {} [existing term: {}, conflicting term: {}]",
                        id.index,
                        self.zero_term_on_out_of_bounds(self.term(id.index)),
                        id.term
                    ));
                }
                return id.index;
            }
        }
        0
    }

    /// findConflictByTerm returns a best guess on where this log ends matching
    /// another log, given that the only information known about the other log is the
    /// (index, term) of its single entry.
    ///
    /// Specifically, the first returned value is the max guessIndex <= index, such
    /// that term(guessIndex) <= term or term(guessIndex) is not known (because this
    /// index is compacted or not yet stored).
    ///
    /// The second returned value is the term(guessIndex), or 0 if it is unknown.
    ///
    /// This function is used by a follower and leader to resolve log conflicts after
    /// an unsuccessful append to a follower, and ultimately restore the steady flow
    /// of appends.
    pub(crate) fn find_conflict_by_term(&self, mut index: u64, term: u64) -> (u64, u64) {
        while index > 0 {
            // If there is an error (likely ErrCompacted or ErrUnavailable), we don't
            // know whether it's a match or not, so assume a possible match and return
            // the index, with 0 term indicating an unknown term.
            match self.term(index) {
                Err(_) => return (index, 0),
                Ok(our_term) => {
                    if our_term <= term {
                        return (index, our_term);
                    }
                }
            }
            index -= 1;
        }
        (0, 0)
    }

    /// nextUnstableEnts returns all entries that are available to be written to the
    /// local stable log and are not already in-progress.
    pub(crate) fn next_unstable_ents(&self) -> &[pb::Entry] {
        self.unstable.next_entries()
    }

    /// hasNextUnstableEnts returns if there are any entries that are available to be
    /// written to the local stable log and are not already in-progress.
    pub(crate) fn has_next_unstable_ents(&self) -> bool {
        !self.next_unstable_ents().is_empty()
    }

    /// hasNextOrInProgressUnstableEnts returns if there are any entries that are
    /// available to be written to the local stable log or in the process of being
    /// written to the local stable log.
    pub(crate) fn has_next_or_in_progress_unstable_ents(&self) -> bool {
        !self.unstable.entries.is_empty()
    }

    /// nextCommittedEnts returns all the available entries for execution.
    /// Entries can be committed even when the local raft instance has not durably
    /// appended them to the local raft log yet. If allowUnstable is true, committed
    /// entries from the unstable log may be returned; otherwise, only entries known
    /// to reside locally on stable storage will be returned.
    pub(crate) fn next_committed_ents(&self, allow_unstable: bool) -> Vec<pb::Entry> {
        if self.applying_ents_paused {
            // Entry application outstanding size limit reached.
            return Vec::new();
        }
        if self.has_next_or_in_progress_snapshot() {
            // See comment in hasNextCommittedEnts.
            return Vec::new();
        }
        let (lo, hi) = (self.applying + 1, self.max_appliable_index(allow_unstable) + 1); // [lo, hi)
        if lo >= hi {
            // Nothing to apply.
            return Vec::new();
        }
        // Go's unsigned subtraction wraps; `<= 0` then only catches zero.
        let max_size = self.max_applying_ents_size.wrapping_sub(self.applying_ents_size);
        if max_size == 0 {
            self.logger.panicf(format_args!(
                "applying entry size ({}-{})={} not positive",
                self.max_applying_ents_size, self.applying_ents_size, max_size
            ));
        }
        match self.slice(lo, hi, max_size) {
            Ok(ents) => ents,
            Err(err) => self.logger.panicf(format_args!("unexpected error when getting unapplied entries ({err})")),
        }
    }

    /// hasNextCommittedEnts returns if there is any available entries for execution.
    /// This is a fast check without heavy raftLog.slice() in nextCommittedEnts().
    pub(crate) fn has_next_committed_ents(&self, allow_unstable: bool) -> bool {
        if self.applying_ents_paused {
            // Entry application outstanding size limit reached.
            return false;
        }
        if self.has_next_or_in_progress_snapshot() {
            // If we have a snapshot to apply, don't also return any committed
            // entries. Doing so raises questions about what should be applied
            // first.
            return false;
        }
        let (lo, hi) = (self.applying + 1, self.max_appliable_index(allow_unstable) + 1); // [lo, hi)
        lo < hi
    }

    /// maxAppliableIndex returns the maximum committed index that can be applied.
    /// If allowUnstable is true, committed entries from the unstable log can be
    /// applied; otherwise, only entries known to reside locally on stable storage
    /// can be applied.
    pub(crate) fn max_appliable_index(&self, allow_unstable: bool) -> u64 {
        let mut hi = self.committed;
        if !allow_unstable {
            hi = min(hi, self.unstable.offset - 1);
        }
        hi
    }

    /// nextUnstableSnapshot returns the snapshot, if present, that is available to
    /// be applied to the local storage and is not already in-progress.
    pub(crate) fn next_unstable_snapshot(&self) -> Option<pb::Snapshot> {
        self.unstable.next_snapshot()
    }

    /// hasNextUnstableSnapshot returns if there is a snapshot that is available to
    /// be applied to the local storage and is not already in-progress.
    pub(crate) fn has_next_unstable_snapshot(&self) -> bool {
        self.unstable.has_next_snapshot()
    }

    /// hasNextOrInProgressSnapshot returns if there is pending snapshot waiting for
    /// applying or in the process of being applied.
    pub(crate) fn has_next_or_in_progress_snapshot(&self) -> bool {
        self.unstable.snapshot.is_some()
    }

    pub(crate) fn snapshot(&self) -> Result<pb::Snapshot, Error> {
        if let Some(snapshot) = &self.unstable.snapshot {
            return Ok(snapshot.clone());
        }
        self.storage.snapshot()
    }

    pub(crate) fn first_index(&self) -> u64 {
        if let Some(i) = self.unstable.maybe_first_index() {
            return i;
        }
        match self.storage.first_index() {
            Ok(index) => index,
            Err(err) => panic!("{err}"), // TODO(bdarnell)
        }
    }

    pub(crate) fn last_index(&self) -> u64 {
        if let Some(i) = self.unstable.maybe_last_index() {
            return i;
        }
        match self.storage.last_index() {
            Ok(i) => i,
            Err(err) => panic!("{err}"), // TODO(bdarnell)
        }
    }

    pub(crate) fn commit_to(&mut self, tocommit: u64) {
        // never decrease commit
        if self.committed < tocommit {
            if self.last_index() < tocommit {
                self.logger.panicf(format_args!(
                    "tocommit({}) is out of range [lastIndex({})]. Was the raft log corrupted, truncated, or lost?",
                    tocommit,
                    self.last_index()
                ));
            }
            self.committed = tocommit;
        }
    }

    pub(crate) fn applied_to(&mut self, i: u64, size: EntryEncodingSize) {
        if self.committed < i || i < self.applied {
            self.logger.panicf(format_args!(
                "applied({}) is out of range [prevApplied({}), committed({})]",
                i, self.applied, self.committed
            ));
        }
        self.applied = i;
        self.applying = max(self.applying, i);
        if self.applying_ents_size > size {
            self.applying_ents_size -= size;
        } else {
            // Defense against underflow.
            self.applying_ents_size = 0;
        }
        self.applying_ents_paused = self.applying_ents_size >= self.max_applying_ents_size;
    }

    pub(crate) fn accept_applying(&mut self, i: u64, size: EntryEncodingSize, allow_unstable: bool) {
        if self.committed < i {
            self.logger.panicf(format_args!(
                "applying({}) is out of range [prevApplying({}), committed({})]",
                i, self.applying, self.committed
            ));
        }
        self.applying = i;
        // Go's unsigned addition wraps; so does this.
        self.applying_ents_size = self.applying_ents_size.wrapping_add(size);
        // Determine whether to pause entry application until some progress is
        // acknowledged. We pause in two cases:
        // 1. the outstanding entry size equals or exceeds the maximum size.
        // 2. the outstanding entry size does not equal or exceed the maximum size,
        //    but we determine that the next entry in the log will push us over the
        //    limit. We determine this by comparing the last entry returned from
        //    raftLog.nextCommittedEnts to the maximum entry that the method was
        //    allowed to return had there been no size limit. If these indexes are
        //    not equal, then the returned entries slice must have been truncated to
        //    adhere to the memory limit.
        self.applying_ents_paused =
            self.applying_ents_size >= self.max_applying_ents_size || i < self.max_appliable_index(allow_unstable);
    }

    pub(crate) fn stable_to(&mut self, id: EntryID) {
        self.unstable.stable_to(id);
    }

    pub(crate) fn stable_snap_to(&mut self, i: u64) {
        self.unstable.stable_snap_to(i);
    }

    /// acceptUnstable indicates that the application has started persisting the
    /// unstable entries in storage, and that the current unstable entries are thus
    /// to be marked as being in-progress, to avoid returning them with future calls
    /// to Ready().
    pub(crate) fn accept_unstable(&mut self) {
        self.unstable.accept_in_progress();
    }

    /// lastEntryID returns the ID of the last entry in the log.
    pub(crate) fn last_entry_id(&self) -> EntryID {
        let index = self.last_index();
        match self.term(index) {
            Ok(t) => EntryID { term: t, index },
            Err(err) => {
                self.logger.panicf(format_args!("unexpected error when getting the last term at {index}: {err}"))
            }
        }
    }

    pub(crate) fn term(&self, i: u64) -> Result<u64, Error> {
        // Check the unstable log first, even before computing the valid term range,
        // which may need to access stable Storage. If we find the entry's term in
        // the unstable log, we know it was in the valid range.
        if let Some(t) = self.unstable.maybe_term(i) {
            return Ok(t);
        }

        // The valid term range is [firstIndex-1, lastIndex]. Even though the entry at
        // firstIndex-1 is compacted away, its term is available for matching purposes
        // when doing log appends.
        //
        // Go's i+1 wraps at the top of uint64; so does this.
        if i.wrapping_add(1) < self.first_index() {
            return Err(Error::Compacted);
        }
        if i > self.last_index() {
            return Err(Error::Unavailable);
        }

        match self.storage.term(i) {
            Ok(t) => Ok(t),
            Err(err) => {
                if err == Error::Compacted || err == Error::Unavailable {
                    return Err(err);
                }
                panic!("{err}") // TODO(bdarnell)
            }
        }
    }

    pub(crate) fn entries(&self, i: u64, max_size: EntryEncodingSize) -> Result<Vec<pb::Entry>, Error> {
        if i > self.last_index() {
            return Ok(Vec::new());
        }
        self.slice(i, self.last_index() + 1, max_size)
    }

    /// allEntries returns all entries in the log.
    // Only Go's tests call this. It is kept for when they are ported.
    #[allow(dead_code)]
    pub(crate) fn all_entries(&self) -> Vec<pb::Entry> {
        match self.entries(self.first_index(), noLimit) {
            Ok(ents) => ents,
            // try again if there was a racing compaction
            Err(Error::Compacted) => self.all_entries(),
            // TODO (xiangli): handle error?
            Err(err) => panic!("{err}"),
        }
    }

    /// isUpToDate determines if a log with the given last entry is more up-to-date
    /// by comparing the index and term of the last entries in the existing logs.
    ///
    /// If the logs have last entries with different terms, then the log with the
    /// later term is more up-to-date. If the logs end with the same term, then
    /// whichever log has the larger lastIndex is more up-to-date. If the logs are
    /// the same, the given log is up-to-date.
    pub(crate) fn is_up_to_date(&self, their: EntryID) -> bool {
        let our = self.last_entry_id();
        their.term > our.term || their.term == our.term && their.index >= our.index
    }

    pub(crate) fn match_term(&self, id: EntryID) -> bool {
        match self.term(id.index) {
            Err(_) => false,
            Ok(t) => t == id.term,
        }
    }

    pub(crate) fn maybe_commit(&mut self, at: EntryID) -> bool {
        // NB: term should never be 0 on a commit because the leader campaigned at
        // least at term 1. But if it is 0 for some reason, we don't consider this a
        // term match.
        if at.term != 0 && at.index > self.committed && self.match_term(at) {
            self.commit_to(at.index);
            return true;
        }
        false
    }

    pub(crate) fn restore(&mut self, s: &pb::Snapshot) {
        self.logger.infof(format_args!(
            "log [{}] starts to restore snapshot [index: {}, term: {}]",
            self,
            s.get_metadata_index(),
            s.get_metadata_term()
        ));
        self.committed = s.get_metadata_index();
        self.unstable.restore(s);
    }

    /// scan visits all log entries in the [lo, hi) range, returning them via the
    /// given callback. The callback can be invoked multiple times, with consecutive
    /// sub-ranges of the requested range. Returns up to pageSize bytes worth of
    /// entries at a time. May return more if a single entry size exceeds the limit.
    ///
    /// The entries in [lo, hi) must exist, otherwise scan() eventually returns an
    /// error (possibly after passing some entries through the callback).
    ///
    /// If the callback returns an error, scan terminates and returns this error
    /// immediately. This can be used to stop the scan early ("break" the loop).
    pub(crate) fn scan(
        &self,
        mut lo: u64,
        hi: u64,
        page_size: EntryEncodingSize,
        mut v: impl FnMut(&[pb::Entry]) -> Result<(), Error>,
    ) -> Result<(), Error> {
        while lo < hi {
            let ents = self.slice(lo, hi, page_size)?;
            if ents.is_empty() {
                return Err(Error::Other(alloc::format!("got 0 entries in [{lo}, {hi})")));
            }
            v(&ents)?;
            lo += len64(&ents);
        }
        Ok(())
    }

    /// slice returns a slice of log entries from lo through hi-1, inclusive.
    pub(crate) fn slice(&self, lo: u64, hi: u64, max_size: EntryEncodingSize) -> Result<Vec<pb::Entry>, Error> {
        self.must_check_out_of_bounds(lo, hi)?;
        if lo == hi {
            return Ok(Vec::new());
        }
        if lo >= self.unstable.offset {
            let ents = limit_size(self.unstable.slice(lo, hi), max_size);
            return Ok(ents.to_vec());
        }

        let cut = min(hi, self.unstable.offset);
        let ents = match self.storage.entries(lo, cut, max_size) {
            Ok(ents) => ents,
            Err(Error::Compacted) => return Err(Error::Compacted),
            Err(Error::Unavailable) => {
                self.logger.panicf(format_args!("entries[{lo}:{cut}) is unavailable from storage"))
            }
            Err(err) => panic!("{err}"), // TODO(pavelkalinnikov): handle errors uniformly
        };
        if hi <= self.unstable.offset {
            return Ok(ents);
        }

        // Fast path to check if ents has reached the size limitation. Either the
        // returned slice is shorter than requested (which means the next entry would
        // bring it over the limit), or a single entry reaches the limit.
        if len64(&ents) < cut - lo {
            return Ok(ents);
        }
        // Slow path computes the actual total size, so that unstable entries are cut
        // optimally before being copied to ents slice.
        let size = ents_size(&ents);
        if size >= max_size {
            return Ok(ents);
        }

        let unstable = limit_size(self.unstable.slice(self.unstable.offset, hi), max_size - size);
        // Total size of unstable may exceed maxSize-size only if len(unstable) == 1.
        // If this happens, ignore this extra entry.
        if unstable.len() == 1 && size + ents_size(unstable) > max_size {
            return Ok(ents);
        }
        // Otherwise, total size of unstable does not exceed maxSize-size, so total
        // size of ents+unstable does not exceed maxSize. Simply concatenate them.
        Ok(extend(ents, unstable))
    }

    /// l.firstIndex <= lo <= hi <= l.firstIndex + len(l.entries)
    fn must_check_out_of_bounds(&self, lo: u64, hi: u64) -> Result<(), Error> {
        if lo > hi {
            self.logger.panicf(format_args!("invalid slice {lo} > {hi}"));
        }
        let fi = self.first_index();
        if lo < fi {
            return Err(Error::Compacted);
        }

        let length = self.last_index() + 1 - fi;
        if hi > fi + length {
            self.logger.panicf(format_args!("slice[{},{}) out of bound [{},{}]", lo, hi, fi, self.last_index()));
        }
        Ok(())
    }

    pub(crate) fn zero_term_on_out_of_bounds(&self, t: Result<u64, Error>) -> u64 {
        match t {
            Ok(t) => t,
            Err(Error::Compacted) | Err(Error::Unavailable) => 0,
            Err(err) => self.logger.panicf(format_args!("unexpected error ({err})")),
        }
    }
}
