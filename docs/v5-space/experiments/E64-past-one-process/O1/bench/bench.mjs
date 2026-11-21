// E-64 O1, the cost bench. What a merger costs per partial change, and how many partial changes a write makes.
// One process, no network: partial frames are made by real partial code first, then the merger is timed alone
// on them. Run one part per process, under the timing lock, three times (run.sh). Each cell: the median of 5
// rounds after one warm-up round; a full collection before each round.
//   --part=window   G groups' top-K windows (E-57's chunked index per group) over N rows; workloads 'uniform'
//                   (a random row gets a random score) and 'rising' (a Zipf-chosen row's score goes up). Measures
//                   the partial's cost per write (its index at N / G rows), partial frames per write, changes per
//                   write, the merger's cost per frame and per write, client frames per write
//   --part=add      counts and exact sums per bucket: deltas (bucket, value, +-1), B buckets, G groups; the merger
//                   with per-group state (rule 4's simple form) and with the merged sums only
//   --part=ext      the max per bucket: each frame is (group, bucket, new max); 30 % of frames lower a value
//   --part=union    rows in and out of a filter, by key
//   --part=pages    a page of 20 after a random cursor over G groups' indexes of N rows: entries sent, rounds,
//                   time per page; and an exact median by selection: rounds and time
//   --part=mem      the merger's heap for each class at G = 256 (needs --expose-gc)
import { rng, OrderIndex2, WideSum, rowCmp, makeRow, keyName, bkey } from '../src/lib.mjs'
import { Partial } from '../src/partial.mjs'
import { Merger } from '../src/merger.mjs'
import { pageScatter, selectRank } from '../src/select.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const PART = arg('part', 'window')
const gc = globalThis.gc ?? (() => {})
const now = () => process.hrtime.bigint()
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1] }
const out = (o) => console.log(JSON.stringify({ part: PART, ...o }))
const ROUNDS = 5
const timeIt = (fn) => { fn(); const ts = []; for (let i = 0; i < ROUNDS; i++) { gc(); const t0 = now(); fn(); ts.push(Number(now() - t0)) } return med(ts) }
const hashG = (i, G) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) % G }
const ZA = rowCmp('points', 'za')
const ECMP = (a, b) => ZA({ points: a.v, id: a.k }, { points: b.v, id: b.k })

// ── window ─────────────────────────────────────────────────────────────────────────────────────────
function windowPart() {
  const N = +arg('n', '100000'), K = +arg('k', '10'), W = +arg('writes', '200000'), WL = arg('work', 'uniform')
  for (const G of [1, 4, 16, 64, 256]) { // G = 1: one index of every row, R0's own view cost on this box
    const R = rng(7 + G)
    const keyName = (i) => 'k' + i
    const gOf = new Int32Array(N), pts = new Float64Array(N)
    const ix = Array.from({ length: G }, () => new OrderIndex2('za'))
    for (let i = 0; i < N; i++) { gOf[i] = hashG(i, G); pts[i] = Math.floor(R() * 1e6) / 100 }
    const es = Array.from({ length: G }, () => [])
    for (let i = 0; i < N; i++) es[gOf[i]].push({ v: pts[i], k: keyName(i) })
    for (let g = 0; g < G; g++) ix[g].build(es[g])
    const win = ix.map((x) => x.first(K).map((e) => e.k))
    const startWins = ix.map((x, g) => [g, x.first(K).map((e) => [e.k, { points: e.v }])])
    // Zipf(0.99) over rows for 'rising': a few rows get most of the writes, and their scores only go up
    let zc = null
    if (WL === 'rising') { zc = new Float64Array(N); let s = 0; for (let i = 0; i < N; i++) { s += 1 / Math.pow(i + 1, 0.99); zc[i] = s } for (let i = 0; i < N; i++) zc[i] /= s }
    const pickRow = () => { if (!zc) return Math.floor(R() * N); const u = R(); let lo = 0, hi = N - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (zc[m] < u) lo = m + 1; else hi = m } return lo }
    // the partials: each write updates its group's index, then one window reconcile; a frame when it changed
    const frames = []
    let changes = 0
    const t0 = now()
    for (let w = 0; w < W; w++) {
      const i = pickRow(), g = gOf[i], k = keyName(i), old = pts[i]
      const nv = WL === 'rising' ? old + Math.floor(R() * 1000) / 100 : Math.floor(R() * 1e6) / 100
      ix[g].remove(old, k); ix[g].insert(nv, k); pts[i] = nv
      const was = win[g]
      const nowE = ix[g].first(K)
      let same = nowE.length === was.length
      for (let j = 0; same && j < nowE.length; j++) if (nowE[j].k !== was[j]) same = false
      if (!same || was.includes(k)) {
        const nowK = nowE.map((e) => e.k), wasSet = new Set(was), nowSet = new Set(nowK)
        const drop = was.filter((x) => !nowSet.has(x))
        const put = nowE.filter((e) => !wasSet.has(e.k) || e.k === k).map((e) => [e.k, { points: e.v }])
        frames.push({ g, put, drop })
        changes += put.length + drop.length
        win[g] = nowK
      }
    }
    const partialNs = Number(now() - t0) / W
    // the merger alone on the frames: seeded with every group's start window, then every frame and a reconcile
    let outFrames = 0
    const t = timeIt(() => {
      const M = new Merger({ K })
      for (const [g, ws] of startWins) for (const [k, row] of ws) M.winPut(g, k, row)
      M.frame()
      for (const f of frames) { for (const k of f.drop) M.winDrop(f.g, k); for (const [k, row] of f.put) M.winPut(f.g, k, row); M.frame() }
      outFrames = M.outChanges
    }) - timeIt(() => { const M = new Merger({ K }); for (const [g, ws] of startWins) for (const [k, row] of ws) M.winPut(g, k, row); M.frame() })
    out({ G, N, K, work: WL, writes: W, partialNsPerWrite: +partialNs.toFixed(1), framesPerWrite: +(frames.length / W).toFixed(5), changesPerWrite: +(changes / W).toFixed(5), mergerNsPerFrame: frames.length ? +(t / frames.length).toFixed(1) : null, mergerNsPerWrite: +(t / W).toFixed(2), clientFramesPerWrite: +((outFrames - 1) / W).toFixed(5) })
  }
}

// ── add ────────────────────────────────────────────────────────────────────────────────────────────
// A start state (each group holds 2 rows in each of min(B, 2,000) buckets), then rounds that apply the delta
// stream forward and then its exact inverse (so every round does the same work on the same state).
function addPart() {
  const D = +arg('deltas', '200000')
  for (const B of [16, 1000, 100000]) for (const G of [4, 16, 64, 256]) {
    const R = rng(11 + G + B)
    const ds = new Array(D)
    for (let i = 0; i < D; i += 2) { // one write: a row leaves one bucket and enters another
      const g = Math.floor(R() * G), b1 = 'b' + Math.floor(R() * B), b2 = 'b' + Math.floor(R() * B)
      ds[i] = [g, b2, Math.floor(R() * 1e6) / 100, 1]; ds[i + 1] = [g, b1, Math.floor(R() * 1e6) / 100, -1]
    }
    const inv = ds.slice().reverse().map(([g, b, v, s]) => [g, b, v, -s])
    const S = Math.min(B, 2000)
    const R0 = rng(5)
    const startRows = []
    for (let g = 0; g < G; g++) for (let j = 0; j < S; j++) { const b = 'b' + Math.floor(R0() * B); startRows.push([g, b, Math.floor(R0() * 1e6) / 100], [g, b, Math.floor(R0() * 1e6) / 100]) }
    const res = { B, G, deltas: D, startEntriesPerGroup: S }
    { // the merger with per-group state (rule 4's simple form)
      const M = new Merger()
      for (const [g, b, v] of startRows) M.addDelta(g, b, v, 1)
      const t = timeIt(() => { for (const [g, b, v, s] of ds) M.addDelta(g, b, v, s); for (const [g, b, v, s] of inv) M.addDelta(g, b, v, s) })
      res.perGroupNsPerDelta = +(t / (2 * D)).toFixed(1)
    }
    gc()
    { // merged sums only (a resync then rebuilds every group's contribution from pictures)
      const m = new Map()
      const step = (b, v, s) => { let e = m.get(b); if (!e) m.set(b, (e = { n: 0, ws: new WideSum() })); e.n += s; if (s > 0) e.ws.add(v); else e.ws.sub(v); if (e.n === 0) m.delete(b) }
      for (const [, b, v] of startRows) step(b, v, 1)
      const t = timeIt(() => { for (const [, b, v, s] of ds) step(b, v, s); for (const [, b, v, s] of inv) step(b, v, s) })
      res.mergedOnlyNsPerDelta = +(t / (2 * D)).toFixed(1)
    }
    out(res)
    gc()
  }
}

// ── ext ────────────────────────────────────────────────────────────────────────────────────────────
function extPart() {
  const F = +arg('frames', '400000')
  for (const B of [16, 1000]) for (const G of [4, 16, 64, 256]) {
    const R = rng(13 + G + B)
    const cur = new Map()
    const fs = new Array(F)
    for (let i = 0; i < F; i++) {
      const g = Math.floor(R() * G), b = 'b' + Math.floor(R() * B), key = g + '|' + b
      const c = cur.get(key) ?? 0
      const v = R() < 0.7 ? c + Math.floor(R() * 1000) / 100 : Math.max(0, c - Math.floor(R() * 3000) / 100) // 30 %: the group's max falls
      cur.set(key, v); fs[i] = [g, b, v]
    }
    const t = timeIt(() => { const M = new Merger(); for (const [g, b, v] of fs) M.extSet(g, b, v) })
    out({ B, G, frames: F, mergerNsPerFrame: +(t / F).toFixed(1) })
  }
}

// ── union ──────────────────────────────────────────────────────────────────────────────────────────
function unionPart() {
  const F = +arg('frames', '400000'), NK = 100000
  for (const G of [4, 16, 64, 256]) {
    const R = rng(17 + G)
    const fs = new Array(F)
    for (let i = 0; i < F; i++) { const k = 'k' + Math.floor(R() * NK); fs[i] = [hashG(+k.slice(1), G), k, R() < 0.6 ? { points: Math.floor(R() * 1e4) } : null] }
    const t = timeIt(() => { const M = new Merger(); for (const [g, k, row] of fs) { if (row) M.uniPut(g, k, row); else M.uniDrop(g, k) } })
    out({ G, frames: F, mergerNsPerChange: +(t / F).toFixed(1) })
  }
}

// ── pages and the median ───────────────────────────────────────────────────────────────────────────
function pagesPart() {
  const SIZE = 20, READS = +arg('reads', '2000')
  for (const N of [100000, 1000000]) for (const G of [1, 4, 16, 64, 256]) {
    const R = rng(19 + G)
    const es = Array.from({ length: G }, () => [])
    for (let i = 0; i < N; i++) es[hashG(i, G)].push({ v: Math.floor(R() * 1e6) / 100, k: 'k' + i })
    const ixs = es.map((e) => { const ix = new OrderIndex2('za'); ix.build(e); return ix })
    const all = es.flat().sort(ECMP)
    const curs = Array.from({ length: READS }, () => { const e = all[Math.floor(R() * all.length)]; return [e.v, e.k] })
    const row = { N, G, size: SIZE }
    for (const form of ['one', 'two']) {
      let sent = 0, r2 = 0
      for (const c of curs) { const r = pageScatter(ixs, c, SIZE, form, ECMP); sent += r.sent; if (r.rounds === 2) r2++ }
      const t = timeIt(() => { for (const c of curs) pageScatter(ixs, c, SIZE, form, ECMP) })
      row[form] = { entriesPerPage: +(sent / READS).toFixed(1), twoRoundShare: +(r2 / READS).toFixed(3), usPerPage: +(t / READS / 1000).toFixed(2) }
      if (G === 1) break
    }
    // an exact median of every value (all are numbers here): two selections
    const counts = ixs.map((ix) => ix.size)
    const n = N, h = (n - 1) * 0.5, lo = Math.floor(h)
    let rounds = 0
    const sel = () => { const a = selectRank(ixs, counts, n - 1 - lo, ECMP); const b = selectRank(ixs, counts, n - 1 - (lo + 1), ECMP); rounds = a.rounds + b.rounds; return a.e.v + 0.5 * (b.e.v - a.e.v) }
    const m = sel()
    const vals = all.map((e) => e.v).sort((a, b) => a - b)
    const want = vals[lo] + 0.5 * (vals[lo + 1] - vals[lo])
    const t = timeIt(() => { for (let i = 0; i < 20; i++) sel() })
    row.median = { exact: m === want, roundsForTwoSelections: rounds, usPerMedian: +(t / 20 / 1000).toFixed(1) }
    out(row)
  }
}

// ── memory ─────────────────────────────────────────────────────────────────────────────────────────
function memPart() {
  const G = 256
  const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed }
  const R = rng(23)
  const res = {}
  for (const K of [10, 100]) {
    const h0 = heap(); const M = new Merger({ K })
    for (let g = 0; g < G; g++) for (let j = 0; j < K; j++) M.winPut(g, 'k' + g + '_' + j, { id: 'k' + g + '_' + j, points: Math.floor(R() * 1e6) / 100, room: 'r' + (j % 50) })
    res['window K=' + K] = +((heap() - h0) / 1e6).toFixed(2); globalThis.__keep = M
  }
  // add: per-group state holds one entry per (group, bucket) the group touches; merged-only one per bucket
  for (const [B, Gs] of [[1000, 256], [100000, 16]]) {
    let h0 = heap(); let M = new Merger()
    for (let g = 0; g < Gs; g++) for (let b = 0; b < B; b++) M.addDelta(g, 'b' + b, Math.floor(R() * 1e6) / 100, 1)
    globalThis.__keep = M
    const d = heap() - h0
    res['add per-group B=' + B + ' G=' + Gs] = +(d / 1e6).toFixed(1)
    res['add per-group bytes per (group, bucket) entry'] = +(d / (Gs * B)).toFixed(0)
    M = null; globalThis.__keep = null
    h0 = heap(); const m = new Map()
    for (let b = 0; b < B; b++) { const ws = new WideSum(); for (let g = 0; g < 4; g++) ws.add(Math.floor(R() * 1e6) / 100); m.set('b' + b, { n: 4, ws }) }
    res['add merged-only B=' + B] = +((heap() - h0) / 1e6).toFixed(2); globalThis.__keep = m
  }
  { const h0 = heap(); const M = new Merger(); for (let b = 0; b < 1000; b++) for (let g = 0; g < G; g++) M.extSet(g, 'b' + b, Math.floor(R() * 1e6) / 100); res['ext B=1000'] = +((heap() - h0) / 1e6).toFixed(1); globalThis.__keep = M }
  { const h0 = heap(); const ix = new OrderIndex2('za'); const es = []; for (let i = 0; i < 1e6; i++) es.push({ v: Math.floor(R() * 1e6) / 100, k: 'k' + i }); ix.build(es); res['a group index of 1e6 rows (entries and keys)'] = +((heap() - h0) / 1e6).toFixed(1); globalThis.__keep = ix }
  out({ G, MB: res })
}

// ── bytes: partial frames from real partial code, as JSON text (a stand-in for fero's codec) ─────────────
// 4 groups of the sim's rows (E-23's int domain: rows { id, points, room }), 20,000 writes: the JSON length of
// each class's changes per write, and of a frame header (group and position) per frame that carries any
function bytesPart() {
  const G = 4, KEYS = 20000, W = 20000, R = rng(29)
  const ps = Array.from({ length: G }, (_, g) => new Partial(g, { KP: 10 }))
  const gOf = (i) => hashG(i, G)
  for (let i = 0; i < KEYS; i++) ps[gOf(i)].apply([{ k: keyName(i), prev: undefined, next: makeRow(keyName(i), 'int', R) }])
  const tot = { win: 0, add: 0, ext: 0, uni: 0, dis: 0, bool: 0, header: 0, frames: 0, record: 0 }
  for (let w = 0; w < W; w++) {
    const i = Math.floor(R() * KEYS), k = keyName(i), p = ps[gOf(i)]
    const prev = p.rows.get(k), next = R() < 0.5 ? makeRow(k, 'int', R) : { ...prev, points: Math.floor(R() * 101) }
    const f = p.apply([{ k, prev, next }])
    tot.record += JSON.stringify({ type: 0, key: next === prev ? [k] : [k], value: next }).length
    let any = false
    for (const c of ['win', 'add', 'ext', 'uni', 'dis', 'bool']) {
      const x = f[c], empty = Array.isArray(x) ? x.length === 0 : x.put.length + x.drop.length === 0
      if (empty) continue
      any = true
      tot[c] += JSON.stringify(x).length
    }
    if (any) { tot.frames++; tot.header += JSON.stringify({ g: 3, pos: 123456, slots: { 917: 4567 } }).length }
  }
  const per = {}
  for (const [c, v] of Object.entries(tot)) per[c] = +(v / W).toFixed(1)
  out({ G, keys: KEYS, writes: W, bytesPerWrite: per, note: 'record = the write itself as a whole-row record, for scale' })
}

const parts = { bytes: bytesPart, window: windowPart, add: addPart, ext: extPart, union: unionPart, pages: pagesPart, mem: memPart }
parts[PART]()
