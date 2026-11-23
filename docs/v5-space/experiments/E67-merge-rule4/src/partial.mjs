// E-67 (copied from E-64 O1 src/partial.mjs unchanged): a PARTIAL. One per group (in the design: one copy of the group, picked like a served view's host).
// It sees its group's rows change (each change is { k, prev, next }: the row before and after, which every copy
// of the group already has from its own fold, V5-6) and keeps six partial views over ITS rows only:
//   win  za('points', KP): the group's top KP, ties by key (the total order, C1 and C2)
//   add  by('room').length() and by('room').sum('points'), plus length() and sum('points') as bucket '*':
//        no state: each changed row gives (bucket, value, -1) for its prev and (bucket, value, +1) for its next
//   ext  by('room').max('points'): the group's largest number per bucket (the numeric projection, C9)
//   uni  gt('points', 50): rows in and out of a filter
//   dis  distinct('room'): per bucket, the smallest key that holds it and its value (C4)
//   bool some(points === 100): whether any row of the group has it
// apply() returns the PARTIAL FRAME: what the merger needs, and nothing else. picture() is the whole partial
// state, for a merger that resyncs this group or is built new.
//   mutate 'kshort': each group sends only 4 rows of its window, a share of K = 10 (planted: an 'optimization'
//   that is wrong whenever one group holds more than 4 of the top 10)
import { OrderIndex2, num, bkey, cmpStr, WideSum } from './lib.mjs'

export const WIN_FIELD = 'points'
export const PRED = (row) => { const x = num(row.points); return x !== undefined && x > 50 }
export const FLAG = (row) => row.points === 100

export class Partial {
  constructor(gid, { KP = 10, mutate = '' } = {}) {
    this.gid = gid
    this.KP = mutate === 'kshort' ? 4 : KP
    this.rows = new Map() // k -> row, the group's own rows (the copy's store)
    this.ix = new OrderIndex2('za') // every row by points, za; also the group's page index
    this.win = [] // [k, row] of the current top KP
    this.buckets = new Map() // bkey(room) -> Set of keys (for ext and dis)
    this.ext = new Map() // b -> the group's max
    this.dis = new Map() // b -> [k, v]
    this.flag = 0
  }
  // changes: [{ k, prev, next }]; returns the partial frame
  apply(changes) {
    const add = [], uni = { put: [], drop: [] }, touched = new Set()
    let flag0 = this.flag > 0, winTouched = false
    for (const { k, prev, next } of changes) {
      if (prev) {
        add.push([bkey(prev.room), prev.points, -1], ['*', prev.points, -1])
        if (!this.ix.remove(prev.points, k)) throw new Error('partial index lost ' + k)
        const b = bkey(prev.room)
        if (b !== undefined) { this.buckets.get(b).delete(k); touched.add(b) }
        if (FLAG(prev)) this.flag--
        this.rows.delete(k)
        winTouched = true
      }
      if (next) {
        add.push([bkey(next.room), next.points, 1], ['*', next.points, 1])
        this.ix.insert(next.points, k)
        const b = bkey(next.room)
        if (b !== undefined) { let s = this.buckets.get(b); if (!s) this.buckets.set(b, (s = new Set())); s.add(k); touched.add(b) }
        if (FLAG(next)) this.flag++
        this.rows.set(k, next)
        winTouched = true
      }
      const pin = prev !== undefined && PRED(prev), nin = next !== undefined && PRED(next)
      if (nin) uni.put.push([k, next])
      else if (pin) uni.drop.push(k)
    }
    // the window: one reconcile per frame, as data's ordered view does once per commit
    const win = { put: [], drop: [] }
    if (winTouched) {
      const now = this.ix.first(this.KP).map((e) => [e.k, this.rows.get(e.k)])
      const nowKeys = new Map(now)
      for (const [k, row] of this.win) if (!nowKeys.has(k)) win.drop.push(k)
      const was = new Map(this.win)
      for (const [k, row] of now) if (was.get(k) !== row) win.put.push([k, row])
      this.win = now
    }
    const ext = [], dis = []
    for (const b of touched) {
      const s = this.buckets.get(b)
      let m, mk
      for (const k of s) {
        const x = num(this.rows.get(k).points)
        if (x !== undefined) m = m === undefined ? x : Math.max(m, x)
        if (mk === undefined || cmpStr(k, mk) < 0) mk = k
      }
      if (s.size === 0) this.buckets.delete(b)
      const om = this.ext.get(b)
      if (!Object.is(om, m)) { if (m === undefined) this.ext.delete(b); else this.ext.set(b, m); ext.push([b, m]) }
      const od = this.dis.get(b), nd = mk === undefined ? undefined : [mk, this.rows.get(mk).room]
      if (od?.[0] !== nd?.[0] || !Object.is(od?.[1], nd?.[1])) { if (nd === undefined) this.dis.delete(b); else this.dis.set(b, nd); dis.push([b, nd?.[0], nd?.[1]]) }
    }
    const bool = (this.flag > 0) !== flag0 ? [this.flag > 0] : []
    return { win, add: add.filter((d) => d[0] !== undefined), ext, uni, dis, bool }
  }
  // the group's whole partial state, for a resync or a new merger
  picture() {
    const add = new Map()
    for (const row of this.rows.values()) {
      for (const b of [bkey(row.room), '*']) {
        if (b === undefined) continue
        let e = add.get(b)
        if (!e) add.set(b, (e = { n: 0, ws: new WideSum() }))
        e.n++
        const x = num(row.points)
        if (x !== undefined) e.ws.add(x)
      }
    }
    const uni = new Map()
    for (const [k, row] of this.rows) if (PRED(row)) uni.set(k, row)
    return { win: this.win.slice(), add, ext: new Map(this.ext), uni, dis: new Map(this.dis), bool: this.flag > 0 }
  }
  // a slot move: the rows of the slot leave (the fence, at A) or arrive (the open, at B), as one frame each
  dropRows(keys) { return this.apply(keys.map((k) => ({ k, prev: this.rows.get(k), next: undefined }))) }
  takeRows(pairs) { return this.apply(pairs.map(([k, row]) => ({ k, prev: undefined, next: row }))) }
  // a page read on this group's own index: the n entries after the cursor (or the first n)
  pageAfter(cur, n) { return cur ? this.ix.after(cur[0], cur[1], n) : this.ix.first(n) }
}
