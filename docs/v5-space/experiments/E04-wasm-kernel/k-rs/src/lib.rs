// K, the Rust twin of k-ts/k.ts: the same SPEC (see k.ts's header), written as a Rust developer
// would. Built natively (rlib, for the native replay bench) and for wasm32-unknown-unknown
// (cdylib, the sim's kernel). Cargo features plant the guard's sensitivity traps:
//   trap-map-order  the dump walks a HashMap in its own order instead of UTF-8 key order
//   trap-num-i64    INCR adds as i64 (a counter as a Rust developer types it), not f64
#![allow(static_mut_refs)]

#[cfg(not(feature = "trap-map-order"))]
use std::collections::BTreeMap as Map;
#[cfg(feature = "trap-map-order")]
use std::collections::HashMap as Map;

pub const EV_TICK: u8 = 1;
pub const EV_PROPOSE: u8 = 2;
pub const EV_RECV: u8 = 3;
pub const OP_SET: u8 = 0;
pub const OP_INCR: u8 = 1;
pub const OP_DEL: u8 = 2;
pub const OP_NOOP: u8 = 3;
const MSG_REQVOTE: u8 = 0x10;
const MSG_VOTE: u8 = 0x11;
const MSG_APPEND: u8 = 0x12;
const MSG_APPRESP: u8 = 0x13;
const EFF_SEND: u8 = 0x20;
const EFF_PERSIST: u8 = 0x21;
const EFF_APPLY: u8 = 0x22;
const EFF_REPLY: u8 = 0x23;
const EFF_ROLE: u8 = 0x24;
const REC_HARD: u8 = 0x30;
const REC_ENTRIES: u8 = 0x31;
const MAX_BATCH: u64 = 64;
const HEARTBEAT: u32 = 2;

// ------------------------------------------------------------------ codec
#[derive(Default)]
pub struct W { pub buf: Vec<u8> }
impl W {
  fn u8(&mut self, v: u8) { self.buf.push(v) }
  fn varint(&mut self, mut v: u64) { while v >= 128 { self.buf.push((v as u8 & 127) | 128); v >>= 7; } self.buf.push(v as u8) }
  fn f64(&mut self, v: f64) { self.buf.extend_from_slice(&v.to_le_bytes()) }
  fn bytes(&mut self, b: &[u8]) { self.buf.extend_from_slice(b) }
  fn str(&mut self, s: &str) { self.varint(s.len() as u64); self.bytes(s.as_bytes()) }
}
pub struct R<'a> { b: &'a [u8], pos: usize }
impl<'a> R<'a> {
  fn new(b: &'a [u8]) -> Self { R { b, pos: 0 } }
  fn u8(&mut self) -> u8 { let v = self.b[self.pos]; self.pos += 1; v }
  fn varint(&mut self) -> u64 {
    let (mut v, mut s) = (0u64, 0u32);
    loop { let x = self.u8(); v |= ((x & 127) as u64) << s; if x < 128 { return v; } s += 7; }
  }
  fn f64(&mut self) -> f64 { let v = f64::from_le_bytes(self.b[self.pos..self.pos + 8].try_into().unwrap()); self.pos += 8; v }
  fn str(&mut self) -> String {
    let n = self.varint() as usize;
    // the TS twin decodes with TextDecoder (invalid UTF-8 becomes U+FFFD); match it
    let s = String::from_utf8_lossy(&self.b[self.pos..self.pos + n]).into_owned();
    self.pos += n; s
  }
  fn more(&self) -> bool { self.pos < self.b.len() }
}

#[derive(Clone)]
struct Entry { term: u64, op: u8, key: String, value: f64 }
fn write_entry(w: &mut W, e: &Entry) { w.varint(e.term); w.u8(e.op); w.str(&e.key); if e.op == OP_SET || e.op == OP_INCR { w.f64(e.value) } }
fn read_entry(r: &mut R) -> Entry {
  let term = r.varint(); let op = r.u8(); let key = r.str();
  let value = if op == OP_SET || op == OP_INCR { r.f64() } else { 0.0 };
  Entry { term, op, key, value }
}

// ------------------------------------------------------------------ the node
pub struct Node {
  id: u64, n: u64,
  term: u64, voted_for: u64, role: u8, leader: u64,
  log: Vec<Entry>,
  commit: u64, applied: u64,
  map: Map<String, f64>,
  votes: u64,
  next: Vec<u64>, matched: Vec<u64>,
  elapsed: u32, timeout: u32, hb: u32,
  rng: u32,
  pub out: W,
  tmp: W,
}

impl Node {
  pub fn new(id: u64, n: u64, journal: &[u8]) -> Node {
    let mut x = Node {
      id, n, term: 0, voted_for: 0, role: 0, leader: 0, log: Vec::new(), commit: 0, applied: 0,
      map: Map::new(), votes: 0, next: vec![1; n as usize + 1], matched: vec![0; n as usize + 1],
      elapsed: 0, timeout: 0, hb: 0,
      rng: (id as u32).wrapping_mul(2654435761) ^ 0x9e3779b9,
      out: W::default(), tmp: W::default(),
    };
    if !journal.is_empty() { x.replay(journal); }
    x.reset_timer();
    x
  }
  fn replay(&mut self, j: &[u8]) {
    let mut r = R::new(j);
    while r.more() {
      match r.u8() {
        REC_HARD => { self.term = r.varint(); self.voted_for = r.varint(); }
        REC_ENTRIES => {
          let from = r.varint(); let count = r.varint();
          self.log.truncate(from as usize - 1);
          for _ in 0..count { let e = read_entry(&mut r); self.log.push(e); }
        }
        t => panic!("journal tag {t}"),
      }
    }
  }
  fn next_rand(&mut self) -> u32 { let mut x = self.rng; x ^= x << 13; x ^= x >> 17; x ^= x << 5; self.rng = x; x }
  fn reset_timer(&mut self) { self.elapsed = 0; let r = self.next_rand(); self.timeout = 10 + ((r as f64 / 4294967296.0) * 10.0).floor() as u32; }
  fn last(&self) -> u64 { self.log.len() as u64 }
  fn term_at(&self, i: u64) -> i64 { if i == 0 { 0 } else if i <= self.last() { self.log[i as usize - 1].term as i64 } else { -1 } }
  fn majority(&self) -> u64 { self.n / 2 + 1 }

  fn persist_hard(&mut self) { self.tmp.buf.clear(); self.tmp.u8(REC_HARD); self.tmp.varint(self.term); self.tmp.varint(self.voted_for); self.emit_persist(); }
  fn persist_entries(&mut self, from: u64) {
    self.tmp.buf.clear(); self.tmp.u8(REC_ENTRIES); self.tmp.varint(from); self.tmp.varint(self.last() - from + 1);
    for i in from..=self.last() { let e = &self.log[i as usize - 1]; write_entry(&mut self.tmp, e); }
    self.emit_persist();
  }
  fn emit_persist(&mut self) { self.out.u8(EFF_PERSIST); self.out.varint(self.tmp.buf.len() as u64); self.out.buf.extend_from_slice(&self.tmp.buf); }
  fn send(&mut self, to: u64) { self.out.u8(EFF_SEND); self.out.varint(to); self.out.varint(self.tmp.buf.len() as u64); self.out.buf.extend_from_slice(&self.tmp.buf); }
  fn emit_role(&mut self) { self.out.u8(EFF_ROLE); self.out.u8(self.role); self.out.varint(self.term); self.out.varint(self.leader); }

  fn step_down(&mut self, term: u64, leader: u64) {
    let changed = self.role != 0 || self.leader != leader || self.term != term;
    if term > self.term { self.term = term; self.voted_for = 0; self.persist_hard(); }
    self.role = 0; self.leader = leader;
    if changed { self.emit_role(); }
  }
  fn campaign(&mut self) {
    self.term += 1; self.role = 1; self.voted_for = self.id; self.votes = 1; self.leader = 0;
    self.persist_hard(); self.reset_timer(); self.emit_role();
    if self.votes >= self.majority() { return self.become_leader(); }
    for p in 1..=self.n {
      if p == self.id { continue; }
      self.tmp.buf.clear(); self.tmp.u8(MSG_REQVOTE); self.tmp.varint(self.term); self.tmp.varint(self.last());
      let lt = self.term_at(self.last()) as u64; self.tmp.varint(lt); self.send(p);
    }
  }
  fn become_leader(&mut self) {
    self.role = 2; self.leader = self.id;
    for p in 1..=self.n as usize { self.next[p] = self.last() + 1; self.matched[p] = 0; }
    self.log.push(Entry { term: self.term, op: OP_NOOP, key: String::new(), value: 0.0 });
    self.persist_entries(self.last());
    let id = self.id as usize; self.matched[id] = self.last();
    self.emit_role();
    self.hb = 0;
    self.broadcast();
    self.advance();
  }
  fn broadcast(&mut self) { for p in 1..=self.n { if p != self.id { self.send_append(p); } } }
  fn send_append(&mut self, p: u64) {
    let prev = self.next[p as usize] - 1;
    let hi = self.last().min(prev + MAX_BATCH);
    self.tmp.buf.clear(); self.tmp.u8(MSG_APPEND); self.tmp.varint(self.term); self.tmp.varint(prev);
    let pt = self.term_at(prev) as u64; self.tmp.varint(pt); self.tmp.varint(self.commit); self.tmp.varint(hi - prev);
    for i in prev + 1..=hi { let e = &self.log[i as usize - 1]; write_entry(&mut self.tmp, e); }
    self.send(p);
  }
  fn advance(&mut self) {
    let mut i = self.last();
    while i > self.commit {
      if self.log[i as usize - 1].term != self.term { break; }
      let c = (1..=self.n as usize).filter(|&p| self.matched[p] >= i).count() as u64;
      if c >= self.majority() { self.commit = i; break; }
      i -= 1;
    }
    self.apply();
  }
  fn apply(&mut self) {
    while self.applied < self.commit {
      self.applied += 1;
      let idx = self.applied;
      let e = &self.log[idx as usize - 1];
      self.out.u8(EFF_APPLY); self.out.varint(idx); self.out.u8(e.op); self.out.str(&e.key);
      match e.op {
        OP_SET => {
          match self.map.get_mut(&e.key) { Some(v) => *v = e.value, None => { self.map.insert(e.key.clone(), e.value); } }
          self.out.f64(e.value);
        }
        OP_INCR => {
          let old = self.map.get(&e.key).copied().unwrap_or(0.0);
          #[cfg(not(feature = "trap-num-i64"))]
          let v = old + e.value;
          #[cfg(feature = "trap-num-i64")]
          let v = ((old as i64).wrapping_add(e.value as i64)) as f64;
          match self.map.get_mut(&e.key) { Some(x) => *x = v, None => { self.map.insert(e.key.clone(), v); } }
          self.out.f64(v);
        }
        OP_DEL => { let had = self.map.remove(&e.key).is_some(); self.out.u8(had as u8); }
        _ => {}
      }
    }
  }

  /// the one entry point: an event in, the effects out (in self.out)
  pub fn step(&mut self, ev: &[u8]) {
    self.out.buf.clear();
    let mut r = R::new(ev);
    match r.u8() {
      EV_TICK => self.tick(),
      EV_PROPOSE => self.propose(&mut r),
      EV_RECV => { let from = r.varint(); self.recv(from, &mut r) }
      t => panic!("event tag {t}"),
    }
  }
  fn tick(&mut self) {
    if self.role == 2 { self.hb += 1; if self.hb >= HEARTBEAT { self.hb = 0; self.broadcast(); } }
    else { self.elapsed += 1; if self.elapsed >= self.timeout { self.campaign(); } }
  }
  fn propose(&mut self, r: &mut R) {
    let req = r.varint(); let op = r.u8(); let key = r.str();
    let value = if op == OP_SET || op == OP_INCR { r.f64() } else { 0.0 };
    if self.role != 2 { self.out.u8(EFF_REPLY); self.out.varint(req); self.out.u8(1); self.out.varint(self.leader); return; }
    self.log.push(Entry { term: self.term, op, key, value });
    self.persist_entries(self.last());
    let id = self.id as usize; self.matched[id] = self.last();
    self.out.u8(EFF_REPLY); self.out.varint(req); self.out.u8(0); self.out.varint(self.last());
    self.broadcast();
    self.advance();
  }
  fn recv(&mut self, from: u64, r: &mut R) {
    let t = r.u8(); let term = r.varint();
    if term > self.term { self.step_down(term, if t == MSG_APPEND { from } else { 0 }); }
    match t {
      MSG_REQVOTE => {
        let last_idx = r.varint(); let last_term = r.varint() as i64;
        let my_last = self.term_at(self.last());
        let up = last_term > my_last || (last_term == my_last && last_idx >= self.last());
        let grant = term == self.term && (self.voted_for == 0 || self.voted_for == from) && up;
        if grant { self.voted_for = from; self.persist_hard(); self.reset_timer(); }
        self.tmp.buf.clear(); self.tmp.u8(MSG_VOTE); self.tmp.varint(self.term); self.tmp.u8(grant as u8); self.send(from);
      }
      MSG_VOTE => {
        let granted = r.u8();
        if self.role == 1 && term == self.term && granted != 0 { self.votes += 1; if self.votes >= self.majority() { self.become_leader(); } }
      }
      MSG_APPEND => {
        let prev = r.varint(); let prev_term = r.varint() as i64; let commit = r.varint(); let count = r.varint();
        if term < self.term { self.tmp.buf.clear(); self.tmp.u8(MSG_APPRESP); self.tmp.varint(self.term); self.tmp.u8(0); self.tmp.varint(0); self.send(from); return; }
        if self.role != 0 || self.leader != from { self.role = 0; self.leader = from; self.emit_role(); }
        self.elapsed = 0;
        if prev > self.last() || self.term_at(prev) != prev_term {
          let hint = self.last().min(prev.saturating_sub(1));
          self.tmp.buf.clear(); self.tmp.u8(MSG_APPRESP); self.tmp.varint(self.term); self.tmp.u8(0); self.tmp.varint(hint); self.send(from); return;
        }
        let mut first_new = 0u64;
        for k in 0..count {
          let e = read_entry(r); let idx = prev + 1 + k;
          if idx <= self.last() {
            if self.log[idx as usize - 1].term == e.term { continue; }
            self.log.truncate(idx as usize - 1);
          }
          self.log.push(e);
          if first_new == 0 { first_new = idx; }
        }
        if first_new != 0 { self.persist_entries(first_new); }
        let m = prev + count;
        if commit > self.commit { self.commit = self.commit.max(commit.min(m)); }
        self.apply();
        self.tmp.buf.clear(); self.tmp.u8(MSG_APPRESP); self.tmp.varint(self.term); self.tmp.u8(1); self.tmp.varint(m); self.send(from);
      }
      MSG_APPRESP => {
        let ok = r.u8(); let mi = r.varint();
        if self.role != 2 || term != self.term { return; }
        let f = from as usize;
        if ok != 0 {
          if mi > self.matched[f] { self.matched[f] = mi; }
          self.next[f] = self.matched[f] + 1;
          self.advance();
          if self.next[f] <= self.last() { self.send_append(from); }
        } else {
          self.next[f] = 1u64.max((self.next[f] - 1).min(mi + 1));
          self.send_append(from);
        }
      }
      _ => panic!("msg tag {t}"),
    }
  }

  pub fn dump(&self) -> Vec<u8> {
    let mut w = W::default();
    w.varint(self.term); w.varint(self.voted_for); w.u8(self.role); w.varint(self.leader);
    w.varint(self.commit); w.varint(self.applied); w.varint(self.last());
    w.varint(self.map.len() as u64);
    for (k, v) in self.map.iter() { w.str(k); w.f64(*v); }
    w.buf
  }
}

// ------------------------------------------------------------------ the wasm (and C) ABI
// One input buffer in linear memory; outputs stay in the node's own W until the next call.
static mut NODES: Vec<Option<Node>> = Vec::new();
static mut IN: Vec<u8> = Vec::new();
static mut OUT_PTR: *const u8 = std::ptr::null();

#[no_mangle]
pub extern "C" fn k_in(len: u32) -> *mut u8 { unsafe { if IN.len() < len as usize { IN.resize(len as usize, 0); } IN.as_mut_ptr() } }
#[no_mangle]
pub extern "C" fn k_out() -> *const u8 { unsafe { OUT_PTR } }
#[no_mangle]
pub extern "C" fn k_create(id: u32, n: u32, jlen: u32) -> u32 {
  unsafe {
    if NODES.is_empty() { NODES.push(None); }
    let node = Node::new(id as u64, n as u64, &IN[..jlen as usize]);
    NODES.push(Some(node));
    (NODES.len() - 1) as u32
  }
}
#[no_mangle]
pub extern "C" fn k_step(h: u32, len: u32) -> u32 {
  unsafe {
    let n = NODES[h as usize].as_mut().unwrap();
    n.step(&IN[..len as usize]);
    OUT_PTR = n.out.buf.as_ptr();
    n.out.buf.len() as u32
  }
}
static mut DUMP: Vec<u8> = Vec::new();
#[no_mangle]
pub extern "C" fn k_dump(h: u32) -> u32 {
  unsafe { DUMP = NODES[h as usize].as_ref().unwrap().dump(); OUT_PTR = DUMP.as_ptr(); DUMP.len() as u32 }
}
#[no_mangle]
pub extern "C" fn k_destroy(h: u32) { unsafe { NODES[h as usize] = None; } }
#[no_mangle]
pub extern "C" fn k_reset() { unsafe { NODES.clear(); } }

// ------------------------------------------------------------------ trace replay (the crossing's price)
// A trace is what the sim fed the kernel: 0 create id n jlen journal | 1 step slot len ev | 2 destroy slot.
// Replaying it inside one call prices the kernel's own work, with no JS<->WASM crossing per event.
pub fn replay(trace: &[u8]) -> (u64, u64) {
  let mut r = R::new(trace);
  let mut nodes: Vec<Option<Node>> = Vec::new();
  let (mut steps, mut out_bytes) = (0u64, 0u64);
  while r.more() {
    match r.u8() {
      0 => { let id = r.varint(); let n = r.varint(); let jl = r.varint() as usize; let j = &trace[r.pos..r.pos + jl]; r.pos += jl; nodes.push(Some(Node::new(id, n, j))); }
      1 => { let s = r.varint() as usize; let l = r.varint() as usize; let ev = &trace[r.pos..r.pos + l]; r.pos += l; let nd = nodes[s].as_mut().unwrap(); nd.step(ev); steps += 1; out_bytes += nd.out.buf.len() as u64; }
      2 => { let s = r.varint() as usize; nodes[s] = None; }
      t => panic!("trace tag {t}"),
    }
  }
  (steps, out_bytes)
}
#[no_mangle]
pub extern "C" fn k_replay(len: u32) -> u32 { unsafe { let (s, _) = replay(&IN[..len as usize]); s as u32 } }
