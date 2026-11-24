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

//! Port of `confchange/restore.go`.

use super::Changer;
use crate::gostd::Error;
use crate::raftpb as pb;
use crate::tracker::{Config, ProgressMap};
use alloc::vec::Vec;

/// toConfChangeSingle translates a conf state into 1) a slice of operations creating
/// first the config that will become the outgoing one, and then the incoming one, and
/// b) another slice that, when applied to the config resulted from 1), represents the
/// ConfState.
fn to_conf_change_single(cs: &pb::ConfState) -> (Vec<pb::ConfChangeSingle>, Vec<pb::ConfChangeSingle>) {
    // Example to follow along this code:
    // voters=(1 2 3) learners=(5) outgoing=(1 2 4 6) learners_next=(4)
    //
    // This means that before entering the joint config, the configuration
    // had voters (1 2 4 6) and perhaps some learners that are already gone.
    // The new set of voters is (1 2 3), i.e. (1 2) were kept around, and (4 6)
    // are no longer voters; however 4 is poised to become a learner upon leaving
    // the joint state.
    // We can't tell whether 5 was a learner before entering the joint config,
    // but it doesn't matter (we'll pretend that it wasn't).
    //
    // The code below will construct
    // outgoing = add 1; add 2; add 4; add 6
    // incoming = remove 1; remove 2; remove 4; remove 6
    //            add 1;    add 2;    add 3;
    //            add-learner 5;
    //            add-learner 4;
    //
    // So, when starting with an empty config, after applying 'outgoing' we have
    //
    //   quorum=(1 2 4 6)
    //
    // From which we enter a joint state via 'incoming'
    //
    //   quorum=(1 2 3)&&(1 2 4 6) learners=(5) learners_next=(4)
    //
    // as desired.
    let mut out: Vec<pb::ConfChangeSingle> = Vec::new();
    let mut r#in: Vec<pb::ConfChangeSingle> = Vec::new();

    for &id in &cs.voters_outgoing {
        // If there are outgoing voters, first add them one by one so that the
        // (non-joint) config has them all.
        out.push(pb::ConfChangeSingle { r#type: Some(pb::ConfChangeAddNode), node_id: Some(id) });
    }

    // We're done constructing the outgoing slice, now on to the incoming one
    // (which will apply on top of the config created by the outgoing slice).

    // First, we'll remove all of the outgoing voters.
    for &id in &cs.voters_outgoing {
        r#in.push(pb::ConfChangeSingle { r#type: Some(pb::ConfChangeRemoveNode), node_id: Some(id) });
    }
    // Then we'll add the incoming voters and learners.
    for &id in &cs.voters {
        r#in.push(pb::ConfChangeSingle { r#type: Some(pb::ConfChangeAddNode), node_id: Some(id) });
    }
    for &id in &cs.learners {
        r#in.push(pb::ConfChangeSingle { r#type: Some(pb::ConfChangeAddLearnerNode), node_id: Some(id) });
    }
    // Same for LearnersNext; these are nodes we want to be learners but which
    // are currently voters in the outgoing config.
    for &id in &cs.learners_next {
        r#in.push(pb::ConfChangeSingle { r#type: Some(pb::ConfChangeAddLearnerNode), node_id: Some(id) });
    }
    (out, r#in)
}

/// One step of a restore. Go builds a slice of closures; an enum of the two
/// kinds of step says the same without boxing.
enum Op<'a> {
    Simple(pb::ConfChangeSingle),
    EnterJoint(bool, &'a [pb::ConfChangeSingle]),
}

fn chain(mut chg: Changer, ops: &[Op<'_>]) -> Result<(Config, ProgressMap), Error> {
    for op in ops {
        let (cfg, trk) = match op {
            Op::Simple(cc) => chg.simple(core::slice::from_ref(cc))?,
            Op::EnterJoint(auto_leave, ccs) => chg.enter_joint(*auto_leave, ccs)?,
        };
        chg.tracker.config = cfg;
        chg.tracker.progress = trk;
    }
    Ok((chg.tracker.config, chg.tracker.progress))
}

/// Restore takes a Changer (which must represent an empty configuration), and
/// runs a sequence of changes enacting the configuration described in the
/// ConfState.
///
/// TODO(tbg) it's silly that this takes a Changer. Unravel this by making sure
/// the Changer only needs a ProgressMap (not a whole Tracker) at which point
/// this can just take LastIndex and MaxInflight directly instead and cook up
/// the results from that alone.
pub fn restore(chg: Changer, cs: &pb::ConfState) -> Result<(Config, ProgressMap), Error> {
    let (outgoing, incoming) = to_conf_change_single(cs);

    let mut ops: Vec<Op<'_>> = Vec::new();

    if outgoing.is_empty() {
        // No outgoing config, so just apply the incoming changes one by one.
        for cc in &incoming {
            ops.push(Op::Simple(*cc));
        }
    } else {
        // The ConfState describes a joint configuration.
        //
        // First, apply all of the changes of the outgoing config one by one, so
        // that it temporarily becomes the incoming active config. For example,
        // if the config is (1 2 3)&(2 3 4), this will establish (2 3 4)&().
        for cc in &outgoing {
            ops.push(Op::Simple(*cc));
        }
        // Now enter the joint state, which rotates the above additions into the
        // outgoing config, and adds the incoming config in. Continuing the
        // example above, we'd get (1 2 3)&(2 3 4), i.e. the incoming operations
        // would be removing 2,3,4 and then adding in 1,2,3 while transitioning
        // into a joint state.
        ops.push(Op::EnterJoint(cs.get_auto_leave(), &incoming));
    }

    chain(chg, &ops)
}
