// Critic probe 3 (timed): what one za('points', 10) view costs data per write, by the kind of write and the batch.
// Rows { points, other }. Modes: sort-field writes one commit each; other-field writes one commit each; sort-field
// writes in batches of 256 (one data commit per batch, as v5's fold of a Raft batch would). Each mode minus the same
// writes with no view = the view's cost. Also: the time to build the view on N rows (a served view's first build,
// a get() with no live entry, a failover rebuild). Median of 3 reps per cell. Data at 63fea66, read only.
//   node --expose-gc --experimental-strip-types ordcost.mjs <N>
import { pathToFileURL, fileURLToPath } from 'node:url'
const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url)) // data's checkout at 63fea66, read only
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const KN = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
const N = +process.argv[2]
const gc = () => { globalThis.gc?.(); globalThis.gc?.() }
const now = () => process.hrtime.bigint()
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
const seed = () => { const r = rng(N * 7 + 1); const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { points: r() % 1000000, other: r() % 1000 }; return o }
const build = () => { const rt = new D.Runtime(); const s = new KN.SourceNode(rt, seed()); s.promote(); return { rt, s } }
const W1 = 2000, B = 256, NB = 40
function run(mode, view, rep) {
  const { rt, s } = build()
  let h = null, buildMs = null
  if (view) { gc(); const t0 = now(); h = D.handleFor(s).za('points', 10); h[D.value]; buildMs = Number(now() - t0) / 1e6 }
  const r = rng(N + rep * 31 + 7)
  const field = mode === 'other' ? 'other' : 'points'
  const W = mode === 'b256' ? B * NB : W1
  const ks = Array.from({ length: W }, () => 'k' + (r() % N)), vs = Array.from({ length: W }, () => r() % 1000000)
  gc()
  const t0 = now()
  if (mode === 'b256') { for (let b = 0; b < NB; b++) rt.batch(() => { for (let i = b * B; i < (b + 1) * B; i++) s.write(ks[i], [field], vs[i]) }) }
  else for (let i = 0; i < W; i++) s.write(ks[i], [field], vs[i])
  const ns = Number(now() - t0) / W
  return { ns, buildMs, top: h ? JSON.stringify(h[D.value][0]) : null }
}
const out = { probe: 'critic-ordcost', node: process.version, rows: N, nsPerWrite: {}, viewNsPerWrite: {}, buildMs: null }
const builds = []
for (const mode of ['sort', 'other', 'b256']) {
  const base = [], withv = []
  for (let rep = 0; rep < 3; rep++) { base.push(run(mode, false, rep).ns); const x = run(mode, true, rep); withv.push(x.ns); builds.push(x.buildMs) }
  out.nsPerWrite[mode] = { none: Math.round(med(base)), za10: Math.round(med(withv)) }
  out.viewNsPerWrite[mode] = Math.round(med(withv) - med(base))
}
out.buildMs = Math.round(med(builds) * 10) / 10
out.heapMB = Math.round(process.memoryUsage().heapUsed / 1e6)
console.log(JSON.stringify(out))
