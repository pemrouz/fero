// E-65 X4: a one-time exact quantile over every row, asked of every group, holding no more than one bucket's
// values at the asker. Trip 1: every group's bucket counts (an asker that keeps the live counts already has them,
// and skips this trip). The asker finds the bucket of rank r. Each later trip: every group sends its values in the
// current range as (value, count) pairs if it has at most `cap` distinct ones there, else counts for 256 equal
// parts of the range; the asker narrows to the part holding the rank and asks again. Every trip must see every
// group at one position (a pinned read); the checks below run at the groups' heads with no write between trips.
import { Hist } from './dd.mjs'

const PARTS = 256

// groups: [{ vals: number[] (rankable values), hist: Hist (that group's counts) }]
export function readRank(groups, r, m, { cap = 1024, haveCounts = null, bug = '' } = {}) {
  let trips = 0, sent = 0, scanned = 0
  let all = haveCounts
  if (!all) { trips++; all = new Hist(m); for (const g of groups) { all.merge(g.hist); sent += g.hist.size } }
  const loc = all.locate(r)
  if (!loc) return undefined
  const b = loc.b
  if (b === 0 || Math.abs(m.est(b)) === Infinity) return { v: m.est(b), trips, sent, scanned } // one value
  let off = r - loc.before
  // the bucket alone first, then a part of it: a chain of tests, each the same arithmetic the groups binned with
  let inside = (v) => m.bid(v) === b
  for (;;) {
    trips++
    const pairs = [], parts = new Float64Array(PARTS)
    let split = false, plo = 0, w = 0
    const partOf = (v) => Math.min(PARTS - 1, Math.max(0, Math.ceil((v - plo) / w) - 1))
    const per = groups.map((g) => {
      const mine = new Map()
      for (const v of g.vals) { scanned++; if (inside(v)) mine.set(v, (mine.get(v) || 0) + 1) }
      return mine
    })
    if (per.some((mine) => mine.size > cap)) {
      // the asker sets the parts: (plo + i w, plo + (i + 1) w] over the values' span in this range
      let mn = Infinity, mx = -Infinity
      for (const mine of per) for (const v of mine.keys()) { if (v < mn) mn = v; if (v > mx) mx = v }
      split = true; plo = mn - (mx - mn) / PARTS / 2; w = (mx - plo) / PARTS
    }
    for (const mine of per) {
      if (split && mine.size > cap) {
        sent += PARTS
        for (const [v, x] of mine) parts[partOf(v)] += x
      } else { sent += mine.size; for (const e of mine) pairs.push(e) }
    }
    if (!split) {
      pairs.sort((a, b2) => a[0] - b2[0])
      let acc = 0
      for (const [v, x] of pairs) { acc += x; if (off < acc) return { v, trips, sent, scanned } }
      return undefined
    }
    for (const [v, x] of pairs) parts[partOf(v)] += x
    let acc = 0, i = 0
    for (; i < PARTS; i++) { if (off < acc + parts[i]) break; acc += parts[i] }
    if (bug !== 'nooff') off -= acc // planted: the rank inside the part is not moved
    const prev = inside, P0 = plo, W = w, I = i
    inside = (v) => prev(v) && Math.min(PARTS - 1, Math.max(0, Math.ceil((v - P0) / W) - 1)) === I
  }
}
