//! E-08 feed: the relay's source (a group's committed records arriving from the kernel), on one TCP link.
//!   feed <port> <rate> <start_epoch_ms> <stop_epoch_ms>
//! rate > 0: every 1 ms, the records due at `rate` a second since start are sent in one write (open loop).
//! rate = 0: as fast as the relay reads them (the link's own backpressure; the relay pauses reading when a
//! subscriber's queue is full), in writes of 256 records. Records go round robin over the 64 rooms; each carries
//! its CLOCK_MONOTONIC send stamp. Prints one JSON line with the records sent.
use e08::{epoch_ms, mono_ns, REC, ROOMS};
use std::io::Write;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let port: u16 = a[1].parse().unwrap();
    let rate: u64 = a[2].parse().unwrap();
    let start: u64 = a[3].parse().unwrap();
    let stop: u64 = a[4].parse().unwrap();
    let mut tries = 0;
    let mut s = loop {
        match std::net::TcpStream::connect(("127.0.0.1", port)) { Ok(s) => break s, Err(e) => { tries += 1; if tries > 200 { panic!("{e}"); } std::thread::sleep(std::time::Duration::from_millis(20)); } }
    };
    s.set_nodelay(true).unwrap();
    while epoch_ms() < start { std::thread::sleep(std::time::Duration::from_micros(200)); }
    let t0 = std::time::Instant::now();
    let mut seq: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 20);
    let mut late_max = 0u128;
    loop {
        if epoch_ms() >= stop { break; }
        let due = if rate > 0 { (t0.elapsed().as_micros() as u64 * rate / 1_000_000).saturating_sub(seq).min(200_000) } else { 256 };
        buf.clear();
        let stamp = mono_ns();
        for _ in 0..due {
            let room = (seq % ROOMS as u64) as u16;
            let mut r = [0x5au8; REC];
            r[0..2].copy_from_slice(&room.to_le_bytes());
            r[2..4].copy_from_slice(&[0, 0]);
            r[4..8].copy_from_slice(&(seq as u32).to_le_bytes());
            r[8..16].copy_from_slice(&stamp.to_le_bytes());
            buf.extend_from_slice(&r);
            seq += 1;
        }
        if !buf.is_empty() { s.write_all(&buf).unwrap(); }
        if rate > 0 {
            let next = ((t0.elapsed().as_micros() / 1000) + 1) * 1000;
            let now = t0.elapsed().as_micros();
            if now < next { std::thread::sleep(std::time::Duration::from_micros((next - now) as u64)); } else { late_max = late_max.max(now - next); }
        }
    }
    drop(s);
    println!("{{\"feed_sent\":{},\"rate\":{},\"late_max_us\":{}}}", seq, rate, late_max);
}
