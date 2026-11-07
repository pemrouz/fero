// E-03 part 4 (SIDE): a Rust daemon that hands record batches to a Node process on the same box,
// by a Unix socket and by a shared-memory ring in /dev/shm. Standard library only.
//   e03_daemon uds-stream <sock> <total> <batch> <rec>   stream frames [u32 count][count*rec]
//   e03_daemon uds-pingpong <sock> <rounds> <batch> <rec> per 1-byte request, reply one frame
//   e03_daemon shm <file> <slots> <rec> <total> <batch>    ring as in the addon's ring_start
// Prints its own CPU time (getrusage) as one JSON line on stderr when done.
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicU32, Ordering};

#[repr(C)]
struct Timeval { sec: i64, usec: i64 }
#[repr(C)]
struct Rusage { utime: Timeval, stime: Timeval, rest: [i64; 14] }
extern "C" {
  fn getrusage(who: i32, r: *mut Rusage) -> i32;
  fn mmap(addr: *mut u8, len: usize, prot: i32, flags: i32, fd: i32, off: i64) -> *mut u8;
}
fn cpu_us() -> i64 {
  let mut r = Rusage { utime: Timeval { sec: 0, usec: 0 }, stime: Timeval { sec: 0, usec: 0 }, rest: [0; 14] };
  unsafe { getrusage(0, &mut r) };
  r.utime.sec * 1_000_000 + r.utime.usec + r.stime.sec * 1_000_000 + r.stime.usec
}
fn records(n: usize, rec: usize) -> Vec<u8> {
  let mut v = vec![0u8; n * rec];
  for i in 0..n { let r = &mut v[i * rec..(i + 1) * rec]; r[0..4].copy_from_slice(&(i as u32).to_le_bytes()); for (j, b) in r[4..].iter_mut().enumerate() { *b = (j as u8).wrapping_add(i as u8); } }
  v
}
fn main() {
  let a: Vec<String> = std::env::args().collect();
  let n = |i: usize| a[i].parse::<usize>().unwrap();
  match a[1].as_str() {
    "uds-stream" | "uds-pingpong" => {
      let _ = std::fs::remove_file(&a[2]);
      let l = UnixListener::bind(&a[2]).unwrap();
      println!("ready"); std::io::stdout().flush().unwrap();
      let (mut s, _) = l.accept().unwrap();
      let (count, batch, rec) = (n(3), n(4), n(5));
      let body = records(batch, rec);
      let mut frame = Vec::with_capacity(4 + body.len());
      frame.extend_from_slice(&(batch as u32).to_le_bytes()); frame.extend_from_slice(&body);
      let c0 = cpu_us();
      if a[1] == "uds-stream" {
        let mut sent = 0;
        while sent < count { s.write_all(&frame).unwrap(); sent += batch; }
      } else {
        let mut q = [0u8; 1];
        for _ in 0..count { if s.read_exact(&mut q).is_err() { break; } s.write_all(&frame).unwrap(); }
      }
      s.flush().unwrap();
      let mut q = [0u8; 1]; let _ = s.read(&mut q); // wait for the client to close
      eprintln!("{{\"daemonCpuUs\":{}}}", cpu_us() - c0);
    }
    "shm" => {
      let (slots, rec, total, batch) = (n(3), n(4), n(5), n(6));
      let len = 64 + slots * rec;
      let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&a[2]).unwrap();
      f.set_len(len as u64).unwrap();
      use std::os::unix::io::AsRawFd;
      let base = unsafe { mmap(std::ptr::null_mut(), len, 3, 1, f.as_raw_fd(), 0) };
      assert!(base as isize != -1);
      let head = unsafe { &*(base as *const AtomicU32) };
      let tail = unsafe { &*(base.add(4) as *const AtomicU32) };
      let ready = unsafe { &*(base.add(8) as *const AtomicU32) };
      println!("ready"); std::io::stdout().flush().unwrap();
      while ready.load(Ordering::Acquire) == 0 { std::hint::spin_loop(); }
      let c0 = cpu_us();
      let src = records(batch, rec);
      let (mut h, mut sent) = (0u32, 0usize);
      while sent < total {
        let k = batch.min(total - sent) as u32;
        loop { let t = tail.load(Ordering::Acquire); if h.wrapping_sub(t) + k <= slots as u32 { break; } std::hint::spin_loop(); }
        for i in 0..k {
          let slot = (h.wrapping_add(i) as usize) % slots;
          unsafe { std::ptr::copy_nonoverlapping(src.as_ptr().add(i as usize * rec), base.add(64 + slot * rec), rec); }
        }
        h = h.wrapping_add(k); head.store(h, Ordering::Release); sent += k as usize;
      }
      while ready.load(Ordering::Acquire) != 2 { std::hint::spin_loop(); }
      eprintln!("{{\"daemonCpuUs\":{}}}", cpu_us() - c0);
    }
    _ => panic!("mode"),
  }
}
