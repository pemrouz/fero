// E-65 X3: user code over every row, kept live as a FOLD: each row emits (bucket, piece) pairs, and a user
// combine merges two pieces of one bucket. A PARTIAL per group keeps the fold over its group's rows, next to them;
// a MERGER per view combines the groups' pieces. No process holds every row. This is E-64 O1's merger with one
// more class, "user": O1's rules carry over (one cut, a move's halves taken together, a resync replaces a
// group's whole part), and the oracle world is O1's.
//
// The user declares (a server-declared view only; clients cannot ship code):
//   fold({ version, emit(row) -> [[bucket, piece], ...]   (or map(row) -> piece, one bucket '*')
//          empty() -> piece, combine(a, b) -> piece, remove?(a, b) -> piece, done?(piece) -> value })
// combine may change its FIRST argument and must not change its second; fero only passes a first argument it
// owns. remove(combine(a, b), b) must equal a. fero counts the rows in each bucket itself, so a bucket goes when
// its last row leaves (C5), whatever the pieces say.
//
// Two classes, picked by whether remove is given:
//   inv (remove given)  the partial is a map: each change sends (bucket, +n, plus, minus) from the row's before and
//                       after; it keeps its group's pieces only for a picture. The merger adds and removes.
//   mon (no remove)     the partial keeps a piece per (slot, bucket); a change that takes a row out RESCANS that
//                       slot's rows for that bucket (near the rows), a pure insert combines in O(1). The group's
//                       piece per bucket is the combine of its slots' pieces; the merger keeps every group's piece
//                       per bucket and combines them for a touched bucket, O(groups).
// Planted builder bugs (mutate): 'norescan' (mon: a row leaving is not rescanned, its piece stays),
// 'resyncadd' (a resync adds the picture without taking the old part out).
import { canon, slotOf } from './lib.mjs'

// a copy of a piece, as a socket would make one (plain values, arrays, Maps; anything else by structuredClone)
export function copy(x) {
  if (typeof x !== 'object' || x === null) return x
  if (Array.isArray(x)) return x.map(copy)
  if (x instanceof Map) { const m = new Map(); for (const [k, v] of x) m.set(k, copy(v)); return m }
  return structuredClone(x)
}

export function fold(d) {
  const emit = d.emit ?? ((row) => { const p = d.map(row); return p === undefined ? [] : [['*', p]] })
  return { name: d.name, version: d.version ?? 1, emit, empty: d.empty, combine: d.combine, remove: d.remove,
    done: d.done ?? ((p) => p), keeps: d.keeps, inv: typeof d.remove === 'function' }
}

// one bucket's entry: n rows, piece p. dn rows in, plus combined in, minus removed.
function applyDelta(m, F, b, dn, plus, minus) {
  let e = m.get(b)
  if (!e) m.set(b, (e = { n: 0, p: F.empty() }))
  e.n += dn
  if (plus !== undefined) e.p = F.combine(e.p, plus)
  if (minus !== undefined) e.p = F.remove(e.p, minus)
  if (e.n === 0) m.delete(b)
}

export class UPartial {
  constructor(gid, F, { mutate = '', slotOf: sf = slotOf, flat = false, nokeeps = false } = {}) {
    this.gid = gid; this.F = F; this.mutate = mutate; this.slotOf = sf; this.flat = flat; this.nokeeps = nokeeps
    this.bp = new Map() // mon: b -> Map block -> { n, p }
    this.rescans = 0; this.kept = 0
    this.rows = new Map() // k -> row: the copy's own rows (it has them already, by slot: GROUPS G7)
    this.state = new Map() // b -> { n, p }: the group's pieces
    this.sbk = new Map() // mon: slot -> Map b -> Set of keys whose rows emit b (what a rescan reads)
    this.sp = new Map() // mon: slot -> Map b -> { n, p }
    this.bslots = new Map() // mon: b -> Set of slots holding b
    this.emits = 0; this.combines = 0; this.rescanRows = 0
  }
  apply(changes) { return this.F.inv ? this.applyInv(changes) : this.applyMon(changes) }
  applyInv(changes) {
    const F = this.F, d = new Map()
    const side = (row, sign) => {
      this.emits++
      for (const [bk, piece] of F.emit(row)) {
        const b = canon(bk)
        let e = d.get(b)
        if (!e) d.set(b, (e = { dn: 0, plus: undefined, minus: undefined }))
        if (sign > 0) { e.dn++; e.plus = e.plus === undefined ? piece : F.combine(e.plus, piece) }
        else { e.dn--; e.minus = e.minus === undefined ? piece : F.combine(e.minus, piece) }
      }
    }
    for (const { k, prev, next } of changes) {
      if (prev) { side(prev, -1); this.rows.delete(k) }
      if (next) { side(next, 1); this.rows.set(k, next) }
    }
    const inv = []
    for (const [b, e] of d) {
      if (e.dn === 0 && canon(e.plus) === canon(e.minus)) continue // the change did not touch this fold
      inv.push([b, e.dn, e.plus, e.minus])
      applyDelta(this.state, F, b, e.dn, e.plus, e.minus)
    }
    return { inv, set: [] }
  }
  applyMon(changes) {
    // Each bucket's piece is kept at three levels: per slot, per block of 32 slots, per group. A row coming in
    // combines into all three (3 combines). A row leaving whose piece the author's 'keeps' hint says cannot matter
    // only lowers the counts. Any other leaving row RESCANS its slot's rows for that bucket, near the rows, and its
    // block and the group's piece are folded again (up to 32 + slots/32 combines). 'flat' folds every slot again.
    const F = this.F, rescan = new Map(), dirty = new Map(), before = new Map() // dirty: b -> Set of blocks to fold again
    const blk = (s) => s >> 5
    const level = (m, key, b) => { let x = m.get(key); if (!x) m.set(key, (x = new Map())); let e = x.get(b); if (!e) x.set(b, (e = { n: 0, p: F.empty() })); return e }
    const first = (b) => { if (!before.has(b)) { const e = this.state.get(b); before.set(b, e === undefined ? 'u' : e.n + '|' + canon(e.p)) } }
    for (const { k, prev, next } of changes) {
      const s = this.slotOf(k)
      if (prev) {
        this.rows.delete(k)
        this.emits++
        for (const [bk, piece] of F.emit(prev)) {
          const b = canon(bk)
          first(b)
          this.sbk.get(s).get(b).delete(k)
          if (rescan.get(s)?.has(b)) continue
          const e = this.sp.get(s).get(b)
          // 'norescan' (planted): the leaving row's piece stays. keeps: its leaving cannot change the slot's piece
          if (e.n > 1 && (this.mutate === 'norescan' || (F.keeps && !this.nokeeps && F.keeps(e.p, piece)))) {
            e.n--; if (!this.flat) this.bp.get(b).get(blk(s)).n--; this.state.get(b).n--; this.kept++; continue
          }
          let x = rescan.get(s); if (!x) rescan.set(s, (x = new Set())); x.add(b)
          let d = dirty.get(b); if (!d) dirty.set(b, (d = new Set())); d.add(this.flat ? -1 : blk(s))
        }
      }
      if (next) {
        this.rows.set(k, next)
        this.emits++
        for (const [bk, piece] of F.emit(next)) {
          const b = canon(bk)
          first(b)
          let sm = this.sbk.get(s); if (!sm) this.sbk.set(s, (sm = new Map())); let ks = sm.get(b); if (!ks) sm.set(b, (ks = new Set())); ks.add(k)
          if (rescan.get(s)?.has(b)) continue // the rescan counts it
          const e = level(this.sp, s, b)
          if (e.n === 0) this.bslot(b, s, true)
          e.n++; e.p = F.combine(e.p, piece); this.combines++
          if (this.flat) { let d = dirty.get(b); if (!d) dirty.set(b, (d = new Set())); d.add(-1); continue }
          if (dirty.get(b)?.has(blk(s))) continue // its block is folded again below
          const eb = level(this.bp, b, blk(s)); eb.n++; eb.p = F.combine(eb.p, piece); this.combines++
          if (dirty.has(b)) continue // the group's piece is folded again below
          let eg = this.state.get(b); if (!eg) this.state.set(b, (eg = { n: 0, p: F.empty() }))
          eg.n++; eg.p = F.combine(eg.p, piece); this.combines++
        }
      }
    }
    for (const [s, bs] of rescan) for (const b of bs) this.rescanSlot(s, b)
    for (const [b, blks] of dirty) this.refold(b, blks)
    const set = []
    for (const [b, was] of before) {
      const e = this.state.get(b)
      if (e !== undefined && e.n === 0) this.state.delete(b)
      const now = this.state.get(b)
      if ((now === undefined ? 'u' : now.n + '|' + canon(now.p)) === was) continue
      set.push([b, now === undefined ? 0 : now.n, now === undefined ? undefined : copy(now.p)]) // sent as it is now
    }
    return { inv: [], set }
  }
  // fold a bucket's dirty blocks again from their slots, then the group's piece from its blocks
  refold(b, blks) {
    const F = this.F
    if (this.flat) {
      const ss = this.bslots.get(b)
      let n = 0, p = F.empty()
      if (ss) for (const s of [...ss].sort((x, y) => x - y)) { const e = this.sp.get(s).get(b); n += e.n; p = F.combine(p, e.p); this.combines++ }
      if (n === 0) this.state.delete(b); else this.state.set(b, { n, p })
      return
    }
    let bm = this.bp.get(b); if (!bm) this.bp.set(b, (bm = new Map()))
    for (const k of blks) {
      let n = 0, p = F.empty()
      for (let s = k << 5; s < (k + 1) << 5; s++) { const e = this.sp.get(s)?.get(b); if (e) { n += e.n; p = F.combine(p, e.p); this.combines++ } }
      if (n === 0) bm.delete(k); else bm.set(k, { n, p })
    }
    if (!bm.size) { this.bp.delete(b); this.state.delete(b); return }
    let n = 0, p = F.empty()
    for (const k of [...bm.keys()].sort((x, y) => x - y)) { const e = bm.get(k); n += e.n; p = F.combine(p, e.p); this.combines++ }
    this.state.set(b, { n, p })
  }
  bslot(b, s, on) {
    let x = this.bslots.get(b)
    if (on) { if (!x) this.bslots.set(b, (x = new Set())); x.add(s) } else if (x) { x.delete(s); if (!x.size) this.bslots.delete(b) }
  }
  // near the rows: one slot's rows, for one bucket
  rescanSlot(s, b) {
    const F = this.F
    let n = 0, p = F.empty()
    this.rescans++
    const ks = this.sbk.get(s)?.get(b) ?? new Set()
    if (!ks.size) { this.sbk.get(s)?.delete(b); if (this.sbk.get(s)?.size === 0) this.sbk.delete(s) }
    for (const k of ks) {
      this.rescanRows++
      for (const [bk, piece] of F.emit(this.rows.get(k))) if (canon(bk) === b) { n++; p = F.combine(p, piece); this.combines++ }
    }
    let sm = this.sp.get(s)
    if (n === 0) { if (sm) { sm.delete(b); if (!sm.size) this.sp.delete(s) } this.bslot(b, s, false); return }
    if (!sm) this.sp.set(s, (sm = new Map()))
    sm.set(b, { n, p }); this.bslot(b, s, true)
  }
  // the group's pieces worked out from its rows alone (a new host, or the audit)
  picture() {
    const F = this.F, m = new Map()
    if (F.inv) {
      for (const row of this.rows.values()) for (const [bk, piece] of F.emit(row)) applyDelta(m, F, canon(bk), 1, piece, undefined)
      return m
    }
    const q = new UPartial(this.gid, F, { slotOf: this.slotOf, flat: this.flat })
    q.takeRows([...this.rows])
    return q.state
  }
  // the audit: does the kept state equal the rows' own? (catches a remove that does not undo, and drift)
  audit() { return canon(this.state) === canon(this.picture()) }
  dropRows(keys) { return this.apply(keys.map((k) => ({ k, prev: this.rows.get(k), next: undefined }))) }
  takeRows(pairs) { return this.apply(pairs.map(([k, row]) => ({ k, prev: undefined, next: row }))) }
}

export class UMerger {
  constructor(F, { mutate = '' } = {}) {
    this.F = F; this.mutate = mutate; this.version = F.version
    this.g = new Map() // g -> Map b -> { n, p }
    this.m = new Map() // b -> { n, p }: the merged answer's pieces
    this.dirty = new Set() // mon: buckets to combine again
    this.drift = 0 // resyncs whose picture differed from the group's part here, at the same place
  }
  gs(g) { let x = this.g.get(g); if (!x) this.g.set(g, (x = new Map())); return x }
  apply(g, fr) {
    const F = this.F, gs = this.gs(g)
    for (const [b, dn, plus, minus] of fr.inv) { applyDelta(gs, F, b, dn, plus, minus); applyDelta(this.m, F, b, dn, plus, minus) }
    for (const [b, n, p] of fr.set) { if (n === 0) gs.delete(b); else gs.set(b, { n, p }); this.dirty.add(b) }
  }
  settle() {
    if (!this.dirty.size) return
    const F = this.F, gids = [...this.g.keys()].sort((a, b) => a - b)
    for (const b of this.dirty) {
      let n = 0, p = F.empty()
      for (const g of gids) { const e = this.g.get(g).get(b); if (e) { n += e.n; p = F.combine(p, e.p) } }
      if (n === 0) this.m.delete(b); else this.m.set(b, { n, p })
    }
    this.dirty.clear()
  }
  // rule 4: a group's part is replaced by a picture, as one change. atCut: the picture is at the merger's place for
  // g, so it must equal what the merger holds for g: a free check of the user's laws at every such resync
  install(g, pic, atCut = false) {
    const F = this.F, old = this.g.get(g) ?? new Map()
    if (atCut && canon(old) !== canon(pic)) this.drift++
    if (F.inv) {
      if (this.mutate !== 'resyncadd') for (const [b, e] of old) applyDelta(this.m, F, b, -e.n, undefined, e.p)
      for (const [b, e] of pic) applyDelta(this.m, F, b, e.n, e.p, undefined)
    } else for (const b of new Set([...old.keys(), ...pic.keys()])) this.dirty.add(b)
    this.g.set(g, pic)
  }
  dropGroup(g) { const gs = this.g.get(g); if (gs) for (const b of gs.keys()) this.dirty.add(b); this.g.delete(g) }
  out(b) { this.settle(); const e = this.m.get(b); return e === undefined ? undefined : this.F.done(e.p) }
  buckets() { this.settle(); return [...this.m.keys()] }
}

// The reference: one process folding every row in key order, from empty. A lawful fold gives this whatever the
// groups; an unlawful one does not.
export function reference(F, rows, keys, b) {
  let n = 0, p = F.empty()
  for (const k of keys) for (const [bk, piece] of F.emit(rows.get(k))) if (canon(bk) === b) { n++; p = F.combine(p, piece) }
  return n === 0 ? undefined : F.done(p)
}
export function referenceAll(F, rows, keys) {
  const m = new Map()
  for (const k of keys) for (const [bk, piece] of F.emit(rows.get(k))) {
    const b = canon(bk)
    let e = m.get(b); if (!e) m.set(b, (e = { n: 0, p: F.empty() }))
    e.n++; e.p = F.combine(e.p, piece)
  }
  return new Map([...m].map(([b, e]) => [b, F.done(e.p)]))
}

// The seeded self-check fero runs when it builds the view, on the partial's host, over pieces of real rows of the
// group: purity of emit, identity, associativity, commutativity, remove undoes combine, the second argument kept.
// Every call gets a fresh copy of its first argument. Returns null, or the first law that failed.
export function selfCheck(F, rows, R, { samples = 64, trials = 200 } = {}) {
  const clone = copy
  const same = (a, b) => canon(a) === canon(b)
  const byB = new Map(), rawB = new Map() // rawB: per bucket, the raw piece of each sampled row (distinct rows)
  const ks = [...rows.keys()]
  for (let i = 0; i < Math.min(samples, ks.length); i++) {
    const j = i + Math.floor(R() * (ks.length - i)); [ks[i], ks[j]] = [ks[j], ks[i]] // distinct rows
    const row = rows.get(ks[i])
    const e1 = F.emit(clone(row)), e2 = F.emit(clone(row))
    if (!same(e1, e2)) return 'emit-not-pure'
    // fero only ever holds pieces folded from empty (empty combined with a piece), so the laws are tested on those:
    // a raw piece may differ from its folded self (a -0 becomes 0) without harm
    for (const [bk, piece] of e1) {
      const b = canon(bk); if (!byB.has(b)) { byB.set(b, []); rawB.set(b, []) }
      byB.get(b).push(F.combine(F.empty(), clone(piece))); rawB.get(b).push(piece)
    }
  }
  const bs = [...byB.keys()]
  if (!bs.length) return null
  const C = (a, b) => { const bb = clone(b), before = canon(bb); const r = F.combine(clone(a), bb); if (canon(bb) !== before) throw new Law('combine-changed-second'); return r }
  const pick = (ps) => { let p = ps[Math.floor(R() * ps.length)]; if (R() < 0.5) p = C(p, ps[Math.floor(R() * ps.length)]); return p }
  try {
    for (let t = 0; t < trials; t++) {
      const ps = byB.get(bs[Math.floor(R() * bs.length)])
      const a = pick(ps), b = pick(ps), c = pick(ps)
      if (!same(C(F.empty(), a), a) || !same(C(a, F.empty()), a)) return 'identity'
      if (!same(C(C(a, b), c), C(a, C(b, c)))) return 'associative'
      if (!same(C(a, b), C(b, a))) return 'commutative'
      if (F.keeps) { // a row's piece the hint says can leave without effect must leave the fold as it was
        const raw = rawB.get(bs[Math.floor(R() * bs.length)]), m = 1 + Math.floor(R() * Math.min(8, raw.length))
        const sub = raw.slice(0, raw.length); for (let i = 0; i < m; i++) { const j = i + Math.floor(R() * (sub.length - i)); [sub[i], sub[j]] = [sub[j], sub[i]] }
        const fz = (xs) => xs.reduce((acc, x) => C(acc, x), F.empty()), all = fz(sub.slice(0, m))
        for (let i = 0; i < m; i++) if (m > 1 && F.keeps(clone(all), clone(sub[i]))) { if (!same(fz(sub.slice(0, m).filter((_, j) => j !== i)), all)) return 'keeps' }
      }
      if (F.inv) {
        const bb = clone(b), before = canon(bb)
        if (!same(F.remove(C(a, b), bb), a)) return 'remove-undoes'
        if (canon(bb) !== before) return 'remove-changed-second'
      }
    }
  } catch (e) { if (e instanceof Law) return e.message; return 'threw: ' + e.message }
  return null
}
class Law extends Error {}
