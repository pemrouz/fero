//! E-39 (a) load generator: open-loop clients that retry, against a pipeline leader (leader.ts or leader.rs).
//!   load <port> <links> <phases> <policy> <timeout_ms> <deadline_ms> [closed_window] [open_window]
//!   phases   "rate:secs,rate:secs,..." new writes a second in each phase (open loop: arrivals do not wait
//!            for answers). With closed_window > 0 the phases are ignored but for their total length, and the
//!            load keeps closed_window writes outstanding instead (no retries): that finds the maximum.
//!   policy   naive   a refused or timed-out write is sent again at the next 1 ms tick
//!            jitter  it waits max(retry-after, random in [0, min(1 s, 10 ms * 2^attempt))) (full jitter)
//!   timeout  an attempt with no answer after timeout_ms is abandoned (a late commit of it is wasted work)
//!            and the write is retried by the policy
//!   deadline a write not committed deadline_ms after it arrived is given up (failed)
//!   open_window > 0: a client-side credit window: at most open_window attempts are outstanding (sent and not
//!            answered) at once; arrivals and retries beyond it wait in the client's own queue (their wait counts
//!            in the end-to-end latency, not the admitted latency) and are given up at the deadline
//! 100 B writes, one request frame per link per 1 ms tick. Every 500 ms it records new writes, good commits
//! (first commit of a live attempt), wasted commits, refusals, retries, timeouts, give-ups, and the p50/p99 of
//! the admitted latency (send of the attempt that committed -> its commit) and of the end-to-end latency
//! (first send -> commit). Prints one JSON line at the end.
use mio::net::TcpStream;
use mio::{Events, Interest, Poll, Token};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

const SIZE: usize = 100;

struct Hist { b: Vec<u64>, n: u64 }
impl Hist {
    fn new() -> Self { Hist { b: vec![0; 64 * 16], n: 0 } }
    fn idx(v: u64) -> usize { if v < 16 { return v as usize; } let p = 63 - v.leading_zeros() as usize; ((p - 3) * 16) + ((v >> (p - 4)) & 15) as usize }
    fn val(i: usize) -> u64 { if i < 16 { return i as u64; } let p = i / 16 + 3; (16 + (i % 16) as u64) << (p - 4) }
    fn add(&mut self, v: u64) { self.b[Self::idx(v)] += 1; self.n += 1; }
    fn q(&self, f: f64) -> f64 { if self.n == 0 { return -1.0; } let t = ((f * self.n as f64).ceil() as u64).max(1); let mut a = 0; for (i, c) in self.b.iter().enumerate() { a += c; if a >= t { return Self::val(i) as f64 / 1000.0; } } -1.0 }
    fn merge(&mut self, o: &Hist) { for i in 0..self.b.len() { self.b[i] += o.b[i]; } self.n += o.n; }
}

#[derive(Default, Clone)]
struct Bucket { new_w: u64, good: u64, wasted: u64, refused: u64, retries: u64, timeouts: u64, giveups: u64, dropped: u64 }

struct Link { s: TcpStream, out: Vec<u8>, sent: usize, inb: Vec<u8> }

/// Writes in flight, in a ring indexed by write id (ids are sequential): no hashing on the hot path.
struct Writes { first: Vec<u64>, wid: Vec<u64>, att: Vec<u32>, mask: usize, evicted: u64 }
impl Writes {
    fn new(bits: u32) -> Self { let n = 1usize << bits; Writes { first: vec![u64::MAX; n], wid: vec![0; n], att: vec![0; n], mask: n - 1, evicted: 0 } }
    fn insert(&mut self, w: u64, first: u64) { let s = w as usize & self.mask; if self.first[s] != u64::MAX { self.evicted += 1; } self.first[s] = first; self.wid[s] = w; self.att[s] = 0; }
    fn get(&self, w: &u64) -> Option<(u64, u32)> { let s = *w as usize & self.mask; if self.first[s] != u64::MAX && self.wid[s] == *w { Some((self.first[s], self.att[s])) } else { None } }
    fn contains_key(&self, w: &u64) -> bool { self.get(w).is_some() }
    fn bump(&mut self, w: u64) { let s = w as usize & self.mask; if self.first[s] != u64::MAX && self.wid[s] == w { self.att[s] += 1; } }
    fn remove(&mut self, w: &u64) -> Option<(u64, u32)> { let r = self.get(w); if r.is_some() { self.first[*w as usize & self.mask] = u64::MAX; } r }
}
/// Attempts in flight, in a ring indexed by request id (ids are sequential).
struct Attempts { aid: Vec<u32>, aw: Vec<u64>, sent: Vec<u64>, mask: usize, n: usize }
impl Attempts {
    fn new(bits: u32) -> Self { let n = 1usize << bits; Attempts { aid: vec![0; n], aw: vec![0; n], sent: vec![u64::MAX; n], mask: n - 1, n: 0 } }
    fn insert(&mut self, id: u32, w: u64, t: u64) { let s = id as usize & self.mask; if self.sent[s] == u64::MAX { self.n += 1; } self.aid[s] = id; self.aw[s] = w; self.sent[s] = t; }
    fn remove(&mut self, id: &u32) -> Option<(u64, u64)> { let s = *id as usize & self.mask; if self.sent[s] != u64::MAX && self.aid[s] == *id { let r = (self.aw[s], self.sent[s]); self.sent[s] = u64::MAX; self.n -= 1; Some(r) } else { None } }
    fn len(&self) -> usize { self.n }
}


fn main() {
    let a: Vec<String> = std::env::args().collect();
    let port: u16 = a[1].parse().unwrap();
    let nlinks: usize = a[2].parse().unwrap();
    let phases: Vec<(f64, f64)> = a[3].split(',').map(|p| { let (r, s) = p.split_once(':').unwrap(); (r.parse().unwrap(), s.parse().unwrap()) }).collect();
    let jitter = a[4] == "jitter";
    let timeout_us: u64 = a[5].parse::<u64>().unwrap() * 1000;
    let deadline_us: u64 = a[6].parse::<u64>().unwrap() * 1000;
    let closed: u64 = a.get(7).map(|x| x.parse().unwrap()).unwrap_or(0);
    let open_win: usize = a.get(8).map(|x| x.parse().unwrap()).unwrap_or(0);
    let mut cq: VecDeque<u64> = VecDeque::new(); // writes waiting for a credit (open_window > 0)
    let total_s: f64 = phases.iter().map(|p| p.1).sum();
    let mut poll = Poll::new().unwrap();
    let mut events = Events::with_capacity(256);
    let mut links: Vec<Link> = Vec::new();
    for i in 0..nlinks {
        let st = loop { match std::net::TcpStream::connect(("127.0.0.1", port)) { Ok(s) => break s, Err(_) => std::thread::sleep(Duration::from_millis(20)) } };
        st.set_nodelay(true).unwrap(); st.set_nonblocking(true).unwrap();
        let mut s = TcpStream::from_std(st);
        poll.registry().register(&mut s, Token(i), Interest::READABLE | Interest::WRITABLE).unwrap();
        links.push(Link { s, out: Vec::with_capacity(1 << 20), sent: 0, inb: Vec::with_capacity(1 << 20) });
    }
    let payload = [0x5au8; SIZE];
    let t0 = Instant::now();
    let now_us = |t0: Instant| t0.elapsed().as_micros() as u64;
    // state
    let mut next_req: u32 = 1;
    let mut next_write: u64 = 0;
    let mut attempts = Attempts::new(24); // reqId -> (write, sent_us)
    let mut writes = Writes::new(24); // write -> (first_us, attempts so far)
    let mut sent_order: VecDeque<(u64, u32)> = VecDeque::new(); // (sent_us, reqId), for timeouts
    let mut retry_q: BinaryHeap<Reverse<(u64, u64)>> = BinaryHeap::new(); // (due_us, write)
    let mut buckets: Vec<Bucket> = vec![Bucket::default(); (total_s * 2.0) as usize + 4];
    let mut adm: Vec<Hist> = (0..buckets.len()).map(|_| Hist::new()).collect();
    let mut e2e: Vec<Hist> = (0..buckets.len()).map(|_| Hist::new()).collect();
    let mut rng: u64 = 0x9e3779b97f4a7c15;
    let mut rnd = move || { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; rng };
    let mut generated: f64 = 0.0;
    let mut rr = 0usize;
    let mut tick_at = 0u64;
    let mut outstanding_closed: u64 = 0;
    let mut pending_new: Vec<u64> = Vec::new();
    let mut max_attempts_pending = 0usize;
    loop {
        let t = now_us(t0);
        let ts = t as f64 / 1e6;
        if ts >= total_s { break; }
        let bk = (t / 500_000) as usize;
        if t >= tick_at {
            tick_at = t + 1000;
            // which writes go out this tick
            pending_new.clear();
            if closed > 0 {
                while outstanding_closed < closed { let w = next_write; next_write += 1; writes.insert(w, t); pending_new.push(w); outstanding_closed += 1; buckets[bk].new_w += 1; }
            } else {
                // the phase's rate, integrated over time
                let mut acc = 0.0; let mut target = 0.0;
                for (r, s) in phases.iter() { if ts >= acc + s { target += r * s; acc += s; } else { target += r * (ts - acc); break; } }
                let due = (target - generated).floor().max(0.0).min(200_000.0) as u64;
                generated += due as f64;
                for _ in 0..due { let w = next_write; next_write += 1; writes.insert(w, t); pending_new.push(w); buckets[bk].new_w += 1; }
            }
            while let Some(Reverse((due, w))) = retry_q.peek().cloned() {
                if due > t { break; }
                retry_q.pop();
                if writes.contains_key(&w) { pending_new.push(w); buckets[bk].retries += 1; }
            }
            // timeouts
            while let Some(&(st, id)) = sent_order.front() {
                if st + timeout_us > t { break; }
                sent_order.pop_front();
                if let Some((w, _)) = attempts.remove(&id) {
                    buckets[bk].timeouts += 1;
                    if closed > 0 { writes.remove(&w); outstanding_closed -= 1; continue; }
                    let Some((first, k)) = writes.get(&w) else { continue };
                    if t - first > deadline_us { writes.remove(&w); buckets[bk].giveups += 1; continue; }
                    let d = if jitter { rnd() % ((10_000u64 << k.min(7)).min(1_000_000)).max(1) } else { 0 };
                    retry_q.push(Reverse((t + d, w)));
                }
            }
            // the client-side window: only as many attempts as there are free credits go out now
            if open_win > 0 {
                for w in pending_new.drain(..) { cq.push_back(w); }
                while let Some(&w) = cq.front() {
                    match writes.get(&w) { None => { cq.pop_front(); } Some((first, _)) => { if t - first > deadline_us { cq.pop_front(); writes.remove(&w); buckets[bk].giveups += 1; } else { break; } } }
                }
                let free = open_win.saturating_sub(attempts.len());
                for _ in 0..free.min(cq.len()) { let w = cq.pop_front().unwrap(); if writes.contains_key(&w) { pending_new.push(w); } }
            }
            // frames: one per link
            if !pending_new.is_empty() {
                let per = (pending_new.len() + nlinks - 1) / nlinks;
                for chunk in pending_new.chunks(per.max(1)) {
                    let l = &mut links[rr % nlinks]; rr += 1;
                    // a client's send buffer is bounded (32 MiB a link): past it the attempt is not sent, and
                    // the write waits and retries by the policy as if refused (counted as client_dropped)
                    if l.out.len() - l.sent > (32 << 20) {
                        for &w in chunk {
                            if let Some((first, k)) = writes.get(&w) {
                                buckets[bk].dropped += 1;
                                if t - first > deadline_us { writes.remove(&w); buckets[bk].giveups += 1; continue; }
                                let d = if jitter { rnd() % ((10_000u64 << k.min(7)).min(1_000_000)).max(1) } else { 1000 };
                                retry_q.push(Reverse((t + d, w)));
                            }
                        }
                        continue;
                    }
                    let body = 4 + chunk.len() * (6 + SIZE);
                    l.out.extend_from_slice(&(body as u32).to_le_bytes());
                    l.out.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
                    for &w in chunk {
                        let id = next_req; next_req = next_req.wrapping_add(1).max(1);
                        attempts.insert(id, w, t);
                        sent_order.push_back((t, id));
                        writes.bump(w);
                        l.out.extend_from_slice(&id.to_le_bytes());
                        l.out.extend_from_slice(&(SIZE as u16).to_le_bytes());
                        l.out.extend_from_slice(&payload);
                    }
                }
            }
            if attempts.len() > max_attempts_pending { max_attempts_pending = attempts.len(); }
            for l in links.iter_mut() {
                while l.sent < l.out.len() {
                    match l.s.write(&l.out[l.sent..]) { Ok(n) => l.sent += n, Err(e) if e.kind() == ErrorKind::WouldBlock => break, Err(e) => panic!("{e}") }
                }
                if l.sent == l.out.len() { l.out.clear(); l.sent = 0; } else if l.sent > (8 << 20) { l.out.drain(..l.sent); l.sent = 0; }
            }
        }
        let wait = tick_at.saturating_sub(now_us(t0));
        poll.poll(&mut events, Some(Duration::from_micros(wait))).unwrap();
        for ev in events.iter() {
            let li = ev.token().0;
            let l = &mut links[li];
            if ev.is_writable() {
                while l.sent < l.out.len() { match l.s.write(&l.out[l.sent..]) { Ok(n) => l.sent += n, Err(_) => break } }
                if l.sent == l.out.len() { l.out.clear(); l.sent = 0; }
            }
            if !ev.is_readable() { continue; }
            let mut buf = [0u8; 65536];
            loop {
                match l.s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => l.inb.extend_from_slice(&buf[..n]),
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) => panic!("{e}"),
                }
            }
            let t = now_us(t0);
            let bk = ((t / 500_000) as usize).min(buckets.len() - 1);
            let mut off = 0;
            while l.inb.len() - off >= 4 {
                let len = u32::from_le_bytes(l.inb[off..off + 4].try_into().unwrap()) as usize;
                if l.inb.len() - off - 4 < len { break; }
                let ty = l.inb[off + 4];
                let n = u32::from_le_bytes(l.inb[off + 5..off + 9].try_into().unwrap()) as usize;
                let retry_us = u32::from_le_bytes(l.inb[off + 9..off + 13].try_into().unwrap()) as u64;
                for k in 0..n {
                    let p = off + 13 + 4 * k;
                    let id = u32::from_le_bytes(l.inb[p..p + 4].try_into().unwrap());
                    match attempts.remove(&id) {
                        None => { if ty == 1 { buckets[bk].wasted += 1; } }
                        Some((w, sent)) => {
                            if ty == 1 {
                                if let Some((first, _)) = writes.remove(&w) {
                                    buckets[bk].good += 1; adm[bk].add(t - sent); e2e[bk].add(t - first);
                                    if closed > 0 { outstanding_closed -= 1; }
                                }
                            } else {
                                buckets[bk].refused += 1;
                                if closed > 0 { writes.remove(&w); outstanding_closed -= 1; continue; }
                                let Some((first, k2)) = writes.get(&w) else { continue }; // evicted from the ring (counted in `evicted`)
                                if t - first > deadline_us { writes.remove(&w); buckets[bk].giveups += 1; continue; }
                                let d = if jitter { retry_us.max(rnd() % ((10_000u64 << k2.min(7)).min(1_000_000)).max(1)) } else { 0 };
                                retry_q.push(Reverse((t + d, w)));
                            }
                        }
                    }
                }
                off += 4 + len;
            }
            l.inb.drain(..off);
        }
    }
    // output: the series, then summaries per phase (the first 3 s of phase 1 are warm-up)
    let mut series = String::from("[");
    for (i, b) in buckets.iter().enumerate() {
        if i > 0 { series.push(','); }
        series.push_str(&format!("{{\"t\":{:.1},\"new\":{},\"good\":{},\"wasted\":{},\"refused\":{},\"retries\":{},\"timeouts\":{},\"giveups\":{},\"dropped\":{},\"adm_p99\":{:.3},\"e2e_p99\":{:.3}}}",
            i as f64 * 0.5, b.new_w, b.good, b.wasted, b.refused, b.retries, b.timeouts, b.giveups, b.dropped, adm[i].q(0.99), e2e[i].q(0.99)));
    }
    series.push(']');
    let mut sums = String::from("[");
    let mut acc = 0.0;
    for (pi, (r, s)) in phases.iter().enumerate() {
        let from = if pi == 0 { acc + 3.0_f64.min(s / 2.0) } else { acc };
        let to = acc + s;
        let (b0, b1) = ((from * 2.0) as usize, ((to * 2.0) as usize).min(buckets.len()));
        let mut tot = Bucket::default(); let mut ha = Hist::new(); let mut he = Hist::new();
        for i in b0..b1 { let b = &buckets[i]; tot.new_w += b.new_w; tot.good += b.good; tot.wasted += b.wasted; tot.refused += b.refused; tot.retries += b.retries; tot.timeouts += b.timeouts; tot.giveups += b.giveups; tot.dropped += b.dropped; ha.merge(&adm[i]); he.merge(&e2e[i]); }
        let secs = (b1 - b0) as f64 / 2.0;
        if pi > 0 { sums.push(','); }
        sums.push_str(&format!("{{\"rate\":{},\"from\":{},\"to\":{},\"offered_per_s\":{:.0},\"goodput_per_s\":{:.0},\"wasted_per_s\":{:.0},\"refused_per_s\":{:.0},\"retries_per_s\":{:.0},\"timeouts_per_s\":{:.0},\"giveups_per_s\":{:.0},\"client_dropped_per_s\":{:.0},\"adm_ms\":{{\"p50\":{:.3},\"p99\":{:.3},\"p999\":{:.3}}},\"e2e_ms\":{{\"p50\":{:.3},\"p99\":{:.3}}}}}",
            r, from, to, tot.new_w as f64 / secs, tot.good as f64 / secs, tot.wasted as f64 / secs, tot.refused as f64 / secs, tot.retries as f64 / secs, tot.timeouts as f64 / secs, tot.giveups as f64 / secs, tot.dropped as f64 / secs,
            ha.q(0.5), ha.q(0.99), ha.q(0.999), he.q(0.5), he.q(0.99)));
        acc += s;
    }
    sums.push(']');
    println!("{{\"role\":\"load\",\"evicted\":{},\"open_window\":{},\"client_queue_end\":{},\"policy\":\"{}\",\"closed\":{},\"timeout_ms\":{},\"deadline_ms\":{},\"links\":{},\"max_attempts_pending\":{},\"phases\":{},\"series\":{}}}",
        writes.evicted, open_win, cq.len(), if jitter { "jitter" } else { "naive" }, closed, timeout_us / 1000, deadline_us / 1000, nlinks, max_attempts_pending, sums, series);
}
