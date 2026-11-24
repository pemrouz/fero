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

//! Port of `quorum/joint.go`.

use super::{AckedIndexer, Index, MajorityConfig, VoteResult};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use core::fmt;

/// JointConfig is a configuration of two groups of (possibly overlapping)
/// majority configurations. Decisions require the support of both majorities.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JointConfig(pub [MajorityConfig; 2]);

/// Go's `(c JointConfig) String()`.
impl fmt::Display for JointConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if !self.0[1].is_empty() {
            return write!(f, "{}&&{}", self.0[0], self.0[1]);
        }
        write!(f, "{}", self.0[0])
    }
}

impl JointConfig {
    /// IDs returns a newly initialized map representing the set of voters present
    /// in the joint configuration.
    #[must_use]
    pub fn ids(&self) -> BTreeSet<u64> {
        let mut m = BTreeSet::new();
        for cc in &self.0 {
            for &id in cc.iter() {
                m.insert(id);
            }
        }
        m
    }

    /// Describe returns a (multi-line) representation of the commit indexes for the
    /// given lookuper.
    pub fn describe(&self, l: &dyn AckedIndexer) -> String {
        MajorityConfig(self.ids()).describe(l)
    }

    /// CommittedIndex returns the largest committed index for the given joint
    /// quorum. An index is jointly committed if it is committed in both constituent
    /// majorities.
    pub fn committed_index(&self, l: &dyn AckedIndexer) -> Index {
        let idx0 = self.0[0].committed_index(l);
        let idx1 = self.0[1].committed_index(l);
        if idx0 < idx1 {
            return idx0;
        }
        idx1
    }

    /// VoteResult takes a mapping of voters to yes/no (true/false) votes and returns
    /// a result indicating whether the vote is pending, lost, or won. A joint quorum
    /// requires both majority quorums to vote in favor.
    #[must_use]
    pub fn vote_result(&self, votes: &BTreeMap<u64, bool>) -> VoteResult {
        let r1 = self.0[0].vote_result(votes);
        let r2 = self.0[1].vote_result(votes);

        if r1 == r2 {
            // If they agree, return the agreed state.
            return r1;
        }
        if r1 == VoteResult::VoteLost || r2 == VoteResult::VoteLost {
            // If either config has lost, loss is the only possible outcome.
            return VoteResult::VoteLost;
        }
        // One side won, the other one is pending, so the whole outcome is.
        VoteResult::VotePending
    }
}
