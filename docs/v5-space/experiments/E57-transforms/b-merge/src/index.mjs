// E-57 XB-1 (D8c) and the shared page index (F-14): an ordered index in O(log N) per change, as a prototype.
// A two-level chunked sorted array: chunks of at most 2 x CHUNK entries, found by a bisect over each chunk's
// last entry, then a bisect and a short splice inside the chunk. An entry is { v, k }: the sort value and the
// row key; the order is the total order (C1, C2) under one direction, ties by key.
//   insert(v, k), remove(v, k): O(log N + CHUNK)
//   first(n), after(v, k, n): the first n entries, or the n entries after a cursor: O(log N + n)
//   build(entries): one sort
// WindowIndex: the index fed by a row sink on a data view, with a window of n (a leaderboard) re-read once per
// commit (one window reconcile per batch, as data's own ordered view does). mutate 'prev': a remove bisects with
// the NEW row instead of `prev` (the planted bug of XB-1: stale entries stay).
import { cmpVal, cmpStr } from './lib.mjs'

const CHUNK = 512
export class OrderIndex2 {
  constructor(dir) {
    this.dir = dir
    this.chunks = [[]]
    this.size = 0
    const d = dir, sg = dir === 'za' ? -1 : 1
    // a fast path for two numbers (the common case), else the total order; ties by key
    this.cmp = (a, b) => {
      const x = a.v, y = b.v
      if (typeof x === 'number' && typeof y === 'number' && x === x && y === y) {
        if (x !== y) return x < y ? -sg : sg
      } else { const c = cmpVal(d, x, y); if (c !== 0) return c }
      return a.k < b.k ? -1 : a.k > b.k ? 1 : 0
    }
  }
  // the first chunk whose last entry is >= e (the last chunk if none)
  chunkFor(e) {
    const cs = this.chunks, cmp = this.cmp
    let lo = 0, hi = cs.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; const c = cs[mid]; if (cmp(c[c.length - 1], e) < 0) lo = mid + 1; else hi = mid }
    return lo
  }
  static lb(c, e, cmp) { let lo = 0, hi = c.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(c[mid], e) < 0) lo = mid + 1; else hi = mid } return lo }
  insert(v, k) {
    const e = { v, k }
    const ci = this.chunkFor(e)
    const c = this.chunks[ci]
    c.splice(OrderIndex2.lb(c, e, this.cmp), 0, e)
    this.size++
    if (c.length > 2 * CHUNK) this.chunks.splice(ci + 1, 0, c.splice(CHUNK))
  }
  remove(v, k) { // returns false when the entry is not where (v, k) says it is
    const e = { v, k }
    const ci = this.chunkFor(e)
    const c = this.chunks[ci]
    const i = OrderIndex2.lb(c, e, this.cmp)
    if (i >= c.length || c[i].k !== k) return false
    c.splice(i, 1)
    this.size--
    if (c.length === 0 && this.chunks.length > 1) this.chunks.splice(ci, 1)
    return true
  }
  build(entries) {
    entries.sort(this.cmp)
    this.chunks = []
    for (let i = 0; i < entries.length; i += CHUNK) this.chunks.push(entries.slice(i, i + CHUNK))
    if (this.chunks.length === 0) this.chunks.push([])
    this.size = entries.length
  }
  first(n) {
    const out = []
    for (const c of this.chunks) { for (const e of c) { if (out.length >= n) return out; out.push(e) } }
    return out
  }
  after(v, k, n) { // the n entries strictly after the cursor (v, k)
    const out = []
    const e = { v, k }
    let ci = this.chunkFor(e)
    const cmp = this.cmp
    let i = OrderIndex2.lb(this.chunks[ci], e, cmp)
    while (ci < this.chunks.length && out.length < n) {
      const c = this.chunks[ci]
      for (; i < c.length && out.length < n; i++) if (cmp(c[i], e) > 0) out.push(c[i])
      ci++; i = 0
    }
    return out
  }
  keys() { const ks = []; for (const c of this.chunks) for (const e of c) ks.push(e.k); return ks }
}

// A leaderboard over a data view: the index fed by a row sink, a window of n re-read once per commit.
// onWindow(keys, changed) once per commit in which the window changed (changed: entries in or out).
export class WindowIndex {
  constructor(view, field, dir, n, { mutate = '', onWindow } = {}) {
    this.ix = new OrderIndex2(dir)
    this.field = field; this.n = n; this.mutate = mutate; this.onWindow = onWindow
    this.win = []
    this.misses = 0
    let first = true
    const f = field
    this.h = view.sink({
      init: (snap) => {
        const es = []
        for (const [k, row] of snap) es.push({ v: row[f], k })
        this.ix.build(es)
        this.win = this.ix.first(n).map((e) => e.k)
        first = false
      },
      apply: (b) => {
        let touched = false
        for (const d of b.rows) {
          if (d.op === 'update') {
            const a = d.prev[f], z = d.row[f]
            if (a === z || (a !== a && z !== z)) continue // the sort value did not change: the entry stays
            if (!this.ix.remove(this.mutate === 'prev' ? z : a, d.key)) this.misses++
            this.ix.insert(z, d.key)
          } else if (d.op === 'add') this.ix.insert(d.row[f], d.key)
          else if (!this.ix.remove(d.prev[f], d.key)) this.misses++
          touched = true
        }
        if (!touched) return
        // one window reconcile per commit: walk the first n entries, compare with the window, no allocation
        let i = 0, same = true
        const win = this.win
        outer: for (const c of this.ix.chunks) for (const e of c) { if (i >= n) break outer; if (win[i] !== e.k) { same = false; break outer } i++ }
        if (same && i !== win.length) same = false
        if (!same) { this.win = this.ix.first(n).map((e) => e.k); this.onWindow?.(this.win) }
      },
    })
  }
  dispose() { this.h.dispose() }
}
