// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! Port of etcd raft's `quorum` package: majority and joint quorums.

mod joint;
mod majority;
#[allow(clippy::module_inception)]
mod quorum;
mod voteresult_string;

pub use joint::JointConfig;
pub use majority::MajorityConfig;
pub use quorum::{AckedIndexer, Index, MapAckIndexer, VoteResult};
