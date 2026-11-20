// B6, XB-12: views on a past reader. One resource, a log of commits (1 to 4 records each), and a fold-version
// change halfway: commits before F were folded by data build b1, those from F on by b2. The two builds fold one
// record kind differently (`incr`: b1 caps the field at 9, b2 does not), as two real data builds can (E-43 found
// 578 rows differ). The live copies folded each stretch under its own build; the oracle is their state.
// The reader (E-54's design, as E-55 claim 23): a snapshot at S, then per-key version lists (fat nodes) built in
// one pass over the window, each stretch under its own build (XB-12; the reader holds both builds). A step or a
// seek moves the reader's store to a new position by ONE data commit of the rows that differ. Views on the store:
// za('points', 5) (total order), by('room').sum('points') (exact), eq('room', 'r1'). After every step and seek:
// each view equals the query over the live copies' rows at that position, each view got at most one sink call,
// and exactly one when its value changed. A reader that cannot load b1 is refused `old-fold` at every position
// whose window needs b1, and only there.
// Planted (MUTATE): byrecord (a step applies record by record), noseek (a seek moves the position, not the
// views), newest (the whole window folded under the newest build).
//   node b6-past.mjs <seeds> <commits>
import { rng, canon, num, bkey, rowCmp, applyRec, E23Sum } from '../src/lib.mjs'
import { D, laneOf, keysOf, za, eq, ByView } from '../src/ops.mjs'

const SEEDS = +(process.argv[2] ?? 1000), COMMITS = +(process.argv[3] ?? 120)
const MUTATE = process.env.MUTATE ?? ''
const T = { seeds: 0, checks: 0, unequal: 0, sinkOver: 0, sinkMissing: 0, steps: 0, seeks: 0, oldFoldRight: 0, oldFoldWrong: 0, crossings: 0, planRuleRefusals: 0, seedsFailed: 0 }
let first = null

function foldRec(build, rows, rec) { // one record under a data build
  if (rec.type === 'incr') {
    const r = rows.get(rec.k)
    if (r === undefined) return
    const v = (num(r.points) ?? 0) + rec.by
    rows.set(rec.k, { ...r, points: build === 'b1' ? Math.min(v, 9) : v })
    return
  }
  applyRec(rows, rec)
}
function oQuery(rows) {
  const top = [...rows.values()].sort(rowCmp('points', 'za')).slice(0, 5).map((r) => r.id)
  const vals = new Map()
  for (const r of rows.values()) { const b = bkey(r.room); if (b === undefined) continue; let a = vals.get(b); if (!a) vals.set(b, (a = [])); const x = num(r.points); if (x !== undefined) a.push(x) }
  const by = new Map()
  for (const [b, a] of vals) { const s = new E23Sum(); for (const x of a) s.add(x); const v = s.value(); by.set(b, v === 0 ? 0 : v) }
  const e = [...rows.values()].filter((r) => r.room === 'r1').map((r) => r.id).sort()
  return { top, by, eq: e }
}

function runSeed(seed) {
  const R = rng(seed * 61 + 7)
  const keys = Array.from({ length: 40 }, (_, i) => 'k' + i)
  // the log: commits of records; the live copies fold each stretch under its build
  const commits = []
  const live = new Map()
  const liveAt = [new Map()] // live rows after commit p (p = 0: before any)
  const F = Math.floor(COMMITS / 2)
  for (let c = 0; c < COMMITS; c++) {
    const recs = []
    const n = 1 + Math.floor(R() * 4)
    for (let i = 0; i < n; i++) {
      const k = keys[Math.floor(R() * keys.length)]
      const u = R()
      if (!live.has(k) || u < 0.15) recs.push({ type: 1, key: [], at: k, value: { id: k, points: Math.floor(R() * 10), room: 'r' + Math.floor(R() * 4) } })
      else if (u < 0.55) recs.push({ type: 'incr', k, by: 1 + Math.floor(R() * 4) })
      else if (u < 0.8) recs.push({ type: 0, key: [k, 'points'], value: Math.floor(R() * 10) })
      else if (u < 0.9) recs.push({ type: 0, key: [k, 'room'], value: 'r' + Math.floor(R() * 4) })
      else recs.push({ type: 2, key: [k] })
      foldRec(c < F ? 'b1' : 'b2', live, recs[recs.length - 1])
    }
    commits.push(recs)
    liveAt.push(new Map(live))
  }
  const S = Math.floor(R() * (F - 5)) // the snapshot, before the change: every window from S crosses F somewhere
  // the reader: fat nodes over [S, end], each stretch under its build (or the newest, planted)
  const buildOf = (c) => (MUTATE === 'newest' ? 'b2' : c < F ? 'b1' : 'b2')
  const fat = new Map() // key -> [[pos, row | undefined]] (pos = commits applied)
  const cur = new Map(liveAt[S])
  for (const [k, r] of cur) fat.set(k, [[S, r]])
  for (let c = S; c < COMMITS; c++) {
    const touched = new Set()
    for (const rec of commits[c]) { foldRec(buildOf(c), cur, rec); touched.add(rec.type === 'incr' ? rec.k : rec.type === 1 ? rec.at : rec.key[0]) }
    for (const k of touched) { let h = fat.get(k); if (!h) fat.set(k, (h = [])); h.push([c + 1, cur.get(k)]) }
  }
  const rowAt = (k, p) => { const h = fat.get(k); let v; if (h) for (const [q, r] of h) { if (q > p) break; v = r } return v }
  // the reader's store and views
  const src = D.$({}), lane = laneOf(src)
  let pos = S
  { const recs = [...liveAt[S]].map(([k, r]) => ({ type: 1, key: [], at: k, value: r })); if (recs.length) lane(recs) }
  const vz = za(src, 'points', 5), ve = eq(src, 'room', 'r1')
  let byCalls = 0
  const vb = new ByView(src, 'room', { agg: 'sum', of: 'points', onCommit: () => { byCalls++ } })
  const calls = { za: 0, eq: 0 }
  vz.sink({ init: () => {}, apply: () => { calls.za++ } })
  ve.sink({ init: () => {}, apply: () => { calls.eq++ } })
  const node = src[D.node]
  function moveTo(p, seek) { // one commit of the rows that differ between pos and p
    const lo = Math.min(pos, p), hi = Math.max(pos, p)
    const ks = new Set()
    for (let c = lo; c < hi; c++) for (const rec of commits[c]) ks.add(rec.type === 'incr' ? rec.k : rec.type === 1 ? rec.at : rec.key[0])
    const recs = []
    for (const k of ks) {
      const want = rowAt(k, p)
      const has = node.hasRow(k)
      if (want === undefined) { if (has) recs.push({ type: 2, key: [k] }) }
      else if (!has) recs.push({ type: 1, key: [], at: k, value: want })
      else if (canon(node.rowAt(k)) !== canon(want)) recs.push({ type: 0, key: [k], value: want })
    }
    if (seek && MUTATE === 'noseek') { pos = p; return }
    if (MUTATE === 'byrecord') for (const r of recs) lane([r]) // planted: one commit per record
    else if (recs.length) lane(recs)
    pos = p
  }
  let bad = 0
  function check() {
    const q = oQuery(liveAt[pos])
    const before = { za: calls.za, eq: calls.eq, by: byCalls }
    T.checks++
    const gz = keysOf(vz), ge = keysOf(ve).sort(), gb = vb.snapshot()
    let ok = canon(gz) === canon(q.top) && canon(ge) === canon(q.eq) && gb.size === q.by.size
    for (const [b, v] of q.by) if (!Object.is(gb.get(b), v)) ok = false
    if (!ok) { T.unequal++; bad++; if (first === null) first = `seed ${seed} pos ${pos}: za ${canon(gz)} vs ${canon(q.top)}; by ${canon(gb)} vs ${canon(q.by)}` }
  }
  let last = { top: canon(keysOf(vz)), eq: canon(keysOf(ve).sort()), by: canon(vb.snapshot()) }
  function oneMove(p, seek) {
    calls.za = 0; calls.eq = 0; byCalls = 0
    moveTo(p, seek)
    const now = { top: canon(keysOf(vz)), eq: canon(keysOf(ve).sort()), by: canon(vb.snapshot()) }
    // at most one sink call per view per move; exactly one when its value changed
    for (const [name, n, changed] of [['za', calls.za, now.top !== last.top], ['eq', calls.eq, now.eq !== last.eq], ['by', byCalls, now.by !== last.by]]) {
      if (n > 1) { T.sinkOver++; bad++; if (first === null) first = `seed ${seed} pos ${p}: ${name} got ${n} sink calls in one move` }
      if (changed && n === 0) { T.sinkMissing++; bad++ }
    }
    last = now
    check()
  }
  check()
  for (let i = 0; i < 40; i++) { // steps both ways and seeks
    if (R() < 0.7) { const d = R() < 0.6 ? 1 : -1; const p = Math.min(COMMITS, Math.max(S, pos + d)); T.steps++; oneMove(p, false) }
    else { const p = S + Math.floor(R() * (COMMITS - S + 1)); T.seeks++; oneMove(p, true) }
  }
  // old-fold: a reader that can load only b2 is refused exactly at the positions whose window needs b1
  const tags = commits.map((_, c) => (c < F ? 'b1' : 'b2')) // the fold-version each commit was folded under (in the log)
  const canOpen = (p, loadable) => { for (let c = S; c < p; c++) if (!loadable.has(tags[c])) return 'old-fold'; return 'ok' }
  for (let p = S; p <= COMMITS; p++) {
    const needsB1 = Math.min(p, F) > S // the oracle: the window [S, p) holds a commit before F
    const refused = canOpen(p, new Set(['b2'])) === 'old-fold'
    if (needsB1 === refused) T.oldFoldRight++; else { T.oldFoldWrong++; bad++ }
    if (canOpen(p, new Set(['b1', 'b2'])) !== 'ok') { T.oldFoldWrong++; bad++ } // both builds loaded: never refused
    if (p > F) { T.crossings++; T.planRuleRefusals++ } // the plan's K7 rule refuses every window that crosses F
  }
  T.seeds++
  if (bad) T.seedsFailed++
}

const t0 = performance.now()
for (let s = 1; s <= SEEDS; s++) runSeed(s)
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'B6+XB-12', bench: 'past-views', planted: MUTATE || null, seeds: SEEDS, commits: COMMITS, ...T, seconds: Math.round(performance.now() - t0) / 1000, first }))
