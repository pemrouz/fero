// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_log_level.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_logger::LVL_NAMES;
use super::{errorf, HResult};
use crate::datadriven::TestData;
use crate::gofmt::Slice;

impl InteractionEnv {
    pub(crate) fn handle_log_level(&mut self, d: &TestData) -> HResult {
        self.log_level(&d.cmd_args[0].key)
    }

    pub fn log_level(&mut self, name: &str) -> HResult {
        for (i, s) in LVL_NAMES.iter().enumerate() {
            // Go's strings.EqualFold. The names are ASCII.
            if s.eq_ignore_ascii_case(name) {
                self.output.set_lvl(i);
                return Ok(());
            }
        }
        errorf(format!("log levels must be either of {}", Slice(&LVL_NAMES)))
    }
}
