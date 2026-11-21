// E-64 O2: what streaming derive costs. One JSON line per run; run.sh runs each three times under the timing
// lock. data at 63fea66, read only; fero v4's codec (kernel/codec.ts) for bytes, read only.
//   node --expose-gc bench.mjs enrich <rows> <records> <plain|sink|enrich>   a copy's fold in lanes of 256, plain,
//        with a no-op sink, or with the enricher (data's row deltas with prev, projected to the fields the views
//        read): ns a record
//   node --expose-gc bench.mjs r0 <rows> <records>       R0's way: one store holding every row, folding every record,
//        with a count-by and exact sum-by kept from data's row deltas: ns a record, and heap per row
//   node --expose-gc bench.mjs runner <records> <buckets> <W> <exact|plain>   the delta runner (no rows): ns an
//        item to fold changes into a window and build its batches; the target's merge, ns a bucket delta
//   node --expose-gc bench.mjs scan <rows> <kp>          a refill's scan at a copy: every row, keep the best kp: ns a row
//   node bench.mjs decode <records> <log|enriched>     fero v4's codec: ns to decode a record of the log (what R0's
//        host decodes for every record) or an enriched item (key, 2 fields before and after: what a runner decodes)
//   node bench.mjs bytes <records>                       encoded bytes a record: the log as is, plus the projected
//        before-image (3 fields), plus the whole row before (E-54's measure)
import { pathToFileURL, fileURLToPath } from 'node:url'
import { rng, Acc, bkey, proj, cmpTup, tup, out } from './lib.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url)) // ../data next to the repo
const FERO = process.env.FERO ?? fileURLToPath(new URL('../../../../../../', import.meta.url)) // this repo's root: fero v4's codec
const [mode, a1, a2, a3, a4] = process.argv.slice(2)
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
const heap = () => process.memoryUsage().heapUsed

// a workload over a fixed key space: rows k0..k(N-1); 25 % whole row, 30 % cents, 12 % user, 13 % score,
// 8 % paid, 3 % cents deleted, 9 % row removed (a later write to it inserts it again). A row has eight fields,
// about 100 B encoded, like E-54's rows; the views read two or three of them.
const SKU = (r) => 'sku-' + Math.floor(r() * 1e5)
function rowOf(r, buckets) { return { user: 'u' + Math.floor(r() * buckets), cents: Math.floor(r() * 10000), score: Math.floor(r() * 1e6), paid: r() < 0.5, sku: SKU(r), title: 'item ' + Math.floor(r() * 1e9).toString(36) + ' blue large', at: 1.7e12 + Math.floor(r() * 1e10), qty: 1 + Math.floor(r() * 5) } }
function makeGen(N, buckets, seed = 1) { // one continuous stream of records over rows filled by store() (seed 99)
  const r = rng(seed)
  const live = new Uint8Array(N).fill(1)
  return (H) => {
    const recs = new Array(H)
    for (let i = 0; i < H; i++) {
      const j = Math.floor(r() * N), k = 'k' + j
      if (!live[j]) { recs[i] = { type: 1, key: [], at: k, value: rowOf(r, buckets) }; live[j] = 1; continue }
      const u = r()
      if (u < 0.25) recs[i] = { type: 0, key: [k], value: rowOf(r, buckets) }
      else if (u < 0.55) recs[i] = { type: 0, key: [k, 'cents'], value: Math.floor(r() * 10000) }
      else if (u < 0.67) recs[i] = { type: 0, key: [k, 'user'], value: 'u' + Math.floor(r() * buckets) }
      else if (u < 0.8) recs[i] = { type: 0, key: [k, 'score'], value: Math.floor(r() * 1e6) }
      else if (u < 0.88) recs[i] = { type: 0, key: [k, 'paid'], value: r() < 0.5 }
      else if (u < 0.91) recs[i] = { type: 2, key: [k, 'cents'] }
      else { recs[i] = { type: 2, key: [k] }; live[j] = 0 }
    }
    return recs
  }
}
const workload = (N, H, buckets, seed = 1) => makeGen(N, buckets, seed)(H)
async function store(N, buckets) {
  const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
  const src = D.$({})
  const lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  const r = rng(99)
  for (let i = 0; i < N; i += 4096) { const b = []; for (let j = i; j < Math.min(N, i + 4096); j++) b.push({ type: 1, key: [], at: 'k' + j, value: rowOf(r, buckets) }); lane(b) }
  return { D, src, lane }
}
const fold = (lane, recs) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < recs.length; i += 256) lane(recs.slice(i, i + 256)); return Number(process.hrtime.bigint() - t0) }

if (mode === 'enrich') { // one variant per process: plain | sink | enrich
  const N = +a1, H = +a2, v = a3, B = 100
  const { src, lane } = await store(N, B)
  const gen = makeGen(N, B), warm = gen(20000), recs = gen(H)
  let items = 0, pending = null
  if (v === 'sink') src.sink({ apply() {} })
  if (v === 'enrich') src.sink({ apply(b) { for (const d of b.rows) pending.push({ k: d.key, b: d.op === 'add' ? undefined : proj(d.prev), a: d.op === 'remove' ? undefined : proj(d.row) }) } })
  pending = []; fold(lane, warm)
  gc()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < H; i += 256) { pending = []; lane(recs.slice(i, i + 256)); items += pending.length }
  const ns = Number(process.hrtime.bigint() - t0) / H
  out({ exp: 'E-64', opt: 'O2', bench: 'enrich', variant: v, rows: N, records: H, node: process.version, ns_per_record: +ns.toFixed(1), changesPerRecord: v === 'enrich' ? +(items / H).toFixed(3) : null })
} else if (mode === 'r0') {
  const N = +a1, H = +a2, B = 100
  const gen = makeGen(N, B), partA = gen(H), warm = gen(20000), recs = gen(H)
  gc(); const h0 = heap()
  const { src, lane } = await store(N, B)
  gc(); const h1 = heap()
  const res = { heap_b_per_row: +((h1 - h0) / N).toFixed(0) }
  const plainNs = fold(lane, partA) / H // the plain fold, same store, the records before
  const acc = new Map()
  const put = (u, c, s) => { const b = bkey(u); if (b === undefined) return; let a = acc.get(b); if (!a) { a = new Acc(); acc.set(b, a) } a.addRow(c, s); if (a.empty()) acc.delete(b) }
  src[Symbol.for('data.v4.node')].each((k, row) => put(row.user, row.cents, +1))
  src.sink({ apply(b) { for (const d of b.rows) { if (d.op !== 'add') put(d.prev.user, d.prev.cents, -1); if (d.op !== 'remove') put(d.row.user, d.row.cents, +1) } } })
  fold(lane, warm)
  gc()
  const viewNs = fold(lane, recs) / H
  out({ exp: 'E-64', opt: 'O2', bench: 'r0', rows: N, records: H, node: process.version, ...res, ns_fold: +plainNs.toFixed(1), ns_fold_and_view: +viewNs.toFixed(1), ns_view: +(viewNs - plainNs).toFixed(1), buckets: acc.size })
} else if (mode === 'runner') {
  const H = +a1, B = +a2, W = +a3, plain = a4 === 'plain'
  // enriched items from a plain fold (no data needed to make them): one change a record
  const N = 100000, recs = workload(N, H, B), rows = new Map()
  const r = rng(99)
  for (let i = 0; i < N; i++) rows.set('k' + i, rowOf(r, B))
  const items = []
  for (const x of recs) {
    const k = x.type === 1 ? x.at : x.key[0], before = rows.get(k)
    let after
    if (x.type === 1 || (x.type === 0 && x.key.length === 1)) after = x.value
    else if (x.type === 0) after = { ...before, [x.key[1]]: x.value }
    else if (x.key.length === 1) after = undefined
    else { after = { ...before }; delete after[x.key[1]] }
    if (after === undefined) rows.delete(k); else rows.set(k, after)
    items.push({ slot: Math.floor(r() * 4096), pos: 0, ch: [{ k, b: proj(before), a: proj(after) }] })
  }
  const slotPos = new Int32Array(4096)
  for (const it of items) it.pos = ++slotPos[it.slot]
  const target = new Map()
  let writes = 0, deltas = 0, tTarget = 0n
  const run = (its, timeTarget) => {
    let win = new Map(), winTo = new Map(), n = 0
    const put = (u, c, s) => { const b = bkey(u); if (b === undefined) return; let d = win.get(b); if (!d) { d = new Acc(plain); win.set(b, d) } d.addRow(c, s) }
    const flush = () => {
      const batch = { from: new Map(), to: winTo, deltas: [...win] }
      writes++
      const t0 = timeTarget ? process.hrtime.bigint() : 0n
      for (const [b, d] of batch.deltas) { let a = target.get(b); if (!a) { a = new Acc(plain); target.set(b, a) } a.merge(d); if (a.empty()) target.delete(b); deltas++ }
      if (timeTarget) tTarget += process.hrtime.bigint() - t0
      win = new Map(); winTo = new Map(); n = 0
    }
    for (const it of its) {
      for (const c of it.ch) { if (c.b) put(c.b.u, c.b.c, -1); if (c.a) put(c.a.u, c.a.c, +1) }
      winTo.set(it.slot, it.pos)
      if (++n >= W) flush()
    }
    if (n) flush()
  }
  run(items.slice(0, 20000), false)
  writes = 0; deltas = 0; target.clear()
  gc()
  const t0 = process.hrtime.bigint()
  run(items, true)
  const total = Number(process.hrtime.bigint() - t0)
  const tgt = Number(tTarget)
  out({ exp: 'E-64', opt: 'O2', bench: 'runner', items: H, buckets: B, W, sum: plain ? 'plain' : 'exact', node: process.version, ns_runner_per_item: +((total - tgt) / H).toFixed(1), ns_target_per_delta: +(tgt / deltas).toFixed(1), deltas_per_item: +(deltas / H).toFixed(3), writes_per_item: +(writes / H).toFixed(4) })
} else if (mode === 'scan') {
  const N = +a1, KP = +a2
  const { src } = await store(N, 100)
  const node = src[Symbol.for('data.v4.node')]
  const once = () => { let top = []; node.each((k, row) => { const t = tup(k, row.score); if (top.length < KP || cmpTup(t, top[top.length - 1]) < 0) { top.push(t); top.sort(cmpTup); if (top.length > KP) top.pop() } }); return top }
  once(); gc()
  const t0 = process.hrtime.bigint()
  const reps = 5
  for (let i = 0; i < reps; i++) once()
  const ns = Number(process.hrtime.bigint() - t0) / reps
  out({ exp: 'E-64', opt: 'O2', bench: 'scan', rows: N, kp: KP, node: process.version, ms_per_scan: +(ns / 1e6).toFixed(1), ns_per_row: +(ns / N).toFixed(1) })
} else if (mode === 'decode') { // what a reader pays to decode: the log's records (R0's host) or enriched items (a runner)
  const H = +a1, N = 100000, B = 100, which = a2
  const C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
  const recs = workload(N, H, B)
  let list = recs
  if (which === 'enriched') {
    const rows = new Map(), r = rng(99)
    for (let i = 0; i < N; i++) rows.set('k' + i, rowOf(r, B))
    list = recs.map((x) => {
      const k = x.type === 1 ? x.at : x.key[0], before = rows.get(k)
      let after
      if (x.type === 1 || (x.type === 0 && x.key.length === 1)) after = x.value
      else if (x.type === 0) after = { ...before, [x.key[1]]: x.value }
      else if (x.key.length === 1) after = undefined
      else { after = { ...before }; delete after[x.key[1]] }
      if (after === undefined) rows.delete(k); else rows.set(k, after)
      const reads = x.type === 1 || x.key.length === 1 || ['user', 'cents', 'score'].includes(x.key[1])
      const p2 = (row) => (row === undefined ? null : { u: row.user, c: row.cents })
      return reads ? { type: 0, key: [k], value: { b: p2(before), a: p2(after) } } : { type: 2, key: [k] }
    })
  }
  const frames = []
  for (let i = 0; i < list.length; i += 256) frames.push(C.encodeFrame(list.slice(i, i + 256)))
  const pass = () => { let n = 0; for (const f of frames) for (const rv of new C.Frame(f).records()) { const r = rv.rec(); n += r.key.length } return n }
  pass(); gc()
  const t0 = process.hrtime.bigint()
  pass(); pass(); pass()
  const ns = Number(process.hrtime.bigint() - t0) / (3 * list.length)
  out({ exp: 'E-64', opt: 'O2', bench: 'decode', which, records: H, node: process.version, ns_per_record: +ns.toFixed(1) })
} else if (mode === 'bytes') {
  const H = +a1, N = 100000, B = 100
  const C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
  const recs = workload(N, H, B)
  const rows = new Map(), r = rng(99)
  for (let i = 0; i < N; i++) rows.set('k' + i, rowOf(r, B))
  const sizeOf = (rs) => { let b = 0; for (let i = 0; i < rs.length; i += 256) b += C.encodeFrame(rs.slice(i, i + 256)).length; return b }
  const projPrev = [], proj2Prev = [], rowPrev = [], bare = [], enriched = []
  let touched = 0
  for (const x of recs) {
    const k = x.type === 1 ? x.at : x.key[0], before = rows.get(k)
    // does this record change a field a view reads? a write of `paid` alone does not
    const reads = x.type === 1 || x.key.length === 1 || ['user', 'cents', 'score'].includes(x.key[1])
    bare.push({ type: 2, key: x.key.length ? x.key : [k] })
    proj2Prev.push(before && reads && x.key[1] !== 'score' ? { type: 0, key: x.key.length ? x.key : [k], value: { u: before.user, c: before.cents } } : { type: 2, key: x.key.length ? x.key : [k] })
    projPrev.push(before && reads ? { type: 0, key: x.key.length ? x.key : [k], value: proj(before) } : { type: 2, key: x.key.length ? x.key : [k] })
    rowPrev.push(before ? { type: 0, key: x.key.length ? x.key : [k], value: before } : { type: 2, key: x.key.length ? x.key : [k] })
    if (before && reads) touched++
    let after
    if (x.type === 1 || (x.type === 0 && x.key.length === 1)) after = x.value
    else if (x.type === 0) after = { ...before, [x.key[1]]: x.value }
    else if (x.key.length === 1) after = undefined
    else { after = { ...before }; delete after[x.key[1]] }
    if (after === undefined) rows.delete(k); else rows.set(k, after)
    const p2 = (row) => (row === undefined ? null : { u: row.user, c: row.cents })
    enriched.push(reads ? { type: 0, key: [k], value: { b: p2(before), a: p2(after) } } : { type: 2, key: [k] })
  }
  const en = sizeOf(enriched)
  const log = sizeOf(recs), b0 = sizeOf(bare), bp = sizeOf(projPrev) - b0, b2 = sizeOf(proj2Prev) - b0, br = sizeOf(rowPrev) - b0
  // proj2: the two fields a sum-by reads (user, cents); proj3: plus `score`, for a top-k too; row: the whole row before
  out({ exp: 'E-64', opt: 'O2', bench: 'bytes', records: H, log_b_per_record: +(log / H).toFixed(1), proj2_prev_b_per_record: +(b2 / H).toFixed(1), proj2_share: +(b2 / log).toFixed(3), proj3_prev_b_per_record: +(bp / H).toFixed(1), row_prev_b_per_record: +(br / H).toFixed(1), proj3_share: +(bp / log).toFixed(3), row_share: +(br / log).toFixed(3), records_needing_prev: +(touched / H).toFixed(3), enriched2_b_per_record: +(en / H).toFixed(1) })
}
