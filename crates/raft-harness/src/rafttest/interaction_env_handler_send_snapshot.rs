// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_send_snapshot.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::node_idxs;
use super::{fatal, HResult};
use crate::datadriven::TestData;
use raft::raftpb as pb;
use raft::Storage;

impl InteractionEnv {
    pub(crate) fn handle_send_snapshot(&mut self, d: &TestData) -> HResult {
        let idxs = node_idxs(d)?;
        if idxs.len() != 2 {
            // Go: require.Len(t, idxs, 2)
            fatal(Err(format!("\"{idxs:?}\" should have 2 item(s), but has {}", idxs.len())))?;
        }
        self.send_snapshot(idxs[0], idxs[1])
    }

    /// SendSnapshot sends a snapshot.
    pub fn send_snapshot(&mut self, from_idx: usize, to_idx: usize) -> HResult {
        let snap = self.nodes[from_idx].storage.snapshot()?;
        let (from, to) = (from_idx as u64 + 1, to_idx as u64 + 1);
        let from_status = self.nodes[from_idx].raw_node.basic_status();
        let msg = pb::Message {
            r#type: Some(pb::MsgSnap),
            term: Some(from_status.hard_state.get_term()),
            from: Some(from),
            to: Some(to),
            snapshot: Some(snap),
            ..Default::default()
        };
        let text = raft::util::describe_message(&msg, None);
        self.messages.push(msg);
        self.output.write_string(&text);
        Ok(())
    }
}
