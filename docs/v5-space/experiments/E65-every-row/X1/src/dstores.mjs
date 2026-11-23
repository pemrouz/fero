// E-65 X1: the asker's row stores on data's real engine (DATA, read only).
//   OneStore      R0 today: one data source for the whole resource, fed in lanes of records.
//   BlockStores   S data sources inside one process, one per fixed BLOCK of slots (block = slot mod S), so no
//                 source nears data's 16,777,216-row ceiling and a slot move between groups never moves a row
//                 between sources. Reads over every row cross the S sources: get routes by the key's block; a
//                 scan visits each source; an operator keeps one view per source and combines them (rule B3).
//   GroupStores   the other way to split: one source per GROUP. A slot move then moves the slot's rows from the
//                 old group's source to the new one's when the move reaches the asker (rule B4).
//   ProjStore     one source holding only the fields the asker's code reads (a projection): a whole row is cut
//                 to those fields; a write to another field is dropped.
// Each has apply(recs), get(k), count(), each(fn(k, row)), field(f, fn(v)), and optional live views.
// Planted bugs (mutate): 'route' (get and fold pick the block by different functions), 'nomigrate' (GroupStores:
// a slot move does not move the slot's rows), 'topshort' (each source gives only k/2 rows to the combined top k),
// 'medmed' (the combined median is the median of the sources' medians).
import { slotOf } from './lib.mjs'
import { SortedCol } from './compact.mjs'

let D = null
export const useData = (d) => { D = d }
const NODE = Symbol.for('data.v4.node'), VALUE = Symbol.for('data.v4.value')
function source() { const src = D.$({}); const lane = D.lane(src, { onReject: (rj) => { throw rj.error } }); return { src, lane, node: src[NODE] } }
const keyOf = (r) => (r.type === 1 ? r.at : r.key[0])
const isNum = (x) => typeof x === 'number' && x === x

export class OneStore {
  constructor() { this.s = source() }
  apply(recs) { this.s.lane(recs) }
  get(k) { return this.s.node.get(k) }
  count() { return this.s.node.rowCount() }
  each(fn) { this.s.node.each((k, row) => fn(k, row)) }
  field(f, fn) { this.s.node.each((k, row) => { if (row && typeof row === 'object' && f in row) fn(row[f]) }) }
  views({ k = 10, median = true } = {}) { // data's own live views over the one source
    const s = this.s.src
    this.v = { sum: s.sum('cents'), len: s.length(), top: s.za('score', k), med: median ? s.median('score') : null }
    return this
  }
  // the top k as numeric scores: when fewer than k rows have a score, data's window also holds rows with none
  read() { const v = this.v; return { sum: v.sum[VALUE], len: v.len[VALUE], top: v.top[VALUE].map((r) => r.score).filter(isNum), med: v.med ? v.med[VALUE] : undefined } }
}

export class BlockStores {
  constructor(S, { mutate = '', blockOf = null } = {}) {
    this.S = S; this.mutate = mutate
    this.blockOf = blockOf ?? ((k) => slotOf(k) % S)
    this.st = Array.from({ length: S }, source)
    this.parts = Array.from({ length: S }, () => [])
  }
  apply(recs) { // split one batch by block: one lane call per block that has records
    const parts = this.parts
    for (const r of recs) parts[this.blockOf(keyOf(r))].push(r)
    for (let i = 0; i < this.S; i++) if (parts[i].length) { this.st[i].lane(parts[i]); parts[i] = [] }
  }
  readBlock(k) { return this.mutate === 'route' ? (slotOf(k) >> 3) % this.S : this.blockOf(k) }
  get(k) { return this.st[this.readBlock(k)].node.get(k) }
  count() { let n = 0; for (const s of this.st) n += s.node.rowCount(); return n }
  each(fn) { for (const s of this.st) s.node.each((k, row) => fn(k, row)) }
  field(f, fn) { for (const s of this.st) s.node.each((k, row) => { if (row && typeof row === 'object' && f in row) fn(row[f]) }) }
  // live views: one data view per source, combined at read (B3); the median from ONE sorted column fed by every
  // source's row deltas (data's median does not combine), or, with perSourceMedian, data's median per source
  views({ k = 10, median = true, perSourceMedian = false } = {}) {
    this.k = k
    this.v = this.st.map((s) => ({ sum: s.src.sum('cents'), len: s.src.length(), top: s.src.za('score', k), med: perSourceMedian || this.mutate === 'medmed' ? s.src.median('score') : null }))
    if (median && !perSourceMedian) {
      const col = (this.col = new SortedCol())
      const num = (x) => (typeof x === 'number' && x === x ? x : undefined)
      for (const s of this.st) {
        s.node.each((_, row) => { const x = num(row?.score); if (x !== undefined) col.insert(x) })
        s.src.sink({ apply(b) { for (const d of b.rows) { const o = d.op === 'add' ? undefined : num(d.prev?.score), n = d.op === 'remove' ? undefined : num(d.row?.score); if (o === n) continue; if (o !== undefined) col.remove(o); if (n !== undefined) col.insert(n) } } })
      }
    }
    return this
  }
  read() {
    const v = this.v, k = this.k
    let sum = 0, len = 0, cands = []
    for (const x of v) {
      const s = x.sum[VALUE]; if (typeof s === 'number') sum += s
      len += x.len[VALUE]
      const top = x.top[VALUE]
      for (let i = 0; i < (this.mutate === 'topshort' ? Math.min(k >> 1, top.length) : top.length); i++) if (isNum(top[i].score)) cands.push(top[i].score)
    }
    cands.sort((a, b) => b - a)
    let med
    if (this.mutate === 'medmed') { const ms = v.map((x) => this.medOf(x)).filter((m) => m !== undefined).sort((a, b) => a - b); med = ms.length ? ms[ms.length >> 1] : undefined }
    else if (this.col) med = this.col.median()
    return { sum, len, top: cands.slice(0, k), med }
  }
  medOf(x) { if (x.med) return x.med[VALUE]; return undefined }
}

// One source per group. owner: slot -> the group whose source holds that slot's rows, as the asker knows it.
export class GroupStores {
  constructor(G, { mutate = '' } = {}) {
    this.G = G; this.mutate = mutate
    this.st = new Map(); for (let g = 0; g < G; g++) this.st.set(g, source())
    this.owner = new Map(); this.moved = 0
  }
  _src(g) { let s = this.st.get(g); if (!s) { s = source(); this.st.set(g, s) } return s }
  // apply one group's records; a record of a slot the asker's map gives another group first moves that slot's
  // rows (B4): one remove in the old source and one insert in the new, per row of the slot
  applyFrom(g, recs) {
    for (const r of recs) {
      const k = keyOf(r), s = slotOf(k)
      const o = this.owner.get(s)
      if (o !== undefined && o !== g && this.mutate !== 'nomigrate') {
        const from = this._src(o), to = this._src(g), rm = [], add = []
        from.node.each((key, row) => { if (slotOf(key) === s) { rm.push({ type: 2, key: [key] }); add.push({ type: 1, key: [], at: key, value: row }) } })
        if (rm.length) { from.lane(rm); to.lane(add); this.moved += rm.length }
      }
      this.owner.set(s, g)
      this._src(g).lane([r])
    }
  }
  get(k) { const g = this.owner.get(slotOf(k)); return g === undefined ? undefined : this._src(g).node.get(k) }
  count() { let n = 0; for (const s of this.st.values()) n += s.node.rowCount(); return n }
  each(fn) { for (const s of this.st.values()) s.node.each((k, row) => fn(k, row)) }
}

export class ProjStore extends OneStore { // views and read() as OneStore's
  constructor(fields) { super(); this.f = new Set(fields); this.fields = fields }
  cut(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) return v; const o = {}; for (const f of this.fields) if (f in v) o[f] = v[f]; return o }
  apply(recs) {
    const out = []
    for (const r of recs) {
      if (r.type === 1) out.push({ type: 1, key: [], at: r.at, value: this.cut(r.value) })
      else if (r.key.length === 1) out.push(r.type === 0 ? { type: 0, key: r.key, value: this.cut(r.value) } : r)
      else if (this.f.has(r.key[1])) out.push(r)
    }
    if (out.length) this.s.lane(out)
  }
  get(k) { return this.s.node.get(k) }
  count() { return this.s.node.rowCount() }
  each(fn) { this.s.node.each((k, row) => fn(k, row)) }
  field(f, fn) { this.s.node.each((k, row) => { if (row && typeof row === 'object' && f in row) fn(row[f]) }) }
}
