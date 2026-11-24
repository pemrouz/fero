// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_status.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;
use raft::tracker;

impl InteractionEnv {
    pub(crate) fn handle_status(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        self.status(idx)
    }

    /// Status pretty-prints the raft status for the node at the given index to the output
    /// buffer.
    pub fn status(&mut self, idx: usize) -> HResult {
        // TODO(tbg): actually print the full status.
        let st = self.nodes[idx].raw_node.status();
        let m = tracker::ProgressMap(st.progress);
        self.output.write_string(&m.to_string());
        Ok(())
    }
}
