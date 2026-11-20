// B2: the new operators are exact. One data store; a value domain of 10 (many ties). After every commit:
//   by('at', { step: 100 }).length(), by('at', { step: 100 }).sum('points'), by('room').sum('points'),
//   group('room') with per-row deltas (and a mirror built only from those deltas), eq('points', 3),
//   in('room', ['r1', 'r3', 2]), and keyset pages (za and az, after fixed cursors) each equal their query run
//   from scratch on the store's rows (an independent fold).
// Page joins (B2): at random cuts, a walk of pages of 7 over the shared index (src/index.mjs), each page the 7
//   rows after the last page's cursor, joined end to end, must equal the whole sorted list: no row repeated or
//   skipped. Once per seed the same walk runs on data's own page views (filter(after).az(cmp, 7)), one per page.
// XB-7: a walk whose pages are fetched at DIFFERENT cuts (commits in between): every row whose sort value did not
//   change during the walk is seen exactly once; rows that changed are counted and reported, not asserted.
// Planted (MUTATE): cursor (a page cursor of the value only: after = value strictly after, so tied rows are
//   skipped), keepempty (by() keeps an emptied bucket: C5 off).
//   node b2-ops.mjs <seeds> <commits> [rows]
import { rng, canon, num, svz, bkey, stepKey, rowCmp, afterCursor, cursorOf, cmpVal, E23Sum, applyRec, recKey } from '../src/lib.mjs'
import { D, NODE, laneOf, keysOf, eq, isIn, page, ByView, GroupView } from '../src/ops.mjs'
import { OrderIndex2 } from '../src/index.mjs'

const SEEDS = +(process.argv[2] ?? 1000), COMMITS = +(process.argv[3] ?? 300), ROWS = +(process.argv[4] ?? 120)
const MUTATE = process.env.MUTATE ?? ''
const PAGE = 7, STEP = 100

function oSum(vals) { // from scratch, add-only (values here are small integers): the -0 rule and counts apart
  let nf = 0, nz = 0
  const s = new E23Sum()
  for (const x of vals) { nf++; if (Object.is(x, -0)) nz++; s.add(x) }
  if (nf > 0 && nz === nf) return -0
  const v = s.value()
  return v === 0 ? 0 : v
}
const mapEq = (a, b) => { if (a.size !== b.size) return false; for (const [k, x] of b) if (!a.has(k) || !Object.is(a.get(k), x)) return false; return true }

const totals = new Map()
let firstBad = null
const tally = (name, ok, ex) => {
  let s = totals.get(name)
  if (s === undefined) totals.set(name, (s = { n: 0, bad: 0, seeds: new Set() }))
  s.n++
  if (!ok) { s.bad++; s.seeds.add(curSeed); if (firstBad === null) firstBad = `seed ${curSeed} ${name}: ${ex()}`.slice(0, 400) }
}
let curSeed = 0
let walks = 0, walkPages = 0, dataWalks = 0, cutWalks = 0, cutWalkRowsChanged = 0, cutWalkRowsStable = 0

function runSeed(seed) {
  curSeed = seed
  const R = rng(seed * 7 + 3)
  const src = D.$({})
  const lane = laneOf(src)
  const truth = new Map()
  const mkRow = (k) => ({ id: k, points: Math.floor(R() * 10), room: R() < 0.85 ? 'r' + Math.floor(R() * 5) : R() < 0.5 ? 2 : '2', at: Math.floor(R() * 1000) })
  const keys = Array.from({ length: ROWS * 1.5 }, (_, i) => (i % 13 === 7 ? 'k\u{1F600}' + i : 'k' + i))
  // the views
  const byStepLen = new ByView(src, 'at', { step: STEP, agg: 'length', keepEmpty: MUTATE === 'keepempty' })
  const byStepSum = new ByView(src, 'at', { step: STEP, agg: 'sum', of: 'points', keepEmpty: MUTATE === 'keepempty' })
  const byRoomSum = new ByView(src, 'room', { agg: 'sum', of: 'points', keepEmpty: MUTATE === 'keepempty' })
  const mirror = new Map() // group('room') rebuilt only from its per-row deltas
  let groupDeltas = 0
  const grp = new GroupView(src, 'room', { onCommit: (ds) => { for (const d of ds) { groupDeltas++; let g = mirror.get(d.b); if (d.row === undefined) { g.delete(d.k); if (g.size === 0) mirror.delete(d.b) } else { if (g === undefined) mirror.set(d.b, (g = new Map())); g.set(d.k, d.row) } } } })
  const vEq = eq(src, 'points', 3)
  const vIn = isIn(src, 'room', ['r1', 'r3', 2])
  const CURS = [['za', [5, 'k20']], ['za', [0, 'k5']], ['az', [4, 'k50']]]
  const pages = CURS.map(([dir, c]) => page(src, 'points', dir, PAGE, c))
  // the shared index for page walks: one per direction, fed by one row sink each
  const ix = { za: new OrderIndex2('za'), az: new OrderIndex2('az') }
  src.sink({
    init: () => {},
    apply: (b) => {
      for (const d of b.rows) for (const x of Object.values(ix)) {
        if (d.op !== 'add') x.remove(d.prev.points, d.key)
        if (d.op !== 'remove') x.insert(d.row.points, d.key)
      }
    },
  })
  const afterOf = (dir, cur) => MUTATE === 'cursor'
    ? (row) => cmpVal(dir, row.points, cur[0]) > 0 // planted: the value only
    : afterCursor('points', dir, cur)
  function walk(dir) { // pages over the shared index; the cursor is [value, key] (or the value only, planted)
    const out = []
    let cur = null
    for (let i = 0; i < 1000; i++) {
      let pg
      if (cur === null) pg = ix[dir].first(PAGE)
      else if (MUTATE === 'cursor') { const all = ix[dir].after(cur[0], '￿￿', PAGE * 100); pg = all.filter((e) => cmpVal(dir, e.v, cur[0]) > 0).slice(0, PAGE) }
      else pg = ix[dir].after(cur[0], cur[1], PAGE)
      walkPages++
      if (pg.length === 0) break
      for (const e of pg) out.push(e.k)
      const last = pg[pg.length - 1]
      cur = [last.v, last.k]
    }
    return out
  }
  function dataWalk(dir) { // the same walk on data's own views, one page view per cursor (the plan's form)
    const out = []
    let cur = null
    for (let i = 0; i < 1000; i++) {
      const v = cur === null ? src.az(rowCmp('points', dir), PAGE) : src.filter(afterOf(dir, cur)).az(rowCmp('points', dir), PAGE)
      const ks = keysOf(v)
      const rows = ks.map((k) => v[NODE].rowAt(k))
      v.dispose()
      if (ks.length === 0) break
      out.push(...ks)
      cur = cursorOf(rows[rows.length - 1], 'points')
    }
    return out
  }
  function commit() {
    const recs = []
    const n = R() < 0.1 ? 2 + Math.floor(R() * 6) : 1
    const used = new Set()
    for (let i = 0; i < n; i++) {
      const k = keys[Math.floor(R() * keys.length)]
      if (used.has(k)) continue
      used.add(k)
      const u = R()
      if (!truth.has(k)) recs.push({ type: 1, key: [], at: k, value: mkRow(k) })
      else if (u < 0.45) recs.push({ type: 0, key: [k, 'points'], value: Math.floor(R() * 10) })
      else if (u < 0.6) recs.push({ type: 0, key: [k, 'room'], value: R() < 0.85 ? 'r' + Math.floor(R() * 5) : R() < 0.5 ? 2 : '2' })
      else if (u < 0.75) recs.push({ type: 0, key: [k, 'at'], value: Math.floor(R() * 1000) })
      else if (u < 0.85) recs.push({ type: 0, key: [k], value: mkRow(k) })
      else recs.push({ type: 2, key: [k] })
    }
    lane(recs)
    for (const r of recs) applyRec(truth, r)
  }
  function check() {
    const rows = [...truth.values()]
    // by with step
    const qsl = new Map(), qss = new Map(), qrs = new Map()
    const vals = new Map(), rvals = new Map()
    for (const r of rows) {
      const b = stepKey(r.at, STEP)
      if (b !== undefined) { qsl.set(b, (qsl.get(b) ?? 0) + 1); let a = vals.get(b); if (!a) vals.set(b, (a = [])); const x = num(r.points); if (x !== undefined) a.push(x) }
      const rb = bkey(r.room)
      if (rb !== undefined) { let a = rvals.get(rb); if (!a) rvals.set(rb, (a = [])); const x = num(r.points); if (x !== undefined) a.push(x) }
    }
    for (const [b, a] of vals) qss.set(b, oSum(a))
    for (const [b, a] of rvals) qrs.set(b, oSum(a))
    tally('by(at, {step}).length()', mapEq(byStepLen.snapshot(), qsl), () => `${canon(byStepLen.snapshot())} vs ${canon(qsl)}`)
    tally('by(at, {step}).sum(points)', mapEq(byStepSum.snapshot(), qss), () => `${canon(byStepSum.snapshot())} vs ${canon(qss)}`)
    tally('by(room).sum(points)', mapEq(byRoomSum.snapshot(), qrs), () => `${canon(byRoomSum.snapshot())} vs ${canon(qrs)}`)
    // group(room): the view, and the mirror built only from its deltas
    const qg = new Map()
    for (const r of rows) { const b = bkey(r.room); if (b === undefined) continue; let g = qg.get(b); if (!g) qg.set(b, (g = new Map())); g.set(r.id, canon(r)) }
    const asCanon = (m) => { const o = new Map(); for (const [b, g] of m) { const x = new Map(); for (const [k, r] of g) x.set(k, canon(r)); o.set(b, x) } return o }
    const gEq = (a, b) => { if (a.size !== b.size) return false; for (const [k, g] of b) { const h = a.get(k); if (!h || h.size !== g.size) return false; for (const [kk, c] of g) if (h.get(kk) !== c) return false } return true }
    tally('group(room) per-row deltas: view', gEq(asCanon(grp.m), qg), () => 'view')
    tally('group(room) per-row deltas: mirror from deltas', gEq(asCanon(mirror), qg), () => 'mirror')
    // eq, in (SameValueZero, typed)
    const qe = rows.filter((r) => svz(r.points, 3)).map((r) => r.id).sort()
    const qi = rows.filter((r) => r.room === 'r1' || r.room === 'r3' || r.room === 2).map((r) => r.id).sort()
    tally('eq(points, 3)', canon(keysOf(vEq).sort()) === canon(qe), () => `${keysOf(vEq).length} vs ${qe.length}`)
    tally("in(room, ['r1','r3',2])", canon(keysOf(vIn).sort()) === canon(qi), () => `${keysOf(vIn).length} vs ${qi.length}`)
    // keyset pages after fixed cursors (data's views)
    CURS.forEach(([dir, c], i) => {
      const cmp = rowCmp('points', dir), aft = afterCursor('points', dir, c)
      const q = rows.filter(aft).sort(cmp).slice(0, PAGE).map((r) => r.id)
      tally(`page ${dir} after ${canon(c)}`, canon(keysOf(pages[i])) === canon(q), () => `${canon(keysOf(pages[i]))} vs ${canon(q)}`)
    })
  }
  const wholeSorted = (dir) => [...truth.values()].sort(rowCmp('points', dir)).map((r) => r.id)
  let cutWalk = null // XB-7: a walk spread over several commits
  for (let c = 0; c < COMMITS; c++) {
    commit()
    check()
    if (R() < 1 / 3) { // B2: a page walk at this cut, joined
      const dir = R() < 0.5 ? 'za' : 'az'
      const j = walk(dir), w = wholeSorted(dir)
      walks++
      tally('page walk at one cut = whole sorted list', canon(j) === canon(w), () => `${j.length} vs ${w.length}; repeated ${j.length - new Set(j).size}`)
    }
    // XB-7: one page per commit; the walk starts when none is open
    if (cutWalk === null && R() < 0.1) cutWalk = { dir: R() < 0.5 ? 'za' : 'az', cur: null, seen: new Map(), start: new Map([...truth].map(([k, r]) => [k, canon(r.points)])), changed: new Set() }
    if (cutWalk !== null) {
      const w = cutWalk, x = ix[w.dir]
      let pg
      if (w.cur === null) pg = x.first(PAGE)
      else if (MUTATE === 'cursor') pg = x.after(w.cur[0], '￿￿', PAGE * 100).filter((e) => cmpVal(w.dir, e.v, w.cur[0]) > 0).slice(0, PAGE)
      else pg = x.after(w.cur[0], w.cur[1], PAGE)
      for (const e of pg) w.seen.set(e.k, (w.seen.get(e.k) ?? 0) + 1)
      if (pg.length === 0) {
        // stable rows: present at the start and now, with the same sort value, and never changed between
        for (const [k, p] of w.start) {
          if (w.changed.has(k) || !truth.has(k) || canon(truth.get(k).points) !== p) { cutWalkRowsChanged++; continue }
          cutWalkRowsStable++
          tally('XB-7 a stable row is seen exactly once across cuts', w.seen.get(k) === 1, () => `${k} seen ${w.seen.get(k) ?? 0}`)
        }
        cutWalks++
        cutWalk = null
      } else { const last = pg[pg.length - 1]; w.cur = [last.v, last.k] }
    }
    // rows whose sort value changes during an open walk are marked changed (the truth log, not the index)
    if (cutWalk !== null) for (const [k, p] of cutWalk.start) { const r = truth.get(k); if (r === undefined || canon(r.points) !== p) cutWalk.changed.add(k) }
  }
  { // once per seed: the walk on data's own page views
    const dir = R() < 0.5 ? 'za' : 'az'
    const j = dataWalk(dir), w = wholeSorted(dir)
    dataWalks++
    tally("page walk on data's page views = whole sorted list", canon(j) === canon(w), () => `${j.length} vs ${w.length}`)
  }
  return groupDeltas
}

const t0 = performance.now()
let gd = 0
for (let s = 1; s <= SEEDS; s++) gd += runSeed(s)
const byCheck = Object.fromEntries([...totals].map(([n, s]) => [n, { checks: s.n, mismatches: s.bad, seedsFailed: s.seeds.size }]))
const seedsFailed = new Set([...totals.values()].flatMap((s) => [...s.seeds])).size
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'B2+XB-7', bench: 'new-operators', planted: MUTATE || null, seeds: SEEDS, commits: COMMITS, rows: ROWS, seedsFailed, checks: [...totals.values()].reduce((a, s) => a + s.n, 0), mismatches: [...totals.values()].reduce((a, s) => a + s.bad, 0), pageWalksAtOneCut: walks, pagesRead: walkPages, dataWalks, cutWalks, cutWalkRowsStable, cutWalkRowsChanged, groupDeltas: gd, seconds: Math.round(performance.now() - t0) / 1000, byCheck, firstBad }))
