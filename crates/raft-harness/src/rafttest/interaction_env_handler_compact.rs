// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_compact.go`.

use super::interaction_env::{InteractionEnv, Storage};
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_compact(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        let new_first_index = raft::gostd::parse_uint(&d.cmd_args[1].key)?;
        self.compact(idx, new_first_index)
    }

    /// Compact truncates the log on the node at index idx so that the supplied new
    /// first index results.
    pub fn compact(&mut self, idx: usize, new_first_index: u64) -> HResult {
        self.nodes[idx].storage.compact(new_first_index)?;
        self.raft_log(idx)
    }
}
