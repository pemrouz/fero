// Claims 1, 2 and 3: what a lens step costs, what it keeps, and a write through the lens.
//   node --expose-gc --experimental-strip-types step.mjs <rows> <part: read | mem | write>
// read (claim 1): ns per read of field n, through the lens and directly, keys spread over the rows and one key
//   direct      f.eng.readSync([k, 'n'])      the call every lens verb turns into (no Proxy)
//   kept        kept[VALUE]                   a lens made once, its verb only
//   lens1       L[k][VALUE].n                 one step and the verb
//   lens2       L[k].n[VALUE]                 two steps and the verb
//   at2         f.at(k, 'n')[VALUE]           the same address with no Proxy
//   handle2     h.get(k).get('n')[value]      data's handle today (it caches every child for its parent's life)
//   map         m.get(k).n                    a plain Map: the floor
// mem (claim 2): bytes kept per distinct key after reading 100,000 keys one and two steps deep, a full GC between
// write (claim 3): ns per write of the same integer values: f.set([k,'n'], v), L[k].n.set(v), kept.set(v),
//   f.at(k,'n').set(v), and data's handle h.get(k).get('n').update(v)
import { fero, VALUE, D } from '../proto/lens.mjs'
import { seedRows, key, gc, heap, out, interleave, r1 } from './common.mjs'

const N = +process.argv[2], PART = process.argv[3]
const f = fero('f', { data: seedRows(N) })
f.eng.promote()
const L = f.data
const keys = Array.from({ length: N }, (_, i) => key(i))
const idx = (j) => keys[(j * 7919) % N]
let sink = 0

if (PART === 'read') {
  const m = new Map(); for (const k of keys) m.set(k, f.eng.src.get(k))
  const h = D.handleFor(f.eng.src)
  const k0 = keys[N >> 1]
  const kept = L[k0].n, keptRow = L[k0]
  const W = 200000
  const same = interleave({
    direct: (c) => { for (let j = 0; j < c; j++) sink += f.eng.readSync([k0, 'n']) },
    kept: (c) => { for (let j = 0; j < c; j++) sink += kept[VALUE] },
    keptRow: (c) => { for (let j = 0; j < c; j++) sink += keptRow[VALUE].n },
    lens1: (c) => { for (let j = 0; j < c; j++) sink += L[k0][VALUE].n },
    lens2: (c) => { for (let j = 0; j < c; j++) sink += L[k0].n[VALUE] },
    at2: (c) => { for (let j = 0; j < c; j++) sink += f.at(k0, 'n')[VALUE] },
    handle2: (c) => { for (let j = 0; j < c; j++) sink += h.get(k0).get('n')[D.value] },
    map: (c) => { for (let j = 0; j < c; j++) sink += m.get(k0).n },
  }, W)
  const spread = interleave({
    direct: (c) => { for (let j = 0; j < c; j++) sink += f.eng.readSync([idx(j), 'n']) },
    lens1: (c) => { for (let j = 0; j < c; j++) sink += L[idx(j)][VALUE].n },
    lens2: (c) => { for (let j = 0; j < c; j++) sink += L[idx(j)].n[VALUE] },
    at2: (c) => { for (let j = 0; j < c; j++) sink += f.at(idx(j), 'n')[VALUE] },
    handle2: (c) => { for (let j = 0; j < c; j++) sink += h.get(idx(j)).get('n')[D.value] },
    map: (c) => { for (let j = 0; j < c; j++) sink += m.get(idx(j)).n },
    idx: (c) => { for (let j = 0; j < c; j++) sink += idx(j).length },
  }, W)
  // derived: the lens's own share per step, the kept verb over the direct call, at() over the direct call
  const derived = {
    step_same: r1((same.lens2 - same.kept) / 2),
    step_same_1: r1(same.lens1 - same.keptRow),
    step_spread: r1((spread.lens2 - spread.direct - (same.kept - same.direct)) / 2),
    kept_over_direct: r1(same.kept - same.direct),
    at_over_direct_same: r1(same.at2 - same.direct),
    at_over_direct_spread: r1(spread.at2 - spread.direct),
  }
  out({ claim: 1, bench: 'step-read', rows: N, ops: W, same, spread, derived, sink: sink > 0 })
}

if (PART === 'mem') {
  // one way per process (argv[4]): one | two | kept | handle2. 100,000 distinct keys, a full GC before and after.
  const WAY = process.argv[4]
  const K = Math.min(N, 101000)
  const hh = D.handleFor(f.eng.src)
  for (let i = 0; i < 1000; i++) sink += L[keys[i]][VALUE].n + L[keys[i]].n[VALUE] + hh.get(keys[i]).get('n')[D.value] // warm
  let keep = null
  gc(); const h0 = heap()
  if (WAY === 'one') for (let i = 1000; i < K; i++) sink += L[keys[i]][VALUE].n
  if (WAY === 'two') for (let i = 1000; i < K; i++) sink += L[keys[i]].n[VALUE]
  if (WAY === 'kept') { keep = new Array(K - 1000); for (let i = 1000; i < K; i++) keep[i - 1000] = L[keys[i]].n } // the app keeps them: for scale
  if (WAY === 'handle2') for (let i = 1000; i < K; i++) sink += hh.get(keys[i]).get('n')[D.value] // data's handle today
  globalThis.__keep = [hh, keep, L, f] // everything the program still holds stays reachable across the second GC
  gc(); const h1 = heap()
  out({ claim: 2, bench: 'step-mem', rows: N, keys: K - 1000, way: WAY, bytesPerKey: r1((h1 - h0) / (K - 1000)), kept: keep?.length ?? 0, sink: sink > 0 })
}

if (PART === 'write') {
  const W = 200000
  const kept = keys.map((k) => L[k].n)
  const h = D.handleFor(f.eng.src)
  const ns = interleave({
    'f.set([k,n],v)': (c) => { for (let j = 0; j < c; j++) f.set([keys[j % N], 'n'], j) },
    'L[k].n.set(v)': (c) => { for (let j = 0; j < c; j++) L[keys[j % N]].n.set(j) },
    'kept.set(v)': (c) => { for (let j = 0; j < c; j++) kept[j % N].set(j) },
    'f.at(k,n).set(v)': (c) => { for (let j = 0; j < c; j++) f.at(keys[j % N], 'n').set(j) },
    'data h.get(k).get(n).update(v)': (c) => { for (let j = 0; j < c; j++) h.get(keys[j % N]).get('n').update(j) },
  }, W)
  const base = ns['f.set([k,n],v)']
  out({ claim: 3, bench: 'step-write', rows: N, writes: W, ns, over_direct: { steps: r1(ns['L[k].n.set(v)'] - base), kept: r1(ns['kept.set(v)'] - base), at: r1(ns['f.at(k,n).set(v)'] - base) } })
}
