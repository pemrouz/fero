//! The probe P2 world: three servers, two Raft groups.
//!
//! Each group has one replica on each server, so three voters. A replica is
//! the ported `raft::RawNode`. Its storage keeps exactly what it persisted:
//! the hard state, the entries and the snapshot. A crash drops the `RawNode`
//! and keeps the storage. A restart builds a new `RawNode` on it, which
//! applies the committed entries again from the first one.
//!
//! This world is a stand-in for the real kernel, which comes in slice 1.

use crate::exec::{Chaos, Exec, Out, Outcome, World};
use crate::num::{ix, ix64, len64};
use crate::payload;
use crate::rng::{mix, Rng};
use crate::trace::Trace;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;
use core::sync::atomic::{AtomicU64, Ordering};
use raft::raftpb as pb;
use raft::{is_empty_hard_state, is_empty_snap, Config, Error, MemoryStorage, Rand, RawNode, ReadOnlyOption};
use raft::{StateType, Storage};

pub const SERVERS: u32 = 3;
pub const GROUPS: u32 = 2;

const ELECTION_TICK: i64 = 10;
const HEARTBEAT_TICK: i64 = 1;
const MAX_SIZE_PER_MSG: u64 = 1 << 20;
const MAX_INFLIGHT_MSGS: i64 = 256;

// Trace tags of this world. The executive's own tags are below 0x20.
const T_STEP: u8 = 0x20;
const T_PROPOSE: u8 = 0x21;
const T_NO_PROPOSE: u8 = 0x22;
const T_SOFT: u8 = 0x23;
const T_HARD: u8 = 0x24;
const T_SNAP: u8 = 0x25;
const T_ENTRIES: u8 = 0x26;
const T_COMMIT: u8 = 0x27;
const T_REPLICA: u8 = 0x28;
const T_DUMP: u8 = 0x30;

/// Where committed entries go. The WASM build hands them to JavaScript; the
/// native build drops them.
pub trait BatchSink {
    /// False when nobody reads the batches, so none is built.
    const ACTIVE: bool;
    /// One batch of committed entries of one replica, in log order.
    ///
    /// `bytes` holds each entry as a varint length and then that many bytes
    /// (see [`payload`]). An empty entry has length zero; a new leader writes
    /// one. The entry at position `i` has the log index `first_index + i`.
    /// A restarted replica starts again at the first index of its log.
    fn batch(&mut self, server: u32, group: u32, first_index: u64, bytes: &[u8]);
}

/// A sink that drops every batch.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSink;

impl BatchSink for NoSink {
    const ACTIVE: bool = false;
    fn batch(&mut self, _server: u32, _group: u32, _first_index: u64, _bytes: &[u8]) {}
}

/// What a replica has persisted. The replica and the world share it, so it
/// outlives a crash.
#[derive(Clone, Debug)]
pub struct Disk(Rc<RefCell<MemoryStorage>>);

impl Disk {
    /// An empty disk of a replica that knows the three voters.
    fn new() -> Disk {
        let mut ms = MemoryStorage::new();
        let conf_state = pb::ConfState { voters: vec![1, 2, 3], ..Default::default() };
        let metadata = pb::SnapshotMetadata { conf_state: Some(conf_state), index: None, term: None };
        ms.apply_snapshot(pb::Snapshot { data: None, metadata: Some(metadata) }).expect("the first snapshot applies");
        Disk(Rc::new(RefCell::new(ms)))
    }
}

impl Storage for Disk {
    fn initial_state(&self) -> Result<(Option<pb::HardState>, pb::ConfState), Error> {
        self.0.borrow().initial_state()
    }
    fn entries(&self, lo: u64, hi: u64, max_size: u64) -> Result<Vec<pb::Entry>, Error> {
        self.0.borrow().entries(lo, hi, max_size)
    }
    fn term(&self, i: u64) -> Result<u64, Error> {
        self.0.borrow().term(i)
    }
    fn last_index(&self) -> Result<u64, Error> {
        self.0.borrow().last_index()
    }
    fn first_index(&self) -> Result<u64, Error> {
        self.0.borrow().first_index()
    }
    fn snapshot(&self) -> Result<pb::Snapshot, Error> {
        self.0.borrow().snapshot()
    }
}

/// The election jitter of one replica: its own seeded stream.
#[derive(Debug)]
struct Jitter(AtomicU64);

impl Rand for Jitter {
    fn intn(&self, n: i64) -> i64 {
        let x = self.0.load(Ordering::Relaxed).wrapping_add(0x9e37_79b9_7f4a_7c15);
        self.0.store(x, Ordering::Relaxed);
        let n = u64::try_from(n).expect("intn needs n > 0");
        i64::try_from(mix(x) % n).expect("smaller than n")
    }
}

/// A Raft message between two servers, with its group.
#[derive(Debug)]
pub struct P2Msg {
    pub group: u32,
    pub m: pb::Message,
}

#[derive(Debug)]
struct Replica {
    /// `None` while the server is down.
    node: Option<RawNode<Disk>>,
    disk: Disk,
    jitter: Arc<Jitter>,
    /// The last index this life of the replica applied.
    applied: u64,
    /// How many client writes this life of the replica applied.
    writes: u64,
}

/// The monitors of one group.
#[derive(Debug, Default)]
struct Monitor {
    /// The hash of the entry first applied at each index; position 0 is
    /// index 1.
    applied: Vec<u64>,
    /// The leader of each term.
    leaders: BTreeMap<u64, u64>,
}

impl Monitor {
    /// Every replica applies the same entry bytes at the same index.
    fn applies(&mut self, group: u32, server: u32, index: u64, digest: u64) {
        let seen = len64(&self.applied);
        if index == seen + 1 {
            self.applied.push(digest);
        } else if index >= 1 && index <= seen {
            let first = self.applied[ix64(index - 1)];
            assert!(
                first == digest,
                "monitor: group {group}, server {server} applied a different entry at index {index}"
            );
        } else {
            panic!("monitor: group {group}, server {server} applied index {index} but only {seen} are known");
        }
    }

    /// A term has at most one leader.
    fn leads(&mut self, group: u32, term: u64, id: u64) {
        let first = *self.leaders.entry(term).or_insert(id);
        assert!(first == id, "monitor: group {group} has two leaders in term {term}: {first} and {id}");
    }
}

/// The world of probe P2.
#[derive(Debug)]
pub struct P2World<S: BatchSink> {
    sink: S,
    /// Server by server, then group by group.
    replicas: Vec<Replica>,
    monitors: Vec<Monitor>,
    /// Request ids start here: 2^32 in a tenth of the seeds, else zero.
    req_base: u64,
    req: u64,
    /// The batch being built for the sink.
    batch: Vec<u8>,
}

/// The position of a replica: server by server, then group by group.
fn slot(server: u32, group: u32) -> u32 {
    server * GROUPS + group
}

fn state_code(s: StateType) -> u8 {
    match s {
        StateType::StateFollower => 0,
        StateType::StateCandidate => 1,
        StateType::StateLeader => 2,
        StateType::StatePreCandidate => 3,
    }
}

fn code_of(n: i32) -> u64 {
    u64::from(n.unsigned_abs())
}

fn hash_entry(t: &mut Trace, e: &pb::Entry) {
    t.varint(e.get_term());
    t.varint(e.get_index());
    t.varint(code_of(e.get_type().0));
    t.bytes(e.data.as_deref().unwrap_or(&[]));
}

/// The hash of a message's fields, in the order of `raft.proto`.
fn digest_msg(group: u32, m: &pb::Message) -> u64 {
    let mut t = Trace::new();
    t.varint(u64::from(group));
    t.varint(code_of(m.get_type().0));
    t.varint(m.get_to());
    t.varint(m.get_from());
    t.varint(m.get_term());
    t.varint(m.get_log_term());
    t.varint(m.get_index());
    t.varint(len64(&m.entries));
    for e in &m.entries {
        hash_entry(&mut t, e);
    }
    t.varint(m.get_commit());
    t.varint(m.get_vote());
    match m.get_snapshot() {
        Some(s) => {
            t.u8(1);
            t.varint(s.get_metadata_index());
            t.varint(s.get_metadata_term());
            t.bytes(s.get_data());
        }
        None => t.u8(0),
    }
    t.u8(u8::from(m.get_reject()));
    t.varint(m.get_reject_hint());
    t.bytes(m.get_context());
    t.varint(len64(&m.responses));
    t.value()
}

fn new_node(server: u32, disk: &Disk, jitter: &Arc<Jitter>) -> RawNode<Disk> {
    let config = Config {
        id: u64::from(server) + 1,
        election_tick: ELECTION_TICK,
        heartbeat_tick: HEARTBEAT_TICK,
        storage: disk.clone(),
        applied: 0,
        async_storage_writes: false,
        max_size_per_msg: MAX_SIZE_PER_MSG,
        max_committed_size_per_ready: 0,
        max_uncommitted_entries_size: 0,
        max_inflight_msgs: MAX_INFLIGHT_MSGS,
        max_inflight_bytes: 0,
        check_quorum: true,
        pre_vote: true,
        read_only_option: ReadOnlyOption::ReadOnlySafe,
        logger: None,
        rand: jitter.clone(),
        disable_proposal_forwarding: false,
        disable_conf_change_validation: false,
        step_down_on_removal: false,
    };
    RawNode::new(config).expect("the config is valid")
}

impl<S: BatchSink> P2World<S> {
    /// An empty world. `reset` fills it.
    #[must_use]
    pub fn new(sink: S) -> P2World<S> {
        let mut monitors = Vec::new();
        for _ in 0..GROUPS {
            monitors.push(Monitor::default());
        }
        P2World { sink, replicas: Vec::new(), monitors, req_base: 0, req: 0, batch: Vec::new() }
    }

    /// Drops every replica and what the monitors hold.
    pub fn destroy(&mut self) {
        self.replicas.clear();
        for m in &mut self.monitors {
            m.applied.clear();
            m.leaders.clear();
        }
    }

    /// The server that leads a group now, if one does.
    #[must_use]
    pub fn leader_of(&self, group: u32) -> Option<u32> {
        (0..SERVERS).find(|s| {
            let node = self.replicas[ix(slot(*s, group))].node.as_ref();
            node.is_some_and(|n| n.basic_status().soft_state.raft_state == StateType::StateLeader)
        })
    }

    /// True when every group has a leader.
    #[must_use]
    pub fn all_groups_led(&self) -> bool {
        (0..GROUPS).all(|g| self.leader_of(g).is_some())
    }

    /// True when every replica of a group has applied `writes` client writes.
    #[must_use]
    pub fn all_applied(&self, group: u32, writes: u64) -> bool {
        (0..SERVERS).all(|s| self.replicas[ix(slot(s, group))].writes >= writes)
    }

    /// Proposes one write at one replica. Returns false if it was dropped:
    /// the server is down, or the replica knows no leader.
    pub fn propose(
        &mut self,
        server: u32,
        group: u32,
        op: u8,
        key: &str,
        value_bits: u64,
        out: &mut Out<'_, P2Msg>,
    ) -> bool {
        self.req += 1;
        let data = payload::encode(op, self.req_base + self.req, key, value_bits);
        let Some(node) = self.replicas[ix(slot(server, group))].node.as_mut() else {
            out.trace.u8(T_NO_PROPOSE);
            return false;
        };
        out.trace.u8(T_PROPOSE);
        out.trace.varint(u64::from(server));
        out.trace.varint(u64::from(group));
        out.trace.bytes(&data);
        let taken = node.propose(Some(data)).is_ok();
        out.trace.u8(u8::from(taken));
        out.event();
        self.drain(server, group, out);
        taken
    }

    /// Handles what a replica has ready, the way etcd's own loop does: save,
    /// then send, then apply, until nothing is left.
    fn drain(&mut self, server: u32, group: u32, out: &mut Out<'_, P2Msg>) {
        let P2World { sink, replicas, monitors, batch, .. } = self;
        let r = &mut replicas[ix(slot(server, group))];
        let monitor = &mut monitors[ix(group)];
        let Some(node) = r.node.as_mut() else { return };
        while node.has_ready() {
            let mut rd = node.ready();
            if let Some(ss) = rd.soft_state {
                out.trace.u8(T_SOFT);
                out.trace.varint(ss.lead);
                out.trace.u8(state_code(ss.raft_state));
                if ss.raft_state == StateType::StateLeader {
                    monitor.leads(group, node.basic_status().hard_state.get_term(), u64::from(server) + 1);
                }
            }
            if !is_empty_hard_state(rd.hard_state.as_ref()) {
                let hs = rd.hard_state.clone().unwrap_or_default();
                out.trace.u8(T_HARD);
                out.trace.varint(hs.get_term());
                out.trace.varint(hs.get_vote());
                out.trace.varint(hs.get_commit());
                r.disk.0.borrow_mut().set_hard_state(Some(hs)).expect("the hard state is saved");
            }
            if !is_empty_snap(rd.snapshot.as_ref()) {
                let snap = rd.snapshot.clone().unwrap_or_default();
                out.trace.u8(T_SNAP);
                out.trace.varint(snap.get_metadata_index());
                out.trace.varint(snap.get_metadata_term());
                r.disk.0.borrow_mut().apply_snapshot(snap).expect("the snapshot is saved");
            }
            if !rd.entries.is_empty() {
                out.trace.u8(T_ENTRIES);
                out.trace.varint(len64(&rd.entries));
                for e in &rd.entries {
                    hash_entry(out.trace, e);
                }
                r.disk.0.borrow_mut().append(&rd.entries).expect("the entries are saved");
            }
            for m in core::mem::take(&mut rd.messages) {
                let to = m.get_to();
                assert!((1..=u64::from(SERVERS)).contains(&to), "a message to {to}, which is no server");
                let to = u32::try_from(to - 1).expect("a server number");
                let digest = digest_msg(group, &m);
                out.send(server, to, digest, P2Msg { group, m });
            }
            if !rd.committed_entries.is_empty() {
                let first = rd.committed_entries[0].get_index();
                out.trace.u8(T_COMMIT);
                out.trace.varint(first);
                out.trace.varint(len64(&rd.committed_entries));
                batch.clear();
                for e in &rd.committed_entries {
                    assert!(e.get_type() == pb::EntryNormal, "this world proposes no membership change");
                    let index = e.get_index();
                    assert!(
                        index == r.applied + 1,
                        "server {server} group {group} applies {index} after {}",
                        r.applied
                    );
                    let data = e.data.as_deref().unwrap_or(&[]);
                    let mut d = Trace::new();
                    d.varint(e.get_term());
                    d.bytes(data);
                    out.trace.u64(d.value());
                    monitor.applies(group, server, index, d.value());
                    r.applied = index;
                    if !data.is_empty() {
                        r.writes += 1;
                    }
                    if S::ACTIVE {
                        payload::put_varint(batch, len64(data));
                        batch.extend_from_slice(data);
                    }
                }
                if S::ACTIVE {
                    sink.batch(server, group, first, batch);
                }
            }
            node.advance(rd);
        }
    }
}

impl<S: BatchSink> World for P2World<S> {
    type Msg = P2Msg;

    fn servers(&self) -> u32 {
        SERVERS
    }

    fn reset(&mut self, seed: u64) {
        self.destroy();
        let mut rng = Rng::new(mix(seed ^ 0x5bd1_e995_9e37_79b9));
        self.req_base = if rng.below(10) == 0 { 1 << 32 } else { 0 };
        self.req = 0;
        for server in 0..SERVERS {
            for _ in 0..GROUPS {
                let disk = Disk::new();
                let jitter = Arc::new(Jitter(AtomicU64::new(rng.next_u64())));
                let node = new_node(server, &disk, &jitter);
                self.replicas.push(Replica { node: Some(node), disk, jitter, applied: 0, writes: 0 });
            }
        }
    }

    fn tick(&mut self, server: u32, out: &mut Out<'_, P2Msg>) {
        for group in 0..GROUPS {
            if let Some(node) = self.replicas[ix(slot(server, group))].node.as_mut() {
                node.tick();
                out.event();
                out.trace.u8(T_REPLICA);
                self.drain(server, group, out);
            }
        }
    }

    fn deliver(&mut self, _from: u32, to: u32, msg: P2Msg, out: &mut Out<'_, P2Msg>) {
        let group = msg.group;
        if let Some(node) = self.replicas[ix(slot(to, group))].node.as_mut() {
            // A step may refuse a message (a forwarded write when no leader
            // is known). etcd's loop drops it; the trace records which.
            let taken = node.step(msg.m).is_ok();
            out.event();
            out.trace.u8(T_STEP);
            out.trace.u8(u8::from(taken));
            self.drain(to, group, out);
        }
    }

    fn client(&mut self, rng: &mut Rng, out: &mut Out<'_, P2Msg>) {
        // Every draw is made even if the write is dropped, so the stream of
        // choices does not depend on who is up.
        let group = rng.below(GROUPS);
        let server = rng.below(SERVERS);
        let op = payload::draw_op(rng);
        let key = payload::draw_key(rng);
        let value_bits = payload::draw_value(rng);
        let _ = self.propose(server, group, op, key, value_bits, out);
    }

    fn crash(&mut self, server: u32) {
        for group in 0..GROUPS {
            self.replicas[ix(slot(server, group))].node = None;
        }
    }

    fn restart(&mut self, server: u32, out: &mut Out<'_, P2Msg>) {
        for group in 0..GROUPS {
            let r = &mut self.replicas[ix(slot(server, group))];
            r.applied = 0;
            r.writes = 0;
            r.node = Some(new_node(server, &r.disk, &r.jitter));
            out.event();
            out.trace.u8(T_REPLICA);
            self.drain(server, group, out);
        }
    }

    fn dump(&self, trace: &mut Trace) {
        for server in 0..SERVERS {
            for group in 0..GROUPS {
                let r = &self.replicas[ix(slot(server, group))];
                trace.u8(T_DUMP);
                trace.varint(u64::from(server));
                trace.varint(u64::from(group));
                // What is on the disk.
                let (hs, _) = r.disk.initial_state().expect("the disk reads");
                let hs = hs.unwrap_or_default();
                trace.varint(hs.get_term());
                trace.varint(hs.get_vote());
                trace.varint(hs.get_commit());
                let first = r.disk.first_index().expect("the disk reads");
                let last = r.disk.last_index().expect("the disk reads");
                trace.varint(first);
                trace.varint(last);
                let mut log = Trace::new();
                if last >= first {
                    for e in &r.disk.entries(first, last + 1, u64::MAX).expect("the disk reads") {
                        hash_entry(&mut log, e);
                    }
                }
                trace.u64(log.value());
                // What this life of the replica applied.
                trace.varint(r.applied);
                // What is in memory, if the server is up.
                match r.node.as_ref() {
                    Some(node) => {
                        let st = node.basic_status();
                        trace.u8(1);
                        trace.varint(st.hard_state.get_term());
                        trace.varint(st.hard_state.get_vote());
                        trace.varint(st.hard_state.get_commit());
                        trace.varint(st.soft_state.lead);
                        trace.u8(state_code(st.soft_state.raft_state));
                        trace.varint(st.applied);
                    }
                    None => trace.u8(0),
                }
            }
        }
    }
}

/// The fresh-world scenario of TEST-01's second bar.
///
/// A new world; tick until both groups have a leader; three client writes
/// (set, incr, set) to group 0 at its leader; tick until all three replicas
/// applied them. The caller reads the folded row and destroys the world.
pub fn fresh<S: BatchSink>(exec: &mut Exec<P2World<S>>, seed: u64) -> Outcome {
    exec.begin(seed, Chaos::CALM);
    let mut left = 400;
    while !exec.world().all_groups_led() {
        assert!(left > 0, "no leader in both groups after 400 calm ticks");
        exec.tick();
        left -= 1;
    }
    let lead = exec.world().leader_of(0).expect("group 0 has a leader");
    let writes = [
        (payload::OP_SET, "stock", payload::TEN),
        (payload::OP_INCR, "stock", payload::MINUS_ONE),
        (payload::OP_SET, "name", payload::THREE),
    ];
    for (op, key, value_bits) in writes {
        let taken = exec.act(|w, out| w.propose(lead, 0, op, key, value_bits, out));
        assert!(taken, "the leader took the write");
    }
    let mut left = 100;
    while !exec.world().all_applied(0, 3) {
        assert!(left > 0, "the three writes were not applied after 100 calm ticks");
        exec.tick();
        left -= 1;
    }
    exec.end()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec() -> Exec<P2World<NoSink>> {
        Exec::new(P2World::new(NoSink))
    }

    #[test]
    fn a_seed_gives_the_same_run_twice() {
        let mut a = exec();
        let mut b = exec();
        for seed in 1..=20 {
            let first = a.run_seed(seed, Chaos::P2);
            // `b` runs each seed on a world that has just run another one:
            // a reset in place must leave nothing behind.
            let _ = b.run_seed(seed + 1000, Chaos::P2);
            assert_eq!(first, b.run_seed(seed, Chaos::P2), "seed {seed}");
        }
    }

    #[test]
    fn seeds_differ_and_do_real_work() {
        let mut e = exec();
        let mut hashes = Vec::new();
        let mut writes = 0;
        let mut led = 0;
        for seed in 1..=50 {
            hashes.push(e.run_seed(seed, Chaos::P2).hash);
            let w = e.world();
            for g in 0..GROUPS {
                // Count each write once: the most any replica applied.
                writes += (0..SERVERS).map(|s| w.replicas[ix(slot(s, g))].writes).max().unwrap_or(0);
                led += u64::from(!w.monitors[ix(g)].leaders.is_empty());
            }
        }
        hashes.sort_unstable();
        hashes.dedup();
        assert_eq!(hashes.len(), 50, "two seeds gave one hash");
        assert_eq!(led, 100, "a group never had a leader");
        // 130 ticks, a write in 60 % of them: 78 a seed if none were lost.
        assert!(writes > 50 * 30, "only {writes} writes were applied in 50 seeds");
    }

    #[test]
    fn the_fresh_scenario_applies_three_writes_everywhere() {
        let mut e = exec();
        for seed in 1..=50 {
            let o = fresh(&mut e, seed);
            assert!(o.events > 0);
            assert!(e.world().all_applied(0, 3));
            e.world_mut().destroy();
        }
    }

    #[test]
    #[should_panic(expected = "applied a different entry at index 2")]
    fn the_apply_monitor_can_fail() {
        let mut m = Monitor::default();
        m.applies(0, 0, 1, 11);
        m.applies(0, 0, 2, 22);
        m.applies(0, 1, 1, 11);
        m.applies(0, 1, 2, 23);
    }

    #[test]
    #[should_panic(expected = "two leaders in term 3")]
    fn the_leader_monitor_can_fail() {
        let mut m = Monitor::default();
        m.leads(1, 3, 1);
        m.leads(1, 3, 1);
        m.leads(1, 3, 2);
    }
}
