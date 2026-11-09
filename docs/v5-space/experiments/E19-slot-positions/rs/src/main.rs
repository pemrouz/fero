// E-19 (Rust): the same four header forms as ../node/header.mjs, the same batches (256 records of
// 100 B), bytes per record and ns per record for encode and header-only decode. No dependencies.
use std::hint::black_box;
use std::time::Instant;

const SLOTS: usize = 1024;
const BATCH: usize = 256;
const PAY: usize = 100;
const FORMS: [&str; 4] = ["off", "slot", "slotfix", "slotimp"];

struct Input { slot: Vec<u16>, issuer: Vec<u32>, call: Vec<u32> }

fn make_input(seed: u32) -> Input {
  let mut s: u32 = if seed == 0 { 1 } else { seed };
  let mut rnd = || { s ^= s << 13; s ^= s >> 17; s ^= s << 5; (s as f64) / 4294967296.0 };
  let mut inp = Input { slot: vec![], issuer: vec![], call: vec![] };
  for _ in 0..BATCH {
    inp.slot.push((rnd() * SLOTS as f64) as u16);
    inp.issuer.push(1 + (rnd() * 200.0) as u32);
    inp.call.push(1_000_000 + (rnd() * 100_000.0) as u32);
  }
  inp
}

#[inline(always)]
fn vu(buf: &mut [u8], p: &mut usize, mut v: u64) { while v >= 128 { buf[*p] = (v as u8 & 127) | 128; *p += 1; v >>= 7; } buf[*p] = v as u8; *p += 1; }
#[inline(always)]
fn rv(buf: &[u8], q: &mut usize) -> u64 { let mut v = 0u64; let mut sh = 0; loop { let b = buf[*q]; *q += 1; v |= ((b & 127) as u64) << sh; if b & 128 == 0 { return v; } sh += 7; } }

fn encode(form: usize, inp: &Input, seq: &mut [u64], buf: &mut [u8], term: u64, base: u64, payload: &[u8]) -> usize {
  let mut p = 0usize;
  vu(buf, &mut p, term); vu(buf, &mut p, base); buf[p..p + 8].copy_from_slice(&1.7e12f64.to_le_bytes()); p += 8; vu(buf, &mut p, BATCH as u64);
  for i in 0..BATCH {
    vu(buf, &mut p, inp.issuer[i] as u64); vu(buf, &mut p, inp.call[i] as u64);
    let sl = inp.slot[i] as usize;
    match form {
      1 => { vu(buf, &mut p, sl as u64); seq[sl] += 1; vu(buf, &mut p, seq[sl]); }
      2 => { buf[p..p + 2].copy_from_slice(&(sl as u16).to_le_bytes()); seq[sl] += 1; buf[p + 2..p + 6].copy_from_slice(&(seq[sl] as u32).to_le_bytes()); p += 6; }
      3 => { vu(buf, &mut p, sl as u64); seq[sl] += 1; }
      _ => {}
    }
    vu(buf, &mut p, PAY as u64); buf[p..p + PAY].copy_from_slice(payload); p += PAY;
  }
  p
}

fn decode(form: usize, buf: &[u8], n: usize, cnt: &mut [u64]) -> u64 {
  let mut q = 0usize; let mut acc = 0u64;
  let term = rv(buf, &mut q); let base = rv(buf, &mut q); q += 8; let count = rv(buf, &mut q); acc = acc.wrapping_add(term + base);
  for _ in 0..count {
    acc = acc.wrapping_add(rv(buf, &mut q)); acc = acc.wrapping_add(rv(buf, &mut q));
    match form {
      1 => { let sl = rv(buf, &mut q); acc = acc.wrapping_add(sl + rv(buf, &mut q)); }
      2 => { let sl = u16::from_le_bytes([buf[q], buf[q + 1]]) as u64; let s = u32::from_le_bytes(buf[q + 2..q + 6].try_into().unwrap()) as u64; acc = acc.wrapping_add(sl + s); q += 6; }
      3 => { let sl = rv(buf, &mut q) as usize; cnt[sl] += 1; acc = acc.wrapping_add(sl as u64 + cnt[sl]); }
      _ => {}
    }
    let len = rv(buf, &mut q) as usize; q += len;
  }
  assert_eq!(q, n);
  acc
}

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let mut secs = 2.0f64; let mut bases: Vec<u64> = vec![1000, 1_000_000, 1_000_000_000];
  for a in &args { if let Some(v) = a.strip_prefix("secs=") { secs = v.parse().unwrap(); } if let Some(v) = a.strip_prefix("seqbase=") { bases = v.split(',').map(|x| x.parse().unwrap()).collect(); } }
  let inputs: Vec<Input> = (0..16u32).map(|k| make_input(k * 7919 + 1)).collect();
  let payload = vec![0x5au8; PAY];
  let mut buf = vec![0u8; BATCH * (PAY + 32) + 64];
  let load = std::fs::read_to_string("/proc/loadavg").unwrap_or_default();
  let mut rows = Vec::new(); let mut sink = 0u64;
  for &base in &bases {
    for f in 0..4 {
      let mut bytes = 0usize;
      for inp in &inputs { let mut s2 = vec![base; SLOTS]; bytes += encode(f, inp, &mut s2, &mut buf, 7, 123456789, &payload); }
      let per = bytes as f64 / (inputs.len() * BATCH) as f64;
      let mut seq = vec![base; SLOTS]; let mut cnt = vec![base; SLOTS];
      for i in 0..20000usize { let n = encode(f, &inputs[i & 15], &mut seq, &mut buf, 7, 123456789 + (i * BATCH) as u64, &payload); sink = sink.wrapping_add(decode(f, &buf, n, &mut cnt)); }
      let t0 = Instant::now(); let mut it = 0usize;
      loop { for k in 0..256 { let n = encode(f, &inputs[(it + k) & 15], &mut seq, &mut buf, 7, 123456789 + ((it + k) * BATCH) as u64, &payload); black_box(n); black_box(&buf); } it += 256; if t0.elapsed().as_secs_f64() > secs { break; } }
      let enc = t0.elapsed().as_nanos() as f64 / (it * BATCH) as f64;
      let mut s3 = vec![base; SLOTS]; let n = encode(f, &inputs[0], &mut s3, &mut buf, 7, 123456789, &payload);
      let t1 = Instant::now(); let mut it2 = 0usize;
      loop { for _ in 0..256 { sink = sink.wrapping_add(decode(f, black_box(&buf), n, &mut cnt)); } it2 += 256; if t1.elapsed().as_secs_f64() > secs { break; } }
      let dec = t1.elapsed().as_nanos() as f64 / (it2 * BATCH) as f64;
      rows.push(format!("{{\"form\":\"{}\",\"seq_base\":{},\"bytes_per_record\":{:.3},\"header_bytes_per_record\":{:.3},\"enc_ns\":{:.2},\"dec_ns\":{:.2}}}", FORMS[f], base, per, per - PAY as f64, enc, dec));
    }
  }
  println!("{{\"exp\":\"E-19\",\"impl\":\"rust\",\"batch\":{},\"payload\":{},\"secs\":{},\"loadavg\":\"{}\",\"rows\":[{}],\"sink\":{}}}", BATCH, PAY, secs, load.trim(), rows.join(","), sink % 1000);
}
