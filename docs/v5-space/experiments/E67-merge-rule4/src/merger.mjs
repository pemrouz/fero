// E-67: the MERGER. Copied from E-64 O1 src/merger.mjs; what changed is marked "E-67".
// It never holds the resource's rows. It holds what the partials sent: per group, that group's partial state,
// and the merged answer. One merge per class (E-23's list):
//   window  each group's top KP, kept in one ordered index; the answer is the first K (KP >= K)
//   add     counts and exact sums per bucket: add and take away; an emptied bucket goes (C5)
//   extreme each group's max per bucket; the answer is the max over groups
//   union   rows by key (filters)
//   distinct per bucket the smallest key over groups
//   bool    a count of groups where it holds
// The rules about WHEN a frame or a picture may be taken (one cut, pairs, pictures, rule 4) live in intake.mjs.
//
// E-67, groups kept apart: O1 kept ONE entry per key for the window and the filter (wrow, uni: k -> { g, row }),
// and ignored a drop from a group that did not own the key (E-23's "each key from one group"). That depends on
// the order the merger applies things inside one cut. Once a cut can join pictures and frames of several groups
// (rule 4's join), a group's frame can overwrite another group's entry for the same key and then drop it.
// So, by default, each group's window and filter rows are kept apart, keyed (group, key), as O1 already kept
// sums, max and distinct per group. At a consistent cut each key is in one group only, so the answer is the same.
//   keys 'group' (default) | 'one' (O1's one entry per key: the planted bug 'keyowner')
//   mutate 'resyncadd' (a picture is added without taking the old part out: O1's planted bug for rule 3)
// A part need not be a group: in fix (c) a moving slot's rows are a part of their own, named 'm<move id>'.
import { OrderIndex2, WideSum, num, cmpStr } from './lib.mjs'
import { wsMerge } from './lib.mjs'
// a is above b under Math.max (so 0 is above -0): the one order every side uses for the extreme
const better = (a, b) => Object.is(Math.max(a, b), a) && !Object.is(a, b)
const SEP = '\u0000' // E-67: index key k + SEP + g keeps the key order (keys hold no NUL), ties still by key
export const EMPTY = { win: [], add: new Map(), ext: new Map(), uni: new Map(), dis: new Map(), bool: false }

export class Merger {
  constructor({ K = 10, mutate = '', keys = 'group' } = {}) {
    this.K = K; this.mutate = mutate; this.one = keys === 'one'
    this.ix = new OrderIndex2('za') // window: the union of the groups' windows
    this.wrow = new Map() // 'one': k -> { g, row, ik }
    this.gw = new Map() // E-67 'group': g -> Map k -> { row, ik }
    this.top = []
    this.gadd = new Map() // g -> Map b -> { n, ws }
    this.add = new Map() // b -> { n, ws }
    this.gext = new Map() // b -> Map g -> max
    this.ext = new Map() // b -> max
    this.uni = new Map() // 'one': k -> { g, row }
    this.guni = new Map() // E-67 'group': g -> Map k -> row
    this.gdis = new Map() // b -> Map g -> [k, v]
    this.dis = new Map() // b -> [k, v]
    this.gbool = new Map() // g -> bool
    this.nbool = 0
  }
  // ── one partial frame from part g ────────────────────────────────────────────────────────────────
  apply(g, p) {
    for (const k of p.win.drop) this.winDrop(g, k)
    for (const [k, row] of p.win.put) this.winPut(g, k, row)
    for (const [b, v, s] of p.add) this.addDelta(g, b, v, s)
    for (const [b, m] of p.ext) this.extSet(g, b, m)
    for (const k of p.uni.drop) this.uniDrop(g, k)
    for (const [k, row] of p.uni.put) this.uniPut(g, k, row)
    for (const [b, k, v] of p.dis) this.disSet(g, b, k, v)
    for (const t of p.bool) this.boolSet(g, t)
  }
  realKey(ik) { const i = ik.indexOf(SEP); return i < 0 ? ik : ik.slice(0, i) }
  winPut(g, k, row) {
    if (this.one) {
      const old = this.wrow.get(k)
      if (old) this.ix.remove(old.row.points, old.ik)
      this.ix.insert(row.points, k)
      this.wrow.set(k, { g, row, ik: k })
      return
    }
    let per = this.gw.get(g)
    if (!per) this.gw.set(g, (per = new Map()))
    const old = per.get(k)
    if (old) this.ix.remove(old.row.points, old.ik)
    const ik = k + SEP + g
    this.ix.insert(row.points, ik)
    per.set(k, { row, ik })
  }
  winDrop(g, k) {
    if (this.one) {
      const old = this.wrow.get(k)
      if (!old || old.g !== g) return // E-23's rule 2, as O1 had it
      this.ix.remove(old.row.points, old.ik); this.wrow.delete(k)
      return
    }
    const per = this.gw.get(g), old = per?.get(k)
    if (!old) return
    this.ix.remove(old.row.points, old.ik); per.delete(k)
  }
  addDelta(g, b, v, s) {
    let ga = this.gadd.get(g)
    if (!ga) this.gadd.set(g, (ga = new Map()))
    for (const m of [ga, this.add]) {
      let e = m.get(b)
      if (!e) m.set(b, (e = { n: 0, ws: new WideSum() }))
      e.n += s
      const x = num(v)
      if (x !== undefined) { if (s > 0) e.ws.add(x); else e.ws.sub(x) }
      if (e.n === 0) m.delete(b)
    }
  }
  extSet(g, b, m) {
    let per = this.gext.get(b)
    if (!per) this.gext.set(b, (per = new Map()))
    const old = per.get(g)
    if (m === undefined) per.delete(g); else per.set(g, m)
    const cur = this.ext.get(b)
    if (m !== undefined && (cur === undefined || better(m, cur))) this.ext.set(b, m)
    else if (old !== undefined && Object.is(old, cur)) { // the top group's value fell or left: look at every group, O(G)
      let best
      for (const x of per.values()) best = best === undefined ? x : Math.max(best, x)
      if (best === undefined) this.ext.delete(b); else this.ext.set(b, best)
    }
    if (per.size === 0) { this.gext.delete(b); this.ext.delete(b) }
  }
  uniPut(g, k, row) {
    if (this.one) { this.uni.set(k, { g, row }); return }
    let per = this.guni.get(g)
    if (!per) this.guni.set(g, (per = new Map()))
    per.set(k, row)
  }
  uniDrop(g, k) {
    if (this.one) { const e = this.uni.get(k); if (e && e.g === g) this.uni.delete(k); return }
    this.guni.get(g)?.delete(k)
  }
  disSet(g, b, k, v) {
    let per = this.gdis.get(b)
    if (!per) this.gdis.set(b, (per = new Map()))
    if (k === undefined) per.delete(g); else per.set(g, [k, v])
    let best
    for (const e of per.values()) if (best === undefined || cmpStr(e[0], best[0]) < 0) best = e
    if (best === undefined) { this.dis.delete(b); this.gdis.delete(b) } else this.dis.set(b, best)
  }
  boolSet(g, t) {
    const old = this.gbool.get(g) ?? false
    if (old === t) return
    this.gbool.set(g, t)
    this.nbool += t ? 1 : -1
  }
  // ── a picture replaces part g, as one commit of differences (O1's rule 3) ─────────────────────────────
  install(g, pic) {
    if (this.one) { // O1: scan every group's entries
      for (const [k, e] of [...this.wrow]) if (e.g === g) { this.ix.remove(e.row.points, e.ik); this.wrow.delete(k) }
      for (const [k, e] of [...this.uni]) if (e.g === g) this.uni.delete(k)
    } else { // E-67: only g's own entries
      const per = this.gw.get(g)
      if (per) { for (const e of per.values()) this.ix.remove(e.row.points, e.ik); per.clear() }
      this.guni.get(g)?.clear()
    }
    for (const [k, row] of pic.win) this.winPut(g, k, row)
    const old = this.gadd.get(g) ?? new Map()
    if (this.mutate !== 'resyncadd') for (const [b, e] of old) this.addGroupState(b, e, -1)
    const ga = new Map()
    for (const [b, e] of pic.add) { const c = { n: e.n, ws: new WideSum() }; wsMerge(c.ws, e.ws, 1); ga.set(b, c); this.addGroupState(b, e, 1) }
    this.gadd.set(g, ga)
    for (const [b, per] of [...this.gext]) if (per.has(g)) this.extSet(g, b, undefined)
    for (const [b, m] of pic.ext) this.extSet(g, b, m)
    for (const [b, per] of [...this.gdis]) if (per.has(g)) this.disSet(g, b, undefined)
    for (const [b, [k, v]] of pic.dis) this.disSet(g, b, k, v)
    for (const [k, row] of pic.uni) this.uniPut(g, k, row)
    this.boolSet(g, pic.bool)
  }
  addGroupState(b, e, sign) {
    let m = this.add.get(b)
    if (!m) this.add.set(b, (m = { n: 0, ws: new WideSum() }))
    m.n += sign * e.n
    wsMerge(m.ws, e.ws, sign)
    if (m.n === 0) this.add.delete(b)
  }
  // E-67: a part leaves whole (a group removed, or a move part closed): its contribution out, then its maps.
  // (O1's dropGroup only forgot the maps; there a group left only once empty.)
  dropGroup(g) {
    const r = this.mutate; this.mutate = ''
    this.install(g, EMPTY)
    this.mutate = r
    this.gadd.delete(g); this.gbool.delete(g); this.gw.delete(g); this.guni.delete(g)
  }
  // ── the answers ──────────────────────────────────────────────────────────────────────────────────
  topK() { return this.ix.first(this.K).map((e) => this.realKey(e.k)) }
  addOut(b) { const e = this.add.get(b); return e === undefined ? undefined : [e.n, e.ws.value()] }
  extOut(b) { return this.ext.get(b) }
  disOut(b) { const e = this.dis.get(b); return e === undefined ? undefined : e[1] }
  boolOut() { return this.nbool > 0 }
  // E-67: the filter's rows for key k over every part (more than one means a key counted twice)
  uniRows(k) {
    if (this.one) { const e = this.uni.get(k); return e ? [e.row] : [] }
    const out = []
    for (const per of this.guni.values()) { const r = per.get(k); if (r !== undefined) out.push(r) }
    return out
  }
  uniSize() { if (this.one) return this.uni.size; let n = 0; for (const per of this.guni.values()) n += per.size; return n }
}
