// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_transfer_leadership.go`.

use super::interaction_env::InteractionEnv;
use super::{fatal, HResult};
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_transfer_leadership(&mut self, d: &TestData) -> HResult {
        let from = fatal(d.scan_args_u64("from"))?;
        let to = fatal(d.scan_args_u64("to"))?;
        if from == 0 || from > self.nodes.len() as u64 {
            fatal(Err("expected valid \"from\" argument".to_string()))?;
        }
        if to == 0 || to > self.nodes.len() as u64 {
            fatal(Err("expected valid \"to\" argument".to_string()))?;
        }
        self.transfer_leadership(from, to)
    }

    /// Initiate leadership transfer.
    pub(crate) fn transfer_leadership(&mut self, from: u64, to: u64) -> HResult {
        let from_idx = usize::try_from(from - 1).unwrap_or(usize::MAX);
        self.nodes[from_idx].raw_node.transfer_leader(to);
        Ok(())
    }
}
