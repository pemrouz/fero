// What a tap costs per committed change, by its argument (data ops/misc.ts:613-633): a bare fn, a fn with a parameter
// (a v2-shaped record, structuredClone'd), a native sink (the CommitBatch by reference), connect(anchor, fn, {clone:false}).
//   node --expose-gc tap-cost.mjs  (TREE = the E-50 scratch tree)
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const N = 10000, W = 200000
const mk = () => { const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { name: 'user-' + i, region: 'r' + (i % 16), n: i, tags: ['a', 'b'] }; return o }
const gc = () => { globalThis.gc(); globalThis.gc() }
const run = (attach) => {
  const s = D.$(mk()); s.promote(); let c = 0
  const h = attach(s, () => c++)
  const r = []
  for (let round = 0; round < 5; round++) {
    gc(); const t0 = process.hrtime.bigint()
    for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(round * W + i)
    r.push(Number(process.hrtime.bigint() - t0) / W)
  }
  r.sort((a, b) => a - b); return { nsPerWrite: +r[2].toFixed(0), calls: c }
}
const out = {
  none: run(() => null),
  'tap(() => …)': run((s, f) => s.tap(() => f())),
  'tap((rec) => …)': run((s, f) => s.tap((rec) => f(rec))),
  'sink({ apply })': run((s, f) => s.sink({ apply: (b) => f(b) })),
  'connect(anchor, fn)': run((s, f) => s.connect({}, (r) => f(r))),
  'connect(anchor, fn, {clone:false})': run((s, f) => s.connect({}, (r) => f(r), { clone: false })),
}
console.log(JSON.stringify({ bench: 'tap-cost', node: process.version, rows: N, writes: W, out }))
