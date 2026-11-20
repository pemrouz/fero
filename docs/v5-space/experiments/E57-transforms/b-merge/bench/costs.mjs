// E-57 group B, the other costs. One part per process (argv[2]); medians of 5 rounds, the ways interleaved, a
// full collection before each round. Prototype costs (the operators are built on data's public API).
//   by <N>     B2: by(room).length() and by(room).sum(points) per change at N rows (16 buckets), against data's
//              group(fn) and lengthBuckets(fn) (today's counts per bucket); 2,000 writes (half points, half
//              room); memory per bucket (by(id-bucket).length() with 1e4 buckets)
//   derive     B3: a restart at 1e5 source rows and 1e3 buckets: build the view, read the target, diff
//   lookup     B4: per left change (its key already held); per right change at k = 1, 10, 100 left rows naming it;
//              memory per left row
//   past <M>   B6: a past reader over M records (1e4 rows): open (snapshot + fat nodes), a step with 1 and 10
//              views, a seek across 1e4 and 1e5 changed rows with views
//   sum        XB-4: ns per add and remove of WideSum against E-23's ExactSum, away from the limit (integers,
//              two-decimal floats) and near it
import { D, laneOf, ByView, za, eq } from '../src/ops.mjs'
import { Lookup } from '../src/lookup.mjs'
import { WideSum, E23Sum, canon, rowCmp } from '../src/lib.mjs'

const PART = process.argv[2], ARG = +(process.argv[3] ?? 0)
const gc = () => { globalThis.gc?.(); globalThis.gc?.() }
const now = () => process.hrtime.bigint()
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const r1 = (x) => Math.round(x * 10) / 10
const r3 = (x) => Math.round(x * 1000) / 1000
const heap = () => process.memoryUsage().heapUsed
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
const out = { exp: 'E-57', part: 'b-merge', bench: 'cost-' + PART, node: process.version }

if (PART === 'by') {
  const N = ARG, B = 16, W = 2000
  out.claim = 'B2'; out.rows = N
  const r = rng(N)
  const init = {}
  for (let i = 0; i < N; i++) init['k' + i] = { id: 'k' + i, points: r() % 100, room: 'r' + (r() % B) }
  const ops = Array.from({ length: W }, (_, i) => { const k = 'k' + (r() % N); return i % 2 ? { type: 0, key: [k, 'room'], value: 'r' + (r() % B) } : { type: 0, key: [k, 'points'], value: r() % 100 } })
  const WAYS = {
    none: () => [],
    'by(room).length()': (s) => [new ByView(s, 'room', { agg: 'length' })],
    'by(room).sum(points)': (s) => [new ByView(s, 'room', { agg: 'sum', of: 'points' })],
    "data's lengthBuckets(fn)": (s) => { const v = s.length((x) => x.room); v[D.value]; return [v] },
    "data's group(fn)": (s) => { const v = s.group((x) => x.room); v[D.value]; return [v] },
  }
  const xs = Object.fromEntries(Object.keys(WAYS).map((k) => [k, []]))
  for (let round = 0; round < 3; round++) {
    for (const [name, mk] of Object.entries(WAYS)) {
      const n = name === "data's group(fn)" && N >= 1e6 ? 200 : W // group at 1e6: about 2.5 ms a change (E-05)
      const src = D.$(structuredClone(init)), lane = laneOf(src)
      const vs = mk(src)
      gc()
      const t0 = now()
      for (let i = 0; i < n; i++) lane([ops[i]])
      xs[name].push(Number(now() - t0) / n)
      for (const v of vs) v.dispose()
    }
  }
  out.nsPerChange = Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, r1(med(v))]))
  out.viewNsPerChange = Object.fromEntries(Object.entries(xs).filter(([k]) => k !== 'none').map(([k, v]) => [k, r1(med(v) - med(xs.none))]))
  if (N === 1e4) { // memory per bucket: 1e4 rows, one bucket each, by(b).sum(points)
    const src = D.$(Object.fromEntries(Array.from({ length: 1e4 }, (_, i) => ['k' + i, { id: 'k' + i, points: i % 100, b: 'b' + i }])))
    gc(); const h0 = heap()
    const v = new ByView(src, 'b', { agg: 'sum', of: 'points' })
    gc(); const h1 = heap()
    const v2 = new ByView(src, 'b', { agg: 'length' })
    gc(); const h2 = heap()
    out.bytesPerBucket = { 'sum (an exact sum each)': Math.round((h1 - h0) / 1e4), length: Math.round((h2 - h1) / 1e4) }
    v.dispose(); v2.dispose()
  }
} else if (PART === 'derive') {
  out.claim = 'B3'
  const N = 1e5, BU = 1000
  const r = rng(7)
  const rows = {}
  for (let i = 0; i < N; i++) rows['o' + i] = { user: 'u' + (r() % BU), cents: r() % 500 }
  const xs = { build: [], read: [], diff: [], total: [] }
  let writes = 0
  for (let round = 0; round < 5; round++) {
    // the target as it stood: the view one cut earlier, with 10 % of the buckets stale and 1 % vanished
    const src0 = D.$(structuredClone(rows))
    const tv = new ByView(src0, 'user', { agg: 'sum', of: 'cents' })
    const target = new Map()
    for (const [b, val] of tv.snapshot()) { const x = r() % 100; if (x < 1) continue; target.set(b, x < 11 ? val + 1 : val) }
    target.set('sgone', 5)
    tv.dispose()
    const snap = structuredClone(rows)
    gc()
    const t0 = now()
    const src = D.$(snap) // the deriver's store from a snapshot of rows
    const v = new ByView(src, 'user', { agg: 'sum', of: 'cents' })
    const want = v.snapshot()
    const t1 = now()
    const have = new Map(target) // a read of the target's 1e3 rows (in process here: no network)
    const t2 = now()
    const w = []
    for (const [b, val] of want) if (!Object.is(have.get(b), val)) w.push({ b, val })
    for (const b of have.keys()) if (!want.has(b)) w.push({ b, val: undefined })
    const t3 = now()
    writes = w.length
    xs.build.push(Number(t1 - t0) / 1e6); xs.read.push(Number(t2 - t1) / 1e6); xs.diff.push(Number(t3 - t2) / 1e6); xs.total.push(Number(t3 - t0) / 1e6)
    v.dispose()
  }
  out.sourceRows = N; out.buckets = BU; out.diffWrites = writes
  out.ms = Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, r3(med(v))]))
} else if (PART === 'lookup') {
  out.claim = 'B4'
  const net = { now: () => 0, open: () => {}, close: () => {} }
  const res = { left: [], right: { 1: [], 10: [], 100: [] } }
  for (let round = 0; round < 5; round++) {
    // per left change: 1,000 left rows over 1,000 skus, all held; a change moves a row to another held sku
    {
      const left = D.$({}), lane = laneOf(left)
      lane(Array.from({ length: 1000 }, (_, i) => ({ type: 1, key: [], at: 'o' + i, value: { id: 'o' + i, sku: 's' + i } })))
      const J = new Lookup(left, 'sku', net)
      for (let i = 0; i < 1000; i++) J.picture('s' + i, { id: 's' + i, price: i })
      const r = rng(round + 1)
      const ops = Array.from({ length: 20000 }, () => ({ type: 0, key: ['o' + (r() % 1000), 'sku'], value: 's' + (r() % 1000) }))
      gc()
      const t0 = now()
      for (const op of ops) lane([op])
      res.left.push(Number(now() - t0) / ops.length)
      J.end()
    }
    // per right change at k rows naming it
    for (const k of [1, 10, 100]) {
      const left = D.$({}), lane = laneOf(left)
      lane(Array.from({ length: 1000 }, (_, i) => ({ type: 1, key: [], at: 'o' + i, value: { id: 'o' + i, sku: 's' + Math.floor(i / k) } })))
      const J = new Lookup(left, 'sku', net)
      const nk = Math.ceil(1000 / k)
      for (let i = 0; i < nk; i++) J.picture('s' + i, { id: 's' + i, price: 0 })
      const M = 5000
      gc()
      const t0 = now()
      for (let i = 0; i < M; i++) J.record('s' + (i % nk), { id: 's' + (i % nk), price: i })
      res.right[k].push(Number(now() - t0) / M)
      J.end()
    }
  }
  out.nsPerLeftChange = r1(med(res.left))
  out.nsPerRightChange = Object.fromEntries(Object.entries(res.right).map(([k, v]) => [k, r1(med(v))]))
  // memory per left row: 1e4 left rows over 1e3 skus, with the join, against the left source alone
  const left = D.$({}), lane = laneOf(left)
  lane(Array.from({ length: 1e4 }, (_, i) => ({ type: 1, key: [], at: 'o' + i, value: { id: 'o' + i, sku: 's' + (i % 1000) } })))
  gc(); const h0 = heap()
  const J = new Lookup(left, 'sku', net)
  for (let i = 0; i < 1000; i++) J.picture('s' + i, { id: 's' + i, price: i })
  gc(); const h1 = heap()
  out.bytesPerLeftRow = Math.round((h1 - h0) / 1e4)
  out.note = 'bytesPerLeftRow includes the 1,000 cached other rows and links (one per sku)'
} else if (PART === 'past') {
  out.claim = 'B6'
  const M = ARG, NR = 1e4
  const r = rng(3)
  const recs = []
  for (let i = 0; i < M; i++) { const k = 'k' + (r() % NR); recs.push({ k, row: { id: k, points: r() % 100, room: 'r' + (r() % 16) } }) }
  // open: the snapshot (NR rows) into a store, then fat nodes over the M records (one pass), as E-55 claim 23
  const xo = [], xs1 = [], xs10 = [], seeks = {}
  for (let round = 0; round < 3; round++) {
    gc()
    const t0 = now()
    const fat = new Map()
    for (let i = 0; i < M; i++) { const { k, row } = recs[i]; let h = fat.get(k); if (!h) fat.set(k, (h = [])); h.push(i + 1, row) }
    const snap = Array.from({ length: NR }, (_, i) => ({ type: 1, key: [], at: 'k' + i, value: { id: 'k' + i, points: 0, room: 'r0' } }))
    const src = D.$({}), lane = laneOf(src)
    lane(snap)
    xo.push(Number(now() - t0) / M)
    const rowAt = (k, p) => { const h = fat.get(k); let v; if (h) for (let j = 0; j < h.length; j += 2) { if (h[j] > p) break; v = h[j + 1] } return v }
    let pos = 0
    const node = src[D.node]
    const moveTo = (p) => {
      const lo = Math.min(pos, p), hi = Math.max(pos, p)
      const ks = new Set()
      for (let c = lo; c < hi; c++) ks.add(recs[c].k)
      const out = []
      for (const k of ks) { const w = rowAt(k, p) ?? { id: k, points: 0, room: 'r0' }; out.push(node.hasRow(k) ? { type: 0, key: [k], value: w } : { type: 1, key: [], at: k, value: w }) }
      if (out.length) lane(out)
      pos = p
    }
    const views = (n) => { const vs = [za(src, 'points', 5), new ByView(src, 'room', { agg: 'sum', of: 'points' }), eq(src, 'room', 'r1')]; for (let i = 3; i < n; i++) vs.push(eq(src, 'room', 'r' + i)); return vs.slice(0, n) }
    for (const [n, xs] of [[1, xs1], [10, xs10]]) {
      const vs = views(n)
      moveTo(M >> 1)
      gc()
      const S = 2000
      const t1 = now()
      for (let i = 0; i < S; i++) moveTo(pos + (i % 2 ? -1 : 1))
      xs.push(Number(now() - t1) / S)
      for (const v of vs) v.dispose()
    }
    // a seek across about 1e4 and 1e5 changed rows (from 0 to p), with the three views
    const vs = views(3)
    for (const span of [1e4, 1e5]) {
      if (span > M) continue
      moveTo(0); gc()
      const t2 = now()
      moveTo(span)
      ;(seeks[span] ??= []).push(Number(now() - t2) / 1e6)
    }
    for (const v of vs) v.dispose()
  }
  out.records = M; out.rows = NR
  out.openUsPerRecord = r3(med(xo) / 1000)
  out.stepUs = { '1 view': r3(med(xs1) / 1000), '10 views': r3(med(xs10) / 1000) }
  out.seekMs = Object.fromEntries(Object.entries(seeks).map(([k, v]) => [k, r3(med(v))]))
} else if (PART === 'sum') {
  out.claim = 'XB-4'
  const r = rng(11)
  const N = 200000
  const sets = {
    integers: Array.from({ length: N }, () => (r() % 201) - 100),
    'two-decimal floats': Array.from({ length: N }, () => (r() % 10000) / 100),
    'near the limit': Array.from({ length: N }, (_, i) => (i % 2 ? -1 : 1) * 1.7e308 * (1 - (r() % 1000) * 1e-6)),
  }
  out.nsPerAddAndRemove = {}
  for (const [name, xs] of Object.entries(sets)) {
    const res = { E23: [], Wide: [] }
    for (let round = 0; round < 5; round++) {
      for (const [w, C] of [['E23', E23Sum], ['Wide', WideSum]]) {
        const s = new C()
        for (let i = 0; i < 64; i++) s.add(xs[i])
        gc()
        const t0 = now()
        for (let i = 64; i < N; i++) { s.add(xs[i]); s.sub(xs[i - 64]) }
        res[w].push(Number(now() - t0) / (N - 64))
      }
    }
    out.nsPerAddAndRemove[name] = { 'E-23 ExactSum': r1(med(res.E23)), WideSum: r1(med(res.Wide)), ratio: r3(med(res.Wide) / med(res.E23)) }
  }
}
console.log(JSON.stringify(out))
