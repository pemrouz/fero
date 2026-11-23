// E-65 skeptic probe: a seeded oracle for X1's SortedCol (the picked exact live median, X1-Q). X1 checked it
// 9 times against a fresh sort. Here: many seeds of inserts and removes with few distinct values (ties across
// chunk bounds), negative zero, infinities, NaN (ignored), and removes of a value that is not there. After
// every step the median, both quartiles (type 7, as data) and a random kth are checked against a sorted array.
//   node sortedcol-oracle.mjs [--seeds=300] [--steps=6000] [--bug=none|nextchunk|nointerp|staleremove]
// A planted bug must fail most seeds. One JSON line.
import { SortedCol } from '../X1/src/compact.mjs'
import { rng, args, out } from '../X1/src/lib.mjs'
const A = args(), seeds = A.seeds ?? 300, steps = A.steps ?? 6000, bug = A.bug ?? 'none'
class Bugged extends SortedCol {
  remove(x) {
    if (bug !== 'nextchunk') return super.remove(x)
    if (x !== x) return false
    const c = this._find(x), a = this.chunks[c], n = this.lens[c]; let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid }
    if (!(lo < n && a[lo] === x)) return false
    a.copyWithin(lo, lo + 1, n); this.lens[c] = n - 1; this.n--
    if (n - 1 === 0 && this.chunks.length > 1) { this.chunks.splice(c, 1); this.lens.splice(c, 1); this.maxs.splice(c === this.maxs.length - 1 ? c - 1 : c, 1) }
    return true
  }
  quant(p) {
    if (this.n === 0) return undefined
    const h = (this.n - 1) * p, lo = Math.floor(h), a = this.kth(lo)
    if (bug === 'nointerp') return a
    return h === lo ? a : a + (h - lo) * (this.kth(lo + 1) - a)
  }
}
const quantOf = (s, p) => { if (!s.length) return undefined; const h = (s.length - 1) * p, lo = Math.floor(h), a = s[lo]; return h === lo ? a : a + (h - lo) * (s[lo + 1] - a) }
const same = (x, y) => x === y || (x !== x && y !== y) || (Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)))
let failed = 0, checks = 0, first = null
for (let seed = 1; seed <= seeds; seed++) {
  const r = rng(seed), B = 2 + Math.floor(r() * 6) // tiny chunks, so splits and empties happen often
  const col = new Bugged(B), ref = []
  const distinct = 1 + Math.floor(r() * 12)
  const pick = () => { const u = r(); if (u < 0.03) return -0; if (u < 0.05) return Infinity; if (u < 0.07) return -Infinity; if (u < 0.09) return NaN; return Math.floor(r() * distinct) - 3 }
  let bad = null
  for (let i = 0; i < steps && !bad; i++) {
    const u = r()
    if (u < 0.55 || ref.length === 0) { const x = pick(); col.insert(x); if (x === x) { let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < x) lo = m + 1; else hi = m } ref.splice(lo, 0, x) } }
    else if (u < 0.95) { const x = ref[Math.floor(r() * ref.length)]; const ok = col.remove(x); if (!ok) bad = 'remove of a present value returned false: ' + x; else ref.splice(ref.indexOf(x), 1) }
    else { const x = pick(); const present = ref.indexOf(x) >= 0; const ok = col.remove(x); if (ok !== present) bad = 'remove(' + x + ') said ' + ok; else if (ok) ref.splice(ref.indexOf(x), 1) }
    if (bad) break
    if (col.n !== ref.length) { bad = 'n ' + col.n + ' vs ' + ref.length; break }
    for (const p of [0.25, 0.5, 0.75]) { checks++; const a = col.quant(p), b = quantOf(ref, p); if (!same(a, b)) { bad = 'q' + p + ' ' + a + ' vs ' + b; break } }
    if (ref.length) { checks++; const k = Math.floor(r() * ref.length); if (!same(col.kth(k), ref[k])) bad = 'kth ' + k }
  }
  if (bad) { failed++; first ??= { seed, bad } }
}
out({ probe: 'sortedcol-oracle', bug, seeds, steps, failed, checks, first })
