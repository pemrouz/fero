// B1: what one local read of a held row costs, on a copy that folds n rows (fero v4's real read paths, through its seam).
//   node --expose-gc local-read.mjs <rows>
// Ways (each reads row k_i's `n` field, i spread over the rows):
//   snapshot.k   S.snapshot(p)[k].n   — what fero v4's `f.snapshot.k.n` runs (api/index.ts:1294-1296 → substrate.ts:97 →
//                data's readAt: store.snapshot() builds a Map of every row, materialize() builds an object of every row)
//   lens.k       lens(p).k[VALUE].n   — what `f.data.k` then its value runs (substrate.ts:309-405: a child handle and a
//                Proxy per step, then data's childRead → src.get(k))
//   handle.k     p.get(k)[VALUE].n    — data's own handle read, no fero lens
//   map.get      a plain Map of the same row objects: the floor any JS fold pays
//   snapshot     S.snapshot(p) alone (no index): the cost of one dense picture
import { S, D, fill, key, nsPer, out, gc } from './common.mjs'
const N = +process.argv[2]
const VALUE = Symbol.for('data.v4.value')
const p = S.proxy({})
fill(p, N)
const L = S.lens(p, [], () => { throw new Error('read only') })
const m = new Map(); for (let i = 0; i < N; i++) m.set(key(i), p.get(key(i))[VALUE])
gc()
const idx = (j) => key((j * 7919) % N)
let sink = 0
// how many calls per round: snapshot ways are O(rows), so fewer calls at large n
const big = Math.max(3, Math.floor(2e7 / N / 50))
const rows = {
  'snapshot.k': nsPer((c) => { for (let j = 0; j < c; j++) sink += S.snapshot(p)[idx(j)].n }, Math.min(big, 2000)),
  'lens.k': nsPer((c) => { for (let j = 0; j < c; j++) sink += L[idx(j)][VALUE].n }, 200000),
  'handle.k': nsPer((c) => { for (let j = 0; j < c; j++) sink += p.get(idx(j))[VALUE].n }, 200000),
  'map.get': nsPer((c) => { for (let j = 0; j < c; j++) sink += m.get(idx(j)).n }, 2000000),
  'snapshot': nsPer((c) => { for (let j = 0; j < c; j++) sink += S.snapshot(p) ? 1 : 0 }, Math.min(big, 2000)),
  'idx.only': nsPer((c) => { for (let j = 0; j < c; j++) sink += idx(j).length }, 2000000),
}
out({ bench: 'local-read', rows: N, ns: rows, sink: sink > 0 })
