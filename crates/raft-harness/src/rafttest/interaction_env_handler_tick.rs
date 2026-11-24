// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_tick.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_tick_election(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        let num = self.nodes[idx].config.election_tick;
        self.tick(idx, num)
    }

    pub(crate) fn handle_tick_heartbeat(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        let num = self.nodes[idx].config.heartbeat_tick;
        self.tick(idx, num)
    }

    /// Tick the node at the given index the given number of times.
    pub fn tick(&mut self, idx: usize, num: i64) -> HResult {
        let mut i = 0;
        while i < num {
            self.nodes[idx].raw_node.tick();
            i += 1;
        }
        Ok(())
    }
}
