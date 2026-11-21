// E-64 O4: shared helpers for the sharded view (repartition by output key). Nothing here imports data.
// Reused from E-57 group B (read only): the seeded source, canonical printing, the numeric projection, typed
// bucket keys, the total order and the exact sum (WideSum). They were checked there (XB-2 to XB-5).
//   slotHash     a row key's slot (FNV-1a and a finaliser), with the slot count set by the caller
//   shardOf      an OUTPUT key's shard: the bucket a row falls in, hashed over K view shards
//   proj         what a routed change carries: only the fields the view reads
//   Bucket       what a shard keeps per bucket: a count, an exact sum, and the bucket's scores in order, so that
//                max and a top 3 stay exact when the best row leaves (the shard holds every row of its buckets)
//   pureView     the same view worked out from scratch over a list of rows, written apart from Bucket
import { rng, canon, num, bkey, WideSum, cmpVal, cmpStr } from '../../../E57-transforms/b-merge/src/lib.mjs'
export { rng, canon, num, bkey, WideSum, cmpVal, cmpStr }

export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
export const slotHash = (key, slots) => hash32(key) % slots
// bkey gives typed bucket keys (C10) as text ('n1' for the number 1, 's1' for the string '1'), so they hash apart
export const shardOf = (b, K) => hash32('o4|' + b) % K

// ── the view: per bucket of `user`, the row count, the exact sum of `cents` (C3, C9), the largest `score`
//    (numbers only, C9) and the top 3 keys by score (za's total order, ties by key: C1, C2) ─────────────────
export const proj = (row) => (row === undefined ? undefined : { u: row.user, c: row.cents, s: row.score })
export const outKey = (p) => (p === undefined ? undefined : bkey(p.u))
const cmpEnt = (a, b) => cmpVal('za', a[0], b[0]) || cmpStr(a[1], b[1]) // [score, key], best first

export class Bucket {
  constructor() { this.n = 0; this.ws = new WideSum(); this.ord = [] } // ord: [score, key] for numeric scores, best first
  add(k, p, sgn) {
    this.n += sgn
    const c = num(p.c)
    if (c !== undefined) { if (sgn > 0) this.ws.add(c); else this.ws.sub(c) }
    const s = num(p.s)
    if (s === undefined) return
    const e = [s, k]
    let lo = 0, hi = this.ord.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmpEnt(this.ord[m], e) < 0) lo = m + 1; else hi = m }
    if (sgn > 0) this.ord.splice(lo, 0, e)
    else if (lo < this.ord.length && this.ord[lo][1] === k) this.ord.splice(lo, 1)
    else throw new Error('O4: a score left that was never there: ' + k)
  }
  value() { return { count: this.n, sum: canon(this.ws.value()), max: this.ord.length ? this.ord[0][0] : null, top3: this.ord.slice(0, 3).map((e) => e[1]).join(',') } }
}
// the cheaper view for the timed runs: count and exact sum per bucket only (E-64 O2's view), no order kept
export class SumBucket {
  constructor() { this.n = 0; this.ws = new WideSum() }
  add(k, p, sgn) { this.n += sgn; const c = num(p.c); if (c !== undefined) { if (sgn > 0) this.ws.add(c); else this.ws.sub(c) } }
}
export function pureView(rows) { // rows: [[key, proj]] -> Map(bucket -> value), from scratch
  const m = new Map()
  for (const [k, p] of rows) {
    const b = outKey(p)
    if (b === undefined) continue
    let a = m.get(b)
    if (!a) { a = { n: 0, ws: new WideSum(), ents: [] }; m.set(b, a) }
    a.n++
    const c = num(p.c); if (c !== undefined) a.ws.add(c)
    const s = num(p.s); if (s !== undefined) a.ents.push([s, k])
  }
  const out = new Map()
  for (const [b, a] of m) {
    a.ents.sort(cmpEnt)
    out.set(b, { count: a.n, sum: canon(a.ws.value()), max: a.ents.length ? a.ents[0][0] : null, top3: a.ents.slice(0, 3).map((e) => e[1]).join(',') })
  }
  return out
}
export const sameValue = (x, y) => x.count === y.count && x.sum === y.sum && Object.is(x.max, y.max) && x.top3 === y.top3

// ── rows (as E-64 O2's, so the two options run the same mix): a bucket field `user` (typed strings, and in the
//    dirty domain the numbers 1, 2, 3 beside the strings '1', '2', '3'), `cents`, `score`, `paid` ───────────
export function genUser(dom, r, buckets) {
  if (dom === 'dirty' && r() < 0.1) { const n = 1 + Math.floor(r() * 3); return r() < 0.5 ? n : String(n) }
  if (dom === 'dirty' && r() < 0.02) return undefined // no bucket: the row is in no shard
  return 'u' + Math.floor(r() * buckets)
}
export function genCents(dom, r) {
  if (dom === 'int') return Math.floor(r() * 10000)
  const u = r()
  if (dom === 'float') return u < 0.5 ? Math.round(r() * 1e4) / 100 : u < 0.8 ? r() * 1e6 : r() * 1e-6
  if (u < 0.6) return Math.floor(r() * 10000)
  if (u < 0.85) return Math.round(r() * 1e4) / 100
  if (u < 0.9) return null
  if (u < 0.93) return 'x'
  if (u < 0.95) return String(Math.floor(r() * 100))
  if (u < 0.97) return -0
  if (u < 0.98) return NaN
  if (u < 0.99) return Infinity
  return -Infinity
}
export function genScore(dom, r) {
  if (dom === 'int' || dom === 'float') return Math.floor(r() * 1000)
  const u = r()
  if (u < 0.9) return Math.floor(r() * 1000)
  if (u < 0.95) return Math.round(r() * 1e5) / 100
  if (u < 0.97) return 'x'
  return null
}
export function makeRow(dom, r, buckets) {
  const row = { cents: genCents(dom, r), score: genScore(dom, r), paid: r() < 0.5 }
  const u = genUser(dom, r, buckets)
  if (u !== undefined) row.user = u
  return row
}
export const keyName = (i) => (i % 97 === 5 ? 'k\u{1F600}' + i : 'k' + i)
export const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
