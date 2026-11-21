// E-64 O1: reads over every row that a merger answers WITHOUT a live merged view: a page of a sorted list
// ({ pages }) and an exact median, each asked of every group's own index (scatter-gather). Every group answers
// from its own rows; nothing holds the whole resource.
import { OrderIndex2 } from './lib.mjs'

// the number of entries strictly before (v, k) in an OrderIndex2, and the entry at a rank: O(chunks + log)
export function rankOf(ix, v, k) {
  const e = { v, k }
  const ci = ix.chunkFor(e)
  let r = 0
  for (let i = 0; i < ci; i++) r += ix.chunks[i].length
  return r + OrderIndex2.lb(ix.chunks[ci], e, ix.cmp)
}
export function entryAt(ix, r) {
  for (const c of ix.chunks) { if (r < c.length) return c[r]; r -= c.length }
  return undefined
}

// ── a page: the first n entries after a cursor, over G groups' indexes ─────────────────────────────────
// 'one': each group sends its n next entries; the merger keeps the first n. One round, G x n entries sent.
// 'two': each group sends m = ceil(n / G) + 1; the merger finds the n-th candidate t; a group that may hold
//        more entries before t (it sent m, and its last is before t), or any group with more when fewer than n
//        came, sends up to n more after its last. Exact; usually far fewer entries sent.
export function pageScatter(ixs, cur, n, form, cmp) {
  const after = (ix, c, m) => (c ? ix.after(c[0], c[1], m) : ix.first(m))
  let sent = 0, rounds = 1
  if (form === 'one') {
    const all = []
    for (const ix of ixs) { const a = after(ix, cur, n); sent += a.length; all.push(...a) }
    all.sort(cmp)
    return { page: all.slice(0, n), sent, rounds }
  }
  const m = Math.ceil(n / ixs.length) + 1
  const got = ixs.map((ix) => after(ix, cur, m))
  for (const a of got) sent += a.length
  let cand = got.flat().sort(cmp)
  const t = cand.length >= n ? cand[n - 1] : undefined
  const more = []
  got.forEach((a, i) => {
    if (a.length < m) return // this group has nothing more after the cursor
    const last = a[a.length - 1]
    if (t === undefined || cmp(last, t) < 0) more.push([i, last])
  })
  if (more.length) {
    rounds = 2
    for (const [i, last] of more) { const b = ixs[i].after(last.v, last.k, n); sent += b.length; cand.push(...b) }
    cand.sort(cmp)
  }
  return { page: cand.slice(0, n), sent, rounds }
}

// ── an exact selection: the entry of global rank r among the first c_g entries of each group ────────────
// Each round the merger sends one pivot; every group answers how many of its entries come before it and the
// middle of what is left in its window. The pivot is the weighted median of those middles, so each round drops
// at least a quarter of what is left. Returns the entry and the number of rounds (each one trip to every group).
export function selectRank(ixs, counts, r, cmp) {
  const lo = ixs.map(() => 0), hi = counts.slice()
  let rounds = 0
  for (;;) {
    rounds++
    const cands = []
    let total = 0
    for (let g = 0; g < ixs.length; g++) {
      const w = hi[g] - lo[g]
      if (w <= 0) continue
      cands.push({ e: entryAt(ixs[g], (lo[g] + hi[g]) >> 1), w })
      total += w
    }
    if (total === 0) throw new Error('selectRank: empty window')
    cands.sort((a, b) => cmp(a.e, b.e))
    let acc = 0, pivot
    for (const c of cands) { acc += c.w; if (2 * acc >= total) { pivot = c.e; break } }
    const ranks = ixs.map((ix) => rankOf(ix, pivot.v, pivot.k))
    let B = 0
    for (const x of ranks) B += x
    if (B === r) return { e: pivot, rounds }
    if (B < r) for (let g = 0; g < ixs.length; g++) { const ix = ixs[g]; const at = ranks[g]; const own = at < ix.size && entryAt(ix, at).k === pivot.k && cmp(entryAt(ix, at), pivot) === 0 ? 1 : 0; lo[g] = Math.max(lo[g], Math.min(hi[g], at + own)) }
    else for (let g = 0; g < ixs.length; g++) hi[g] = Math.min(hi[g], Math.max(lo[g], ranks[g]))
  }
}
