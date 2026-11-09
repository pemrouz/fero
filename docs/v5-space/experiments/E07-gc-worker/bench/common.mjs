// E-07 shared helpers: fero's seam and codec from the scratch tree (tree.sh), the two row shapes, GC and
// event-loop-delay watchers. Borrowed from E-05 and E-34 so the rows look exactly like theirs.
import { pathToFileURL } from 'node:url'
import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks'

export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the scratch tree built by tree.sh')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href)
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
export const UPDATE = 0, INSERT = 1, REMOVE = 2

// small: E-05's ~100 B row (125 B in fero's codec). big: the same plus a 1,890-character text field, about
// 2 KB a row (DEP-13's "2 KB a row"). Rows reach data through encode + decode, so every string is a flat
// decoded string owned by its row, as on a real replica (a sliced constant would share one backing store).
const BODY = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(25).slice(0, 1890)
export const row = (shape, i, s) => {
  const r = { name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] }
  if (shape === 'big') r.body = BODY + String(s % 1e9).padStart(10, '0')
  return r
}
export const key = (i) => 'k' + i
export const laneFor = (p) => D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }

// GC pauses as perf_hooks reports them (entry.duration, ms, this thread). Entries are sorted into phases by
// their own startTime: w.mark(name) starts a phase; a GC belongs to the last phase begun before it started.
export const gcWatch = () => {
  const KIND = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb' } // perf_hooks.constants NODE_PERFORMANCE_GC_*
  const w = { marks: [['load', 0]], list: [] }
  const push = (e) => w.list.push({ start: e.startTime, ms: e.duration, kind: KIND[e.detail?.kind] ?? String(e.detail?.kind) })
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) push(e) })
  obs.observe({ entryTypes: ['gc'] })
  w.mark = (name) => w.marks.push([name, performance.now()])
  w.phaseOf = (t) => { let ph = w.marks[0][0]; for (const [n, at] of w.marks) if (t >= at) ph = n; return ph }
  w.stop = () => { for (const e of obs.takeRecords?.() ?? []) push(e); obs.disconnect() }
  return w
}
export const stats = (xs) => {
  if (xs.length === 0) return { n: 0, max: 0, p99: 0, p999: 0, sum: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  return { n: s.length, p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2), p999: +q(0.999).toFixed(2), max: +s[s.length - 1].toFixed(2), sum: +s.reduce((a, b) => a + b, 0).toFixed(0) }
}
export const gcSummary = (w, phase) => {
  const xs = w.list.filter((e) => w.phaseOf(e.start) === phase)
  const by = (k) => stats(xs.filter((e) => e.kind === k).map((e) => e.ms))
  return { all: stats(xs.map((e) => e.ms)), major: by('major'), minor: by('minor'), incremental: by('incremental') }
}
export const eld = () => { const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); return h }
export const eldSummary = (h) => ({ p50: +(h.percentile(50) / 1e6).toFixed(2), p99: +(h.percentile(99) / 1e6).toFixed(2), p999: +(h.percentile(99.9) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) })
export const mb = (b) => Math.round(b / 2 ** 20)
export const out = (o) => console.log(JSON.stringify(o))
