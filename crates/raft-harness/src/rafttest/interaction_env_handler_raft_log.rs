// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_raft_log.go`.

use super::interaction_env::{default_entry_formatter, InteractionEnv};
use super::interaction_env_handler::first_as_node_idx;
use super::HResult;
use crate::datadriven::TestData;
use raft::Storage;

impl InteractionEnv {
    pub(crate) fn handle_raft_log(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        self.raft_log(idx)
    }

    /// RaftLog pretty prints the raft log to the output buffer.
    pub fn raft_log(&mut self, idx: usize) -> HResult {
        let s = &self.nodes[idx].storage;
        let fi = s.first_index()?;
        let li = s.last_index()?;
        if li < fi {
            // TODO(tbg): this is what MemoryStorage returns, but unclear if it's
            // the "correct" thing to do.
            self.output.write_string(&format!("log is empty: first index={fi}, last index={li}"));
            return Ok(());
        }
        let ents = s.entries(fi, li + 1, u64::MAX)?;
        self.output.write_string(&raft::util::describe_entries(&ents, Some(&default_entry_formatter)));
        Ok(())
    }
}
