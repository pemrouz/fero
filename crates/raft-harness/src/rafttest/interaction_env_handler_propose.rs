// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_propose.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::{fatal, HResult};
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_propose(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        if d.cmd_args.len() != 2 || !d.cmd_args[1].vals.is_empty() {
            fatal(Err(format!("expected exactly one key with no vals: {:?}", &d.cmd_args[1..])))?;
        }
        self.propose(idx, d.cmd_args[1].key.as_bytes())
    }

    /// Propose a regular entry.
    pub fn propose(&mut self, idx: usize, data: &[u8]) -> HResult {
        Ok(self.nodes[idx].raw_node.propose(Some(data.to_vec()))?)
    }
}
