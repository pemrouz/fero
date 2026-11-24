// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_stabilize.go`.

use super::interaction_env::InteractionEnv;
use super::interaction_env_handler::node_idxs;
use super::interaction_env_handler_deliver_msgs::Recipient;
use super::{fatal, HResult};
use crate::datadriven::TestData;
use raft::raftpb as pb;

impl InteractionEnv {
    pub(crate) fn handle_stabilize(&mut self, d: &TestData) -> HResult {
        let idxs = node_idxs(d)?; // skips key=value args
                                  // Go defers one restore of the level per `log-level` value; they run
                                  // in reverse order when the handler returns, so the level ends up as
                                  // it was at the start.
        let old = self.output.lvl();
        let res = self.handle_stabilize_inner(d, &idxs);
        self.output.set_lvl(old);
        res
    }

    fn handle_stabilize_inner(&mut self, d: &TestData, idxs: &[usize]) -> HResult {
        for arg in &d.cmd_args {
            for i in 0..arg.vals.len() {
                if arg.key.as_str() == "log-level" {
                    let level = fatal(arg.scan_string(i))?;
                    self.log_level(&level)?;
                }
            }
        }
        self.stabilize(idxs)
    }

    /// Stabilize repeatedly runs Ready handling on and message delivery to the set
    /// of nodes specified via the idxs slice until reaching a fixed point.
    pub fn stabilize(&mut self, idxs: &[usize]) -> HResult {
        let nodes: Vec<usize> = if !idxs.is_empty() { idxs.to_vec() } else { (0..self.nodes.len()).collect() };

        loop {
            let mut done = true;
            for &rn in &nodes {
                if self.nodes[rn].raw_node.has_ready() {
                    let idx = id_to_idx(self.nodes[rn].raw_node.status().basic.id);
                    self.output.write_string(&format!("> {} handling Ready\n", idx + 1));
                    let err = self.with_indent(|env| env.process_ready(idx));
                    err?;
                    done = false;
                }
            }
            for &rn in &nodes {
                let id = self.nodes[rn].raw_node.status().basic.id;
                // NB: we grab the messages just to see whether to print the header.
                // DeliverMsgs will do it again.
                if has_msgs(&self.messages, id, None /* typ */, false /* drop */) {
                    self.output.write_string(&format!("> {id} receiving messages\n"));
                    self.with_indent(|env| env.deliver_msgs(None /* typ */, &[Recipient { id, drop: false }]));
                    done = false;
                }
            }
            for &rn in &nodes {
                let idx = id_to_idx(self.nodes[rn].raw_node.status().basic.id);
                if !self.nodes[rn].append_work.is_empty() {
                    self.output.write_string(&format!("> {} processing append thread\n", idx + 1));
                    while !self.nodes[rn].append_work.is_empty() {
                        let err = self.with_indent(|env| env.process_append_thread(idx));
                        err?;
                    }
                    done = false;
                }
            }
            for &rn in &nodes {
                let idx = id_to_idx(self.nodes[rn].raw_node.status().basic.id);
                if !self.nodes[rn].apply_work.is_empty() {
                    self.output.write_string(&format!("> {} processing apply thread\n", idx + 1));
                    while !self.nodes[rn].apply_work.is_empty() {
                        let _ = self.with_indent(|env| env.process_apply_thread(idx));
                    }
                    done = false;
                }
            }
            if done {
                return Ok(());
            }
        }
    }
}

/// Go's `int(rn.Status().ID - 1)`.
fn id_to_idx(id: u64) -> usize {
    usize::try_from(id.wrapping_sub(1)).unwrap_or(usize::MAX)
}

fn matches(msg: &pb::Message, to: u64, typ: Option<pb::MessageType>, drop: bool) -> bool {
    msg.get_to() == to && !(drop && is_local_msg(msg)) && typ.is_none_or(|t| msg.get_type() == t)
}

/// Go calls splitMsgs and looks only at the length of the first result. This
/// answers the same question without moving the messages.
fn has_msgs(msgs: &[pb::Message], to: u64, typ: Option<pb::MessageType>, drop: bool) -> bool {
    msgs.iter().any(|msg| matches(msg, to, typ, drop))
}

/// splitMsgs extracts messages for the given recipient of the given type (-1 for
/// all types) from msgs, and returns them along with the remainder of msgs.
pub(crate) fn split_msgs(
    msgs: Vec<pb::Message>,
    to: u64,
    typ: Option<pb::MessageType>,
    drop: bool,
) -> (Vec<pb::Message>, Vec<pb::Message>) {
    let mut to_msgs = Vec::new();
    let mut rmdr = Vec::new();
    for msg in msgs {
        if matches(&msg, to, typ, drop) {
            to_msgs.push(msg);
        } else {
            rmdr.push(msg);
        }
    }
    (to_msgs, rmdr)
}

/// Don't drop local messages, which require reliable delivery.
fn is_local_msg(msg: &pb::Message) -> bool {
    msg.get_from() == msg.get_to()
        || raft::util::is_local_msg_target(msg.get_from())
        || raft::util::is_local_msg_target(msg.get_to())
}
