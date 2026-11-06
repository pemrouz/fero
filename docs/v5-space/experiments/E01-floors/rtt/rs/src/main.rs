// Loopback TCP ping-pong in Rust (std, blocking sockets), Nagle off. One message in flight.
// rtt server <port> | rtt client <port> <bytes> <seconds>
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let addr = format!("127.0.0.1:{}", a[2]);
    if a[1] == "server" {
        let ln = TcpListener::bind(&addr).unwrap();
        for s in ln.incoming() {
            let mut s = s.unwrap();
            std::thread::spawn(move || {
                s.set_nodelay(true).unwrap();
                let mut buf = vec![0u8; 65536];
                loop {
                    let n = match s.read(&mut buf) { Ok(0) | Err(_) => return, Ok(n) => n };
                    if s.write_all(&buf[..n]).is_err() { return; }
                }
            });
        }
        return;
    }
    let size: usize = a[3].parse().unwrap();
    let secs: u64 = a[4].parse().unwrap();
    let mut s = TcpStream::connect(&addr).unwrap();
    s.set_nodelay(true).unwrap();
    let msg = vec![7u8; size];
    let mut inb = vec![0u8; size];
    let mut lat: Vec<f64> = Vec::with_capacity(4_000_000);
    let warm_end = Instant::now() + Duration::from_secs(1);
    let end = warm_end + Duration::from_secs(secs);
    loop {
        let t0 = Instant::now();
        if t0 >= end { break; }
        s.write_all(&msg).unwrap();
        s.read_exact(&mut inb).unwrap();
        if t0 >= warm_end { lat.push(t0.elapsed().as_nanos() as f64 / 1e3); }
    }
    lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let n = lat.len();
    let q = |p: f64| lat[((p * n as f64) as usize).min(n - 1)];
    println!("{{\"impl\":\"rust\",\"bytes\":{},\"n\":{},\"rtt_per_s\":{},\"p50_us\":{:.1},\"p99_us\":{:.1},\"p999_us\":{:.1},\"max_us\":{:.1}}}",
        size, n, n as u64 / secs, q(0.5), q(0.99), q(0.999), lat[n - 1]);
}
