// B1: one data store fed by slot keeps views over every row exact through slot moves, failover and a rebuild.
//
// The source: one resource of 1,024 slots, held by G groups (1, 4, 16, or elastic: groups come and go). Each
// group is a log of entries: commits (records of the slots it owns, each record with its slot's next sequence),
// and the three-step slot move of LAYERS 8.6: B commits a copy of s while A still takes writes (`import`, at
// N0), A commits `fence(s, N)`, then B commits the delta since the copy (`delta`, N0+1..N) and `open(s, N)`.
// One move at a time per resource (LAYERS 8.6 step 1); a move takes 1 to 64 slots.
//
// Two consumers, each one process with ONE data store (src/store.mjs: R0, R1, R2) and data views on it. Each
// takes entries from the groups' logs at its own pace and in its own interleaving, up to 100 entries behind
// a group (the lag bound), with its own failovers (a resume from an older point: entries delivered again),
// pictures (R0's state subscribe: a group's slots at the group's head, as one diff commit) and view rebuilds.
//
// The oracle, after every entry a consumer takes: the query run from scratch over the TRUTH rows at that
// consumer's cut (each slot at the store's position for it), folded independently from each slot's own record
// log. Views: za('points', 10) with key ties, by('room').length(), by('room').sum('points') exact, length(),
// sum('points') exact, eq('room', 'r7'), gt('points', 50), and a page of 10 after a cursor. Also: the store's
// rows equal the truth at its cut (touched slots every entry, every row every 1,000), positions never go back,
// and at sync points (both consumers drained to the head) the two stores' views are equal as values.
//
// Planted (MUTATE): r2 (the importing copy feeds the store before open), r1 (no drop at or below the position),
// ties (the comparator without the key tie-break: ties by data's arrival seq).
//   node b1-store.mjs --groups=1|4|16|elastic --commits=100000 --seed=1 --dom=dirty --keys=3000 [--mutate=..]
//   node b1-store.mjs --seeds=1000 --commits=400 --keys=300 ...   many short seeds; one JSON line in total
import { rng, SLOTS, slotOf, canon, num, svz, bkey, rowCmp, afterCursor, E23Sum, applyRec, recKey, makeRow, genPoints, genRoom, keyName } from '../src/lib.mjs'
import { D, NODE, VALUE, keysOf, za, page, eq, gt, SumView, ByView } from '../src/ops.mjs'
import { SlotStore } from '../src/store.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const GROUPS = arg('groups', '4'), COMMITS = +arg('commits', '100000'), DOM = arg('dom', 'dirty')
const KEYS = +arg('keys', '3000'), LAGMAX = +arg('lag', '100'), MUTATE = arg('mutate', '')
const SEEDS = +arg('seeds', '0'), SEED0 = +arg('seed', '1')
const K = 10, CUR = [50, 'k1500']
const SYNC_EVERY = +arg('sync', '2000'), FULL_EVERY = 1000

function runSeed(SEED) {
  const R = rng(SEED)
  const stats = new Map()
  let firstBad = null
  const tally = (name, ok, ex) => {
    let s = stats.get(name)
    if (s === undefined) stats.set(name, (s = { n: 0, bad: 0 }))
    s.n++
    if (!ok) { s.bad++; if (firstBad === null) firstBad = name + ': ' + ex().slice(0, 300) }
  }

  // ── the source ────────────────────────────────────────────────────────────────────────────────────
  const slotLog = Array.from({ length: SLOTS }, () => [])
  const slotSeq = new Float64Array(SLOTS)
  const truth = new Map()
  const truthKeys = Array.from({ length: SLOTS }, () => new Set())
  const owner = new Int32Array(SLOTS)
  const fenced = new Uint8Array(SLOTS)
  const groups = new Map()
  let nextGid = 0
  const newGroup = () => { const g = { gid: nextGid++, log: [], alive: true }; groups.set(g.gid, g); return g }
  const elastic = GROUPS === 'elastic'
  const G0 = elastic ? 1 : +GROUPS
  for (let i = 0; i < G0; i++) newGroup()
  for (let s = 0; s < SLOTS; s++) owner[s] = Math.floor((s * G0) / SLOTS)
  const slotsOf = (gid) => { const xs = []; for (let s = 0; s < SLOTS; s++) if (owner[s] === gid) xs.push(s); return xs }
  const rowsOfSlot = (s) => { const m = new Map(); for (const k of truthKeys[s]) m.set(k, truth.get(k)); return m }

  function commit(gid, recs) {
    const items = []
    for (const rec of recs) {
      const k = recKey(rec), s = slotOf(k)
      const seq = ++slotSeq[s]
      slotLog[s].push(rec)
      items.push({ slot: s, seq, rec })
      applyRec(truth, rec)
      if (truth.has(k)) truthKeys[s].add(k); else truthKeys[s].delete(k)
    }
    groups.get(gid).log.push({ kind: 'commit', items })
  }
  const pool = (i) => keyName(i)
  function opFor(k) {
    const exists = truth.has(k)
    const u = R()
    if (!exists || u < 0.2) {
      const row = makeRow(k, DOM, R)
      return exists ? { type: 0, key: [k], value: row } : { type: 1, key: [], at: k, value: row }
    }
    if (u < 0.65) { const p = genPoints(DOM, R); return p === undefined ? { type: 2, key: [k, 'points'] } : { type: 0, key: [k, 'points'], value: p } }
    if (u < 0.78) return { type: 0, key: [k, 'room'], value: genRoom(DOM, R) }
    return { type: 2, key: [k] }
  }
  const live = []
  const liveIdx = new Map()
  const addLive = (k) => { if (!liveIdx.has(k)) { liveIdx.set(k, live.length); live.push(k) } }
  const delLive = (k) => { const i = liveIdx.get(k); if (i === undefined) return; const last = live.pop(); if (last !== k) { live[i] = last; liveIdx.set(last, i) } liveIdx.delete(k) }
  function sourceCommit() {
    for (let tries = 0; tries < 50; tries++) {
      if (R() < 0.05) { // several rows of one group in one entry
        const gs = [...groups.values()].filter((g) => g.alive)
        const g = gs[Math.floor(R() * gs.length)]
        const ks = new Set()
        const want = 3 + Math.floor(R() * 6)
        for (let t = 0; t < 400 && ks.size < want; t++) { const k = pool(Math.floor(R() * KEYS)); const s = slotOf(k); if (owner[s] === g.gid && !fenced[s]) ks.add(k) }
        if (ks.size === 0) continue
        const recs = [...ks].map(opFor)
        commit(g.gid, recs)
        for (const k of ks) if (truth.has(k)) addLive(k); else delLive(k)
        return
      }
      const k = live.length > 0 && R() < 0.6 ? live[Math.floor(R() * live.length)] : pool(Math.floor(R() * KEYS))
      const s = slotOf(k)
      if (fenced[s]) continue // a write to a fenced slot is refused (moved / retry)
      commit(owner[s], [opFor(k)])
      if (truth.has(k)) addLive(k); else delLive(k)
      return
    }
  }

  // ── slot moves (LAYERS 8.6) ───────────────────────────────────────────────────────────────────────
  let move = null, moves = 0, slotMoves = 0, grows = 0, shrinks = 0
  function startMove(step) {
    const gs = [...groups.values()].filter((g) => g.alive)
    let A, B, slots
    if (elastic) { // groups come and go; a move takes at most 64 slots, so a shrink can take several moves
      if (gs.length < 16 && (gs.length === 1 || R() < 0.5)) {
        const big = gs.filter((g) => slotsOf(g.gid).length >= 2)
        A = big[Math.floor(R() * big.length)]
        if (!A) return
        B = newGroup(); grows++
        const mine = slotsOf(A.gid).sort(() => R() - 0.5)
        slots = mine.slice(0, Math.max(1, Math.min(64, mine.length >> 1)))
      } else {
        A = gs[Math.floor(R() * gs.length)]
        const others = gs.filter((g) => g !== A)
        B = others[Math.floor(R() * others.length)]
        const mine = slotsOf(A.gid)
        if (mine.length === 0) { A.alive = false; return }
        slots = mine.slice(0, 64)
        if (mine.length <= 64) move = { shrink: true }
      }
    } else {
      const withSlots = gs.filter((g) => slotsOf(g.gid).length > 0)
      A = withSlots[Math.floor(R() * withSlots.length)]
      const others = gs.filter((g) => g !== A)
      B = others[Math.floor(R() * others.length)]
      const mine = slotsOf(A.gid).sort(() => R() - 0.5)
      const m = [1, 2, 4, 16, 64][Math.floor(R() * 5)]
      slots = mine.slice(0, Math.max(1, Math.min(m, mine.length)))
    }
    const N0 = new Map(), copy = new Map()
    for (const s of slots) { N0.set(s, slotSeq[s]); const rows = rowsOfSlot(s); copy.set(s, rows); B.log.push({ kind: 'import', slot: s, N0: slotSeq[s], rows }) }
    move = { shrink: move?.shrink ?? false, A, B, slots, N0, copy, phase: 'copy', at: step + 1 + Math.floor(R() * 12) }
  }
  function stepMove(step) {
    if (move.at > step) return
    if (move.phase === 'copy') {
      for (const s of move.slots) { fenced[s] = 1; move.A.log.push({ kind: 'fence', slot: s, N: slotSeq[s] }) }
      move.phase = 'fenced'
      move.at = step + 1 + Math.floor(R() * 6)
      return
    }
    for (const s of move.slots) {
      const N = slotSeq[s], N0 = move.N0.get(s)
      const items = []
      for (let q = N0; q < N; q++) items.push({ slot: s, seq: q + 1, rec: slotLog[s][q] })
      move.B.log.push({ kind: 'delta', slot: s, items })
      move.B.log.push({ kind: 'open', slot: s, N })
      owner[s] = move.B.gid
      fenced[s] = 0
    }
    moves++
    slotMoves += move.slots.length
    if (move.shrink) { move.A.alive = false; shrinks++ }
    move = null
  }

  // ── a consumer: one store, its views, and the truth at its cut ────────────────────────────────────
  const KC = K
  function buildViews(store) {
    const s = store.src
    return {
      za: za(s, 'points', KC, MUTATE === 'ties' ? 'ties' : ''),
      page: page(s, 'points', 'za', KC, CUR),
      byLen: new ByView(s, 'room', { agg: 'length' }),
      bySum: new ByView(s, 'room', { agg: 'sum', of: 'points' }),
      len: s.length(),
      sum: new SumView(s, 'points'),
      eq: eq(s, 'room', 'r7'),
      gt: gt(s, 'points', 50),
    }
  }
  function disposeViews(v) { for (const x of Object.values(v)) x.dispose() }
  class Consumer {
    constructor(i) {
      this.i = i
      this.R = rng(SEED * 1009 + 17 * (i + 1))
      this.store = new SlotStore({ slots: SLOTS, mutate: MUTATE === 'ties' ? '' : MUTATE })
      this.cur = new Map()
      this.cut = new Map()
      this.cutKeys = Array.from({ length: SLOTS }, () => new Set())
      this.cutPos = new Float64Array(SLOTS)
      this.views = buildViews(this.store)
      this.st = { entries: 0, failovers: 0, redelivered: 0, pictures: 0, rebuilds: 0, maxLag: 0, opensBehind: 0, opensBehindLag50: 0, opensAt: 0 }
      this.touched = new Set()
    }
    backlog(g) { return g.log.length - (this.cur.get(g.gid) ?? 0) }
    cutApply(s, rec) {
      const k = recKey(rec)
      applyRec(this.cut, rec)
      if (this.cut.has(k)) this.cutKeys[s].add(k); else this.cutKeys[s].delete(k)
      this.touched.add(k)
    }
    syncCut() {
      for (const s of this.store.moved) {
        const p = this.store.pos[s]
        if (p < this.cutPos[s]) { tally('positions never go back', false, () => `slot ${s}: ${this.cutPos[s]} -> ${p}`); for (const k of this.cutKeys[s]) { this.cut.delete(k); this.touched.add(k) } this.cutKeys[s].clear(); for (let q = 0; q < p; q++) this.cutApply(s, slotLog[s][q]) }
        else for (let q = this.cutPos[s]; q < p; q++) this.cutApply(s, slotLog[s][q])
        this.cutPos[s] = p
      }
      this.store.moved.clear()
    }
    deliver(g) {
      const idx = this.cur.get(g.gid) ?? 0
      const e = g.log[idx]
      this.cur.set(g.gid, idx + 1)
      this.st.entries++
      const st = this.store
      if (e.kind === 'commit') { for (const it of e.items) this.touched.add(recKey(it.rec)); st.feedCommit(e.items) }
      else if (e.kind === 'import') { for (const k of e.rows.keys()) this.touched.add(k); st.feedImport(e.slot, e.N0, e.rows, g.gid) }
      else if (e.kind === 'delta') st.feedDelta(e.slot, e.items, applyRec, g.gid)
      else if (e.kind === 'open') {
        if (st.pos[e.slot] < e.N) {
          this.st.opensBehind++
          // how far behind A this consumer is when it takes B's open: entries of A not yet taken
          let lag = 0
          for (const a of groups.values()) if (a !== g) lag = Math.max(lag, this.backlog(a))
          if (lag >= 50) this.st.opensBehindLag50++
        } else this.st.opensAt++
        for (const k of st.keys[e.slot]) this.touched.add(k)
        st.feedOpen(e.slot, e.N, g.gid)
        for (const k of st.keys[e.slot]) this.touched.add(k)
      } // fence: nothing for a reader of rows
      this.syncCut()
      this.check(false)
    }
    failover() { // resume at another copy from an older point: up to 50 entries come again
      const gs = [...groups.values()].filter((g) => (this.cur.get(g.gid) ?? 0) > 0)
      if (gs.length === 0) return
      const g = gs[Math.floor(this.R() * gs.length)]
      const back = Math.floor(this.R() * 51)
      const c = this.cur.get(g.gid)
      this.cur.set(g.gid, Math.max(0, c - back))
      this.st.failovers++
      this.st.redelivered += Math.min(back, c)
    }
    picture() { // R0: a state subscribe to a group: its served slots at its head, its importing copies kept apart
      const gs = [...groups.values()]
      const g = gs[Math.floor(this.R() * gs.length)]
      const slots = [], sides = []
      if (g.alive) {
        for (let s = 0; s < SLOTS; s++) if (owner[s] === g.gid && !fenced[s]) slots.push({ slot: s, P: slotSeq[s], rows: rowsOfSlot(s) })
        if (move !== null && move.B === g) for (const s of move.slots) sides.push({ slot: s, N: move.N0.get(s), rows: move.copy.get(s) })
      }
      this.cur.set(g.gid, g.log.length)
      for (const { slot } of slots) for (const k of this.store.keys[slot]) this.touched.add(k)
      this.store.feedPicture(slots, sides, g.gid)
      for (const { slot } of slots) for (const k of this.store.keys[slot]) this.touched.add(k)
      this.st.pictures++
      this.syncCut()
      this.check(false)
    }
    rebuild() { disposeViews(this.views); this.views = buildViews(this.store); this.st.rebuilds++; this.check(true) }
    tick() {
      const R = this.R
      if (R() < 1 / 700) this.failover()
      if (R() < 1 / 900) this.picture()
      if (R() < 1 / 1000) this.rebuild()
      for (const g of groups.values()) { // the lag bound
        const b = this.backlog(g)
        if (b > LAGMAX) { const to = LAGMAX - Math.floor(R() * 20); while (this.backlog(g) > to) this.deliver(g) }
        if (this.backlog(g) > this.st.maxLag) this.st.maxLag = this.backlog(g)
      }
      if (R() < 1 / 500) { const gs = [...groups.values()]; const g = gs[Math.floor(R() * gs.length)]; while (this.backlog(g) > 0) this.deliver(g) }
      const u = R()
      const k = u < 0.4 ? 0 : u < 0.75 ? 1 : u < 0.92 ? 2 : 3 // 0.93 an entry a tick on average: the lag sits near its bound
      for (let i = 0; i < k; i++) {
        const gs = [...groups.values()].filter((g) => this.backlog(g) > 0)
        if (gs.length === 0) break
        this.deliver(gs[Math.floor(R() * gs.length)])
      }
    }
    drain() { for (;;) { const gs = [...groups.values()].filter((g) => this.backlog(g) > 0); if (gs.length === 0) return; this.deliver(gs[Math.floor(this.R() * gs.length)]) } }
    read() {
      const v = this.views
      return { za: keysOf(v.za), page: keysOf(v.page), byLen: v.byLen.snapshot(), bySum: v.bySum.snapshot(), len: v.len[VALUE], sum: v.sum.value, eq: v.eq[NODE], gt: v.gt[NODE] }
    }
    check(full) {
      const q = query(this.cut)
      const v = this.views
      const n = this.i
      const zk = keysOf(v.za)
      tally('za(10) key sequence', canon(zk) === canon(q.top), () => `c${n} ${canon(zk)} vs ${canon(q.top)}`)
      const pk = keysOf(v.page)
      tally('page after cursor', canon(pk) === canon(q.page), () => `c${n} ${canon(pk)} vs ${canon(q.page)}`)
      tally('by(room).length()', mapEq(v.byLen.snapshot(), q.byLen), () => `c${n} ${canon(v.byLen.snapshot())} vs ${canon(q.byLen)}`)
      tally('by(room).sum(points)', mapEq(v.bySum.snapshot(), q.bySum), () => `c${n} ${canon(v.bySum.snapshot())} vs ${canon(q.bySum)}`)
      tally('length()', v.len[VALUE] === this.cut.size, () => `c${n} ${v.len[VALUE]} vs ${this.cut.size}`)
      tally('sum(points) exact', Object.is(v.sum.value, q.sum), () => `c${n} ${canon(v.sum.value)} vs ${canon(q.sum)}`)
      const en = v.eq[NODE], gn = v.gt[NODE]
      tally('eq(room, r7) rows', en.rowCount() === q.eq.length && q.eq.every((k) => en.hasRow(k) && canon(en.rowAt(k)) === canon(this.cut.get(k))), () => `c${n} ${en.rowCount()} vs ${q.eq.length}`)
      tally('gt(points, 50) keys', gn.rowCount() === q.gt.length && q.gt.every((k) => gn.hasRow(k)), () => `c${n} ${gn.rowCount()} vs ${q.gt.length}`)
      // the store itself at its cut: the rows this entry touched, or every row
      const st = this.store
      const ks = full || this.st.entries % FULL_EVERY === 0 ? new Set([...this.cut.keys(), ...keysOf(st.src)]) : this.touched
      let ok = true, ex = ''
      for (const k of ks) {
        const a = st.has(k) ? canon(st.row(k)) : 'absent', b = this.cut.has(k) ? canon(this.cut.get(k)) : 'absent'
        if (a !== b) { ok = false; ex = `${k}: store ${a} vs truth at cut ${b}`; break }
      }
      tally('store rows = truth at its cut', ok, () => `c${n} ${ex}`)
      tally('lane rejects', st.rejects.length === 0, () => st.rejects[0])
      this.touched.clear()
    }
  }
  const mapEq = (a, b) => { if (a.size !== b.size) return false; for (const [k, x] of b) if (!a.has(k) || !Object.is(a.get(k), x)) return false; return true }
  const cmpZa = rowCmp('points', 'za')
  const after = afterCursor('points', 'za', CUR)
  function topK(arr, row) {
    if (arr.length < K || cmpZa(row, arr[arr.length - 1]) < 0) {
      let lo = 0, hi = arr.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpZa(arr[mid], row) < 0) lo = mid + 1; else hi = mid }
      arr.splice(lo, 0, row)
      if (arr.length > K) arr.pop()
    }
  }
  function oSum(vals) { // from scratch: counts apart, the -0 rule, Shewchuk add-only (exact: |values| here stay small)
    let nan = 0, pinf = 0, ninf = 0, nf = 0, nz = 0
    const s = new E23Sum()
    for (const x of vals) {
      if (x !== x) nan++; else if (x === Infinity) pinf++; else if (x === -Infinity) ninf++
      else { nf++; if (Object.is(x, -0)) nz++; s.add(x) }
    }
    if (nan || (pinf && ninf)) return NaN
    if (pinf) return Infinity
    if (ninf) return -Infinity
    if (nf > 0 && nz === nf) return -0
    const v = s.value()
    return v === 0 ? 0 : v
  }
  function query(cut) {
    const top = [], pg = [], eqk = [], gtk = [], all = []
    const bl = new Map(), bv = new Map()
    for (const [k, row] of cut) {
      topK(top, row)
      if (after(row)) { if (pg.length < K || cmpZa(row, pg[pg.length - 1]) < 0) { let lo = 0, hi = pg.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpZa(pg[mid], row) < 0) lo = mid + 1; else hi = mid } pg.splice(lo, 0, row); if (pg.length > K) pg.pop() } }
      const x = num(row.points)
      if (x !== undefined) all.push(x)
      if (svz(row.room, 'r7')) eqk.push(k)
      if (x !== undefined && x > 50) gtk.push(k)
      const b = bkey(row.room)
      if (b !== undefined) { bl.set(b, (bl.get(b) ?? 0) + 1); let a = bv.get(b); if (a === undefined) bv.set(b, (a = [])); if (x !== undefined) a.push(x) }
    }
    const bySum = new Map()
    for (const [b, a] of bv) bySum.set(b, oSum(a))
    return { top: top.map((r) => r.id), page: pg.map((r) => r.id), byLen: bl, bySum, sum: oSum(all), eq: eqk, gt: gtk }
  }

  const C = [new Consumer(0), new Consumer(1)]
  function syncCompare(tag) {
    for (const c of C) c.drain()
    const a = C[0].read(), b = C[1].read()
    tally('two stores equal at equal cuts: za', canon(a.za) === canon(b.za), () => `${tag} ${canon(a.za)} vs ${canon(b.za)}`)
    tally('two stores equal at equal cuts: page', canon(a.page) === canon(b.page), () => `${tag}`)
    tally('two stores equal at equal cuts: by', mapEq(a.byLen, b.byLen) && mapEq(a.bySum, b.bySum), () => `${tag}`)
    tally('two stores equal at equal cuts: scalars', a.len === b.len && Object.is(a.sum, b.sum), () => `${tag} ${a.len}/${b.len} ${canon(a.sum)}/${canon(b.sum)}`)
    const rowsEq = (x, y) => x.rowCount() === y.rowCount() && keysOf({ [NODE]: x }).every((k) => y.hasRow(k))
    tally('two stores equal at equal cuts: filters', rowsEq(a.eq, b.eq) && rowsEq(a.gt, b.gt), () => `${tag}`)
  }

  const t0 = performance.now()
  for (let step = 1; step <= COMMITS; step++) {
    if (move !== null && move.A !== undefined) stepMove(step)
    else if (move === null && (groups.size > 1 || elastic) && R() < 1 / 40) startMove(step)
    if (move !== null && move.A === undefined) move = null
    sourceCommit()
    for (const c of C) c.tick()
    if (step % SYNC_EVERY === 0) syncCompare('step ' + step)
  }
  while (move !== null && move.A !== undefined) { stepMove(Infinity) }
  syncCompare('end')
  const ms = performance.now() - t0
  const st = C.map((c) => ({ ...c.st, ...c.store.st }))
  return { stats, firstBad, moves, slotMoves, grows, shrinks, groupsAtEnd: [...groups.values()].filter((g) => g.alive).length, rows: truth.size, ms, consumers: st }
}

const out = { exp: 'E-57', part: 'b-merge', claim: 'B1', bench: 'store-by-slot', groups: GROUPS, dom: DOM, keys: KEYS, lagMax: LAGMAX, slots: SLOTS, mutate: MUTATE || null }
if (SEEDS > 0) {
  let failed = 0, checks = 0, mism = 0, moves = 0, slotMoves = 0, first = null
  const byCheck = {}
  for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
    const r = runSeed(seed)
    let bad = 0
    for (const [n, s] of r.stats) { checks += s.n; mism += s.bad; bad += s.bad; (byCheck[n] ??= [0, 0]); byCheck[n][0] += s.n; byCheck[n][1] += s.bad }
    if (bad) { failed++; if (first === null) first = { seed, firstBad: r.firstBad } }
    moves += r.moves; slotMoves += r.slotMoves
  }
  console.log(JSON.stringify({ ...out, seeds: SEEDS, seed0: SEED0, commits: COMMITS, seedsFailed: failed, checks, mismatches: mism, moves, slotMoves, byCheck, first }))
} else {
  const r = runSeed(SEED0)
  const byCheck = Object.fromEntries([...r.stats].map(([n, s]) => [n, [s.n, s.bad]]))
  const checks = [...r.stats.values()].reduce((a, s) => a + s.n, 0), mism = [...r.stats.values()].reduce((a, s) => a + s.bad, 0)
  console.log(JSON.stringify({ ...out, seed: SEED0, commits: COMMITS, checks, mismatches: mism, moves: r.moves, slotMoves: r.slotMoves, grows: r.grows, shrinks: r.shrinks, groupsAtEnd: r.groupsAtEnd, rows: r.rows, seconds: Math.round(r.ms / 100) / 10, consumers: r.consumers, byCheck, firstBad: r.firstBad }))
}
