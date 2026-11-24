// Licensed under the Apache License, Version 2.0.

//! Test tooling for the `raft` crate. It is never shipped.
//!
//! - [`datadriven`]: the reader for cockroachdb/datadriven's file format, and
//!   the byte-for-byte check.
//! - [`gofmt`]: the small part of Go's `fmt` that the expected outputs need.
//! - [`quorum_dd`], [`confchange_dd`]: etcd's two package-level test drivers.
//! - [`rafttest`]: etcd's `InteractionEnv`, which drives whole clusters.
//! - [`suites`]: runs every vendored etcd file.

#![forbid(unsafe_code)]
// The raft crate keeps Go's names for enum values (`pb::MsgHup`).
#![allow(non_upper_case_globals)]

pub mod confchange_dd;
pub mod datadriven;
pub mod gofmt;
pub mod quorum_dd;
pub mod rafttest;
pub mod suites;
