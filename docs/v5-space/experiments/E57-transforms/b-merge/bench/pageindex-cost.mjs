// A page reader's shared index, per write (added after the skeptic's review, finding F1). `{ pages }` keeps one
// ordered index of EVERY row, with no window, and keeps it up on every write while it lives. Two such indexes, set
// beside the same writes with no view: data's own `za('points')` with no window (today's form; at 1e4 and 1e5 only,
// since it moves memory on every write), and D8c's chunked index (src/index.mjs) with no window (a WindowIndex of
// n = 0: the index fed by a row sink, no window to reconcile). Rows { points, other } as xb1-cost.mjs (the critic's
// probe); 2,000 sort-field writes, one commit each. A cell is the median of three repetitions, the ways interleaved,
// a full collection before each. Also the build: the view's first read.
//   node --expose-gc pageindex-cost.mjs <N>
import { D } from '../src/ops.mjs'
import { WindowIndex } from '../src/index.mjs'

const N = +process.argv[2]
const gc = () => { globalThis.gc?.(); globalThis.gc?.() }
const now = () => process.hrtime.bigint()
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
const seed = () => { const r = rng(N * 7 + 1); const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { points: r() % 1000000, other: r() % 1000 }; return o }
const build = () => { const rt = new D.Runtime(); const s = new D.SourceNode(rt, seed()); s.promote(); return { rt, s } }
const W = 2000
const WAYS = N >= 1e6 ? ['none', 'index'] : ['none', 'data', 'index']
function run(way, rep) {
  const { s } = build()
  let h = null, buildMs = null, check = null
  gc()
  if (way === 'data') { const t0 = now(); h = D.handleFor(s).za('points'); h[D.value]; buildMs = Number(now() - t0) / 1e6 }
  if (way === 'index') { const t0 = now(); h = new WindowIndex(D.handleFor(s), 'points', 'za', 0); buildMs = Number(now() - t0) / 1e6 }
  const r = rng(N + rep * 31 + 7)
  const ks = Array.from({ length: W }, () => 'k' + (r() % N)), vs = Array.from({ length: W }, () => r() % 1000000)
  gc()
  const t0 = now()
  for (let i = 0; i < W; i++) s.write(ks[i], [ 'points' ], vs[i])
  const ns = Number(now() - t0) / W
  if (way === 'index') { // the index's first ten equal data's own answer at the end (a spot check)
    const top = h.ix.first(10).map((e) => e.k)
    const want = D.handleFor(s).za('points', 10)[D.value]
    check = top.length === want.length && top.every((k, i) => s.rowAt(k).points === want[i].points)
    h.dispose()
  }
  return { ns, buildMs, check }
}
const out = { exp: 'E-57', part: 'b-merge', claim: 'XA-7', bench: 'pageindex-cost', node: process.version, rows: N, nsPerWrite: {}, viewNsPerWrite: {}, buildMs: {}, endCheck: true }
const xs = Object.fromEntries(WAYS.map((w) => [w, []])), builds = { data: [], index: [] }
for (let rep = 0; rep < 3; rep++) for (const w of WAYS) { const x = run(w, rep); xs[w].push(x.ns); if (x.buildMs !== null) builds[w].push(x.buildMs); if (x.check === false) out.endCheck = false }
out.nsPerWrite.sort = Object.fromEntries(WAYS.map((w) => [w, Math.round(med(xs[w]))]))
out.viewNsPerWrite.sort = Object.fromEntries(WAYS.filter((w) => w !== 'none').map((w) => [w, Math.round(med(xs[w]) - med(xs.none))]))
for (const w of WAYS) if (builds[w]?.length) out.buildMs[w] = Math.round(med(builds[w]) * 10) / 10
out.heapMB = Math.round(process.memoryUsage().heapUsed / 1e6)
console.log(JSON.stringify(out))
