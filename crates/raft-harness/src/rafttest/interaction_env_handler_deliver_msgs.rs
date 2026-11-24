// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_deliver_msgs.go`.

use super::interaction_env::{default_entry_formatter, InteractionEnv};
use super::interaction_env_handler_stabilize::split_msgs;
use super::{fatal, HResult};
use crate::datadriven::TestData;
use raft::raftpb as pb;

impl InteractionEnv {
    pub(crate) fn handle_deliver_msgs(&mut self, d: &TestData) -> HResult {
        // Go's `typ = -1` (any type) is `None`.
        let mut typ: Option<pb::MessageType> = None;
        let mut rs: Vec<Recipient> = Vec::new();
        for arg in &d.cmd_args {
            if arg.vals.is_empty() {
                let id = fatal(raft::gostd::parse_uint(&arg.key).map_err(|e| e.to_string()))?;
                rs.push(Recipient { id, drop: false });
            }
            for i in 0..arg.vals.len() {
                match arg.key.as_str() {
                    "drop" => {
                        let id = fatal(arg.scan_u64(i))?;
                        let mut found = false;
                        for r in &rs {
                            if r.id == id {
                                found = true;
                            }
                        }
                        if found {
                            fatal(Err(format!("can't both deliver and drop msgs to {id}")))?;
                        }
                        rs.push(Recipient { id, drop: true });
                    }
                    "type" => {
                        let s = fatal(arg.scan_string(i))?;
                        match pb::MessageType::from_name(&s) {
                            Some(v) => typ = Some(v),
                            None => fatal(Err(format!("unknown message type {s}")))?,
                        }
                    }
                    _ => {}
                }
            }
        }

        if self.deliver_msgs(typ, &rs) == 0 {
            self.output.write_string("no messages\n");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipient {
    pub id: u64,
    pub drop: bool,
}

impl InteractionEnv {
    /// DeliverMsgs goes through env.Messages and, depending on the Drop flag,
    /// delivers or drops messages to the specified Recipients. Only messages of type
    /// typ are delivered (-1 for all types). Returns the number of messages handled
    /// (i.e. delivered or dropped). A handled message is removed from env.Messages.
    pub fn deliver_msgs(&mut self, typ: Option<pb::MessageType>, rs: &[Recipient]) -> usize {
        let mut n = 0;
        for r in rs {
            let (msgs, rmdr) = split_msgs(std::mem::take(&mut self.messages), r.id, typ, r.drop);
            self.messages = rmdr;
            n += msgs.len();
            for msg in msgs {
                if r.drop {
                    self.output.write_string("dropped: ");
                }
                self.output.write_string(&raft::util::describe_message(&msg, Some(&default_entry_formatter)));
                self.output.write_string("\n");
                if r.drop {
                    // NB: it's allowed to drop messages to nodes that haven't been instantiated yet,
                    // we haven't used msg.To yet.
                    continue;
                }
                // Go: int(msg.GetTo() - 1), an index panic if it is not a node.
                let to_idx = usize::try_from(msg.get_to().wrapping_sub(1)).unwrap_or(usize::MAX);
                if let Err(err) = self.nodes[to_idx].raw_node.step(msg) {
                    self.output.write_string(&format!("{err}\n"));
                }
            }
        }
        n
    }
}
