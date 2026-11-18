// A check of PATHS PA-31: what one path step costs through fero v4's lens and through data's own handle.
//   TREE=<E-50 scratch tree> node --expose-gc path-step.mjs <rows>
// Ways (n rows, E-05's small row; each way reads field `n`):
//   lens.k.spread   L[k][VALUE].n, k spread over the rows (E-50's lens.k)
//   lens.k.same     the same, one key read again and again (data's child cache warm)
//   lens.k.n        L[k].n[VALUE]: two steps through the lens
//   handle.k.spread p.get(k)[VALUE].n, spread (E-50's handle.k)
//   handle.k.same   p.get(k)[VALUE].n, one key
//   handle.k.n      p.get(k).get('n')[VALUE]: two steps through data's handle
//   map.get         a plain Map of the same rows: the floor
// Then the memory data keeps per distinct key read through its handle (its child cache, api/index.ts:592-602).
import { pathToFileURL } from 'node:url'
const TREE = process.env.TREE
const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href)
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const VALUE = Symbol.for('data.v4.value')
const N = +process.argv[2]
const row = (i) => ({ name: 'user-' + i, email: 'u' + i + '.example.com', region: 'r' + (i % 16), room: i % 100, n: i, active: (i & 1) === 0, tags: ['a', 'b'] })
const key = (i) => 'k' + i
const keys = Array.from({ length: N }, (_, i) => key(i))
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
const now = () => process.hrtime.bigint()
const nsPer = (fn, m, rounds = 5) => { const r = []; for (let k = 0; k < rounds; k++) { gc(); const t0 = now(); fn(m); r.push(Number(now() - t0) / m) } r.sort((a, b) => a - b); return +r[r.length >> 1].toFixed(1) }
const fill = (p) => {
  const lane = D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
  for (let i = 0; i < N; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: 1, key: [], at: keys[j], value: row(j) })
    const rv = new C.Frame(C.encodeFrame(recs)).records(); const out = new Array(rv.length); for (let x = 0; x < rv.length; x++) out[x] = rv[x].rec()
    lane(out)
  }
}
const p = S.proxy({}); fill(p)
const L = S.lens(p, [], () => { throw new Error('read only') })
const m = new Map(); for (let i = 0; i < N; i++) m.set(keys[i], p.get(keys[i])[VALUE])
const idx = (j) => keys[(j * 7919) % N]
let sink = 0
const k0 = keys[N >> 1]
const ns = {
  'lens.k.spread': nsPer((c) => { for (let j = 0; j < c; j++) sink += L[idx(j)][VALUE].n }, 200000),
  'lens.k.same': nsPer((c) => { for (let j = 0; j < c; j++) sink += L[k0][VALUE].n }, 200000),
  'lens.k.n': nsPer((c) => { for (let j = 0; j < c; j++) sink += L[k0].n[VALUE] }, 200000),
  'handle.k.spread': nsPer((c) => { for (let j = 0; j < c; j++) sink += p.get(idx(j))[VALUE].n }, 200000),
  'handle.k.same': nsPer((c) => { for (let j = 0; j < c; j++) sink += p.get(k0)[VALUE].n }, 200000),
  'handle.k.n': nsPer((c) => { for (let j = 0; j < c; j++) sink += p.get(k0).get('n')[VALUE] }, 200000),
  'map.get.spread': nsPer((c) => { for (let j = 0; j < c; j++) sink += m.get(idx(j)).n }, 2000000),
  'idx.only': nsPer((c) => { for (let j = 0; j < c; j++) sink += idx(j).length }, 2000000),
}
// (memory: see mem-step2.mjs)




console.log(JSON.stringify({ bench: 'path-step', node: process.version, rows: N, ns, sink: sink > 0 }))
