// Licensed under the Apache License, Version 2.0.

//! The differential fuzz, Rust side: replays scripts that etcd's Go code
//! filled in, and checks the port prints the same bytes.
//!
//! The Go side is `diff/zz_raft_diff_test.go`; the scripts come from
//! `diff/gen_scripts.ts`; `diff/run_diff.sh` runs all of it.
//!
//! Two commands are not etcd harness commands. The Go driver adds them, and
//! so does this replay:
//! - `read-index <node> <ctx>`: a linearizable read on one node.
//! - `restart <node>`: a crash. The node is built again from its storage;
//!   work queued for its append and apply threads is lost.
//!
//! Both sides pin the election jitter to 0, so both are deterministic.

use crate::datadriven::{read_test_data, run_test, Fatal, FileResult, TestData};
use crate::rafttest::{InteractionEnv, InteractionOpts};
use raft::{Rand, RawNode};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;

/// The election jitter of the fuzz: always 0, as the patched Go side.
#[derive(Debug)]
struct ZeroRand;

impl Rand for ZeroRand {
    fn intn(&self, _n: i64) -> i64 {
        0
    }
}

/// A fresh environment, set up as the Go driver sets it up.
pub fn new_env() -> InteractionEnv {
    InteractionEnv::new(Some(InteractionOpts {
        on_config: Some(Box::new(|cfg| cfg.rand = Arc::new(ZeroRand))),
        set_randomized_election_timeout: Some(Box::new(|node, timeout| {
            node.set_randomized_election_timeout(timeout);
        })),
    }))
}

/// Go's `fmt.Sscanf(key, "%d", &idx)` followed by `env.Nodes[idx-1]`. A scan
/// that fails leaves 0 in Go, and the index -1 panics there; so it does here.
fn node_idx(env: &InteractionEnv, d: &TestData) -> usize {
    let n: i64 = d.cmd_args[0].key.parse().unwrap_or(0);
    match usize::try_from(n - 1) {
        Ok(i) if i < env.nodes.len() => i,
        _ => panic!("index out of range [{}] with length {}", n - 1, env.nodes.len()),
    }
}

/// Handles one directive: the two added commands here, the rest in etcd's
/// own handler.
pub fn handle(env: &mut InteractionEnv, d: &TestData) -> Result<String, Fatal> {
    match d.cmd.as_str() {
        "read-index" => {
            let idx = node_idx(env, d);
            let rctx = d.cmd_args[1].key.as_bytes().to_vec();
            env.nodes[idx].raw_node.read_index(Some(rctx));
            Ok("ok".to_string())
        }
        "restart" => {
            let idx = node_idx(env, d);
            env.output.reset();
            let n = &mut env.nodes[idx];
            let mut cfg = n.config.clone();
            cfg.applied = n.history.borrow().last().map_or(0, raft::raftpb::Snapshot::get_metadata_index);
            let rn = match RawNode::new(cfg) {
                Ok(rn) => rn,
                Err(e) => panic!("{e}"),
            };
            n.raw_node = rn;
            n.append_work = Vec::new();
            n.apply_work = Vec::new();
            if env.output.is_empty() {
                Ok("ok".to_string())
            } else {
                Ok(env.output.string())
            }
        }
        _ => env.handle(d),
    }
}

/// What the Go side noted when it panicked in a script.
#[derive(Clone, Debug)]
pub struct PanicCheck {
    /// The directive (counted from 0) where Go panicked.
    pub go_at: usize,
    /// The directive where the port panicked, if it did.
    pub rust_at: Option<usize>,
    /// Go's note: `directive N (line): message`.
    pub go_note: String,
    /// The port's panic message.
    pub rust_msg: String,
}

impl PanicCheck {
    pub fn ok(&self) -> bool {
        self.rust_at == Some(self.go_at)
    }
}

/// The result of one script.
#[derive(Clone, Debug)]
pub struct ScriptResult {
    pub result: FileResult,
    pub panic: Option<PanicCheck>,
}

impl ScriptResult {
    pub fn ok(&self) -> bool {
        self.result.ok() && self.panic.as_ref().is_none_or(PanicCheck::ok)
    }
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Replays one Go-filled script. `filled` is the script with Go's outputs.
/// When Go panicked there is a note in `<filled>.panic`; then `original`
/// (the script as generated) is replayed on a fresh environment, and the
/// port must panic at the same directive.
pub fn run_script(filled: &Path, original: Option<&Path>, name: &str) -> ScriptResult {
    let mut env = new_env();
    let result = run_test(filled, name, |d| handle(&mut env, d));
    let mut note_path = filled.as_os_str().to_owned();
    note_path.push(".panic");
    let Ok(note) = std::fs::read_to_string(Path::new(&note_path)) else {
        return ScriptResult { result, panic: None };
    };
    let go_note = note.trim().to_string();
    let go_at = go_note
        .strip_prefix("directive ")
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(usize::MAX);
    let mut check = PanicCheck { go_at, rust_at: None, go_note, rust_msg: String::new() };
    let text = original.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    if let Ok(ds) = read_test_data(&text, name) {
        let mut env = new_env();
        for (i, d) in ds.iter().enumerate() {
            match catch_unwind(AssertUnwindSafe(|| handle(&mut env, d))) {
                Ok(Ok(_)) => {}
                Ok(Err(fatal)) => {
                    check.rust_msg = format!("fatal, not a panic: {fatal}");
                    break;
                }
                Err(p) => {
                    check.rust_at = Some(i);
                    check.rust_msg = panic_text(p.as_ref());
                    break;
                }
            }
        }
    }
    ScriptResult { result, panic: Some(check) }
}
