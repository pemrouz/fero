// E-25 (Rust): the hub side of ../node/member.mjs. Listens on `port`, takes `links` links (a Node farm opens
// them), sends an 8-byte ping (E-11's frame) on each link every `ping` ms, and every 100 ms checks that each
// link heard something within `suspect` ms. Holds `groups` quiet raft-rs 0.7.0 groups (built, never ticked),
// as E-11's Rust host builds them. One reader thread per link (blocking reads), as E-11's Rust host does.
// Output: one JSON line: CPU (user+system, all threads) as a share of one core over the window, RSS.
use raft::{storage::MemStorage, Config, RawNode};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn cpu_s() -> f64 {
  let mut r: libc::rusage = unsafe { std::mem::zeroed() };
  unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut r) };
  (r.ru_utime.tv_sec as f64 + r.ru_utime.tv_usec as f64 / 1e6) + (r.ru_stime.tv_sec as f64 + r.ru_stime.tv_usec as f64 / 1e6)
}
fn rss_kb() -> u64 {
  let s = std::fs::read_to_string("/proc/self/status").unwrap();
  s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).unwrap().parse().unwrap()
}

fn main() {
  let mut a = std::collections::HashMap::new();
  for s in std::env::args().skip(1) { if let Some((k, v)) = s.split_once('=') { a.insert(k.to_string(), v.to_string()); } }
  let g = |k: &str, d: &str| a.get(k).cloned().unwrap_or(d.to_string()).parse::<u64>().unwrap();
  let (port, nlinks, ping, suspect, ngroups, warm, dur) = (g("port", "18500"), g("links", "99") as usize, g("ping", "500"), g("suspect", "2000"), g("groups", "0") as usize, g("warm", "5000"), g("dur", "30000"));
  let t0 = Instant::now();
  let now_us = move || t0.elapsed().as_micros() as u64;

  let logger = slog::Logger::root(slog::Discard, slog::o!());
  let mut groups = Vec::with_capacity(ngroups);
  for _ in 0..ngroups {
    let st = MemStorage::new_with_conf_state((vec![1u64, 2, 3], vec![]));
    let cfg = Config { id: 1, election_tick: 4, heartbeat_tick: 1, max_size_per_msg: 1 << 20, max_inflight_msgs: 256, pre_vote: true, check_quorum: true, ..Default::default() };
    groups.push(RawNode::new(&cfg, st, &logger).unwrap());
  }

  let ln = TcpListener::bind(("127.0.0.1", port as u16)).unwrap();
  println!("listening");
  let frames_in = Arc::new(AtomicU64::new(0));
  let measuring = Arc::new(AtomicU64::new(0));
  let mut links: Vec<(TcpStream, Arc<AtomicU64>, u64)> = Vec::new();
  for c in ln.incoming().take(nlinks) {
    let c = c.unwrap(); c.set_nodelay(true).unwrap();
    let last = Arc::new(AtomicU64::new(now_us()));
    let (mut rc, l2, fi, me) = (c.try_clone().unwrap(), last.clone(), frames_in.clone(), measuring.clone());
    std::thread::spawn(move || {
      let mut buf = vec![0u8; 1 << 16]; let mut have = 0usize;
      loop {
        let n = match rc.read(&mut buf[have..]) { Ok(0) | Err(_) => return, Ok(n) => n };
        have += n; l2.store(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
        let mut off = 0;
        while have - off >= 4 { let len = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize; if have - off - 4 < len { break; } off += 4 + len; if me.load(Ordering::Relaxed) == 1 { fi.fetch_add(1, Ordering::Relaxed); } }
        buf.copy_within(off..have, 0); have -= off;
      }
    });
    links.push((c, last, 0));
  }
  println!("ready");
  let ping_frame = [4u8, 0, 0, 0, 0, 0, 0, 0];
  let (mut frames_out, mut suspects) = (0u64, 0u64);
  let (mut c0, mut w0, mut done) = (0.0, Instant::now(), false);
  let mut started = false;
  let mut next_ping = Instant::now(); let mut next_det = Instant::now();
  loop {
    let now = Instant::now();
    if now >= next_ping {
      let us = now_us();
      for l in links.iter_mut() { if us - l.2 >= ping * 1000 { let _ = l.0.write_all(&ping_frame); l.2 = us; if started { frames_out += 1; } } }
      next_ping = now + Duration::from_millis(ping / 4);
    }
    if now >= next_det {
      let us = now_us();
      for l in links.iter() { if us - l.1.load(Ordering::Relaxed) > suspect * 1000 { if started { suspects += 1; } l.1.store(us, Ordering::Relaxed); } }
      next_det = now + Duration::from_millis(100);
    }
    if !started && t0.elapsed() >= Duration::from_millis(warm) { started = true; measuring.store(1, Ordering::Relaxed); c0 = cpu_s(); w0 = Instant::now(); }
    if started && !done && w0.elapsed() >= Duration::from_millis(dur) {
      done = true; measuring.store(0, Ordering::Relaxed);
      let sec = w0.elapsed().as_secs_f64(); let c = cpu_s() - c0;
      let la = std::fs::read_to_string("/proc/loadavg").unwrap();
      println!("{{\"impl\":\"rust\",\"mode\":\"hub\",\"links\":{},\"groups\":{},\"ping_ms\":{},\"window_s\":{:.2},\"cores\":{:.6},\"frames_out_s\":{:.1},\"frames_in_s\":{:.1},\"suspects\":{},\"rss_kb\":{},\"loadavg\":\"{}\"}}",
        links.len(), groups.len(), ping, sec, c / sec, frames_out as f64 / sec, frames_in.load(Ordering::Relaxed) as f64 / sec, suspects, rss_kb(), la.trim());
      std::process::exit(0);
    }
    let wake = next_ping.min(next_det);
    let n = Instant::now(); if wake > n { std::thread::sleep(wake - n); }
  }
}
