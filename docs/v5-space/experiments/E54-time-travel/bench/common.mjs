// E-54 shared helpers: the row and key of E-05/E-06, the log (a seeded tape of change records), data's fold
// meaning on a plain Map, timing, GC watching (E-07's method) and the freed-bytes count (v8.GCProfiler).
import v8 from 'node:v8'
import { performance, PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks'

export const UPDATE = 0, INSERT = 1, REMOVE = 2 // fero kernel/env.ts REC, data seam HOT

// E-05's small row (~100 B as JSON), as E-06 uses it
export const row = (i, s) => ({ name: 'user-' + i, email: 'u' + i + '.example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] })
export const key = (i) => 'k' + i

export const rng = (seed) => () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed }

// The log: T change records in fero's record shape ({ type, key: [rowKey, ...fieldPath], value }), one per
// version (version v = the state after the first v records). Mix: 45% field writes (`n` of one live row),
// 45% whole-row writes, 5% new rows, 5% removes of a live row. The row count stays about n.
// HOT (env, default 0): that share of records are field writes to one extra row, 'hot', that is never removed
// (a row written very often, such as a counter). Unset, the tape is exactly the one above.
export const HOT = +(process.env.HOT ?? 0)
export const tape = (n, T, seed = 54) => {
  const r = rng(seed)
  const live = new Int32Array(n + T)
  for (let i = 0; i < n; i++) live[i] = i
  let nl = n, next = n, s = 1
  const recs = new Array(T)
  for (let i = 0; i < T; i++) {
    if (HOT > 0 && r() % 1000 < HOT * 1000) { recs[i] = { type: UPDATE, key: ['hot', 'n'], value: ++s }; continue }
    const m = r() % 100
    if (m < 45) recs[i] = { type: UPDATE, key: [key(live[r() % nl]), 'n'], value: ++s }
    else if (m < 90) { const j = live[r() % nl]; recs[i] = { type: UPDATE, key: [key(j)], value: row(j, ++s) } }
    else if (m < 95) { const j = next++; live[nl++] = j; recs[i] = { type: INSERT, key: [key(j)], value: row(j, ++s) } }
    else { const x = r() % nl, j = live[x]; live[x] = live[--nl]; recs[i] = { type: REMOVE, key: [key(j)] } }
  }
  return { recs, keysEver: next }
}

// the initial rows (the snapshot a history starts from: the compacted start)
export const initMap = (n) => { const m = new Map(); for (let i = 0; i < n; i++) m.set(key(i), row(i, 0)); if (HOT > 0) m.set('hot', row(-1, 0)); return m }

// data's fold meaning on a Map: a whole-row write or insert sets the row, a remove deletes it, a field write
// path-copies the row (data's pathCopy: a shallow copy with the field set; the old row is never mutated)
export const pathCopy = (old, f, v) => { const c = { ...old }; c[f] = v; return c }
export const applyMap = (m, x) => {
  const k = x.key[0]
  if (x.type === REMOVE) m.delete(k)
  else if (x.key.length === 1) m.set(k, x.value)
  else m.set(k, pathCopy(m.get(k), x.key[1], x.value))
}

export const gc = () => { if (global.gc) { global.gc(); global.gc() } }
export const heapUsed = () => process.memoryUsage().heapUsed
export const now = () => process.hrtime.bigint()
export const ns = (t0) => Number(process.hrtime.bigint() - t0)
export const out = (o) => console.log(JSON.stringify(o))
export const mb = (b) => +(b / 2 ** 20).toFixed(1)
export const q = (xs, f) => { if (!xs.length) return null; const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(f * s.length))] }
export const sumUp = (xs) => xs.length ? { n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), max: q(xs, 1) } : { n: 0 }

// run fn(i) until n samples or the budget (ms) is spent (at least `min` samples); each sample's ns
export const sample = (n, budgetMs, fn, min = 3) => {
  const xs = []
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    const a = now(); fn(i); xs.push(ns(a))
    if (xs.length >= min && performance.now() - t0 > budgetMs) break
  }
  return xs
}

// GC pauses as perf_hooks reports them (E-07): entries sorted into phases by their own start time
export const gcWatch = () => {
  const KIND = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb' }
  const w = { marks: [['setup', 0]], list: [] }
  const push = (e) => w.list.push({ start: e.startTime, ms: e.duration, kind: KIND[e.detail?.kind] ?? String(e.detail?.kind) })
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) push(e) })
  obs.observe({ entryTypes: ['gc'] })
  w.mark = (name) => w.marks.push([name, performance.now()])
  w.phaseOf = (t) => { let ph = w.marks[0][0]; for (const [nm, at] of w.marks) if (t >= at) ph = nm; return ph }
  w.flush = () => { for (const e of obs.takeRecords?.() ?? []) push(e) }
  w.stop = () => { w.flush(); obs.disconnect() }
  return w
}
const st = (xs) => {
  if (!xs.length) return { n: 0, max: 0, p99: 0, sum: 0 }
  const s = [...xs].sort((a, b) => a - b)
  return { n: s.length, max: +s[s.length - 1].toFixed(2), p99: +s[Math.min(s.length - 1, Math.floor(0.99 * s.length))].toFixed(2), sum: +s.reduce((a, b) => a + b, 0).toFixed(1) }
}
export const gcSummary = (w, phase) => {
  const xs = w.list.filter((e) => w.phaseOf(e.start) === phase)
  const by = (k) => st(xs.filter((e) => e.kind === k).map((e) => e.ms))
  return { all: st(xs.map((e) => e.ms)), major: by('major'), minor: by('minor'), incremental: by('incremental') }
}
export const eld = () => { const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); return h }
export const eldSummary = (h) => ({ p50: +(h.percentile(50) / 1e6).toFixed(2), p99: +(h.percentile(99) / 1e6).toFixed(2), p999: +(h.percentile(99.9) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) })

// bytes freed by every GC between start() and stop() (v8.GCProfiler: used heap before minus after, per GC).
// Garbage made in a phase = freed in it, when the phase starts and ends with a full collection.
export const freedWatch = () => {
  const p = new v8.GCProfiler()
  p.start()
  return () => { const r = p.stop(); let f = 0; for (const s of r.statistics) f += s.beforeGC.heapStatistics.usedHeapSize - s.afterGC.heapStatistics.usedHeapSize; return f }
}
