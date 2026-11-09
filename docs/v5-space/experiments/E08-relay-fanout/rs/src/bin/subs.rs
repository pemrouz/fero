//! E-08 subscriber process: holds N links to the relay, each in one room, and counts what arrives.
//!   subs <port> <n> <first_index> <warm_ms> <dur_ms> [tcp|ws]
//! After every link has joined it prints "ready" on stderr and reads the start time (epoch ms) from stdin.
//! Link i (counting from first_index) joins room i % 64. Records are 100 B with a CLOCK_MONOTONIC stamp; the
//! delivery latency of every record is now - stamp, read once per read() call. Deliveries and latencies count
//! only inside the window [start + warm, start + warm + dur). In ws mode the link does a WebSocket handshake,
//! sends its join as a masked binary frame, and strips the server's frame headers (unmasked binary frames).
//! Prints "ready" on stderr when every link has joined, then one JSON line at the end of the window + 1 s.
use e08::{epoch_ms, mono_ns, ws_client_frame, ws_client_hello, Hist, REC, ROOMS};
use mio::net::TcpStream;
use mio::{Events, Interest, Poll, Token};
use std::io::{ErrorKind, Read, Write};

struct L { s: TcpStream, buf: Vec<u8>, have: usize, hs_done: bool, frame_left: usize, hdr: Vec<u8> }

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let port: u16 = a[1].parse().unwrap();
    let n: usize = a[2].parse().unwrap();
    let first: usize = a[3].parse().unwrap();
    let warm: u64 = a[4].parse().unwrap();
    let dur: u64 = a[5].parse().unwrap();
    let ws = a.get(6).map(|x| x == "ws").unwrap_or(false);
    let mut poll = Poll::new().unwrap();
    let mut events = Events::with_capacity(4096);
    let mut links: Vec<L> = Vec::with_capacity(n);
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    for i in 0..n {
        // blocking connect + join, then hand the socket to mio
        let mut tries = 0;
        let mut st = loop {
            match std::net::TcpStream::connect(addr) { Ok(s) => break s, Err(e) => { tries += 1; if tries > 200 { panic!("connect: {e}"); } std::thread::sleep(std::time::Duration::from_millis(20)); } }
        };
        st.set_nodelay(true).unwrap();
        let room = ((first + i) % ROOMS) as u16;
        let join = [room.to_le_bytes()[0], room.to_le_bytes()[1], 0, 0];
        if ws {
            st.write_all(&ws_client_hello(port)).unwrap();
            // read the 101 response up to \r\n\r\n
            let mut r = Vec::new(); let mut b = [0u8; 1];
            while !r.ends_with(b"\r\n\r\n") { st.read_exact(&mut b).unwrap(); r.push(b[0]); }
            if !r.starts_with(b"HTTP/1.1 101") { panic!("ws handshake: {}", String::from_utf8_lossy(&r)); }
            st.write_all(&ws_client_frame(&join)).unwrap();
        } else { st.write_all(&join).unwrap(); }
        st.set_nonblocking(true).unwrap();
        let mut s = TcpStream::from_std(st);
        poll.registry().register(&mut s, Token(i), Interest::READABLE).unwrap();
        links.push(L { s, buf: vec![0; 256 << 10], have: 0, hs_done: true, frame_left: 0, hdr: Vec::new() });
    }
    eprintln!("ready");
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    let start: u64 = line.trim().parse().unwrap();
    let ws0 = start + warm; let we = ws0 + dur;
    let mut h = Hist::new();
    let (mut deliv, mut deliv_all, mut reads) = (0u64, 0u64, 0u64);
    let mut done_at = we + 1000;
    loop {
        poll.poll(&mut events, Some(std::time::Duration::from_millis(50))).unwrap();
        let now_ms = epoch_ms();
        if now_ms >= done_at { break; }
        for ev in events.iter() {
            let l = &mut links[ev.token().0];
            loop {
                let cap = l.buf.len();
                match l.s.read(&mut l.buf[l.have..cap]) {
                    Ok(0) => { break; }
                    Ok(k) => {
                        reads += 1;
                        let t = mono_ns();
                        let in_win = { let m = epoch_ms(); m >= ws0 && m < we };
                        // in ws mode strip frame headers in place: copy payload bytes to the record area
                        let mut recs_bytes_end;
                        if ws {
                            let mut src = l.have; let end = l.have + k; let mut dst = l.have;
                            while src < end {
                                if l.frame_left == 0 {
                                    // collect a header (2, 4 or 10 bytes)
                                    l.hdr.push(l.buf[src]); src += 1;
                                    let need = if l.hdr.len() >= 2 { match l.hdr[1] & 127 { 126 => 4, 127 => 10, _ => 2 } } else { 2 };
                                    if l.hdr.len() == need {
                                        let len = match l.hdr[1] & 127 { 126 => u16::from_be_bytes([l.hdr[2], l.hdr[3]]) as usize, 127 => { let mut x = [0u8; 8]; x.copy_from_slice(&l.hdr[2..10]); u64::from_be_bytes(x) as usize }, v => v as usize };
                                        l.frame_left = len; l.hdr.clear();
                                    }
                                } else {
                                    let take = (end - src).min(l.frame_left);
                                    l.buf.copy_within(src..src + take, dst);
                                    dst += take; src += take; l.frame_left -= take;
                                }
                            }
                            recs_bytes_end = dst;
                        } else { recs_bytes_end = l.have + k; }
                        let whole = recs_bytes_end - recs_bytes_end % REC;
                        let mut off = 0;
                        let mut c = 0u64;
                        while off < whole {
                            let mut x = [0u8; 8]; x.copy_from_slice(&l.buf[off + 8..off + 16]);
                            let stamp = u64::from_le_bytes(x);
                            if in_win { h.add(t.saturating_sub(stamp), 1); }
                            c += 1; off += REC;
                        }
                        deliv_all += c;
                        if in_win { deliv += c; }
                        l.buf.copy_within(whole..recs_bytes_end, 0);
                        l.have = recs_bytes_end - whole;
                        recs_bytes_end = 0; let _ = recs_bytes_end;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = l.hs_done;
        }
        if now_ms > we && deliv_all == 0 { done_at = now_ms; }
    }
    let us = |v: u64| (v as f64 / 1000.0 * 10.0).round() / 10.0;
    println!("{{\"subs\":{},\"deliveries_win\":{},\"deliveries_all\":{},\"reads\":{},\"per_s\":{},\"lat_us\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"p999\":{},\"max\":{}}},\"lat_n\":{}}}",
        n, deliv, deliv_all, reads, (deliv as f64 / (dur as f64 / 1000.0)).round(), us(h.q(0.5)), us(h.q(0.9)), us(h.q(0.99)), us(h.q(0.999)), us(h.max), h.n);
}
