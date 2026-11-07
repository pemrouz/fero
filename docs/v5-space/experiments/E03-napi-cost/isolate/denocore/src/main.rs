// E-03 part 3, the deno_core row: a V8 isolate embedded in Rust (EMB-V8). An empty op, a 4 KB
// buffer op, data's hot lane on a 256-record batch inside the isolate (the same work.js the
// Node and QuickJS hosts run), and the isolate's memory. One JSON line per measure.
// e03_denocore <data.bundle.js> <shim.js> <work.js>
use deno_core::{extension, op2, JsRuntime, RuntimeOptions};
use std::time::Instant;

#[op2(fast)]
fn op_e03_noop() {}

#[op2(fast)]
fn op_e03_buf(#[buffer] b: &[u8]) -> u32 { b.len() as u32 + b[b.len() - 1] as u32 }

extension!(e03_ext, ops = [op_e03_noop, op_e03_buf]);

fn rss() -> u64 {
  let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
  s.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * 4096
}

fn run(rt: &mut JsRuntime, code: String) -> f64 {
  let t = Instant::now();
  rt.execute_script("<e03>", code).expect("script");
  t.elapsed().as_nanos() as f64
}

fn measure(rt: &mut JsRuntime, name: &str, units: f64, iters: u64, reps: usize, code: &dyn Fn(u64) -> String) {
  run(rt, code((iters >> 3).max(1)));
  let mut xs: Vec<f64> = (0..reps).map(|_| run(rt, code(iters)) / (iters as f64 * units)).collect();
  xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
  println!("{{\"host\":\"deno_core 0.413.0 (v8 crate 150.4.0)\",\"measure\":\"{}\",\"ns\":{:.2},\"min\":{:.2},\"max\":{:.2},\"reps\":{}}}", name, xs[xs.len() / 2], xs[0], xs[xs.len() - 1], reps);
}

fn main() {
  let a: Vec<String> = std::env::args().collect();
  let quick = std::env::var("QUICK").ok().as_deref() == Some("1");
  let reps = if quick { 2 } else { 5 };
  let (bundle, shim, work) = (std::fs::read_to_string(&a[1]).unwrap(), std::fs::read_to_string(&a[2]).unwrap(), std::fs::read_to_string(&a[3]).unwrap());
  let r0 = rss();
  let t0 = Instant::now();
  let mut rt = JsRuntime::new(RuntimeOptions { extensions: vec![e03_ext::init()], ..Default::default() });
  let create_us = t0.elapsed().as_micros();
  let heap0 = rt.v8_isolate().get_heap_statistics().used_heap_size();
  let r1 = rss();
  let t1 = Instant::now();
  rt.execute_script("<shim>", shim).unwrap();
  rt.execute_script("<data>", bundle).unwrap();
  rt.execute_script("<work>", work).unwrap();
  let load_ms = t1.elapsed().as_secs_f64() * 1e3;
  rt.v8_isolate().low_memory_notification();
  let heap1 = rt.v8_isolate().get_heap_statistics().used_heap_size();
  let rows = 10_000u64;
  rt.execute_script("<setup>", format!("W.setup({rows})")).unwrap();
  rt.v8_isolate().low_memory_notification();
  let heap2 = rt.v8_isolate().get_heap_statistics().used_heap_size();
  println!("{{\"host\":\"deno_core 0.413.0 (v8 crate 150.4.0)\",\"measure\":\"memory\",\"createUs\":{create_us},\"loadMs\":{load_ms:.2},\"heapBareBytes\":{heap0},\"heapDataLoadedBytes\":{},\"heapPerRowBytes\":{},\"rssIsolateBytes\":{},\"rssBytes\":{}}}",
    heap1 as i64 - heap0 as i64, (heap2 as i64 - heap1 as i64) / rows as i64, r1 as i64 - r0 as i64, rss());
  let n = if quick { 1_000_000 } else { 10_000_000 };
  measure(&mut rt, "js loop floor", 1.0, n, reps, &|k| format!("W.loop({k})"));
  measure(&mut rt, "empty op", 1.0, n, reps, &|k| format!("(function(){{ const op = Deno.core.ops.op_e03_noop; for (let i = 0; i < {k}; i++) op(); return 0 }})()"));
  measure(&mut rt, "4 KB buffer op", 1.0, n, reps, &|k| format!("(function(){{ const op = Deno.core.ops.op_e03_buf; const b = new Uint8Array(4096); let s = 0; for (let i = 0; i < {k}; i++) s += op(b); return s }})()"));
  let f = if quick { 500 } else { 5000 };
  measure(&mut rt, "data fold, batch 256 (ns/record)", 256.0, f, reps, &|k| format!("W.fold({k})"));
}
