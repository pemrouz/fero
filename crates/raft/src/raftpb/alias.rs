// Copyright 2026 The etcd Authors
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

//! Port of `raftpb/alias.go`: the short names of the enum values.
//!
//! Go's names are kept as they are (`pb::MsgHup`), so the port reads like the
//! source. They are constants, so they work as `match` patterns.

use super::raft::{ConfChangeTransition, ConfChangeType, EntryType, MessageType};

pub const EntryNormal: EntryType = EntryType(0);
pub const EntryConfChange: EntryType = EntryType(1);
pub const EntryConfChangeV2: EntryType = EntryType(2);

pub const MsgHup: MessageType = MessageType(0);
pub const MsgBeat: MessageType = MessageType(1);
pub const MsgProp: MessageType = MessageType(2);
pub const MsgApp: MessageType = MessageType(3);
pub const MsgAppResp: MessageType = MessageType(4);
pub const MsgVote: MessageType = MessageType(5);
pub const MsgVoteResp: MessageType = MessageType(6);
pub const MsgSnap: MessageType = MessageType(7);
pub const MsgHeartbeat: MessageType = MessageType(8);
pub const MsgHeartbeatResp: MessageType = MessageType(9);
pub const MsgUnreachable: MessageType = MessageType(10);
pub const MsgSnapStatus: MessageType = MessageType(11);
pub const MsgCheckQuorum: MessageType = MessageType(12);
pub const MsgTransferLeader: MessageType = MessageType(13);
pub const MsgTimeoutNow: MessageType = MessageType(14);
pub const MsgReadIndex: MessageType = MessageType(15);
pub const MsgReadIndexResp: MessageType = MessageType(16);
pub const MsgPreVote: MessageType = MessageType(17);
pub const MsgPreVoteResp: MessageType = MessageType(18);
pub const MsgStorageAppend: MessageType = MessageType(19);
pub const MsgStorageAppendResp: MessageType = MessageType(20);
pub const MsgStorageApply: MessageType = MessageType(21);
pub const MsgStorageApplyResp: MessageType = MessageType(22);
pub const MsgForgetLeader: MessageType = MessageType(23);

pub const ConfChangeTransitionAuto: ConfChangeTransition = ConfChangeTransition(0);
pub const ConfChangeTransitionJointImplicit: ConfChangeTransition = ConfChangeTransition(1);
pub const ConfChangeTransitionJointExplicit: ConfChangeTransition = ConfChangeTransition(2);

pub const ConfChangeAddNode: ConfChangeType = ConfChangeType(0);
pub const ConfChangeRemoveNode: ConfChangeType = ConfChangeType(1);
pub const ConfChangeUpdateNode: ConfChangeType = ConfChangeType(2);
pub const ConfChangeAddLearnerNode: ConfChangeType = ConfChangeType(3);
