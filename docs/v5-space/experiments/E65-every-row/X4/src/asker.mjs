// E-65 X4: the asker's side of a live quantile over every row, fed by every group's stream.
// It keeps, per group, the bucket counts of that group's values (needed to drop one group's part on a resync),
// their sum (the live approximate answer, within the relative error a), and a BAND: the exact values whose bucket
// lies in one range around the asked rank. The exact answer comes from the band; when the rank leaves the band
// the asker asks every group for a picture of the new range, and the exact answer waits for all of them.
// It never holds rows or keys: only counts by bucket, and the values inside the band.
import { Hist, rankable, type7 } from './dd.mjs'

const inR = (r, b) => r !== null && b >= r[0] && b <= r[1]
function lb(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m } return lo }

export class Asker {
  constructor(m, G, bug = '') {
    this.m = m; this.bug = bug
    this.per = []
    for (let g = 0; g < G; g++) this.per.push({ h: new Hist(m), range: null, band: new Map() })
    this.all = new Hist(m)
    this.arr = [] // the band's values from every group, sorted, duplicates kept
    this.belowN = 0 // values whose bucket is below the asked range
    this.want = null // the range asked of every group; exact answers need every group on it
  }
  bandAdd(P, v, w) {
    if (v === 0) v = 0 // -0 and 0 rank the same
    const x = (P.band.get(v) || 0) + w
    if (x === 0) P.band.delete(v); else P.band.set(v, x)
    const a = this.arr
    for (let i = 0; i < (w < 0 ? -w : w); i++) { const j = lb(a, v); if (w > 0) a.splice(j, 0, v); else a.splice(j, 1) }
  }
  get bandN() { return this.arr.length }
  setWant(range) { this.want = range; this.belowN = range === null ? 0 : this.all.below(range[0]) }
  // a value enters (w = +1) or leaves (w = -1) group g's set
  val(g, v, w, skipBand = false) {
    if (!rankable(v)) return
    const P = this.per[g], b = this.m.bid(v)
    P.h.addBid(b, w); this.all.addBid(b, w)
    if (this.want !== null && b < this.want[0]) this.belowN += w
    if (!skipBand && inR(P.range, b)) this.bandAdd(P, v, w)
  }
  // one row's field went from o to n in group g (o or n not a number: absent)
  delta(g, o, n) {
    if (this.bug !== 'noremove') {
      const sk = this.bug === 'bandold' && rankable(o) && rankable(n) && !inR(this.per[g].range, this.m.bid(n))
      this.val(g, o, -1, sk)
    }
    this.val(g, n, +1)
  }
  // a picture of group g's band for a range (values with a bucket in it, at the group's position)
  installBand(g, range, vals) {
    const P = this.per[g]
    if (this.bug !== 'picadd') for (const [v, x] of [...P.band]) this.bandAdd(P, v, -x)
    P.band = this.bug === 'picadd' ? P.band : new Map(); P.range = range
    for (const v of vals) this.bandAdd(P, v, +1)
  }
  // a whole new picture of group g: every value (for the counts) and its band
  resync(g, vals, range) {
    const P = this.per[g]
    if (this.bug !== 'resyncadd') { this.all.merge(P.h, -1); P.h = new Hist(this.m) }
    for (const v of vals) { const b = this.m.bid(v); P.h.addBid(b, 1); this.all.addBid(b, 1) }
    this.setWant(this.want)
    this.installBand(g, range, range === null ? [] : vals.filter((v) => inR(range, this.m.bid(v))))
  }
  ready() { return this.want !== null && this.per.every((P) => P.range === this.want) }
  // the exact value of rank r, from the band; undefined if the band does not hold it
  exactAt(r) {
    const i = r - this.belowN
    return i < 0 || i >= this.arr.length ? undefined : this.arr[i]
  }
  exact(q) {
    if (!this.ready() || this.all.n === 0) return undefined
    let miss = false
    const v = type7(this.all.n, q, (r) => { const x = this.exactAt(r); if (x === undefined) miss = true; return x }, this.bug)
    return miss ? undefined : v
  }
  approx(q) { return type7(this.all.n, q, (r) => this.all.atRank(r)) }
  // the range to ask for so the ranks of quantile q sit inside it, w non-empty buckets each side
  rangeFor(q, w = 2) {
    const n = this.all.n
    if (n === 0) return null
    const r = Math.floor((n - 1) * q)
    const ids = this.all.sorted(), l = this.all.locate(r)
    const i = ids.indexOf(l.b)
    return [ids[Math.max(0, i - w)], ids[Math.min(ids.length - 1, i + w)]]
  }
}
