//! E-39 (a): E-02's Rust pipeline leader with a client front and admission control (see ../../pipe/leader.ts
//! for the wire and the two policies; the logic is the same). Threads, as in E-02: the kernel thread (admit,
//! cut a batch every 1 ms, send to followers, commit at a majority, answer clients), one disk thread (writev +
//! fdatasync, group commit), one ack reader per follower link, one reader per client link.
//!   leader port=<p> peers=<p1,p2> dir=<dir> seg=<bytes> policy=unbounded|bounded|bounded-prio limit=<n> [capBytes=] [secs=30]
//! bounded-prio: the client readers hand requests over through a bounded queue of 16 chunks (when it is full they
//! stop reading: TCP backpressure), and each loop takes acks and fsync completions first, then requests for at
//! most 500 µs, so incoming requests never starve the commit path or the batch timer.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const HDR: usize = 20;
const RH: usize = 12;

enum Ev { Ack(usize, u32), Dur(u32), Req(usize, Vec<u8>), Link(usize, TcpStream) }
/// Where the client readers put requests: the kernel's one queue, or (bounded-prio) a bounded queue of their own.
#[derive(Clone)]
enum ReqTx { U(Sender<Ev>), B(SyncSender<Ev>) }
impl ReqTx { fn send(&self, e: Ev) -> bool { match self { ReqTx::U(t) => t.send(e).is_ok(), ReqTx::B(t) => t.send(e).is_ok() } } }

fn cpu_us() -> u64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    (ru.ru_utime.tv_sec as u64 * 1_000_000 + ru.ru_utime.tv_usec as u64) + (ru.ru_stime.tv_sec as u64 * 1_000_000 + ru.ru_stime.tv_usec as u64)
}
fn rd(b: &[u8], off: usize) -> u32 { u32::from_le_bytes(b[off..off + 4].try_into().unwrap()) }

fn spawn_disk(path: String, seg: u64, tx: Sender<Ev>) -> Sender<(u32, Arc<Vec<u8>>)> {
    let (dtx, rx): (Sender<(u32, Arc<Vec<u8>>)>, Receiver<(u32, Arc<Vec<u8>>)>) = channel();
    std::thread::spawn(move || {
        let f = std::fs::OpenOptions::new().write(true).create(seg == 0).truncate(seg == 0).open(&path).expect("open journal");
        let fd = std::os::unix::io::AsRawFd::as_raw_fd(&f);
        let mut pos: i64 = 0;
        let mut bufs: Vec<Arc<Vec<u8>>> = Vec::new();
        while let Ok((mut seq, b)) = rx.recv() {
            bufs.clear(); bufs.push(b);
            while let Ok((s, b)) = rx.try_recv() { seq = s; bufs.push(b); }
            let total: usize = bufs.iter().map(|b| b.len()).sum();
            if seg > 0 && pos + total as i64 > seg as i64 { pos = 0; }
            for chunk in bufs.chunks(1024) {
                let iov: Vec<libc::iovec> = chunk.iter().map(|b| libc::iovec { iov_base: b.as_ptr() as *mut _, iov_len: b.len() }).collect();
                let n = unsafe { if seg > 0 { libc::pwritev(fd, iov.as_ptr(), iov.len() as i32, pos) } else { libc::writev(fd, iov.as_ptr(), iov.len() as i32) } };
                assert!(n > 0, "write");
                pos += n as i64;
            }
            assert_eq!(unsafe { libc::fdatasync(fd) }, 0, "fdatasync");
            if tx.send(Ev::Dur(seq)).is_err() { return; }
        }
    });
    dtx
}

fn reply(s: &mut TcpStream, ty: u8, ids: &[u32], retry_us: u32) {
    let mut b = Vec::with_capacity(13 + 4 * ids.len());
    b.extend_from_slice(&((9 + 4 * ids.len()) as u32).to_le_bytes()); b.push(ty);
    b.extend_from_slice(&(ids.len() as u32).to_le_bytes()); b.extend_from_slice(&retry_us.to_le_bytes());
    for id in ids { b.extend_from_slice(&id.to_le_bytes()); }
    let _ = s.write_all(&b);
}

fn main() {
    let (mut port, mut peers, mut dir, mut seg, mut policy, mut limit, mut cap_bytes, mut secs) = (0u16, vec![], String::from("."), 0u64, String::from("bounded"), 50_000usize, 32usize << 20, 30u64);
    for a in std::env::args().skip(1) {
        let (k, v) = a.split_once('=').unwrap();
        match k { "port" => port = v.parse().unwrap(), "peers" => peers = v.split(',').filter(|s| !s.is_empty()).map(|s| s.parse::<u16>().unwrap()).collect(),
            "dir" => dir = v.into(), "seg" => seg = v.parse().unwrap(), "policy" => policy = v.into(), "limit" => limit = v.parse().unwrap(),
            "capBytes" => cap_bytes = v.parse().unwrap(), "secs" => secs = v.parse().unwrap(), _ => panic!("unknown {k}") }
    }
    let bounded = policy != "unbounded";
    let prio = policy == "bounded-prio";
    let (tx, rx) = channel::<Ev>();
    let (rtx, rrx) = sync_channel::<Ev>(16);
    let req_tx = if prio { ReqTx::B(rtx) } else { ReqTx::U(tx.clone()) };
    let mut fsocks: Vec<TcpStream> = Vec::new();
    for (i, p) in peers.iter().enumerate() {
        let s = loop { match TcpStream::connect(("127.0.0.1", *p)) { Ok(s) => break s, Err(_) => std::thread::sleep(Duration::from_millis(20)) } };
        s.set_nodelay(true).unwrap();
        let mut r = s.try_clone().unwrap(); let tx = tx.clone();
        std::thread::spawn(move || { let mut b = [0u8; 4]; while r.read_exact(&mut b).is_ok() { if tx.send(Ev::Ack(i, u32::from_le_bytes(b))).is_err() { return; } } });
        fsocks.push(s);
    }
    let disk = spawn_disk(format!("{}/j.0.0", dir), seg, tx.clone());
    let ln = TcpListener::bind(("127.0.0.1", port)).unwrap();
    { let tx = tx.clone(); let req_tx = req_tx.clone(); std::thread::spawn(move || {
        let mut id = 0usize;
        for s in ln.incoming() {
            let s = s.unwrap(); s.set_nodelay(true).unwrap();
            let w = s.try_clone().unwrap();
            let _ = tx.send(Ev::Link(id, w));
            let rq = req_tx.clone(); let li = id; id += 1;
            std::thread::spawn(move || {
                let mut s = s; let mut buf: Vec<u8> = vec![0; 4 << 20]; let mut fill = 0usize;
                loop {
                    if buf.len() - fill < 1 << 20 { let n = buf.len() * 2; buf.resize(n, 0); }
                    let n = match s.read(&mut buf[fill..]) { Ok(0) | Err(_) => return, Ok(n) => n };
                    fill += n;
                    let mut off = 0;
                    while fill - off >= 8 { let len = rd(&buf, off) as usize; if fill - off - 4 < len { break; } off += 4 + len; }
                    if off > 0 { if !rq.send(Ev::Req(li, buf[..off].to_vec())) { return; } buf.copy_within(off..fill, 0); fill -= off; }
                }
            });
        }
    }); }
    eprintln!("leader ready");
    // kernel state
    let mut clients: Vec<Option<TcpStream>> = Vec::new();
    let mut acks: Vec<Vec<u32>> = Vec::new();
    let mut q: VecDeque<(usize, u32, Vec<u8>)> = VecDeque::new(); // (link, reqId, payload) admitted, waiting for a batch
    let mut inflight: VecDeque<(u32, Vec<(usize, u32)>, usize)> = VecDeque::new();
    let (mut inflight_bytes, mut inflight_recs) = (0usize, 0usize);
    let (mut seq, mut committed, mut durable, mut acked) = (0u32, 0u32, 0u32, [0u32; 2]);
    let mut last = 0u32;
    let (mut st_committed, mut st_refused, mut st_admitted, mut max_queued) = (0u64, 0u64, 0u64, 0usize);
    let mut rate_win: VecDeque<u64> = VecDeque::new(); let mut slot_commits = 0u64;
    let t0 = Instant::now();
    let mut next_tick = t0 + Duration::from_millis(1);
    let mut next_slot = t0 + Duration::from_millis(10);
    let mut next_sec = t0 + Duration::from_secs(1);
    let mut series = String::from("[");
    let (mut c0, mut tc0, mut sc, mut sr, mut sa) = (cpu_us(), Instant::now(), 0u64, 0u64, 0u64);
    let end = t0 + Duration::from_secs(secs);
    let mut refused: Vec<u32> = Vec::new();
    loop {
        let now = Instant::now();
        if now >= end { break; }
        if now >= next_slot { next_slot += Duration::from_millis(10); rate_win.push_back(slot_commits); slot_commits = 0; if rate_win.len() > 10 { rate_win.pop_front(); } }
        if now >= next_sec {
            next_sec += Duration::from_secs(1);
            let c = cpu_us(); let t = Instant::now();
            if series.len() > 1 { series.push(','); }
            series.push_str(&format!("{{\"t\":{:.2},\"committed\":{},\"refused\":{},\"admitted\":{},\"queued\":{},\"inflight\":{},\"max_queued\":{},\"cores\":{:.3}}}",
                (t - t0).as_secs_f64(), st_committed - sc, st_refused - sr, st_admitted - sa, q.len(), inflight_recs, max_queued, (c - c0) as f64 / 1e6 / (t - tc0).as_secs_f64()));
            sc = st_committed; sr = st_refused; sa = st_admitted; c0 = c; tc0 = t; max_queued = q.len();
        }
        if now >= next_tick {
            next_tick += Duration::from_millis(1); if next_tick <= now { next_tick = now + Duration::from_millis(1); }
            // cut a batch (at most capBytes in flight)
            let room = cap_bytes.saturating_sub(inflight_bytes) / (RH + 100);
            let n = q.len().min(room);
            if n > 0 {
                let mut b: Vec<u8> = Vec::with_capacity(HDR + n * (RH + 100)); b.resize(HDR, 0);
                let mut who: Vec<(usize, u32)> = Vec::with_capacity(n);
                for _ in 0..n {
                    let (li, id, p) = q.pop_front().unwrap();
                    last += 1;
                    b.extend_from_slice(&0u32.to_le_bytes()); b.extend_from_slice(&last.to_le_bytes()); b.extend_from_slice(&(p.len() as u32).to_le_bytes()); b.extend_from_slice(&p);
                    who.push((li, id));
                }
                seq += 1;
                let len = (b.len() - 4) as u32;
                b[0..4].copy_from_slice(&len.to_le_bytes()); b[8..12].copy_from_slice(&seq.to_le_bytes());
                b[12..16].copy_from_slice(&committed.to_le_bytes()); b[16..20].copy_from_slice(&(n as u32).to_le_bytes());
                let crc = crc32fast::hash(&b[8..]); b[4..8].copy_from_slice(&crc.to_le_bytes());
                let bytes = b.len();
                let b = Arc::new(b);
                for s in fsocks.iter_mut() { s.write_all(&b).unwrap(); }
                disk.send((seq, b)).unwrap();
                inflight.push_back((seq, who, bytes)); inflight_bytes += bytes; inflight_recs += n;
            }
        }
        let wait = next_tick.saturating_duration_since(Instant::now());
        let iter0 = Instant::now();
        let budget = Duration::from_micros(500);
        let mut ev = match rx.recv_timeout(if prio { wait.min(Duration::from_micros(200)) } else { wait }) { Ok(e) => Some(e), Err(RecvTimeoutError::Timeout) => None, Err(_) => break };
        if ev.is_none() && prio { ev = rrx.try_recv().ok(); }
        while let Some(e) = ev {
            match e {
                Ev::Ack(i, s) => { if s > acked[i] { acked[i] = s; } }
                Ev::Dur(s) => { durable = s; }
                Ev::Link(i, s) => { while clients.len() <= i { clients.push(None); acks.push(Vec::new()); } clients[i] = Some(s); }
                Ev::Req(li, buf) => {
                    let mut off = 0;
                    while off < buf.len() {
                        let len = rd(&buf, off) as usize; let count = rd(&buf, off + 4) as usize;
                        let mut r = off + 8;
                        refused.clear();
                        for _ in 0..count {
                            let id = rd(&buf, r); let size = u16::from_le_bytes([buf[r + 4], buf[r + 5]]) as usize;
                            if bounded && inflight_recs + q.len() >= limit { refused.push(id); }
                            else { q.push_back((li, id, buf[r + 6..r + 6 + size].to_vec())); st_admitted += 1; }
                            r += 6 + size;
                        }
                        if !refused.is_empty() {
                            let rate = (rate_win.iter().sum::<u64>() as f64 / (rate_win.len().max(1) as f64 * 0.01)).max(1000.0);
                            let backlog = (inflight_recs + q.len()) as f64 - limit as f64 / 2.0;
                            let ra = ((backlog / rate) * 1e6).max(1000.0) as u32;
                            if let Some(s) = clients.get_mut(li).and_then(|x| x.as_mut()) { reply(s, 2, &refused, ra); }
                            st_refused += refused.len() as u64;
                        }
                        off += 4 + len;
                    }
                    if q.len() > max_queued { max_queued = q.len(); }
                }
            }
            ev = rx.try_recv().ok();
            if ev.is_none() && prio && iter0.elapsed() < budget { ev = rrx.try_recv().ok(); }
        }
        let (d, a, b2) = (durable, acked[0], acked[1]);
        let c = d.min(a).max(d.max(a).min(b2));
        if c > committed {
            while let Some((s, _, _)) = inflight.front() {
                if *s > c { break; }
                let (_, who, bytes) = inflight.pop_front().unwrap();
                inflight_bytes -= bytes; inflight_recs -= who.len();
                st_committed += who.len() as u64; slot_commits += who.len() as u64;
                for (li, id) in who { acks[li].push(id); }
            }
            for li in 0..acks.len() { if !acks[li].is_empty() { if let Some(s) = clients[li].as_mut() { reply(s, 1, &acks[li], 0); } acks[li].clear(); } }
            committed = c;
        }
    }
    series.push(']');
    println!("{{\"role\":\"leader\",\"impl\":\"rust\",\"policy\":\"{}\",\"limit\":{},\"series\":{}}}", policy, limit, series);
    std::process::exit(0);
}
