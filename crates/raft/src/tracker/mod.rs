// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! Port of etcd raft's `tracker` package: what a leader knows about each peer.

mod inflights;
mod progress;
mod state;
#[allow(clippy::module_inception)]
mod tracker;

pub use inflights::Inflights;
pub use progress::{Progress, ProgressMap};
pub use state::StateType;
pub use tracker::{Config, ProgressTracker};
