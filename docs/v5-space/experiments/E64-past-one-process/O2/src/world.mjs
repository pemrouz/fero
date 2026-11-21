// E-64 O2: the source resource, as groups that each hold only their own slots' rows.
//   G groups, SLOTS slots. A slot belongs to one group at a time and keeps its own position (a count of the
//   entries written to it), carried by a move (E-19). Each group has a log and one copy: a data store that folds
//   that group's entries and holds only that group's rows (a partial server: no process holds every row).
//   The ENRICHER is a data sink on each copy. data hands every commit's row deltas with `prev`, the row before
//   the batch, by reference (data contract/delta.ts; E-54). The enricher turns them into one item per log
//   entry: { slot, pos, ch: [{ k, b, a }] }, where b and a are the projected rows before and after (proj()).
//   An entry that touches no projected field still gives an item, so readers see its position.
//   A slot move is a fence entry at A and an open entry at B; the copies drop and take the slot's rows with the
//   enricher switched off, so a move is never read as a change.
// The truth: every row's history per key, as (slot position, row after), so a test can ask for the rows at
// any cut (one position per slot) without data.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { rng, slotHash, makeRow, genCents, genUser, genScore, keyName, proj, canon } from './lib.mjs'

// data's folder: DATA, else ../data next to the repo (as fero's own seam expects it)
const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url))
export const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
export const NODE = D.node

export class World {
  constructor({ seed = 1, G = 4, slots = 1024, keys = 600, dom = 'dirty', buckets = 20, moveEvery = 200, mutate = '' }) {
    this.r = rng(seed * 7919 + 13)
    Object.assign(this, { G, slots, nkeys: keys, dom, buckets, moveEvery, mutate })
    this.owner = new Int32Array(slots)
    for (let s = 0; s < slots; s++) this.owner[s] = s % G
    this.spos = new Int32Array(slots) // per-slot position: entries written to the slot
    this.truth = new Map() // key -> row (the head)
    this.hist = new Map() // key -> [[pos, row | undefined]]
    this.slotOfKey = new Map()
    this.keysOfSlot = Array.from({ length: slots }, () => new Set())
    this.groups = []
    for (let g = 0; g < G; g++) this.groups.push(this.makeGroup())
    this.st = { entries: 0, recs: 0, moves: 0, rowsMoved: 0, items: 0, changes: 0 }
  }
  makeGroup() {
    const src = D.$({})
    const lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
    const grp = { src, lane, stream: [], suppress: false, pending: null }
    src.sink({ apply: (b) => {
      if (grp.suppress) return
      for (const d of b.rows) grp.pending.push({ k: d.key, b: d.op === 'add' ? undefined : proj(d.prev), a: d.op === 'remove' ? undefined : proj(d.row) })
    } })
    return grp
  }
  slotOf(k) { let s = this.slotOfKey.get(k); if (s === undefined) { s = slotHash(k, this.slots); this.slotOfKey.set(k, s) } return s }
  rowAt(k, cut) { // the row of k at a cut (cut: Int32Array of slot positions), from the truth's history
    const h = this.hist.get(k)
    if (!h) return undefined
    const p = cut[this.slotOf(k)]
    let lo = 0, hi = h.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= p) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans < 0 ? undefined : h[ans][1]
  }
  rowsAt(cut, keep) { // every [key, row] at a cut, optionally only keys whose slot passes keep(s)
    const outRows = []
    for (const [k] of this.hist) {
      if (keep && !keep(this.slotOf(k))) continue
      const row = this.rowAt(k, cut)
      if (row !== undefined) outRows.push([k, row])
    }
    return outRows
  }
  // one write: an entry of 1 to 3 records on one key, in its slot's group
  write() {
    const r = this.r
    const k = keyName(Math.floor(r() * this.nkeys))
    const s = this.slotOf(k)
    const cur = this.truth.get(k)
    const recs = []
    let row = cur
    const n = r() < 0.85 ? 1 : 2 + Math.floor(r() * 2)
    for (let i = 0; i < n; i++) {
      if (row === undefined) { const v = makeRow(this.dom, r, this.buckets); recs.push({ type: 1, key: [], at: k, value: v }); row = v; continue }
      const u = r()
      if (u < 0.25) { const v = makeRow(this.dom, r, this.buckets); recs.push({ type: 0, key: [k], value: v }); row = v }
      else if (u < 0.55) { const v = genCents(this.dom, r); recs.push({ type: 0, key: [k, 'cents'], value: v }); row = { ...row, cents: v } }
      else if (u < 0.67) { const v = genUser(this.dom, r, this.buckets); if (v === undefined) { recs.push({ type: 2, key: [k, 'user'] }); row = { ...row }; delete row.user } else { recs.push({ type: 0, key: [k, 'user'], value: v }); row = { ...row, user: v } } }
      else if (u < 0.8) { const v = genScore(this.dom, r); recs.push({ type: 0, key: [k, 'score'], value: v }); row = { ...row, score: v } }
      else if (u < 0.88) { recs.push({ type: 0, key: [k, 'paid'], value: r() < 0.5 }); row = { ...row, paid: recs.at(-1).value } }
      else if (u < 0.91) { recs.push({ type: 2, key: [k, 'cents'] }); row = { ...row }; delete row.cents }
      else { recs.push({ type: 2, key: [k] }); row = undefined }
    }
    const pos = ++this.spos[s]
    const grp = this.groups[this.owner[s]]
    grp.pending = []
    grp.lane(recs)
    const item = { kind: 'w', slot: s, pos, ch: grp.pending }
    grp.pending = null
    grp.stream.push(item)
    if (row === undefined) { this.truth.delete(k); this.keysOfSlot[s].delete(k) } else { this.truth.set(k, row); this.keysOfSlot[s].add(k) }
    let h = this.hist.get(k)
    if (!h) { h = []; this.hist.set(k, h) }
    h.push([pos, row])
    this.st.entries++; this.st.recs += recs.length; this.st.items++; this.st.changes += item.ch.length
    return item
  }
  // a slot move from its group A to another group B: A's fence, then B's open with the slot's rows
  move() {
    if (this.G < 2) return
    const r = this.r
    const k = keyName(Math.floor(r() * this.nkeys))
    const s = this.slotOf(k)
    const A = this.owner[s]
    let B = Math.floor(r() * (this.G - 1)); if (B >= A) B++
    const ga = this.groups[A], gb = this.groups[B]
    const keys = [...this.keysOfSlot[s]]
    ga.suppress = true; gb.suppress = true
    if (keys.length) {
      ga.lane(keys.map((key) => ({ type: 2, key: [key] })))
      gb.lane(keys.map((key) => ({ type: 1, key: [], at: key, value: this.truth.get(key) })))
    }
    ga.suppress = false; gb.suppress = false
    ga.stream.push({ kind: 'fence', slot: s, pos: this.spos[s], to: B })
    gb.stream.push({ kind: 'open', slot: s, pos: this.spos[s], from: A })
    this.owner[s] = B
    this.st.moves++; this.st.rowsMoved += keys.length
  }
  step() {
    if (this.G > 1 && this.moveEvery > 0 && this.r() < 1 / this.moveEvery) this.move()
    return this.write()
  }
  // the rows a copy holds now, for a set of slots: what a scan at the copies returns (a refill), with the cut
  scan(keepSlot) {
    const rows = []
    for (let s = 0; s < this.slots; s++) {
      if (!keepSlot(s)) continue
      const src = this.groups[this.owner[s]].src[NODE]
      for (const k of this.keysOfSlot[s]) rows.push([k, src.rowAt(k)])
    }
    return rows
  }
  // a check that each copy holds exactly the truth's rows of its slots (the world is sound)
  checkCopies() {
    let bad = 0
    for (let g = 0; g < this.G; g++) {
      const node = this.groups[g].src[NODE]
      let n = 0
      node.each((k, row) => { n++; if (this.owner[this.slotOf(k)] !== g || canon(row) !== canon(this.truth.get(k))) bad++ })
      let want = 0
      for (let s = 0; s < this.slots; s++) if (this.owner[s] === g) want += this.keysOfSlot[s].size
      if (n !== want) bad++
    }
    return bad
  }
}
