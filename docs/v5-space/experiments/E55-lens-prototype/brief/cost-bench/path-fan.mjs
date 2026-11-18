// K path subscriptions on ONE source, each on a different row. data today: each subscribes the root and checks every row delta
// (data api/index.ts:186-191). Against one sink plus a Map from row key to callbacks (a keyed router).
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const N = 10000, W = 50000
const mk = () => { const o = {}; for (let i = 0; i < N; i++) o['k' + i] = { name: 'user-' + i, n: i }; return o }
const gc = () => { globalThis.gc(); globalThis.gc() }
const run = (K, mode) => {
  const s = D.$(mk()); s.promote(); let c = 0
  if (mode === 'path') for (let i = 0; i < K; i++) s.get('k' + i).connect({}, () => c++, { clone: false, initial: false })
  if (mode === 'router') {
    const m = new Map(); for (let i = 0; i < K; i++) m.set('k' + i, [() => c++])
    s.sink({ apply(b) { for (const d of b.rows) { const fs = m.get(d.key); if (fs) for (const f of fs) f(d) } } })
  }
  const r = []
  for (let round = 0; round < 5; round++) {
    gc(); const t0 = process.hrtime.bigint()
    for (let i = 0; i < W; i++) s.get('k' + (i % N)).get('n').update(round * W + i)
    r.push(Number(process.hrtime.bigint() - t0) / W)
  }
  r.sort((a, b) => a - b); return +r[2].toFixed(0)
}
const out = {}
for (const K of [0, 10, 100, 1000, 10000]) out[K] = { path: run(K, 'path'), router: run(K, 'router') }
console.log(JSON.stringify({ bench: 'path-fan', node: process.version, rows: N, writes: W, nsPerWrite: out }))
