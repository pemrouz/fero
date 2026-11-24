// Licensed under the Apache License, Version 2.0.

//! Port of etcd raft's `rafttest` package: the `InteractionEnv` that drives
//! whole clusters from the interaction files. One module per Go file.
//!
//! Not ported: `network.go` and `node.go` (they drive Go's goroutine `Node`,
//! which the raft crate does not have), and `doc.go`.
//!
//! How a handler stops, compared with Go:
//! - Go returns an `error`: the text goes to the output. Here `Stop::Err`.
//! - Go calls `t.Fatal`: the test file fails. Here `Stop::Fatal`.

mod interaction_env;
mod interaction_env_handler;
mod interaction_env_handler_add_nodes;
mod interaction_env_handler_campaign;
mod interaction_env_handler_compact;
mod interaction_env_handler_deliver_msgs;
mod interaction_env_handler_forget_leader;
mod interaction_env_handler_log_level;
mod interaction_env_handler_process_append_thread;
mod interaction_env_handler_process_apply_thread;
mod interaction_env_handler_process_ready;
mod interaction_env_handler_propose;
mod interaction_env_handler_propose_conf_change;
mod interaction_env_handler_raft_log;
mod interaction_env_handler_raftstate;
mod interaction_env_handler_report_unreachable;
mod interaction_env_handler_send_snapshot;
mod interaction_env_handler_set_randomized_election_timeout;
mod interaction_env_handler_stabilize;
mod interaction_env_handler_status;
mod interaction_env_handler_tick;
mod interaction_env_handler_transfer_leadership;
mod interaction_env_logger;

pub use interaction_env::{InteractionEnv, InteractionOpts, Node, Storage};
pub use interaction_env_handler_add_nodes::SnapOverrideStorage;
pub use interaction_env_handler_deliver_msgs::Recipient;
pub use interaction_env_logger::RedirectLogger;

/// Why a handler stopped early.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stop {
    /// Go's returned `error`: its text becomes part of the output.
    Err(String),
    /// Go's `t.Fatal`: the file fails.
    Fatal(String),
}

/// What a handler returns. Go's `error`.
pub type HResult = Result<(), Stop>;

impl From<raft::Error> for Stop {
    fn from(e: raft::Error) -> Stop {
        Stop::Err(e.to_string())
    }
}

impl From<raft::gostd::Error> for Stop {
    fn from(e: raft::gostd::Error) -> Stop {
        Stop::Err(e.to_string())
    }
}

/// Turns a failed scan into Go's `t.Fatal`.
pub(crate) fn fatal<T>(r: Result<T, String>) -> Result<T, Stop> {
    r.map_err(Stop::Fatal)
}

/// Go's `errors.New` / `fmt.Errorf`, returned from a handler.
pub(crate) fn errorf<T>(msg: impl Into<String>) -> Result<T, Stop> {
    Err(Stop::Err(msg.into()))
}
