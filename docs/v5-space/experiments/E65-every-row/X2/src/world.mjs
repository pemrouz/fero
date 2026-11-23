// E-65 X2: the world a scan runs in. Plain JavaScript, one process, no network, no Raft, no data.
//
//   S slots, G groups, C copies per group. A group is one log (its committed entries, in order). A copy is one
//   server's replica of one group: it applies the group's log at its own pace (a follower lags), holds the rows
//   of the slots it holds, by slot, and can fail (its local state is lost) and be replaced from a live peer.
//
//   Log entries:
//     w      a commit: 1 to 4 rows of this group's slots (a multi-row commit may touch several slots)
//     fence  a slot move's first half, at the old group A: A stops taking writes to the slot and keeps its rows
//     open   the second half, at the new group B: the slot's rows as they were at the fence, and its position
//     drop   the third step, at A, after the open: A lets the slot's rows go
//     pin    a scan's pin (the "cut" mode only): from here on, every copy keeps each pinned row's image as it was
//            at the pin, the first time the row changes
//     unpin  the end of a pin
//   A slot's POSITION counts the commits that touched it; a move carries it (E-19), so it never goes back.
//
//   The truth is kept apart from the copies: every key's history by slot position (for a cut) and by world step
//   (for the "no cut" mode), and every multi-slot commit's slots and positions (to find a torn commit).
import { rng } from './lib.mjs'

export const ABSENT = Symbol('absent') // a saved image of a row that did not exist at the pin

export function slotOf(k, S) {
  let h = 0x811c9dc5
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13
  return (h >>> 0) % S
}

// ── a copy: one server's replica of one group ──────────────────────────────────────────────────────────────
export class Copy {
  constructor(g, id, S, bugs) {
    this.g = g; this.id = id; this.S = S; this.bugs = bugs
    this.alive = true
    this.applied = 0 // entries of the group's log applied
    this.rows = new Map() // slot -> Map(key -> row)
    this.held = new Map() // slot -> 'own' | 'fenced'
    this.spos = new Map() // slot -> position
    this.pins = new Map() // replicated pins: id -> { id, index, slots: Set, saved: Map(k -> row|ABSENT), bySlot: Map(s -> Set(k)), spos: Map, saver }
    this.local = new Map() // the "slot" mode's local pins: `${scan}:${s}` -> { s, pos, saved: Map, keys: [] }
  }
  // the first time a pinned row changes, keep its image as it was at the pin
  save(k, s, before) {
    const img = before === undefined ? ABSENT : before
    for (const p of this.pins.values()) {
      if (!p.slots.has(s)) continue
      if (p.saver !== undefined && p.saver !== this.id) continue // bug 'localpin': only one copy keeps images
      if (p.saved.has(k) && !this.bugs.everysave) continue
      p.saved.set(k, img)
      let b = p.bySlot.get(s); if (!b) p.bySlot.set(s, (b = new Set())); b.add(k)
    }
    for (const lp of this.local.values()) {
      if (lp.s !== s) continue
      if (lp.saved.has(k) && !this.bugs.everysave) continue
      lp.saved.set(k, img)
    }
  }
  apply(e) {
    const idx = this.applied + 1
    switch (e.t) {
      case 'w':
        for (const { k, s, row } of e.recs) {
          let m = this.rows.get(s)
          if (!m) this.rows.set(s, (m = new Map()))
          this.save(k, s, m.get(k))
          if (row === undefined) m.delete(k); else m.set(k, row)
        }
        for (const [s, p] of e.sp) this.spos.set(s, p)
        break
      case 'fence': this.held.set(e.s, 'fenced'); break
      case 'open': {
        const m = new Map(this.rows.get(e.s) ?? [])
        // the open's rows are a change to this copy's rows of the slot: a pin that holds the slot (the slot
        // moved away and is now coming back) keeps their images first (bug 'opennosave' skips it)
        if (!this.bugs.opennosave) for (const [k] of e.rows) this.save(k, e.s, m.get(k))
        const nm = new Map(e.rows)
        this.rows.set(e.s, nm)
        this.held.set(e.s, 'own'); this.spos.set(e.s, e.pos)
        break
      }
      case 'drop': {
        const m = this.rows.get(e.s)
        if (m && !this.bugs.dropnosave) for (const [k, row] of m) this.save(k, e.s, row)
        this.rows.delete(e.s); this.held.delete(e.s)
        break
      }
      case 'pin': {
        const slots = new Set(this.held.keys())
        const spos = new Map(); for (const s of slots) spos.set(s, this.spos.get(s) ?? 0)
        this.pins.set(e.id, { id: e.id, index: idx, slots, saved: new Map(), bySlot: new Map(), spos, saver: e.saver })
        break
      }
      case 'unpin': this.pins.delete(e.id); break
    }
    this.applied = idx
  }
  // a new copy placed by healing: a picture of a live peer's state; it carries the peer's open pins and their
  // images (bug 'pinnotcarried': the pins come without their images)
  static from(peer, id, bugs) {
    const c = new Copy(peer.g, id, peer.S, bugs)
    c.applied = peer.applied
    for (const [s, m] of peer.rows) c.rows.set(s, new Map(m))
    c.held = new Map(peer.held); c.spos = new Map(peer.spos)
    for (const [pid, p] of peer.pins) {
      const q = { ...p, slots: new Set(p.slots), spos: new Map(p.spos), saved: new Map(), bySlot: new Map(), saver: p.saver === undefined ? undefined : -1 }
      if (!bugs.pinnotcarried) { q.saved = new Map(p.saved); for (const [s, ks] of p.bySlot) q.bySlot.set(s, new Set(ks)) }
      c.pins.set(pid, q)
    }
    return c
  }
}

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────
export class World {
  constructor({ seed = 1, G = 4, S = 64, C = 3, keys = 800, multi = 0.2, moveP = 0.02, failP = 0.01, lagMax = 25, wps = 2, moveLen = 15, bugs = {} }) {
    this.r = rng(seed * 2654435761 + 7)
    Object.assign(this, { G, S, C, nkeys: keys, multi, moveP, failP, lagMax, wps, moveLen, bugs })
    this.step = 0
    this.owner = new Int32Array(S) // the group that takes writes to the slot; -1 while a move is between fence and open
    this.spos = new Int32Array(S)
    for (let s = 0; s < S; s++) this.owner[s] = s % G
    this.truth = new Map()
    this.hist = new Map() // k -> [[slot position, row]]
    this.histT = new Map() // k -> [[step, row]]
    this.slotKeys = Array.from({ length: S }, () => new Set())
    this.keyName = Array.from({ length: keys }, (_, i) => 'k' + i.toString(36) + (i % 7 === 0 ? 'é' : ''))
    this.slotOfKey = this.keyName.map((k) => slotOf(k, S))
    this.multiSlot = [] // { g, idx, slots: [[s, pos]] } for commits that touched two or more slots
    this.groups = []
    this.nextCopy = 0
    for (let g = 0; g < G; g++) {
      const grp = { g, log: [], copies: [] }
      for (let c = 0; c < C; c++) {
        const cp = new Copy(g, this.nextCopy++, S, bugs)
        for (let s = 0; s < S; s++) if (s % G === g) { cp.held.set(s, 'own'); cp.spos.set(s, 0) }
        grp.copies.push(cp)
      }
      this.groups.push(grp)
    }
    this.moves = [] // in flight: { s, A, B, mid, stage: 'fenced' | 'opened', due }
    this.nextMove = 1
    this.dead = [] // { g, due }
    this.st = { commits: 0, recs: 0, moves: 0, movesDone: 0, fails: 0, heals: 0 }
  }
  append(g, e) { this.groups[g].log.push(e); return this.groups[g].log.length }
  liveCopies(g) { return this.groups[g].copies.filter((c) => c.alive) }

  // one commit: 1 key, or (multi) 2 to 4 keys of one group, which may sit in several slots
  write() {
    const r = this.r
    const i0 = Math.floor(r() * this.nkeys)
    const g = this.owner[this.slotOfKey[i0]]
    if (g < 0) return // the slot is between fence and open: the write is refused `retry`
    const ks = [i0]
    if (r() < this.multi) {
      const want = 1 + Math.floor(r() * 3)
      for (let t = 0; t < 40 && ks.length <= want; t++) {
        const j = Math.floor(r() * this.nkeys)
        if (!ks.includes(j) && this.owner[this.slotOfKey[j]] === g) ks.push(j)
      }
    }
    const recs = [], touched = new Set()
    for (const i of ks) {
      const k = this.keyName[i], s = this.slotOfKey[i]
      const cur = this.truth.get(k)
      let row
      const u = r()
      if (cur === undefined) row = { v: Math.floor(r() * 1000), n: 1 }
      else if (u < 0.15) row = undefined
      else row = { v: Math.floor(r() * 1000), n: cur.n + 1 }
      recs.push({ k, s, row })
      touched.add(s)
    }
    const sp = new Map()
    for (const s of touched) sp.set(s, ++this.spos[s])
    const idx = this.append(g, { t: 'w', recs, sp })
    for (const { k, s, row } of recs) {
      if (row === undefined) { this.truth.delete(k); this.slotKeys[s].delete(k) } else { this.truth.set(k, row); this.slotKeys[s].add(k) }
      let h = this.hist.get(k); if (!h) this.hist.set(k, (h = [])); h.push([sp.get(s), row])
      let t = this.histT.get(k); if (!t) this.histT.set(k, (t = [])); t.push([this.step, row])
    }
    if (touched.size > 1) this.multiSlot.push({ g, idx, slots: [...sp] })
    this.st.commits++; this.st.recs += recs.length
  }

  // a slot move in three steps: fence at A, open at B (after 1 to 15 steps), drop at A (after 1 to 15 more)
  startMove() {
    if (this.G < 2) return
    const r = this.r
    const s = Math.floor(r() * this.S)
    const A = this.owner[s]
    if (A < 0 || this.moves.some((m) => m.s === s)) return
    let B = Math.floor(r() * (this.G - 1)); if (B >= A) B++
    const mid = this.nextMove++
    this.append(A, { t: 'fence', s, to: B, mid })
    this.owner[s] = -1
    this.moves.push({ s, A, B, mid, stage: 'fenced', due: this.step + 1 + Math.floor(r() * this.moveLen) })
    this.st.moves++
  }
  advanceMoves() {
    for (const m of [...this.moves]) {
      if (this.step < m.due) continue
      if (m.stage === 'fenced') {
        const rows = [...this.slotKeys[m.s]].map((k) => [k, this.truth.get(k)])
        this.append(m.B, { t: 'open', s: m.s, from: m.A, mid: m.mid, rows, pos: this.spos[m.s] })
        this.owner[m.s] = m.B
        m.stage = 'opened'; m.due = this.step + 1 + Math.floor(this.r() * this.moveLen)
      } else {
        this.append(m.A, { t: 'drop', s: m.s, mid: m.mid })
        this.moves.splice(this.moves.indexOf(m), 1)
        this.st.movesDone++
      }
    }
  }
  // where the slot is now, as the leaders' slot table says: its owner, or the group that fenced it
  whereNow(s) {
    if (this.owner[s] >= 0) return this.owner[s]
    return this.moves.find((m) => m.s === s).A
  }

  // copies apply the log at their own pace; a copy fails and is replaced from a live peer after 5 to 30 steps
  advanceCopies() {
    const r = this.r
    for (const grp of this.groups) {
      const n = grp.log.length
      for (const c of grp.copies) {
        if (!c.alive) continue
        let k = r() < 0.5 ? 1 + Math.floor(r() * 3) : 0
        if (n - c.applied > this.lagMax) k = n - c.applied - this.lagMax
        while (k-- > 0 && c.applied < n) c.apply(grp.log[c.applied])
      }
    }
    if (r() < this.failP) {
      const g = Math.floor(r() * this.G)
      const live = this.liveCopies(g)
      if (live.length > 1) {
        const c = live[Math.floor(r() * live.length)]
        c.alive = false; this.st.fails++
        this.dead.push({ g, c, due: this.step + 5 + Math.floor(r() * 25) })
      }
    }
    for (const d of [...this.dead]) {
      if (this.step < d.due) continue
      const live = this.liveCopies(d.g)
      const peer = live[Math.floor(r() * live.length)]
      const grp = this.groups[d.g]
      grp.copies[grp.copies.indexOf(d.c)] = Copy.from(peer, this.nextCopy++, this.bugs)
      this.dead.splice(this.dead.indexOf(d), 1); this.st.heals++
    }
  }
  // one world step: wps commits (2 by default), maybe a move, the moves in flight, the copies
  tick() {
    this.step++
    for (let i = 0; i < this.wps; i++) this.write()
    if (this.r() < this.moveP) this.startMove()
    this.advanceMoves()
    this.advanceCopies()
  }

  // the leader's answer at a pin: what the group held at log index idx (own or fenced), and each slot's position
  heldAt(g, idx) {
    const held = new Map(), spos = new Map()
    for (let s = 0; s < this.S; s++) if (s % this.G === g) { held.set(s, 'own'); spos.set(s, 0) }
    const log = this.groups[g].log
    for (let i = 0; i < idx; i++) {
      const e = log[i]
      if (e.t === 'w') for (const [s, p] of e.sp) spos.set(s, p)
      else if (e.t === 'fence') held.set(e.s, 'fenced')
      else if (e.t === 'open') { held.set(e.s, 'own'); spos.set(e.s, e.pos) }
      else if (e.t === 'drop') held.delete(e.s)
    }
    return { held, spos }
  }

  // the leader's answer after a pin: the position of the first commit on slot s after log index idx, if any yet
  firstPosAfter(g, idx, s) {
    const log = this.groups[g].log
    for (let i = idx; i < log.length; i++) { const e = log[i]; if (e.t === 'w' && e.sp.has(s)) return e.sp.get(s) }
    return undefined
  }

  // ── the truth ──
  rowAtPos(k, p) { // a key's row at its slot's position p
    const h = this.hist.get(k)
    if (!h) return undefined
    let lo = 0, hi = h.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= p) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans < 0 ? undefined : h[ans][1]
  }
  rowAtStep(k, t) {
    const h = this.histT.get(k)
    if (!h) return undefined
    let ans
    for (const [st, row] of h) { if (st <= t) ans = row; else break }
    return ans
  }
}
