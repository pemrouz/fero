// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_campaign.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_campaign(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        self.campaign(idx)
    }

    /// Campaign the node at the given index.
    pub fn campaign(&mut self, idx: usize) -> HResult {
        Ok(self.nodes[idx].raw_node.campaign()?)
    }
}
