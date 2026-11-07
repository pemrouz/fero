// raft-rs 0.7.0's step loop behind a byte ABI, for wasm32-unknown-unknown (and natively, for the
// replay bench). One RawNode + MemStorage per replica. Every call does its work, then handles the
// Ready the way raft-rs's own example does (persist entries and hard state into MemStorage, send,
// apply, advance) and writes the effects into OUT:
//   0x20 SEND to len <protobuf Message>   0x22 APPLY idx len data   0x24 ROLE role term leader
//   0x25 DROPPED (a proposal refused: no leader here)
// A crash drops the RawNode and keeps the MemStorage (what a disk keeps); a restart builds a
// new RawNode on it with applied = 0, so committed entries are applied again from the start.
// Randomness: raft-rs draws election timeouts from rand::thread_rng(); on wasm32 getrandom's
// "custom" hook below seeds it from a counter, so a fresh instance replays the same timeouts.
#![allow(static_mut_refs)]
use protobuf::Message as PbMessage;
use raft::eraftpb::{ConfState, Entry, EntryType, Message};
use raft::{storage::MemStorage, Config, RawNode, StateRole};

struct Replica { id: u64, n: u64, storage: MemStorage, node: Option<RawNode<MemStorage>>, role: StateRole, leader: u64 }

static mut REPLICAS: Vec<Option<Replica>> = Vec::new();
static mut IN: Vec<u8> = Vec::new();
static mut OUT: Vec<u8> = Vec::new();
static mut SEED: u64 = 0x9e3779b97f4a7c15;

fn custom_getrandom(buf: &mut [u8]) -> Result<(), getrandom::Error> {
  unsafe { for b in buf.iter_mut() { SEED ^= SEED << 13; SEED ^= SEED >> 7; SEED ^= SEED << 17; *b = SEED as u8; } }
  Ok(())
}
getrandom::register_custom_getrandom!(custom_getrandom);

fn logger() -> slog::Logger { slog::Logger::root(slog::Discard, slog::o!()) }

fn varint(o: &mut Vec<u8>, mut v: u64) { while v >= 128 { o.push((v as u8 & 127) | 128); v >>= 7; } o.push(v as u8) }

fn config(id: u64) -> Config {
  Config { id, election_tick: 10, heartbeat_tick: 1, max_size_per_msg: 1 << 20, max_inflight_msgs: 256,
    pre_vote: true, check_quorum: true, applied: 0, ..Default::default() }
}

fn send_all(o: &mut Vec<u8>, msgs: Vec<Message>) {
  for m in msgs {
    let b = m.write_to_bytes().unwrap();
    o.push(0x20); varint(o, m.to); varint(o, b.len() as u64); o.extend_from_slice(&b);
  }
}
fn apply_all(o: &mut Vec<u8>, ents: Vec<Entry>) {
  for e in ents {
    if e.get_entry_type() != EntryType::EntryNormal || e.data.is_empty() { continue; }
    o.push(0x22); varint(o, e.index); varint(o, e.data.len() as u64); o.extend_from_slice(&e.data);
  }
}

fn on_ready(r: &mut Replica, o: &mut Vec<u8>) {
  let node = r.node.as_mut().unwrap();
  let (role, leader, term) = (node.raft.state, node.raft.leader_id, node.raft.term);
  if role != r.role || leader != r.leader {
    r.role = role; r.leader = leader;
    o.push(0x24); o.push(match role { StateRole::Follower => 0, StateRole::Candidate | StateRole::PreCandidate => 1, StateRole::Leader => 2 });
    varint(o, term); varint(o, leader);
  }
  if !node.has_ready() { return; }
  let store = node.raft.raft_log.store.clone();
  let mut rd = node.ready();
  if !rd.messages().is_empty() { send_all(o, rd.take_messages()); }
  if !rd.snapshot().is_empty() { store.wl().apply_snapshot(rd.snapshot().clone()).unwrap(); }
  apply_all(o, rd.take_committed_entries());
  if !rd.entries().is_empty() { store.wl().append(rd.entries()).unwrap(); }
  if let Some(hs) = rd.hs() { store.wl().set_hardstate(hs.clone()); }
  if !rd.persisted_messages().is_empty() { send_all(o, rd.take_persisted_messages()); }
  let mut light = node.advance(rd);
  if let Some(c) = light.commit_index() { store.wl().mut_hard_state().set_commit(c); }
  send_all(o, light.take_messages());
  apply_all(o, light.take_committed_entries());
  node.advance_apply();
}

fn with<F: FnOnce(&mut Replica, &mut Vec<u8>)>(h: u32, f: F) -> u32 {
  unsafe {
    OUT.clear();
    let r = REPLICAS[h as usize].as_mut().unwrap();
    f(r, &mut OUT);
    OUT.len() as u32
  }
}

#[no_mangle] pub extern "C" fn r_in(len: u32) -> *mut u8 { unsafe { if IN.len() < len as usize { IN.resize(len as usize, 0); } IN.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn r_out() -> *const u8 { unsafe { OUT.as_ptr() } }
#[no_mangle] pub extern "C" fn r_seed(s: u32) { unsafe { SEED = 0x9e3779b97f4a7c15 ^ (s as u64).wrapping_mul(0xff51afd7ed558ccd); } }
#[no_mangle] pub extern "C" fn r_reset() { unsafe { REPLICAS.clear(); REPLICAS.push(None); } }
#[no_mangle] pub extern "C" fn r_create(id: u32, n: u32) -> u32 {
  unsafe {
    if REPLICAS.is_empty() { REPLICAS.push(None); }
    let voters: Vec<u64> = (1..=n as u64).collect();
    let storage = MemStorage::new_with_conf_state(ConfState::from((voters, vec![])));
    let node = RawNode::new(&config(id as u64), storage.clone(), &logger()).unwrap();
    REPLICAS.push(Some(Replica { id: id as u64, n: n as u64, storage, node: Some(node), role: StateRole::Follower, leader: 0 }));
    (REPLICAS.len() - 1) as u32
  }
}
#[no_mangle] pub extern "C" fn r_tick(h: u32) -> u32 { with(h, |r, o| { r.node.as_mut().unwrap().tick(); on_ready(r, o) }) }
#[no_mangle] pub extern "C" fn r_step(h: u32, len: u32) -> u32 {
  let m = unsafe { Message::parse_from_bytes(&IN[..len as usize]).unwrap() };
  with(h, |r, o| { let _ = r.node.as_mut().unwrap().step(m); on_ready(r, o) })
}
#[no_mangle] pub extern "C" fn r_propose(h: u32, len: u32) -> u32 {
  let data = unsafe { IN[..len as usize].to_vec() };
  with(h, |r, o| { if r.node.as_mut().unwrap().propose(vec![], data).is_err() { o.push(0x25); } on_ready(r, o) })
}
#[no_mangle] pub extern "C" fn r_crash(h: u32) { unsafe { let r = REPLICAS[h as usize].as_mut().unwrap(); r.node = None; r.role = StateRole::Follower; r.leader = 0; } }
#[no_mangle] pub extern "C" fn r_restart(h: u32) -> u32 {
  with(h, |r, o| { let _ = (r.id, r.n); r.node = Some(RawNode::new(&config(r.id), r.storage.clone(), &logger()).unwrap()); on_ready(r, o) })
}
#[no_mangle] pub extern "C" fn r_destroy(h: u32) { unsafe { REPLICAS[h as usize] = None; } }
