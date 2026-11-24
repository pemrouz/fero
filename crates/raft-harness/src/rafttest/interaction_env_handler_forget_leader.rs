// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_forget_leader.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_forget_leader(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        self.forget_leader(idx);
        Ok(())
    }

    /// ForgetLeader makes the follower at the given index forget its leader.
    pub fn forget_leader(&mut self, idx: usize) {
        let _ = self.nodes[idx].raw_node.forget_leader();
    }
}
