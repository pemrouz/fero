// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! Port of etcd raft's `raftpb` package: the messages.
//!
//! For now the messages are plain Rust structs. They follow `raft.proto`
//! field for field, with proto2 presence: an optional field is an `Option`,
//! and `get_x()` returns the zero value when it is absent, as Go's generated
//! getters do. The real byte shapes on the wire belong to a later `wire`
//! crate. The only encoding kept here is the one Raft itself depends on:
//! conf changes ride inside entries as bytes, and limits count an entry's
//! encoded size.

mod alias;
mod confchange;
mod confstate;
mod raft;
mod util;

pub use alias::*;
pub use confchange::{conf_changes_from_string, conf_changes_to_string, marshal_conf_change, ConfChangeI};
pub use raft::{
    ConfChange, ConfChangeSingle, ConfChangeTransition, ConfChangeType, ConfChangeV2, ConfState, Entry, EntryType,
    HardState, Message, MessageType, Snapshot, SnapshotMetadata,
};
pub use util::{ensure_conf_state, ensure_snapshot, ensure_snapshot_metadata};
