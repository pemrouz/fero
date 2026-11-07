// E-04's timing: TEST-01's bar with the kernel in WASM, against the same kernel in TS.
// node --experimental-strip-types --expose-gc bench/test01.ts <k.wasm> <raft.wasm> <trace file>
// One JSON line per measure. Kernels: K (the twins) and Raft (raft-rs in WASM; E-10's TS port).
//   chaos-200     200 chaos seeds, data's hot lane folding every apply on every node (TEST-01: <= 1 s)
//   chaos-200-nofold  the same without data, to show the kernel's share
//   fresh         a fresh solo node plus a scenario: elect, 3 writes, folded by data, a read (TEST-01: <= 5 ms)
//   replay        the recorded per-node event streams of 200 K seeds replayed with no driver:
//                 TS twin, WASM twin one call per event (the crossing), WASM twin in one call (no crossing)
//   wasm-setup    compile a module; make an instance
import { readFileSync, writeFileSync } from 'node:fs'
import { tsKernel, Node, W, R, EV, OP, EFF } from '../k-ts/k.ts'
import { compileK, wasmKernel } from '../sim/kwasm.ts'
import { runSeed, type Recorder } from '../sim/simk.ts'
import { raftWasm, raftTs, runRaftSeed, compile } from '../sim/simraft.ts'

const [kPath, rPath, tracePath] = process.argv.slice(2)
const D: any = await import((process.env.DATA ?? '/home/user/pemrouz/data') + '/api/index.ts')
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const TICKS = Number(process.env.TICKS ?? 130)
const gc = (globalThis as any).gc ?? (() => {})
const now = () => process.hrtime.bigint()
const out = (o: any) => console.log(JSON.stringify({ node: process.version, ...o }))
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { med: s[s.length >> 1], min: s[0], max: s[s.length - 1] } }
const r2 = (x: number) => +x.toFixed(2)

const kMod = compileK(kPath), rMod = compile(rPath)

// ---- chaos-200
function chaos(name: string, fn: (seed: number) => { events: number; violations: string[] }) {
  const one = () => { let ev = 0, v = 0; gc(); const t0 = now(); for (let s = 1; s <= 200; s++) { const r = fn(s); ev += r.events; v += r.violations.length } return { ms: Number(now() - t0) / 1e6, ev, v } }
  one() // warm-up
  const rs = Array.from({ length: REPS }, one)
  const st = stats(rs.map((r) => r.ms))
  out({ measure: 'chaos-200', kernel: name, ms: r2(st.med), min: r2(st.min), max: r2(st.max), events: rs[0].ev, nsPerEvent: r2((st.med * 1e6) / rs[0].ev), violations: rs[0].v, ticks: TICKS, reps: REPS })
}
const kT = tsKernel(), kW = wasmKernel(kMod)
for (const fold of [D, null]) {
  const tag = fold ? '' : ' (no data fold)'
  chaos('K ts' + tag, (s) => runSeed(kT, s, { fold, ticks: TICKS }))
  chaos('K wasm' + tag, (s) => runSeed(kW, s, { fold, ticks: TICKS }))
  chaos('raft ts-port' + tag, (s) => runRaftSeed(raftTs(), s, { fold, ticks: TICKS }))
  chaos('raft-rs wasm, fresh instance per seed' + tag, (s) => runRaftSeed(raftWasm(rMod, true), s, { fold, ticks: TICKS }))
  const one = raftWasm(rMod, false)
  chaos('raft-rs wasm, one instance' + tag, (s) => runRaftSeed(one, s, { fold, ticks: TICKS }))
}

// ---- fresh solo node + scenario
const tick = new Uint8Array([EV.TICK])
function scenarioK(K: any) {
  const src = D.$({}), lane = D.lane(src, {})
  const h = K.create(1, 1, new Uint8Array(0))
  const w = new W()
  const fold = (eff: Uint8Array) => {
    const r = new R(eff), recs: any[] = []
    while (r.more()) {
      const t = r.u8()
      if (t === EFF.SEND) { r.varint(); const l = r.varint(); r.pos += l }
      else if (t === EFF.PERSIST) { const l = r.varint(); r.pos += l }
      else if (t === EFF.APPLY) { r.varint(); const op = r.u8(), key = r.str(); if (op === OP.SET || op === OP.INCR) recs.push({ type: 0, key: [key], value: r.f64() }); else if (op === OP.DEL) r.u8() }
      else if (t === EFF.REPLY) { r.varint(); r.u8(); r.varint() }
      else if (t === EFF.ROLE) { r.u8(); r.varint(); r.varint() }
    }
    if (recs.length) lane(recs)
  }
  for (let i = 0; i < 25; i++) fold(K.step(h, tick))
  for (const [op, key, v] of [[OP.SET, 'stock', 10], [OP.INCR, 'stock', -1], [OP.SET, 'name', 3]] as const) { w.reset(); w.u8(EV.PROPOSE); w.varint(1); w.u8(op); w.str(key); w.f64(v); fold(K.step(h, w.take())) }
  const v = src[D.value].stock
  K.destroy(h)
  if (v !== 9) throw new Error('scenario read ' + v)
}
function scenarioRaft(A: any) {
  const src = D.$({}), lane = D.lane(src, {})
  let cur = 0
  A.begin(7, { send() {}, apply(_i: number, d: Uint8Array) { const r = new R(d); const op = r.u8(), key = r.str(), v = r.f64(); lane([{ type: 0, key: [key], value: op === OP.INCR ? (src[D.value][key] ?? 0) + v : v }]) }, leader() {} })
  const h = A.create(1, 1)
  for (let i = 0; i < 25; i++) A.tick(h)
  const w = new W()
  for (const [op, key, v] of [[OP.SET, 'stock', 10], [OP.INCR, 'stock', -1], [OP.SET, 'name', 3]] as const) { w.reset(); w.u8(op); w.str(key); w.f64(v); A.propose(h, w.take()) }
  void cur
  const v = src[D.value].stock
  if (v !== 9) throw new Error('raft scenario read ' + v)
}
function fresh(name: string, fn: () => void) {
  const N = quick ? 200 : 2000
  for (let i = 0; i < 200; i++) fn()
  const runs = Array.from({ length: REPS }, () => { const xs: number[] = []; for (let i = 0; i < N; i++) { const t0 = now(); fn(); xs.push(Number(now() - t0) / 1e6) } xs.sort((a, b) => a - b); return { p50: xs[N >> 1], p99: xs[Math.floor(N * 0.99)], max: xs[N - 1] } })
  const p50 = stats(runs.map((r) => r.p50)), p99 = stats(runs.map((r) => r.p99)), mx = stats(runs.map((r) => r.max))
  out({ measure: 'fresh node + scenario', kernel: name, p50ms: +p50.med.toFixed(4), p99ms: +p99.med.toFixed(4), p99min: +p99.min.toFixed(4), p99max: +p99.max.toFixed(4), maxms: +mx.med.toFixed(3), n: N, reps: REPS })
}
fresh('K ts', () => scenarioK(tsKernel()))
fresh('K wasm, shared instance', () => scenarioK(kW))
fresh('K wasm, fresh instance', () => scenarioK(wasmKernel(kMod)))
fresh('raft ts-port', () => scenarioRaft(raftTs()))
fresh('raft-rs wasm, fresh instance', () => scenarioRaft(raftWasm(rMod, true)))
const shared = raftWasm(rMod, false)
fresh('raft-rs wasm, shared instance', () => scenarioRaft(shared))

// ---- replay: the crossing's price, no driver
{
  const trace = readFileSync(tracePath)
  const parse = () => {
    const ops: { k: number; a: number; b: number; ev: Uint8Array }[] = []
    const r = new R(trace)
    while (r.more()) {
      const k = r.u8()
      if (k === 0) { const id = r.varint(), n = r.varint(), l = r.varint(); ops.push({ k, a: id, b: n, ev: trace.subarray(r.pos, r.pos + l) }); r.pos += l }
      else if (k === 1) { const s = r.varint(), l = r.varint(); ops.push({ k, a: s, b: 0, ev: trace.subarray(r.pos, r.pos + l) }); r.pos += l }
      else { ops.push({ k, a: r.varint(), b: 0, ev: new Uint8Array(0) }) }
    }
    return ops
  }
  const ops = parse()
  const steps = ops.filter((o) => o.k === 1).length
  const replayVia = (K: any) => { K.reset?.(); const hs: number[] = []; for (const o of ops) { if (o.k === 0) hs.push(K.create(o.a, o.b, o.ev)); else if (o.k === 1) K.step(hs[o.a], o.ev); else K.destroy(hs[o.a]) } }
  const time = (name: string, fn: () => void) => {
    fn()
    const xs = Array.from({ length: REPS }, () => { gc(); const t0 = now(); fn(); return Number(now() - t0) / steps })
    const st = stats(xs)
    out({ measure: 'replay', kernel: name, ns: r2(st.med), min: r2(st.min), max: r2(st.max), events: steps, reps: REPS })
  }
  time('K ts, per event', () => replayVia(tsKernel()))
  time('K wasm, one call per event', () => replayVia(kW))
  const ex: any = new WebAssembly.Instance(kMod, {}).exports
  const p = ex.k_in(trace.length); new Uint8Array(ex.memory.buffer).set(trace, p)
  time('K wasm, whole trace in one call', () => { if (ex.k_replay(trace.length) !== steps) throw new Error('replay count') })
}

// ---- wasm setup costs
{
  const time = (name: string, fn: () => void, n: number) => {
    fn()
    const xs = Array.from({ length: REPS }, () => { const t0 = now(); for (let i = 0; i < n; i++) fn(); return Number(now() - t0) / n / 1e3 })
    const st = stats(xs)
    out({ measure: 'wasm-setup', what: name, us: r2(st.med), min: r2(st.min), max: r2(st.max), reps: REPS })
  }
  const kb = readFileSync(kPath), rb = readFileSync(rPath)
  out({ measure: 'wasm-size', k: kb.length, raft: rb.length })
  time('compile K module', () => new WebAssembly.Module(kb), 20)
  time('compile raft-rs module', () => new WebAssembly.Module(rb), 5)
  time('instantiate K', () => new WebAssembly.Instance(kMod, {}), 200)
  time('instantiate raft-rs', () => new WebAssembly.Instance(rMod, {}), 200)
}
