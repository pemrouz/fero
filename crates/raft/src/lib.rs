// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! A port of etcd's Raft library to Rust.
//!
//! The port is faithful: Go's names, order and control flow are kept, with
//! one Rust module per Go file. The Go source at commit
//! `c51f010c851edd0dada5af41bafbf68e54617767` is the reference.
//!
//! The crate is a pure state machine. It does no I/O, reads no clock and
//! draws no random number on its own. It builds without `std`.
//!
//! Rules this crate keeps (a test in `raft-harness` scans for them):
//! - no `unsafe`;
//! - no hashed containers (their order can change between runs);
//! - no `usize`, `isize` or floats in state or messages. Terms, indexes and
//!   ids are `u64`, as in Go. The only place that names `usize` is
//!   [`num`], which turns a `u64` into a slice position.
//! - no outside crates.

#![no_std]
#![forbid(unsafe_code)]
// Go's names for enum values are kept as they are (`pb::MsgHup`), so the port
// reads like the source. They are constants, and they are used as patterns.
#![allow(non_upper_case_globals)]

extern crate alloc;

mod bootstrap;
pub mod confchange;
pub mod gostd;
mod log;
#[cfg(test)]
mod log_test;
mod log_unstable;
pub mod logger;
mod node;
pub mod num;
pub mod quorum;
pub mod raft;
pub mod raftpb;
mod rawnode;
mod read_only;
mod status;
pub mod storage;
pub mod tracker;
mod types;
pub mod util;

pub use logger::{DiscardLogger, Logger, LoggerRef};
pub use node::{is_empty_hard_state, is_empty_snap, Peer, Ready, SnapshotStatus, SoftState};
pub use raft::{Config, LocalAppendThread, LocalApplyThread, Rand, RandRef, ReadOnlyOption, StateType, NONE};
pub use rawnode::{must_sync, ProgressType, RawNode};
pub use read_only::ReadState;
pub use status::{BasicStatus, Status};
pub use storage::{Error, MemoryStorage, Storage};
