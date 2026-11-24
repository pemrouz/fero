// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler.go`.

use super::interaction_env::InteractionEnv;
use super::{fatal, HResult, Stop};
use crate::datadriven::{parse_int, Fatal, TestData};

impl InteractionEnv {
    /// Handle handles the given directive.
    pub fn handle(&mut self, d: &TestData) -> Result<String, Fatal> {
        self.output.reset();
        let err: HResult = match d.cmd.as_str() {
            "_breakpoint" => {
                // This is a helper case to attach a debugger to when a problem needs
                // to be investigated in a longer test file. In such a case, add the
                // following stanza immediately before the interesting behavior starts:
                //
                // _breakpoint:
                // ----
                // ok
                //
                // and set a breakpoint on the `case` above.
                Ok(())
            }
            "add-nodes" => {
                // Example:
                //
                // add-nodes <number-of-nodes-to-add> voters=(1 2 3) learners=(4 5) index=2 content=foo async-storage-writes=true
                self.handle_add_nodes(d)
            }
            "campaign" => {
                // Example:
                //
                // campaign <id-of-candidate>
                self.handle_campaign(d)
            }
            "compact" => {
                // Example:
                //
                // compact <id> <new-first-index>
                self.handle_compact(d)
            }
            "deliver-msgs" => {
                // Deliver the messages for a given recipient.
                //
                // Example:
                //
                // deliver-msgs <idx> type=MsgApp drop=(2,3)
                self.handle_deliver_msgs(d)
            }
            "process-ready" => {
                // Example:
                //
                // process-ready 3
                self.handle_process_ready(d)
            }
            "process-append-thread" => {
                // Example:
                //
                // process-append-thread 3
                self.handle_process_append_thread(d)
            }
            "process-apply-thread" => {
                // Example:
                //
                // process-apply-thread 3
                self.handle_process_apply_thread(d)
            }
            "log-level" => {
                // Set the log level. NONE disables all output, including from the test
                // harness (except errors).
                //
                // Example:
                //
                // log-level WARN
                self.handle_log_level(d)
            }
            "raft-log" => {
                // Print the Raft log.
                //
                // Example:
                //
                // raft-log 3
                self.handle_raft_log(d)
            }
            "raft-state" => {
                // Print Raft state of all nodes (whether the node is leading,
                // following, etc.). The information for node n is based on
                // n's view.
                self.handle_raft_state()
            }
            "set-randomized-election-timeout" => {
                // Set the randomized election timeout for the given node. Will be reset
                // again when the node changes state.
                //
                // Example:
                //
                // set-randomized-election-timeout 1 timeout=5
                self.handle_set_randomized_election_timeout(d)
            }
            "stabilize" => {
                // Deliver messages to and run process-ready on the set of IDs until
                // no more work is to be done. If no ids are given, all nodes are used.
                //
                // Example:
                //
                // stabilize 1 4
                self.handle_stabilize(d)
            }
            "status" => {
                // Print Raft status.
                //
                // Example:
                //
                // status 5
                self.handle_status(d)
            }
            "tick-election" => {
                // Tick an election timeout interval for the given node (but beware the
                // randomized timeout).
                //
                // Example:
                //
                // tick-election 3
                self.handle_tick_election(d)
            }
            "tick-heartbeat" => {
                // Tick a heartbeat interval.
                //
                // Example:
                //
                // tick-heartbeat 3
                self.handle_tick_heartbeat(d)
            }
            "transfer-leadership" => {
                // Transfer the Raft leader.
                //
                // Example:
                //
                // transfer-leadership from=1 to=4
                self.handle_transfer_leadership(d)
            }
            "forget-leader" => {
                // Forgets the current leader of the given node.
                //
                // Example:
                //
                // forget-leader 1
                self.handle_forget_leader(d)
            }
            "send-snapshot" => {
                // Sends a snapshot to a node. Takes the source and destination node.
                // The message will be queued, but not delivered automatically.
                //
                // Example: send-snapshot 1 3
                //
                // As in Go, an error this handler returns is dropped. Its
                // `t.Fatal` is not.
                match self.handle_send_snapshot(d) {
                    Err(Stop::Fatal(f)) => Err(Stop::Fatal(f)),
                    _ => Ok(()),
                }
            }
            "propose" => {
                // Propose an entry.
                //
                // Example:
                //
                // propose 1 foo
                self.handle_propose(d)
            }
            "propose-conf-change" => {
                // Propose a configuration change, or transition out of a previously
                // proposed joint configuration change that requested explicit
                // transitions. When adding nodes, this command can be used to
                // logically add nodes to the configuration, but add-nodes is needed
                // to "create" the nodes.
                //
                // propose-conf-change node_id [v1=<bool>] [transition=<string>]
                // command string
                // See ConfChangesFromString for command string format.
                // Arguments are:
                //    node_id - the node proposing the configuration change.
                //    v1 - make one change at a time, false by default.
                //    transition - "auto" (the default), "explicit" or "implicit".
                // Example:
                //
                // propose-conf-change 1 v1=true
                // v5
                //
                // Example:
                //
                // propose-conf-change 2 v1=true
                // v5
                //
                // Example:
                //
                // propose-conf-change 1 transition=explicit
                // v1 v3 l4 r5
                //
                // Example:
                //
                // propose-conf-change 2
                // v1 v3 l4 r5
                self.handle_propose_conf_change(d)
            }
            "report-unreachable" => {
                // Calls <1st>.ReportUnreachable(<2nd>).
                //
                // Example:
                // report-unreachable 1 2
                self.handle_report_unreachable(d)
            }
            _ => Err(Stop::Err("unknown command".to_string())),
        };
        // NB: the highest log level suppresses all output, including that of the
        // handlers. This comes in useful during setup which can be chatty.
        // However, errors are always logged.
        match err {
            Ok(()) => {}
            Err(Stop::Fatal(f)) => return Err(f),
            Err(Stop::Err(e)) => {
                if self.output.quiet() {
                    return Ok(e);
                }
                self.output.write_string(&e);
            }
        }
        if self.output.is_empty() {
            return Ok("ok".to_string());
        }
        Ok(self.output.string())
    }
}

/// Go's `firstAsInt`. A missing first argument is an index panic in Go, and
/// here.
pub(crate) fn first_as_int(d: &TestData) -> Result<i64, Stop> {
    fatal(parse_int(&d.cmd_args[0].key))
}

pub(crate) fn first_as_node_idx(d: &TestData) -> Result<usize, Stop> {
    let n = first_as_int(d)?;
    fatal(idx_of(n - 1))
}

/// Go indexes a slice with an `int`; a negative one panics there.
pub(crate) fn idx_of(n: i64) -> Result<usize, Fatal> {
    usize::try_from(n).map_err(|_| format!("index out of range [{n}]"))
}

pub(crate) fn node_idxs(d: &TestData) -> Result<Vec<usize>, Stop> {
    let mut ints = Vec::new();
    for arg in &d.cmd_args {
        if !arg.vals.is_empty() {
            continue;
        }
        let n = fatal(parse_int(&arg.key))?;
        ints.push(fatal(idx_of(n - 1))?);
    }
    Ok(ints)
}
