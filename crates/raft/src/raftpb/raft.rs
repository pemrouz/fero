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

//! Port of `raftpb/raft.proto` and of the parts of the generated
//! `raft.pb.go` that Raft uses: the types, the getters, the enum names, the
//! encoded size of an entry, and the encoding of the two conf change messages.

use crate::num::{ix, len64};
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

/// Declares a proto enum as an open integer type, as Go has it: any `i32`
/// can be held, and a value without a name prints as its number.
macro_rules! proto_enum {
    ($(#[$doc:meta])* $name:ident { $($vname:literal = $val:literal,)* }) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
        pub struct $name(pub i32);

        impl $name {
            /// The name of the value, if it has one.
            #[must_use]
            pub fn name(self) -> Option<&'static str> {
                match self.0 {
                    $($val => Some($vname),)*
                    _ => None,
                }
            }

            /// The value with this name, if there is one. Go's `X_value` map.
            #[must_use]
            pub fn from_name(s: &str) -> Option<$name> {
                match s {
                    $($vname => Some($name($val)),)*
                    _ => None,
                }
            }
        }

        /// Go's generated `String()`.
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self.name() {
                    Some(s) => f.pad(s),
                    None => write!(f, "{}", self.0),
                }
            }
        }
    };
}

proto_enum! {
    EntryType {
        "EntryNormal" = 0,
        "EntryConfChange" = 1, // corresponds to pb.ConfChange
        "EntryConfChangeV2" = 2, // corresponds to pb.ConfChangeV2
    }
}

proto_enum! {
    /// For description of different message types, see:
    /// https://pkg.go.dev/go.etcd.io/raft/v3#hdr-MessageType
    MessageType {
        "MsgHup" = 0,
        "MsgBeat" = 1,
        "MsgProp" = 2,
        "MsgApp" = 3,
        "MsgAppResp" = 4,
        "MsgVote" = 5,
        "MsgVoteResp" = 6,
        "MsgSnap" = 7,
        "MsgHeartbeat" = 8,
        "MsgHeartbeatResp" = 9,
        "MsgUnreachable" = 10,
        "MsgSnapStatus" = 11,
        "MsgCheckQuorum" = 12,
        "MsgTransferLeader" = 13,
        "MsgTimeoutNow" = 14,
        "MsgReadIndex" = 15,
        "MsgReadIndexResp" = 16,
        "MsgPreVote" = 17,
        "MsgPreVoteResp" = 18,
        "MsgStorageAppend" = 19,
        "MsgStorageAppendResp" = 20,
        "MsgStorageApply" = 21,
        "MsgStorageApplyResp" = 22,
        "MsgForgetLeader" = 23,
    }
}

proto_enum! {
    /// ConfChangeTransition specifies the behavior of a configuration change with
    /// respect to joint consensus.
    ConfChangeTransition {
        "ConfChangeTransitionAuto" = 0,
        "ConfChangeTransitionJointImplicit" = 1,
        "ConfChangeTransitionJointExplicit" = 2,
    }
}

proto_enum! {
    ConfChangeType {
        "ConfChangeAddNode" = 0,
        "ConfChangeRemoveNode" = 1,
        "ConfChangeUpdateNode" = 2,
        "ConfChangeAddLearnerNode" = 3,
    }
}

/// Declares the getters of optional fields. A getter returns the zero value
/// when the field is absent, as Go's generated getters do.
macro_rules! getters {
    ($ty:ident { $($get:ident : $field:ident -> $t:ty,)* }) => {
        impl $ty {
            $(
                #[inline]
                #[must_use]
                pub fn $get(&self) -> $t {
                    self.$field.unwrap_or_default()
                }
            )*
        }
    };
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    pub term: Option<u64>,  // must be 64-bit aligned for atomic operations
    pub index: Option<u64>, // must be 64-bit aligned for atomic operations
    pub r#type: Option<EntryType>,
    pub data: Option<Vec<u8>>,
}

getters!(Entry {
    get_term: term -> u64,
    get_index: index -> u64,
    get_type: r#type -> EntryType,
});

impl Entry {
    /// The data, empty when absent.
    #[must_use]
    pub fn get_data(&self) -> &[u8] {
        self.data.as_deref().unwrap_or(&[])
    }

    /// The size of the entry when encoded as protobuf. Go's `Size()`.
    #[must_use]
    pub fn size(&self) -> u64 {
        let mut n = 0;
        if let Some(t) = self.r#type {
            n += 1 + sov_enum(t.0);
        }
        if let Some(v) = self.term {
            n += 1 + sov(v);
        }
        if let Some(v) = self.index {
            n += 1 + sov(v);
        }
        if let Some(d) = &self.data {
            n += 1 + sov(len64(d)) + len64(d);
        }
        n
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub conf_state: Option<ConfState>,
    pub index: Option<u64>,
    pub term: Option<u64>,
}

getters!(SnapshotMetadata {
    get_index: index -> u64,
    get_term: term -> u64,
});

impl SnapshotMetadata {
    #[must_use]
    pub fn get_conf_state(&self) -> Option<&ConfState> {
        self.conf_state.as_ref()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub data: Option<Vec<u8>>,
    pub metadata: Option<SnapshotMetadata>,
}

impl Snapshot {
    #[must_use]
    pub fn get_data(&self) -> &[u8] {
        self.data.as_deref().unwrap_or(&[])
    }

    #[must_use]
    pub fn get_metadata(&self) -> Option<&SnapshotMetadata> {
        self.metadata.as_ref()
    }

    /// `s.GetMetadata().GetIndex()`: zero when there is no metadata, as Go's
    /// getters on a nil message give.
    #[must_use]
    pub fn get_metadata_index(&self) -> u64 {
        self.metadata.as_ref().map_or(0, SnapshotMetadata::get_index)
    }

    /// `s.GetMetadata().GetTerm()`.
    #[must_use]
    pub fn get_metadata_term(&self) -> u64 {
        self.metadata.as_ref().map_or(0, SnapshotMetadata::get_term)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Message {
    pub r#type: Option<MessageType>,
    pub to: Option<u64>,
    pub from: Option<u64>,
    pub term: Option<u64>,
    /// logTerm is generally used for appending Raft logs to followers. For example,
    /// (type=MsgApp,index=100,logTerm=5) means the leader appends entries starting
    /// at index=101, and the term of the entry at index 100 is 5.
    /// (type=MsgAppResp,reject=true,index=100,logTerm=5) means follower rejects some
    /// entries from its leader as it already has an entry with term 5 at index 100.
    /// (type=MsgStorageAppendResp,index=100,logTerm=5) means the local node wrote
    /// entries up to index=100 in stable storage, and the term of the entry at index
    /// 100 was 5. This doesn't always mean that the corresponding MsgStorageAppend
    /// message was the one that carried these entries, just that those entries were
    /// stable at the time of processing the corresponding MsgStorageAppend.
    pub log_term: Option<u64>,
    pub index: Option<u64>,
    pub entries: Vec<Entry>,
    pub commit: Option<u64>,
    /// (type=MsgStorageAppend,vote=5,term=10) means the local node is voting for
    /// peer 5 in term 10. For MsgStorageAppends, the term, vote, and commit fields
    /// will either all be set (to facilitate the construction of a HardState) if
    /// any of the fields have changed or will all be unset if none of the fields
    /// have changed.
    pub vote: Option<u64>,
    /// snapshot is non-nil and non-empty for MsgSnap messages and nil for all other
    /// message types. However, peer nodes running older binary versions may send a
    /// non-nil, empty value for the snapshot field of non-MsgSnap messages. Code
    /// should be prepared to handle such messages.
    pub snapshot: Option<Snapshot>,
    pub reject: Option<bool>,
    pub reject_hint: Option<u64>,
    pub context: Option<Vec<u8>>,
    /// responses are populated by a raft node to instruct storage threads on how
    /// to respond and who to respond to when the work associated with a message
    /// is complete. Populated for MsgStorageAppend and MsgStorageApply messages.
    pub responses: Vec<Message>,
}

getters!(Message {
    get_type: r#type -> MessageType,
    get_to: to -> u64,
    get_from: from -> u64,
    get_term: term -> u64,
    get_log_term: log_term -> u64,
    get_index: index -> u64,
    get_commit: commit -> u64,
    get_vote: vote -> u64,
    get_reject: reject -> bool,
    get_reject_hint: reject_hint -> u64,
});

impl Message {
    #[must_use]
    pub fn get_entries(&self) -> &[Entry] {
        &self.entries
    }

    #[must_use]
    pub fn get_snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }

    #[must_use]
    pub fn get_context(&self) -> &[u8] {
        self.context.as_deref().unwrap_or(&[])
    }

    #[must_use]
    pub fn get_responses(&self) -> &[Message] {
        &self.responses
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HardState {
    pub term: Option<u64>,
    pub vote: Option<u64>,
    pub commit: Option<u64>,
}

getters!(HardState {
    get_term: term -> u64,
    get_vote: vote -> u64,
    get_commit: commit -> u64,
});

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfState {
    /// The voters in the incoming config. (If the configuration is not joint,
    /// then the outgoing config is empty).
    pub voters: Vec<u64>,
    /// The learners in the incoming config.
    pub learners: Vec<u64>,
    /// The voters in the outgoing config.
    pub voters_outgoing: Vec<u64>,
    /// The nodes that will become learners when the outgoing config is removed.
    /// These nodes are necessarily currently in nodes_joint (or they would have
    /// been added to the incoming config right away).
    pub learners_next: Vec<u64>,
    /// If set, the config is joint and Raft will automatically transition into
    /// the final config (i.e. remove the outgoing config) when this is safe.
    pub auto_leave: Option<bool>,
}

getters!(ConfState {
    get_auto_leave: auto_leave -> bool,
});

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfChange {
    pub r#type: Option<ConfChangeType>,
    pub node_id: Option<u64>,
    pub context: Option<Vec<u8>>,
    /// NB: this is used only by etcd to thread through a unique identifier.
    /// Ideally it should really use the Context instead. No counterpart to
    /// this field exists in ConfChangeV2.
    pub id: Option<u64>,
}

getters!(ConfChange {
    get_type: r#type -> ConfChangeType,
    get_node_id: node_id -> u64,
    get_id: id -> u64,
});

impl ConfChange {
    #[must_use]
    pub fn get_context(&self) -> &[u8] {
        self.context.as_deref().unwrap_or(&[])
    }
}

/// ConfChangeSingle is an individual configuration change operation. Multiple
/// such operations can be carried out atomically via a ConfChangeV2.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConfChangeSingle {
    pub r#type: Option<ConfChangeType>,
    pub node_id: Option<u64>,
}

getters!(ConfChangeSingle {
    get_type: r#type -> ConfChangeType,
    get_node_id: node_id -> u64,
});

/// ConfChangeV2 messages initiate configuration changes. They support both the
/// simple "one at a time" membership change protocol and full Joint Consensus
/// allowing for arbitrary changes in membership.
///
/// The supplied context is treated as an opaque payload and can be used to
/// attach an action on the state machine to the application of the config change
/// proposal. Note that contrary to Joint Consensus as outlined in the Raft
/// paper[1], configuration changes become active when they are *applied* to the
/// state machine (not when they are appended to the log).
///
/// The simple protocol can be used whenever only a single change is made.
///
/// Non-simple changes require the use of Joint Consensus, for which two
/// configuration changes are run. The first configuration change specifies the
/// desired changes and transitions the Raft group into the joint configuration,
/// in which quorum requires a majority of both the pre-changes and post-changes
/// configuration. Joint Consensus avoids entering fragile intermediate
/// configurations that could compromise survivability. For example, without the
/// use of Joint Consensus and running across three availability zones with a
/// replication factor of three, it is not possible to replace a voter without
/// entering an intermediate configuration that does not survive the outage of
/// one availability zone.
///
/// The provided ConfChangeTransition specifies how (and whether) Joint Consensus
/// is used, and assigns the task of leaving the joint configuration either to
/// Raft or the application. Leaving the joint configuration is accomplished by
/// proposing a ConfChangeV2 with only and optionally the Context field
/// populated.
///
/// For details on Raft membership changes, see:
///
/// [1]: https://github.com/ongardie/dissertation/blob/master/online-trim.pdf
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfChangeV2 {
    pub transition: Option<ConfChangeTransition>,
    pub changes: Vec<ConfChangeSingle>,
    pub context: Option<Vec<u8>>,
}

getters!(ConfChangeV2 {
    get_transition: transition -> ConfChangeTransition,
});

impl ConfChangeV2 {
    #[must_use]
    pub fn get_changes(&self) -> &[ConfChangeSingle] {
        &self.changes
    }

    #[must_use]
    pub fn get_context(&self) -> &[u8] {
        self.context.as_deref().unwrap_or(&[])
    }
}

// ---- The protobuf encoding that Raft itself depends on. ----

/// The size of `x` as a protobuf varint.
#[must_use]
pub(crate) fn sov(mut x: u64) -> u64 {
    let mut n = 1;
    while x >= 128 {
        x >>= 7;
        n += 1;
    }
    n
}

/// A proto enum is an int32 on the wire: a negative value is sign-extended
/// to 64 bits.
fn enum_bits(v: i32) -> u64 {
    i64::from(v).cast_unsigned()
}

fn sov_enum(v: i32) -> u64 {
    sov(enum_bits(v))
}

fn put_varint(out: &mut Vec<u8>, mut x: u64) {
    while x >= 128 {
        out.push(x.to_le_bytes()[0] | 0x80);
        x >>= 7;
    }
    out.push(x.to_le_bytes()[0]);
}

fn put_bytes(out: &mut Vec<u8>, tag: u8, b: &[u8]) {
    out.push(tag);
    put_varint(out, len64(b));
    out.extend_from_slice(b);
}

const EOF: &str = "proto: cannot parse invalid wire-format data";

fn read_varint(b: &[u8], pos: &mut u64) -> Result<u64, String> {
    let mut x: u64 = 0;
    let mut shift = 0u32;
    loop {
        let Some(&c) = b.get(ix(*pos)) else {
            return Err(String::from(EOF));
        };
        *pos += 1;
        if shift >= 64 {
            return Err(String::from(EOF));
        }
        x |= u64::from(c & 0x7f) << shift;
        if c < 0x80 {
            return Ok(x);
        }
        shift += 7;
    }
}

fn read_bytes<'a>(b: &'a [u8], pos: &mut u64) -> Result<&'a [u8], String> {
    let n = read_varint(b, pos)?;
    let start = *pos;
    let end = start.checked_add(n).filter(|&e| e <= len64(b)).ok_or_else(|| String::from(EOF))?;
    *pos = end;
    Ok(&b[ix(start)..ix(end)])
}

/// Skips a field this message does not know, as protobuf does.
fn skip_field(b: &[u8], pos: &mut u64, tag: u64) -> Result<(), String> {
    match tag & 7 {
        0 => read_varint(b, pos).map(|_| ()),
        1 => skip_fixed(b, pos, 8),
        2 => read_bytes(b, pos).map(|_| ()),
        5 => skip_fixed(b, pos, 4),
        _ => Err(String::from(EOF)),
    }
}

fn skip_fixed(b: &[u8], pos: &mut u64, n: u64) -> Result<(), String> {
    let end = pos.checked_add(n).filter(|&e| e <= len64(b)).ok_or_else(|| String::from(EOF))?;
    *pos = end;
    Ok(())
}

fn to_enum(x: u64) -> i32 {
    // An enum is an int32 on the wire: the low 32 bits, read as signed.
    let b = x.to_le_bytes();
    i32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

impl ConfChange {
    /// The protobuf encoding. Go's `proto.Marshal`.
    #[must_use]
    pub fn marshal(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(v) = self.id {
            out.push(0x08);
            put_varint(&mut out, v);
        }
        if let Some(v) = self.r#type {
            out.push(0x10);
            put_varint(&mut out, enum_bits(v.0));
        }
        if let Some(v) = self.node_id {
            out.push(0x18);
            put_varint(&mut out, v);
        }
        if let Some(c) = &self.context {
            put_bytes(&mut out, 0x22, c);
        }
        out
    }

    /// Reads the protobuf encoding. Go's `proto.Unmarshal`.
    pub fn unmarshal(b: &[u8]) -> Result<ConfChange, String> {
        let mut c = ConfChange::default();
        let mut pos = 0;
        while pos < len64(b) {
            let tag = read_varint(b, &mut pos)?;
            match tag {
                0x08 => c.id = Some(read_varint(b, &mut pos)?),
                0x10 => c.r#type = Some(ConfChangeType(to_enum(read_varint(b, &mut pos)?))),
                0x18 => c.node_id = Some(read_varint(b, &mut pos)?),
                0x22 => c.context = Some(read_bytes(b, &mut pos)?.to_vec()),
                _ => skip_field(b, &mut pos, tag)?,
            }
        }
        Ok(c)
    }
}

impl ConfChangeSingle {
    fn marshal_to(&self, out: &mut Vec<u8>) {
        if let Some(v) = self.r#type {
            out.push(0x08);
            put_varint(out, enum_bits(v.0));
        }
        if let Some(v) = self.node_id {
            out.push(0x10);
            put_varint(out, v);
        }
    }

    fn unmarshal(b: &[u8]) -> Result<ConfChangeSingle, String> {
        let mut c = ConfChangeSingle::default();
        let mut pos = 0;
        while pos < len64(b) {
            let tag = read_varint(b, &mut pos)?;
            match tag {
                0x08 => c.r#type = Some(ConfChangeType(to_enum(read_varint(b, &mut pos)?))),
                0x10 => c.node_id = Some(read_varint(b, &mut pos)?),
                _ => skip_field(b, &mut pos, tag)?,
            }
        }
        Ok(c)
    }
}

impl ConfChangeV2 {
    /// The protobuf encoding. Go's `proto.Marshal`.
    #[must_use]
    pub fn marshal(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(v) = self.transition {
            out.push(0x08);
            put_varint(&mut out, enum_bits(v.0));
        }
        let mut inner = Vec::new();
        for ch in &self.changes {
            inner.clear();
            ch.marshal_to(&mut inner);
            put_bytes(&mut out, 0x12, &inner);
        }
        if let Some(c) = &self.context {
            put_bytes(&mut out, 0x1a, c);
        }
        out
    }

    /// Reads the protobuf encoding. Go's `proto.Unmarshal`.
    pub fn unmarshal(b: &[u8]) -> Result<ConfChangeV2, String> {
        let mut c = ConfChangeV2::default();
        let mut pos = 0;
        while pos < len64(b) {
            let tag = read_varint(b, &mut pos)?;
            match tag {
                0x08 => c.transition = Some(ConfChangeTransition(to_enum(read_varint(b, &mut pos)?))),
                0x12 => c.changes.push(ConfChangeSingle::unmarshal(read_bytes(b, &mut pos)?)?),
                0x1a => c.context = Some(read_bytes(b, &mut pos)?.to_vec()),
                _ => skip_field(b, &mut pos, tag)?,
            }
        }
        Ok(c)
    }
}
