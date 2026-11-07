// Native replay of a recorded sim trace through K (Rust, no WASM, no JS): the kernel's own cost.
// replay <trace file> <reps>  ->  one JSON line: ns per event (median of reps), min, max
use std::time::Instant;
fn main() {
  let a: Vec<String> = std::env::args().collect();
  let t = std::fs::read(&a[1]).unwrap();
  let reps: usize = a.get(2).map(|x| x.parse().unwrap()).unwrap_or(5);
  e04_k::replay(&t);
  let mut xs = Vec::new(); let mut steps = 0;
  for _ in 0..reps { let t0 = Instant::now(); let (s, _) = e04_k::replay(&t); steps = s; xs.push(t0.elapsed().as_nanos() as f64 / s as f64); }
  xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
  println!("{{\"measure\":\"K replay, native Rust\",\"ns\":{:.1},\"min\":{:.1},\"max\":{:.1},\"events\":{},\"reps\":{}}}", xs[xs.len() / 2], xs[0], xs[xs.len() - 1], steps, reps);
}
