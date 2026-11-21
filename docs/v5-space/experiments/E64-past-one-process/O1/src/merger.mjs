// E-64 O1: the MERGER. One per served view (in the design: on one server, picked by a hash, like a served view's
// entry). It never holds the resource's rows. It holds what the partials sent: per group, that group's partial
// state, and the merged answer. Its rules (E-23's four, as built here):
//   1. A merged view is defined at a cut: each group at the position of the last frame applied from it.
//   2. Each key from exactly one group: a drop from a group that does not own the key is ignored.
//   3. The two halves of a slot move (A's fence, B's open) are applied at one cut (the caller pairs them).
//   4. A group's partial is replaced by a picture taken at or past the merger's position for that group, as one
//      commit of differences: its old contribution leaves and the new one comes in.
// And one merge per class (E-23's list; the classes data 5 would state per call, C6):
//   window  each group's top KP, kept in one ordered index; the answer is the first K (KP >= K)
//   add     counts and exact sums per bucket: add and take away; an emptied bucket goes (C5)
//   extreme each group's max per bucket; the answer is the max over groups (O(G) when the top group's falls)
//   union   rows by key (filters)
//   distinct per bucket the smallest key over groups
//   bool    a count of groups where it holds
// Planted (mutate): 'ties' (window ties by arrival, not key), 'extmerged' (the extreme keeps only the merged
// value, no per-group values), 'resyncadd' (a resync adds the picture without taking the old contribution out),
// 'noowner' (rule 2 off).
import { OrderIndex2, WideSum, num, cmpStr } from './lib.mjs'
import { wsMerge } from './lib.mjs'
// a is above b under Math.max (so 0 is above -0): the one order every side uses for the extreme
const better = (a, b) => Object.is(Math.max(a, b), a) && !Object.is(a, b)

export class Merger {
  constructor({ K = 10, mutate = '' } = {}) {
    this.K = K; this.mutate = mutate
    this.ix = new OrderIndex2('za') // window: the union of the groups' windows
    this.wrow = new Map() // k -> { g, row, ik } (ik: the key in the index; differs only under 'ties')
    this.arrival = 0
    this.top = [] // the current answer's keys, for frame diffs
    this.gadd = new Map() // g -> Map b -> { n, ws }
    this.add = new Map() // b -> { n, ws }
    this.gext = new Map() // b -> Map g -> max
    this.ext = new Map() // b -> max
    this.uni = new Map() // k -> { g, row }
    this.gdis = new Map() // b -> Map g -> [k, v]
    this.dis = new Map() // b -> [k, v]
    this.gbool = new Map() // g -> bool
    this.nbool = 0
    this.pos = new Map() // g -> position (the cut)
    this.frames = 0; this.outChanges = 0; this.dirty = true; this.kth = undefined
  }
  // ── one partial frame from group g ───────────────────────────────────────────────────────────────
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
  // the client's frame: did the answer change since the last frame? A put or drop at or above the K-th entry
  // marks it (O(log) per change); only then is the top K read again, O(K): the work a frame to clients needs anyway
  frame() {
    this.frames++
    if (!this.dirty) return false
    this.dirty = false
    const ents = this.ix.first(this.K)
    this.kth = ents.length >= this.K ? ents[ents.length - 1] : undefined
    this.top = ents.map((e) => this.realKey(e.k))
    this.outChanges++
    return true
  }
  touches(v, ik) { if (!this.dirty && (this.kth === undefined || this.ix.cmp({ v, k: ik }, this.kth) <= 0)) this.dirty = true }
  realKey(ik) { return this.mutate === 'ties' ? ik.slice(ik.indexOf('|') + 1) : ik }
  winPut(g, k, row) {
    const old = this.wrow.get(k)
    if (old) { this.touches(old.row.points, old.ik); this.ix.remove(old.row.points, old.ik) }
    const ik = this.mutate === 'ties' ? String(this.arrival++).padStart(12, '0') + '|' + k : k
    this.ix.insert(row.points, ik)
    this.wrow.set(k, { g, row, ik })
    this.touches(row.points, ik)
  }
  winDrop(g, k) {
    const old = this.wrow.get(k)
    if (!old) return
    if (old.g !== g && this.mutate !== 'noowner') return // rule 2
    this.touches(old.row.points, old.ik)
    this.ix.remove(old.row.points, old.ik)
    this.wrow.delete(k)
  }
  addDelta(g, b, v, s) {
    let ga = this.gadd.get(g)
    if (!ga) this.gadd.set(g, (ga = new Map()))
    for (const [m, keep] of [[ga, true], [this.add, false]]) {
      let e = m.get(b)
      if (!e) m.set(b, (e = { n: 0, ws: new WideSum() }))
      e.n += s
      const x = num(v)
      if (x !== undefined) { if (s > 0) e.ws.add(x); else e.ws.sub(x) }
      if (e.n === 0) m.delete(b)
    }
  }
  extSet(g, b, m) {
    if (this.mutate === 'extmerged') { // planted: no per-group values, so a falling max cannot be found again
      if (m === undefined) return
      const cur = this.ext.get(b)
      this.ext.set(b, cur === undefined ? m : Math.max(cur, m))
      return
    }
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
  uniPut(g, k, row) { this.uni.set(k, { g, row }) }
  uniDrop(g, k) { const e = this.uni.get(k); if (e && (e.g === g || this.mutate === 'noowner')) this.uni.delete(k) }
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
  // ── rule 4: replace group g's partial by a picture, as one commit of differences ──────────────────
  install(g, pic) {
    // window: g's rows out, the picture's in
    for (const [k, e] of [...this.wrow]) if (e.g === g) { this.ix.remove(e.row.points, e.ik); this.wrow.delete(k) }
    this.dirty = true
    for (const [k, row] of pic.win) this.winPut(g, k, row)
    // add: take g's old contribution out of the merged sums, put the new one in
    const old = this.gadd.get(g) ?? new Map()
    if (this.mutate !== 'resyncadd') for (const [b, e] of old) this.addGroupState(b, e, -1)
    const ga = new Map()
    for (const [b, e] of pic.add) { const c = { n: e.n, ws: new WideSum() }; wsMerge(c.ws, e.ws, 1); ga.set(b, c); this.addGroupState(b, e, 1) }
    this.gadd.set(g, ga)
    // ext, dis: replace g's values bucket by bucket
    for (const [b, per] of [...this.gext]) if (per.has(g)) this.extSet(g, b, undefined)
    for (const [b, m] of pic.ext) this.extSet(g, b, m)
    for (const [b, per] of [...this.gdis]) if (per.has(g)) this.disSet(g, b, undefined)
    for (const [b, [k, v]] of pic.dis) this.disSet(g, b, k, v)
    for (const [k, e] of [...this.uni]) if (e.g === g) this.uni.delete(k)
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
  dropGroup(g) { this.gadd.delete(g); this.gbool.delete(g); this.pos.delete(g) }
  // ── the answers ──────────────────────────────────────────────────────────────────────────────────
  topK() { return this.ix.first(this.K).map((e) => this.realKey(e.k)) }
  addOut(b) { const e = this.add.get(b); return e === undefined ? undefined : [e.n, e.ws.value()] }
  extOut(b) { return this.ext.get(b) }
  disOut(b) { const e = this.dis.get(b); return e === undefined ? undefined : e[1] }
  boolOut() { return this.nbool > 0 }
}
