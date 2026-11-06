// E-23 shared helpers: a seeded random source, the slot hash, a canonical
// printer for comparisons, an exact (order-free) float sum, the row
// generator, and an independent fold of fero Recs (the "truth").
//
// Nothing here imports data. The truth fold and the pure queries are written
// from scratch so that a data bug cannot hide in both sides of a comparison.

// ── random ──────────────────────────────────────────────────────────────────
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── slots ───────────────────────────────────────────────────────────────────
// DESIGN-V5 §4.2: 1,024 fixed slots per resource; a partition hashes to one
// slot forever. The design names a 64-bit hash with an avalanche finaliser;
// a 32-bit FNV-1a plus murmur3's fmix32 is enough to spread keys here.
export const SLOTS = 1024
export function slotOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % SLOTS
}

// ── canonical printing ──────────────────────────────────────────────────────
// Sorted object keys; NaN, ±Infinity, -0, undefined and null all distinct.
// Used for "equal as values" checks. Byte-for-byte checks use JSON.stringify
// of data's own output instead (key order included).
export function canon(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'n'
  switch (typeof v) {
    case 'number':
      return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : String(v)
    case 'string':
      return JSON.stringify(v)
    case 'boolean':
      return v ? 'T' : 'F'
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
      const o = v as Record<string, unknown>
      const ks = Object.keys(o).sort()
      let s = '{'
      for (let i = 0; i < ks.length; i++) s += (i ? ',' : '') + JSON.stringify(ks[i]) + ':' + canon(o[ks[i]])
      return s + '}'
    }
  }
  return String(v)
}

// ── the exact sum ───────────────────────────────────────────────────────────
// Shewchuk's non-overlapping partials (the algorithm behind Python's
// math.fsum). Every add is exact (two-sum), so the partials always hold the
// EXACT real sum of the values currently in the set, whatever order they
// came and went in. value() rounds that exact sum once, to nearest-even. So
// the result is a function of the multiset of values alone: two groups'
// partials merge exactly, and a rebuilt view gives the same bits as a live
// one. NaN and the infinities are counted apart, so removing the one NaN row
// un-poisons the sum (data's running total cannot).
// Limit: values here stay far below 1e300, so no partial overflows; a real
// build needs Python's overflow branch too.
export class ExactSum {
  p: number[] = []
  nan = 0
  pinf = 0
  ninf = 0
  n = 0 // values tracked (NaN and infinities included)

  add(x: number): void {
    this.n++
    if (x !== x) { this.nan++; return }
    if (x === Infinity) { this.pinf++; return }
    if (x === -Infinity) { this.ninf++; return }
    this.grow(x)
  }
  sub(x: number): void {
    this.n--
    if (x !== x) { this.nan--; return }
    if (x === Infinity) { this.pinf--; return }
    if (x === -Infinity) { this.ninf--; return }
    this.grow(-x)
  }
  private grow(x: number): void {
    const p = this.p
    let i = 0
    for (let j = 0; j < p.length; j++) {
      let y = p[j]
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t }
      const hi = x + y
      const lo = y - (hi - x)
      if (lo !== 0) p[i++] = lo
      x = hi
    }
    p.length = i
    if (x !== 0 || i === 0) p.push(x)
  }
  mergeFrom(o: ExactSum): void {
    for (const y of o.p) if (y !== 0) this.grow(y)
    this.nan += o.nan
    this.pinf += o.pinf
    this.ninf += o.ninf
    this.n += o.n
  }
  value(): number {
    if (this.nan > 0 || (this.pinf > 0 && this.ninf > 0)) return NaN
    if (this.pinf > 0) return Infinity
    if (this.ninf > 0) return -Infinity
    return fsumRound(this.p)
  }
}

// Python's msum final rounding (Modules/mathmodule.c math_fsum, the tail).
function fsumRound(partials: number[]): number {
  let n = partials.length
  let hi = 0
  if (n > 0) {
    n--
    hi = partials[n]
    let lo = 0
    while (n > 0) {
      const x = hi
      n--
      const y = partials[n]
      hi = x + y
      const yr = hi - x
      lo = y - yr
      if (lo !== 0) break
    }
    if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
      const y = lo * 2
      const x = hi + y
      const yr = x - hi
      if (y === yr) hi = x
    }
  }
  return hi
}

// ── rows ────────────────────────────────────────────────────────────────────
export type Row = { id: string; points?: unknown; room?: unknown }
export type Domain = 'int' | 'float' | 'dirty'
export type Rec = { type: 0 | 1 | 2; key: (string | number)[]; value?: unknown; at?: string }

export function genPoints(d: Domain, r: () => number): unknown {
  if (d === 'int') return Math.floor(r() * 101) // 0..100: many ties, as real scores have
  if (d === 'float') {
    const u = r()
    if (u < 0.5) return Math.round(r() * 1e4) / 100 // two decimals: 0.1-style values, not exact in binary
    if (u < 0.8) return (r() - 0.5) * 1e6 // wide
    return (r() - 0.5) * 1e-3 // tiny, so big values swallow them
  }
  // Rare NaN and infinities (about 2 NaN rows and 1 of each infinity among
  // ~1,000 rows), so the set often holds none and un-poisoning can show.
  const u = r()
  if (u < 0.75) return Math.floor(r() * 101)
  if (u < 0.85) return Math.round(r() * 1e4) / 100
  if (u < 0.89) return null
  if (u < 0.92) return undefined // the field is left out of the row
  if (u < 0.955) return String(Math.floor(r() * 101)) // '42': a numeric string
  if (u < 0.996) return 'x'
  if (u < 0.998) return NaN
  if (u < 0.999) return Infinity
  return -Infinity
}

export function genRoom(d: Domain, r: () => number): unknown {
  if (d !== 'dirty') return 'r' + Math.floor(r() * 50)
  const u = r()
  if (u < 0.8) return 'r' + Math.floor(r() * 50)
  const n = 1 + Math.floor(r() * 5)
  return u < 0.9 ? n : String(n) // 1 and '1' land in one bucket and one distinct key
}

export function makeRow(id: string, d: Domain, r: () => number): Row {
  const row: Row = { id }
  const p = genPoints(d, r)
  if (p !== undefined) row.points = p
  row.room = genRoom(d, r)
  return row
}

// ── the truth: an independent fold of fero Recs ──────────────────────────────
export function applyTruth(t: Map<string, Row>, rec: Rec): void {
  const k = (rec.type === 1 ? rec.at : rec.key[0]) as string
  if (rec.type === 1) { t.set(k, rec.value as Row); return }
  if (rec.type === 0) {
    if (rec.key.length === 1) t.set(k, rec.value as Row)
    else t.set(k, { ...(t.get(k) as Row), [rec.key[1] as string]: rec.value })
    return
  }
  if (rec.key.length === 1) { t.delete(k); return }
  const row = { ...(t.get(k) as Row) } as Record<string, unknown>
  delete row[rec.key[1] as string]
  t.set(k, row as Row)
}

// ── the order every view is judged by ───────────────────────────────────────
// "Rankable" = a number that is not NaN (data's quantile rule). Rankable
// values first, descending; everything else after; ties by row key. A strict
// total order that is a function of the row alone, so a sort, a k-way merge
// of per-group sorts, and a rebuilt sort all agree.
export const rankable = (x: unknown): x is number => typeof x === 'number' && x === x
export function cmpTotal(a: Row, b: Row): number {
  const ra = rankable(a.points)
  const rb = rankable(b.points)
  if (ra && rb) {
    if (a.points !== b.points) return (a.points as number) > (b.points as number) ? -1 : 1
  } else if (ra !== rb) return ra ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// R type-7 quantile over a sorted numeric array (data's quantile formula).
export function r7(vals: number[], q: number): number | undefined {
  if (vals.length === 0) return undefined
  const h = (vals.length - 1) * q
  const lo = Math.floor(h)
  const frac = h - lo
  return frac === 0 ? vals[lo] : vals[lo] + frac * (vals[lo + 1] - vals[lo])
}

// The column projection data's aggregates use: undefined and null are "not in the set".
export const proj = (row: Row | undefined, col: 'points' | 'room'): unknown => {
  const x = row?.[col]
  return x === undefined || x === null ? undefined : x
}
