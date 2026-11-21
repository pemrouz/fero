// E-64 O2: count-by and sum-by derived from the change stream alone, with before-images.
//   A SHARE is a fixed set of source slots (slot % S). One RUNNER owns a share at a time. It reads the enriched
//   items of its slots from whichever group holds each slot, in each slot's order, and keeps NO rows: for each
//   change it subtracts the "before" from the old bucket and adds the "after" to the new bucket.
//   It folds the changes of a WINDOW (up to W entries) into one delta per bucket, then writes, to each output
//   partition that has deltas, one batch: the deltas and a MARK that covers a range of source positions per
//   slot of its share: from (what it believes the partition has) and to (the window's end).
//   The TARGET keeps, per output partition: the buckets (an Acc each: exact sum and row count; an emptied
//   bucket goes) and, per share, the mark vector. It applies a batch only if its `from` equals the stored mark
//   for every slot it names; a batch already applied is answered `dup`, any other is refused `gap`, and the
//   runner then starts again from the stored marks.
//   RESTART: a new runner reads every output partition's marks. Its cursor per slot is the lowest mark over
//   the partitions; while it replays, it sends a change's delta to a partition only if the change is past THAT
//   partition's own mark (the floor). Writes to one partition go out in order (issue-order); a crash may lose
//   the tail of the outbox, and some of it may still arrive later (a zombie).
//   Target layouts: 'one' puts every bucket in one output partition (one atomic batch per window: the whole
//   view sits at one cut); 'spread' hashes buckets over P partitions (each sits at its own cut).
// Planted bugs (never set in a measured run):
//   nobefore   the runner ignores the before-image: it only adds the after
//   nomark     the target applies every batch, with no mark check
//   memcursor  a restart resumes from the runner's own last position, not from the target's marks
//   nofilter   a restart sends every replayed change to every partition (no per-partition floor)
//   float      the sums are float running totals (op.incr), not exact accumulators
import { Acc, bkey, slotHash } from './lib.mjs'

const partOf = (b, P) => (P === 1 ? 0 : slotHash(b, P))

export class Target {
  constructor({ P = 1, mutate = '' }) {
    this.P = P; this.mutate = mutate
    this.parts = Array.from({ length: P }, () => ({ rows: new Map(), marks: new Map() }))
    this.st = { ok: 0, dup: 0, gap: 0, deltas: 0, bare: 0 }
  }
  marksOf(o, share) { return this.parts[o].marks.get(share) }
  apply(w) {
    const part = this.parts[w.o]
    let m = part.marks.get(w.share)
    if (!m) { m = new Map(); part.marks.set(w.share, m) }
    if (this.mutate !== 'nomark') {
      let same = true, covered = true
      for (const [s, to] of w.to) { const have = m.get(s) ?? 0; if (have !== (w.from.get(s) ?? 0)) same = false; if (to > have) covered = false }
      if (!same) { if (covered) { this.st.dup++; return 'dup' } this.st.gap++; return 'gap' }
    }
    for (const [s, to] of w.to) m.set(s, to)
    if (w.deltas.length === 0) this.st.bare++
    for (const [b, d] of w.deltas) {
      let a = part.rows.get(b)
      if (!a) { a = new Acc(d.plain); part.rows.set(b, a) }
      a.merge(d)
      if (a.empty()) part.rows.delete(b) // an emptied bucket goes (C5)
      this.st.deltas++
    }
    this.st.ok++
    return 'ok'
  }
}

export class Runner {
  constructor({ world, share, S, target, W = 16, bare = 0.1, mutate = '', r }) {
    Object.assign(this, { world, share, S, target, W, bare, mutate, r })
    this.mySlots = []
    for (let s = 0; s < world.slots; s++) if (s % S === share) this.mySlots.push(s)
    this.outbox = []
    this.inc = 0
    this.st = { items: 0, changes: 0, windows: 0, writes: 0, restarts: 0, blocked: 0, redelivered: 0, scannedRows: 0, waits: 0 }
    this.start()
  }
  start() { // a new incarnation: read every partition's marks (none of them carry this runner's memory)
    this.inc++
    const P = this.target.P
    this.floor = []
    const keepMem = this.mutate === 'memcursor' && this.pos
    for (let o = 0; o < P; o++) {
      const m = keepMem ? this.lastTo[o] : this.target.marksOf(o, this.share)
      const f = new Map()
      for (const s of this.mySlots) f.set(s, m?.get(s) ?? 0)
      this.floor.push(f)
    }
    this.lastTo = this.floor.map((f) => new Map(f))
    this.pos = new Map()
    for (const s of this.mySlots) { let lo = Infinity; for (const f of this.floor) lo = Math.min(lo, f.get(s)); this.pos.set(s, lo) }
    if (this.mutate === 'nofilter') for (const f of this.floor) for (const s of this.mySlots) f.set(s, this.pos.get(s))
    this.gcur = new Int32Array(this.world.G) // a SUB per slot set from the cursor; here: each group's stream from its start
    this.win = new Map() // bucket -> { o, d: Acc }
    this.winTo = new Map() // slot -> last position in this window
    this.winN = 0
  }
  crash() { // memory goes; the outbox tail is lost, and part of it may still arrive later
    const keep = Math.floor(this.r() * (this.outbox.length + 1))
    const zombie = this.outbox.slice(0, keep).filter(() => this.r() < 0.5)
    this.outbox = []
    this.st.restarts++
    this.start()
    return zombie
  }
  // the delta of one change, into the window, for the partitions whose floor this change is past
  addChange(s, p, c) {
    const plain = this.mutate === 'float'
    const put = (u, v, sign) => {
      const b = bkey(u)
      if (b === undefined) return
      const o = partOf(b, this.target.P)
      if (p <= this.floor[o].get(s)) return // that partition already has this change
      let e = this.win.get(b)
      if (!e) { e = { o, d: new Acc(plain) }; this.win.set(b, e) }
      e.d.addRow(v, sign)
    }
    if (c.b && this.mutate !== 'nobefore') put(c.b.u, c.b.c, -1)
    if (c.a) put(c.a.u, c.a.c, +1)
    this.st.changes++
  }
  // read one item from one group, if it is this share's next one; false when nothing could be read there
  pull(g) {
    if (this.world.down === g) return false // that group's copies cannot be reached
    const stream = this.world.groups[g].stream
    let i = this.gcur[g]
    while (i < stream.length && stream[i].slot % this.S !== this.share) i++
    this.gcur[g] = i
    if (i >= stream.length) return false
    const it = stream[i]
    if (it.kind !== 'w') { this.gcur[g] = i + 1; return true } // fence and open: positions carry on in the next group
    const have = this.pos.get(it.slot)
    if (it.pos <= have) { this.gcur[g] = i + 1; this.st.redelivered++; return true }
    if (it.pos > have + 1) { this.st.blocked++; return false } // the slot's earlier entries are in its old group
    for (const c of it.ch) this.addChange(it.slot, it.pos, c)
    this.pos.set(it.slot, it.pos)
    this.winTo.set(it.slot, it.pos)
    this.winN++
    this.st.items++
    this.gcur[g] = i + 1
    return true
  }
  redeliver() { const g = Math.floor(this.r() * this.world.G); this.gcur[g] = Math.max(0, this.gcur[g] - 1 - Math.floor(this.r() * 50)) }
  flush(force = false) {
    if (this.winN === 0 && !force) return
    const P = this.target.P
    const per = Array.from({ length: P }, () => [])
    for (const [b, e] of this.win) per[e.o].push([b, e.d]) // a net-zero delta is sent too: harmless, and simpler
    for (let o = 0; o < P; o++) {
      const bareMark = this.r() < this.bare || P === 1
      if (per[o].length === 0 && !bareMark) continue
      const from = new Map(), to = new Map()
      for (const [s, p] of this.winTo) { const f = this.lastTo[o].get(s); if (p > f) { from.set(s, f); to.set(s, p); this.lastTo[o].set(s, p) } }
      if (to.size === 0 && per[o].length === 0) continue
      this.outbox.push({ o, share: this.share, inc: this.inc, from, to, deltas: per[o] })
      this.st.writes++
    }
    this.win = new Map(); this.winTo = new Map(); this.winN = 0
    this.st.windows++
  }
  tick() {
    const g = Math.floor(this.r() * this.world.G)
    const n = Math.floor(this.r() * 3)
    for (let i = 0; i < n; i++) if (!this.pull(g)) break
    if (this.winN >= 1 + Math.floor(this.r() * this.W)) this.flush()
  }
  drain() { // read everything there is, flush, then raise every partition's mark to this runner's position
    let moved = true
    while (moved) { moved = false; for (let g = 0; g < this.world.G; g++) while (this.pull(g)) moved = true }
    this.flush(true)
    for (let o = 0; o < this.target.P; o++) {
      const from = new Map(), to = new Map()
      for (const s of this.mySlots) { const f = this.lastTo[o].get(s), p = this.pos.get(s); if (p > f) { from.set(s, f); to.set(s, p); this.lastTo[o].set(s, p) } }
      if (to.size) { this.outbox.push({ o, share: this.share, inc: this.inc, from, to, deltas: [] }); this.st.writes++ }
    }
  }
}

// the oracle: each output partition must equal the pure query, restricted to its buckets, at its own cut
export function checkTarget(world, target, S, pure) {
  let bad = 0, checked = 0, cutsDiffer = 0
  const cuts = []
  for (let o = 0; o < target.P; o++) {
    const cut = new Int32Array(world.slots)
    for (let s = 0; s < world.slots; s++) cut[s] = target.marksOf(o, s % S)?.get(s) ?? 0
    cuts.push(cut)
    const want = pure(world.rowsAt(cut).map(([, row]) => row), (b) => partOf(b, target.P) === o)
    const have = target.parts[o].rows
    checked += want.size
    if (want.size !== have.size) { bad++; continue }
    for (const [b, v] of want) { const a = have.get(b); if (!a) { bad++; break } const x = a.value(); if (x.count !== v.count || !Object.is(x.sum, v.sum) && !(Number.isNaN(x.sum) && Number.isNaN(v.sum))) { bad++; break } }
  }
  for (let o = 1; o < cuts.length; o++) for (let s = 0; s < world.slots; s++) if (cuts[o][s] !== cuts[0][s]) { cutsDiffer++; break }
  return { bad, checked, cutsDiffer: cutsDiffer > 0 ? 1 : 0, cuts }
}

// what a reader of the whole target sees when partitions sit at different cuts: a row moved between two
// buckets in two partitions can be counted in both or in neither (counted here, per check)
export function crossAnomalies(world, target, cuts) {
  if (target.P === 1) return 0
  let anomalies = 0
  for (const [k] of world.hist) {
    let seen = 0, alwaysB = true
    for (let o = 0; o < target.P; o++) {
      const row = world.rowAt(k, cuts[o])
      const b = row === undefined ? undefined : bkey(row.user)
      if (b === undefined) alwaysB = false
      else if (partOf(b, target.P) === o) seen++
    }
    if (seen >= 2 || (seen === 0 && alwaysB)) anomalies++ // counted twice, or counted nowhere though it always had a bucket
  }
  return anomalies
}

// ── Form B: partials per share, replaced on restart (no marks, no history, before-images only live) ─────────
// The target holds, per share, the share's own partial (bucket -> Acc) and the cut it stands at, under the
// share's owner token: think of a depth-2 resource whose partition is the share and whose rows are buckets.
// A new runner takes a new token, scans its share's rows at the copies (they hold them anyway), sends the
// partial as one REPLACE (a room write), then follows the live stream from the scan's cut with delta batches
// under its token. A batch from an older token is refused `fenced`; one whose `from` is not the stored cut is
// refused `gap`, and the runner starts again. The answer is the sum of the shares' partials per bucket.
// Planted: nofence (old tokens' batches are not refused by token; the position check still runs), nocheck
// (neither the token nor the position is checked), noreplace (a restart keeps the stored partial and skips to
// the copies' cut: what was lost in flight stays lost).
let TOKENS = 0
export class TargetB {
  constructor({ S, mutate = '' }) { this.S = S; this.mutate = mutate; this.shares = Array.from({ length: S }, () => ({ token: 0, rows: new Map(), at: new Map() })); this.st = { ok: 0, fenced: 0, gap: 0, replaces: 0, deltas: 0 } }
  apply(w) {
    const sh = this.shares[w.share]
    if (w.token < sh.token && this.mutate !== 'nofence' && this.mutate !== 'nocheck') { this.st.fenced++; return 'fenced' }
    if (w.kind === 'replace') { sh.token = w.token; sh.rows = w.rows; sh.at = new Map(w.at); this.st.replaces++; this.st.ok++; return 'ok' }
    if (w.token !== sh.token && this.mutate !== 'nofence' && this.mutate !== 'nocheck') { this.st.fenced++; return 'fenced' }
    if (this.mutate !== 'nocheck') for (const [s, to] of w.to) if ((sh.at.get(s) ?? 0) !== w.from.get(s)) { this.st.gap++; return 'gap' }
    for (const [s, to] of w.to) sh.at.set(s, to)
    for (const [b, d] of w.deltas) { let a = sh.rows.get(b); if (!a) { a = new Acc(d.plain); sh.rows.set(b, a) } a.merge(d); if (a.empty()) sh.rows.delete(b); this.st.deltas++ }
    this.st.ok++
    return 'ok'
  }
}
export class RunnerB {
  constructor({ world, share, S, target, W = 16, mutate = '', r }) {
    Object.assign(this, { world, share, S, target, W, mutate, r })
    this.mySlots = []
    for (let s = 0; s < world.slots; s++) if (s % S === share) this.mySlots.push(s)
    this.outbox = []
    this.st = { items: 0, changes: 0, windows: 0, writes: 0, restarts: 0, blocked: 0, redelivered: 0, scannedRows: 0, waits: 0 }
    this.first = true
    this.start()
  }
  start() {
    // the scan needs every group that holds a slot of this share: while one is down, the restart waits
    if (this.world.down >= 0 && this.mySlots.some((s) => this.world.owner[s] === this.world.down)) { this.waiting = true; this.outbox = []; return }
    this.waiting = false
    this.token = ++TOKENS
    const rows = this.world.scan((s) => s % this.S === this.share) // at the copies: their rows of this share, now
    this.st.scannedRows += rows.length
    this.pos = new Map()
    for (const s of this.mySlots) this.pos.set(s, this.world.spos[s])
    this.gcur = new Int32Array(this.world.G)
    for (let g = 0; g < this.world.G; g++) this.gcur[g] = this.world.groups[g].stream.length
    this.lastTo = new Map(this.pos)
    if (this.mutate === 'noreplace' && !this.first) {
      this.token = this.target.shares[this.share].token // keeps the old partial, carries on from the copies' cut
      this.lastTo = new Map(this.target.shares[this.share].at)
    } else {
      const part = new Map()
      for (const [, row] of rows) { const b = bkey(row.user); if (b === undefined) continue; let a = part.get(b); if (!a) { a = new Acc(); part.set(b, a) } a.addRow(row.cents, +1) }
      this.outbox.push({ kind: 'replace', share: this.share, token: this.token, rows: part, at: new Map(this.pos) })
    }
    this.first = false
    this.win = new Map(); this.winTo = new Map(); this.winN = 0
  }
  crash() { const keep = Math.floor(this.r() * (this.outbox.length + 1)); const zombie = this.outbox.slice(0, keep).filter(() => this.r() < 0.5); this.outbox = []; this.st.restarts++; this.start(); return zombie }
  addChange(c) {
    const put = (u, v, sign) => { const b = bkey(u); if (b === undefined) return; let d = this.win.get(b); if (!d) { d = new Acc(); this.win.set(b, d) } d.addRow(v, sign) }
    if (c.b) put(c.b.u, c.b.c, -1)
    if (c.a) put(c.a.u, c.a.c, +1)
    this.st.changes++
  }
  pull(g) {
    if (this.world.down === g) return false
    const stream = this.world.groups[g].stream
    let i = this.gcur[g]
    while (i < stream.length && stream[i].slot % this.S !== this.share) i++
    this.gcur[g] = i
    if (i >= stream.length) return false
    const it = stream[i]
    if (it.kind !== 'w') { this.gcur[g] = i + 1; return true }
    const have = this.pos.get(it.slot)
    if (it.pos <= have) { this.gcur[g] = i + 1; this.st.redelivered++; return true }
    if (it.pos > have + 1) { this.st.blocked++; return false }
    for (const c of it.ch) this.addChange(c)
    this.pos.set(it.slot, it.pos); this.winTo.set(it.slot, it.pos); this.winN++; this.st.items++
    this.gcur[g] = i + 1
    return true
  }
  redeliver() { const g = Math.floor(this.r() * this.world.G); this.gcur[g] = Math.max(0, this.gcur[g] - 1 - Math.floor(this.r() * 50)) }
  flush() {
    if (this.winN === 0) return
    const from = new Map(), to = new Map()
    for (const [s, p] of this.winTo) { from.set(s, this.lastTo.get(s)); to.set(s, p); this.lastTo.set(s, p) }
    this.outbox.push({ kind: 'delta', share: this.share, token: this.token, from, to, deltas: [...this.win] })
    this.st.writes++; this.st.windows++
    this.win = new Map(); this.winTo = new Map(); this.winN = 0
  }
  tick() {
    if (this.waiting) { this.st.waits++; this.start(); if (this.waiting) return }
    const g = Math.floor(this.r() * this.world.G); const n = Math.floor(this.r() * 3); for (let i = 0; i < n; i++) if (!this.pull(g)) break; if (this.winN >= 1 + Math.floor(this.r() * this.W)) this.flush()
  }
  drain() { if (this.waiting) this.start(); let moved = true; while (moved) { moved = false; for (let g = 0; g < this.world.G; g++) while (this.pull(g)) moved = true } this.flush() }
}
export function checkTargetB(world, target, S, pure) {
  let bad = 0
  const cut = new Int32Array(world.slots)
  for (let sh = 0; sh < S; sh++) {
    const T = target.shares[sh]
    for (let s = sh; s < world.slots; s += S) cut[s] = T.at.get(s) ?? 0
  }
  const rows = world.rowsAt(cut)
  for (let sh = 0; sh < S; sh++) { // each share's partial, at its own cut
    const want = pure(rows.filter(([k]) => world.slotOf(k) % S === sh).map(([, row]) => row))
    const have = target.shares[sh].rows
    if (want.size !== have.size) { bad++; continue }
    for (const [b, v] of want) { const a = have.get(b); const x = a?.value(); if (!a || x.count !== v.count || !(Object.is(x.sum, v.sum) || (Number.isNaN(x.sum) && Number.isNaN(v.sum)))) { bad++; break } }
  }
  // the answer a reader gets: the shares' partials added per bucket, against the pure query at the combined cut
  const merged = new Map()
  for (const T of target.shares) for (const [b, a] of T.rows) { let m = merged.get(b); if (!m) { m = new Acc(); merged.set(b, m) } m.merge(a) }
  for (const [b, m] of merged) if (m.empty()) merged.delete(b)
  const want = pure(rows.map(([, row]) => row))
  let mergedBad = want.size !== merged.size ? 1 : 0
  if (!mergedBad) for (const [b, v] of want) { const x = merged.get(b)?.value(); if (!x || x.count !== v.count || !(Object.is(x.sum, v.sum) || (Number.isNaN(x.sum) && Number.isNaN(v.sum)))) { mergedBad = 1; break } }
  return { bad, mergedBad, cut }
}
