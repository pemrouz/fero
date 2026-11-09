// E-12 in Rust: one shared journal against one log file per group. Storage only, one process.
// Same modes, load and measurement as ../ts/journal.ts (read that header first):
//   a  one journal, one flusher thread: take everything queued, one write + one fdatasync.
//   b  one file per group; `pool` worker threads; a group with queued records is put on a ready
//      queue; a worker takes it, writes its queue to its file, fdatasyncs, and acks.
//   c  one file per group; one coordinator takes every group's queue, writes each dirty file,
//      hands the fdatasyncs to `pool` threads at once, and acks when all have returned.
// A record is durable when the fdatasync covering it returns. Latency is measured from the
// record's ideal arrival time (open loop).
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::*};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
struct Rec { t: f64, g: u32, seq: u32 }

const HB: usize = 3200;
fn hidx(us: f64) -> usize { let v = if us < 0.0 { 0u32 } else { us as u32 }; if v < 256 { return v as usize; } let e = 31 - v.leading_zeros(); let sh = e - 7; 256 + ((e - 8) * 128 + ((v >> sh) - 128)) as usize }
fn hval(i: usize) -> f64 { if i < 256 { return i as f64 + 0.5; } let e = ((i - 256) / 128) as u32 + 8; let m = ((i - 256) % 128) as u32 + 128; let sh = e - 7; ((m << sh) as f64) + ((1u32 << sh) as f64) / 2.0 }
fn pct(h: &[u64], n: u64, p: f64) -> f64 { if n == 0 { return -1.0; } let want = (p * n as f64).ceil() as u64; let mut c = 0; for i in 0..HB { c += h[i]; if c >= want { return hval(i) / 1000.0; } } -1.0 }

struct Opts { mode: char, stripes: usize, groups: usize, rate: f64, size: usize, warm: f64, dur: f64, drain: f64, inflight: i64, dir: String, prealloc: bool, pool: usize, tag: String }

struct Fl { f: File, pos: u64, seg: u64 }
impl Fl {
  fn open(path: &str, seg: u64) -> Fl {
    let f = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path).unwrap();
    if seg > 0 {
      let z = vec![0u8; 1 << 20]; let mut off = 0u64;
      while off < seg { let n = std::cmp::min(z.len() as u64, seg - off) as usize; f.write_all_at(&z[..n], off).unwrap(); off += n as u64; }
      f.sync_data().unwrap();
    }
    Fl { f, pos: 0, seg }
  }
  fn put(&mut self, b: &[u8]) {
    if self.seg > 0 { if self.pos + b.len() as u64 > self.seg { self.pos = 0; } self.f.write_all_at(b, self.pos).unwrap(); }
    else { self.f.write_all(b).unwrap(); }
    self.pos += b.len() as u64;
  }
}

struct Shared {
  o: Opts, t0: Instant, ws: f64, we: f64,
  hist: Mutex<(Vec<u64>, u64)>,
  done_win: AtomicU64, fsyncs: AtomicU64, bytes: AtomicU64, batches: AtomicU64, batch_recs: AtomicU64,
  inflight: AtomicI64, stop: AtomicBool, payload: Vec<u8>,
}
impl Shared {
  fn now(&self) -> f64 { self.t0.elapsed().as_secs_f64() * 1000.0 }
  fn in_win(&self, t: f64) -> bool { t >= self.ws && t < self.we }
  fn encode(&self, recs: &[Rec], seq: u32, out: &mut Vec<u8>) {
    out.clear(); out.extend_from_slice(&[0u8; 16]);
    for r in recs { out.extend_from_slice(&r.g.to_le_bytes()); out.extend_from_slice(&r.seq.to_le_bytes()); out.extend_from_slice(&(self.o.size as u32).to_le_bytes()); out.extend_from_slice(&self.payload[..self.o.size]); }
    let n = out.len() as u32; out[0..4].copy_from_slice(&(n - 4).to_le_bytes()); out[8..12].copy_from_slice(&seq.to_le_bytes()); out[12..16].copy_from_slice(&(recs.len() as u32).to_le_bytes());
    let crc = crc32fast::hash(&out[8..]); out[4..8].copy_from_slice(&crc.to_le_bytes());
  }
  fn done(&self, recs: &[Rec], t: f64, local: &mut Vec<u64>) -> u64 {
    let mut n = 0u64;
    for r in recs { if self.in_win(r.t) { local[hidx((t - r.t) * 1000.0)] += 1; n += 1; } }
    if self.in_win(t) { self.done_win.fetch_add(recs.len() as u64, Relaxed); }
    self.inflight.fetch_sub((recs.len() * self.o.size) as i64, Relaxed);
    n
  }
  fn merge(&self, local: &mut Vec<u64>, n: u64) { if n == 0 { return; } let mut h = self.hist.lock().unwrap(); for i in 0..HB { h.0[i] += local[i]; local[i] = 0; } h.1 += n; }
}

struct GState { q: Vec<Rec>, sched: bool }

fn rusage() -> f64 { unsafe { let mut r: libc::rusage = std::mem::zeroed(); libc::getrusage(libc::RUSAGE_SELF, &mut r); (r.ru_utime.tv_sec as f64 + r.ru_utime.tv_usec as f64 / 1e6) + (r.ru_stime.tv_sec as f64 + r.ru_stime.tv_usec as f64 / 1e6) } }
fn procstat() -> (f64, f64) { let s = std::fs::read_to_string("/proc/stat").unwrap(); let v: Vec<f64> = s.lines().next().unwrap().split_whitespace().skip(1).map(|x| x.parse().unwrap()).collect(); (v[0] + v[1] + v[2] + v[5] + v[6] + v[7], v.iter().sum()) }

fn main() {
  let mut o = Opts { mode: 'a', stripes: 1, groups: 1, rate: 10000.0, size: 100, warm: 2000.0, dur: 8000.0, drain: 1500.0, inflight: 32 << 20, dir: String::new(), prealloc: false, pool: 4, tag: String::new() };
  for a in std::env::args().skip(1) {
    let (k, v) = a.split_once('=').unwrap();
    match k { "mode" => o.mode = v.chars().next().unwrap(), "stripes" => o.stripes = v.parse().unwrap(), "groups" => o.groups = v.parse().unwrap(), "rate" => o.rate = v.parse().unwrap(), "size" => o.size = v.parse().unwrap(),
      "warm" => o.warm = v.parse().unwrap(), "dur" => o.dur = v.parse().unwrap(), "drain" => o.drain = v.parse().unwrap(), "inflight" => o.inflight = v.parse().unwrap(),
      "dir" => o.dir = v.to_string(), "prealloc" => o.prealloc = v != "0", "pool" => o.pool = v.parse().unwrap(), "tag" => o.tag = v.to_string(), _ => panic!("unknown arg {}", k) }
  }
  let loadavg = std::fs::read_to_string("/proc/loadavg").unwrap().trim().to_string();
  std::fs::create_dir_all(&o.dir).unwrap();
  let ng = o.groups; let mode = o.mode; let pool = o.pool; let stripes = o.stripes.max(1);
  // mode a with stripes = K: K journals, each with its own flusher thread; group g goes to journal g % K
  let nfiles = if mode == 'a' { stripes } else { ng };
  let seg = if o.prealloc { std::cmp::max(256u64 << 10, ((256u64 << 20) / nfiles as u64 / 4096) * 4096) } else { 0 };
  let files: Vec<Mutex<Fl>> = (0..nfiles).map(|i| Mutex::new(Fl::open(&format!("{}/{}", o.dir, if mode == 'a' { format!("journal-{}", i) } else { format!("g{}", i) }), seg))).collect();
  let files = Arc::new(files);
  let payload = vec![0x5au8; o.size.max(1)];
  let (warm, dur, drain, rate, inflight_cap, size) = (o.warm, o.dur, o.drain, o.rate, o.inflight, o.size);
  let t0 = Instant::now();
  let sh = Arc::new(Shared { ws: warm, we: warm + dur, o, t0, hist: Mutex::new((vec![0; HB], 0)), done_win: AtomicU64::new(0), fsyncs: AtomicU64::new(0), bytes: AtomicU64::new(0),
    batches: AtomicU64::new(0), batch_recs: AtomicU64::new(0), inflight: AtomicI64::new(0), stop: AtomicBool::new(false), payload });

  // queues
  let gq: Arc<Vec<Mutex<GState>>> = Arc::new((0..ng).map(|_| Mutex::new(GState { q: Vec::new(), sched: false })).collect());
  let ready: Arc<(Mutex<VecDeque<u32>>, Condvar)> = Arc::new((Mutex::new(VecDeque::new()), Condvar::new()));
  let jqs: Arc<Vec<(Mutex<Vec<Rec>>, Condvar)>> = Arc::new((0..stripes).map(|_| (Mutex::new(Vec::new()), Condvar::new())).collect());

  match mode {
    'a' => { for k in 0..stripes { let (sh, jqs, files) = (sh.clone(), jqs.clone(), files.clone()); std::thread::spawn(move || {
      let jq = &jqs[k];
      let mut buf = Vec::with_capacity(1 << 20); let mut local = vec![0u64; HB]; let mut seq = 0u32; let mut take: Vec<Rec> = Vec::new();
      loop {
        { let mut q = jq.0.lock().unwrap(); while q.is_empty() { q = jq.1.wait_timeout(q, Duration::from_millis(50)).unwrap().0; } std::mem::swap(&mut *q, &mut take); }
        sh.encode(&take, seq, &mut buf); seq = seq.wrapping_add(1);
        { let mut f = files[k].lock().unwrap(); f.put(&buf); f.f.sync_data().unwrap(); }
        let t = sh.now();
        if sh.in_win(t) { sh.fsyncs.fetch_add(1, Relaxed); sh.bytes.fetch_add(buf.len() as u64, Relaxed); sh.batches.fetch_add(1, Relaxed); sh.batch_recs.fetch_add(take.len() as u64, Relaxed); }
        let n = sh.done(&take, t, &mut local); sh.merge(&mut local, n); take.clear();
      }
    }); } }
    'b' => { for _ in 0..pool { let (sh, gq, ready, files) = (sh.clone(), gq.clone(), ready.clone(), files.clone()); std::thread::spawn(move || {
      let mut buf = Vec::with_capacity(1 << 16); let mut local = vec![0u64; HB]; let mut take: Vec<Rec> = Vec::new(); let mut seq = 0u32;
      loop {
        let g = { let mut r = ready.0.lock().unwrap(); loop { if let Some(g) = r.pop_front() { break g; } r = ready.1.wait(r).unwrap(); } } as usize;
        { let mut s = gq[g].lock().unwrap(); std::mem::swap(&mut s.q, &mut take); }
        if !take.is_empty() {
          sh.encode(&take, seq, &mut buf); seq = seq.wrapping_add(1);
          { let mut f = files[g].lock().unwrap(); f.put(&buf); f.f.sync_data().unwrap(); }
          let t = sh.now();
          if sh.in_win(t) { sh.fsyncs.fetch_add(1, Relaxed); sh.bytes.fetch_add(buf.len() as u64, Relaxed); sh.batches.fetch_add(1, Relaxed); sh.batch_recs.fetch_add(take.len() as u64, Relaxed); }
          let n = sh.done(&take, t, &mut local); sh.merge(&mut local, n); take.clear();
        }
        let again = { let mut s = gq[g].lock().unwrap(); if s.q.is_empty() { s.sched = false; false } else { true } };
        if again { ready.0.lock().unwrap().push_back(g as u32); ready.1.notify_one(); }
      }
    }); } }
    'c' => {
      // fsync pool: jobs are file indexes; a countdown says when the window's fsyncs are all back
      let jobs: Arc<(Mutex<(VecDeque<usize>, usize)>, Condvar, Condvar)> = Arc::new((Mutex::new((VecDeque::new(), 0)), Condvar::new(), Condvar::new()));
      for _ in 0..pool { let (sh, jobs, files) = (sh.clone(), jobs.clone(), files.clone()); std::thread::spawn(move || loop {
        let i = { let mut j = jobs.0.lock().unwrap(); loop { if let Some(i) = j.0.pop_front() { break i; } j = jobs.1.wait(j).unwrap(); } };
        files[i].lock().unwrap().f.sync_data().unwrap();
        if sh.in_win(sh.now()) { sh.fsyncs.fetch_add(1, Relaxed); }
        let mut j = jobs.0.lock().unwrap(); j.1 -= 1; if j.1 == 0 { jobs.2.notify_all(); }
      }); }
      let (sh, gq, ready, files) = (sh.clone(), gq.clone(), ready.clone(), files.clone());
      std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(1 << 16); let mut local = vec![0u64; HB]; let mut all: Vec<Rec> = Vec::new(); let mut seq = 0u32; let mut dirty: VecDeque<u32> = VecDeque::new();
        let mut take: Vec<Rec> = Vec::new(); let mut todo: Vec<usize> = Vec::new();
        loop {
          { let mut r = ready.0.lock().unwrap(); while r.is_empty() { r = ready.1.wait(r).unwrap(); } std::mem::swap(&mut *r, &mut dirty); }
          let mut nb = 0u64; todo.clear();
          for &g in dirty.iter() {
            let g = g as usize;
            { let mut s = gq[g].lock().unwrap(); std::mem::swap(&mut s.q, &mut take); s.sched = false; }
            if take.is_empty() { continue; }
            sh.encode(&take, seq, &mut buf); seq = seq.wrapping_add(1); files[g].lock().unwrap().put(&buf); nb += buf.len() as u64;
            all.extend_from_slice(&take); take.clear(); todo.push(g);
          }
          dirty.clear();
          if todo.is_empty() { continue; }
          { let mut j = jobs.0.lock().unwrap(); j.1 = todo.len(); for &g in todo.iter() { j.0.push_back(g); } jobs.1.notify_all();
            while j.1 > 0 { j = jobs.2.wait(j).unwrap(); } }
          let t = sh.now();
          if sh.in_win(t) { sh.bytes.fetch_add(nb, Relaxed); sh.batches.fetch_add(1, Relaxed); sh.batch_recs.fetch_add(all.len() as u64, Relaxed); }
          let n = sh.done(&all, t, &mut local); sh.merge(&mut local, n); all.clear();
        }
      });
    }
    _ => panic!("mode"),
  }

  // the load: one generator thread (this one), 1 ms ticks, ideal arrival times
  let mut rng: u32 = 0x9e3779b9;
  let mut made: u64 = 0; let mut cpu0 = 0.0; let mut st0 = (0.0, 0.0); let mut cpuw = 0.0; let mut stw = (0.0, 0.0); let (mut got0, mut gotw) = (false, false);
  let push = |r: Rec, sh: &Shared| {
    sh.inflight.fetch_add(size as i64, Relaxed);
    match mode {
      'a' => { jqs[r.g as usize % stripes].0.lock().unwrap().push(r); }
      _ => { let mut s = gq[r.g as usize].lock().unwrap(); s.q.push(r); if !s.sched { s.sched = true; drop(s); ready.0.lock().unwrap().push_back(r.g); if mode == 'b' { ready.1.notify_one(); } } }
    }
  };
  let mut gseq = vec![0u32; ng];
  loop {
    let t = sh.now();
    if !got0 && t >= warm { cpu0 = rusage(); st0 = procstat(); got0 = true; }
    if !gotw && t >= warm + dur { cpuw = rusage() - cpu0; let s = procstat(); stw = (s.0 - st0.0, s.1 - st0.1); gotw = true; sh.stop.store(true, Relaxed); }
    if t >= warm + dur + drain { break; }
    if !sh.stop.load(Relaxed) {
      let mut batch: Vec<Rec> = Vec::new();
      if rate > 0.0 {
        let due = (t * rate / 1000.0).floor() as u64;
        while made < due { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; let g = if ng == 1 { 0 } else { ((rng as f64 / 4294967296.0) * ng as f64) as usize };
          batch.push(Rec { t: made as f64 * 1000.0 / rate, g: g as u32, seq: gseq[g] }); gseq[g] = gseq[g].wrapping_add(1); made += 1; }
      } else {
        let mut room = std::cmp::min(inflight_cap - sh.inflight.load(Relaxed), inflight_cap / 16);
        while room >= size as i64 { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; let g = if ng == 1 { 0 } else { ((rng as f64 / 4294967296.0) * ng as f64) as usize };
          batch.push(Rec { t, g: g as u32, seq: gseq[g] }); gseq[g] = gseq[g].wrapping_add(1); room -= size as i64; }
      }
      if mode == 'a' && stripes == 1 { if !batch.is_empty() { sh.inflight.fetch_add((batch.len() * size) as i64, Relaxed); jqs[0].0.lock().unwrap().extend_from_slice(&batch); jqs[0].1.notify_one(); } }
      else if mode == 'a' { if !batch.is_empty() { sh.inflight.fetch_add((batch.len() * size) as i64, Relaxed); let mut parts: Vec<Vec<Rec>> = vec![Vec::new(); stripes]; for r in batch.drain(..) { parts[r.g as usize % stripes].push(r); }
        for (k, p) in parts.into_iter().enumerate() { if !p.is_empty() { jqs[k].0.lock().unwrap().extend_from_slice(&p); jqs[k].1.notify_one(); } } } }
      else { for r in batch.drain(..) { push(r, &sh); } if mode == 'c' { ready.1.notify_one(); } }
    }
    std::thread::sleep(Duration::from_micros(1000));
  }
  let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as f64;
  let win = dur / 1000.0; let done = sh.done_win.load(Relaxed) as f64;
  let h = sh.hist.lock().unwrap();
  let cores = cpuw / win; let other = (stw.0 / stw.1 * ncpu - cores).max(0.0);
  println!("{{\"exp\":\"E-12\",\"impl\":\"rs\",\"stripes\":{},\"tag\":\"{}\",\"mode\":\"{}\",\"groups\":{},\"rate\":{},\"size\":{},\"prealloc\":{},\"pool\":{},\"loadavg\":\"{}\",\"appends_s\":{:.1},\"fsyncs_s\":{:.1},\"mb_s\":{:.3},\"recs_per_batch\":{:.2},\"cpu_us_per_append\":{:.3},\"cores\":{:.4},\"other_cores\":{:.3},\"p50\":{:.3},\"p99\":{:.3},\"p999\":{:.3},\"max\":{:.3},\"n\":{}}}",
    stripes, sh.o.tag, mode, ng, rate, size, if sh.o.prealloc { 1 } else { 0 }, pool, loadavg, done / win, sh.fsyncs.load(Relaxed) as f64 / win, sh.bytes.load(Relaxed) as f64 / win / 1e6,
    { let b = sh.batches.load(Relaxed); if b == 0 { 0.0 } else { sh.batch_recs.load(Relaxed) as f64 / b as f64 } }, cpuw * 1e6 / done.max(1.0), cores, other,
    pct(&h.0, h.1, 0.5), pct(&h.0, h.1, 0.99), pct(&h.0, h.1, 0.999), pct(&h.0, h.1, 1.0), h.1);
  drop(h);
  let _ = std::fs::remove_dir_all(&sh.o.dir);
  std::process::exit(0);
}
