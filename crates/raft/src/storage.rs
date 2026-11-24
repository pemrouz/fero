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

//! Port of `storage.go`.

use crate::num::{ix, len64};
use crate::raftpb as pb;
use crate::util::limit_size;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;

/// Go's `error` values of the core package.
///
/// Go compares errors by identity (`err == ErrCompacted`). One enum does the
/// same job. The other files of the core add their errors here as they are
/// ported (Go's `error` is one type for all of them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// ErrCompacted is returned by Storage.Entries/Compact when a requested
    /// index is unavailable because it predates the last snapshot.
    Compacted,
    /// ErrSnapOutOfDate is returned by Storage.CreateSnapshot when a requested
    /// index is older than the existing snapshot.
    SnapOutOfDate,
    /// ErrUnavailable is returned by Storage interface when the requested log entries
    /// are unavailable.
    Unavailable,
    /// ErrSnapshotTemporarilyUnavailable is returned by the Storage interface when the required
    /// snapshot is temporarily unavailable.
    SnapshotTemporarilyUnavailable,
    /// ErrProposalDropped is returned when the proposal is ignored by some cases,
    /// so that the proposer can be notified and fail fast. (Go: raft.go.)
    ProposalDropped,
    /// ErrStepLocalMsg is returned when try to step a local raft message.
    /// (Go: rawnode.go.)
    StepLocalMsg,
    /// ErrStepPeerNotFound is returned when try to step a response message
    /// but there is no peer found in raft.trk for that node. (Go: rawnode.go.)
    StepPeerNotFound,
    /// errBreak is a sentinel error used to break a callback-based loop.
    /// (Go: raft.go.)
    Break,
    /// Any other error, by its text. A Storage of the host returns its own
    /// failures this way.
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Compacted => "requested index is unavailable due to compaction",
            Error::SnapOutOfDate => "requested index is older than the existing snapshot",
            Error::Unavailable => "requested entry at index is unavailable",
            Error::SnapshotTemporarilyUnavailable => "snapshot is temporarily unavailable",
            Error::ProposalDropped => "raft proposal dropped",
            Error::StepLocalMsg => "raft: cannot step raft local message",
            Error::StepPeerNotFound => "raft: cannot step as peer not found",
            Error::Break => "break",
            Error::Other(s) => s,
        })
    }
}

/// Storage is an interface that may be implemented by the application
/// to retrieve log entries from storage.
///
/// If any Storage method returns an error, the raft instance will
/// become inoperable and refuse to participate in elections; the
/// application is responsible for cleanup and recovery in this case.
///
/// In Go the application and Raft share one storage object behind a pointer.
/// Here Raft owns a value of a type that implements this trait; a host that
/// also writes to the storage makes that value a shared handle.
pub trait Storage {
    // TODO(tbg): split this into two interfaces, LogStorage and StateStorage.

    /// InitialState returns the saved HardState and ConfState information.
    /// The returned HardState may be nil to indicate that no HardState has been
    /// persisted yet; IsEmptyHardState treats nil as empty.
    /// The returned ConfState must not be nil; if no ConfState has been
    /// persisted yet, return an empty ConfState instead.
    fn initial_state(&self) -> Result<(Option<pb::HardState>, pb::ConfState), Error>;

    /// Entries returns a slice of consecutive log entries in the range [lo, hi),
    /// starting from lo. The maxSize limits the total size of the log entries
    /// returned, but Entries returns at least one entry if any.
    ///
    /// The caller of Entries owns the returned slice, and may append to it.
    ///
    /// Returns ErrCompacted if entry lo has been compacted, or ErrUnavailable if
    /// encountered an unavailable entry in [lo, hi).
    fn entries(&self, lo: u64, hi: u64, max_size: u64) -> Result<Vec<pb::Entry>, Error>;

    /// Term returns the term of entry i, which must be in the range
    /// [FirstIndex()-1, LastIndex()]. The term of the entry before
    /// FirstIndex is retained for matching purposes even though the
    /// rest of that entry may not be available.
    fn term(&self, i: u64) -> Result<u64, Error>;
    /// LastIndex returns the index of the last entry in the log.
    fn last_index(&self) -> Result<u64, Error>;
    /// FirstIndex returns the index of the first log entry that is
    /// possibly available via Entries (older entries have been incorporated
    /// into the latest Snapshot; if storage only contains the dummy entry the
    /// first log entry is not available).
    fn first_index(&self) -> Result<u64, Error>;
    /// Snapshot returns the most recent snapshot.
    /// If snapshot is temporarily unavailable, it should return ErrSnapshotTemporarilyUnavailable,
    /// so raft state machine could know that Storage needs some time to prepare
    /// snapshot and call Snapshot later.
    fn snapshot(&self) -> Result<pb::Snapshot, Error>;
}

/// MemoryStorage implements the Storage interface backed by an
/// in-memory array.
///
/// Go's version holds a mutex, because the application appends from another
/// goroutine. This one is a plain value: reads take `&self`, writes take
/// `&mut self`, and sharing it is the host's choice. Go's call counters
/// (`callStats`, used by Go's unit tests only) are not carried.
#[derive(Clone, Debug)]
pub struct MemoryStorage {
    hard_state: Option<pb::HardState>,
    snapshot: pb::Snapshot,
    /// ents[i] has raft log position i+ms.snapshot.GetMetadata().GetIndex()
    ents: Vec<pb::Entry>,
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStorage {
    /// NewMemoryStorage creates an empty MemoryStorage.
    #[must_use]
    pub fn new() -> MemoryStorage {
        let mut snapshot = None;
        pb::ensure_snapshot(&mut snapshot);
        MemoryStorage {
            hard_state: None,
            snapshot: snapshot.unwrap_or_default(),
            // When starting from scratch populate the list with a dummy entry at term zero.
            ents: vec![pb::Entry::default()],
        }
    }

    /// SetHardState saves the current HardState.
    pub fn set_hard_state(&mut self, st: Option<pb::HardState>) -> Result<(), Error> {
        self.hard_state = st;
        Ok(())
    }

    fn last_index_(&self) -> u64 {
        self.ents[0].get_index() + len64(&self.ents) - 1
    }

    fn first_index_(&self) -> u64 {
        self.ents[0].get_index() + 1
    }

    /// ApplySnapshot overwrites the contents of this Storage object with
    /// those of the given snapshot.
    pub fn apply_snapshot(&mut self, snap: pb::Snapshot) -> Result<(), Error> {
        let mut snap = Some(snap);
        let snap = pb::ensure_snapshot(&mut snap);

        //handle check for old snapshot being applied
        let ms_index = self.snapshot.get_metadata_index();
        let snap_index = snap.get_metadata_index();
        // During bootstrap, applications (e.g., etcd) may initialize only the
        // ConfState in the snapshot. In this case, both the snapshot index and
        // term are 0.
        if ms_index != 0 && ms_index >= snap_index {
            return Err(Error::SnapOutOfDate);
        }

        self.ents = vec![pb::Entry {
            term: Some(snap.get_metadata_term()),
            index: Some(snap.get_metadata_index()),
            ..pb::Entry::default()
        }];
        self.snapshot = snap.clone();
        Ok(())
    }

    /// CreateSnapshot makes a snapshot which can be retrieved with Snapshot() and
    /// can be used to reconstruct the state at that point.
    /// If any configuration changes have been made since the last compaction,
    /// the result of the last ApplyConfChange must be passed in.
    pub fn create_snapshot(
        &mut self,
        i: u64,
        cs: Option<&pb::ConfState>,
        data: Option<Vec<u8>>,
    ) -> Result<pb::Snapshot, Error> {
        if i <= self.snapshot.get_metadata_index() {
            return Err(Error::SnapOutOfDate);
        }

        let offset = self.ents[0].get_index();
        if i > self.last_index_() {
            panic!("snapshot {} is out of bound lastindex({})", i, self.last_index_());
        }

        let term = self.ents[ix(i - offset)].get_term();
        let md = pb::ensure_snapshot_metadata(&mut self.snapshot.metadata);
        md.index = Some(i);
        md.term = Some(term);
        if let Some(cs) = cs {
            md.conf_state = Some(cs.clone());
        }
        self.snapshot.data = data;
        Ok(self.snapshot.clone())
    }

    /// Compact discards all log entries prior to compactIndex.
    /// It is the application's responsibility to not attempt to compact an index
    /// greater than raftLog.applied.
    pub fn compact(&mut self, compact_index: u64) -> Result<(), Error> {
        let offset = self.ents[0].get_index();
        if compact_index <= offset {
            return Err(Error::Compacted);
        }
        if compact_index > self.last_index_() {
            panic!("compact {} is out of bound lastindex({})", compact_index, self.last_index_());
        }

        let i = ix(compact_index - offset);
        let mut ents: Vec<pb::Entry> = Vec::with_capacity(self.ents.len() - i);
        ents.push(pb::Entry {
            index: Some(self.ents[i].get_index()),
            term: Some(self.ents[i].get_term()),
            ..pb::Entry::default()
        });
        ents.extend(self.ents.drain(i + 1..));
        self.ents = ents;
        Ok(())
    }

    /// Append the new entries to storage.
    /// TODO (xiangli): ensure the entries are continuous and
    /// entries[0].Index > ms.entries[0].Index
    pub fn append(&mut self, entries: &[pb::Entry]) -> Result<(), Error> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut entries = entries;

        let first = self.first_index_();
        let last = entries[0].get_index() + len64(entries) - 1;

        // shortcut if there is no new entry.
        if last < first {
            return Ok(());
        }
        // truncate compacted entries
        if first > entries[0].get_index() {
            entries = &entries[ix(first - entries[0].get_index())..];
        }

        let offset = entries[0].get_index() - self.ents[0].get_index();
        if len64(&self.ents) > offset {
            self.ents.truncate(ix(offset));
            self.ents.extend_from_slice(entries);
        } else if len64(&self.ents) == offset {
            self.ents.extend_from_slice(entries);
        } else {
            panic!("missing log entry [last: {}, append at: {}]", self.last_index_(), entries[0].get_index());
        }
        Ok(())
    }
}

impl Storage for MemoryStorage {
    /// InitialState implements the Storage interface.
    fn initial_state(&self) -> Result<(Option<pb::HardState>, pb::ConfState), Error> {
        let mut cs = self.snapshot.get_metadata().and_then(|m| m.get_conf_state()).cloned();
        pb::ensure_conf_state(&mut cs);
        Ok((self.hard_state.clone(), cs.unwrap_or_default()))
    }

    /// Entries implements the Storage interface.
    fn entries(&self, lo: u64, hi: u64, max_size: u64) -> Result<Vec<pb::Entry>, Error> {
        let offset = self.ents[0].get_index();
        if lo <= offset {
            return Err(Error::Compacted);
        }
        if hi > self.last_index_() + 1 {
            panic!("entries' hi({}) is out of bound lastindex({})", hi, self.last_index_());
        }
        // only contains dummy entries.
        if self.ents.len() == 1 {
            return Err(Error::Unavailable);
        }

        let ents = limit_size(&self.ents[ix(lo - offset)..ix(hi - offset)], max_size);
        Ok(ents.to_vec())
    }

    /// Term implements the Storage interface.
    fn term(&self, i: u64) -> Result<u64, Error> {
        let offset = self.ents[0].get_index();
        if i < offset {
            return Err(Error::Compacted);
        }
        if i - offset >= len64(&self.ents) {
            return Err(Error::Unavailable);
        }
        Ok(self.ents[ix(i - offset)].get_term())
    }

    /// LastIndex implements the Storage interface.
    fn last_index(&self) -> Result<u64, Error> {
        Ok(self.last_index_())
    }

    /// FirstIndex implements the Storage interface.
    fn first_index(&self) -> Result<u64, Error> {
        Ok(self.first_index_())
    }

    /// Snapshot implements the Storage interface.
    fn snapshot(&self) -> Result<pb::Snapshot, Error> {
        // Go fills the snapshot's nil fields here (EnsureSnapshot). Every
        // path that sets the snapshot in this type fills them already.
        Ok(self.snapshot.clone())
    }
}
