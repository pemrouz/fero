// Claim 23: `lens.asOf(position)` as a reader: fat nodes (per row, the versions at which it changed and the row
// each made) fed from data's real fold: each commit's RowDeltas, `row` and `prev` by reference.
//   node --expose-gc --experimental-strip-types asof.mjs <rows> <base|fat> [HOT=share of records to one row]
// The log is E-54's tape (bench/common.mjs there: 45% field writes, 45% row writes, 5% adds, 5% removes), 1,000,000
// records, one data commit each (version v = the state after v records).
//   base  data's fold alone: SourceNode.write/remove per record
//   fat   the same fold plus one data sink that keeps the versions (a row's first change also keeps `prev` as
//         its version-0 value; a row never changed reads from the live rows)
// Measured: ns per record, bytes kept per version (heap after minus before, full GCs), a step (the cursor moves
// one version), a row at a random version, the hot row at a random version, and every answer against a refold.
import { SourceNode, D } from '../proto/lens.mjs'
import { tape, initMap, applyMap, key, HOT as HOTSHARE } from '../../E54-time-travel/bench/common.mjs'
import { gc, heap, out, r1, r3, rng, med, now } from './common.mjs'

const N = +process.argv[2], MODE = process.argv[3]
const H = +(process.env.H ?? 1e6)
const { recs, keysEver } = tape(N, H)
const UPDATE = 0, INSERT = 1, REMOVE = 2
const rt = new D.Runtime()
const seed = Object.fromEntries(initMap(N))
const src = new SourceNode(rt, seed)
src.promote()
const TOMB = Symbol('removed')
class Fat { constructor() { this.vs = []; this.rs = [] } }
const fat = new Map()
let cur = 0 // the reader's cursor: a version number
const readAt = (v, k) => {
  const e = fat.get(k)
  if (e === undefined) return src.get(k) // never changed in the window: as it is now
  const vs = e.vs
  let lo = 0, hi = vs.length - 1, j = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (vs[mid] <= v) { j = mid; lo = mid + 1 } else hi = mid - 1 }
  if (j < 0) return undefined // added after v
  const r = e.rs[j]
  return r === TOMB ? undefined : r
}
const seq0 = rt.seq
if (MODE === 'fat') {
  src.connect({ wantsOrder: false, origin: null, apply(b) {
    const v = b.seq - seq0, rows = b.rows
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i]
      let e = fat.get(d.key)
      if (e === undefined) { e = new Fat(); if (d.op !== 'add') { e.vs.push(0); e.rs.push(d.prev) } fat.set(d.key, e) }
      e.vs.push(v); e.rs.push(d.op === 'remove' ? TOMB : d.row)
    }
  } })
}
const EMPTY = []
const fold = (x) => {
  const k = x.key[0]
  if (x.type === REMOVE) src.remove(k)
  else src.write(k, x.key.length === 1 ? EMPTY : x.key.slice(1), x.value)
}
gc(); const h0 = heap()
const t0 = now()
for (let i = 0; i < H; i++) fold(recs[i])
const nsPerRecord = r1(Number(now() - t0) / H)
gc(); const h1 = heap()
const res = { claim: 23, bench: 'asof', mode: MODE, rows: N, records: H, hot: HOTSHARE || undefined, nsPerRecord, keptBytesPerVersion: r1((h1 - h0) / H), commits: rt.seq - seq0 }
if (MODE === 'fat') {
  const V = H
  const r = rng(N + 23)
  // a step: the cursor moves one version (a number); timed as 1,000,000 steps back and forth
  let t = now(); for (let i = 0; i < 1e6; i++) cur += (i & 1) ? 1 : -1; res.stepNs = r3(Number(now() - t) / 1e6)
  // a row at a version: random rows ever made, random versions (targets drawn before the clock)
  const M = 100000
  const vs = Array.from({ length: M }, () => r() % (V + 1)), ks = Array.from({ length: M }, () => key(r() % keysEver))
  let sink = 0
  const xs = []
  for (let rep = 0; rep < 5; rep++) { t = now(); for (let i = 0; i < M; i++) if (readAt(vs[i], ks[i]) !== undefined) sink++; xs.push(Number(now() - t) / M) }
  res.rowAtVersionNs = r1(med(xs))
  if (HOTSHARE > 0) {
    const ys = []
    for (let rep = 0; rep < 5; rep++) { t = now(); for (let i = 0; i < M; i++) if (readAt(vs[i], 'hot') !== undefined) sink++; ys.push(Number(now() - t) / M) }
    res.hotRowVersions = fat.get('hot')?.vs.length ?? 0
    res.hotRowAtVersionNs = r1(med(ys))
  }
  // every answer against a refold from the start (a plain Map, data's fold rule)
  const cr = rng(99)
  const cvs = [0, V, ...Array.from({ length: 12 }, () => cr() % (V + 1))].sort((a, b) => a - b)
  const cks = Array.from({ length: 40 }, () => key(cr() % keysEver)); if (HOTSHARE > 0) cks[0] = 'hot'
  const m = initMap(N)
  let ci = 0, checked = 0, wrong = 0
  for (let v = 0; v <= V; v++) {
    while (ci < cvs.length && cvs[ci] === v) { for (const k of cks) { checked++; if (JSON.stringify(readAt(v, k)) !== JSON.stringify(m.get(k))) wrong++ } ci++ }
    if (v < V) applyMap(m, recs[v])
  }
  res.checks = { checked, wrong }
  res.sink = sink > 0
}
out(res)
