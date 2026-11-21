// E-64 O3: partials keyed by slot, pushed down to a copy of each group, and the combiner that merges them.
//
// A PARTIAL is a view over the rows of ONE SLOT, kept by a copy of the group that owns the slot (the copy holds
// those rows anyway). Its state is a few CELLS: for the views here, a count and an exact sum, a count, exact sum
// and max per bucket, the slot's own top K, and the rows that pass a filter. Every cell is keyed by
// (slot, view key) and stamped with the slot's position, so the combiner never needs to know which group sent it.
//
// A host (one copy of a group) sends a STREAM of frames. A frame is one group commit: for each slot it touched,
// the range of positions it covers, (from, to], and the cells that changed, as their new whole values. A PICTURE
// is a slot's whole cells at one position (from = -1).
//
// The combiner's three rules (S1 to S3), which replace E-23's cut, move pairing and per-group resync:
//   S1 cells are keyed by slot and every frame names its slot range (from, to]
//   S2 per slot, newest wins with no gap: a frame applies when from <= pos < to, is dropped when to <= pos, and a
//      picture (from = -1) replaces the slot's cells whole when pos < to
//   S3 a stream starts every slot with its picture: when a host opens a slot after a move, and when a stream
//      (re)starts after a failover or for a new combiner
// Because a frame carries whole new values, two frames in a row of one stream merge into one (a slow reader is
// folded), and any copy of a group can serve: every copy folds the same log, so its cells at a position are the
// same.
//
// Planted bugs (opts.mutate; never in a measured run):
//   nor1        S2's position check off: every frame applies, a picture always replaces, the position follows it
//   nopicture   S3 off: a host opens a slot, and a new stream starts, with no picture; the combiner applies a frame
//               past a gap as if there were none
//   mergepic    a picture sets the cells it carries but keeps the slot's other cells (a merge, not a replace)
//   coalescedrop  merging two frames keeps only the later one's changes
//   ties        the slot's top K and the merge order break ties by arrival, not by row key
//   extmerged   the combiner keeps one merged max per bucket, not every slot's max
//   rounded     a sum cell carries its rounded value; the combiner keeps a float running total
//   pergroup    cells keyed by group instead of by slot (one partial per group, E-23 with no move pairing)
// Variant (expected to pass): early -- the importing group publishes its copy of a slot at import, before open
// (B1's R2, keep the copy apart, dropped).
import { rowCmp, num, bkey, canon, WideSum, maxBetter, sumState, emptySum, putState, newAcc } from './lib.mjs'

export const K = 10
const cmpKey = rowCmp('points', 'za')

// ── a slot's (or, for pergroup, a group's) cells, from its rows ───────────────────────────────────────
export function computeCells(rowsIters, mutate) {
  let len = 0
  const sum = new WideSum()
  const by = new Map() // bucket -> { c, s: WideSum, m }
  const gt = new Map()
  const all = []
  for (const rows of rowsIters) for (const [k, row] of rows) {
    len++
    const x = num(row.points)
    if (x !== undefined) sum.add(x)
    const b = bkey(row.room)
    if (b !== undefined) {
      let e = by.get(b)
      if (e === undefined) by.set(b, (e = { c: 0, s: new WideSum(), m: undefined }))
      e.c++
      if (x !== undefined) { e.s.add(x); if (e.m === undefined || maxBetter(x, e.m)) e.m = x }
    }
    if (x !== undefined && x > 50) gt.set(k, row)
    all.push(row)
  }
  const cmp = mutate === 'ties' ? (a, b) => cmpKey({ ...a, id: '' }, { ...b, id: '' }) : cmpKey
  all.sort(cmp) // stable: with 'ties', equal scores stay in arrival order
  const top = all.slice(0, K).map((r) => ({ id: r.id, points: r.points }))
  const byOut = new Map()
  for (const [b, e] of by) byOut.set(b, { c: e.c, s: mutate === 'rounded' ? e.s.value() : sumState(e.s), m: e.m })
  return { len, sum: mutate === 'rounded' ? sum.value() : sumState(sum), by: byOut, top, gt }
}
export const emptyCells = (mutate) => ({ len: 0, sum: mutate === 'rounded' ? 0 : emptySum(), by: new Map(), top: [], gt: new Map() })

const DEL = null
// changes from cells a to cells b: [['len', v], ['sum', st], ['by', bucket, cell|null], ['top', list], ['gt', key, row|null]]
export function diffCells(a, b) {
  const ch = []
  if (a.len !== b.len) ch.push(['len', b.len])
  if (canon(a.sum) !== canon(b.sum)) ch.push(['sum', b.sum])
  for (const [k, x] of b.by) { const y = a.by.get(k); if (y === undefined || canon(y) !== canon(x)) ch.push(['by', k, x]) }
  for (const k of a.by.keys()) if (!b.by.has(k)) ch.push(['by', k, DEL])
  if (canon(a.top) !== canon(b.top)) ch.push(['top', b.top])
  for (const [k, x] of b.gt) { const y = a.gt.get(k); if (y === undefined || canon(y) !== canon(x)) ch.push(['gt', k, x]) }
  for (const k of a.gt.keys()) if (!b.gt.has(k)) ch.push(['gt', k, DEL])
  return ch
}
const chId = (c) => (c[0] === 'by' || c[0] === 'gt' ? c[0] + '\u0000' + c[1] : c[0])
export function cloneCells(c) { return { len: c.len, sum: c.sum, by: new Map(c.by), top: c.top, gt: new Map(c.gt) } }
export function applyToCells(cells, ch) {
  for (const c of ch) {
    if (c[0] === 'len') cells.len = c[1]
    else if (c[0] === 'sum') cells.sum = c[1]
    else if (c[0] === 'top') cells.top = c[1]
    else { const m = cells[c[0]]; if (c[2] === DEL) m.delete(c[1]); else m.set(c[1], c[2]) }
  }
}

// ── coalescing: two frames in a row of one stream become one ─────────────────────────────────────────
export function mergeFrames(f1, f2, mutate) {
  const out = new Map()
  for (const e of f1.e) out.set(e.k, e)
  for (const e2 of f2.e) {
    const e1 = out.get(e2.k)
    if (e1 === undefined || e2.pic) { out.set(e2.k, e2); continue }
    if (e1.pic) { const cells = cloneCells(e1.cells); applyToCells(cells, e2.ch); out.set(e2.k, { k: e2.k, from: -1, to: e2.to, pic: true, cells, sp: e2.sp ?? e1.sp }); continue }
    let ch
    if (mutate === 'coalescedrop') ch = e2.ch
    else { const m = new Map(); for (const c of e1.ch) m.set(chId(c), c); for (const c of e2.ch) m.set(chId(c), c); ch = [...m.values()] }
    out.set(e2.k, { k: e2.k, from: e1.from, to: e2.to, ch, sp: e2.sp ?? e1.sp })
  }
  return { g: f2.g, e: [...out.values()], merged: (f1.merged ?? 1) + (f2.merged ?? 1), sp: mergeSp(f1.sp, f2.sp) }
}
function mergeSp(a, b) { if (!a) return b; if (!b) return a; const m = new Map(a); for (const [s, p] of b) if (!(m.get(s) >= p)) m.set(s, p); return [...m] }

// ── a host: one copy of one group, folding the group's log and sending its partials' frames ────────────
export class Host {
  constructor(gid, { mutate = '', early = false, slotOf }) {
    this.gid = gid; this.mutate = mutate; this.early = early; this.slotOf = slotOf
    this.group = mutate === 'pergroup'
    this.rows = new Map() // slot -> Map(key -> row): the slots this copy serves
    this.pos = new Map() // slot -> position
    this.side = new Map() // slot -> { N, rows }: a slot being imported (B1's R2: kept apart until open)
    this.cells = new Map() // partial key -> cells
    this.gseq = 0 // pergroup: the group partial's own position
    this.out = [] // the stream: frames not yet taken
    this.emit = true
  }
  key(s) { return this.group ? 'g' + this.gid : s }
  slotCells(s) { return computeCells([this.rows.get(s) ?? this.side.get(s).rows], this.mutate) }
  groupCells() { return computeCells([...this.rows.values()], this.mutate) }
  push(f) { if (this.emit) this.out.push(f) }
  // pergroup: recompute the one group partial and send its changes, with the touched slots' positions for the oracle
  groupFrame(sp) {
    const k = this.key(0)
    const old = this.cells.get(k) ?? emptyCells(this.mutate)
    const nw = this.groupCells()
    this.cells.set(k, nw)
    const from = this.gseq
    this.gseq++
    this.push({ g: this.gid, e: [{ k, from, to: this.gseq, ch: diffCells(old, nw) }], sp })
  }
  feed(e, applyRec) {
    if (e.kind === 'commit') {
      const touched = new Map()
      for (const it of e.items) {
        const rows = this.rows.get(it.slot)
        if (rows === undefined) throw new Error(`group ${this.gid} got a commit for slot ${it.slot} it does not serve`)
        if (!touched.has(it.slot)) touched.set(it.slot, this.pos.get(it.slot))
        applyRec(rows, it.rec)
        this.pos.set(it.slot, it.seq)
      }
      const sp = [...touched.keys()].map((s) => [s, this.pos.get(s)])
      if (this.group) { this.groupFrame(sp); return }
      const ents = []
      for (const [s, from] of touched) {
        const old = this.cells.get(s) ?? emptyCells(this.mutate)
        const nw = this.slotCells(s)
        this.cells.set(s, nw)
        ents.push({ k: s, from, to: this.pos.get(s), ch: diffCells(old, nw) })
      }
      this.push({ g: this.gid, e: ents, sp })
    } else if (e.kind === 'import') {
      this.side.set(e.slot, { N: e.N0, rows: new Map(e.rows) })
      if (this.early && !this.group) { const c = this.slotCells(e.slot); this.cells.set(e.slot, c); this.push({ g: this.gid, e: [{ k: e.slot, from: -1, to: e.N0, pic: true, cells: c }], sp: [[e.slot, e.N0]] }) }
    } else if (e.kind === 'delta') {
      const sc = this.side.get(e.slot)
      if (sc === undefined) return
      const from = sc.N
      for (const it of e.items) { applyRec(sc.rows, it.rec); sc.N = it.seq }
      if (this.early && !this.group && e.items.length > 0) {
        const old = this.cells.get(e.slot)
        const nw = this.slotCells(e.slot)
        this.cells.set(e.slot, nw)
        this.push({ g: this.gid, e: [{ k: e.slot, from, to: sc.N, ch: diffCells(old, nw) }], sp: [[e.slot, sc.N]] })
      }
    } else if (e.kind === 'fence') {
      this.rows.delete(e.slot); this.pos.delete(e.slot)
      if (this.group) this.groupFrame([])
      else this.cells.delete(e.slot)
    } else if (e.kind === 'open') {
      const sc = this.side.get(e.slot)
      if (sc === undefined || sc.N !== e.N) throw new Error(`open(${e.slot}, ${e.N}) at group ${this.gid} without its copy at N (have ${sc?.N})`)
      this.side.delete(e.slot)
      this.rows.set(e.slot, sc.rows); this.pos.set(e.slot, e.N)
      if (this.group) { this.groupFrame([[e.slot, e.N]]); return }
      const c = this.slotCells(e.slot)
      this.cells.set(e.slot, c)
      if (this.early) return // already sent at import
      if (this.mutate === 'nopicture') return
      this.push({ g: this.gid, e: [{ k: e.slot, from: -1, to: e.N, pic: true, cells: c }], sp: [[e.slot, e.N]] })
    }
  }
  // a new stream (a failover to this copy, or a new combiner): S3, every slot it serves starts with a picture
  pictures() {
    if (this.group) {
      const k = this.key(0)
      const c = this.cells.get(k) ?? emptyCells(this.mutate)
      this.push({ g: this.gid, e: [{ k, from: -1, to: this.gseq, pic: true, cells: c }], sp: [...this.pos] })
      return
    }
    if (this.mutate === 'nopicture') return
    const ents = []
    for (const [s, p] of this.pos) ents.push({ k: s, from: -1, to: p, pic: true, cells: this.cells.get(s) ?? emptyCells(this.mutate) })
    if (this.early) for (const [s, sc] of this.side) ents.push({ k: s, from: -1, to: sc.N, pic: true, cells: this.cells.get(s) })
    if (ents.length > 0) this.push({ g: this.gid, e: ents, sp: ents.map((x) => [x.k, x.to]) })
  }
}

// ── the combiner: holds every slot's cells (not rows) and the merged answers ────────────────────────────
export class Combiner {
  constructor({ mutate = '', keys, fresh = false }) {
    this.mutate = mutate
    this.pos = new Map() // partial key -> position (-1: nothing yet, after a rebuild)
    this.cells = new Map()
    for (const k of keys) { this.pos.set(k, fresh ? -1 : 0); this.cells.set(k, emptyCells(mutate)) }
    this.len = 0
    this.sum = newAcc(); this.fsum = 0 // fsum: the planted 'rounded' running total
    this.by = new Map() // bucket -> { c, acc, maxes: Map(key -> m), merged }
    this.gt = new Map() // row key -> row
    this.st = { frames: 0, entries: 0, applied: 0, dropped: 0, pictures: 0, gaps: 0, cellsChanged: 0, merged: 0 }
    this.missing = fresh ? keys.length : 0
  }
  ready() { return this.missing === 0 }
  // take one cell's contribution out (sign -1) or in (+1)
  putBy(k, b, cell, sign) {
    let t = this.by.get(b)
    if (t === undefined) this.by.set(b, (t = { c: 0, acc: newAcc(), f: 0, maxes: new Map(), merged: undefined }))
    t.c += sign * cell.c
    if (this.mutate === 'rounded') t.f += sign * cell.s; else putState(t.acc, cell.s, sign)
    if (sign < 0) { if (this.mutate !== 'extmerged') t.maxes.delete(k) }
    else if (cell.m !== undefined) {
      if (this.mutate === 'extmerged') { if (t.merged === undefined || maxBetter(cell.m, t.merged)) t.merged = cell.m }
      else t.maxes.set(k, cell.m)
    }
    if (t.c === 0) this.by.delete(b)
  }
  swapSlot(k, oldC, newC) { // replace one partial's whole contribution
    this.len += newC.len - oldC.len
    if (this.mutate === 'rounded') this.fsum += newC.sum - oldC.sum
    else { putState(this.sum, oldC.sum, -1); putState(this.sum, newC.sum, 1) }
    for (const [b, cell] of oldC.by) this.putBy(k, b, cell, -1)
    for (const [b, cell] of newC.by) this.putBy(k, b, cell, 1)
    for (const rk of oldC.gt.keys()) this.gt.delete(rk)
    for (const [rk, row] of newC.gt) this.gt.set(rk, row)
  }
  applyCh(k, cells, ch) {
    for (const c of ch) {
      this.st.cellsChanged++
      if (c[0] === 'len') { this.len += c[1] - cells.len; cells.len = c[1] }
      else if (c[0] === 'sum') {
        if (this.mutate === 'rounded') this.fsum += c[1] - cells.sum
        else { putState(this.sum, cells.sum, -1); putState(this.sum, c[1], 1) }
        cells.sum = c[1]
      } else if (c[0] === 'top') cells.top = c[1]
      else if (c[0] === 'by') {
        const old = cells.by.get(c[1])
        if (old !== undefined) this.putBy(k, c[1], old, -1)
        if (c[2] === DEL) cells.by.delete(c[1]); else { cells.by.set(c[1], c[2]); this.putBy(k, c[1], c[2], 1) }
      } else if (c[0] === 'gt') {
        if (c[2] === DEL) { cells.gt.delete(c[1]); this.gt.delete(c[1]) } else { cells.gt.set(c[1], c[2]); this.gt.set(c[1], c[2]) }
      }
    }
  }
  setPos(k, p) { if (this.pos.get(k) === -1 && p >= 0) this.missing--; this.pos.set(k, p) }
  take(f) {
    this.st.frames++
    if (f.merged) this.st.merged += f.merged - 1
    for (const e of f.e) {
      this.st.entries++
      const k = e.k
      let pos = this.pos.get(k)
      if (pos === undefined) { this.pos.set(k, (pos = 0)); this.cells.set(k, emptyCells(this.mutate)) } // a new group's partial starts empty at 0
      if (e.pic) {
        if (this.mutate !== 'nor1' && e.to <= pos) { this.st.dropped++; continue } // S2: never back
        const old = this.cells.get(k)
        let nw = e.cells
        if (this.mutate === 'mergepic') { nw = cloneCells(old); nw.len = e.cells.len; nw.sum = e.cells.sum; nw.top = e.cells.top; for (const [b, x] of e.cells.by) nw.by.set(b, x); for (const [rk, x] of e.cells.gt) nw.gt.set(rk, x) }
        else nw = cloneCells(nw)
        this.swapSlot(k, old, nw)
        this.cells.set(k, nw)
        this.setPos(k, e.to)
        this.st.pictures++; this.st.applied++
        continue
      }
      if (this.mutate !== 'nor1' && e.to <= pos) { this.st.dropped++; continue } // S2: already have it
      if (e.from > pos) { // a gap: a frame from after a change this combiner never saw
        this.st.gaps++
        if (this.mutate !== 'nopicture' && this.mutate !== 'nor1') throw new Error(`gap at ${k}: have ${pos}, frame (${e.from}, ${e.to}]`)
      }
      this.applyCh(k, this.cells.get(k), e.ch)
      this.setPos(k, e.to)
      this.st.applied++
    }
  }
  // the merged answers
  answers() {
    const byLen = new Map(), bySum = new Map(), byMax = new Map()
    for (const [b, t] of this.by) {
      byLen.set(b, t.c)
      if (this.mutate === 'rounded') bySum.set(b, t.f === 0 ? 0 : t.f)
      else bySum.set(b, t.acc.value())
      let m
      if (this.mutate === 'extmerged') m = t.merged
      else for (const v of t.maxes.values()) if (m === undefined || maxBetter(v, m)) m = v
      if (m !== undefined) byMax.set(b, m)
    }
    const cand = []
    for (const c of this.cells.values()) for (const r of c.top) cand.push(r)
    cand.sort(this.mutate === 'ties' ? (a, b) => cmpKey({ ...a, id: '' }, { ...b, id: '' }) : cmpKey)
    const sum = this.mutate === 'rounded' ? (this.fsum === 0 ? 0 : this.fsum) : this.sum.value()
    return { len: this.len, sum, byLen, bySum, byMax, top: cand.slice(0, K).map((r) => r.id), gt: this.gt }
  }
}
