// E-65 X4: a relative-error bucket histogram (the DDSketch idea) whose counts can go DOWN, so it takes updates
// and removes. One bucket id per value, in one total order over every number data ranks:
//   -Infinity < negative buckets < 0 (and -0) < positive buckets < +Infinity
// A positive value v lands in bucket k = ceil(log_g v), g = (1 + a) / (1 - a); the bucket's estimate is within
// a relative error a of every value in it. Counts are exact integers, so subtracting is exact: a sketch of a set
// is the same however that set was reached (inserts, updates, removes, slot moves), and sketches merge by adding.
// Only real numbers rank (data's quantile: typeof number and not NaN); everything else is skipped by the caller.

export const rankable = (x) => typeof x === 'number' && !Number.isNaN(x)

export function mapping(alpha, bug = '') {
  const g = (1 + alpha) / (1 - alpha), lg = Math.log(g)
  const SHIFT = Math.ceil(745 / lg) + 2 // every positive double, even 5e-324, gets a key >= 1
  const INF = 4 * SHIFT
  const K = (v) => Math.ceil(Math.log(v) / lg) + SHIFT
  const bid = (v) => {
    if (v === Infinity) return bug === 'infbucket' ? K(1e300) : INF
    if (v === -Infinity) return bug === 'infbucket' ? -K(1e300) : -INF
    if (v > 0) return K(v)
    if (v < 0) return bug === 'negbucket' ? K(-v) : -K(-v)
    return 0 // 0 and -0
  }
  const est = (b) => {
    if (b === 0) return 0
    if (b >= INF) return Infinity
    if (b <= -INF) return -Infinity
    const a = b < 0 ? -b : b
    const e = (2 * Math.exp((a - SHIFT) * lg)) / (g + 1)
    return b < 0 ? -e : e
  }
  return { alpha, g, lg, SHIFT, INF, bid, est }
}

// counts by bucket id; sorted ids kept lazily for rank walks
export class Hist {
  constructor(m) { this.m = m; this.c = new Map(); this.n = 0; this.ids = null }
  addBid(b, w) {
    const x = (this.c.get(b) || 0) + w
    if (x === 0) { this.c.delete(b); this.ids = null } else { if (!this.c.has(b)) this.ids = null; this.c.set(b, x) }
    this.n += w
  }
  add(v, w) { this.addBid(this.m.bid(v), w) }
  merge(o, w = 1) { for (const [b, x] of o.c) this.addBid(b, w * x) }
  sorted() { return (this.ids ??= [...this.c.keys()].sort((a, b) => a - b)) }
  // the bucket holding the value of rank r (0-based) and the number of values before that bucket
  locate(r) {
    let acc = 0
    for (const b of this.sorted()) { const x = this.c.get(b); if (r < acc + x) return { b, before: acc }; acc += x }
    return undefined
  }
  atRank(r) { const l = this.locate(r); return l && this.m.est(l.b) }
  below(bLo) { let acc = 0; for (const b of this.sorted()) { if (b >= bLo) break; acc += this.c.get(b) } return acc }
  get size() { return this.c.size }
}

// data's quantile (R type 7): h = (n - 1) q, interpolate between the order statistics at floor(h) and floor(h) + 1
export function type7(n, q, at, bug = '') {
  if (n === 0) return undefined
  const h = bug === 'rank7' ? Math.min(n - 1, n * q) : (n - 1) * q
  const lo = Math.floor(h), f = h - lo
  const a = at(lo)
  return f === 0 ? a : a + f * (at(lo + 1) - a)
}
