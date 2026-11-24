// Licensed under the Apache License, Version 2.0.

//! The edge value check: messages whose fields hold values from the bottom
//! and the top of `u64`, stepped into one node, compared with etcd's Go code.
//!
//! Go's `uint64` arithmetic wraps. A port that panics on overflow where Go
//! wraps is not the same machine: a peer's message can hold any value. The
//! random scripts of the differential fuzz never send such a message, so
//! this check does.
//!
//! The Go side is `diff/zz_edge_values_test.go`. It prints the number of
//! cases and the FNV-1a hash of all result lines; those are the constants
//! below. This file builds the same lines and must reach the same hash.
//! `EDGE_OUT=<dir>` writes the lines to `<dir>/enum.txt` and `<dir>/seq.txt`,
//! to compare with Go's files when a hash differs.

use raft::raftpb as pb;
use raft::{Config, MemoryStorage, Rand, RawNode, ReadOnlyOption};
use std::fmt::Write as _;
use std::io::Write as _;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// From Go (measured): `enum: lines=1035000 fnv=0xad899dbb74962a14`.
const ENUM_LINES: u64 = 1_035_000;
const ENUM_FNV: u64 = 0xad89_9dbb_7496_2a14;
/// From Go (measured): `seq: lines=500000 fnv=0xd37afbd1cc69e0e8`.
const SEQ_LINES: u64 = 500_000;
const SEQ_FNV: u64 = 0xd37a_fbd1_cc69_e0e8;

const TOP: u64 = u64::MAX;

#[derive(Debug)]
struct ZeroRand;

impl Rand for ZeroRand {
    fn intn(&self, _n: i64) -> i64 {
        0
    }
}

fn conf_state() -> Option<pb::ConfState> {
    Some(pb::ConfState { voters: vec![1, 2, 3], ..Default::default() })
}

/// One node of a three-node group. State 0: a follower. 1: a candidate.
/// 2: a new leader. 3: a leader with one caught-up follower.
fn node(state: u64) -> RawNode<MemoryStorage> {
    let mut st = MemoryStorage::new();
    st.apply_snapshot(pb::Snapshot {
        metadata: Some(pb::SnapshotMetadata { conf_state: conf_state(), index: Some(1), term: Some(1) }),
        ..Default::default()
    })
    .unwrap();
    let cfg = Config {
        id: 1,
        election_tick: 10,
        heartbeat_tick: 1,
        storage: st,
        applied: 0,
        async_storage_writes: false,
        max_size_per_msg: TOP,
        max_committed_size_per_ready: 0,
        max_uncommitted_entries_size: 0,
        max_inflight_msgs: 256,
        max_inflight_bytes: 0,
        check_quorum: false,
        pre_vote: false,
        read_only_option: ReadOnlyOption::ReadOnlySafe,
        logger: None,
        rand: Arc::new(ZeroRand),
        disable_proposal_forwarding: false,
        disable_conf_change_validation: false,
        step_down_on_removal: false,
    };
    let mut rn = RawNode::new(cfg).unwrap();
    let m = |t| pb::Message { r#type: Some(t), from: Some(2), to: Some(1), term: Some(1), ..Default::default() };
    let advance = |rn: &mut RawNode<MemoryStorage>| {
        let rd = rn.ready();
        rn.advance(rd);
    };
    match state {
        0 => {
            let mut h = m(pb::MsgHeartbeat);
            h.commit = Some(0);
            rn.step(h).unwrap();
        }
        1 => {
            rn.campaign().unwrap();
            advance(&mut rn);
        }
        _ => {
            rn.campaign().unwrap();
            advance(&mut rn);
            rn.step(m(pb::MsgVoteResp)).unwrap();
            advance(&mut rn);
            if state == 3 {
                let mut a = m(pb::MsgAppResp);
                a.index = Some(2);
                rn.step(a).unwrap();
                advance(&mut rn);
            }
        }
    }
    rn
}

#[allow(clippy::too_many_arguments)]
fn msg(ty: i32, from: u64, term: u64, idx: u64, lt: u64, c: u64, h: u64, rej: u64, e: u64) -> pb::Message {
    let mut msg = pb::Message {
        r#type: Some(pb::MessageType(ty)),
        from: Some(from),
        to: Some(1),
        term: Some(term),
        index: Some(idx),
        log_term: Some(lt),
        commit: Some(c),
        reject_hint: Some(h),
        reject: Some(rej == 1),
        ..Default::default()
    };
    let entry = |term, index| pb::Entry {
        term: Some(term),
        index: Some(index),
        data: Some(b"x".to_vec()),
        ..Default::default()
    };
    if e == 1 {
        msg.entries = vec![entry(lt, idx.wrapping_add(1))];
    }
    if e == 2 {
        msg.entries = vec![entry(TOP, TOP)];
    }
    if ty == 7 {
        msg.snapshot = Some(pb::Snapshot {
            metadata: Some(pb::SnapshotMetadata { conf_state: conf_state(), index: Some(idx), term: Some(lt) }),
            ..Default::default()
        });
    }
    msg
}

fn describe(o: &mut String, rn: &mut RawNode<MemoryStorage>, err: bool) {
    let s = rn.status();
    let _ = write!(
        o,
        "err={} st={} term={} vote={} commit={} lead={}",
        u8::from(err),
        s.basic.soft_state.raft_state,
        s.basic.hard_state.get_term(),
        s.basic.hard_state.get_vote(),
        s.basic.hard_state.get_commit(),
        s.basic.soft_state.lead
    );
    for (id, p) in &s.progress {
        let _ = write!(o, " p{}={}/{}/{}", id, p.match_, p.next, p.state);
    }
    if rn.has_ready() {
        let rd = rn.ready();
        let _ = write!(o, " rd={}/{}/{}", rd.messages.len(), rd.entries.len(), rd.committed_entries.len());
    }
}

/// Steps the messages into a fresh node. The text after each step, or `P<n>`
/// when step n panics.
fn run(state: u64, msgs: Vec<pb::Message>) -> String {
    let mut step = 0;
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut rn = node(state);
        let mut o = String::new();
        for m in msgs {
            step += 1;
            o.push_str("| ");
            let err = rn.step(m).is_err();
            describe(&mut o, &mut rn, err);
        }
        o
    }));
    r.unwrap_or_else(|_| format!("P{step}"))
}

/// Go's `x*a + c` generator of the Go side, bit for bit.
struct Lcg(u64);

impl Lcg {
    fn n(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % n
    }
    fn pick(&mut self, from: &[u64]) -> u64 {
        let i = self.n(u64::try_from(from.len()).unwrap());
        from[usize::try_from(i).unwrap()]
    }
}

/// Counts and hashes the lines (FNV-1a, 64 bits), and writes them when asked.
struct Sink {
    fnv: u64,
    lines: u64,
    file: Option<std::io::BufWriter<std::fs::File>>,
}

impl Sink {
    fn new(name: &str) -> Sink {
        let file = std::env::var_os("EDGE_OUT")
            .map(|d| std::io::BufWriter::new(std::fs::File::create(std::path::Path::new(&d).join(name)).unwrap()));
        Sink { fnv: 0xcbf2_9ce4_8422_2325, lines: 0, file }
    }
    fn line(&mut self, l: &str) {
        for b in l.bytes().chain(std::iter::once(b'\n')) {
            self.fnv = (self.fnv ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
        if let Some(f) = &mut self.file {
            writeln!(f, "{l}").unwrap();
        }
        self.lines += 1;
    }
}

/// A leader gets an append answer for the top index. Go wraps `Match + 1`
/// to 0 and goes on (measured on Go: the line below). The port used to
/// panic with an overflow there.
#[test]
fn append_answer_with_the_top_index_wraps_as_in_go() {
    let got = run(2, vec![msg(4, 2, 1, TOP, 0, 0, 0, 0, 0)]);
    assert_eq!(
        got,
        "| err=0 st=StateLeader term=1 vote=1 commit=1 lead=1 p1=2/3/StateReplicate \
         p2=18446744073709551615/2/StateSnapshot p3=0/2/StateProbe rd=1/0/0"
    );
}

/// Every message type, on every state, with every mix of the edge values:
/// one message per case.
#[test]
#[cfg_attr(debug_assertions, ignore = "about a million cases: run with --release")]
fn every_message_with_edge_values_equals_go() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut s = Sink::new("enum.txt");
    let vals = [0, 1, 2, TOP - 1, TOP];
    let terms = [0, 1, TOP];
    for state in 0..4u64 {
        for ty in 0..23i32 {
            for term in terms {
                for idx in vals {
                    for lt in vals {
                        for c in vals {
                            for h in vals {
                                for rej in 0..2u64 {
                                    for e in 0..3u64 {
                                        let out = run(state, vec![msg(ty, 2, term, idx, lt, c, h, rej, e)]);
                                        s.line(&format!("{state} {ty} {term} {idx} {lt} {c} {h} {rej} {e} => {out}"));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = std::panic::take_hook();
    assert_eq!((s.lines, s.fnv), (ENUM_LINES, ENUM_FNV), "lines and hash differ from Go's");
}

/// Random runs of four messages from the same space.
#[test]
#[cfg_attr(debug_assertions, ignore = "half a million cases: run with --release")]
fn runs_of_messages_with_edge_values_equal_go() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut s = Sink::new("seq.txt");
    let vals = [0, 1, 2, 3, TOP - 1, TOP];
    let terms = [0, 1, 1, 2, TOP];
    let mut g = Lcg(42);
    for case in 0..SEQ_LINES {
        let state = g.n(4);
        let mut msgs = Vec::new();
        for _ in 0..4 {
            let ty = i32::try_from(g.n(23)).unwrap();
            let from = 2 + g.n(2);
            let term = g.pick(&terms);
            let (idx, lt, c, h) = (g.pick(&vals), g.pick(&vals), g.pick(&vals), g.pick(&vals));
            let (rej, e) = (g.n(2), g.n(3));
            msgs.push(msg(ty, from, term, idx, lt, c, h, rej, e));
        }
        let out = run(state, msgs);
        s.line(&format!("{case} {state} => {out}"));
    }
    let _ = std::panic::take_hook();
    assert_eq!((s.lines, s.fnv), (SEQ_LINES, SEQ_FNV), "lines and hash differ from Go's");
}
