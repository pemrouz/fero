#!/usr/bin/env node
// Probe P2's timing, under Node. One JSON line per measure.
//
//   node --expose-gc probes/p2/bench.mjs <the .wasm>
//
//   seeds-200          200 seeds, one instance, data folding every batch   (bar: 1 s)
//   seeds-200-nofold   the same, the hook returns at once
//   seeds-200-fresh-instance   a new instance for every seed, fold on      (reference)
//   fresh-world        a fresh world plus a scenario, 2,000 times: p50, p99, max  (bar: p99 5 ms)
//   fresh-world-fresh-instance   the same with a new instance each time    (reference)
//   module             the size of the .wasm, the time to compile it and to make an instance
//
// Each measure warms up first and then repeats REPS times (5). QUICK=1 runs 2.
// Times on a shared machine are provisional.
import { readFileSync } from 'node:fs'
import { compile, loadData, open } from './sim.mjs'

const [wasm] = process.argv.slice(2)
if (!wasm) { console.error('usage: node --expose-gc probes/p2/bench.mjs <the .wasm>'); process.exit(2) }
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const SEEDS = 200
const FRESH = quick ? 200 : 2000
const gc = globalThis.gc ?? (() => {})
const now = () => process.hrtime.bigint()
const ms = (t0) => Number(now() - t0) / 1e6
const r3 = (x) => +x.toFixed(3)
const spread = (xs) => { const s = [...xs].sort((a, b) => a - b); return { med: s[s.length >> 1], min: s[0], max: s[s.length - 1] } }
const out = (o) => console.log(JSON.stringify({ node: process.version, ...o }))

const D = await loadData()
const mod = compile(wasm)

function seeds(measure, run) {
  const pass = () => { let events = 0; gc(); const t0 = now(); for (let s = 1; s <= SEEDS; s++) events += run(s).events; return { ms: ms(t0), events } }
  pass() // warm-up
  const rs = Array.from({ length: REPS }, pass)
  const t = spread(rs.map((r) => r.ms))
  out({ measure, seeds: SEEDS, ms: r3(t.med), min: r3(t.min), max: r3(t.max), events: rs[0].events, eventsPerSeed: r3(rs[0].events / SEEDS), nsPerEvent: r3((t.med * 1e6) / rs[0].events), reps: REPS })
}

function fresh(measure, run) {
  for (let i = 1; i <= 200; i++) run(i) // warm-up
  const rs = Array.from({ length: REPS }, () => {
    const xs = []
    let events = 0
    gc()
    for (let i = 1; i <= FRESH; i++) { const t0 = now(); events += run(i).events; xs.push(ms(t0)) }
    xs.sort((a, b) => a - b)
    return { p50: xs[FRESH >> 1], p99: xs[Math.floor(FRESH * 0.99)], p999: xs[Math.floor(FRESH * 0.999)], max: xs[FRESH - 1], events }
  })
  const p50 = spread(rs.map((r) => r.p50)), p99 = spread(rs.map((r) => r.p99)), p999 = spread(rs.map((r) => r.p999)), mx = spread(rs.map((r) => r.max))
  out({ measure, n: FRESH, p50ms: +p50.med.toFixed(4), p50min: +p50.min.toFixed(4), p50max: +p50.max.toFixed(4), p99ms: +p99.med.toFixed(4), p99min: +p99.min.toFixed(4), p99max: +p99.max.toFixed(4), p999ms: +p999.med.toFixed(4), p999max: +p999.max.toFixed(4), maxms: r3(mx.med), maxOfMax: r3(mx.max), eventsPerWorld: r3(rs[0].events / FRESH), reps: REPS })
}

const folding = open(mod, D)
{
  // What one pass of 200 seeds hands to JavaScript (counted, not timed).
  for (let s = 1; s <= SEEDS; s++) folding.runSeed(s)
  out({ measure: 'fold-work', seeds: SEEDS, ...folding.stats, memoryBytes: folding.memoryBytes() })
}
seeds('seeds-200', (s) => folding.runSeed(s))
const plain = open(mod, null)
seeds('seeds-200-nofold', (s) => plain.runSeed(s))
seeds('seeds-200-fresh-instance', (s) => open(mod, D).runSeed(s))

fresh('fresh-world', (s) => folding.fresh(s))
fresh('fresh-world-fresh-instance', (s) => open(mod, D).fresh(s))

{
  const bytes = readFileSync(wasm)
  const time = (fn, n) => { fn(); return spread(Array.from({ length: REPS }, () => { const t0 = now(); for (let i = 0; i < n; i++) fn(); return (ms(t0) * 1e3) / n })) }
  const c = time(() => new WebAssembly.Module(bytes), 5)
  const i = time(() => new WebAssembly.Instance(mod, { fero: { batch() {} } }), 100)
  out({ measure: 'module', bytes: bytes.length, compileUs: r3(c.med), instanceUs: r3(i.med) })
}
