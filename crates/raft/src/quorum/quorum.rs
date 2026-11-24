// Copyright 2019 The etcd Authors
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

//! Port of `quorum/quorum.go`.

use alloc::collections::BTreeMap;
use core::fmt;

/// Index is a Raft log position.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Index(pub u64);

impl fmt::Display for Index {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0 == u64::MAX {
            return f.write_str("∞");
        }
        write!(f, "{}", self.0)
    }
}

/// AckedIndexer allows looking up a commit index for a given ID of a voter
/// from a corresponding MajorityConfig.
///
/// Go returns `(idx, found)`; here `None` is "not found".
pub trait AckedIndexer {
    fn acked_index(&self, voter_id: u64) -> Option<Index>;
}

/// Go's `mapAckIndexer`: a map from voter id to acked index.
pub type MapAckIndexer = BTreeMap<u64, Index>;

impl AckedIndexer for MapAckIndexer {
    fn acked_index(&self, id: u64) -> Option<Index> {
        self.get(&id).copied()
    }
}

/// VoteResult indicates the outcome of a vote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum VoteResult {
    /// VotePending indicates that the decision of the vote depends on future
    /// votes, i.e. neither "yes" or "no" has reached quorum yet.
    VotePending = 1,
    /// VoteLost indicates that the quorum has voted "no".
    VoteLost = 2,
    /// VoteWon indicates that the quorum has voted "yes".
    VoteWon = 3,
}
