// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_set_randomized_election_timeout.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::{fatal, HResult};
use crate::datadriven::TestData;

impl InteractionEnv {
    pub(crate) fn handle_set_randomized_election_timeout(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        let timeout = fatal(d.scan_args_i64("timeout"))?;
        if timeout == 0 {
            // Go: require.NotZero(t, timeout)
            fatal(Err("Should not be zero, but was 0".to_string()))?;
        }

        // Go calls the function value without a nil check: a nil one panics.
        let set = match &self.options.set_randomized_election_timeout {
            Some(f) => f,
            None => panic!("SetRandomizedElectionTimeout is not set"),
        };
        set(&mut self.nodes[idx].raw_node, timeout);
        Ok(())
    }
}
