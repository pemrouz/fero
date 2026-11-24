// Licensed under the Apache License, Version 2.0.

//! Port of `rafttest/interaction_env_handler_add_nodes.go`.

use super::interaction_env::{raft_config_stub, InteractionEnv, Node, Storage, TestConfig};
use super::interaction_env_handler::first_as_int;
use super::{errorf, fatal, HResult};
use crate::datadriven::TestData;
use crate::gofmt::quote;
use raft::raftpb as pb;
use raft::{MemoryStorage, RawNode};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

impl InteractionEnv {
    pub(crate) fn handle_add_nodes(&mut self, d: &TestData) -> HResult {
        let n = first_as_int(d)?;
        let mut snap_slot = None;
        let snap = pb::ensure_snapshot(&mut snap_slot);
        let mut cfg = raft_config_stub();
        for arg in &d.cmd_args[1..] {
            for i in 0..arg.vals.len() {
                match arg.key.as_str() {
                    "voters" => {
                        let id = fatal(arg.scan_u64(i))?;
                        pb::ensure_conf_state(&mut pb::ensure_snapshot_metadata(&mut snap.metadata).conf_state)
                            .voters
                            .push(id);
                    }
                    "learners" => {
                        let id = fatal(arg.scan_u64(i))?;
                        pb::ensure_conf_state(&mut pb::ensure_snapshot_metadata(&mut snap.metadata).conf_state)
                            .learners
                            .push(id);
                    }
                    "inflight" => {
                        cfg.max_inflight_msgs = fatal(arg.scan_i64(i))?;
                    }
                    "index" => {
                        let idx = fatal(arg.scan_u64(i))?;
                        pb::ensure_snapshot_metadata(&mut snap.metadata).index = Some(idx);
                        cfg.applied = snap.get_metadata_index();
                    }
                    "content" => {
                        // Go scans into a []byte, which datadriven does not
                        // support: it fails the test.
                        fatal(Err(format!(
                            "{}: {}: failed to scan argument {}: unsupported type *[]uint8 (might be easy to add it)",
                            d.pos, arg.key, i
                        )))?;
                    }
                    "async-storage-writes" => {
                        cfg.async_storage_writes = fatal(arg.scan_bool(i))?;
                    }
                    "prevote" => {
                        cfg.pre_vote = fatal(arg.scan_bool(i))?;
                    }
                    "checkquorum" => {
                        cfg.check_quorum = fatal(arg.scan_bool(i))?;
                    }
                    "max-committed-size-per-ready" => {
                        cfg.max_committed_size_per_ready = fatal(arg.scan_u64(i))?;
                    }
                    "disable-conf-change-validation" => {
                        cfg.disable_conf_change_validation = fatal(arg.scan_bool(i))?;
                    }
                    "read-only" => match arg.vals[i].as_str() {
                        "safe" => cfg.read_only_option = raft::ReadOnlyOption::ReadOnlySafe,
                        "lease-based" => cfg.read_only_option = raft::ReadOnlyOption::ReadOnlyLeaseBased,
                        other => return errorf(format!("invalid read-only option {}", quote(other))),
                    },
                    "step-down-on-removal" => {
                        cfg.step_down_on_removal = fatal(arg.scan_bool(i))?;
                    }
                    _ => {}
                }
            }
        }
        let snap = snap_slot.unwrap_or_default();
        self.add_nodes(n, cfg, snap)
    }
}

/// Go's `snapOverrideStorage`: a MemoryStorage whose `Snapshot()` is taken
/// over by a function. In Go that function reads the last snapshot of the
/// node's `History`; here the storage holds the shared history itself.
///
/// The node and the environment both use the storage, so it is a shared
/// handle (Go shares a pointer).
#[derive(Clone, Debug)]
pub struct SnapOverrideStorage {
    storage: Rc<RefCell<MemoryStorage>>,
    snapshot_override: Option<Rc<RefCell<Vec<pb::Snapshot>>>>,
}

impl SnapOverrideStorage {
    /// The storage of the config stub. Each node gets its own before use.
    pub(crate) fn placeholder() -> SnapOverrideStorage {
        SnapOverrideStorage { storage: Rc::new(RefCell::new(MemoryStorage::new())), snapshot_override: None }
    }
}

impl raft::Storage for SnapOverrideStorage {
    fn initial_state(&self) -> Result<(Option<pb::HardState>, pb::ConfState), raft::Error> {
        self.storage.borrow().initial_state()
    }
    fn entries(&self, lo: u64, hi: u64, max_size: u64) -> Result<Vec<pb::Entry>, raft::Error> {
        self.storage.borrow().entries(lo, hi, max_size)
    }
    fn term(&self, i: u64) -> Result<u64, raft::Error> {
        self.storage.borrow().term(i)
    }
    fn last_index(&self) -> Result<u64, raft::Error> {
        self.storage.borrow().last_index()
    }
    fn first_index(&self) -> Result<u64, raft::Error> {
        self.storage.borrow().first_index()
    }
    fn snapshot(&self) -> Result<pb::Snapshot, raft::Error> {
        if let Some(history) = &self.snapshot_override {
            let snaps = history.borrow();
            return Ok(snaps[snaps.len() - 1].clone());
        }
        self.storage.borrow().snapshot()
    }
}

impl Storage for SnapOverrideStorage {
    fn set_hard_state(&self, state: Option<pb::HardState>) -> Result<(), raft::Error> {
        self.storage.borrow_mut().set_hard_state(state)
    }
    fn apply_snapshot(&self, snap: pb::Snapshot) -> Result<(), raft::Error> {
        self.storage.borrow_mut().apply_snapshot(snap)
    }
    fn compact(&self, new_first_index: u64) -> Result<(), raft::Error> {
        self.storage.borrow_mut().compact(new_first_index)
    }
    fn append(&self, ents: &[pb::Entry]) -> Result<(), raft::Error> {
        self.storage.borrow_mut().append(ents)
    }
}

impl InteractionEnv {
    /// AddNodes adds n new nodes initialized from the given snapshot (which may be
    /// empty), and using the cfg as template. They will be assigned consecutive IDs.
    pub fn add_nodes(&mut self, n: i64, cfg: TestConfig, snap: pb::Snapshot) -> HResult {
        let mut empty_slot = None;
        pb::ensure_snapshot(&mut empty_slot);
        let empty_snapshot = empty_slot.unwrap_or_default();
        let mut snap_slot = Some(snap);
        pb::ensure_snapshot(&mut snap_slot);
        let mut snap = snap_slot.unwrap_or_default();
        let bootstrap = snap != empty_snapshot;
        let mut i = 0;
        while i < n {
            i += 1;
            let id = 1 + self.nodes.len() as u64;
            let history: Rc<RefCell<Vec<pb::Snapshot>>> = Rc::new(RefCell::new(Vec::new()));
            let s = SnapOverrideStorage {
                storage: Rc::new(RefCell::new(MemoryStorage::new())),
                // When you ask for a snapshot, you get the most recent snapshot.
                //
                // TODO(tbg): this is sort of clunky, but MemoryStorage itself will
                // give you some fixed snapshot and also the snapshot changes
                // whenever you compact the logs and vice versa, so it's all a bit
                // awkward to use.
                snapshot_override: Some(history.clone()),
            };
            if bootstrap {
                // NB: we could make this work with 1, but MemoryStorage just
                // doesn't play well with that and it's not a loss of generality.
                if snap.get_metadata_index() <= 1 {
                    return errorf("index must be specified as > 1 due to bootstrap");
                }
                pb::ensure_snapshot_metadata(&mut snap.metadata).term = Some(1);
                s.apply_snapshot(snap.clone())?;
                let fi = raft::Storage::first_index(&s)?;
                // At the time of writing and for *MemoryStorage, applying a
                // snapshot also truncates appropriately, but this would change with
                // other storage engines potentially.
                let exp = snap.get_metadata_index() + 1;
                if fi != exp {
                    return errorf(format!("failed to establish first index {exp}; got {fi}"));
                }
            }
            let mut cfg = cfg.clone(); // fork the config stub
            cfg.id = id;
            cfg.storage = s.clone();
            if let Some(on_config) = &self.options.on_config {
                on_config(&mut cfg);
                if cfg.id != id {
                    // This could be supported but then we need to do more work
                    // translating back and forth -- not worth it.
                    return errorf("OnConfig must not change the ID");
                }
            }
            if cfg.logger.is_some() {
                return errorf("OnConfig must not set Logger");
            }
            cfg.logger = Some(Arc::new(self.output.clone()));

            let rn = RawNode::new(cfg.clone())?;

            history.borrow_mut().push(snap.clone());
            let node = Node {
                raw_node: rn,
                // TODO(tbg): allow a more general Storage, as long as it also allows
                // us to apply snapshots, append entries, and update the HardState.
                storage: s,
                config: cfg,
                append_work: Vec::new(),
                apply_work: Vec::new(),
                history,
            };
            self.nodes.push(node);
        }
        Ok(())
    }
}
