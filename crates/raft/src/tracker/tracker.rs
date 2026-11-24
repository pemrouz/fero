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

//! Port of `tracker/tracker.go`.

use super::{Progress, ProgressMap};
use crate::quorum::{self, AckedIndexer, JointConfig, MajorityConfig, VoteResult};
use crate::raftpb as pb;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;
use core::fmt;

/// Config reflects the configuration tracked in a ProgressTracker.
///
/// The derived `clone` is an exact copy, like Go's struct assignment but
/// sharing nothing. Go's `Clone()` method is [`Config::go_clone`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Config {
    pub voters: JointConfig,
    /// AutoLeave is true if the configuration is joint and a transition to the
    /// incoming configuration should be carried out automatically by Raft when
    /// this is possible. If false, the configuration will be joint until the
    /// application initiates the transition manually.
    pub auto_leave: bool,
    /// Learners is a set of IDs corresponding to the learners active in the
    /// current configuration.
    ///
    /// Invariant: Learners and Voters does not intersect, i.e. if a peer is in
    /// either half of the joint config, it can't be a learner; if it is a
    /// learner it can't be in either half of the joint config. This invariant
    /// simplifies the implementation since it allows peers to have clarity about
    /// its current role without taking into account joint consensus.
    ///
    /// `None` is Go's nil map. Go tells nil from empty here, so this does too.
    pub learners: Option<BTreeSet<u64>>,
    /// When we turn a voter into a learner during a joint consensus transition,
    /// we cannot add the learner directly when entering the joint state. This is
    /// because this would violate the invariant that the intersection of
    /// voters and learners is empty. For example, assume a Voter is removed and
    /// immediately re-added as a learner (or in other words, it is demoted):
    ///
    /// Initially, the configuration will be
    ///
    ///   voters:   {1 2 3}
    ///   learners: {}
    ///
    /// and we want to demote 3. Entering the joint configuration, we naively get
    ///
    ///   voters:   {1 2} & {1 2 3}
    ///   learners: {3}
    ///
    /// but this violates the invariant (3 is both voter and learner). Instead,
    /// we get
    ///
    ///   voters:   {1 2} & {1 2 3}
    ///   learners: {}
    ///   next_learners: {3}
    ///
    /// Where 3 is now still purely a voter, but we are remembering the intention
    /// to make it a learner upon transitioning into the final configuration:
    ///
    ///   voters:   {1 2}
    ///   learners: {3}
    ///   next_learners: {}
    ///
    /// Note that next_learners is not used while adding a learner that is not
    /// also a voter in the joint config. In this case, the learner is added
    /// right away when entering the joint configuration, so that it is caught up
    /// as soon as possible.
    pub learners_next: Option<BTreeSet<u64>>,
}

/// Shows a bare set of ids the way `MajorityConfig` prints.
struct Ids<'a>(&'a BTreeSet<u64>);

impl fmt::Display for Ids<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("(")?;
        for (i, id) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{id:x}")?;
        }
        f.write_str(")")
    }
}

/// Go's `(c Config) String()`.
impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "voters={}", self.voters)?;
        if let Some(learners) = &self.learners {
            write!(f, " learners={}", Ids(learners))?;
        }
        if let Some(learners_next) = &self.learners_next {
            write!(f, " learners_next={}", Ids(learners_next))?;
        }
        if self.auto_leave {
            f.write_str(" autoleave")?;
        }
        Ok(())
    }
}

impl Config {
    /// Go's `Clone()`: returns a copy of the Config that shares no memory with
    /// the original.
    ///
    /// As in Go, the copy does not carry `AutoLeave`: it is false in the copy.
    #[must_use]
    pub fn go_clone(&self) -> Config {
        Config {
            voters: JointConfig([self.voters.0[0].clone(), self.voters.0[1].clone()]),
            auto_leave: false,
            learners: self.learners.clone(),
            learners_next: self.learners_next.clone(),
        }
    }
}

/// ProgressTracker tracks the currently active configuration and the information
/// known about the nodes and learners in it. In particular, it tracks the match
/// index for each peer which in turn allows reasoning about the committed index.
///
/// Go embeds `Config`, so Go's `p.Voters` is `p.config.voters` here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProgressTracker {
    pub config: Config,

    pub progress: ProgressMap,

    pub votes: BTreeMap<u64, bool>,

    pub max_inflight: u64,
    pub max_inflight_bytes: u64,
}

/// Go's `matchAckIndexer`: the acked index of a voter is its `Match`.
impl AckedIndexer for ProgressMap {
    /// AckedIndex implements IndexLookuper.
    fn acked_index(&self, id: u64) -> Option<quorum::Index> {
        let pr = self.get(&id)?;
        Some(quorum::Index(pr.match_))
    }
}

impl ProgressTracker {
    /// MakeProgressTracker initializes a ProgressTracker.
    #[must_use]
    pub fn make(max_inflight: u64, max_bytes: u64) -> ProgressTracker {
        ProgressTracker {
            max_inflight,
            max_inflight_bytes: max_bytes,
            config: Config {
                voters: JointConfig([
                    MajorityConfig::new(),
                    MajorityConfig::new(), // only populated when used
                ]),
                auto_leave: false,
                learners: None,      // only populated when used
                learners_next: None, // only populated when used
            },
            votes: BTreeMap::new(),
            progress: ProgressMap::default(),
        }
    }

    /// ConfState returns a ConfState representing the active configuration.
    #[must_use]
    pub fn conf_state(&self) -> pb::ConfState {
        let slice = |m: &Option<BTreeSet<u64>>| -> Vec<u64> {
            m.as_ref().map_or_else(Vec::new, |s| s.iter().copied().collect())
        };
        pb::ConfState {
            voters: self.config.voters.0[0].slice(),
            voters_outgoing: self.config.voters.0[1].slice(),
            learners: slice(&self.config.learners),
            learners_next: slice(&self.config.learners_next),
            auto_leave: Some(self.config.auto_leave),
        }
    }

    /// IsSingleton returns true if (and only if) there is only one voting member
    /// (i.e. the leader) in the current configuration.
    #[must_use]
    pub fn is_singleton(&self) -> bool {
        self.config.voters.0[0].len() == 1 && self.config.voters.0[1].is_empty()
    }

    /// IsVoter returns true if (and only if) id is a voting member of the current
    /// configuration, i.e. it is in either half of a joint configuration.
    #[must_use]
    pub fn is_voter(&self, id: u64) -> bool {
        let ok0 = self.config.voters.0[0].contains(&id);
        let ok1 = self.config.voters.0[1].contains(&id);
        ok0 || ok1
    }

    /// Committed returns the largest log index known to be committed based on what
    /// the voting members of the group have acknowledged.
    #[must_use]
    pub fn committed(&self) -> u64 {
        self.config.voters.committed_index(&self.progress).0
    }

    /// Visit invokes the supplied closure for all tracked progresses in stable order.
    ///
    /// The map is sorted, so this is a plain walk: Go's sort of the ids (and
    /// its care not to allocate) is not needed.
    pub fn visit(&mut self, mut f: impl FnMut(u64, &mut Progress)) {
        for (id, pr) in self.progress.iter_mut() {
            f(*id, pr);
        }
    }

    /// QuorumActive returns true if the quorum is active from the view of the local
    /// raft state machine. Otherwise, it returns false.
    #[must_use]
    pub fn quorum_active(&self) -> bool {
        let mut votes: BTreeMap<u64, bool> = BTreeMap::new();
        for (&id, pr) in self.progress.iter() {
            if pr.is_learner {
                continue;
            }
            votes.insert(id, pr.recent_active);
        }

        self.config.voters.vote_result(&votes) == VoteResult::VoteWon
    }

    /// VoterNodes returns a sorted slice of voters.
    #[must_use]
    pub fn voter_nodes(&self) -> Vec<u64> {
        let m = self.config.voters.ids();
        m.into_iter().collect()
    }

    /// LearnerNodes returns a sorted slice of learners.
    #[must_use]
    pub fn learner_nodes(&self) -> Vec<u64> {
        match &self.config.learners {
            None => Vec::new(),
            Some(learners) => learners.iter().copied().collect(),
        }
    }

    /// ResetVotes prepares for a new round of vote counting via recordVote.
    pub fn reset_votes(&mut self) {
        self.votes = BTreeMap::new();
    }

    /// RecordVote records that the node with the given id voted for this Raft
    /// instance if v == true (and declined it otherwise).
    pub fn record_vote(&mut self, id: u64, v: bool) {
        self.votes.entry(id).or_insert(v);
    }

    /// TallyVotes returns the number of granted and rejected Votes, and whether the
    /// election outcome is known.
    #[must_use]
    pub fn tally_votes(&self) -> (u64, u64, VoteResult) {
        // Make sure to populate granted/rejected correctly even if the Votes slice
        // contains members no longer part of the configuration. This doesn't really
        // matter in the way the numbers are used (they're informational), but might
        // as well get it right.
        let mut granted: u64 = 0;
        let mut rejected: u64 = 0;
        for (id, pr) in self.progress.iter() {
            if pr.is_learner {
                continue;
            }
            let Some(&v) = self.votes.get(id) else {
                continue;
            };
            if v {
                granted += 1;
            } else {
                rejected += 1;
            }
        }
        let result = self.config.voters.vote_result(&self.votes);
        (granted, rejected, result)
    }
}
