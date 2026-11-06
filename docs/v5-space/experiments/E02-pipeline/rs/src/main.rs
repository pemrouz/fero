// E-02: the minimal replication pipeline in Rust, with plain OS threads.
// Same protocol, journal format, batching and commit rule as ts/pipeline.ts (see there).
// Threads per process: the kernel thread (leader: generate, frame, send, commit; follower:
// read, check, hand to disk), one disk thread (writev + fdatasync, group commit), one ack
// reader per follower link (leader), and a clock thread for the CPU window.
// Why threads and not tokio: three sockets and one file per process; fdatasync blocks a
// thread in any runtime (tokio sends file I/O to its blocking pool), so an async runtime
// adds wakeups and no parallelism here.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HDR: usize = 20;
const RH: usize = 12;

#[derive(Clone)]
struct Opts {
    role: String, id: u32, port: u16, peers: Vec<u16>, dir: String, mode: String, size: usize,
    groups: usize, rate: f64, start: f64, warm: f64, dur: f64, drain: f64, seg: u64, emu: String, cap_bytes: usize,
}

fn parse() -> Opts {
    let mut o = Opts { role: "leader".into(), id: 0, port: 0, peers: vec![], dir: ".".into(), mode: "persisted".into(),
        size: 100, groups: 1, rate: 0.0, start: 0.0, warm: 2000.0, dur: 8000.0, drain: 1000.0, seg: 0, emu: String::new(),
        cap_bytes: 32 << 20 };
    for a in std::env::args().skip(1) {
        let (k, v) = a.split_once('=').expect("key=value");
        match k {
            "role" => o.role = v.into(), "id" => o.id = v.parse().unwrap(), "port" => o.port = v.parse().unwrap(),
            "peers" => o.peers = v.split(',').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap()).collect(),
            "dir" => o.dir = v.into(), "mode" => o.mode = v.into(), "size" => o.size = v.parse().unwrap(),
            "groups" => o.groups = v.parse().unwrap(), "rate" => o.rate = v.parse().unwrap(),
            "start" => o.start = v.parse().unwrap(), "warm" => o.warm = v.parse().unwrap(), "dur" => o.dur = v.parse().unwrap(),
            "drain" => o.drain = v.parse().unwrap(), "seg" => o.seg = v.parse().unwrap(), "emu" => o.emu = v.into(),
            "capBytes" => o.cap_bytes = v.parse().unwrap(), "workers" | "addon" => {}
            _ => panic!("unknown option {k}"),
        }
    }
    o
}

struct Win { start: Instant, ws: Instant, we: Instant, end: Instant }
fn window(o: &Opts) -> Win {
    let now_e = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1e3;
    let now_i = Instant::now();
    let at = |ms: f64| if ms >= now_e { now_i + Duration::from_secs_f64((ms - now_e) / 1e3) } else { now_i - Duration::from_secs_f64((now_e - ms) / 1e3) };
    Win { start: at(o.start), ws: at(o.start + o.warm), we: at(o.start + o.warm + o.dur), end: at(o.start + o.warm + o.dur + o.drain) }
}

fn cpu_us() -> u64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    (ru.ru_utime.tv_sec as u64 * 1_000_000 + ru.ru_utime.tv_usec as u64) + (ru.ru_stime.tv_sec as u64 * 1_000_000 + ru.ru_stime.tv_usec as u64)
}

fn rd(b: &[u8], off: usize) -> u32 { u32::from_le_bytes(b[off..off + 4].try_into().unwrap()) }

// ---------------------------------------------------------------- disk thread (group commit)
fn sampler(path: &str) -> Option<Box<dyn FnMut() -> u64 + Send>> {
    if path.is_empty() { return None; }
    let t: Vec<f64> = std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.is_empty() && !l.starts_with('#')).map(|l| l.parse().unwrap()).collect();
    let mut s: u32 = 0x9e37_79b9 ^ std::process::id().wrapping_mul(2654435761);
    if s == 0 { s = 1; }
    Some(Box::new(move || { s ^= s << 13; s ^= s >> 17; s ^= s << 5; t[((s as f64 / 4294967296.0) * t.len() as f64) as usize].round() as u64 }))
}

fn spawn_disk(o: &Opts, path: String, done: impl Fn(u32, &[Arc<Vec<u8>>]) + Send + 'static, flushes: Arc<AtomicU64>) -> Sender<(u32, Arc<Vec<u8>>)> {
    let (tx, rx): (Sender<(u32, Arc<Vec<u8>>)>, Receiver<(u32, Arc<Vec<u8>>)>) = channel();
    let o = o.clone();
    std::thread::spawn(move || {
        let f = std::fs::OpenOptions::new().write(true).create(o.seg == 0).truncate(o.seg == 0).open(&path).expect("open journal");
        let fd = std::os::unix::io::AsRawFd::as_raw_fd(&f);
        let mut sample = sampler(&o.emu);
        if sample.is_some() { unsafe { libc::prctl(libc::PR_SET_TIMERSLACK, 1000 as libc::c_ulong) }; }
        let mut pos: i64 = 0;
        let mut bufs: Vec<Arc<Vec<u8>>> = Vec::new();
        while let Ok((mut seq, b)) = rx.recv() {
            bufs.clear();
            bufs.push(b);
            while let Ok((s, b)) = rx.try_recv() { seq = s; bufs.push(b); }
            let total: usize = bufs.iter().map(|b| b.len()).sum();
            if o.seg > 0 && pos + total as i64 > o.seg as i64 { pos = 0; }
            for chunk in bufs.chunks(1024) {
                let iov: Vec<libc::iovec> = chunk.iter().map(|b| libc::iovec { iov_base: b.as_ptr() as *mut _, iov_len: b.len() }).collect();
                let want: usize = chunk.iter().map(|b| b.len()).sum();
                let n = unsafe { if o.seg > 0 { libc::pwritev(fd, iov.as_ptr(), iov.len() as i32, pos) } else { libc::writev(fd, iov.as_ptr(), iov.len() as i32) } };
                assert_eq!(n as usize, want, "short write");
                pos += n as i64;
            }
            if o.mode != "memory" {
                assert_eq!(unsafe { libc::fdatasync(fd) }, 0, "fdatasync");
                if let Some(s) = sample.as_mut() { std::thread::sleep(Duration::from_micros(s())); }
            }
            flushes.fetch_add(1, Relaxed);
            done(seq, &bufs);
        }
    });
    tx
}

// ---------------------------------------------------------------- leader
enum Ev { Ack(usize, u32), Dur(u32) }

fn weighted_pct(lat: &mut Vec<(f64, u64)>, ps: &[f64]) -> Vec<f64> {
    lat.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let tot: u64 = lat.iter().map(|x| x.1).sum();
    ps.iter().map(|p| {
        let target = p * tot as f64; let mut acc = 0u64;
        for x in lat.iter() { acc += x.1; if acc as f64 >= target { return x.0; } }
        lat.last().map(|x| x.0).unwrap_or(f64::NAN)
    }).collect()
}

fn leader(o: Opts) {
    let win = window(&o);
    let (tx, rx) = channel::<Ev>();
    let mode = o.mode.clone();
    let mut socks: Vec<TcpStream> = Vec::new();
    if mode == "persisted" || mode == "memory" {
        for (i, p) in o.peers.iter().enumerate() {
            let s = loop { match TcpStream::connect(("127.0.0.1", *p)) { Ok(s) => break s, Err(_) => std::thread::sleep(Duration::from_millis(20)) } };
            s.set_nodelay(true).unwrap();
            let mut r = s.try_clone().unwrap();
            let tx = tx.clone();
            std::thread::spawn(move || { let mut b = [0u8; 4]; while r.read_exact(&mut b).is_ok() { if tx.send(Ev::Ack(i, u32::from_le_bytes(b))).is_err() { return; } } });
            socks.push(s);
        }
    }
    let flushes = Arc::new(AtomicU64::new(0));
    let disk = if mode != "none" {
        let tx = tx.clone();
        Some(spawn_disk(&o, format!("{}/j.{}.0", o.dir, o.id), move |s, _| { let _ = tx.send(Ev::Dur(s)); }, flushes.clone()))
    } else { None };
    if Instant::now() > win.start { eprintln!("leader: not connected before start"); }
    let payload = vec![0x5au8; o.size];
    let rec = RH + o.size;
    let cap = (o.cap_bytes / rec) as u64;
    let chunk = (cap / 16).max(1);
    let g = o.groups;
    let mut last = vec![0u32; g];
    let mut cidx = vec![0u32; g];
    let (mut seq, mut committed, mut durable, mut acked) = (0u32, 0u32, 0u32, [0u32; 2]);
    let mut batches: VecDeque<(Arc<Vec<u8>>, Instant, bool)> = VecDeque::new();
    let (mut generated, mut committed_recs, mut committed_win, mut gen_win) = (0u64, 0u64, 0u64, 0u64);
    let mut lat: Vec<(f64, u64)> = Vec::new();
    let (mut cpu0, mut cpu1) = (0u64, 0u64);
    let (mut late_max, mut late5, mut ticks) = (0f64, 0u64, 0u64);
    let tick_d = Duration::from_millis(1);
    while Instant::now() < win.start { std::thread::sleep(win.start - Instant::now()); }
    let mut next_tick = win.start;
    let mut prev: Option<Instant> = None;
    let (mut got0, mut got1) = (false, false);
    loop {
        let now = Instant::now();
        if !got0 && now >= win.ws { cpu0 = cpu_us(); got0 = true; }
        if !got1 && now >= win.we { cpu1 = cpu_us(); got1 = true; }
        if now >= win.end { break; }
        if now >= next_tick {
            if let Some(p) = prev { let l = (now - p).as_secs_f64() * 1e3 - 1.0; if l > late_max { late_max = l; } if l > 5.0 { late5 += 1; } }
            prev = Some(now); ticks += 1;
            next_tick += tick_d;
            if next_tick <= now { next_tick = now + tick_d; }
            if now < win.we {
                let n = if o.rate > 0.0 { (((now - win.start).as_secs_f64() * o.rate) as u64).saturating_sub(generated) }
                        else { cap.saturating_sub(generated - committed_recs).min(chunk) }; // max: about 16 batches in flight
                if n > 0 {
                    let mut b: Vec<u8> = Vec::with_capacity(HDR + n as usize * rec);
                    b.resize(HDR, 0);
                    for i in 0..n {
                        let gi = ((generated + i) % g as u64) as usize;
                        last[gi] += 1;
                        b.extend_from_slice(&(gi as u32).to_le_bytes());
                        b.extend_from_slice(&last[gi].to_le_bytes());
                        b.extend_from_slice(&(o.size as u32).to_le_bytes());
                        b.extend_from_slice(&payload);
                    }
                    generated += n;
                    let in_win = now >= win.ws && now < win.we;
                    if in_win { gen_win += n; }
                    seq += 1;
                    let len = (b.len() - 4) as u32;
                    b[0..4].copy_from_slice(&len.to_le_bytes());
                    b[8..12].copy_from_slice(&seq.to_le_bytes());
                    b[12..16].copy_from_slice(&committed.to_le_bytes());
                    b[16..20].copy_from_slice(&(n as u32).to_le_bytes());
                    let crc = crc32fast::hash(&b[8..]);
                    b[4..8].copy_from_slice(&crc.to_le_bytes());
                    let b = Arc::new(b);
                    for s in socks.iter_mut() { s.write_all(&b).unwrap(); }
                    batches.push_back((b.clone(), now, in_win));
                    if let Some(d) = &disk { d.send((seq, b)).unwrap(); }
                    if mode == "none" || mode == "memory" { durable = seq; }
                }
            }
        }
        // wait for an event until the next tick, then drain what is queued
        let wait = next_tick.saturating_duration_since(Instant::now());
        let mut ev = match rx.recv_timeout(wait) { Ok(e) => Some(e), Err(RecvTimeoutError::Timeout) => None, Err(_) => break };
        while let Some(e) = ev {
            match e { Ev::Ack(i, s) => { if s > acked[i] { acked[i] = s; } } Ev::Dur(s) => { if mode != "memory" { durable = s; } } }
            ev = rx.try_recv().ok();
        }
        // commit rule: median of three for a majority; leader only for `none` and `ldr`
        let c = if mode == "none" || mode == "ldr" { durable } else { let (a, b2) = (acked[0], acked[1]); durable.min(a).max(durable.max(a).min(b2)) };
        if c > committed {
            let t = Instant::now();
            let tw = t >= win.ws && t < win.we;
            for _ in committed..c {
                let (b, tg, w) = batches.pop_front().unwrap();
                let count = rd(&b, 16) as u64;
                let mut off = HDR;
                for _ in 0..count { let gi = rd(&b, off) as usize; cidx[gi] = rd(&b, off + 4); off += RH + rd(&b, off + 8) as usize; }
                committed_recs += count;
                if tw { committed_win += count; }
                if w { lat.push(((t - tg).as_secs_f64() * 1e3, count)); }
            }
            committed = c;
        }
    }
    let p = weighted_pct(&mut lat, &[0.5, 0.9, 0.99, 0.999, 1.0]);
    let lat_n: u64 = lat.iter().map(|x| x.1).sum();
    let cpu = cpu1 - cpu0;
    let secs = o.dur / 1e3;
    let fl = flushes.load(Relaxed);
    println!("{{\"role\":\"leader\",\"impl\":\"rust\",\"mode\":\"{}\",\"size\":{},\"groups\":{},\"rate\":{},\"gen_win\":{},\"committed_win\":{},\"tput\":{},\"cpu_ms\":{},\"cpu_us_per_append\":{:.3},\"cores_used\":{:.3},\"lat_ms\":{{\"p50\":{:.3},\"p90\":{:.3},\"p99\":{:.3},\"p999\":{:.3},\"max\":{:.3}}},\"lat_n\":{},\"missing\":{},\"flushes\":{},\"recs_per_flush\":{:.1},\"ticks\":{},\"tick_late_max_ms\":{:.2},\"ticks_late_over_5ms\":{},\"cidx0\":{}}}",
        mode, o.size, o.groups, o.rate, gen_win, committed_win, (committed_win as f64 / secs) as u64, cpu / 1000,
        if committed_win > 0 { cpu as f64 / committed_win as f64 } else { 0.0 }, cpu as f64 / 1e6 / secs,
        p[0], p[1], p[2], p[3], p[4], lat_n, gen_win as i64 - lat_n as i64, fl, if fl > 0 { generated as f64 / fl as f64 } else { 0.0 },
        ticks, late_max, late5, cidx[0]);
    std::process::exit(0);
}

// ---------------------------------------------------------------- follower
fn follower(o: Opts) {
    let win = window(&o);
    let ln = TcpListener::bind(("127.0.0.1", o.port)).unwrap();
    eprintln!("follower {} ready", o.id);
    let received = Arc::new(AtomicU64::new(0));
    let flushes = Arc::new(AtomicU64::new(0));
    {
        // clock thread: CPU window, then report and exit
        let (received, flushes, o2) = (received.clone(), flushes.clone(), o.clone());
        let (ws, we, end) = (win.ws, win.we, win.end + Duration::from_millis(300));
        std::thread::spawn(move || {
            let sl = |t: Instant| { let n = Instant::now(); if t > n { std::thread::sleep(t - n); } };
            sl(ws); let c0 = cpu_us(); sl(we); let c1 = cpu_us(); sl(end);
            let r = received.load(Relaxed); let cpu = c1 - c0;
            println!("{{\"role\":\"follower\",\"id\":{},\"impl\":\"rust\",\"received_win\":{},\"cpu_ms\":{},\"cpu_us_per_append\":{:.3},\"cores_used\":{:.3},\"flushes\":{}}}",
                o2.id, r, cpu / 1000, if r > 0 { cpu as f64 / r as f64 } else { 0.0 }, cpu as f64 / 1e6 / (o2.dur / 1e3), flushes.load(Relaxed));
            std::process::exit(0);
        });
    }
    let (mut s, _) = ln.accept().unwrap();
    s.set_nodelay(true).unwrap();
    let ackw = s.try_clone().unwrap();
    let disk = spawn_disk(&o, format!("{}/j.{}.0", o.dir, o.id), move |seq, _| { let _ = (&ackw).write_all(&seq.to_le_bytes()); }, flushes.clone());
    let mut last = vec![0u32; o.groups];
    let mut buf = vec![0u8; 4 << 20];
    let mut fill = 0usize;
    loop {
        if buf.len() - fill < 256 * 1024 { let nl = buf.len() * 2; buf.resize(nl, 0); }
        let n = match s.read(&mut buf[fill..]) { Ok(0) | Err(_) => break, Ok(n) => n };
        fill += n;
        let (mut off, mut seq, mut recs) = (0usize, 0u32, 0u64);
        while fill - off >= 4 {
            let len = rd(&buf, off) as usize;
            if fill - off - 4 < len { break; }
            seq = rd(&buf, off + 8);
            let count = rd(&buf, off + 16);
            let mut r = off + HDR;
            for _ in 0..count {
                let gi = rd(&buf, r) as usize; let idx = rd(&buf, r + 4);
                if idx != last[gi] + 1 { panic!("gap in group {gi}: {idx} after {}", last[gi]); }
                last[gi] = idx; r += RH + rd(&buf, r + 8) as usize;
            }
            recs += count as u64; off += 4 + len;
        }
        let t = Instant::now();
        if t >= win.ws && t < win.we { received.fetch_add(recs, Relaxed); }
        if off > 0 {
            disk.send((seq, Arc::new(buf[..off].to_vec()))).unwrap();
            buf.copy_within(off..fill, 0);
            fill -= off;
        }
    }
    std::thread::sleep(Duration::from_secs(5));
}

fn main() {
    let o = parse();
    if o.role == "leader" { leader(o) } else { follower(o) }
}
