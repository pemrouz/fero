// E-64 O2: shared helpers. Nothing here imports data.
// Reused from E-57 group B (read only): the seeded source, canonical printing, the numeric projection, typed
// bucket keys, the total order and the exact sum (WideSum). They were checked there (XB-2 to XB-5).
//   slotOf       a slot hash with a slot count set by the caller (LAYERS has 4,096)
//   Acc          what a derived bucket keeps: an exact sum and a row count. It is a commutative group: deltas
//                add and subtract exactly, so deltas from many shares can land in any order
//   proj         the "before" and "after" a change must carry: only the fields the views read
//   tup, cmpTup  the top-k order: score by za's total order, ties by key (C1, C2)
import { rng, canon, num, bkey, WideSum, cmpVal, cmpStr, toUnits } from '../../../E57-transforms/b-merge/src/lib.mjs'
export { rng, canon, num, bkey, WideSum, cmpVal, cmpStr }

export function slotHash(key, slots) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return (h >>> 0) % slots
}

// ── the accumulator: exact sum (C3) of the numeric projection (C9) of one field, and a row count ──────────
// plain = true is the planted bug: a float running sum, as data's sum and fero's op.incr give today.
export class Acc {
  constructor(plain = false) { this.plain = plain; this.ws = plain ? null : new WideSum(); this.f = 0; this.rows = 0 }
  addRow(v, s) { // s = +1 adds a row with value v, -1 takes it away
    this.rows += s
    const x = num(v)
    if (x === undefined) return
    if (this.plain) { this.f += s * x; return }
    if (s > 0) this.ws.add(x); else this.ws.sub(x)
  }
  merge(d) { // this += d, exactly (both exact) or as floats (both plain)
    this.rows += d.rows
    if (this.plain) { this.f += d.f; return }
    const a = this.ws, b = d.ws
    a.nan += b.nan; a.pinf += b.pinf; a.ninf += b.ninf; a.nf += b.nf; a.nz += b.nz; a.n += b.n
    if (b.big !== null || a.big !== null) {
      let t = a.big ?? 0n
      if (a.big === null) for (const y of a.p) t += toUnits(y)
      if (b.big !== null) t += b.big; else for (const y of b.p) t += toUnits(y)
      a.p = []; a.big = t; a.bigAdd(0n) // back to partials when small
      return
    }
    for (const y of b.p) if (y !== 0) a.grow(y)
  }
  empty() { return this.rows === 0 }
  sum() { return this.plain ? this.f : this.ws.value() }
  value() { return { count: this.rows, sum: this.sum() } }
}

// the pure query, written apart from the runner: count and exact sum per typed bucket over a list of rows
export function pureSumBy(rows, field, valField, keep) {
  const m = new Map()
  for (const row of rows) {
    const b = bkey(row[field])
    if (b === undefined || (keep && !keep(b))) continue
    let a = m.get(b)
    if (!a) { a = { n: 0, ws: new WideSum() }; m.set(b, a) }
    a.n++
    const x = num(row[valField])
    if (x !== undefined) a.ws.add(x)
  }
  const out = new Map()
  for (const [b, a] of m) out.set(b, { count: a.n, sum: a.ws.value() })
  return out
}
export const sameBucket = (x, y) => x.count === y.count && canon(x.sum) === canon(y.sum)

// ── the projection a change carries: the fields the views read, before and after ─────────────────────────
export const FIELDS = ['user', 'cents', 'score']
export function proj(row) {
  if (row === undefined) return undefined
  return { u: row.user, c: row.cents, s: row.score }
}

// ── the top-k order (za over `score`, ties by key) ───────────────────────────────────────────────────────
export const tup = (k, s) => ({ k, s })
export const cmpTup = (a, b) => cmpVal('za', a.s, b.s) || cmpStr(a.k, b.k)
export function pureTopK(entries, k) { // entries: [[key, score]]
  const ts = entries.map(([key, s]) => tup(key, s))
  ts.sort(cmpTup)
  return ts.slice(0, k).map((t) => t.k)
}

// ── rows: a bucket field `user` (typed: strings, and numbers in the dirty domain), `cents`, `score`, `paid` ──
export function genUser(dom, r, buckets) {
  if (dom === 'dirty' && r() < 0.1) { const n = 1 + Math.floor(r() * 3); return r() < 0.5 ? n : String(n) } // 1 and '1': two buckets
  if (dom === 'dirty' && r() < 0.02) return undefined // no bucket
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
