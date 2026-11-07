// E-03 part 3, the QuickJS row (rquickjs): an empty Rust function called from JS, a 4 KB buffer
// call, data's hot lane on a 256-record batch inside QuickJS (the same work.js), and memory.
// e03_quickjs <data.bundle.js> <shim.js> <work.js>
use rquickjs::{Context, Function, Runtime, TypedArray};
use std::time::Instant;

fn rss() -> u64 {
  let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
  s.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * 4096
}

fn main() {
  let a: Vec<String> = std::env::args().collect();
  let quick = std::env::var("QUICK").ok().as_deref() == Some("1");
  let reps = if quick { 2 } else { 5 };
  let (bundle, shim, work) = (std::fs::read_to_string(&a[1]).unwrap(), std::fs::read_to_string(&a[2]).unwrap(), std::fs::read_to_string(&a[3]).unwrap());
  let r0 = rss();
  let t0 = Instant::now();
  let rt = Runtime::new().unwrap();
  rt.set_max_stack_size(8 << 20);
  let ctx = Context::full(&rt).unwrap();
  let create_us = t0.elapsed().as_micros();
  let m0 = rt.memory_usage().memory_used_size;
  let r1 = rss();
  let host = "rquickjs 0.14.0";
  // rt.run_gc() and rt.memory_usage() lock the runtime, so they run between ctx.with blocks
  let load_ms = ctx.with(|ctx| {
    let g = ctx.globals();
    g.set("__noop", Function::new(ctx.clone(), || {}).unwrap()).unwrap();
    g.set("__buf", Function::new(ctx.clone(), |b: TypedArray<u8>| -> u32 {
      let p = b.as_raw().unwrap();
      let s: &[u8] = unsafe { p.as_ref() };
      s.len() as u32 + s[s.len() - 1] as u32
    }).unwrap()).unwrap();
    let t1 = Instant::now();
    let _: () = ctx.eval(shim.as_str()).unwrap();
    let r: rquickjs::Result<()> = ctx.eval(bundle.as_str());
    if let Err(e) = r { let ex = ctx.catch(); panic!("bundle: {e} {:?}", ex); }
    let _: () = ctx.eval(work.as_str()).unwrap();
    t1.elapsed().as_secs_f64() * 1e3
  });
  let rows = 10_000i64;
  rt.run_gc();
  let m1 = rt.memory_usage().memory_used_size;
  ctx.with(|ctx| {
    let r: rquickjs::Result<i32> = ctx.eval(format!("W.setup({rows})"));
    if let Err(e) = r { let ex = ctx.catch(); panic!("setup: {e} {:?}", ex); }
  });
  rt.run_gc();
  let m2 = rt.memory_usage().memory_used_size;
  println!("{{\"host\":\"{host}\",\"measure\":\"memory\",\"createUs\":{create_us},\"loadMs\":{load_ms:.2},\"heapBareBytes\":{m0},\"heapDataLoadedBytes\":{},\"heapPerRowBytes\":{},\"rssIsolateBytes\":{},\"rssBytes\":{}}}",
    m1 - m0, (m2 - m1) / rows, r1 as i64 - r0 as i64, rss());
  ctx.with(|ctx| {
    let run = |code: String| -> f64 {
      let t = Instant::now();
      let r: rquickjs::Result<rquickjs::Value> = ctx.eval(code);
      if let Err(e) = r { let ex = ctx.catch(); panic!("run: {e} {:?}", ex); }
      t.elapsed().as_nanos() as f64
    };
    let measure = |name: &str, units: f64, iters: u64, code: &dyn Fn(u64) -> String| {
      run(code((iters >> 3).max(1)));
      let mut xs: Vec<f64> = (0..reps).map(|_| run(code(iters)) / (iters as f64 * units)).collect();
      xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
      println!("{{\"host\":\"{host}\",\"measure\":\"{name}\",\"ns\":{:.2},\"min\":{:.2},\"max\":{:.2},\"reps\":{reps}}}", xs[xs.len() / 2], xs[0], xs[xs.len() - 1]);
    };
    let n = if quick { 200_000 } else { 2_000_000 };
    measure("js loop floor", 1.0, n, &|k| format!("W.loop({k})"));
    measure("empty op", 1.0, n, &|k| format!("(function(){{ var op = __noop; for (var i = 0; i < {k}; i++) op(); return 0 }})()"));
    measure("4 KB buffer op", 1.0, n, &|k| format!("(function(){{ var op = __buf; var b = new Uint8Array(4096); var s = 0; for (var i = 0; i < {k}; i++) s += op(b); return s }})()"));
    let f = if quick { 50 } else { 300 };
    measure("data fold, batch 256 (ns/record)", 256.0, f, &|k| format!("W.fold({k})"));
  });
}
