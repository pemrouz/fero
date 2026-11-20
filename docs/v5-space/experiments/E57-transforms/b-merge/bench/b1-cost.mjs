// B1, cost. Three parts, each in one process (pick by argv[2]):
//   feed   R1's compare and the store's bookkeeping per record: SlotStore.feedCommit against a plain lane call,
//          one record a commit, 1e5 rows (the same records both ways, interleaved, a full collection first)
//   diff   R2's diff commit per moved slot, by rows per slot (1, 10, 100, 1,000): every row of the side copy
//          differs from the store's (the worst case), one data commit
//   views  per-commit view costs as E-23 run D: 2,000 rows, 20,000 one-record commits (points and room writes),
//          each view alone on the store against none, and all eight together
// ns per record (feed, views) and microseconds per diff commit (diff); medians of 5 rounds.
//   node --expose-gc b1-cost.mjs feed|diff|views
import { D, laneOf, za, page, eq, gt, SumView, ByView } from '../src/ops.mjs'
import { SlotStore } from '../src/store.mjs'
import { slotOf, SLOTS } from '../src/lib.mjs'

const PART = process.argv[2]
const gc = () => { globalThis.gc?.(); globalThis.gc?.() }
const now = () => process.hrtime.bigint()
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const r1 = (x) => Math.round(x * 10) / 10
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
const out = { exp: 'E-57', part: 'b-merge', claim: 'B1', bench: 'cost-' + PART, node: process.version }

if (PART === 'feed') {
  const N = 100000, W = 50000
  const rows = () => { const r = rng(5); const recs = []; for (let i = 0; i < N; i++) recs.push({ type: 1, key: [], at: 'k' + i, value: { id: 'k' + i, points: r() % 100, room: 'r' + (r() % 50) } }); return recs }
  const r = rng(9)
  const ks = Array.from({ length: W }, () => 'k' + (r() % N)), vs = Array.from({ length: W }, () => r() % 100)
  const seq = new Float64Array(SLOTS)
  const items = ks.map((k, i) => { const s = slotOf(k); return { slot: s, seq: ++seq[s], rec: { type: 0, key: [k, 'points'], value: vs[i] } } })
  const xs = { lane: [], store: [] }
  for (let round = 0; round < 5; round++) {
    { const src = D.$({}), lane = laneOf(src); lane(rows()); gc(); const t0 = now(); for (const it of items) lane([it.rec]); xs.lane.push(Number(now() - t0) / W) }
    { const st = new SlotStore({ slots: SLOTS }); st.apply(rows()); gc(); const t0 = now(); for (const it of items) st.feedCommit([it]); xs.store.push(Number(now() - t0) / W) }
  }
  out.rows = N; out.records = W
  out.nsPerRecord = { lane: r1(med(xs.lane)), slotStore: r1(med(xs.store)) }
  out.r1AndBookkeepingNs = r1(med(xs.store) - med(xs.lane))
  // R1's drop path alone: records at or below the position (all dropped)
  const st = new SlotStore({ slots: SLOTS }); st.apply(rows()); for (const it of items) st.feedCommit([it])
  const ys = []
  for (let round = 0; round < 5; round++) { gc(); const t0 = now(); for (const it of items) st.feedCommit([it]); ys.push(Number(now() - t0) / W) }
  out.r1DropNsPerRecord = r1(med(ys))
} else if (PART === 'diff') {
  // 200 slots moved per round (one diff commit each), so the code is warm; 5 rounds
  out.usPerDiffCommit = {}; out.nsPerDiffRow = {}
  const MS = 200
  for (const per of [1, 10, 100, 1000]) {
    const xs = []
    for (let round = 0; round < 5; round++) {
      const st = new SlotStore({ slots: SLOTS })
      const bySlot = new Map()
      for (let i = 0; ; i++) {
        const k = 'k' + i, s = slotOf(k)
        if (s >= MS) continue
        let a = bySlot.get(s); if (!a) bySlot.set(s, (a = []))
        if (a.length < per) a.push(k)
        if (bySlot.size === MS && [...bySlot.values()].every((x) => x.length >= per)) break
      }
      const recs = []
      for (const ks of bySlot.values()) for (const k of ks) recs.push({ type: 1, key: [], at: k, value: { id: k, points: 1, room: 'r1' } })
      st.apply(recs)
      for (const [s, ks] of bySlot) st.side.set(s + ':1', { N: 10, rows: new Map(ks.map((k) => [k, { id: k, points: 2, room: 'r2' }])) })
      gc()
      const t0 = now()
      for (const s of bySlot.keys()) st.feedOpen(s, 10, 1)
      xs.push(Number(now() - t0) / 1000 / MS)
    }
    out.usPerDiffCommit[per] = r1(med(xs))
    out.nsPerDiffRow[per] = r1((med(xs) * 1000) / per)
  }
} else if (PART === 'views') {
  const N = 2000, W = 20000
  const r = rng(3)
  const init = Array.from({ length: N }, (_, i) => ({ type: 1, key: [], at: 'k' + i, value: { id: 'k' + i, points: r() % 101, room: 'r' + (r() % 50) } }))
  const ops = Array.from({ length: W }, () => { const k = 'k' + (r() % N); return r() % 4 === 0 ? { type: 0, key: [k, 'room'], value: 'r' + (r() % 50) } : { type: 0, key: [k, 'points'], value: r() % 101 } })
  const VIEWS = {
    none: () => [],
    'za(10)': (s) => [za(s, 'points', 10)],
    'page after cursor': (s) => [page(s, 'points', 'za', 10, [50, 'k1000'])],
    'by(room).length()': (s) => [new ByView(s, 'room', { agg: 'length' })],
    'by(room).sum(points)': (s) => [new ByView(s, 'room', { agg: 'sum', of: 'points' })],
    'length()': (s) => [s.length()],
    'sum(points) exact': (s) => [new SumView(s, 'points')],
    "data's sum(points)": (s) => [s.sum('points')],
    'eq(room, r7)': (s) => [eq(s, 'room', 'r7')],
    'gt(points, 50)': (s) => [gt(s, 'points', 50)],
    'all eight': (s) => [za(s, 'points', 10), page(s, 'points', 'za', 10, [50, 'k1000']), new ByView(s, 'room', { agg: 'length' }), new ByView(s, 'room', { agg: 'sum', of: 'points' }), s.length(), new SumView(s, 'points'), eq(s, 'room', 'r7'), gt(s, 'points', 50)],
  }
  const xs = Object.fromEntries(Object.keys(VIEWS).map((k) => [k, []]))
  for (let round = 0; round < 5; round++) {
    for (const [name, mk] of Object.entries(VIEWS)) {
      const src = D.$({}), lane = laneOf(src)
      lane(init)
      const vs = mk(src)
      for (const v of vs) if (v[D.value] !== undefined) v[D.value]
      gc()
      const t0 = now()
      for (const op of ops) lane([op])
      xs[name].push(Number(now() - t0) / W)
      for (const v of vs) v.dispose()
    }
  }
  out.rows = N; out.commits = W
  out.nsPerCommit = Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, r1(med(v))]))
  out.viewNsPerCommit = Object.fromEntries(Object.entries(xs).filter(([k]) => k !== 'none').map(([k, v]) => [k, r1(med(v) - med(xs.none))]))
}
console.log(JSON.stringify(out))
