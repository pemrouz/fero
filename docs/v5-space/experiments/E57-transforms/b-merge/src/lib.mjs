// E-57 group B: shared helpers. Nothing here imports data. The oracles and the pure queries are written from
// scratch here so that a data bug cannot hide on both sides of a comparison.
//   rng, slots        E-23's seeded source and slot hash (4,096 slots, as LAYERS "Words")
//   canon             E-23's canonical printer, for "equal as values"
//   num               the one numeric projection (XB-3): a value counts if it is a number and not NaN
//   cmpVal, rowCmp    the total order in both directions (XB-2; C1, C2 as the critic restated them)
//   bkey, stepKey     typed bucket keys (XB-5)
//   svz               SameValueZero, the equality of eq and in (XB-5)
//   WideSum           the exact sum over every finite double (XB-4): Shewchuk's partials, a BigInt path near the
//                     float limit, and the -0 rule
//   makeRow           rows for the dirty domain (E-23's), with emoji in some keys and values (XB-2, F-13)

// ── random ─────────────────────────────────────────────────────────────────────────────────────────
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = (r, xs) => xs[Math.floor(r() * xs.length)]

// ── slots ──────────────────────────────────────────────────────────────────────────────────────────
export const SLOTS = 1024 // E-23's count; LAYERS has 4,096. Fewer slots put more rows in each slot: a harder test of R1 and R2
export function slotOf(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return (h >>> 0) % SLOTS
}

// ── canonical printing (E-23) ───────────────────────────────────────────────────────────────────────
export function canon(v) {
  if (v === undefined) return 'u'
  if (v === null) return 'n'
  switch (typeof v) {
    case 'number': return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : String(v)
    case 'string': return JSON.stringify(v)
    case 'boolean': return v ? 'T' : 'F'
    case 'bigint': return v + 'n'
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
      if (v instanceof Map) return 'M' + canon(Object.fromEntries([...v].map(([k, x]) => [String(k), x])))
      const ks = Object.keys(v).sort()
      let s = '{'
      for (let i = 0; i < ks.length; i++) s += (i ? ',' : '') + JSON.stringify(ks[i]) + ':' + canon(v[ks[i]])
      return s + '}'
    }
  }
  return String(v)
}

// ── the numeric projection (XB-3) ───────────────────────────────────────────────────────────────────
// One rule for every aggregate: a value counts if it is a number and not NaN. Strings, booleans, objects,
// null, undefined and NaN are skipped. The infinities count (so +Inf and -Inf together give NaN, as IEEE says).
export const num = (x) => (typeof x === 'number' && x === x ? x : undefined)

// ── SameValueZero (XB-5) ────────────────────────────────────────────────────────────────────────────
export const svz = (a, b) => a === b || (a !== a && b !== b)

// ── the total order (XB-2) ──────────────────────────────────────────────────────────────────────────
// Classes: 0 numbers that are not NaN, 1 strings (UTF-16 code units, as JS <), 2 booleans (false first),
// 3 other values (objects, arrays: by their canonical text), 4 undefined, null and NaN (one tie class).
// az: classes ascending, each class ascending. za: numbers DESCENDING, then the rest exactly as az, so a
// non-number never ranks above a number in either direction (E-23's cmpTotal measured this form).
export function vclass(v) {
  switch (typeof v) {
    case 'number': return v === v ? 0 : 4
    case 'string': return 1
    case 'boolean': return 2
    case 'undefined': return 4
    default: return v === null ? 4 : 3
  }
}
function cmpIn(c, a, b) {
  if (c === 0 || c === 1) return a < b ? -1 : a > b ? 1 : 0 // -0 and 0 tie (SameValueZero)
  if (c === 2) return a === b ? 0 : a ? 1 : -1
  if (c === 3) { const x = canon(a), y = canon(b); return x < y ? -1 : x > y ? 1 : 0 }
  return 0
}
export function cmpVal(dir, a, b) {
  const ca = vclass(a), cb = vclass(b)
  if (ca !== cb) return ca - cb
  const c = cmpIn(ca, a, b)
  return dir === 'za' && ca === 0 ? -c : c
}
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0) // UTF-16 code units
// Rows carry their own key as `id` (and `p`, the partition, at depth 2): data's comparators see rows, not keys,
// so the prototype ties by a key the row carries. data 5 would tie by the store's key itself.
export function rowCmp(field, dir, depth = 1) {
  if (depth === 2) return (a, b) => cmpVal(dir, a[field], b[field]) || cmpStr(a.p, b.p) || cmpStr(a.id, b.id)
  return (a, b) => cmpVal(dir, a[field], b[field]) || cmpStr(a.id, b.id)
}
// a keyset cursor: [value, key] at depth 1, [value, partition, key] at depth 2. "after" under the same order
export function afterCursor(field, dir, cur, depth = 1) {
  const cmp = rowCmp(field, dir, depth)
  const probe = depth === 2 ? { [field]: cur[0], p: cur[1], id: cur[2] } : { [field]: cur[0], id: cur[1] }
  return (row) => cmp(row, probe) > 0
}
export const cursorOf = (row, field, depth = 1) => (depth === 2 ? [row[field], row.p, row.id] : [row[field], row.id])

// ── typed bucket keys (XB-5) ────────────────────────────────────────────────────────────────────────
// A bucket's key is a type tag plus the value: 1 and '1' are two buckets; -0 and 0 one (SameValueZero); NaN one.
// by(field): scalars only (number, string, boolean, null); undefined and objects go to no bucket.
// by(field, { step }): finite numbers only (the numeric projection, less the infinities); the bucket is
// floor(v / step); others go to no bucket.
export function bkey(v) {
  switch (typeof v) {
    case 'number': return v !== v ? 'nNaN' : 'n' + (v === 0 ? '0' : String(v))
    case 'string': return 's' + v
    case 'boolean': return v ? 'bT' : 'bF'
    case 'object': return v === null ? 'z' : undefined
    default: return undefined
  }
}
export function stepKey(v, step) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const b = Math.floor(v / step)
  return 'n' + (b === 0 ? '0' : String(b))
}
// the planted bug of XB-5: data's String(v) naming (1 and '1' share a bucket)
export const bkeyString = (v) => (v === undefined ? undefined : String(v))

// ── the exact sum over every finite double (XB-4) ───────────────────────────────────────────────────
// Fast path: E-23's Shewchuk partials (exact while no partial overflows). When an add would overflow, the
// accumulator moves to a BigInt in units of 2^-1074 (every finite double is an integer multiple of it; about
// 2,100 bits cover any sum of up to 2^20 values), and moves back to partials once the sum is small again.
// value() rounds the exact sum once, to nearest even, overflow to +-Infinity included. NaN and the infinities
// are counted apart. The -0 rule: the sum is -0 exactly when every finite value is -0 (IEEE's own rule for a
// sum of zeros); an empty sum is +0.
const F64 = new Float64Array(1)
const U64 = new BigUint64Array(F64.buffer)
export function toUnits(x) { // x finite -> x * 2^1074 as an exact BigInt
  F64[0] = x
  const bits = U64[0]
  const exp = Number((bits >> 52n) & 0x7ffn)
  const man = bits & 0xfffffffffffffn
  const r = exp === 0 ? man : (man | 0x10000000000000n) << BigInt(exp - 1)
  return bits >> 63n ? -r : r
}
export function fromUnits(N) { // correctly rounded N * 2^-1074
  if (N === 0n) return 0
  const neg = N < 0n
  const a = neg ? -N : N
  const L = a.toString(2).length
  let r
  if (L <= 53) r = Number(a) * 5e-324 // exact: a subnormal or the smallest normals
  else if (L <= 64) r = Number(a) * 5e-324 // Number(a) rounds once; the scale is exact (result is normal)
  else {
    const s = L - 64
    let m = a >> BigInt(s)
    if (m << BigInt(s) !== a) m |= 1n // sticky bit: no double rounding
    r = Number(m) * 2 ** (s - 1074)
  }
  return neg ? -r : r
}
const BACK = 1n << 2070n // back to partials below about 2^996
export class WideSum {
  constructor() { this.p = []; this.big = null; this.nan = 0; this.pinf = 0; this.ninf = 0; this.nf = 0; this.nz = 0; this.n = 0 }
  add(x) { this.n++; this.put(x, 1) }
  sub(x) { this.n--; this.put(x, -1) }
  put(x, s) {
    if (x !== x) { this.nan += s; return }
    if (x === Infinity) { this.pinf += s; return }
    if (x === -Infinity) { this.ninf += s; return }
    this.nf += s
    if (x === 0) { if (Object.is(x, -0)) this.nz += s; return }
    if (this.big !== null) { this.bigAdd(s > 0 ? toUnits(x) : -toUnits(x)); return }
    this.grow(s > 0 ? x : -x)
  }
  grow(x) {
    const p = this.p
    let i = 0
    for (let j = 0; j < p.length; j++) {
      let y = p[j]
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t }
      const hi = x + y
      if (hi === Infinity || hi === -Infinity) { // overflow: the exact total is p[0..i) + x + y + p[j+1..]
        let t = toUnits(x) + toUnits(y)
        for (let q = 0; q < i; q++) t += toUnits(p[q])
        for (let q = j + 1; q < p.length; q++) t += toUnits(p[q])
        this.p = []
        this.big = t
        this.overflows = (this.overflows ?? 0) + 1
        return
      }
      const lo = y - (hi - x)
      if (lo !== 0) p[i++] = lo
      x = hi
    }
    p.length = i
    if (x !== 0 || i === 0) p.push(x)
  }
  bigAdd(u) {
    if (this.big === null) this.big = 0n
    this.big += u
    const a = this.big < 0n ? -this.big : this.big
    if (a < BACK) this.fromBig()
  }
  fromBig() { // back to non-overlapping partials, smallest first
    let N = this.big
    const parts = []
    while (N !== 0n) { const d = fromUnits(N); parts.push(d); N -= toUnits(d) }
    this.p = parts.reverse()
    this.big = null
  }
  value() {
    if (this.nan > 0 || (this.pinf > 0 && this.ninf > 0)) return NaN
    if (this.pinf > 0) return Infinity
    if (this.ninf > 0) return -Infinity
    if (this.nf > 0 && this.nz === this.nf) return -0
    if (this.big !== null) return fromUnits(this.big)
    const r = fsumRound(this.p)
    if (r === Infinity || r === -Infinity || r !== r) { let t = 0n; for (const y of this.p) t += toUnits(y); return fromUnits(t) }
    return r === 0 ? 0 : r
  }
}

// Python's msum final rounding (Modules/mathmodule.c math_fsum, the tail), as E-23.
export function fsumRound(partials) {
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

// E-23's ExactSum, as it is (the planted bug of XB-4): no overflow path, -0 lost.
export class E23Sum {
  constructor() { this.p = []; this.nan = 0; this.pinf = 0; this.ninf = 0; this.n = 0 }
  add(x) { this.n++; if (x !== x) { this.nan++; return } if (x === Infinity) { this.pinf++; return } if (x === -Infinity) { this.ninf++; return } this.grow(x) }
  sub(x) { this.n--; if (x !== x) { this.nan--; return } if (x === Infinity) { this.pinf--; return } if (x === -Infinity) { this.ninf--; return } this.grow(-x) }
  grow(x) {
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
  value() {
    if (this.nan > 0 || (this.pinf > 0 && this.ninf > 0)) return NaN
    if (this.pinf > 0) return Infinity
    if (this.ninf > 0) return -Infinity
    return fsumRound(this.p)
  }
}

// ── an independent fold of fero Recs (E-23's applyTruth) ───────────────────────────────────────────────
// { type: 0 set | 1 insert at `at` | 2 remove, key: [rowKey, ...fieldPath], value }
export function applyRec(t, rec) {
  const k = rec.type === 1 ? rec.at : rec.key[0]
  if (rec.type === 1) { t.set(k, rec.value); return }
  if (rec.type === 0) {
    if (rec.key.length === 1) t.set(k, rec.value)
    else t.set(k, { ...t.get(k), [rec.key[1]]: rec.value })
    return
  }
  if (rec.key.length === 1) { t.delete(k); return }
  const row = { ...t.get(k) }
  delete row[rec.key[1]]
  t.set(k, row)
}
export const recKey = (rec) => (rec.type === 1 ? rec.at : rec.key[0])

// ── rows ───────────────────────────────────────────────────────────────────────────────────────────
// E-23's dirty domain for `points` and `room`, plus `cents` (an integer) for derive. Some keys and string
// values carry an emoji (an astral character: two UTF-16 code units), so a UTF-8 byte order would differ.
export function genPoints(dom, r) {
  if (dom === 'int') return Math.floor(r() * 101)
  if (dom === 'ties') return Math.floor(r() * 10)
  const u = r()
  if (u < 0.75) return Math.floor(r() * 101)
  if (u < 0.85) return Math.round(r() * 1e4) / 100
  if (u < 0.89) return null
  if (u < 0.92) return undefined
  if (u < 0.955) return String(Math.floor(r() * 101))
  if (u < 0.985) return 'x'
  if (u < 0.990) return r() < 0.5 ? '\u{1F600}a' : 'ｚb' // an astral and a high BMP character
  if (u < 0.993) return r() < 0.5
  if (u < 0.995) return { o: Math.floor(r() * 3) }
  if (u < 0.997) return NaN
  if (u < 0.998) return -0
  if (u < 0.999) return Infinity
  return -Infinity
}
export function genRoom(dom, r) {
  if (dom !== 'dirty') return 'r' + Math.floor(r() * 50)
  const u = r()
  if (u < 0.8) return 'r' + Math.floor(r() * 50)
  const n = 1 + Math.floor(r() * 5)
  return u < 0.9 ? n : String(n) // 1 and '1': two buckets under the typed key rule
}
export const keyName = (i) => (i % 97 === 5 ? 'k\u{1F600}' + i : i % 89 === 3 ? 'kｚ' + i : 'k' + i)
export function makeRow(id, dom, r) {
  const row = { id }
  const p = genPoints(dom, r)
  if (p !== undefined) row.points = p
  row.room = genRoom(dom, r)
  return row
}
