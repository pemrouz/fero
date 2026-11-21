// E-64 O2: a top-k from the change stream, with a bounded buffer per share and a refill when it runs short.
//   The buffer holds every row of the share at or above a threshold tau (in za's order, ties by key), and
//   nothing else. A change: drop the key; if its "after" is at or above tau, put it back. Past kmax rows, keep
//   the best kp and raise tau to the last kept. Below k rows, REFILL: read the share's rows at the copies (a
//   scan: every row of the share's slots, at the copies' current positions), keep the best kp, set tau to the
//   kp-th (or no threshold if the share has fewer rows), and jump the read position of every slot to the
//   scan's cut. This is the bounded-buffer way to keep a top-k view up (Yi et al., ICDE 2003, from memory).
//   A top-k is a state, not a sum: a restart is a refill, and its output is written as a difference (the view
//   form's own steps), so it needs no marks.
// Planted bugs: nodrop (a buffered row that falls below tau stays), norefill (an underflow is ignored).
import { tup, cmpTup, pureTopK } from './lib.mjs'

export class TopRunner {
  constructor({ world, share, S, k = 10, kp = 20, kmax = 40, mutate = '', r }) {
    Object.assign(this, { world, share, S, k, kp, kmax, mutate, r })
    this.mySlots = []
    for (let s = 0; s < world.slots; s++) if (s % S === share) this.mySlots.push(s)
    this.st = { items: 0, changes: 0, refills: 0, refillRows: 0, trims: 0, restarts: 0, blocked: 0, maxBuf: 0 }
    this.refill()
  }
  inShare(s) { return s % this.S === this.share }
  refill() {
    const rows = this.world.scan((s) => this.inShare(s))
    this.st.refills++; this.st.refillRows += rows.length
    const ts = rows.map(([k, row]) => tup(k, row.score)).sort(cmpTup)
    this.buf = new Map()
    for (const t of ts.slice(0, this.kp)) this.buf.set(t.k, t)
    this.tau = ts.length >= this.kp ? ts[this.kp - 1] : null // null: every row of the share is held
    this.pos = new Map()
    for (const s of this.mySlots) this.pos.set(s, this.world.spos[s])
    this.gcur = new Int32Array(this.world.G)
    for (let g = 0; g < this.world.G; g++) this.gcur[g] = this.world.groups[g].stream.length // live from the cut
  }
  restart() { this.st.restarts++; this.refill() }
  change(c) {
    const had = this.buf.get(c.k)
    if (c.a) {
      const t = tup(c.k, c.a.s)
      if (this.tau === null || cmpTup(t, this.tau) <= 0) this.buf.set(c.k, t)
      else if (had && this.mutate === 'nodrop') this.buf.set(c.k, t)
      else this.buf.delete(c.k)
    } else this.buf.delete(c.k)
    this.st.changes++
    if (this.buf.size > this.kmax) {
      const ts = [...this.buf.values()].sort(cmpTup).slice(0, this.kp)
      this.buf = new Map(ts.map((t) => [t.k, t]))
      this.tau = ts[ts.length - 1]
      this.st.trims++
    }
    if (this.buf.size > this.st.maxBuf) this.st.maxBuf = this.buf.size
  }
  pull(g) {
    const stream = this.world.groups[g].stream
    let i = this.gcur[g]
    while (i < stream.length && !this.inShare(stream[i].slot)) i++
    this.gcur[g] = i
    if (i >= stream.length) return false
    const it = stream[i]
    if (it.kind !== 'w') { this.gcur[g] = i + 1; return true }
    const have = this.pos.get(it.slot)
    if (it.pos <= have) { this.gcur[g] = i + 1; return true }
    if (it.pos > have + 1) { this.st.blocked++; return false }
    for (const c of it.ch) this.change(c)
    this.pos.set(it.slot, it.pos)
    this.st.items++
    this.gcur[g] = i + 1
    if (this.buf.size < this.k && this.tau !== null && this.mutate !== 'norefill') this.refill()
    return true
  }
  tick() { const g = Math.floor(this.r() * this.world.G); const n = Math.floor(this.r() * 3); for (let i = 0; i < n; i++) if (!this.pull(g)) break }
  drain() { let moved = true; while (moved) { moved = false; for (let g = 0; g < this.world.G; g++) while (this.pull(g)) moved = true } }
  answer() { return [...this.buf.values()].sort(cmpTup).slice(0, this.k) }
}

// the oracle for one share, and for the merge of every share's answer (top k of the union)
export function checkTop(world, runners, k) {
  let bad = 0
  const cut = new Int32Array(world.slots)
  for (const R of runners) for (const s of R.mySlots) cut[s] = R.pos.get(s)
  const all = world.rowsAt(cut)
  for (const R of runners) {
    const want = pureTopK(all.filter(([key]) => R.inShare(world.slotOf(key))).map(([key, row]) => [key, row.score]), k)
    const have = R.answer().map((t) => t.k)
    if (want.join('\u0000') !== have.join('\u0000')) bad++
  }
  const want = pureTopK(all.map(([key, row]) => [key, row.score]), k)
  const have = runners.flatMap((R) => R.answer()).sort(cmpTup).slice(0, k).map((t) => t.k)
  const mergedBad = want.join('\u0000') !== have.join('\u0000') ? 1 : 0
  return { bad, mergedBad }
}
