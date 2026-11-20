// E-57 B1: one data store for a whole resource, fed by slot (PLAN 1.5).
//   R0  the store holds every slot: it folds every group it follows, and takes a picture of a group it follows
//       by state subscribe (the hold: 'all' path), as one commit of differences.
//   R1  per slot, a record at or below the store's position for that slot is dropped.
//   R2  an importing group's copy of a slot is kept apart until `open(s, N)`. At open: if the store is already at
//       N for s, the copy is dropped; if it is below N, the store takes the copy as ONE commit of differences and
//       its position for s becomes N.
// Planted bugs (never set in a measured run):
//   r2  the importing copy feeds the store as it arrives (rows upserted, its delta through R1), open does nothing
//   r1  no drop: a record at or below the position applies again (the position only moves up)
import { D, NODE, laneOf } from './ops.mjs'
import { slotOf, canon } from './lib.mjs'

export class SlotStore {
  constructor({ slots, mutate = '' }) {
    this.src = D.$({})
    this.rejects = []
    this.lane = laneOf(this.src, this.rejects)
    this.node = this.src[NODE]
    this.pos = new Float64Array(slots)
    this.side = new Map() // 'slot:importing group' -> { N, rows: Map }   (R2: kept apart; a slot can move twice while this store lags)
    this.keys = Array.from({ length: slots }, () => new Set()) // the store's keys per slot, for diffs
    this.mutate = mutate
    this.st = { recs: 0, r1drops: 0, r2kept: 0, r2drop: 0, r2diff: 0, r2diffRecs: 0, pictures: 0, pictureRecs: 0, commits: 0 }
    this.moved = new Set() // slots whose position changed in the last feed (for the oracle's cut)
  }
  has(k) { return this.node.hasRow(k) }
  row(k) { return this.node.rowAt(k) }
  apply(recs) {
    if (recs.length === 0) return
    this.lane(recs)
    this.st.commits++
    for (const r of recs) {
      const k = r.type === 1 ? r.at : r.key[0]
      const s = slotOf(k)
      if (this.has(k)) this.keys[s].add(k); else this.keys[s].delete(k)
    }
  }
  setPos(s, p) { if (this.pos[s] !== p) { this.pos[s] = p; this.moved.add(s) } }
  // records of one group commit: [{ slot, seq, rec }]
  feedCommit(items) {
    const out = []
    for (const it of items) {
      this.st.recs++
      if (it.seq <= this.pos[it.slot]) {
        if (this.mutate !== 'r1') { this.st.r1drops++; continue } // R1
        out.push(it.rec)
        continue
      }
      out.push(it.rec)
      this.setPos(it.slot, it.seq)
    }
    this.apply(out)
  }
  // a diff of slot s's rows in the store against `rows` (a Map), as records
  diffRecs(s, rows, out) {
    for (const k of this.keys[s]) if (!rows.has(k)) out.push({ type: 2, key: [k] })
    for (const [k, row] of rows) {
      if (!this.has(k)) out.push({ type: 1, key: [], at: k, value: row })
      else if (canon(this.row(k)) !== canon(row)) out.push({ type: 0, key: [k], value: row })
    }
  }
  feedImport(s, N0, rows, gid) {
    if (this.mutate === 'r2') { // planted: upsert the copy now
      const out = []
      for (const [k, row] of rows) out.push(this.has(k) ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row })
      this.apply(out)
      return
    }
    this.st.r2kept++
    const cur = this.side.get(s + ':' + gid)
    if (cur === undefined || cur.N < N0) this.side.set(s + ':' + gid, { N: N0, rows: new Map(rows) })
  }
  feedDelta(s, items, applyTo, gid) { // the delta since ready: records of s from N0 + 1 to N
    if (this.mutate === 'r2') { this.feedCommit(items); return }
    const sc = this.side.get(s + ':' + gid)
    if (sc === undefined) return // a re-delivered delta after open: nothing kept apart any more
    for (const it of items) { if (it.seq <= sc.N) continue; applyTo(sc.rows, it.rec); sc.N = it.seq }
  }
  feedOpen(s, N, gid) {
    if (this.mutate === 'r2') return
    const sc = this.side.get(s + ':' + gid)
    this.side.delete(s + ':' + gid)
    if (this.pos[s] >= N) { this.st.r2drop++; return }
    if (sc === undefined || sc.N !== N) throw new Error(`open(${s}, ${N}) without its copy at N (have ${sc?.N})`)
    const out = []
    this.diffRecs(s, sc.rows, out)
    this.st.r2diff++
    this.st.r2diffRecs += out.length
    this.apply(out) // ONE commit of differences
    this.setPos(s, N)
  }
  // R0: a picture of a group by state subscribe. slots: [{ slot, P, rows }] the slots the group serves, at P;
  // sides: [{ slot, N, rows }] the group's importing copies (kept apart, R2). One commit for the whole picture.
  feedPicture(slots, sides, gid) {
    const out = []
    const up = []
    for (const { slot, P, rows } of slots) {
      if (P <= this.pos[slot]) continue // never back
      this.diffRecs(slot, rows, out)
      up.push([slot, P])
    }
    this.st.pictures++
    this.st.pictureRecs += out.length
    this.apply(out)
    for (const [s, P] of up) this.setPos(s, P)
    for (const { slot, N, rows } of sides) {
      const cur = this.side.get(slot + ':' + gid)
      if (cur === undefined || cur.N < N) this.side.set(slot + ':' + gid, { N, rows: new Map(rows) })
    }
  }
}
