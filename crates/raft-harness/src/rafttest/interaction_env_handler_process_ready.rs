// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_process_ready.go`.

use super::interaction_env::{default_entry_formatter, InteractionEnv};
use super::interaction_env_handler::node_idxs;
use super::interaction_env_handler_process_append_thread::process_append;
use super::interaction_env_handler_process_apply_thread::process_apply;
use super::HResult;
use crate::datadriven::TestData;
use raft::raftpb as pb;

impl InteractionEnv {
    pub(crate) fn handle_process_ready(&mut self, d: &TestData) -> HResult {
        let idxs = node_idxs(d)?;
        for idx in &idxs {
            let idx = *idx;
            let err: HResult = if idxs.len() > 1 {
                self.output.write_string(&format!("> {} handling Ready\n", idx + 1));
                self.with_indent(|env| env.process_ready(idx))
            } else {
                self.process_ready(idx)
            };
            err?;
        }
        Ok(())
    }

    /// ProcessReady runs Ready handling on the node with the given index.
    pub fn process_ready(&mut self, idx: usize) -> HResult {
        // TODO(tbg): Allow simulating crashes here.
        let n = &mut self.nodes[idx];
        let rd = n.raw_node.ready();
        self.output.write_string(&raft::util::describe_ready(&rd, Some(&default_entry_formatter)));

        if !n.config.async_storage_writes {
            process_append(n, rd.hard_state.as_ref(), &rd.entries, rd.snapshot.as_ref())?;
            process_apply(n, &rd.committed_entries)?;
        }

        for m in &rd.messages {
            if raft::util::is_local_msg_target(m.get_to()) {
                if !n.config.async_storage_writes {
                    panic!("unexpected local msg target");
                }
                match m.get_type() {
                    pb::MsgStorageAppend => n.append_work.push(m.clone()),
                    pb::MsgStorageApply => n.apply_work.push(m.clone()),
                    t => panic!("unexpected message type {t}"),
                }
            } else {
                self.messages.push(m.clone());
            }
        }

        if !n.config.async_storage_writes {
            n.raw_node.advance(rd);
        }
        Ok(())
    }
}
