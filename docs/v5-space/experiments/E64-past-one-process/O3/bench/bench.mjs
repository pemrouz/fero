// E-64 O3: what partials keyed by slot cost. One part per process (--part=...); every timed cell is the median of
// 5 rounds after a warm-up, with a full collection before each round. run.sh runs each part three times, each
// process alone under the timing lock. Rows are { id, points, room }; the partials are plain code, incremental,
// the way a copy would keep them beside its rows (not data 5's views).
//   host      a copy keeps per-slot partials for every write: counts and exact sums per bucket (B = 16, 1,000),
//             the max per bucket, the slot's top 10, a filter. N = 1e5 and 1e6 rows over S = 4,096 slots.
//             ns a write, and changed cells and frame entries a write.
//   comb      the combiner applies those frames: ns a frame entry, per view.
//   rate      frames a write for a window: partials keyed by slot (S = 4,096) against partials keyed by group
//             (G = 4, 16, 64, 256), top 10 and top 100, N = 1e5 and 1e6, uniform and rising scores. Counts.
//   coalesce  how many partial rows change per window W when frames are merged per slot (or per group, G = 16):
//             the writes a partials RESOURCE would take, per source write. Counts.
//   mem       the combiner's heap: cells per (slot, bucket) at S = 4,096, against per (group, bucket) and merged
//             totals only; a window's S x K candidates.
//   bytes     JSON bytes of frame entries and pictures (a stand-in for fero's codec).
import { WideSum, OrderIndex2, maxBetter, sumState, putState, newAcc, slotOfN, rng } from '../src/lib.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const PART = arg('part', 'host'), RUN = +arg('run', '0'), QUICK = process.argv.includes('--quick')
const S = 4096
const ROUNDS = QUICK ? 1 : 5
const gc = globalThis.gc ?? (() => {})
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1] }
const emit = (o) => console.log(JSON.stringify({ exp: 'E-64', option: 'O3', run: RUN, part: PART, ...o }))
const K = 10

// ── the source rows and the writes ─────────────────────────────────────────────────────────────────
function makeRows(N, B, R) {
  const rows = new Array(N)
  for (let i = 0; i < N; i++) rows[i] = { id: 'k' + i, points: Math.floor(R() * 1e6), room: 'r' + Math.floor(R() * B) }
  return rows
}
function zipfCdf(N, s) { const c = new Float64Array(N); let t = 0; for (let i = 0; i < N; i++) { t += 1 / Math.pow(i + 1, s); c[i] = t } for (let i = 0; i < N; i++) c[i] /= t; return c }
function zipfPick(c, u) { let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < u) lo = m + 1; else hi = m } return lo }
// writes: [row index, new points, new room or -1]
function makeWrites(n, N, B, R, work) {
  const idx = new Int32Array(n), pts = new Float64Array(n), room = new Int32Array(n)
  const cdf = work === 'rising' ? zipfCdf(N, 0.99) : null
  const perm = work === 'rising' ? Array.from({ length: N }, (_, i) => i).sort(() => R() - 0.5) : null
  for (let j = 0; j < n; j++) {
    idx[j] = cdf ? perm[zipfPick(cdf, R())] : Math.floor(R() * N)
    pts[j] = work === 'rising' ? -1 : Math.floor(R() * 1e6) // -1: the row's score goes up by 1 to 1,000
    room[j] = R() < 0.1 ? Math.floor(R() * B) : -1
  }
  return { idx, pts, room, n }
}

// ── a copy's per-slot partials, kept incrementally ─────────────────────────────────────────────────
const za = (a, b) => (a.points !== b.points ? b.points - a.points : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
class SlotPartials {
  constructor(rows, { views, B }) {
    this.views = views
    this.slotOf = new Int32Array(rows.length)
    this.slots = Array.from({ length: S }, () => ({ rows: [], by: new Map(), sum: new WideSum(), top: [], gt: new Set() }))
    for (let i = 0; i < rows.length; i++) { const s = slotOfN(rows[i].id, S); this.slotOf[i] = s; this.slots[s].rows.push(rows[i]) }
    for (const sl of this.slots) {
      for (const r of sl.rows) {
        sl.sum.add(r.points)
        let c = sl.by.get(r.room); if (c === undefined) sl.by.set(r.room, (c = { c: 0, s: new WideSum(), m: -Infinity })); c.c++; c.s.add(r.points); if (r.points > c.m) c.m = r.points
        if (r.points > 500000) sl.gt.add(r.id)
      }
      sl.top = topOf(sl.rows)
    }
    this.out = [] // frame entries [slot, changes]
    this.cells = 0; this.entries = 0
  }
  write(i, row, np, nr) {
    const s = this.slotOf[i], sl = this.slots[s]
    const op = row.points, or = row.room
    const ch = []
    const v = this.views
    if (v.add) {
      if (or === nr) {
        const c = sl.by.get(or); c.s.sub(op); c.s.add(np); ch.push(['by', or, { c: c.c, s: sumState(c.s) }])
      } else {
        const a = sl.by.get(or); a.c--; a.s.sub(op)
        ch.push(['by', or, a.c === 0 ? null : { c: a.c, s: sumState(a.s) }]); if (a.c === 0) sl.by.delete(or)
        let b = sl.by.get(nr); if (b === undefined) sl.by.set(nr, (b = { c: 0, s: new WideSum(), m: -Infinity })); b.c++; b.s.add(np)
        ch.push(['by', nr, { c: b.c, s: sumState(b.s) }])
      }
      sl.sum.sub(op); sl.sum.add(np); ch.push(['sum', sumState(sl.sum)])
    }
    row.points = np; row.room = nr
    if (v.ext) {
      if (or === nr) {
        const c = sl.by.get(or)
        if (np > c.m) { c.m = np; ch.push(['max', or, np]) } else if (op === c.m && np < op) { c.m = rescanMax(sl, or); ch.push(['max', or, c.m]) }
      } else {
        const a = sl.by.get(or)
        if (a !== undefined && op === a.m) { a.m = rescanMax(sl, or); ch.push(['max', or, a.m]) } else if (a === undefined) ch.push(['max', or, null])
        const b = sl.by.get(nr)
        if (b.c === 1) b.m = -Infinity
        if (np > b.m) { b.m = np; ch.push(['max', nr, np]) }
      }
    }
    if (v.win) {
      const t = sl.top
      let at = -1
      for (let j = 0; j < t.length; j++) if (t[j] === row) { at = j; break }
      if (at >= 0) { // a top row changed: its place may now belong to a row outside the top: rescan the slot
        const old = t.map((r) => r.id + ':' + r.points).join()
        sl.top = topOf(sl.rows)
        if (sl.top.map((r) => r.id + ':' + r.points).join() !== old) ch.push(['top', sl.top.map((r) => ({ id: r.id, points: r.points }))])
      } else if (t.length < K || za(row, t[t.length - 1]) < 0) {
        let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (za(t[m], row) < 0) lo = m + 1; else hi = m }
        t.splice(lo, 0, row); if (t.length > K) t.pop()
        ch.push(['top', t.map((r) => ({ id: r.id, points: r.points }))])
      }
    }
    if (v.gt) {
      const was = op > 500000, is = np > 500000
      if (is) { sl.gt.add(row.id); ch.push(['gt', row.id, { id: row.id, points: np }]) } else if (was) { sl.gt.delete(row.id); ch.push(['gt', row.id, null]) }
    }
    if (ch.length > 0) { this.entries++; this.cells += ch.length; if (this.keep) this.out.push([s, ch]) }
  }
}
function topOf(rows) { const t = []; for (const r of rows) { if (t.length < K || za(r, t[t.length - 1]) < 0) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (za(t[m], r) < 0) lo = m + 1; else hi = m } t.splice(lo, 0, r); if (t.length > K) t.pop() } } return t }
function rescanMax(sl, b) { let m = -Infinity; for (const r of sl.rows) if (r.room === b && r.points > m) m = r.points; return m }

// ── the combiner's per-view state ──────────────────────────────────────────────────────────────────
class Comb {
  constructor() {
    this.cells = Array.from({ length: S }, () => ({ by: new Map(), sum: null, top: [], max: new Map() }))
    this.tot = new Map() // bucket -> { c, acc }
    this.sum = newAcc()
    this.maxes = new Map() // bucket -> { m: Map(slot -> v), best, bs }
    this.ix = new OrderIndex2('za')
    this.gt = new Map()
  }
  take(s, ch) {
    const sc = this.cells[s]
    for (const c of ch) {
      const kind = c[0]
      if (kind === 'by') {
        const old = sc.by.get(c[1])
        let t = this.tot.get(c[1]); if (t === undefined) this.tot.set(c[1], (t = { c: 0, acc: newAcc() }))
        if (old !== undefined) { t.c -= old.c; putState(t.acc, old.s, -1) }
        if (c[2] === null) sc.by.delete(c[1]); else { sc.by.set(c[1], c[2]); t.c += c[2].c; putState(t.acc, c[2].s, 1) }
        if (t.c === 0) this.tot.delete(c[1])
      } else if (kind === 'sum') {
        if (sc.sum !== null) putState(this.sum, sc.sum, -1)
        putState(this.sum, c[1], 1); sc.sum = c[1]
      } else if (kind === 'max') {
        let e = this.maxes.get(c[1]); if (e === undefined) this.maxes.set(c[1], (e = { m: new Map(), best: -Infinity, bs: -1 }))
        if (c[2] === null) e.m.delete(s); else e.m.set(s, c[2])
        if (c[2] !== null && c[2] > e.best) { e.best = c[2]; e.bs = s } else if (e.bs === s) { e.best = -Infinity; e.bs = -1; for (const [ss, v] of e.m) if (v > e.best) { e.best = v; e.bs = ss } }
      } else if (kind === 'top') {
        const old = sc.top, nw = c[1]
        const keep = new Set(); for (const r of nw) keep.add(r.id + '\u0000' + r.points)
        const had = new Set(); for (const r of old) { const id = r.id + '\u0000' + r.points; had.add(id); if (!keep.has(id)) this.ix.remove(r.points, r.id) }
        for (const r of nw) if (!had.has(r.id + '\u0000' + r.points)) this.ix.insert(r.points, r.id)
        sc.top = nw
      } else if (kind === 'gt') { if (c[2] === null) this.gt.delete(c[1]); else this.gt.set(c[1], c[2]) }
    }
  }
}

// ── parts ──────────────────────────────────────────────────────────────────────────────────────────
const VIEWS = { add: { add: true }, ext: { add: true, ext: true }, win: { win: true }, gt: { gt: true } }
function partHost() {
  for (const N of QUICK ? [1e5] : [1e5, 1e6]) for (const [vname, views] of Object.entries(VIEWS)) for (const B of vname === 'add' || vname === 'ext' ? [16, 1000] : [16]) {
    const R = rng(1000 + N + B)
    const rows = makeRows(N, B, R)
    const p = new SlotPartials(rows, { views, B })
    const W = QUICK ? 20000 : 200000
    const ws = makeWrites(W + 20000, N, B, R, 'uniform')
    let j = 0
    const run = (n) => { for (let q = 0; q < n; q++, j = (j + 1) % ws.n) { const i = ws.idx[j]; const row = rows[i]; p.write(i, row, ws.pts[j] < 0 ? row.points + 1 : ws.pts[j], ws.room[j] < 0 ? row.room : 'r' + ws.room[j]) } }
    run(20000)
    const per = []
    let e0 = p.entries, c0 = p.cells
    for (let r = 0; r < ROUNDS; r++) { gc(); const t = process.hrtime.bigint(); run(W); per.push(Number(process.hrtime.bigint() - t) / W) }
    emit({ view: vname, N, B, S, writes: W * ROUNDS, nsPerWrite: Math.round(median(per)), entriesPerWrite: +((p.entries - e0) / (W * ROUNDS)).toFixed(4), cellsPerWrite: +((p.cells - c0) / (W * ROUNDS)).toFixed(4), rowsPerSlot: N / S })
  }
}
function partComb() {
  for (const N of QUICK ? [1e5] : [1e5, 1e6]) for (const [vname, views] of Object.entries(VIEWS)) for (const B of vname === 'add' || vname === 'ext' ? [16, 1000] : [16]) {
    const R = rng(2000 + N + B)
    const rows = makeRows(N, B, R)
    const p = new SlotPartials(rows, { views, B })
    const comb = new Comb()
    // the combiner starts from every slot's picture
    for (let s = 0; s < S; s++) {
      const sl = p.slots[s], ch = []
      if (views.add) { for (const [b, c] of sl.by) ch.push(['by', b, { c: c.c, s: sumState(c.s) }]); ch.push(['sum', sumState(sl.sum)]) }
      if (views.ext) for (const [b, c] of sl.by) ch.push(['max', b, c.m])
      if (views.win) ch.push(['top', sl.top.map((r) => ({ id: r.id, points: r.points }))])
      if (views.gt) for (const id of sl.gt) ch.push(['gt', id, { id }])
      comb.take(s, ch)
    }
    const W = QUICK ? 20000 : 200000
    const ws = makeWrites(W, N, B, R, 'uniform')
    p.keep = true
    for (let j = 0; j < W; j++) { const i = ws.idx[j]; const row = rows[i]; p.write(i, row, ws.pts[j], ws.room[j] < 0 ? row.room : 'r' + ws.room[j]) }
    const frames = p.out
    p.out = []
    const views1 = { ...views }; delete views1.add
    // time only the view this row names: for 'ext' the frames carry both add and max changes: count both apart
    const per = []
    let cells = 0; for (const [, ch] of frames) cells += ch.length
    for (let r = 0; r < ROUNDS; r++) {
      const c2 = new Comb()
      for (let s = 0; s < S; s++) { c2.cells[s] = { by: new Map(comb.cells[s].by), sum: comb.cells[s].sum, top: comb.cells[s].top, max: new Map() } }
      c2.tot = new Map([...comb.tot].map(([b, t]) => [b, { c: t.c, acc: cloneAcc(t.acc) }])); c2.sum = cloneAcc(comb.sum)
      c2.maxes = new Map([...comb.maxes].map(([b, e]) => [b, { m: new Map(e.m), best: e.best, bs: e.bs }]))
      c2.ix = new OrderIndex2('za'); c2.ix.build(comb.ix.keys().length ? [...comb.ix.chunks.flat()].map((e) => ({ v: e.v, k: e.k })) : [])
      c2.gt = new Map(comb.gt)
      gc()
      const t = process.hrtime.bigint()
      for (const [s, ch] of frames) c2.take(s, ch)
      per.push(Number(process.hrtime.bigint() - t))
    }
    const ns = median(per)
    emit({ view: vname, N, B, S, frames: frames.length, cells, nsPerEntry: Math.round(ns / frames.length), nsPerCell: Math.round(ns / cells), nsPerWrite: Math.round(ns / W), candidates: comb.ix.size })
  }
}
function cloneAcc(a) { const w = newAcc(); w.p = a.p.slice(); w.big = a.big; w.nan = a.nan; w.pinf = a.pinf; w.ninf = a.ninf; w.nf = a.nf; w.nz = a.nz; w.n = a.n; return w }

// frames a write for a window: per slot against per group (counts only)
function partRate() {
  for (const N of QUICK ? [1e5] : [1e5, 1e6]) for (const KK of [10, 100]) for (const work of ['uniform', 'rising']) {
    const R = rng(3000 + N + KK)
    const rows = makeRows(N, 1, R)
    const slotOf = new Int32Array(N)
    for (let i = 0; i < N; i++) slotOf[i] = slotOfN(rows[i].id, S)
    // each level: G partials (G = S means per slot), each an ordered index; a frame when its first KK change
    const levels = [S, 4, 16, 64, 256].map((G) => {
      const ix = Array.from({ length: G }, () => new OrderIndex2('za'))
      const es = Array.from({ length: G }, () => [])
      for (let i = 0; i < N; i++) es[G === S ? slotOf[i] : slotOf[i] % G].push({ v: rows[i].points, k: rows[i].id })
      for (let g = 0; g < G; g++) ix[g].build(es[g])
      return { G, ix, frames: 0, rowsIn: 0 }
    })
    const W = QUICK ? 20000 : 200000
    const ws = makeWrites(W, N, 1, R, work)
    const kth = (ix) => { let n = KK - 1; for (const c of ix.chunks) { if (n < c.length) return c[n]; n -= c.length } return undefined }
    const better = (a, b) => (a.v !== b.v ? a.v > b.v : a.k < b.k)
    for (let j = 0; j < W; j++) {
      const i = ws.idx[j], row = rows[i]
      const op = row.points, np = ws.pts[j] < 0 ? op + 1 + Math.floor(R() * 1000) : ws.pts[j]
      for (const L of levels) {
        const g = L.G === S ? slotOf[i] : slotOf[i] % L.G
        const ix = L.ix[g]
        const k0 = kth(ix)
        const wasIn = k0 === undefined || !better(k0, { v: op, k: row.id })
        ix.remove(op, row.id); ix.insert(np, row.id)
        const k1 = kth(ix)
        const isIn = k1 === undefined || !better(k1, { v: np, k: row.id })
        if (wasIn || isIn) { L.frames++ }
      }
      row.points = np
    }
    for (const L of levels) emit({ N, K: KK, work, G: L.G === S ? 'slot' : L.G, partials: L.G, writes: W, framesPerWrite: +(L.frames / W).toFixed(5), candidates: L.G * KK })
  }
}

// partial-row writes per source write when frames are merged per window
function partCoalesce() {
  const T = QUICK ? 2 : 20 // seconds simulated
  for (const keys of ['uniform', 'zipf']) for (const rate of [1e4, 5e4, 2e5]) {
    const R = rng(4000 + rate)
    const NK = 1e6
    const cdf = keys === 'zipf' ? zipfCdf(NK, 0.99) : null
    const n = Math.round(rate * T)
    const times = new Float64Array(n); for (let i = 0; i < n; i++) times[i] = R() * T
    times.sort()
    const slot = new Int32Array(n)
    for (let i = 0; i < n; i++) slot[i] = slotOfN('k' + (cdf ? zipfPick(cdf, R()) : Math.floor(R() * NK)), S)
    for (const Wms of [0, 10, 100, 1000]) {
      let slotRows = 0, groupRows = 0
      if (Wms === 0) { slotRows = n; groupRows = n } else {
        const W = Wms / 1000
        let w = -1, seenS = new Set(), seenG = new Set()
        for (let i = 0; i < n; i++) {
          const wi = Math.floor(times[i] / W)
          if (wi !== w) { slotRows += seenS.size; groupRows += seenG.size; seenS = new Set(); seenG = new Set(); w = wi }
          seenS.add(slot[i]); seenG.add(slot[i] % 16)
        }
        slotRows += seenS.size; groupRows += seenG.size
      }
      emit({ keys, ratePerSec: rate, windowMs: Wms, writes: n, slotRowWritesPerWrite: +(slotRows / n).toFixed(4), groupRowWritesPerWrite: +(groupRows / n).toFixed(5), slotRowWritesPerSec: Math.round(slotRows / T), groupRowWritesPerSec: Math.round(groupRows / T) })
    }
  }
}

// the combiner's heap for bucket views, and for a window's candidates
function heap() { gc(); gc(); return process.memoryUsage().heapUsed }
function partMem() {
  const R = rng(5000)
  const st = () => { const w = new WideSum(); w.add(Math.floor(R() * 1e6)); w.add(R() * 100); return sumState(w) }
  for (const B of QUICK ? [16] : [1, 16, 100, 1000]) {
    for (const form of ['slot', 'group16', 'group256', 'merged']) {
      const P = form === 'slot' ? S : form === 'group16' ? 16 : form === 'group256' ? 256 : 0
      const h0 = heap()
      const keep = []
      if (P > 0) for (let s = 0; s < P; s++) { const m = new Map(); for (let b = 0; b < B; b++) m.set('r' + b, { c: 1 + Math.floor(R() * 100), s: st() }); keep.push(m) }
      const tot = new Map(); for (let b = 0; b < B; b++) { const a = newAcc(); a.add(R() * 1e6); tot.set('r' + b, { c: 1, acc: a }) }
      const h1 = heap()
      emit({ what: 'count+exact sum per bucket', form, partials: P, B, cells: P * B, bytes: h1 - h0, bytesPerCell: P ? Math.round((h1 - h0) / (P * B)) : Math.round((h1 - h0) / B) })
      keep.length = 0; tot.clear()
    }
    { // max per bucket: every slot's max kept
      const h0 = heap()
      const ms = new Map(); for (let b = 0; b < B; b++) { const m = new Map(); for (let s = 0; s < S; s++) m.set(s, Math.floor(R() * 1e6)); ms.set('r' + b, { m, best: 0, bs: 0 }) }
      const h1 = heap()
      emit({ what: 'max per bucket', form: 'slot', partials: S, B, cells: S * B, bytes: h1 - h0, bytesPerCell: Math.round((h1 - h0) / (S * B)) })
      ms.clear()
    }
  }
  for (const KK of [10, 100]) for (const P of [S, 16, 256]) {
    const h0 = heap()
    const ix = new OrderIndex2('za'); const lists = []
    const es = []
    for (let s = 0; s < P; s++) { const l = []; for (let q = 0; q < KK; q++) { const r = { id: 'k' + s + '_' + q, points: Math.floor(R() * 1e6) }; l.push(r); es.push({ v: r.points, k: r.id }) } lists.push(l) }
    ix.build(es)
    const h1 = heap()
    emit({ what: 'window candidates', K: KK, partials: P, rows: P * KK, bytes: h1 - h0, bytesPerRow: Math.round((h1 - h0) / (P * KK)) })
    lists.length = 0
  }
}

function partBytes() {
  for (const B of [16, 1000]) for (const N of [1e5, 1e6]) {
    const R = rng(6000 + B)
    const rows = makeRows(N, B, R)
    const p = new SlotPartials(rows, { views: { add: true, ext: true, win: true, gt: true }, B })
    p.keep = true
    const W = QUICK ? 5000 : 20000
    const ws = makeWrites(W, N, B, R, 'uniform')
    for (let j = 0; j < W; j++) { const i = ws.idx[j]; const row = rows[i]; p.write(i, row, ws.pts[j], ws.room[j] < 0 ? row.room : 'r' + ws.room[j]) }
    const by = { by: 0, sum: 0, max: 0, top: 0, gt: 0 }
    for (const [s, ch] of p.out) for (const c of ch) by[c[0]] += JSON.stringify([s, c]).length
    const head = 24 // a frame entry's slot, from and to, as JSON digits and punctuation (a guess at the codec's)
    let pic = 0
    for (let s = 0; s < 64; s++) {
      const sl = p.slots[s]
      pic += JSON.stringify({ s, by: [...sl.by].map(([b, c]) => [b, c.c, sumState(c.s).p, c.m]), sum: sumState(sl.sum).p, top: sl.top.map((r) => [r.id, r.points]), gt: [...sl.gt] }).length
    }
    emit({ N, B, writes: W, bytesPerWrite: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / W).toFixed(1)])), entriesPerWrite: +(p.out.length / W).toFixed(3), entryHeaderBytes: head, pictureBytesPerSlot: Math.round(pic / 64) })
  }
}

// the delta form, for comparison: a frame carries (bucket, value out) and (bucket, value in), not whole cells; the
// combiner keeps merged totals only (no cell per slot). Cheaper, but a frame must apply exactly once and in order,
// so a lost stream or a move whose old half is late cannot be repaired from a picture (section 4 of the page).
function partDelta() {
  for (const N of QUICK ? [1e5] : [1e5, 1e6]) for (const B of [16, 1000]) {
    const R = rng(7000 + N + B)
    const rows = makeRows(N, B, R)
    const slotOf = new Int32Array(N); for (let i = 0; i < N; i++) slotOf[i] = slotOfN(rows[i].id, S)
    const W = QUICK ? 20000 : 200000
    const ws = makeWrites(W + 20000, N, B, R, 'uniform')
    const pos = new Float64Array(S)
    let out = []
    let j = 0
    const run = (n, keep) => { for (let q = 0; q < n; q++, j = (j + 1) % ws.n) { const i = ws.idx[j]; const row = rows[i]; const op = row.points, or = row.room; const np = ws.pts[j], nr = ws.room[j] < 0 ? or : 'r' + ws.room[j]; row.points = np; row.room = nr; const s = slotOf[i]; const f = [s, pos[s], ++pos[s], or, op, nr, np]; if (keep) out.push(f) } }
    run(20000, false)
    const per = []
    for (let r = 0; r < ROUNDS; r++) { out = []; gc(); const t = process.hrtime.bigint(); run(W, true); per.push(Number(process.hrtime.bigint() - t) / W) }
    // the combiner: merged totals and a position per slot, applying the last round's frames in order
    const cper = []
    for (let r = 0; r < ROUNDS; r++) {
      const tot = new Map(); for (let b = 0; b < B; b++) { const a = newAcc(); tot.set('r' + b, { c: 1e9, acc: a }) }
      const sum = newAcc(); const cpos = new Float64Array(S); for (const f of out) if (cpos[f[0]] === 0) cpos[f[0]] = f[1]
      gc()
      const t = process.hrtime.bigint()
      for (const f of out) {
        const s = f[0]
        if (f[1] !== cpos[s]) continue // not the next frame for this slot: held or dropped (never here: one stream, in order)
        cpos[s] = f[2]
        const a = tot.get(f[3]); a.c--; a.acc.sub(f[4])
        const b = tot.get(f[5]); b.c++; b.acc.add(f[6])
        sum.sub(f[4]); sum.add(f[6])
      }
      cper.push(Number(process.hrtime.bigint() - t) / out.length)
    }
    emit({ view: 'add-delta', N, B, S, writes: W * ROUNDS, hostNsPerWrite: Math.round(median(per)), combNsPerFrame: Math.round(median(cper)), frameJsonBytes: JSON.stringify(out[0]).length })
  }
}

({ delta: partDelta, host: partHost, comb: partComb, rate: partRate, coalesce: partCoalesce, mem: partMem, bytes: partBytes })[PART]()
