// Smoke test: one raft-rs node elects itself, proposes one entry, and sees it committed.
use raft::{storage::MemStorage, Config, RawNode, StateRole};

fn main() {
    let logger = slog::Logger::root(slog::Discard, slog::o!());
    let storage = MemStorage::new_with_conf_state((vec![1], vec![]));
    let cfg = Config { id: 1, election_tick: 10, heartbeat_tick: 3, ..Default::default() };
    let mut node = RawNode::new(&cfg, storage, &logger).unwrap();
    node.campaign().unwrap();
    let mut proposed = false;
    let mut committed = 0;
    for _ in 0..10 {
        if node.raft.state == StateRole::Leader && !proposed { node.propose(vec![], b"hello".to_vec()).unwrap(); proposed = true; }
        if !node.has_ready() { continue; }
        let mut rd = node.ready();
        let store = node.raft.raft_log.store.clone();
        if !rd.entries().is_empty() { store.wl().append(rd.entries()).unwrap(); }
        if let Some(hs) = rd.hs() { store.wl().set_hardstate(hs.clone()); }
        for e in rd.take_committed_entries() { if e.data[..] == b"hello"[..] { committed += 1; } }
        let mut light = node.advance(rd);
        for e in light.take_committed_entries() { if e.data[..] == b"hello"[..] { committed += 1; } }
        node.advance_apply();
    }
    println!("ok raft-rs 0.7.0 leader={} committed_hello={}", node.raft.state == StateRole::Leader, committed);
}
