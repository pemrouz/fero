// E-03: the napi seam, priced. One napi-rs addon with every crossing the question names:
// an empty call; a 4 KB Buffer in and out; Rust calling a JS function per record, directly
// and through a threadsafe function from a Rust thread; a SharedArrayBuffer ring between a
// Rust thread and JS; a record batch handed to JS for data's fold; Rust building the JS
// record objects itself; and a /dev/shm map for the SIDE seam (E-03's local-seam part).
//
// High-level napi-rs where it is the natural API (what fero would write), raw napi-sys where
// the high-level wrapper would add work the measurement must not hide (both are reported).

use napi::bindgen_prelude::*;
use napi::sys;
use napi_derive::napi;
use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};

// ---------------------------------------------------------------- 1. empty calls
#[napi]
pub fn noop() {}

#[napi]
pub fn add1(x: u32) -> u32 { x.wrapping_add(1) }

// ---------------------------------------------------------------- 2. a 4 KB Buffer in and out
/// napi-rs's owned `Buffer` (it takes a napi reference to keep the bytes alive).
#[napi]
pub fn buf_in_owned(b: Buffer) -> u32 { b.len() as u32 + b[b.len() - 1] as u32 }

/// a borrowed slice over a Uint8Array/Buffer (no reference, no copy).
#[napi]
pub fn buf_in_slice(b: &[u8]) -> u32 { b.len() as u32 + b[b.len() - 1] as u32 }

/// Rust fills a buffer JS owns (the zero-allocation way to hand bytes out).
#[napi]
pub fn buf_fill(mut b: Uint8ArraySlice, v: u32) -> u32 {
  let b = unsafe { b.as_mut() };
  let n = b.len();
  b[0] = v as u8; b[n - 1] = v as u8; // touch, do not memset: the crossing is what is priced
  n as u32
}

/// Rust hands out a NEW 4 KB Buffer it owns: a Vec moved into an external buffer (no copy).
#[napi]
pub fn buf_out_new(v: u32) -> Buffer { let mut x = vec![0u8; 4096]; x[0] = v as u8; Buffer::from(x) }

/// the same, but copied into a fresh JS-owned Buffer (napi_create_buffer_copy).
#[napi]
pub fn buf_out_copy(env: &Env, v: u32) -> Result<Unknown<'_>> {
  static mut SRC: [u8; 4096] = [0u8; 4096];
  unsafe {
    SRC[0] = v as u8;
    let mut data = ptr::null_mut();
    let mut out = ptr::null_mut();
    let st = sys::napi_create_buffer_copy(env.raw(), 4096, ptr::addr_of!(SRC) as *const c_void, &mut data, &mut out);
    if st != sys::Status::napi_ok { return Err(Error::from_reason("copy")); }
    Unknown::from_napi_value(env.raw(), out)
  }
}

// ---------------------------------------------------------------- 3. Rust calls JS, directly
/// napi-rs `Function::call` once per record: n calls of f(i).
#[napi]
pub fn call_each(f: Function<u32, ()>, n: u32) -> Result<()> {
  for i in 0..n { f.call(i)?; }
  Ok(())
}

/// raw napi_call_function once per record (what napi-rs wraps), one int argument.
#[napi]
pub fn call_each_raw(env: Env, f: Function<u32, ()>, n: u32) -> Result<()> {
  unsafe {
    let e = env.raw();
    let fr = f.raw();
    let mut undef = ptr::null_mut();
    sys::napi_get_undefined(e, &mut undef);
    let mut ret = ptr::null_mut();
    for i in 0..n {
      let mut a = ptr::null_mut();
      sys::napi_create_uint32(e, i, &mut a);
      let st = sys::napi_call_function(e, undef, fr, 1, &a, &mut ret);
      if st != sys::Status::napi_ok { return Err(Error::from_reason("call")); }
    }
  }
  Ok(())
}

/// Batched callbacks: Rust holds `total` records of `rec` bytes; it calls f(count) once per
/// batch of `batch` records, after copying the batch's bytes into ONE JS-owned scratch Buffer
/// that the JS callback reads (what a kernel handing a batch to JS would do). Returns records sent.
#[napi]
pub fn call_batches(env: Env, f: Function<u32, ()>, mut scratch: Uint8ArraySlice, total: u32, batch: u32, rec: u32) -> Result<u32> {
  let scratch = unsafe { scratch.as_mut() };
  let src = make_records(batch as usize, rec as usize);
  let need = (batch * rec) as usize;
  if scratch.len() < need { return Err(Error::from_reason("scratch too small")); }
  let mut sent = 0u32;
  let fr = f.raw();
  unsafe {
    let e = env.raw();
    let mut undef = ptr::null_mut();
    sys::napi_get_undefined(e, &mut undef);
    let mut ret = ptr::null_mut();
    let mut cnt = ptr::null_mut();
    while sent < total {
      let k = batch.min(total - sent);
      scratch[..(k * rec) as usize].copy_from_slice(&src[..(k * rec) as usize]);
      sys::napi_create_uint32(e, k, &mut cnt);
      let st = sys::napi_call_function(e, undef, fr, 1, &cnt, &mut ret);
      if st != sys::Status::napi_ok { return Err(Error::from_reason("call")); }
      sent += k;
    }
  }
  Ok(sent)
}

fn make_records(n: usize, rec: usize) -> Vec<u8> {
  let mut v = vec![0u8; n * rec];
  for i in 0..n {
    let r = &mut v[i * rec..(i + 1) * rec];
    r[0..4].copy_from_slice(&(i as u32).to_le_bytes());
    for (j, b) in r[4..].iter_mut().enumerate() { *b = (j as u8).wrapping_add(i as u8); }
  }
  v
}

// ---------------------------------------------------------------- 4. threadsafe function from a Rust thread
// Raw napi_threadsafe_function: a Rust thread produces `total` records in batches of `batch`;
// each batch is one call into JS carrying a Buffer of the batch's bytes. Blocking mode with a
// bounded queue, so the producer cannot run ahead without limit.
struct Tsfn(sys::napi_threadsafe_function);
unsafe impl Send for Tsfn {}

struct Payload { bytes: Vec<u8>, count: u32 }

unsafe extern "C" fn tsfn_call_js(env: sys::napi_env, js_cb: sys::napi_value, _ctx: *mut c_void, data: *mut c_void) {
  if env.is_null() { drop(Box::from_raw(data as *mut Payload)); return; }
  let p = Box::from_raw(data as *mut Payload);
  let mut buf = ptr::null_mut();
  let mut dp = ptr::null_mut();
  // copy into a JS-owned Buffer (an external buffer would need a finalizer per batch)
  sys::napi_create_buffer_copy(env, p.bytes.len(), p.bytes.as_ptr() as *const c_void, &mut dp, &mut buf);
  let mut cnt = ptr::null_mut();
  sys::napi_create_uint32(env, p.count, &mut cnt);
  let mut undef = ptr::null_mut();
  sys::napi_get_undefined(env, &mut undef);
  let args = [buf, cnt];
  let mut ret = ptr::null_mut();
  sys::napi_call_function(env, undef, js_cb, 2, args.as_ptr(), &mut ret);
}

#[napi]
pub fn tsfn_start(env: Env, f: Function<(Unknown, u32), ()>, total: u32, batch: u32, rec: u32, queue: u32) -> Result<()> {
  let mut tsfn: sys::napi_threadsafe_function = ptr::null_mut();
  unsafe {
    let mut name = ptr::null_mut();
    sys::napi_create_string_utf8(env.raw(), c"e03".as_ptr(), 3, &mut name);
    let st = sys::napi_create_threadsafe_function(
      env.raw(), f.raw(), ptr::null_mut(), name, queue as usize, 1,
      ptr::null_mut(), None, ptr::null_mut(), Some(tsfn_call_js), &mut tsfn);
    if st != sys::Status::napi_ok { return Err(Error::from_reason("tsfn create")); }
  }
  let t = Tsfn(tsfn);
  std::thread::spawn(move || {
    let t = t;
    let src = make_records(batch as usize, rec as usize);
    let mut sent = 0u32;
    while sent < total {
      let k = batch.min(total - sent);
      let p = Box::new(Payload { bytes: src[..(k * rec) as usize].to_vec(), count: k });
      unsafe {
        sys::napi_call_threadsafe_function(t.0, Box::into_raw(p) as *mut c_void, sys::ThreadsafeFunctionCallMode::blocking);
      }
      sent += k;
    }
    unsafe { sys::napi_release_threadsafe_function(t.0, sys::ThreadsafeFunctionReleaseMode::release); }
  });
  Ok(())
}

// ---------------------------------------------------------------- 5. a SharedArrayBuffer ring
// JS allocates a SharedArrayBuffer: [0..64) header (u32 head at 0, u32 tail at 4 — record
// counts, wrapping), then `slots` records of `rec` bytes. A Rust thread writes records and
// publishes `head` once per `batch` records (Release); JS polls `head` with Atomics.load,
// reads the records, and stores `tail`. V8's Atomics.wait cannot be woken from Rust, so the JS
// side spins: a real design adds a doorbell (a TSFN or uv_async) for when the consumer sleeps.
struct RingPtr(*mut u8, usize);
unsafe impl Send for RingPtr {}

#[napi]
pub fn ring_start(mut ring: Uint8ArraySlice, slots: u32, rec: u32, total: u32, batch: u32) -> Result<()> {
  let ring = unsafe { ring.as_mut() };
  let p = RingPtr(ring.as_mut_ptr(), ring.len());
  if (64 + slots * rec) as usize > ring.len() { return Err(Error::from_reason("ring too small")); }
  std::thread::spawn(move || {
    let p = p;
    let base = p.0;
    let head = unsafe { &*(base as *const AtomicU32) };
    let tail = unsafe { &*(base.add(4) as *const AtomicU32) };
    let src = make_records(batch as usize, rec as usize);
    let mut h = head.load(Ordering::Relaxed);
    let mut sent = 0u32;
    while sent < total {
      let k = batch.min(total - sent);
      // wait for room for k records
      loop {
        let t = tail.load(Ordering::Acquire);
        if h.wrapping_sub(t) + k <= slots { break; }
        std::hint::spin_loop();
      }
      for i in 0..k {
        let slot = (h.wrapping_add(i) % slots) as usize;
        unsafe {
          let dst = base.add(64 + slot * rec as usize);
          ptr::copy_nonoverlapping(src.as_ptr().add((i * rec) as usize), dst, rec as usize);
        }
      }
      h = h.wrapping_add(k);
      head.store(h, Ordering::Release);
      sent += k;
    }
  });
  Ok(())
}

// ---------------------------------------------------------------- 6. a record batch for data's fold (X3)
// The kernel holds encoded frames (fero v4's codec bytes, made by JS once and handed in); the
// three ways a Rust kernel could give one to data's JS fold are priced in bench/fold.mjs:
//   pull: JS asks for the next frame, Rust copies it into a JS-owned scratch buffer;
//   push: Rust walks its frames and calls a JS function per frame with the scratch buffer;
//   objects: Rust builds the JS record objects itself through napi (see build_records).
static mut FRAMES: Vec<Vec<u8>> = Vec::new();

#[napi]
pub fn frames_load(frames: Vec<Buffer>) -> u32 {
  unsafe {
    let f = &mut *ptr::addr_of_mut!(FRAMES);
    f.clear();
    for b in frames { f.push(b.to_vec()); }
    f.len() as u32
  }
}

/// pull: copy frame i into the scratch buffer, return its length.
#[napi]
pub fn frame_pull(i: u32, mut scratch: Uint8ArraySlice) -> u32 {
  let scratch = unsafe { scratch.as_mut() };
  unsafe {
    let f = &*ptr::addr_of!(FRAMES);
    let fr = &f[i as usize % f.len()];
    scratch[..fr.len()].copy_from_slice(fr);
    fr.len() as u32
  }
}

/// push: for n frames, copy each into scratch and call f(len). One napi call, n JS callbacks.
#[napi]
pub fn frame_push(env: Env, f: Function<u32, ()>, mut scratch: Uint8ArraySlice, n: u32) -> Result<()> {
  let scratch = unsafe { scratch.as_mut() };
  unsafe {
    let e = env.raw();
    let fr_js = f.raw();
    let mut undef = ptr::null_mut();
    sys::napi_get_undefined(e, &mut undef);
    let frames = &*ptr::addr_of!(FRAMES);
    let mut ret = ptr::null_mut();
    for i in 0..n {
      let fr = &frames[i as usize % frames.len()];
      scratch[..fr.len()].copy_from_slice(fr);
      let mut a = ptr::null_mut();
      sys::napi_create_uint32(e, fr.len() as u32, &mut a);
      let st = sys::napi_call_function(e, undef, fr_js, 1, &a, &mut ret);
      if st != sys::Status::napi_ok { return Err(Error::from_reason("call")); }
    }
  }
  Ok(())
}

/// objects: Rust makes `n` record objects { type, key: [row, field], value } itself through napi
/// (strings, numbers, arrays and objects created one call at a time) and returns the array, as
/// a kernel that hands JS ready objects would. `salt` varies the values.
#[napi]
pub fn build_records(env: &Env, n: u32, rows: u32, salt: u32) -> Result<Unknown<'_>> {
  unsafe {
    let e = env.raw();
    let mut arr = ptr::null_mut();
    sys::napi_create_array_with_length(e, n as usize, &mut arr);
    let mut ktype = ptr::null_mut(); sys::napi_create_string_utf8(e, c"type".as_ptr(), 4, &mut ktype);
    let mut kkey = ptr::null_mut(); sys::napi_create_string_utf8(e, c"key".as_ptr(), 3, &mut kkey);
    let mut kval = ptr::null_mut(); sys::napi_create_string_utf8(e, c"value".as_ptr(), 5, &mut kval);
    let mut zero = ptr::null_mut(); sys::napi_create_uint32(e, 0, &mut zero);
    let mut rowbuf = [0u8; 16];
    for i in 0..n {
      let mut o = ptr::null_mut(); sys::napi_create_object(e, &mut o);
      sys::napi_set_property(e, o, ktype, zero);
      let r = (i.wrapping_mul(7).wrapping_add(salt)) % rows;
      let s = fmt_row(&mut rowbuf, r);
      let mut row = ptr::null_mut(); sys::napi_create_string_utf8(e, rowbuf.as_ptr() as *const _, s as isize, &mut row);
      let mut key = ptr::null_mut(); sys::napi_create_array_with_length(e, if i % 2 == 0 { 2 } else { 1 }, &mut key);
      sys::napi_set_element(e, key, 0, row);
      if i % 2 == 0 {
        let mut fld = ptr::null_mut(); sys::napi_create_string_utf8(e, c"n".as_ptr(), 1, &mut fld);
        sys::napi_set_element(e, key, 1, fld);
      }
      sys::napi_set_property(e, o, kkey, key);
      if i % 2 == 0 {
        let mut v = ptr::null_mut(); sys::napi_create_double(e, (i + salt) as f64, &mut v);
        sys::napi_set_property(e, o, kval, v);
      } else {
        let mut v = ptr::null_mut(); sys::napi_create_object(e, &mut v);
        let mut nm = ptr::null_mut(); sys::napi_create_string_utf8(e, c"user".as_ptr(), 4, &mut nm);
        sys::napi_set_named_property(e, v, c"name".as_ptr(), nm);
        let mut num = ptr::null_mut(); sys::napi_create_double(e, (i + salt) as f64, &mut num);
        sys::napi_set_named_property(e, v, c"n".as_ptr(), num);
        let mut tags = ptr::null_mut(); sys::napi_create_array_with_length(e, 2, &mut tags);
        let mut ta = ptr::null_mut(); sys::napi_create_string_utf8(e, c"a".as_ptr(), 1, &mut ta);
        let mut tb = ptr::null_mut(); sys::napi_create_string_utf8(e, c"b".as_ptr(), 1, &mut tb);
        sys::napi_set_element(e, tags, 0, ta); sys::napi_set_element(e, tags, 1, tb);
        sys::napi_set_named_property(e, v, c"tags".as_ptr(), tags);
        sys::napi_set_property(e, o, kval, v);
      }
      sys::napi_set_element(e, arr, i, o);
    }
    Unknown::from_napi_value(e, arr)
  }
}

fn fmt_row(buf: &mut [u8; 16], r: u32) -> usize {
  buf[0] = b'u';
  let mut tmp = [0u8; 10]; let mut n = 0; let mut x = r;
  loop { tmp[n] = b'0' + (x % 10) as u8; n += 1; x /= 10; if x == 0 { break; } }
  for j in 0..n { buf[1 + j] = tmp[n - 1 - j]; }
  1 + n
}

// ---------------------------------------------------------------- 7. a /dev/shm map (SIDE's shared-memory seam)
/// Map a file (made by the Rust daemon in /dev/shm) and hand it to JS as an external
/// ArrayBuffer. One call at start; no napi on the per-record path after that.
#[napi]
pub fn map_shm(env: &Env, path: String, len: u32) -> Result<Unknown<'_>> {
  use std::os::unix::io::AsRawFd;
  let f = std::fs::OpenOptions::new().read(true).write(true).open(&path).map_err(|e| Error::from_reason(e.to_string()))?;
  let p = unsafe { libc_mmap(len as usize, f.as_raw_fd()) };
  if p.is_null() { return Err(Error::from_reason("mmap")); }
  std::mem::forget(f);
  unsafe {
    let mut ab = ptr::null_mut();
    let st = sys::napi_create_external_arraybuffer(env.raw(), p as *mut c_void, len as usize, None, ptr::null_mut(), &mut ab);
    if st != sys::Status::napi_ok { return Err(Error::from_reason("external arraybuffer refused")); }
    Unknown::from_napi_value(env.raw(), ab)
  }
}

extern "C" {
  fn mmap(addr: *mut c_void, len: usize, prot: i32, flags: i32, fd: i32, off: i64) -> *mut c_void;
}
unsafe fn libc_mmap(len: usize, fd: i32) -> *mut u8 {
  const PROT_READ: i32 = 1; const PROT_WRITE: i32 = 2; const MAP_SHARED: i32 = 1;
  let p = mmap(ptr::null_mut(), len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if p as isize == -1 { ptr::null_mut() } else { p as *mut u8 }
}
