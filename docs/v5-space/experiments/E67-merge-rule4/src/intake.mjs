// E-67: the merger's INTAKE. What it may take, and when: O1's rules 1 to 3, and rule 4 in each form studied.
// It owns a Merger (merger.mjs) and, per group, the merger's place (pos), the frames that arrived and are not
// taken yet (its inbound buffer, items), a pending picture (pic), and whether the group's partial is down.
//
// Words. A HALF is a slot move's frame at one group: A's 'fence' (the slot's rows leave A), B's 'open' (they
// arrive at B), or A's 'unfence' (B gave up; they come back to A). The open and the unfence name the fence's
// place in A's log (fpos). A UNIT is what the merger takes next from a group: its pending picture, else its
// next frame. A JOIN takes one unit and everything it needs, at ONE cut (nothing is shown in between).
//
// The forms (fix):
//   none  O1's three rules. Rule 1: frames in order; a picture at or past the merger's place. Rule 2: a half is
//         taken with its partner (fence with the open or the unfence; open with its fence), with the closure
//         for frames: the partner's group is taken up to the partner, and each half met on the way brings its
//         own partner. Rule 3: a picture replaces the group's whole part. A picture carries nothing, so a
//         picture past a half is installed alone.
//   a     rule 4 as "a picture carries its moves": the picture names every half in (merger's place, its place];
//         the merger installs it together with each half's partner, at one cut (the JOIN for a picture).
//   b     a ring of frames on every copy: a new host whose ring reaches back to the merger's place re-sends the
//         frames and no picture is needed (the resume rule, in sim.mjs); otherwise, and at a rebuild, (a).
//   b0    the ring, with a picture installed alone behind it (the ring without (a)).
//   c     a part for the moving slot: at A's fence the slot's rows go into a part of their own ('m<move>');
//         B's open or A's unfence takes them out. A fence never waits. An open waits for its fence (it needs
//         the move part). A picture carries its halves and, with the rows, every move its group fenced that
//         the merger has not closed (so a takeover or a new merger gets the move part back).
// Planted bugs (mutate): nopair (halves one by one), noclosure (only the unit's own halves bring partners),
// nojoin (a picture's first half joined, the others left for later), giveup (after 30 steps held by a down
// group, take the unit alone), giveupskip (after 30 steps, drop the waiting half), back (rule 1 off: a picture
// behind the merger's place is taken), health (health names down groups only), nomovepart, noorder (c: an
// open does not wait for its fence). Bugs of the world side (pictures, ring, rows kept) live in sim.mjs.
import { Merger } from './merger.mjs'
import { Partial } from './partial.mjs'

const PAIR = new Set(['none', 'a', 'b', 'b0'])
export const GIVEUP = 30

export class Intake {
  constructor({ fix, mutate = '', K = 10, rnd }) {
    this.fix = fix; this.mutate = mutate; this.K = K; this.rnd = rnd
    this.M = this.newMerger()
    this.st = new Map() // g -> { pos, present, down, items: Map pos -> item, pic, blockedSince }
    this.closeOf = new Map() // move -> { g, pos } of its open or unfence, once seen (delivered or carried)
    this.mparts = new Set() // (c) moves whose part the merger holds
    this.closed = new Set() // moves this merger has closed (both halves taken)
    this.carries = fix === 'a' || fix === 'b' || fix === 'c'
  }
  newMerger() { return new Merger({ K: this.K, mutate: this.mutate === 'resyncadd' ? 'resyncadd' : '', keys: this.mutate === 'keyowner' ? 'one' : 'group' }) }
  addGroup(g) { this.st.set(g, { pos: 0, present: true, down: false, items: new Map(), pic: null, blockedSince: -1 }) }
  dropGroup(g) { this.M.dropGroup(g); this.st.delete(g) }
  setDown(g, d) { this.st.get(g).down = d }
  deliver(g, it) {
    const s = this.st.get(g)
    s.items.set(it.pos, it)
    if (it.kind === 'open' || it.kind === 'unfence') this.closeOf.set(it.mv, { g, pos: it.pos })
  }
  // A takeover (a failover, or the end of an outage): the old host's link is gone, so the merger's inbound
  // buffer from it is dropped. pic = { pos, pic, halves, parts, readyAt } or null (a ring re-send follows).
  takeover(g, pic) {
    const s = this.st.get(g)
    for (const it of s.items.values()) if (this.closeOf.get(it.mv)?.g === g && this.closeOf.get(it.mv).pos === it.pos) this.closeOf.delete(it.mv)
    s.items.clear()
    s.pic = pic
    if (pic && this.carries) for (const h of pic.halves) if (h.kind === 'open' || h.kind === 'unfence') this.closeOf.set(h.mv, { g, pos: h.pos })
  }
  skipTo(g, p) { this.st.get(g).pos = p } // only the planted 'ringgap' calls this
  // A new merger: no part, no buffer; every group's host sends a picture (sim.mjs), each group keeps its place
  // as the floor its picture's halves start from.
  rebuild() {
    this.M = this.newMerger()
    for (const s of this.st.values()) { s.present = false; s.items.clear(); s.pic = null; s.blockedSince = -1 }
    this.closeOf.clear(); this.mparts.clear(); this.closed = new Set()
  }
  serving() { for (const s of this.st.values()) if (!s.present) return false; return true }
  hasWork(g, now) {
    const s = this.st.get(g)
    if (s.down) return false
    if (s.pic) return s.pic.readyAt <= now
    return s.present && s.items.has(s.pos + 1)
  }
  // ── the join ─────────────────────────────────────────────────────────────────────────────────────
  // Plan g0's next unit and everything it needs. Returns { ok, T, P, downs, why }: T the target place per
  // group, P the groups whose picture is installed, downs the down groups it waits on, why the first wait.
  plan(g0, now, force = false) {
    const T = new Map(), P = new Set(), downs = new Set(), q = []
    let ok = true, why = ''
    const st = this.st, pair = PAIR.has(this.fix), m = this.mutate
    const cur = (g) => (T.has(g) ? T.get(g) : st.get(g).pos)
    const stop = (w, g) => { ok = false; if (!why) why = w; if (g !== undefined) downs.add(g) }
    const addPic = (g) => { // a pending picture joins the cut, with the halves it carries
      const s = st.get(g)
      if (s.pic.readyAt > now) { stop('picture'); return false }
      if (s.pic.pos < s.pos && m !== 'back') { stop('behind'); return false } // rule 1: never back
      P.add(g); T.set(g, s.pic.pos)
      if (this.carries) {
        const hs = m === 'nojoin' ? s.pic.halves.slice(0, 1) : s.pic.halves
        for (const h of hs) q.push(h)
      }
      return true
    }
    const include = (g, upto, own) => {
      const s = st.get(g)
      if (!s) return stop('gone')
      if (upto <= cur(g) && (s.present || P.has(g))) return
      if (s.down) return stop('down', g)
      if (!P.has(g)) { if (s.pic) { if (!addPic(g)) return } else if (!s.present) return stop('picture') }
      for (let p = cur(g) + 1; p <= upto; p++) {
        const it = s.items.get(p)
        if (!it) return stop('frame')
        if (it.kind !== 'w' && (own || m !== 'noclosure')) q.push(it)
        T.set(g, p)
      }
    }
    const needs = (h) => {
      if (force || m === 'nopair') return
      if (pair) {
        if (h.kind === 'fence') {
          const c = this.closeOf.get(h.mv)
          if (!c) { if (st.get(h.B)?.down) stop('down', h.B); else stop('move'); return }
          include(c.g, c.pos, false)
        } else if (h.kind === 'open') include(h.A, h.fpos, false)
      } else if (h.kind === 'open' && m !== 'noorder') include(h.A, h.fpos, false) // (c): an open waits for its fence
    }
    const s0 = st.get(g0)
    if (s0.down) stop('down', g0)
    else if (s0.pic) addPic(g0)
    else include(g0, s0.pos + 1, true)
    const own = q.length // the unit's own halves
    for (let i = 0; i < q.length; i++) {
      if (m === 'noclosure' && i >= own) break
      needs(q[i])
    }
    return { ok, T, P, downs, why }
  }
  // Take g0's next unit with what it needs, at one cut. Returns { ok, moved: [g...], downs, why }.
  take(g0, now) {
    let pl = this.plan(g0, now)
    const s0 = this.st.get(g0)
    if (!pl.ok) {
      if (pl.downs.size) { if (s0.blockedSince < 0) s0.blockedSince = now } else s0.blockedSince = -1
      const giving = (this.mutate === 'giveup' || this.mutate === 'giveupskip') && pl.downs.size && s0.blockedSince >= 0 && now - s0.blockedSince >= GIVEUP
      if (!giving) return { ok: false, downs: pl.downs, why: pl.why }
      if (this.mutate === 'giveupskip' && !s0.pic) { // drop the waiting half: the merger steps over it
        const it = s0.items.get(s0.pos + 1)
        if (it && it.kind !== 'w') { s0.items.delete(it.pos); s0.pos = it.pos; s0.blockedSince = -1; return { ok: true, moved: [g0], gaveUp: true } }
      }
      pl = this.plan(g0, now, true)
      if (!pl.ok) return { ok: false, downs: pl.downs, why: pl.why }
      s0.blockedSince = -1
      this.apply(pl)
      return { ok: true, moved: [...pl.T.keys()], gaveUp: true }
    }
    s0.blockedSince = -1
    this.apply(pl)
    return { ok: true, moved: [...pl.T.keys()], pics: pl.P.size }
  }
  apply({ T, P }) {
    const M = this.M, creates = [], closes = new Set()
    const order = [...new Set([...P, ...T.keys()])]
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    for (const g of order) {
      if (!P.has(g)) continue
      const s = this.st.get(g), pic = s.pic
      M.install(g, pic.pic)
      s.present = true; s.pos = pic.pos; s.pic = null
      if (this.carries) for (const h of pic.halves) if (h.kind !== 'fence') closes.add(h.mv)
      if (this.fix === 'c') for (const pt of pic.parts) creates.push(pt)
    }
    for (const g of order) {
      const s = this.st.get(g), to = T.get(g)
      for (let p = s.pos + 1; p <= to; p++) {
        const it = s.items.get(p)
        M.apply(g, it.frame)
        s.items.delete(p)
        if (it.kind === 'fence') creates.push({ mv: it.mv, rows: it.rows })
        else if (it.kind !== 'w') closes.add(it.mv)
      }
      if (to > s.pos) s.pos = to
    }
    if (this.fix === 'c' && this.mutate !== 'nomovepart') {
      for (const { mv, rows } of creates) {
        if (closes.has(mv) || this.mparts.has(mv) || this.closed.has(mv)) continue
        const p = new Partial('m' + mv); p.takeRows(rows)
        M.install('m' + mv, p.picture()); this.mparts.add(mv)
      }
    }
    for (const mv of closes) {
      if (this.mparts.has(mv)) { M.dropGroup('m' + mv); this.mparts.delete(mv) }
      this.closed.add(mv); this.closeOf.delete(mv)
    }
  }
  // ── health: per group, 'down', or 'held' by the down groups its next unit waits on ────────────────────
  health(now) {
    const out = new Map()
    for (const [g, s] of this.st) {
      if (s.down) { out.set(g, { down: true }); continue }
      if (this.mutate === 'health') continue
      if (!(s.pic || s.items.has(s.pos + 1))) continue
      const pl = this.plan(g, now)
      if (!pl.ok && pl.downs.size) out.set(g, { held: [...pl.downs].sort((a, b) => a - b) })
    }
    return out
  }
}
