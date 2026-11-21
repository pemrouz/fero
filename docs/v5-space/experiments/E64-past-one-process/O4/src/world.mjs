// E-64 O4: the source resource, as groups that each hold only their own slots' rows (no process holds every row).
//   G groups, SLOTS slots. A slot belongs to one group at a time and keeps its own position (a count of the
//   entries written to it), carried by a move (E-19). Each group has a log and one copy: a data store (data
//   63fea66, read only) that folds the group's entries. A data sink on the copy sees each commit's row deltas
//   with `prev`, the row before (data contract/delta.ts; E-54), so the copy knows each changed row before and
//   after: that is what the ROUTER needs to send a "leave" to the old output key's shard.
//   The group's stream holds one item per entry: { kind: 'w', slot, pos, ch: [{ k, b, a }] } (b and a: the
//   projected row before and after), and the slot moves: { kind: 'fence' } at the old group and { kind: 'open' }
//   at the new one. A move drops and takes the rows at the copies with the sink off, so it is never a change.
// The truth: every row's history per key, as (slot position, row after), so a test can ask for the rows at any
// cut (one position per slot) without data.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { rng, slotHash, makeRow, genCents, genUser, genScore, keyName, proj, canon } from './lib.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url)) // ../data next to the repo
export const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
export const NODE = Symbol.for('data.v4.node')

export class World {
  constructor({ seed = 1, G = 4, slots = 1024, keys = 600, dom = 'dirty', buckets = 20, moveEvery = 200 }) {
    this.r = rng(seed * 7919 + 17)
    Object.assign(this, { G, slots, nkeys: keys, dom, buckets, moveEvery })
    this.owner = new Int32Array(slots)
    for (let s = 0; s < slots; s++) this.owner[s] = s % G
    this.spos = new Int32Array(slots)
    this.truth = new Map()
    this.hist = new Map()
    this.slotOfKey = new Map()
    this.keysOfSlot = Array.from({ length: slots }, () => new Set())
    this.down = new Set() // groups that cannot be reached: no writes, no routing, no pictures
    this.groups = []
    for (let g = 0; g < G; g++) this.groups.push(this.makeGroup())
    this.st = { entries: 0, recs: 0, moves: 0, rowsMoved: 0, changes: 0 }
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
  rowAt(k, cut) { // the row of k at a cut, from the truth's history
    const h = this.hist.get(k)
    if (!h) return undefined
    const p = cut[this.slotOf(k)]
    let lo = 0, hi = h.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= p) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans < 0 ? undefined : h[ans][1]
  }
  // one write: an entry of 1 to 3 records on one key, in its slot's group (the same mix as E-64 O2)
  write() {
    const r = this.r
    let k, s, tries = 0
    do { k = keyName(Math.floor(r() * this.nkeys)); s = this.slotOf(k) } while (this.down.has(this.owner[s]) && ++tries < 50)
    if (this.down.has(this.owner[s])) return null
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
    this.st.entries++; this.st.recs += recs.length; this.st.changes += item.ch.length
    return item
  }
  // a slot move from its group A to another group B: A's fence, then B's open with the slot's rows
  move() {
    if (this.G < 2) return
    const r = this.r
    const s = Math.floor(r() * this.slots)
    const A = this.owner[s]
    let B = Math.floor(r() * (this.G - 1)); if (B >= A) B++
    if (this.down.has(A) || this.down.has(B)) return
    const ga = this.groups[A], gb = this.groups[B]
    const keys = [...this.keysOfSlot[s]]
    ga.suppress = true; gb.suppress = true
    if (keys.length) {
      ga.lane(keys.map((key) => ({ type: 2, key: [key] })))
      gb.lane(keys.map((key) => ({ type: 1, key: [], at: key, value: this.truth.get(key) })))
    }
    ga.suppress = false; gb.suppress = false
    ga.stream.push({ kind: 'fence', slot: s, pos: this.spos[s] })
    gb.stream.push({ kind: 'open', slot: s, pos: this.spos[s] })
    this.owner[s] = B
    this.st.moves++; this.st.rowsMoved += keys.length
  }
  // a slot's rows as its owner's copy holds them now: what a picture is cut from
  slotRows(s) {
    const node = this.groups[this.owner[s]].src[NODE]
    const rows = []
    for (const k of this.keysOfSlot[s]) rows.push([k, proj(node.rowAt(k))])
    return rows
  }
  // a check that each copy holds exactly the truth's rows of its slots (the world itself is sound)
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
