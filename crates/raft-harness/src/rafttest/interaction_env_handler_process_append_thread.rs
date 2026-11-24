// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_process_append_thread.go`.

use super::interaction_env::{default_entry_formatter, InteractionEnv, Node, Storage};
use super::interaction_env_handler::node_idxs;
use super::{errorf, HResult};
use crate::datadriven::TestData;
use raft::raftpb as pb;

impl InteractionEnv {
    pub(crate) fn handle_process_append_thread(&mut self, d: &TestData) -> HResult {
        let idxs = node_idxs(d)?;
        for idx in &idxs {
            let idx = *idx;
            let err: HResult = if idxs.len() > 1 {
                self.output.write_string(&format!("> {} processing append thread\n", idx + 1));
                self.with_indent(|env| env.process_append_thread(idx))
            } else {
                self.process_append_thread(idx)
            };
            err?;
        }
        Ok(())
    }

    /// ProcessAppendThread runs processes a single message on the "append" thread of
    /// the node with the given index.
    pub fn process_append_thread(&mut self, idx: usize) -> HResult {
        let n = &mut self.nodes[idx];
        if n.append_work.is_empty() {
            self.output.write_string("no append work to perform");
            return Ok(());
        }
        let mut m = n.append_work.remove(0);

        let resps = std::mem::take(&mut m.responses);
        self.output.write_string("Processing:\n");
        self.output.write_string(&(raft::util::describe_message(&m, Some(&default_entry_formatter)) + "\n"));
        let st = pb::HardState { term: Some(m.get_term()), vote: Some(m.get_vote()), commit: Some(m.get_commit()) };
        let mut cloned: Option<pb::Snapshot> = m.get_snapshot().cloned();
        pb::ensure_snapshot(&mut cloned);
        process_append(n, Some(&st), m.get_entries(), cloned.as_ref())?;

        self.output.write_string("Responses:\n");
        for m in &resps {
            self.output.write_string(&(raft::util::describe_message(m, Some(&default_entry_formatter)) + "\n"));
        }
        self.messages.extend(resps);
        Ok(())
    }
}

pub(crate) fn process_append(
    n: &Node,
    st: Option<&pb::HardState>,
    ents: &[pb::Entry],
    snap: Option<&pb::Snapshot>,
) -> HResult {
    // TODO(tbg): the order of operations here is not necessarily safe. See:
    // https://github.com/etcd-io/etcd/pull/10861
    let s = &n.storage;
    if !raft::is_empty_hard_state(st) {
        s.set_hard_state(st.cloned())?;
    }
    if !raft::is_empty_snap(snap) {
        if !ents.is_empty() {
            return errorf("can't apply snapshot and entries at the same time");
        }
        return Ok(s.apply_snapshot(snap.cloned().unwrap_or_default())?);
    }
    Ok(s.append(ents)?)
}
