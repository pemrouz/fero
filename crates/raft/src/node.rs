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

//! Port of the parts of `node.go` that the state machine and `RawNode` need:
//! `SoftState`, `Ready`, `SnapshotStatus`, `Peer` and a few helpers.
//!
//! Go's `Node` (the goroutine wrapper around `RawNode`, with its channels) is
//! not ported. A host drives [`crate::RawNode`] itself.

use crate::raft::StateType;
use crate::raftpb as pb;
use crate::read_only::ReadState;
use alloc::vec;
use alloc::vec::Vec;

/// Go's `SnapshotStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotStatus {
    SnapshotFinish = 1,
    SnapshotFailure = 2,
}

/// SoftState provides state that is useful for logging and debugging.
/// The state is volatile and does not need to be persisted to the WAL.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SoftState {
    pub lead: u64, // must use atomic operations to access; keep 64-bit aligned.
    pub raft_state: StateType,
}

impl SoftState {
    pub(crate) fn equal(&self, b: &SoftState) -> bool {
        self.lead == b.lead && self.raft_state == b.raft_state
    }
}

/// Ready encapsulates the entries and messages that are ready to read,
/// be saved to stable storage, committed or sent to other peers.
/// All fields in Ready are read-only.
///
/// Go embeds `*SoftState` and `*pb.HardState`; here they are the two
/// optional fields `soft_state` and `hard_state`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ready {
    /// The current volatile state of a Node.
    /// SoftState will be nil if there is no update.
    /// It is not required to consume or store SoftState.
    pub soft_state: Option<SoftState>,

    /// The current state of a Node to be saved to stable storage BEFORE
    /// Messages are sent.
    ///
    /// HardState will be equal to empty state if there is no update.
    ///
    /// If async storage writes are enabled, this field does not need to be acted
    /// on immediately. It will be reflected in a MsgStorageAppend message in the
    /// Messages slice.
    pub hard_state: Option<pb::HardState>,

    /// ReadStates can be used for node to serve linearizable read requests locally
    /// when its applied index is greater than the index in ReadState.
    /// Note that the readState will be returned when raft receives msgReadIndex.
    /// The returned is only valid for the request that requested to read.
    pub read_states: Vec<ReadState>,

    /// Entries specifies entries to be saved to stable storage BEFORE
    /// Messages are sent.
    ///
    /// If async storage writes are enabled, this field does not need to be acted
    /// on immediately. It will be reflected in a MsgStorageAppend message in the
    /// Messages slice.
    pub entries: Vec<pb::Entry>,

    /// Snapshot specifies the snapshot to be saved to stable storage.
    ///
    /// If async storage writes are enabled, this field does not need to be acted
    /// on immediately. It will be reflected in a MsgStorageAppend message in the
    /// Messages slice.
    pub snapshot: Option<pb::Snapshot>,

    /// CommittedEntries specifies entries to be committed to a
    /// store/state-machine. These have previously been appended to stable
    /// storage.
    ///
    /// If async storage writes are enabled, this field does not need to be acted
    /// on immediately. It will be reflected in a MsgStorageApply message in the
    /// Messages slice.
    pub committed_entries: Vec<pb::Entry>,

    /// Messages specifies outbound messages.
    ///
    /// If async storage writes are not enabled, these messages must be sent
    /// AFTER Entries are appended to stable storage.
    ///
    /// If async storage writes are enabled, these messages can be sent
    /// immediately as the messages that have the completion of the async writes
    /// as a precondition are attached to the individual MsgStorage{Append,Apply}
    /// messages instead.
    ///
    /// If it contains a MsgSnap message, the application MUST report back to raft
    /// when the snapshot has been received or has failed by calling ReportSnapshot.
    pub messages: Vec<pb::Message>,

    /// MustSync indicates whether the HardState and Entries must be durably
    /// written to disk or if a non-durable write is permissible.
    pub must_sync: bool,
}

pub(crate) fn is_hard_state_equal(a: &pb::HardState, b: &pb::HardState) -> bool {
    a.get_term() == b.get_term() && a.get_vote() == b.get_vote() && a.get_commit() == b.get_commit()
}

/// IsEmptyHardState returns true if the given HardState is empty.
#[must_use]
pub fn is_empty_hard_state(st: Option<&pb::HardState>) -> bool {
    match st {
        None => true,
        // Go compares with `emptyState`, a HardState of zeros.
        Some(st) => is_hard_state_equal(st, &pb::HardState::default()),
    }
}

/// IsEmptySnap returns true if the given Snapshot is empty.
#[must_use]
pub fn is_empty_snap(sp: Option<&pb::Snapshot>) -> bool {
    sp.is_none_or(|sp| sp.get_metadata_index() == 0)
}

/// Go's `Peer`: a node of the first configuration, for `Bootstrap`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Peer {
    pub id: u64,
    pub context: Option<Vec<u8>>,
}

/// Go's `confChangeToMsg`. Encoding cannot fail here, so there is no error
/// to return.
pub(crate) fn conf_change_to_msg(c: Option<&dyn pb::ConfChangeI>) -> pb::Message {
    let (typ, data) = pb::marshal_conf_change(c);
    pb::Message {
        r#type: Some(pb::MsgProp),
        entries: vec![pb::Entry { r#type: Some(typ), data, ..Default::default() }],
        ..Default::default()
    }
}
