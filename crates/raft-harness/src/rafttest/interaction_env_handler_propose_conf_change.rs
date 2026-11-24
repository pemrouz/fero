// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_propose_conf_change.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::first_as_node_idx;
use super::{errorf, HResult};
use crate::datadriven::TestData;
use crate::gofmt::quote;
use raft::raftpb as pb;

/// Go's `strconv.ParseBool`, with its error text.
fn parse_bool(val: &str) -> Result<bool, String> {
    match val {
        "1" | "t" | "T" | "true" | "TRUE" | "True" => Ok(true),
        "0" | "f" | "F" | "false" | "FALSE" | "False" => Ok(false),
        _ => Err(format!("strconv.ParseBool: parsing {}: invalid syntax", quote(val))),
    }
}

impl InteractionEnv {
    pub(crate) fn handle_propose_conf_change(&mut self, d: &TestData) -> HResult {
        let idx = first_as_node_idx(d)?;
        let mut v1 = false;
        let mut transition = pb::ConfChangeTransitionAuto;
        for arg in &d.cmd_args[1..] {
            for val in &arg.vals {
                match arg.key.as_str() {
                    "v1" => match parse_bool(val) {
                        Ok(b) => v1 = b,
                        Err(err) => return errorf(err),
                    },
                    "transition" => match val.as_str() {
                        "auto" => transition = pb::ConfChangeTransitionAuto,
                        "implicit" => transition = pb::ConfChangeTransitionJointImplicit,
                        "explicit" => transition = pb::ConfChangeTransitionJointExplicit,
                        _ => return errorf(format!("unknown transition {val}")),
                    },
                    _ => return errorf(format!("unknown command {}", arg.key)),
                }
            }
        }

        let ccs = pb::conf_changes_from_string(&d.input)?;

        if v1 {
            if ccs.len() > 1 || transition != pb::ConfChangeTransitionAuto {
                return errorf("v1 conf change can only have one operation and no transition");
            }
            let c = pb::ConfChange {
                r#type: Some(ccs[0].get_type()),
                node_id: Some(ccs[0].get_node_id()),
                ..Default::default()
            };
            self.propose_conf_change(idx, &c)
        } else {
            let c = pb::ConfChangeV2 { transition: Some(transition), changes: ccs, ..Default::default() };
            self.propose_conf_change(idx, &c)
        }
    }

    /// ProposeConfChange proposes a configuration change on the node with the given index.
    pub fn propose_conf_change(&mut self, idx: usize, c: &dyn pb::ConfChangeI) -> HResult {
        Ok(self.nodes[idx].raw_node.propose_conf_change(c)?)
    }
}
