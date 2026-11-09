//! E-08 relay in Rust: one thread, one epoll loop (mio), plain TCP.
//!   relay <feed_port> <sub_port> [cap_bytes=4194304]
//! A subscriber connects to sub_port and sends 4 bytes (u16 room, u16 0); from then on it receives every record
//! of that room. The feed connects to feed_port and streams 100 B records. Each "tick" is one pass over the
//! feed socket (read until it would block, or 1 MB): the tick's records are grouped by room, each room's bytes
//! are copied ONCE into one shared buffer (encoded once), and every subscriber of the room gets that buffer
//! queued and flushed with one writev (up to 64 queued buffers per call). A subscriber whose queue passes
//! cap_bytes pauses the feed until it drains below half (bounded memory, backpressure to the source).
//! On stdin EOF or after the feed closes and 2 s pass, it prints one JSON line of counters.
use e08::{REC, ROOMS};
use mio::net::{TcpListener, TcpStream};
use mio::{Events, Interest, Poll, Token};
use std::collections::VecDeque;
use std::io::{ErrorKind, IoSlice, Read, Write};
use std::rc::Rc;

const FEED_L: Token = Token(usize::MAX - 1);
const SUB_L: Token = Token(usize::MAX - 2);

struct Sub { s: TcpStream, room: Option<usize>, hello: Vec<u8>, q: VecDeque<(Rc<Vec<u8>>, usize)>, qbytes: usize, writable_wait: bool }

fn flush(sub: &mut Sub, writes: &mut u64) -> bool {
    // returns false if the socket died
    while !sub.q.is_empty() {
        let n = sub.q.len().min(64);
        let mut sl: Vec<IoSlice> = Vec::with_capacity(n);
        for (b, off) in sub.q.iter().take(n) { sl.push(IoSlice::new(&b[*off..])); }
        match sub.s.write_vectored(&sl) {
            Ok(mut w) => {
                *writes += 1;
                sub.qbytes -= w;
                while w > 0 {
                    let (b, off) = sub.q.front_mut().unwrap();
                    let left = b.len() - *off;
                    if w >= left { w -= left; sub.q.pop_front(); } else { *off += w; w = 0; }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => { sub.writable_wait = true; return true; }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    sub.writable_wait = false;
    true
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let feed_port: u16 = a[1].parse().unwrap();
    let sub_port: u16 = a[2].parse().unwrap();
    let cap: usize = a.get(3).map(|x| x.parse().unwrap()).unwrap_or(4 << 20);
    let mut poll = Poll::new().unwrap();
    let mut events = Events::with_capacity(4096);
    let mut fl = TcpListener::bind(format!("127.0.0.1:{}", feed_port).parse().unwrap()).unwrap();
    let mut sl = TcpListener::bind(format!("127.0.0.1:{}", sub_port).parse().unwrap()).unwrap();
    poll.registry().register(&mut fl, FEED_L, Interest::READABLE).unwrap();
    poll.registry().register(&mut sl, SUB_L, Interest::READABLE).unwrap();
    let mut subs: Vec<Option<Sub>> = Vec::new();
    let mut room_subs: Vec<Vec<usize>> = vec![Vec::new(); ROOMS];
    let mut feed: Option<TcpStream> = None;
    let feed_tok = Token(usize::MAX - 3);
    let mut fbuf: Vec<u8> = vec![0; 1 << 20];
    let mut fhave = 0usize;
    let mut rooms: Vec<Vec<u8>> = vec![Vec::with_capacity(64 << 10); ROOMS];
    let (mut recs_in, mut deliveries, mut writes, mut ticks, mut drops, mut pauses) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let mut feed_ready = false;
    let mut paused_by: usize = 0; // number of subscribers over cap
    let mut over: Vec<bool> = Vec::new();
    let mut feed_closed_at: Option<std::time::Instant> = None;
    loop {
        let timeout = if feed_ready && paused_by == 0 { Some(std::time::Duration::ZERO) } else { Some(std::time::Duration::from_millis(100)) };
        poll.poll(&mut events, timeout).unwrap();
        for ev in events.iter() {
            match ev.token() {
                FEED_L => loop {
                    match fl.accept() {
                        Ok((mut s, _)) => { s.set_nodelay(true).ok(); poll.registry().register(&mut s, feed_tok, Interest::READABLE).unwrap(); feed = Some(s); feed_ready = true; }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                        Err(e) => panic!("{e}"),
                    }
                },
                SUB_L => loop {
                    match sl.accept() {
                        Ok((mut s, _)) => {
                            s.set_nodelay(true).ok();
                            let id = subs.len();
                            poll.registry().register(&mut s, Token(id), Interest::READABLE | Interest::WRITABLE).unwrap();
                            subs.push(Some(Sub { s, room: None, hello: Vec::new(), q: VecDeque::new(), qbytes: 0, writable_wait: false }));
                            over.push(false);
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                        Err(e) => panic!("{e}"),
                    }
                },
                t if t == feed_tok => { feed_ready = true; }
                Token(id) => {
                    let mut dead = false;
                    if let Some(sub) = subs[id].as_mut() {
                        if ev.is_readable() {
                            let mut b = [0u8; 64];
                            loop {
                                match sub.s.read(&mut b) {
                                    Ok(0) => { dead = true; break; }
                                    Ok(n) => {
                                        if sub.room.is_none() {
                                            sub.hello.extend_from_slice(&b[..n]);
                                            if sub.hello.len() >= 4 { let r = u16::from_le_bytes([sub.hello[0], sub.hello[1]]) as usize % ROOMS; sub.room = Some(r); room_subs[r].push(id); }
                                        }
                                    }
                                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                                    Err(_) => { dead = true; break; }
                                }
                            }
                        }
                        if !dead && ev.is_writable() && sub.writable_wait {
                            if !flush(sub, &mut writes) { dead = true; }
                            if over[id] && sub.qbytes < cap / 2 { over[id] = false; paused_by -= 1; }
                        }
                    }
                    if dead {
                        if let Some(sub) = subs[id].take() { if let Some(r) = sub.room { room_subs[r].retain(|&x| x != id); } drops += 1; }
                        if over[id] { over[id] = false; paused_by -= 1; }
                    }
                }
            }
        }
        // one tick: read the feed until it would block (or 1 MB), group by room, fan out
        if feed_ready && paused_by == 0 {
            if let Some(f) = feed.as_mut() {
                let mut got = 0usize;
                loop {
                    if fhave == fbuf.len() { break; }
                    match f.read(&mut fbuf[fhave..]) {
                        Ok(0) => { feed_ready = false; if feed_closed_at.is_none() { feed_closed_at = Some(std::time::Instant::now()); } break; }
                        Ok(n) => { fhave += n; got += n; }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => { feed_ready = false; break; }
                        Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                        Err(_) => { feed_ready = false; break; }
                    }
                }
                if got > 0 || fhave >= REC {
                    let whole = fhave - fhave % REC;
                    let mut off = 0;
                    while off < whole {
                        let r = u16::from_le_bytes([fbuf[off], fbuf[off + 1]]) as usize % ROOMS;
                        rooms[r].extend_from_slice(&fbuf[off..off + REC]);
                        off += REC;
                    }
                    recs_in += (whole / REC) as u64;
                    fbuf.copy_within(whole..fhave, 0);
                    fhave -= whole;
                    ticks += 1;
                    for r in 0..ROOMS {
                        if rooms[r].is_empty() { continue; }
                        let nrec = (rooms[r].len() / REC) as u64;
                        let shared = Rc::new(std::mem::replace(&mut rooms[r], Vec::with_capacity(64 << 10)));
                        for &id in room_subs[r].iter() {
                            if let Some(sub) = subs[id].as_mut() {
                                sub.q.push_back((shared.clone(), 0));
                                sub.qbytes += shared.len();
                                deliveries += nrec;
                                if !sub.writable_wait { if !flush(sub, &mut writes) { /* dies on next event */ } }
                                if sub.qbytes > cap && !over[id] { over[id] = true; paused_by += 1; pauses += 1; }
                            }
                        }
                    }
                }
            }
        }
        if let Some(t) = feed_closed_at { if t.elapsed().as_secs() >= 2 { break; } }
    }
    println!("{{\"relay\":\"rust\",\"recs_in\":{},\"deliveries\":{},\"writes\":{},\"ticks\":{},\"drops\":{},\"pauses\":{}}}", recs_in, deliveries, writes, ticks, drops, pauses);
}
