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

//! Port of `confchange/confchange.go`.
//!
//! Go's methods return `(tracker.Config, tracker.ProgressMap, error)`. Here
//! they return `Result<(Config, ProgressMap), Error>`.

use crate::gostd::Error;
use crate::quorum::MajorityConfig;
use crate::raftpb as pb;
use crate::tracker::{self, Config, Inflights, Progress, ProgressMap};
use alloc::collections::BTreeSet;
use alloc::string::String;
use core::cmp::max;
use core::fmt::Write;

/// Changer facilitates configuration changes. It exposes methods to handle
/// simple and joint consensus while performing the proper validation that allows
/// refusing invalid configuration changes before they affect the active
/// configuration.
#[derive(Clone, Debug)]
pub struct Changer {
    pub tracker: tracker::ProgressTracker,
    pub last_index: u64,
}

type Result = core::result::Result<(Config, ProgressMap), Error>;

impl Changer {
    /// EnterJoint verifies that the outgoing (=right) majority config of the joint
    /// config is empty and initializes it with a copy of the incoming (=left)
    /// majority config. That is, it transitions from
    ///
    ///     (1 2 3)&&()
    ///
    /// to
    ///
    ///     (1 2 3)&&(1 2 3).
    ///
    /// The supplied changes are then applied to the incoming majority config,
    /// resulting in a joint configuration that in terms of the Raft thesis[1]
    /// (Section 4.3) corresponds to `C_{new,old}`.
    ///
    /// [1]: https://github.com/ongardie/dissertation/blob/master/online-trim.pdf
    pub fn enter_joint(&self, auto_leave: bool, ccs: &[pb::ConfChangeSingle]) -> Result {
        let (mut cfg, mut trk) = self.check_and_copy()?;
        if joint(&cfg) {
            let err = Error::new("config is already joint");
            return self.err(err);
        }
        if incoming(&cfg).is_empty() {
            // We allow adding nodes to an empty config for convenience (testing and
            // bootstrap), but you can't enter a joint state.
            let err = Error::new("can't make a zero-voter config joint");
            return self.err(err);
        }
        // Clear the outgoing config.
        *outgoing_ptr(&mut cfg) = MajorityConfig::new();
        // Copy incoming to outgoing.
        let ids: BTreeSet<u64> = incoming(&cfg).0.clone();
        for id in ids {
            outgoing_ptr(&mut cfg).insert(id);
        }

        if let Err(err) = self.apply(&mut cfg, &mut trk, ccs) {
            return self.err(err);
        }
        cfg.auto_leave = auto_leave;
        check_and_return(cfg, trk)
    }

    /// LeaveJoint transitions out of a joint configuration. It is an error to call
    /// this method if the configuration is not joint, i.e. if the outgoing majority
    /// config Voters[1] is empty.
    ///
    /// The outgoing majority config of the joint configuration will be removed,
    /// that is, the incoming config is promoted as the sole decision maker. In the
    /// notation of the Raft thesis[1] (Section 4.3), this method transitions from
    /// `C_{new,old}` into `C_new`.
    ///
    /// At the same time, any staged learners (LearnersNext) the addition of which
    /// was held back by an overlapping voter in the former outgoing config will be
    /// inserted into Learners.
    ///
    /// [1]: https://github.com/ongardie/dissertation/blob/master/online-trim.pdf
    pub fn leave_joint(&self) -> Result {
        let (mut cfg, mut trk) = self.check_and_copy()?;
        if !joint(&cfg) {
            let err = Error::new("can't leave a non-joint config");
            return self.err(err);
        }
        if let Some(learners_next) = cfg.learners_next.take() {
            for id in learners_next {
                nil_aware_add(&mut cfg.learners, id);
                // check_invariants made sure that every staged learner has a
                // Progress; Go would panic on a nil pointer here.
                match trk.get_mut(&id) {
                    Some(pr) => pr.is_learner = true,
                    None => panic!("no progress for {id}"),
                }
            }
        }
        cfg.learners_next = None;

        for &id in outgoing(&cfg).iter() {
            let is_voter = incoming(&cfg).contains(&id);
            let is_learner = cfg.learners.as_ref().is_some_and(|l| l.contains(&id));

            if !is_voter && !is_learner {
                trk.remove(&id);
            }
        }
        *outgoing_ptr(&mut cfg) = MajorityConfig::new();
        cfg.auto_leave = false;

        check_and_return(cfg, trk)
    }

    /// Simple carries out a series of configuration changes that (in aggregate)
    /// mutates the incoming majority config Voters[0] by at most one. This method
    /// will return an error if that is not the case, if the resulting quorum is
    /// zero, or if the configuration is in a joint state (i.e. if there is an
    /// outgoing configuration).
    pub fn simple(&self, ccs: &[pb::ConfChangeSingle]) -> Result {
        let (mut cfg, mut trk) = self.check_and_copy()?;
        if joint(&cfg) {
            let err = Error::new("can't apply simple config change in joint config");
            return self.err(err);
        }
        if let Err(err) = self.apply(&mut cfg, &mut trk, ccs) {
            return self.err(err);
        }
        let n = symdiff(incoming(&self.tracker.config), incoming(&cfg));
        if n > 1 {
            return Err(Error::new("more than one voter changed without entering joint config"));
        }

        check_and_return(cfg, trk)
    }

    /// apply a change to the configuration. By convention, changes to voters are
    /// always made to the incoming majority config Voters[0]. Voters[1] is either
    /// empty or preserves the outgoing majority configuration while in a joint state.
    fn apply(
        &self,
        cfg: &mut Config,
        trk: &mut ProgressMap,
        ccs: &[pb::ConfChangeSingle],
    ) -> core::result::Result<(), Error> {
        for cc in ccs {
            if cc.get_node_id() == 0 {
                // etcd replaces the NodeId with zero if it decides (downstream of
                // raft) to not apply a change, so we have to have explicit code
                // here to ignore these.
                continue;
            }
            match cc.get_type() {
                pb::ConfChangeAddNode => self.make_voter(cfg, trk, cc.get_node_id()),
                pb::ConfChangeAddLearnerNode => self.make_learner(cfg, trk, cc.get_node_id()),
                pb::ConfChangeRemoveNode => self.remove(cfg, trk, cc.get_node_id()),
                pb::ConfChangeUpdateNode => {}
                t => {
                    // Go's `%d` of the enum: its number.
                    return Err(Error::errorf(format_args!("unexpected conf type {}", t.0)));
                }
            }
        }
        if incoming(cfg).is_empty() {
            return Err(Error::new("removed all voters"));
        }
        Ok(())
    }

    /// makeVoter adds or promotes the given ID to be a voter in the incoming
    /// majority config.
    fn make_voter(&self, cfg: &mut Config, trk: &mut ProgressMap, id: u64) {
        let Some(pr) = trk.get_mut(&id) else {
            self.init_progress(cfg, trk, id, false /* isLearner */);
            return;
        };

        pr.is_learner = false;
        nil_aware_delete(&mut cfg.learners, id);
        nil_aware_delete(&mut cfg.learners_next, id);
        incoming_ptr(cfg).insert(id);
    }

    /// makeLearner makes the given ID a learner or stages it to be a learner once
    /// an active joint configuration is exited.
    ///
    /// The former happens when the peer is not a part of the outgoing config, in
    /// which case we either add a new learner or demote a voter in the incoming
    /// config.
    ///
    /// The latter case occurs when the configuration is joint and the peer is a
    /// voter in the outgoing config. In that case, we do not want to add the peer
    /// as a learner because then we'd have to track a peer as a voter and learner
    /// simultaneously. Instead, we add the learner to LearnersNext, so that it will
    /// be added to Learners the moment the outgoing config is removed by
    /// LeaveJoint().
    fn make_learner(&self, cfg: &mut Config, trk: &mut ProgressMap, id: u64) {
        // Go keeps the pointer `pr` across the remove below and puts it back.
        // Here the Progress is taken out of the map first and put back after,
        // which leaves the map in the same state at every step that reads it:
        // `remove` only asks whether the id is tracked, so it is told.
        let Some(mut pr) = trk.remove(&id) else {
            self.init_progress(cfg, trk, id, true /* isLearner */);
            return;
        };
        if pr.is_learner {
            trk.insert(id, pr);
            return;
        }
        // Remove any existing voter in the incoming config...
        self.remove_tracked(cfg, id);
        // ... but save the Progress.
        //
        // Use LearnersNext if we can't add the learner to Learners directly, i.e.
        // if the peer is still tracked as a voter in the outgoing config. It will
        // be turned into a learner in LeaveJoint().
        //
        // Otherwise, add a regular learner right away.
        if outgoing(cfg).contains(&id) {
            nil_aware_add(&mut cfg.learners_next, id);
        } else {
            pr.is_learner = true;
            nil_aware_add(&mut cfg.learners, id);
        }
        trk.insert(id, pr);
    }

    /// remove this peer as a voter or learner from the incoming config.
    fn remove(&self, cfg: &mut Config, trk: &mut ProgressMap, id: u64) {
        if !trk.contains_key(&id) {
            return;
        }

        self.remove_tracked(cfg, id);

        // If the peer is still a voter in the outgoing config, keep the Progress.
        if !outgoing(cfg).contains(&id) {
            trk.remove(&id);
        }
    }

    /// The part of Go's `remove` that edits the config, for an id that is
    /// known to be tracked.
    fn remove_tracked(&self, cfg: &mut Config, id: u64) {
        incoming_ptr(cfg).remove(&id);
        nil_aware_delete(&mut cfg.learners, id);
        nil_aware_delete(&mut cfg.learners_next, id);
    }

    /// initProgress initializes a new progress for the given node or learner.
    fn init_progress(&self, cfg: &mut Config, trk: &mut ProgressMap, id: u64, is_learner: bool) {
        if !is_learner {
            incoming_ptr(cfg).insert(id);
        } else {
            nil_aware_add(&mut cfg.learners, id);
        }
        trk.insert(
            id,
            Progress {
                // Initializing the Progress with the last index means that the follower
                // can be probed (with the last index).
                //
                // TODO(tbg): seems awfully optimistic. Using the first index would be
                // better. The general expectation here is that the follower has no log
                // at all (and will thus likely need a snapshot), though the app may
                // have applied a snapshot out of band before adding the replica (thus
                // making the first index the better choice).
                match_: 0,
                next: max(self.last_index, 1), // invariant: Match < Next
                inflights: Inflights::new(self.tracker.max_inflight, self.tracker.max_inflight_bytes),
                is_learner,
                // When a node is first added, we should mark it as recently active.
                // Otherwise, CheckQuorum may cause us to step down if it is invoked
                // before the added node has had a chance to communicate with us.
                recent_active: true,
                ..Progress::default()
            },
        );
    }

    /// checkAndCopy copies the tracker's config and progress map (deeply enough for
    /// the purposes of the Changer) and returns those copies. It returns an error
    /// if checkInvariants does.
    fn check_and_copy(&self) -> Result {
        let cfg = self.tracker.config.go_clone();
        let mut trk = ProgressMap::default();

        for (&id, pr) in self.tracker.progress.iter() {
            // Go: a shallow copy is enough because we only mutate the Learner field.
            //
            // Go's shallow copy shares the Inflights pointer between the old
            // and the new Progress. This copy is deep. Nothing can tell the
            // two apart: the Changer never touches Inflights, and the caller
            // keeps only one of the two maps (the new one on success, the old
            // one on error).
            trk.insert(id, pr.clone());
        }
        check_and_return(cfg, trk)
    }

    /// err returns zero values and an error.
    fn err(&self, err: Error) -> Result {
        Err(err)
    }
}

/// checkInvariants makes sure that the config and progress are compatible with
/// each other. This is used to check both what the Changer is initialized with,
/// as well as what it returns.
fn check_invariants(cfg: &Config, trk: &ProgressMap) -> core::result::Result<(), Error> {
    // NB: intentionally allow the empty config. In production we'll never see a
    // non-empty config (we prevent it from being created) but we will need to
    // be able to *create* an initial config, for example during bootstrap (or
    // during tests). Instead of having to hand-code this, we allow
    // transitioning from an empty config into any other legal and non-empty
    // config.
    let empty = BTreeSet::new();
    let voter_ids = cfg.voters.ids();
    for ids in [&voter_ids, cfg.learners.as_ref().unwrap_or(&empty), cfg.learners_next.as_ref().unwrap_or(&empty)] {
        for id in ids {
            if !trk.contains_key(id) {
                return Err(Error::errorf(format_args!("no progress for {id}")));
            }
        }
    }

    // Any staged learner was staged because it could not be directly added due
    // to a conflicting voter in the outgoing config.
    for id in cfg.learners_next.as_ref().unwrap_or(&empty) {
        if !outgoing(cfg).contains(id) {
            return Err(Error::errorf(format_args!("{id} is in LearnersNext, but not Voters[1]")));
        }
        if trk[id].is_learner {
            return Err(Error::errorf(format_args!("{id} is in LearnersNext, but is already marked as learner")));
        }
    }
    // Conversely Learners and Voters doesn't intersect at all.
    for id in cfg.learners.as_ref().unwrap_or(&empty) {
        if outgoing(cfg).contains(id) {
            return Err(Error::errorf(format_args!("{id} is in Learners and Voters[1]")));
        }
        if incoming(cfg).contains(id) {
            return Err(Error::errorf(format_args!("{id} is in Learners and Voters[0]")));
        }
        if !trk[id].is_learner {
            return Err(Error::errorf(format_args!("{id} is in Learners, but is not marked as learner")));
        }
    }

    if !joint(cfg) {
        // We enforce that empty maps are nil instead of zero.
        //
        // Go also checks here that Voters[1] is nil and not an empty map
        // ("cfg.Voters[1] must be nil when not joint"). A MajorityConfig here
        // has one empty value, so that check has nothing to tell apart.
        if cfg.learners_next.is_some() {
            return Err(Error::new("cfg.LearnersNext must be nil when not joint"));
        }
        if cfg.auto_leave {
            return Err(Error::new("AutoLeave must be false when not joint"));
        }
    }

    Ok(())
}

/// checkAndReturn calls checkInvariants on the input and returns either the
/// resulting error or the input.
fn check_and_return(cfg: Config, trk: ProgressMap) -> Result {
    check_invariants(&cfg, &trk)?;
    Ok((cfg, trk))
}

/// nilAwareAdd populates a map entry, creating the map if necessary.
fn nil_aware_add(m: &mut Option<BTreeSet<u64>>, id: u64) {
    m.get_or_insert_with(BTreeSet::new).insert(id);
}

/// nilAwareDelete deletes from a map, nil'ing the map itself if it is empty after.
fn nil_aware_delete(m: &mut Option<BTreeSet<u64>>, id: u64) {
    let Some(set) = m else {
        return;
    };
    set.remove(&id);
    if set.is_empty() {
        *m = None;
    }
}

/// symdiff returns the count of the symmetric difference between the sets of
/// uint64s, i.e. len( (l - r) \union (r - l)).
fn symdiff(l: &MajorityConfig, r: &MajorityConfig) -> u64 {
    let mut n: u64 = 0;
    let pairs: [[&MajorityConfig; 2]; 2] = [
        [l, r], // count elems in l but not in r
        [r, l], // count elems in r but not in l
    ];
    for p in pairs {
        for id in p[0].iter() {
            if !p[1].contains(id) {
                n += 1;
            }
        }
    }
    n
}

fn joint(cfg: &Config) -> bool {
    !outgoing(cfg).is_empty()
}

// Go's helpers take the JointConfig; these take the Config that holds it.
fn incoming(cfg: &Config) -> &MajorityConfig {
    &cfg.voters.0[0]
}
fn outgoing(cfg: &Config) -> &MajorityConfig {
    &cfg.voters.0[1]
}
fn incoming_ptr(cfg: &mut Config) -> &mut MajorityConfig {
    &mut cfg.voters.0[0]
}
fn outgoing_ptr(cfg: &mut Config) -> &mut MajorityConfig {
    &mut cfg.voters.0[1]
}

/// Describe prints the type and NodeId of the configuration changes as a
/// space-delimited string.
#[must_use]
pub fn describe(ccs: &[pb::ConfChangeSingle]) -> String {
    let mut buf = String::new();
    for cc in ccs {
        if !buf.is_empty() {
            buf.push(' ');
        }
        let _ = write!(buf, "{}({})", cc.get_type(), cc.get_node_id());
    }
    buf
}
