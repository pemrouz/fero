// E-65 X2: the scanner. It reads every row of the resource once, in pages, from one copy of each group, and
// keeps nothing but where it is. Three promises, one class:
//
//   'none'  NO CUT. Each slot is read live, in key order, by a cursor (the last key sent). A row that existed
//           for the whole scan is read exactly once; any row read was the row at some moment of the scan.
//           Rules: N1 a copy answers only at or past the highest place the scanner saw of that group, and never
//           below the group's head when the scan began (the floor); N2 a page is "keys after the cursor", in
//           key order, so a resume at another copy or another group neither repeats nor skips; N3 a slot that
//           moved is followed to its new group with the same cursor.
//   'slot'  A CUT PER SLOT. A copy pins a slot when its first page is asked: from then on it keeps each of the
//           slot's rows as it was at the pin, the first time the row changes (a "saved image"). The scanner
//           keeps a slot's rows until the slot is done, then hands them on together, with the slot's position.
//           Rules: S1 the first change keeps the image, later ones do not; S2 a drop of the slot (the move's
//           third step) is a change too; S3 a slot is handed on only when whole, and started again from nothing
//           if its pin is lost; S4 the floor, as N1.
//   'cut'   ONE CUT FOR THE WHOLE RESOURCE: one position per group, consistent with every slot move. The scanner
//           writes a PIN entry into every group's log; every copy of the group keeps saved images from it, so the
//           pin survives a copy's failure. It then checks the moves against the pins and pins again any group that
//           is on the wrong side of a move, before it reads a row. Rules: C1 = S1, C2 = S2, C3 an open into a
//           pinned slot is a change too (a slot that left and came back); C4 the pin is in the log, so every copy
//           keeps images; C5 a copy placed by healing carries the open pins with their images; C6 a copy answers
//           only once it has applied the pin; C7 the pairing check: a slot's place in the cut is its highest
//           position in any group's log up to that group's pin (p); a group that holds it at p at its pin serves
//           it; if none does, the group that has the slot now is pinned again; a group with a commit on the slot
//           after its pin at a position at or below p is pinned again; then check again; C8 unpin at the end (a
//           lease, if the scanner dies). (A first form of C7 looked at the holders only, and failed 16 of 2,000
//           seeds: a slot that moved away and came back was read from an old frozen copy. It is kept as the
//           planted bug 'oldpair'.)
import { ABSENT } from './world.mjs'

export class Scan {
  constructor(w, { mode = 'none', P = 4, bugs = {}, id = 1, pinSpread = 8 }) {
    Object.assign(this, { w, mode, P, bugs, id, pinSpread })
    this.pinWait = 0
    this.done = false
    this.phase = mode === 'cut' ? 'pin' : 'scan'
    this.st = { pages: 0, waits: 0, failovers: 0, moved: 0, restarts: 0, pinsTaken: 0, repins: 0, rounds: 0, maxImages: 0, rows: 0, errs: 0 }
    this.r = w.r
  }
  start() {
    const w = this.w
    this.T0 = w.step
    this.spos0 = Int32Array.from(w.spos)
    this.floor = w.groups.map((g) => g.log.length)
    this.cur = w.groups.map((_, g) => this.pickCopy(g))
    this.q = w.groups.map(() => [])
    this.slot = []
    for (let s = 0; s < w.S; s++) this.slot.push({ g: -1, cursor: null, i: 0, buf: [], pinCopy: null, pos: -1, done: false })
    if (this.mode !== 'cut') for (let s = 0; s < w.S; s++) this.assign(s, w.whereNow(s))
    this.deliv = new Map() // 'none': key -> [rows]; 'slot' and 'cut': slot -> [{ rows: Map, pos }]
    this.pins = new Array(w.G).fill(null)
    this.toPin = [...Array(w.G).keys()]
  }
  pickCopy(g) { const l = this.w.liveCopies(g); return l[Math.floor(this.r() * l.length)] }
  assign(s, g) { this.slot[s].g = g; this.q[g].push(s) }
  copyFor(g) {
    let c = this.cur[g]
    if (!c.alive || !this.w.groups[g].copies.includes(c)) { c = this.cur[g] = this.pickCopy(g); this.st.failovers++; return [c, true] }
    return [c, false]
  }
  deliverRow(s, k, row) {
    this.st.rows++
    if (this.mode === 'none') { let a = this.deliv.get(k); if (!a) this.deliv.set(k, (a = [])); a.push(row); return }
    let d = this.deliv.get(s)
    if (!d) this.deliv.set(s, (d = []))
    if (!d.open) { d.open = { rows: new Map(), pos: this.slot[s].pos, dup: 0 }; d.push(d.open) }
    if (d.open.rows.has(k)) d.open.dup++
    d.open.rows.set(k, row)
  }
  closeSlot(s) { const d = this.deliv.get(s); if (d) d.open = null; else this.deliv.set(s, [{ rows: new Map(), pos: this.slot[s].pos, dup: 0 }]) }

  tick() {
    if (this.done) return
    if (this.phase === 'pin') return this.pinOne()
    if (this.phase === 'check') return this.check()
    const ready = []
    for (let g = 0; g < this.w.G; g++) if (this.q[g].length) ready.push(g)
    if (!ready.length) return this.finish()
    const g = ready[Math.floor(this.r() * ready.length)]
    const s = this.q[g][0]
    this.st.pages++
    if (this.mode === 'none') this.serveNone(g, s)
    else if (this.mode === 'slot') this.serveSlot(g, s)
    else this.serveCut(g, s)
  }
  finish() {
    this.done = true
    if (this.mode === 'cut') for (let g = 0; g < this.w.G; g++) this.w.append(g, { t: 'unpin', id: this.pins[g].id })
    this.T1 = this.w.step
  }
  next(g, s) { this.q[g].shift(); this.slot[s].done = true }
  moved(g, s) {
    this.st.moved++
    const st = this.slot[s]
    if (this.bugs.nofollow) { this.next(g, s); return } // bug: a slot that moved is taken as done
    const g2 = this.w.whereNow(s)
    if (g2 === g) { this.st.waits++; return } // this copy has not applied the open yet: ask again later
    this.q[g].shift(); this.assign(s, g2)
    st.pinCopy = null
  }

  // ── 'none': live rows, a key cursor, follow moves ──
  serveNone(g, s) {
    const [c, changed] = this.copyFor(g)
    const st = this.slot[s]
    if (changed && this.bugs.restart) { st.cursor = null; st.i = 0 } // bug: start the slot again after a failover
    if (!this.bugs.noseen && c.applied < this.floor[g]) { this.st.waits++; return }
    if (!c.held.has(s)) return this.moved(g, s)
    const m = c.rows.get(s) ?? new Map()
    let page
    if (this.bugs.maporder) { // bug: page by the copy's own order and a count, not by key
      page = [...m.keys()].slice(st.i, st.i + this.P); st.i += page.length
    } else {
      const keys = []
      for (const k of m.keys()) if (st.cursor === null || k > st.cursor) keys.push(k)
      keys.sort(); page = keys.slice(0, this.P)
    }
    for (const k of page) this.deliverRow(s, k, m.get(k))
    if (page.length) st.cursor = page[page.length - 1]
    if (page.length < this.P) this.next(g, s)
    if (c.applied > this.floor[g]) this.floor[g] = c.applied // the seen rule: never back within a group
  }

  // ── 'slot': a local pin per slot, the slot handed on whole ──
  serveSlot(g, s) {
    const [c, changed] = this.copyFor(g)
    const st = this.slot[s]
    const key = this.id + ':' + s
    if (st.pinCopy && st.pinCopy !== c) { // the pin was on a copy that failed: start the slot again
      this.st.restarts++
      st.pinCopy = null; st.i = 0
      if (!this.bugs.nobuffer) st.buf = []
    }
    if (!this.bugs.noseen && c.applied < this.floor[g]) { this.st.waits++; return }
    let lp = c.local.get(key)
    if (!lp) {
      if (!c.held.has(s)) return this.moved(g, s)
      const m = c.rows.get(s) ?? new Map()
      lp = { s, pos: c.spos.get(s) ?? 0, saved: new Map(), keys: [...m.keys()].sort() }
      c.local.set(key, lp); st.pinCopy = c; st.pos = lp.pos; st.i = 0
      if (this.bugs.nobuffer) { const d = this.deliv.get(s); if (d) d.open = null } // a new delivery for the restart
    }
    const page = lp.keys.slice(st.i, st.i + this.P); st.i += page.length
    const live = c.rows.get(s)
    for (const k of page) {
      let v = lp.saved.has(k) ? lp.saved.get(k) : live?.get(k)
      if (v === ABSENT) v = undefined
      if (this.bugs.nobuffer) this.deliverRow(s, k, v); else st.buf.push([k, v])
    }
    let imgs = 0; for (const cp of this.w.groups[g].copies) for (const x of cp.local.values()) imgs += x.saved.size
    if (imgs > this.st.maxImages) this.st.maxImages = imgs
    if (st.i >= lp.keys.length) {
      if (!this.bugs.nobuffer) { for (const [k, v] of st.buf) this.deliverRow(s, k, v); st.buf = [] }
      this.closeSlot(s)
      c.local.delete(key); st.pinCopy = null
      this.next(g, s)
    }
    if (c.applied > this.floor[g]) this.floor[g] = c.applied
  }

  // ── 'cut': pins in every group's log, the pairing check, then pages at the pins ──
  pinOne() { // the pins land one by one, 0 to pinSpread world steps apart (sent together, they arrive apart)
    if (this.pinWait-- > 0) return
    this.pinWait = Math.floor(this.r() * (this.pinSpread + 1))
    const i = Math.floor(this.r() * this.toPin.length)
    const g = this.toPin.splice(i, 1)[0]
    this.pinGroup(g)
    if (!this.toPin.length) this.phase = 'check'
  }
  pinGroup(g) {
    const w = this.w
    const id = `${this.id}.${g}.${++this.st.pinsTaken}`
    const saver = this.bugs.localpin ? this.cur[g].id : undefined // bug: only the copy the scanner uses keeps images
    const index = w.append(g, { t: 'pin', id, saver })
    this.pins[g] = { id, index }
  }
  check() {
    const w = this.w
    this.st.rounds++
    const ans = w.groups.map((_, g) => w.heldAt(g, this.pins[g].index))
    const repin = new Set()
    const pick = new Array(w.S).fill(-1)
    for (let s = 0; s < w.S; s++) {
      // p: the slot's highest position in any group's log up to that group's pin. The cut must show the slot at
      // p, so some group must hold it at p at its pin (own, or fenced and kept); and no group may have a commit
      // on the slot after its pin at a position at or below p (that commit would be in the slot's rows but not in
      // its own group's cut).
      let p = -1
      for (let g = 0; g < w.G; g++) if (ans[g].spos.has(s)) p = Math.max(p, ans[g].spos.get(s))
      const holders = []
      for (let g = 0; g < w.G; g++) if (ans[g].held.has(s) && (this.bugs.nopair || ans[g].spos.get(s) === p)) holders.push(g)
      if (this.bugs.nopair) { // bug: take the pins as they came, any holder, a slot with none is skipped
        if (holders.length) pick[s] = holders[Math.floor(this.r() * holders.length)]
        continue
      }
      if (this.bugs.oldpair && !holders.length) { // bug: the first form of the check, which looked at holders only
        for (let g = 0; g < w.G; g++) if (ans[g].held.has(s)) holders.push(g)
      }
      if (!holders.length) { repin.add(w.whereNow(s)); continue }
      let H = holders[0]
      for (const g of holders) if (ans[g].held.get(s) === 'own' && (this.bugs.oldpair ? ans[g].spos.get(s) >= ans[H].spos.get(s) : true)) H = g
      for (let g = 0; g < w.G; g++) {
        if (g === H) continue
        if (this.bugs.oldpair) { if (ans[g].held.get(s) === 'own') repin.add(g); continue }
        const f = w.firstPosAfter(g, this.pins[g].index, s)
        if (f !== undefined && f <= p) repin.add(g)
      }
      pick[s] = H
    }
    if (repin.size) {
      for (const g of repin) { w.append(g, { t: 'unpin', id: this.pins[g].id }); this.pinGroup(g); this.st.repins++ }
      return // check again on the next tick
    }
    for (let s = 0; s < w.S; s++) {
      if (pick[s] < 0) { this.slot[s].done = true; continue }
      this.slot[s].pos = ans[pick[s]].spos.get(s)
      this.assign(s, pick[s])
    }
    this.phase = 'scan'
  }
  serveCut(g, s) {
    const [c] = this.copyFor(g)
    const st = this.slot[s]
    const pin = this.pins[g]
    if (!this.bugs.nofloor && c.applied < pin.index) { this.st.waits++; return }
    const p = c.pins.get(pin.id)
    const live = c.rows.get(s)
    let keys
    if (!p) {
      if (c.applied >= pin.index) { this.st.errs++; this.st.waits++; this.cur[g] = this.pickCopy(g); return } // never: the pin is in the log
      keys = live ? [...live.keys()] : [] // bug 'nofloor': a copy behind the pin answers with its live rows
    } else {
      const ks = new Set(live ? live.keys() : [])
      const sv = p.bySlot.get(s)
      if (sv) for (const k of sv) ks.add(k)
      keys = []
      for (const k of ks) if (p.saved.has(k) ? p.saved.get(k) !== ABSENT : live?.has(k)) keys.push(k)
    }
    const after = keys.filter((k) => st.cursor === null || k > st.cursor).sort()
    const page = after.slice(0, this.P)
    for (const k of page) this.deliverRow(s, k, p && p.saved.has(k) ? p.saved.get(k) : live?.get(k))
    if (page.length) st.cursor = page[page.length - 1]
    let imgs = 0; for (const cp of this.w.groups[g].copies) if (cp.alive) for (const x of cp.pins.values()) imgs += x.saved.size
    if (imgs > this.st.maxImages) this.st.maxImages = imgs
    if (page.length < this.P) { this.closeSlot(s); this.next(g, s) }
  }
}
