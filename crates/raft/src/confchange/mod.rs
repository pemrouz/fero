// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! Port of etcd raft's `confchange` package: membership changes, simple and
//! joint.

#[allow(clippy::module_inception)]
mod confchange;
mod restore;

pub use confchange::{describe, Changer};
pub use restore::restore;
