// E-57 B4, XB-11: lookup(other, field), a live many-to-one join by key, built small on data's public API.
//   data's part (N5): over two data sources in one process, a left view and a cache of the other side's rows,
//     a reverse index from the other side's key to the left keys that name it; the output is a data source of
//     frozen { row, other } keyed by the left key, written once per input commit.
//   fero's part: one link per distinct key the left rows name, counted by how many name it; a new key costs one
//     trip (a picture after a delay); at count zero the link lingers, then ends; every link ends with the view.
//   other: the other row at this process's position for it; null when the picture (or a later record) says no
//     such row; undefined only while the key's first picture is on its way (XB-11's three states).
// Planted (mutate): reverse (the reverse index is not moved when a left row's field changes), count (a link's
//   count is not released when a left row stops naming it), undef (a removed other row reads undefined).
import { D, laneOf } from './ops.mjs'

export class Lookup {
  constructor(leftView, field, net, { linger = 5, mutate = '' } = {}) {
    this.field = field; this.net = net; this.linger = linger; this.mutate = mutate
    this.out = D.$({}); this.outLane = laneOf(this.out)
    this.cache = D.$({}); this.cacheLane = laneOf(this.cache) // the other side's rows held here, by the links
    this.cacheNode = this.cache[D.node]
    this.rev = new Map() // other key -> Set of left keys
    this.at = new Map() // left key -> the other key it is indexed under
    this.links = new Map() // other key -> { count, state: 'loading' | 'ready', idle: step when count reached 0 }
    this.left = new Map() // left key -> row (as the left view last gave it)
    this.trips = 0; this.closed = 0; this.ended = false
    this.pend = []
    this.cacheSink = this.cache.sink({ init: () => {}, apply: (b) => { for (const d of b.rows) this.touchOther(d.key) } })
    this.leftSink = leftView.sink({
      init: (snap) => { for (const [k, row] of snap) this.onLeft(k, undefined, row); this.flush() },
      apply: (b) => { for (const d of b.rows) this.onLeft(d.key, d.op === 'add' ? undefined : d.prev, d.op === 'remove' ? undefined : d.row); this.flush() },
    })
  }
  otherOf(ok) {
    const l = this.links.get(ok)
    if (l === undefined || l.state === 'loading') return undefined
    if (this.cacheNode.hasRow(ok)) return this.cacheNode.rowAt(ok)
    return this.mutate === 'undef' ? undefined : null
  }
  joined(k) {
    const row = this.left.get(k)
    return Object.freeze({ row, other: this.otherOf(row[this.field]) })
  }
  take(ok, step) {
    let l = this.links.get(ok)
    if (l === undefined) { l = { count: 0, state: 'loading', idle: -1 }; this.links.set(ok, l); this.trips++; this.net.open(ok) }
    l.count++
    l.idle = -1
  }
  release(ok, step) {
    const l = this.links.get(ok)
    l.count--
    if (l.count === 0) l.idle = this.net.now()
  }
  onLeft(k, prev, row) {
    const f = this.field
    const po = prev === undefined ? undefined : prev[f], no = row === undefined ? undefined : row[f]
    if (row === undefined) this.left.delete(k); else this.left.set(k, row)
    if (po !== no) {
      if (prev !== undefined && (this.mutate !== 'reverse' || row === undefined)) { this.rev.get(this.at.get(k))?.delete(k); this.at.delete(k) }
      if (row !== undefined && (this.mutate !== 'reverse' || prev === undefined)) { let s = this.rev.get(no); if (!s) this.rev.set(no, (s = new Set())); s.add(k); this.at.set(k, no) }
      if (prev !== undefined && !(this.mutate === 'count' && row !== undefined)) this.release(po)
      if (row !== undefined) this.take(no)
    }
    if (row === undefined) this.pend.push({ type: 2, key: [k] })
    else this.pend.push({ type: 1, key: [], at: k, value: null, k })
  }
  touchOther(ok) { const s = this.rev.get(ok); if (s) for (const k of s) this.pend.push({ type: 1, key: [], at: k, value: null, k }) }
  flush() { // one output commit per input commit
    if (this.pend.length === 0) return
    const recs = []
    const done = new Set()
    for (let i = this.pend.length - 1; i >= 0; i--) { // last write per key wins
      const p = this.pend[i]
      const k = p.type === 2 ? p.key[0] : p.k
      if (done.has(k)) continue
      done.add(k)
      if (p.type === 2) { if (this.out[D.node].hasRow(k)) recs.push({ type: 2, key: [k] }) }
      else recs.push(this.out[D.node].hasRow(k) ? { type: 0, key: [k], value: this.joined(k) } : { type: 1, key: [], at: k, value: this.joined(k) })
    }
    this.pend = []
    if (recs.length) this.outLane(recs.reverse())
  }
  // the network: a picture of key ok (row or null) arrives; a later record of ok arrives
  picture(ok, row) {
    const l = this.links.get(ok)
    if (l === undefined) return
    l.state = 'ready'
    if (row === null) { if (this.cacheNode.hasRow(ok)) this.cacheLane([{ type: 2, key: [ok] }]) }
    else this.cacheLane([this.cacheNode.hasRow(ok) ? { type: 0, key: [ok], value: row } : { type: 1, key: [], at: ok, value: row }])
    this.touchOther(ok) // undefined -> a row or null, even when the cache did not change
    this.flush()
  }
  record(ok, row) {
    const l = this.links.get(ok)
    if (l === undefined || l.state !== 'ready') return
    if (row === null) { if (this.cacheNode.hasRow(ok)) this.cacheLane([{ type: 2, key: [ok] }]) }
    else this.cacheLane([this.cacheNode.hasRow(ok) ? { type: 0, key: [ok], value: row } : { type: 1, key: [], at: ok, value: row }])
    this.flush()
  }
  tick() { // links whose linger is over end
    const now = this.net.now()
    for (const [ok, l] of this.links) if (l.count === 0 && l.idle >= 0 && now - l.idle >= this.linger) this.endLink(ok)
  }
  endLink(ok) {
    this.links.delete(ok); this.closed++; this.net.close(ok)
    if (this.cacheNode.hasRow(ok)) this.cacheLane([{ type: 2, key: [ok] }])
  }
  end() { // the view ends: every link with it, no sink after
    for (const ok of [...this.links.keys()]) this.endLink(ok)
    this.leftSink.dispose(); this.cacheSink.dispose(); this.ended = true
  }
  openLinks() { let n = 0; for (const l of this.links.values()) if (l.count > 0) n++; return n }
}
