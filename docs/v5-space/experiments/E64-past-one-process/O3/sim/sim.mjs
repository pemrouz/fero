// E-64 O3: partials keyed by slot, pushed down to a copy of each group, merged by key: exact through slot
// moves, groups made and removed, host failovers, outages, duplicates, merged frames and combiner rebuilds?
//
// The source is E-57 B1's world, unchanged in kind: one resource of 1,024 slots over G groups (4, 16, or elastic:
// 1 to 16, a grow moves half a group's slots to a new group, a shrink moves all of a group's slots out), 3,000
// keys in E-23's dirty domain, the three-step slot move of LAYERS 8.6 (B imports a copy at N0 while A takes
// writes; A fences at N; B takes the delta and opens at N). 5 % of commits touch several rows of one group.
//
// Each group has ONE HOST, a copy that folds the group's log at its head and sends its partials' frames into a
// stream (src/partial.mjs). One COMBINER takes frames from the G streams in its own interleaving, 0 to 3 a step,
// never more than 100 behind a stream. Faults, each drawn from the seed: a host failover (the stream's undelivered
// frames are lost; a new copy folds the log and starts a new stream with pictures), an outage (one stream sends
// nothing for 50 to 300 steps), a duplicate (a recent frame comes again), merged frames (a run of 2 to 6 frames
// at a stream's head becomes one, as a slow reader is folded), and a combiner rebuild (every stream restarts with
// pictures; answers wait until every slot has one).
//
// The oracle, after every frame the combiner takes (while it is ready): each answer against the query run from
// scratch on the TRUTH rows at the combiner's cut (each slot at the combiner's position for it), folded apart from
// each slot's own record log by code that shares nothing with the partials but the contract's definitions.
// Answers: length(), sum('points') exact, by('room') count / exact sum / max, za('points', 10) with key ties,
// gt('points', 50) rows. Also: no position goes back, and no frame ever leaves a gap (S2). It also counts TORN
// multi-row commits: a commit of several slots of one group that the cut shows in part (a measure, not a bug).
//   node sim.mjs --groups=4|16|elastic --commits=100000 --seed=1 [--mutate=..] [--early]
//   node sim.mjs --seeds=1000 --commits=400 --keys=300 ...       many short seeds; one JSON line
import { rng, SLOTS, slotOf, canon, num, bkey, rowCmp, E23Sum, applyRec, recKey, makeRow, genPoints, genRoom, keyName, maxBetter } from '../src/lib.mjs'
import { Host, Combiner, mergeFrames, K } from '../src/partial.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const flag = (n) => process.argv.includes('--' + n)
const GROUPS = arg('groups', '4'), COMMITS = +arg('commits', '100000'), DOM = arg('dom', 'dirty')
const KEYS = +arg('keys', '3000'), LAGMAX = +arg('lag', '100'), MUTATE = arg('mutate', ''), EARLY = flag('early')
const SEEDS = +arg('seeds', '0'), SEED0 = +arg('seed', '1')
const FULL_EVERY = 1000

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
  const ev = { hostFailovers: 0, outages: 0, duplicates: 0, merges: 0, rebuilds: 0, deliveries: 0, checks: 0, tornSeen: 0, tornCommits: 0, multiCommits: 0, notReadySteps: 0, gapThrows: 0 }

  // ── the source (E-57 B1's world) ───────────────────────────────────────────────────────────────────
  const slotLog = Array.from({ length: SLOTS }, () => [])
  const slotSeq = new Float64Array(SLOTS)
  const truth = new Map()
  const truthKeys = Array.from({ length: SLOTS }, () => new Set())
  const owner = new Int32Array(SLOTS)
  const fenced = new Uint8Array(SLOTS)
  const groups = new Map()
  let nextGid = 0
  const hostOpts = { mutate: MUTATE, early: EARLY, slotOf }
  const newGroup = (slots) => {
    const g = { gid: nextGid++, log: [], alive: true }
    g.host = new Host(g.gid, hostOpts)
    for (const s of slots) { g.host.rows.set(s, new Map()); g.host.pos.set(s, 0) }
    g.paused = 0 // an outage: steps left with nothing sent
    g.recent = [] // frames taken lately, for duplicates
    groups.set(g.gid, g)
    return g
  }
  const elastic = GROUPS === 'elastic'
  const G0 = elastic ? 1 : +GROUPS
  for (let s = 0; s < SLOTS; s++) owner[s] = Math.floor((s * G0) / SLOTS)
  for (let i = 0; i < G0; i++) { const mine = []; for (let s = 0; s < SLOTS; s++) if (owner[s] === i) mine.push(s); newGroup(mine) }
  const slotsOf = (gid) => { const xs = []; for (let s = 0; s < SLOTS; s++) if (owner[s] === gid) xs.push(s); return xs }
  const rowsOfSlot = (s) => { const m = new Map(); for (const k of truthKeys[s]) m.set(k, truth.get(k)); return m }
  const append = (g, e) => { g.log.push(e); g.host.feed(e, applyRec) } // the host is a copy at the group's head

  const multi = [] // the last multi-slot commits: [[slot, seq], ...]
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
    const ss = new Map(); for (const it of items) ss.set(it.slot, it.seq)
    if (ss.size > 1) { ev.multiCommits++; multi.push({ id: ev.multiCommits, at: [...ss], torn: false }); if (multi.length > 300) multi.shift() }
    append(groups.get(gid), { kind: 'commit', items })
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
      if (R() < 0.05) { // several rows of one group in one commit
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
      if (fenced[s]) continue
      commit(owner[s], [opFor(k)])
      if (truth.has(k)) addLive(k); else delLive(k)
      return
    }
  }

  // ── slot moves (LAYERS 8.6), as B1 ─────────────────────────────────────────────────────────────────
  let move = null, moves = 0, slotMoves = 0, grows = 0, shrinks = 0
  function startMove(step) {
    const gs = [...groups.values()].filter((g) => g.alive)
    let A, B, slots
    if (elastic) {
      if (gs.length < 16 && (gs.length === 1 || R() < 0.5)) {
        const big = gs.filter((g) => slotsOf(g.gid).length >= 2)
        A = big[Math.floor(R() * big.length)]
        if (!A) return
        B = newGroup([]); grows++
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
    const N0 = new Map()
    for (const s of slots) { N0.set(s, slotSeq[s]); append(B, { kind: 'import', slot: s, N0: slotSeq[s], rows: rowsOfSlot(s) }) }
    move = { shrink: move?.shrink ?? false, A, B, slots, N0, phase: 'copy', at: step + 1 + Math.floor(R() * 12) }
  }
  function stepMove(step) {
    if (move.at > step) return
    if (move.phase === 'copy') {
      for (const s of move.slots) { fenced[s] = 1; append(move.A, { kind: 'fence', slot: s, N: slotSeq[s] }) }
      move.phase = 'fenced'
      move.at = step + 1 + Math.floor(R() * 6)
      return
    }
    for (const s of move.slots) {
      const N = slotSeq[s], N0 = move.N0.get(s)
      const items = []
      for (let q = N0; q < N; q++) items.push({ slot: s, seq: q + 1, rec: slotLog[s][q] })
      append(move.B, { kind: 'delta', slot: s, items })
      append(move.B, { kind: 'open', slot: s, N })
      owner[s] = move.B.gid
      fenced[s] = 0
    }
    moves++
    slotMoves += move.slots.length
    if (move.shrink) { move.A.alive = false; shrinks++ }
    move = null
  }

  // ── the combiner, its streams, and the truth at its cut ─────────────────────────────────────────────
  const pergroup = MUTATE === 'pergroup'
  const keysNow = () => (pergroup ? [...groups.values()].filter((g) => g.alive).map((g) => 'g' + g.gid) : Array.from({ length: SLOTS }, (_, s) => s))
  let comb = new Combiner({ mutate: MUTATE, keys: keysNow() })
  const CR = rng(SEED * 1009 + 17)
  const cut = new Map()
  const cutKeys = Array.from({ length: SLOTS }, () => new Set())
  const cutPos = new Float64Array(SLOTS)
  const spPos = new Float64Array(SLOTS) // pergroup: the slot positions the frames named (the oracle's cut)
  const touched = new Set()
  const backlog = (g) => g.host.out.length
  const posOf = (s) => (pergroup ? spPos[s] : comb.pos.get(s))
  function cutApply(s, rec) {
    const k = recKey(rec)
    applyRec(cut, rec)
    if (cut.has(k)) cutKeys[s].add(k); else cutKeys[s].delete(k)
    touched.add(k)
  }
  function syncCut(slots) {
    for (const s of slots) {
      const p = posOf(s)
      if (p < 0) continue
      if (p < cutPos[s]) {
        tally('positions never go back', false, () => `slot ${s}: ${cutPos[s]} -> ${p}`)
        for (const k of cutKeys[s]) { cut.delete(k); touched.add(k) }
        cutKeys[s].clear()
        for (let q = 0; q < p; q++) cutApply(s, slotLog[s][q])
      } else for (let q = cutPos[s]; q < p; q++) cutApply(s, slotLog[s][q])
      cutPos[s] = p
    }
  }
  function deliver(g) {
    let f = g.host.out.shift()
    // a slow reader is folded: a run of frames at the head becomes one
    if (CR() < 0.2 && g.host.out.length > 0) {
      const n = 1 + Math.floor(CR() * 5)
      for (let i = 0; i < n && g.host.out.length > 0; i++) f = mergeFrames(f, g.host.out.shift(), MUTATE)
      ev.merges++
    }
    takeFrame(g, f)
    g.recent.push(f); if (g.recent.length > 8) g.recent.shift()
  }
  function takeFrame(g, f) {
    ev.deliveries++
    try { comb.take(f) } catch (e) { ev.gapThrows++; tally('no gap (S2)', false, () => e.message); return }
    const slots = new Set()
    if (pergroup) { for (const [s, p] of f.sp ?? []) if (p > spPos[s]) { spPos[s] = p; slots.add(s) } }
    else for (const e of f.e) slots.add(e.k)
    syncCut(slots)
    if (comb.ready()) check(ev.deliveries % FULL_EVERY === 0)
  }
  function restartStream(g) { // S3: a new stream from another copy starts with pictures (the old one's frames are lost)
    const h = new Host(g.gid, hostOpts)
    h.emit = false
    for (const s of slotsOfAtStart.get(g.gid) ?? []) { h.rows.set(s, new Map()); h.pos.set(s, 0) }
    for (const e of g.log) h.feed(e, applyRec)
    h.emit = true
    g.host = h
    h.pictures()
  }
  const slotsOfAtStart = new Map()
  for (const g of groups.values()) slotsOfAtStart.set(g.gid, [...g.host.rows.keys()])
  const combTot = {}
  const addTot = () => { for (const [k, v] of Object.entries(comb.st)) combTot[k] = (combTot[k] ?? 0) + v }
  function rebuildCombiner() {
    addTot()
    for (const g of groups.values()) g.recent = [] // a new combiner reads new streams only
    comb = new Combiner({ mutate: MUTATE, keys: keysNow(), fresh: true })
    ev.rebuilds++
    for (const g of groups.values()) { g.paused = 0; restartStream(g) }
  }
  function tick() {
    if (CR() < 1 / 700) { // a duplicate: a recent frame comes again
      const gs = [...groups.values()].filter((g) => g.recent.length > 0)
      if (gs.length > 0) { const g = gs[Math.floor(CR() * gs.length)]; ev.duplicates++; takeFrame(g, g.recent[Math.floor(CR() * g.recent.length)]) }
    }
    if (CR() < 1 / 900) { const gs = [...groups.values()]; const g = gs[Math.floor(CR() * gs.length)]; ev.hostFailovers++; restartStream(g) }
    if (CR() < 1 / 1500) { const gs = [...groups.values()]; const g = gs[Math.floor(CR() * gs.length)]; ev.outages++; g.paused = 50 + Math.floor(CR() * 251); g.failAfter = CR() < 0.5 }
    if (CR() < 1 / 2500) rebuildCombiner()
    for (const g of groups.values()) {
      if (g.paused > 0) { g.paused--; if (g.paused === 0 && g.failAfter) { ev.hostFailovers++; restartStream(g) } continue }
      const b = backlog(g)
      if (b > LAGMAX) { const to = LAGMAX - Math.floor(CR() * 20); while (backlog(g) > to) deliver(g) }
    }
    const u = CR()
    const n = u < 0.4 ? 0 : u < 0.75 ? 1 : u < 0.92 ? 2 : 3
    for (let i = 0; i < n; i++) {
      const gs = [...groups.values()].filter((g) => g.paused === 0 && backlog(g) > 0)
      if (gs.length === 0) break
      deliver(gs[Math.floor(CR() * gs.length)])
    }
    if (!comb.ready()) ev.notReadySteps++
    // torn multi-slot commits: the cut shows part of one (allowed: no atomic write across partitions)
    if (ev.deliveries % 50 === 0) for (const m of multi) {
      let any = false, all = true
      for (const [s, seq] of m.at) { if (cutPos[s] >= seq) any = true; else all = false }
      if (any && !all) { ev.tornSeen++; if (!m.torn) { m.torn = true; ev.tornCommits++ } }
    }
  }
  function drain() { for (;;) { const gs = [...groups.values()].filter((g) => backlog(g) > 0); if (gs.length === 0) return; for (const g of gs) g.paused = 0; deliver(gs[Math.floor(CR() * gs.length)]) } }

  // ── the oracle ─────────────────────────────────────────────────────────────────────────────────────
  const cmpZa = rowCmp('points', 'za')
  function oSum(vals) { // from scratch, as E-57 B1: counts apart, the -0 rule, add-only exact partials
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
  function query() {
    const top = [], all = [], gtk = []
    const bl = new Map(), bv = new Map(), bm = new Map()
    for (const [k, row] of cut) {
      if (top.length < K || cmpZa(row, top[top.length - 1]) < 0) {
        let lo = 0, hi = top.length
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpZa(top[mid], row) < 0) lo = mid + 1; else hi = mid }
        top.splice(lo, 0, row); if (top.length > K) top.pop()
      }
      const x = num(row.points)
      if (x !== undefined) all.push(x)
      if (x !== undefined && x > 50) gtk.push(k)
      const b = bkey(row.room)
      if (b !== undefined) {
        bl.set(b, (bl.get(b) ?? 0) + 1)
        let a = bv.get(b); if (a === undefined) bv.set(b, (a = []))
        if (x !== undefined) { a.push(x); const m = bm.get(b); if (m === undefined || maxBetter(x, m)) bm.set(b, x) }
      }
    }
    const bySum = new Map()
    for (const [b, a] of bv) bySum.set(b, oSum(a))
    return { top: top.map((r) => r.id), byLen: bl, bySum, byMax: bm, sum: oSum(all), gt: gtk }
  }
  const mapEq = (a, b) => { if (a.size !== b.size) return false; for (const [k, x] of b) if (!a.has(k) || !Object.is(a.get(k), x)) return false; return true }
  function check(full) {
    ev.checks++
    const q = query()
    const a = comb.answers()
    tally('length()', a.len === cut.size, () => `${a.len} vs ${cut.size}`)
    tally('sum(points) exact', Object.is(a.sum, q.sum), () => `${canon(a.sum)} vs ${canon(q.sum)}`)
    tally('by(room) count', mapEq(a.byLen, q.byLen), () => `${canon(a.byLen)} vs ${canon(q.byLen)}`)
    tally('by(room) exact sum', mapEq(a.bySum, q.bySum), () => `${canon(a.bySum)} vs ${canon(q.bySum)}`)
    tally('by(room) max', mapEq(a.byMax, q.byMax), () => `${canon(a.byMax)} vs ${canon(q.byMax)}`)
    tally('za(points, 10) key sequence', canon(a.top) === canon(q.top), () => `${canon(a.top)} vs ${canon(q.top)}`)
    let ok = a.gt.size === q.gt.length, ex = `${a.gt.size} vs ${q.gt.length}`
    const ks = full ? q.gt : [...touched].filter((k) => a.gt.has(k) || (cut.has(k) && num(cut.get(k).points) > 50))
    if (ok) for (const k of ks) if (!a.gt.has(k) || canon(a.gt.get(k)) !== canon(cut.get(k))) { ok = false; ex = `${k}: ${canon(a.gt.get(k))} vs ${canon(cut.get(k))}`; break }
    tally('gt(points, 50) rows', ok, () => ex)
    touched.clear()
  }

  const t0 = performance.now()
  for (let step = 1; step <= COMMITS; step++) {
    if (move !== null && move.A !== undefined) stepMove(step)
    else if (move === null && (groups.size > 1 || elastic) && R() < 1 / 40) startMove(step)
    if (move !== null && move.A === undefined) move = null
    sourceCommit()
    tick()
  }
  while (move !== null && move.A !== undefined) stepMove(Infinity)
  drain()
  // at the end, the cut is every slot's head: the answers must equal the query over the true rows
  const atHead = (() => { for (let s = 0; s < SLOTS; s++) if (posOf(s) !== slotSeq[s]) return false; return true })()
  tally('drained: the cut is every slot\'s head', atHead || pergroup, () => 'some slot behind')
  if (comb.ready()) check(true)
  const ms = performance.now() - t0
  addTot()
  return { stats, firstBad, moves, slotMoves, grows, shrinks, groupsAtEnd: [...groups.values()].filter((g) => g.alive).length, rows: truth.size, ms, ev, comb: combTot }
}

const out = { exp: 'E-64', option: 'O3', bench: 'slot-partials', groups: GROUPS, dom: DOM, keys: KEYS, lagMax: LAGMAX, slots: SLOTS, mutate: MUTATE || null, early: EARLY }
if (SEEDS > 0) {
  let failed = 0, checks = 0, mism = 0, moves = 0, slotMoves = 0, first = null
  const byCheck = {}, evs = {}
  for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
    const r = runSeed(seed)
    let bad = 0
    for (const [n, s] of r.stats) { checks += s.n; mism += s.bad; bad += s.bad; (byCheck[n] ??= [0, 0]); byCheck[n][0] += s.n; byCheck[n][1] += s.bad }
    if (bad) { failed++; if (first === null) first = { seed, firstBad: r.firstBad } }
    moves += r.moves; slotMoves += r.slotMoves
    for (const [k, v] of Object.entries(r.ev)) evs[k] = (evs[k] ?? 0) + v
  }
  console.log(JSON.stringify({ ...out, seeds: SEEDS, seed0: SEED0, commits: COMMITS, seedsFailed: failed, checks, mismatches: mism, moves, slotMoves, events: evs, byCheck, first }))
} else {
  const r = runSeed(SEED0)
  const byCheck = Object.fromEntries([...r.stats].map(([n, s]) => [n, [s.n, s.bad]]))
  const checks = [...r.stats.values()].reduce((a, s) => a + s.n, 0), mism = [...r.stats.values()].reduce((a, s) => a + s.bad, 0)
  console.log(JSON.stringify({ ...out, seed: SEED0, commits: COMMITS, checks, mismatches: mism, moves: r.moves, slotMoves: r.slotMoves, grows: r.grows, shrinks: r.shrinks, groupsAtEnd: r.groupsAtEnd, rows: r.rows, seconds: Math.round(r.ms / 100) / 10, events: r.ev, combiner: r.comb, byCheck, firstBad: r.firstBad }))
}
