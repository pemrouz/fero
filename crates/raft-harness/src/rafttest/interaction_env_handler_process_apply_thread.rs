// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_process_apply_thread.go`.

use super::interaction_env::{default_entry_formatter, InteractionEnv, Node};
use super::interaction_env_handler::node_idxs;
use super::{errorf, HResult};
use crate::datadriven::TestData;
use raft::raftpb as pb;

impl InteractionEnv {
    pub(crate) fn handle_process_apply_thread(&mut self, d: &TestData) -> HResult {
        let idxs = node_idxs(d)?;
        for idx in &idxs {
            let idx = *idx;
            let err: HResult = if idxs.len() > 1 {
                self.output.write_string(&format!("> {} processing apply thread\n", idx + 1));
                self.with_indent(|env| env.process_apply_thread(idx))
            } else {
                self.process_apply_thread(idx)
            };
            err?;
        }
        Ok(())
    }

    /// ProcessApplyThread runs processes a single message on the "apply" thread of
    /// the node with the given index.
    pub fn process_apply_thread(&mut self, idx: usize) -> HResult {
        let n = &mut self.nodes[idx];
        if n.apply_work.is_empty() {
            self.output.write_string("no apply work to perform");
            return Ok(());
        }
        let mut m = n.apply_work.remove(0);

        let resps = std::mem::take(&mut m.responses);
        self.output.write_string("Processing:\n");
        self.output.write_string(&(raft::util::describe_message(&m, Some(&default_entry_formatter)) + "\n"));
        process_apply(n, m.get_entries())?;

        self.output.write_string("Responses:\n");
        for m in &resps {
            self.output.write_string(&(raft::util::describe_message(m, Some(&default_entry_formatter)) + "\n"));
        }
        self.messages.extend(resps);
        Ok(())
    }
}

pub(crate) fn process_apply(n: &mut Node, ents: &[pb::Entry]) -> HResult {
    for ent in ents {
        let update: Vec<u8>;
        let mut cs: Option<pb::ConfState> = None;
        match ent.get_type() {
            pb::EntryConfChange => {
                let cc = match pb::ConfChange::unmarshal(ent.get_data()) {
                    Ok(cc) => cc,
                    Err(err) => return errorf(err),
                };
                update = cc.get_context().to_vec();
                cs = Some(n.raw_node.apply_conf_change(&cc));
            }
            pb::EntryConfChangeV2 => {
                let cc = match pb::ConfChangeV2::unmarshal(ent.get_data()) {
                    Ok(cc) => cc,
                    Err(err) => return errorf(err),
                };
                cs = Some(n.raw_node.apply_conf_change(&cc));
                update = cc.get_context().to_vec();
            }
            _ => {
                update = ent.get_data().to_vec();
            }
        }

        // Record the new state by starting with the current state and applying
        // the command.
        let mut history = n.history.borrow_mut();
        let last_snap = &history[history.len() - 1];
        let mut snap_slot = None;
        let snap = pb::ensure_snapshot(&mut snap_slot);
        // Go appends to a nil slice: it stays nil while nothing is added.
        let mut data: Vec<u8> = Vec::new();
        data.extend_from_slice(last_snap.get_data());
        data.extend_from_slice(&update);
        snap.data = if data.is_empty() { None } else { Some(data) };
        let md = pb::ensure_snapshot_metadata(&mut snap.metadata);
        md.index = Some(ent.get_index());
        md.term = Some(ent.get_term());
        if cs.is_none() {
            cs = last_snap.get_metadata().and_then(|m| m.get_conf_state()).cloned();
        }
        md.conf_state = cs;
        let snap = snap_slot.unwrap_or_default();
        history.push(snap);
    }
    Ok(())
}
