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

//! Port of `status.go`.

use crate::gostd::Quote;
use crate::node::SoftState;
use crate::raft::{Raft, StateType};
use crate::raftpb as pb;
use crate::storage::Storage;
use crate::tracker;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use core::fmt;
use core::fmt::Write;

/// Status contains information about this Raft peer and its view of the system.
/// The Progress is only populated on the leader.
///
/// Go embeds `BasicStatus`; here it is the field `basic`.
#[derive(Clone, Debug, Default)]
pub struct Status {
    pub basic: BasicStatus,
    pub config: tracker::Config,
    /// Go's map is nil when the node is not the leader. Here it is empty.
    pub progress: BTreeMap<u64, tracker::Progress>,
}

/// BasicStatus contains basic information about the Raft peer. It does not allocate.
///
/// Go embeds `*pb.HardState` and `SoftState`; here they are fields.
#[derive(Clone, Debug, Default)]
pub struct BasicStatus {
    pub id: u64,

    pub hard_state: pb::HardState,
    pub soft_state: SoftState,

    pub applied: u64,

    pub lead_transferee: u64,
}

fn get_progress_copy<S: Storage>(r: &Raft<S>) -> BTreeMap<u64, tracker::Progress> {
    let mut m = BTreeMap::new();
    for (id, pr) in r.trk.progress.iter() {
        // The clone copies the Inflights too, as Go's `pr.Inflights.Clone()`.
        m.insert(*id, pr.clone());
    }
    m
}

pub(crate) fn get_basic_status<S: Storage>(r: &Raft<S>) -> BasicStatus {
    BasicStatus {
        id: r.id,
        lead_transferee: r.lead_transferee,
        hard_state: r.hard_state(),
        soft_state: r.soft_state(),
        applied: r.raft_log.applied,
    }
}

/// getStatus gets a copy of the current raft status.
pub(crate) fn get_status<S: Storage>(r: &Raft<S>) -> Status {
    let mut s = Status { basic: get_basic_status(r), ..Default::default() };
    if s.basic.soft_state.raft_state == StateType::StateLeader {
        s.progress = get_progress_copy(r);
    }
    s.config = r.trk.config.go_clone();
    s
}

impl Status {
    /// MarshalJSON translates the raft status into JSON.
    /// TODO: try to simplify this by introducing ID type into raft
    ///
    /// Go walks the progress map in its map order, which changes from run to
    /// run. Here the peers come sorted by id.
    #[must_use]
    pub fn marshal_json(&self) -> String {
        let mut j = format!(
            "{{\"id\":\"{:x}\",\"term\":{},\"vote\":\"{:x}\",\"commit\":{},\"lead\":\"{:x}\",\"raftState\":{},\"applied\":{},\"progress\":{{",
            self.basic.id,
            self.basic.hard_state.get_term(),
            self.basic.hard_state.get_vote(),
            self.basic.hard_state.get_commit(),
            self.basic.soft_state.lead,
            Quote(self.basic.soft_state.raft_state.to_string().as_bytes()),
            self.basic.applied
        );

        if self.progress.is_empty() {
            j.push_str("},");
        } else {
            for (k, v) in &self.progress {
                let _ = write!(
                    j,
                    "\"{:x}\":{{\"match\":{},\"next\":{},\"state\":{}}},",
                    k,
                    v.match_,
                    v.next,
                    Quote(v.state.to_string().as_bytes())
                );
            }
            // remove the trailing ","
            j.pop();
            j.push_str("},");
        }

        let _ = write!(j, "\"leadtransferee\":\"{:x}\"}}", self.lead_transferee());
        j
    }

    fn lead_transferee(&self) -> u64 {
        self.basic.lead_transferee
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.marshal_json())
    }
}
