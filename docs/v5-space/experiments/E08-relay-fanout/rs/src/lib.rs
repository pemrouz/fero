//! E-08 shared bits: the record layout, the clock, a small latency histogram.
//! A record is 100 bytes: u16 room, u16 pad, u32 seq, u64 stamp (CLOCK_MONOTONIC ns, the same clock
//! Node's process.hrtime.bigint() reads, so every process on the box can compare stamps), 84 bytes payload.
pub const REC: usize = 100;
pub const ROOMS: usize = 64;

pub fn mono_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}
pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// Log-linear histogram: 16 sub-buckets per power of two (about 4% resolution), in nanoseconds.
pub struct Hist { pub b: Vec<u64>, pub n: u64, pub max: u64 }
impl Hist {
    pub fn new() -> Self { Hist { b: vec![0; 64 * 16], n: 0, max: 0 } }
    #[inline] pub fn idx(v: u64) -> usize {
        if v < 16 { return v as usize; }
        let p = 63 - v.leading_zeros() as usize; // floor log2
        let sub = ((v >> (p - 4)) & 15) as usize;
        (p - 3) * 16 + sub
    }
    pub fn val(i: usize) -> u64 { if i < 16 { return i as u64; } let p = i / 16 + 3; let sub = (i % 16) as u64; (16 + sub) << (p - 4) }
    #[inline] pub fn add(&mut self, v: u64, c: u64) { self.b[Self::idx(v)] += c; self.n += c; if v > self.max { self.max = v; } }
    pub fn merge(&mut self, o: &Hist) { for i in 0..self.b.len() { self.b[i] += o.b[i]; } self.n += o.n; if o.max > self.max { self.max = o.max; } }
    pub fn q(&self, f: f64) -> u64 {
        let t = (f * self.n as f64).ceil() as u64; let mut a = 0;
        for (i, c) in self.b.iter().enumerate() { a += c; if a >= t.max(1) { return Self::val(i); } }
        self.max
    }
}

/// The opening of a WebSocket handshake and frame helpers (RFC 6455), for the ws variant of E-40.
pub fn ws_client_hello(port: u16) -> Vec<u8> {
    format!("GET /sub HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", port).into_bytes()
}
/// A masked client frame (opcode 2, binary) with a short payload.
pub fn ws_client_frame(payload: &[u8]) -> Vec<u8> {
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut v = vec![0x82, 0x80 | payload.len() as u8];
    v.extend_from_slice(&mask);
    for (i, b) in payload.iter().enumerate() { v.push(b ^ mask[i & 3]); }
    v
}
