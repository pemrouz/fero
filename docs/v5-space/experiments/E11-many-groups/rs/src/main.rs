// E-11 host in Rust on raft-rs 0.7.0. Same design, protocol and measurements as ../go/main.go
// (read its header): one process hosts one replica of each of N groups; one TCP link per peer;
// one ticker; one journal with one write + one fdatasync per loop round; persist, then send.
use protobuf::Message as PbMessage;
use raft::eraftpb::{Entry, EntryType, Message, MessageType};
use raft::{storage::MemStorage, Config, RawNode, StateRole};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::io::AsRawFd;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const QUIET: u32 = 0x8000_0000;
const WAKE: u32 = 0x4000_0000;
const HB: usize = 3200;
fn hidx(us: f64) -> usize { let v = if us < 0.0 { 0u32 } else { us as u32 }; if v < 256 { return v as usize; } let e = 31 - v.leading_zeros(); let sh = e - 7; 256 + ((e - 8) * 128 + ((v >> sh) - 128)) as usize }
fn hval(i: usize) -> f64 { if i < 256 { return i as f64 + 0.5; } let e = ((i - 256) / 128) as u32 + 8; let m = ((i - 256) % 128) as u32 + 128; let sh = e - 7; ((m << sh) as f64) + ((1u32 << sh) as f64) / 2.0 }
fn wall_ms() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0 }

struct Group { rn: RawNode<MemStorage>, quiet: bool, active: bool, idle: u32, proposed: bool, dirty: bool }

enum Ev { Items(Vec<(u32, Vec<u8>)>), Ctl(String) }

struct Host {
  id: usize, np: usize, mode: String, ping_ms: u64, size: usize,
  groups: Vec<Group>, active: Vec<usize>, dirty: Vec<usize>,
  peers: Vec<Option<TcpStream>>, out: Vec<Vec<u8>>, out_count: Vec<u32>, last_sent: Vec<Instant>,
  journal: File, jbuf: Vec<u8>, fsync_on: bool,
  measuring: bool, ws_wall: f64,
  frames: u64, msgs: u64, bytes_out: u64, fsyncs: u64, proposals: u64, hist: Vec<u64>, hist_n: u64,
}

impl Host {
  fn mark(&mut self, g: usize) { if !self.groups[g].dirty { self.groups[g].dirty = true; self.dirty.push(g); } }
  fn wake(&mut self, g: usize) { let gr = &mut self.groups[g]; if gr.quiet { gr.quiet = false; gr.idle = 0; if !gr.active { gr.active = true; self.active.push(g); } } }
  fn queue(&mut self, p: usize, g: u32, data: &[u8]) {
    if self.out[p].is_empty() { self.out[p].extend_from_slice(&[0u8; 8]); }
    self.out[p].extend_from_slice(&g.to_le_bytes()); self.out[p].extend_from_slice(&(data.len() as u32).to_le_bytes()); self.out[p].extend_from_slice(data);
    self.out_count[p] += 1;
  }
  fn flush(&mut self, p: usize, ping: bool) {
    let b: Vec<u8> = if ping { vec![4, 0, 0, 0, 0, 0, 0, 0] } else {
      let n = self.out[p].len() as u32 - 4; let c = self.out_count[p];
      self.out[p][0..4].copy_from_slice(&n.to_le_bytes()); self.out[p][4..8].copy_from_slice(&c.to_le_bytes()); std::mem::take(&mut self.out[p]) };
    self.peers[p].as_mut().unwrap().write_all(&b).unwrap();
    if self.measuring { self.frames += 1; self.msgs += self.out_count[p] as u64; self.bytes_out += b.len() as u64; }
    self.last_sent[p] = Instant::now(); self.out[p].clear(); self.out_count[p] = 0;
  }
  fn handle(&mut self, items: Vec<(u32, Vec<u8>)>) {
    for (gw, data) in items {
      if gw & QUIET != 0 {
        let g = (gw & !QUIET) as usize; let c = u64::from_le_bytes(data[0..8].try_into().unwrap());
        if self.groups[g].rn.raft.raft_log.committed >= c { self.groups[g].quiet = true; }
        else { let lead = self.groups[g].rn.raft.leader_id as usize; if lead != 0 { self.queue(lead - 1, g as u32 | WAKE, &[]); } }
        continue;
      }
      if gw & WAKE != 0 { let g = (gw & !WAKE) as usize; self.wake(g); self.mark(g); continue; }
      let g = gw as usize;
      let m = Message::parse_from_bytes(&data).unwrap();
      let t = m.get_msg_type();
      if t != MessageType::MsgHeartbeatResponse && t != MessageType::MsgAppendResponse { self.wake(g); }
      let _ = self.groups[g].rn.step(m);
      self.mark(g);
    }
  }
  fn tick(&mut self) {
    let mut keep = Vec::with_capacity(self.active.len());
    let list = std::mem::take(&mut self.active);
    for g in list {
      if self.groups[g].quiet { self.groups[g].active = false; continue; }
      if self.mode == "quiet" && self.groups[g].rn.raft.state == StateRole::Leader {
        let commit = self.groups[g].rn.raft.raft_log.committed;
        let matched = self.groups[g].rn.raft.prs().iter().all(|(_, p)| p.matched == commit);
        let gr = &mut self.groups[g];
        if matched && !gr.proposed { gr.idle += 1; } else { gr.idle = 0; }
        gr.proposed = false;
        if gr.idle >= 2 {
          gr.quiet = true; gr.active = false;
          let cb = commit.to_le_bytes();
          for p in 1..=self.np { if p != self.id { self.queue(p - 1, g as u32 | QUIET, &cb); } }
          continue;
        }
      }
      self.groups[g].rn.tick(); self.mark(g); keep.push(g);
    }
    keep.extend(self.active.drain(..)); // groups woken during this tick
    self.active = keep;
    let now = Instant::now();
    for p in 0..self.np { if p != self.id - 1 && self.out_count[p] == 0 && now.duration_since(self.last_sent[p]) >= Duration::from_millis(self.ping_ms) { self.flush(p, true); } }
  }
  fn apply(&mut self, ents: &[Entry]) {
    let now = wall_ms();
    for e in ents {
      let d = &e.data;
      if e.get_entry_type() == EntryType::EntryNormal && d.len() >= 9 && d[0] as usize == self.id {
        let at = f64::from_le_bytes(d[1..9].try_into().unwrap());
        if self.measuring && at >= self.ws_wall { self.hist[hidx((now - at) * 1000.0)] += 1; self.hist_n += 1; }
      }
    }
  }
  fn process(&mut self) {
    let mut pass = 0;
    while pass < 4 && !self.dirty.is_empty() {
      pass += 1;
      let list = std::mem::take(&mut self.dirty);
      let mut rds = Vec::new();
      self.jbuf.clear();
      for g in list {
        self.groups[g].dirty = false;
        if !self.groups[g].rn.has_ready() { continue; }
        let rd = self.groups[g].rn.ready();
        let store = self.groups[g].rn.raft.raft_log.store.clone();
        if let Some(hs) = rd.hs() {
          store.wl().set_hardstate(hs.clone());
          self.jbuf.extend_from_slice(&(g as u32).to_le_bytes()); self.jbuf.extend_from_slice(&hs.term.to_le_bytes()); self.jbuf.extend_from_slice(&hs.vote.to_le_bytes()); self.jbuf.extend_from_slice(&hs.commit.to_le_bytes());
        }
        if !rd.entries().is_empty() {
          store.wl().append(rd.entries()).unwrap();
          for e in rd.entries() { self.jbuf.extend_from_slice(&(g as u32).to_le_bytes()); self.jbuf.extend_from_slice(&e.term.to_le_bytes()); self.jbuf.extend_from_slice(&e.index.to_le_bytes()); self.jbuf.extend_from_slice(&(e.data.len() as u32).to_le_bytes()); self.jbuf.extend_from_slice(&e.data); }
        }
        rds.push((g, rd));
      }
      if !self.jbuf.is_empty() {
        self.journal.write_all(&self.jbuf).unwrap();
        if self.fsync_on { unsafe { libc::fdatasync(self.journal.as_raw_fd()); } if self.measuring { self.fsyncs += 1; } }
      }
      let mut lights = Vec::new();
      for (g, mut rd) in rds {
        for m in rd.take_messages().into_iter().chain(rd.take_persisted_messages().into_iter()) { let b = m.write_to_bytes().unwrap(); self.queue(m.to as usize - 1, g as u32, &b); }
        let ce = rd.take_committed_entries(); self.apply(&ce);
        let mut light = self.groups[g].rn.advance(rd);
        for m in light.take_messages() { let b = m.write_to_bytes().unwrap(); self.queue(m.to as usize - 1, g as u32, &b); }
        let ce = light.take_committed_entries(); self.apply(&ce);
        self.groups[g].rn.advance_apply();
        lights.push(g);
      }
      for p in 0..self.np { if self.out_count[p] > 0 { self.flush(p, false); } }
      for g in lights { if self.groups[g].rn.has_ready() { self.mark(g); } }
    }
    // frames queued outside the Ready loop (quiet notices from tick, wake requests from handle) go out even when no group was dirty
    for p in 0..self.np { if self.out_count[p] > 0 { self.flush(p, false); } }
  }
}

fn reader(mut c: TcpStream, tx: Sender<Ev>) {
  let mut r = BufReader::with_capacity(1 << 20, &mut c);
  let mut hdr = [0u8; 4];
  loop {
    if r.read_exact(&mut hdr).is_err() { return; }
    let n = u32::from_le_bytes(hdr) as usize; let mut body = vec![0u8; n];
    if r.read_exact(&mut body).is_err() { return; }
    let cnt = u32::from_le_bytes(body[0..4].try_into().unwrap()); let mut off = 4; let mut items = Vec::with_capacity(cnt as usize);
    for _ in 0..cnt { let g = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()); let l = u32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap()) as usize; items.push((g, body[off + 8..off + 8 + l].to_vec())); off += 8 + l; }
    if tx.send(Ev::Items(items)).is_err() { return; }
  }
}

fn cpu_s() -> f64 { unsafe { let mut r: libc::rusage = std::mem::zeroed(); libc::getrusage(libc::RUSAGE_SELF, &mut r); (r.ru_utime.tv_sec as f64 + r.ru_utime.tv_usec as f64 / 1e6) + (r.ru_stime.tv_sec as f64 + r.ru_stime.tv_usec as f64 / 1e6) } }
fn rss_kb() -> u64 { let s = std::fs::read_to_string("/proc/self/status").unwrap(); for l in s.lines() { if l.starts_with("VmRSS:") { return l.split_whitespace().nth(1).unwrap().parse().unwrap(); } } 0 }

fn main() {
  let a: HashMap<String, String> = std::env::args().skip(1).map(|s| { let (k, v) = s.split_once('=').unwrap(); (k.to_string(), v.to_string()) }).collect();
  let g = |k: &str, d: &str| a.get(k).cloned().unwrap_or(d.to_string());
  let id: usize = g("id", "1").parse().unwrap(); let n: usize = g("n", "10").parse().unwrap(); let mode = g("mode", "tick");
  let tick_ms: u64 = g("tick", "100").parse().unwrap(); let elect: usize = g("elect", "10").parse().unwrap(); let ping_ms: u64 = g("ping", "500").parse().unwrap();
  let rate: f64 = g("rate", "0").parse().unwrap(); let hot: f64 = g("hot", "1").parse().unwrap(); let size: usize = g("size", "100").parse().unwrap();
  let warm: f64 = g("warm", "3000").parse().unwrap(); let dur: f64 = g("dur", "10000").parse().unwrap(); let dir = g("dir", "/tmp"); let fsync_on = g("fsync", "1") == "1";
  let ports: Vec<u16> = g("ports", "17001,17002,17003").split(',').map(|p| p.parse().unwrap()).collect();
  let np = ports.len(); let t_start = Instant::now();
  std::fs::create_dir_all(&dir).unwrap();
  let journal = OpenOptions::new().create(true).write(true).truncate(true).open(format!("{}/journal-{}", dir, id)).unwrap();
  let logger = slog::Logger::root(slog::Discard, slog::o!());
  let voters: Vec<u64> = (1..=np as u64).collect();
  let mut groups = Vec::with_capacity(n);
  for _ in 0..n {
    let st = MemStorage::new_with_conf_state((voters.clone(), vec![]));
    let cfg = Config { id: id as u64, election_tick: elect, heartbeat_tick: 1, max_size_per_msg: 1 << 20, max_inflight_msgs: 256, pre_vote: true, check_quorum: true, ..Default::default() };
    groups.push(Group { rn: RawNode::new(&cfg, st, &logger).unwrap(), quiet: false, active: true, idle: 0, proposed: false, dirty: false });
  }
  let (tx, rx): (Sender<Ev>, Receiver<Ev>) = channel();
  let ln = TcpListener::bind(("127.0.0.1", ports[id - 1])).unwrap();
  let mut peers: Vec<Option<TcpStream>> = (0..np).map(|_| None).collect();
  for p in id + 1..=np {
    let c = loop { if let Ok(c) = TcpStream::connect(("127.0.0.1", ports[p - 1])) { break c; } std::thread::sleep(Duration::from_millis(20)); };
    c.set_nodelay(true).unwrap(); (&c).write_all(&(id as u32).to_le_bytes()).unwrap(); peers[p - 1] = Some(c);
  }
  for _ in 1..id { let (mut c, _) = ln.accept().unwrap(); c.set_nodelay(true).unwrap(); let mut h = [0u8; 4]; c.read_exact(&mut h).unwrap(); peers[u32::from_le_bytes(h) as usize - 1] = Some(c); }
  for p in 0..np { if let Some(c) = &peers[p] { let c2 = c.try_clone().unwrap(); let tx2 = tx.clone(); std::thread::spawn(move || reader(c2, tx2)); } }
  { let tx2 = tx.clone(); std::thread::spawn(move || { let stdin = std::io::stdin(); for l in stdin.lock().lines() { if let Ok(l) = l { if tx2.send(Ev::Ctl(l)).is_err() { return; } } else { return; } } }); }
  let mut h = Host { id, np, mode, ping_ms, size, active: (0..n).collect(), groups, dirty: Vec::new(), peers, out: vec![Vec::new(); np], out_count: vec![0; np], last_sent: vec![Instant::now(); np],
    journal, jbuf: Vec::new(), fsync_on, measuring: false, ws_wall: 0.0, frames: 0, msgs: 0, bytes_out: 0, fsyncs: 0, proposals: 0, hist: vec![0; HB], hist_n: 0 };
  for gi in 0..n { if gi % np == id - 1 { let _ = h.groups[gi].rn.campaign(); h.mark(gi); } }

  let tick_d = Duration::from_millis(tick_ms);
  let mut next_tick = Instant::now() + tick_d; let mut next_check = Instant::now() + Duration::from_millis(200);
  let mut ready = false; let mut ready_ms = 0.0;
  let mut started = false; let mut t_go; let mut ws = Instant::now(); let mut we = Instant::now();
  let mut cpu0 = 0.0; let mut gen_start_wall = 0.0; let mut gen_start = Instant::now(); let mut made = 0.0f64; let mut led_hot: Vec<usize> = Vec::new();
  let hot_n = ((n as f64 * hot).ceil() as usize).max(1);
  let mut rng: u32 = 0x9e3779b9;
  let mut next_gen = Instant::now();
  loop {
    let now = Instant::now();
    let mut deadline = if ready { next_tick } else { next_tick.min(next_check) };
    if started && !h.measuring && cpu0 == 0.0 { deadline = deadline.min(ws); }
    if h.measuring { deadline = deadline.min(we); }
    if started && rate > 0.0 { deadline = deadline.min(next_gen); }
    let wait = deadline.saturating_duration_since(now);
    // control lines ("go") can arrive mixed with frames: keep them, never drop them in the drain below
    let mut ctl: Option<String> = None;
    match rx.recv_timeout(wait) {
      Ok(Ev::Items(it)) => h.handle(it),
      Ok(Ev::Ctl(l)) => ctl = Some(l),
      Err(RecvTimeoutError::Timeout) => {}
      Err(_) => return,
    }
    while let Ok(ev) = rx.try_recv() { match ev { Ev::Items(it) => h.handle(it), Ev::Ctl(l) => ctl = Some(l) } }
    if let Some(l) = ctl { if l.starts_with("go") {
        started = true; t_go = Instant::now(); ws = t_go + Duration::from_secs_f64(warm / 1000.0); we = ws + Duration::from_secs_f64(dur / 1000.0);
        h.ws_wall = wall_ms() + warm; gen_start = Instant::now(); gen_start_wall = wall_ms(); made = 0.0; next_gen = Instant::now();
        led_hot = (0..hot_n.min(n)).filter(|&gi| h.groups[gi].rn.raft.state == StateRole::Leader).collect();
    } }
    let now = Instant::now();
    if now >= next_tick { h.tick(); next_tick += tick_d; if next_tick < now { next_tick = now + tick_d; } }
    if now >= next_check { next_check = now + Duration::from_millis(200);
      if !ready && h.groups.iter().all(|gr| gr.rn.raft.leader_id != 0) { ready = true; ready_ms = t_start.elapsed().as_secs_f64() * 1000.0; println!("ready"); std::io::stdout().flush().unwrap(); } }
    if started && rate > 0.0 && now >= next_gen && now < we && !led_hot.is_empty() {
      next_gen = now + Duration::from_millis(1);
      let my_rate = rate * led_hot.len() as f64 / hot_n as f64;
      let due = (now.duration_since(gen_start).as_secs_f64() * my_rate).floor() + 1.0; // writes whose ideal arrival is not later than now
      while made < due {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        let gi = led_hot[((rng as f64 / 4294967296.0) * led_hot.len() as f64) as usize];
        let mut data = vec![0u8; h.size]; data[0] = id as u8; data[1..9].copy_from_slice(&(gen_start_wall + made * 1000.0 / my_rate).to_le_bytes());
        h.wake(gi); h.groups[gi].proposed = true;
        if h.groups[gi].rn.propose(vec![], data).is_ok() && h.measuring { h.proposals += 1; }
        h.mark(gi); made += 1.0;
      }
    }
    h.process();
    if started {
      let now = Instant::now();
      if !h.measuring && cpu0 == 0.0 && now >= ws { h.measuring = true; cpu0 = cpu_s(); }
      if h.measuring && now >= we {
        h.measuring = false; let cpuw = cpu_s() - cpu0; let win = dur / 1000.0;
        let leaders = h.groups.iter().filter(|gr| gr.rn.raft.state == StateRole::Leader).count(); let awake = h.groups.iter().filter(|gr| !gr.quiet).count();
        let pct = |p: f64| -> f64 { if h.hist_n == 0 { return -1.0; } let want = (p * h.hist_n as f64).ceil() as u64; let mut c = 0; for i in 0..HB { c += h.hist[i]; if c >= want { return hval(i) / 1000.0; } } -1.0 };
        let la = std::fs::read_to_string("/proc/loadavg").unwrap();
        println!("{{\"impl\":\"rs\",\"id\":{},\"n\":{},\"mode\":\"{}\",\"tick\":{},\"elect\":{},\"rate\":{},\"hot\":{},\"leaders\":{},\"awake_end\":{},\"ready_ms\":{:.1},\"cores\":{:.5},\"frames_s\":{:.1},\"msgs_s\":{:.1},\"bytes_s\":{:.1},\"fsyncs_s\":{:.1},\"proposals_s\":{:.1},\"commits_s\":{:.1},\"p50\":{:.3},\"p99\":{:.3},\"p999\":{:.3},\"max\":{:.3},\"rss_kb\":{},\"heap_kb\":-1,\"loadavg\":\"{}\"}}",
          id, n, h.mode, tick_ms, elect, rate, hot, leaders, awake, ready_ms, cpuw / win, h.frames as f64 / win, h.msgs as f64 / win, h.bytes_out as f64 / win, h.fsyncs as f64 / win, h.proposals as f64 / win, h.hist_n as f64 / win,
          pct(0.5), pct(0.99), pct(0.999), pct(1.0), rss_kb(), la.trim());
        std::io::stdout().flush().unwrap();
        let end = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < end {
          match rx.recv_timeout(Duration::from_millis(10)) { Ok(Ev::Items(it)) => h.handle(it), _ => {} }
          if Instant::now() >= next_tick { h.tick(); next_tick = Instant::now() + tick_d; }
          h.process();
        }
        std::process::exit(0);
      }
    }
  }
}
