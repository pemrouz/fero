// E-57 group B: the contract and the new operators, built small on data's public API (data at 63fea66, bundled
// by run.sh into $OUT/data.mjs). Their costs are this prototype's, not data 5's.
//   za, az, page     data's ordered view with the total-order comparator, ties by the key the row carries (C1, C2)
//   eq, isIn, gt     data's filter(fn) with SameValueZero (XB-5) and the numeric projection (XB-3)
//   SumView          an exact sum as a row sink (C3, XB-4)
//   ByView           by(field, { step }) with one aggregate per bucket: length or an exact sum (N2; C5; XB-5)
//   GroupView        group(field) with per-row deltas into a bucket (D8b)
// Every row sink calls its listener once per data commit, after the commit's rows (one emission per commit).
import { pathToFileURL } from 'node:url'
import { num, svz, bkey, stepKey, rowCmp, afterCursor, WideSum, cmpVal } from './lib.mjs'

if (!process.env.OUT) throw new Error('set OUT to the folder that holds data.mjs (run.sh bundles it)')
export const D = await import(pathToFileURL(process.env.OUT + '/data.mjs').href)
export const NODE = D.node, VALUE = D.value

export function laneOf(src, rejects) {
  return D.lane(src, { onReject: (rj) => { if (rejects) rejects.push(String(rj.error?.message ?? rj.error)); else throw rj.error } })
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────────
export const keysOf = (h) => { const ks = []; h[NODE].each((k) => ks.push(k)); return ks }
export const rowsOf = (h) => { const m = new Map(); h[NODE].each((k, r) => m.set(k, r)); return m }

// ── ordered views and pages (C1, C2) ─────────────────────────────────────────────────────────────────
// mutate 'ties': the comparator without the key tie-break, so ties fall to data's arrival seq (today's rule)
export function za(src, field, n, mutate) {
  return src.az(mutate === 'ties' ? (a, b) => cmpVal('za', a[field], b[field]) : rowCmp(field, 'za'), n)
}
export function az(src, field, n) { return src.az(rowCmp(field, 'az'), n) }
export function page(src, field, dir, n, after) { // a page after a keyset cursor: a row test, then the window
  return src.filter(afterCursor(field, dir, after)).az(rowCmp(field, dir), n)
}

// ── filters (XB-3, XB-5) ─────────────────────────────────────────────────────────────────────────────
const scalar = (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v)
export function eq(src, field, v) {
  if (!scalar(v)) throw new Error('eq takes a scalar')
  return src.filter((r) => svz(r[field], v))
}
export function isIn(src, field, vs) {
  if (!vs.every(scalar)) throw new Error('in takes scalars')
  const set = new Set(vs.map(bkey))
  return src.filter((r) => { const k = bkey(r[field]); return k !== undefined && set.has(k) })
}
export function gt(src, field, v) { return src.filter((r) => { const x = num(r[field]); return x !== undefined && x > v }) }

// ── a row sink: on(key, prev | undefined, row | undefined) per row delta, then done() once per commit ──
export function rowSink(view, on, done) {
  return view.sink({
    init: (snap) => { for (const [k, row] of snap) on(k, undefined, row); done?.(true) },
    apply: (b) => { for (const d of b.rows) on(d.key, d.op === 'add' ? undefined : d.prev, d.op === 'remove' ? undefined : d.row); done?.(false) },
  })
}

// ── the exact sum (C3) over the numeric projection ──────────────────────────────────────────────────
export class SumView {
  constructor(view, field, { onChange } = {}) {
    this.s = new WideSum()
    this.calls = 0
    let before = 0
    this.h = rowSink(view, (k, p, r) => {
      const o = p === undefined ? undefined : num(p[field]), n = r === undefined ? undefined : num(r[field])
      if (o !== undefined) this.s.sub(o)
      if (n !== undefined) this.s.add(n)
    }, (first) => {
      const v = this.s.value()
      if (!first && !Object.is(v, before)) { this.calls++; onChange?.(before, v) }
      before = v
    })
  }
  get value() { return this.s.value() }
  dispose() { this.h.dispose() }
}

// ── by(field, { step }) with one aggregate (N2) ──────────────────────────────────────────────────────
// agg 'length' (a count per bucket) or 'sum' of field `of` (an exact sum per bucket). An emptied bucket goes (C5)
// unless keepEmpty (the planted bug). keyFn: the typed key (XB-5); bkeyString is the planted bug.
// onCommit(changes) once per commit: [{ b, key, value }] for buckets whose value changed; value undefined = gone.
export class ByView {
  constructor(view, field, { step, agg = 'length', of, keyFn = bkey, keepEmpty = false, onCommit } = {}) {
    this.m = new Map() // typed key -> { key: the bucket's value, n, s }
    this.field = field; this.step = step; this.agg = agg; this.of = of; this.keyFn = keyFn; this.keepEmpty = keepEmpty
    this.touched = new Map() // typed key -> value before this commit
    this.onCommit = onCommit
    this.commits = 0
    this.h = rowSink(view, (k, p, r) => this.on(p, r), (first) => this.flush(first))
  }
  bucket(row) {
    const v = row[this.field]
    return this.step === undefined ? this.keyFn(v) : stepKey(v, this.step)
  }
  val(e) { return e === undefined ? undefined : this.agg === 'length' ? e.n : e.s.value() }
  touch(b) { if (!this.touched.has(b)) this.touched.set(b, this.val(this.m.get(b))) }
  on(prev, row) {
    const bo = prev === undefined ? undefined : this.bucket(prev)
    const bn = row === undefined ? undefined : this.bucket(row)
    if (bo !== undefined) {
      this.touch(bo)
      const e = this.m.get(bo)
      e.n--
      if (this.agg === 'sum') { const x = num(prev[this.of]); if (x !== undefined) e.s.sub(x) }
      if (e.n === 0 && !this.keepEmpty) this.m.delete(bo)
    }
    if (bn !== undefined) {
      this.touch(bn)
      let e = this.m.get(bn)
      if (e === undefined) {
        const v = row[this.field]
        this.m.set(bn, (e = { key: this.step === undefined ? v : Math.floor(v / this.step) * this.step, n: 0, s: this.agg === 'sum' ? new WideSum() : null }))
      }
      e.n++
      if (this.agg === 'sum') { const x = num(row[this.of]); if (x !== undefined) e.s.add(x) }
    }
  }
  flush(first) {
    if (this.onCommit === undefined || first) { if (!first) this.commits++; this.touched.clear(); return }
    const out = []
    for (const [b, before] of this.touched) {
      const after = this.val(this.m.get(b))
      if (!Object.is(before, after)) out.push({ b, key: this.m.get(b)?.key, value: after })
    }
    this.touched.clear()
    if (!first) { this.commits++; if (out.length) this.onCommit?.(out) }
  }
  // the value as a Map typed key -> aggregate
  snapshot() { const o = new Map(); for (const [b, e] of this.m) o.set(b, this.val(e)); return o }
  dispose() { this.h.dispose() }
}

// ── group(field) with per-row deltas (D8b) ───────────────────────────────────────────────────────────
// Members per bucket. Each row change is one delta into its bucket (O(1)); an emptied bucket goes (C5).
// onCommit(deltas) once per commit: [{ b, k, row | undefined }]
export class GroupView {
  constructor(view, field, { keyFn = bkey, onCommit } = {}) {
    this.m = new Map() // typed key -> Map row key -> row
    this.field = field; this.keyFn = keyFn; this.onCommit = onCommit
    this.out = []
    this.h = rowSink(view, (k, p, r) => {
      const bo = p === undefined ? undefined : this.keyFn(p[field])
      const bn = r === undefined ? undefined : this.keyFn(r[field])
      if (bo !== undefined && bo !== bn) { const g = this.m.get(bo); g.delete(k); if (g.size === 0) this.m.delete(bo); this.out.push({ b: bo, k, row: undefined }) }
      if (bn !== undefined) { let g = this.m.get(bn); if (g === undefined) this.m.set(bn, (g = new Map())); g.set(k, r); this.out.push({ b: bn, k, row: r }) }
    }, (first) => { if (!first && this.out.length) this.onCommit?.(this.out); this.out = [] })
  }
  dispose() { this.h.dispose() }
}
