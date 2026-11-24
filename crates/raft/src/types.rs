// Copyright 2024 The etcd Authors
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

//! Port of `types.go`.

use crate::gostd::Error;
use crate::num::len64;
use crate::raftpb as pb;
use alloc::vec::Vec;
use core::fmt;

/// entryID uniquely identifies a raft log entry.
///
/// Every entry is associated with a leadership term which issued this entry and
/// initially appended it to the log. There can only be one leader at any term,
/// and a leader never issues two entries with the same index.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EntryID {
    pub(crate) term: u64,
    pub(crate) index: u64,
}

/// Go's `%+v` of an entryID.
impl fmt::Display for EntryID {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{{term:{} index:{}}}", self.term, self.index)
    }
}

/// pbEntryID returns the ID of the given pb.Entry.
pub(crate) fn pb_entry_id(entry: &pb::Entry) -> EntryID {
    EntryID { term: entry.get_term(), index: entry.get_index() }
}

/// logSlice describes a correct slice of a raft log.
///
/// Every log slice is considered in a context of a specific leader term. This
/// term does not necessarily match entryID.term of the entries, since a leader
/// log contains both entries from its own term, and some earlier terms.
///
/// Two slices with a matching logSlice.term are guaranteed to be consistent,
/// i.e. they never contain two different entries at the same index. The reverse
/// is not true: two slices with different logSlice.term may contain both
/// matching and mismatching entries. Specifically, logs at two different leader
/// terms share a common prefix, after which they *permanently* diverge.
///
/// A well-formed logSlice conforms to raft safety properties. It provides the
/// following guarantees:
///
///  1. entries[i].Index == prev.index + 1 + i,
///  2. prev.term <= entries[0].Term,
///  3. entries[i-1].Term <= entries[i].Term,
///  4. entries[len-1].Term <= term.
///
/// Property (1) means the slice is contiguous. Properties (2) and (3) mean that
/// the terms of the entries in a log never regress. Property (4) means that a
/// leader log at a specific term never has entries from higher terms.
///
/// Users of this struct can assume the invariants hold true. Exception is the
/// "gateway" code that initially constructs logSlice, such as when its content
/// is sourced from a message that was received via transport, or from Storage,
/// or in a test code that manually hard-codes this struct. In these cases, the
/// invariants should be validated using the valid() method.
#[derive(Clone, Debug, Default)]
pub(crate) struct LogSlice {
    /// term is the leader term containing the given entries in its log.
    // Read by `valid` only, which today only Go's tests call.
    #[allow(dead_code)]
    pub(crate) term: u64,
    /// prev is the ID of the entry immediately preceding the entries.
    pub(crate) prev: EntryID,
    /// entries contains the consecutive entries representing this slice.
    pub(crate) entries: Vec<pb::Entry>,
}

// Today only Go's tests call these (see the TODOs in raft.rs about
// validating a logSlice when it is built). Kept for when they are ported.
#[allow(dead_code)]
impl LogSlice {
    /// lastIndex returns the index of the last entry in this log slice. Returns
    /// prev.index if there are no entries.
    pub(crate) fn last_index(&self) -> u64 {
        self.prev.index + len64(&self.entries)
    }

    /// lastEntryID returns the ID of the last entry in this log slice, or prev if
    /// there are no entries.
    pub(crate) fn last_entry_id(&self) -> EntryID {
        if let Some(last) = self.entries.last() {
            return pb_entry_id(last);
        }
        self.prev
    }

    /// valid returns nil iff the logSlice is a well-formed log slice. See logSlice
    /// comment for details on what constitutes a valid raft log slice.
    pub(crate) fn valid(&self) -> Result<(), Error> {
        let mut prev = self.prev;
        for e in &self.entries {
            let id = pb_entry_id(e);
            // Go's prev.index+1 wraps at the top of uint64; so does this.
            if id.term < prev.term || id.index != prev.index.wrapping_add(1) {
                return Err(Error::errorf(format_args!(
                    "leader term {}: entries {} and {} not consistent",
                    self.term, prev, id
                )));
            }
            prev = id;
        }
        if self.term < prev.term {
            return Err(Error::errorf(format_args!("leader term {}: entry {} has a newer term", self.term, prev)));
        }
        Ok(())
    }
}
