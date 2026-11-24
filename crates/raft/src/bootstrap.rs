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

//! Port of `bootstrap.go`.

use crate::node::Peer;
use crate::raft::NONE;
use crate::raftpb as pb;
use crate::raftpb::ConfChangeI;
use crate::rawnode::RawNode;
use crate::storage::{Error, Storage};
use alloc::string::String;
use alloc::vec::Vec;

impl<S: Storage> RawNode<S> {
    /// Bootstrap initializes the RawNode for first use by appending configuration
    /// changes for the supplied peers. This method returns an error if the Storage
    /// is nonempty.
    ///
    /// It is recommended that instead of calling this method, applications bootstrap
    /// their state manually by setting up a Storage that has a first index > 1 and
    /// which stores the desired ConfState as its InitialState.
    pub fn bootstrap(&mut self, peers: &[Peer]) -> Result<(), Error> {
        if peers.is_empty() {
            return Err(Error::Other(String::from("must provide at least one peer to Bootstrap")));
        }
        let last_index = self.raft.raft_log.storage.last_index()?;

        if last_index != 0 {
            return Err(Error::Other(String::from("can't bootstrap a nonempty Storage")));
        }

        // We've faked out initial entries above, but nothing has been
        // persisted. Start with an empty HardState (thus the first Ready will
        // emit a HardState update for the app to persist).
        self.prev_hard_st = pb::HardState::default();

        // TODO(tbg): remove StartNode and give the application the right tools to
        // bootstrap the initial membership in a cleaner way.
        self.raft.become_follower(1, NONE);
        let mut ents: Vec<pb::Entry> = Vec::with_capacity(peers.len());
        let mut i: u64 = 0;
        for peer in peers {
            let cc = pb::ConfChange {
                r#type: Some(pb::ConfChangeAddNode),
                node_id: Some(peer.id),
                context: peer.context.clone(),
                ..Default::default()
            };
            let data = cc.marshal();

            ents.push(pb::Entry {
                r#type: Some(pb::EntryConfChange),
                term: Some(1),
                index: Some(i + 1),
                data: Some(data),
            });
            i += 1;
        }
        self.raft.raft_log.append(&ents);

        // Now apply them, mainly so that the application can call Campaign
        // immediately after StartNode in tests. Note that these nodes will
        // be added to raft twice: here and when the application's Ready
        // loop calls ApplyConfChange. The calls to addNode must come after
        // all calls to raftLog.append so progress.next is set after these
        // bootstrapping entries (it is an error if we try to append these
        // entries since they have already been committed).
        // We do not set raftLog.applied so the application will be able
        // to observe all conf changes via Ready.CommittedEntries.
        //
        // TODO(bdarnell): These entries are still unstable; do we need to preserve
        // the invariant that committed < unstable?
        self.raft.raft_log.committed = i;
        for peer in peers {
            self.raft.apply_conf_change(
                &pb::ConfChange { node_id: Some(peer.id), r#type: Some(pb::ConfChangeAddNode), ..Default::default() }
                    .as_v2(),
            );
        }
        Ok(())
    }
}
