// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_report_unreachable.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::node_idxs;
use super::{errorf, HResult};
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_report_unreachable(&mut self, d: &TestData) -> HResult {
        let sl = node_idxs(d)?;
        if sl.len() != 2 {
            return errorf("must specify exactly two node indexes: node on which to report, and reported node");
        }
        let id = self.nodes[sl[1]].config.id;
        self.nodes[sl[0]].raw_node.report_unreachable(id);
        Ok(())
    }
}
