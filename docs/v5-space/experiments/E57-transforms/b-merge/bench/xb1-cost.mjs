// XB-1, cost: what a leaderboard over every row costs per write with the O(log N) index (src/index.mjs), set
// beside the same writes with no view, and (at 1e4 and 1e5) data's own za('points', 10). The critic's probe
// (CRITIC 1.1, ordcost.mjs) re-run on the new index: rows { points, other }, seeded and promoted; 2,000
// sort-field writes one commit each; 2,000 other-field writes; 40 batches of 256 sort-field writes, one data
// commit each. The view's cost = the time with it minus the same writes with none. A cell is the median of three
// repetitions, the ways interleaved, a full collection before each. Also the build: the view's first read.
//   node --expose-gc xb1-cost.mjs <N>
import { D } from '../src/ops.mjs'
import { WindowIndex } from '../src/index.mjs'

const N = +process.argv[2]
const gc = () => { globalThis.gc?.(); globalThis.gc?.() }
const now = () => process.hrtime.bigint()
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
const seed = () => { const r = rng(N * 7 + 1); const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { points: r() % 1000000, other: r() % 1000 }; return o }
const build = () => { const rt = new D.Runtime(); const s = new D.SourceNode(rt, seed()); s.promote(); return { rt, s } }
const W1 = 2000, B = 256, NB = 40
const WAYS = N >= 1e6 ? ['none', 'index'] : ['none', 'data', 'index']
function run(mode, way, rep) {
  const { rt, s } = build()
  let h = null, buildMs = null, check = null
  gc()
  if (way === 'data') { const t0 = now(); h = D.handleFor(s).za('points', 10); h[D.value]; buildMs = Number(now() - t0) / 1e6 }
  if (way === 'index') { const t0 = now(); h = new WindowIndex(D.handleFor(s), 'points', 'za', 10); buildMs = Number(now() - t0) / 1e6 }
  const r = rng(N + rep * 31 + 7)
  const field = mode === 'other' ? 'other' : 'points'
  const W = mode === 'b256' ? B * NB : W1
  const ks = Array.from({ length: W }, () => 'k' + (r() % N)), vs = Array.from({ length: W }, () => r() % 1000000)
  gc()
  const t0 = now()
  if (mode === 'b256') { for (let b = 0; b < NB; b++) rt.batch(() => { for (let i = b * B; i < (b + 1) * B; i++) s.write(ks[i], [field], vs[i]) }) }
  else for (let i = 0; i < W; i++) s.write(ks[i], [field], vs[i])
  const ns = Number(now() - t0) / W
  if (way === 'index') { // the window equals data's own answer at the end (a spot check: one sort-free compare)
    const top = [...h.win]
    const z = D.handleFor(s).za('points', 10)
    const want = z[D.value]
    check = top.length === want.length && top.every((k, i) => s.rowAt(k).points === want[i].points)
    h.dispose()
  }
  return { ns, buildMs, check }
}
const out = { exp: 'E-57', part: 'b-merge', claim: 'XB-1', bench: 'leaderboard-cost', node: process.version, rows: N, nsPerWrite: {}, viewNsPerWrite: {}, buildMs: {}, endCheck: true }
const builds = { data: [], index: [] }
for (const mode of ['sort', 'other', 'b256']) {
  const xs = Object.fromEntries(WAYS.map((w) => [w, []]))
  for (let rep = 0; rep < 3; rep++) for (const w of WAYS) { const x = run(mode, w, rep); xs[w].push(x.ns); if (x.buildMs !== null) builds[w].push(x.buildMs); if (x.check === false) out.endCheck = false }
  out.nsPerWrite[mode] = Object.fromEntries(WAYS.map((w) => [w, Math.round(med(xs[w]))]))
  out.viewNsPerWrite[mode] = Object.fromEntries(WAYS.filter((w) => w !== 'none').map((w) => [w, Math.round(med(xs[w]) - med(xs.none))]))
}
for (const w of WAYS) if (builds[w]?.length) out.buildMs[w] = Math.round(med(builds[w]) * 10) / 10
out.heapMB = Math.round(process.memoryUsage().heapUsed / 1e6)
console.log(JSON.stringify(out))
