// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env.go`.

use super::interaction_env_handler_add_nodes::SnapOverrideStorage;
use super::interaction_env_logger::RedirectLogger;
use raft::raftpb as pb;
use raft::{Config, Rand, RawNode};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// The node type the environment drives.
pub type TestRawNode = RawNode<SnapOverrideStorage>;
/// The config type of those nodes.
pub type TestConfig = Config<SnapOverrideStorage>;

/// Go's `func(*raft.Config)`.
pub type OnConfig = Box<dyn Fn(&mut TestConfig)>;
/// Go's `func(node *raft.RawNode, timeout int)`.
pub type SetRandomizedElectionTimeout = Box<dyn Fn(&mut TestRawNode, i64)>;

/// InteractionOpts groups the options for an InteractionEnv.
#[derive(Default)]
pub struct InteractionOpts {
    pub on_config: Option<OnConfig>,

    /// SetRandomizedElectionTimeout is used to plumb this function down from the
    /// raft test package.
    pub set_randomized_election_timeout: Option<SetRandomizedElectionTimeout>,
}

/// Node is a member of a raft group tested via an InteractionEnv.
///
/// Go embeds `*raft.RawNode` and `Storage`; here they are the fields
/// `raw_node` and `storage`.
pub struct Node {
    pub raw_node: TestRawNode,
    pub storage: SnapOverrideStorage,

    pub config: TestConfig,
    pub append_work: Vec<pb::Message>, // []MsgStorageAppend
    pub apply_work: Vec<pb::Message>,  // []MsgStorageApply
    /// Go's `History []*pb.Snapshot`. The storage reads the last one for
    /// `Snapshot()`, so the two share it.
    pub history: Rc<RefCell<Vec<pb::Snapshot>>>,
}

/// InteractionEnv facilitates testing of complex interactions between the
/// members of a raft group.
pub struct InteractionEnv {
    pub options: InteractionOpts,
    pub nodes: Vec<Node>,
    pub messages: Vec<pb::Message>, // in-flight messages

    pub output: RedirectLogger,
}

impl InteractionEnv {
    /// NewInteractionEnv initializes an InteractionEnv. opts may be nil.
    pub fn new(opts: Option<InteractionOpts>) -> InteractionEnv {
        let opts = opts.unwrap_or_default();
        InteractionEnv { options: opts, nodes: Vec::new(), messages: Vec::new(), output: RedirectLogger::new() }
    }

    pub(crate) fn with_indent<T>(&mut self, f: impl FnOnce(&mut InteractionEnv) -> T) -> T {
        let orig = self.output.swap_builder(String::new());
        let res = f(self);

        let inner = self.output.swap_builder(orig);
        // Go reads the text with a bufio.Scanner: one line at a time, the
        // line end (and a carriage return before it) dropped. `lines` does
        // the same.
        for line in inner.lines() {
            self.output.builder_write_string(&format!("  {line}\n"));
        }
        res
    }
}

/// Storage is the interface used by InteractionEnv. It is comprised of raft's
/// Storage interface plus access to operations that maintain the log and drive
/// the Ready handling loop.
pub trait Storage: raft::Storage {
    fn set_hard_state(&self, state: Option<pb::HardState>) -> Result<(), raft::Error>;
    fn apply_snapshot(&self, snap: pb::Snapshot) -> Result<(), raft::Error>;
    fn compact(&self, new_first_index: u64) -> Result<(), raft::Error>;
    fn append(&self, ents: &[pb::Entry]) -> Result<(), raft::Error>;
}

/// The source of election jitter for the nodes of an environment.
///
/// Go draws real random numbers here. The files do not depend on the values
/// (they set the timeout where it matters), so a fixed sequence does the job
/// and keeps every run the same.
#[derive(Debug)]
pub(crate) struct TestRand(AtomicU64);

impl TestRand {
    pub(crate) fn new() -> TestRand {
        TestRand(AtomicU64::new(0x9e37_79b9_7f4a_7c15))
    }
}

impl Rand for TestRand {
    fn intn(&self, n: i64) -> i64 {
        // xorshift64
        let mut x = self.0.load(Ordering::Relaxed);
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0.store(x, Ordering::Relaxed);
        let n = u64::try_from(n).expect("intn needs n > 0");
        i64::try_from(x % n).expect("smaller than n")
    }
}

/// raftConfigStub sets up a raft.Config stub with reasonable testing defaults.
/// In particular, no limits are set. It is not a complete config: ID and Storage
/// must be set for each node using the stub as a template.
pub(crate) fn raft_config_stub() -> TestConfig {
    Config {
        id: 0,
        election_tick: 3,
        heartbeat_tick: 1,
        storage: SnapOverrideStorage::placeholder(),
        applied: 0,
        async_storage_writes: false,
        max_size_per_msg: u64::MAX,
        max_committed_size_per_ready: 0,
        max_uncommitted_entries_size: 0,
        max_inflight_msgs: i64::from(i32::MAX),
        max_inflight_bytes: 0,
        check_quorum: false,
        pre_vote: false,
        read_only_option: raft::ReadOnlyOption::ReadOnlySafe,
        logger: None,
        rand: Arc::new(TestRand::new()),
        disable_proposal_forwarding: false,
        disable_conf_change_validation: false,
        step_down_on_removal: false,
    }
}

pub(crate) fn default_entry_formatter(b: &[u8]) -> String {
    raft::gostd::Quote(b).to_string()
}
