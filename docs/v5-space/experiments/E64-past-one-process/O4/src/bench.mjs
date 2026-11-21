// E-64 O4: what the routing step and a view shard cost. One JSON line per run; run.sh runs each three times,
// each process alone under the timing lock. data at 63fea66 and fero v4's codec (kernel/codec.ts), read only.
//   node --expose-gc bench.mjs route <rows> <records> <K> <plain|route|encode|encode256>
//        a source copy's fold in lanes of 256 records: plain; with the router (data's row deltas with prev, each
//        changed row sent as leave/row messages to the shards of its old and new bucket); with the router's
//        messages also encoded into fero frames, one per shard per lane (encode) or one per shard once it holds
//        256 messages (encode256): ns a record, messages a record
//   node --expose-gc bench.mjs shard <rows> <records> <K> <sum|full>
//        one view shard of K: its rows (only the fields the view reads, only its buckets) in a data store, and per
//        bucket a count and an exact sum (sum), and also the scores in order, for max and a top 3 (full); it
//        decodes its frames and applies them: ns a message, heap a row
//   node --expose-gc bench.mjs r0 <rows> <records> <sum|full>
//        R0's way, for the same view: one store holding every whole row, folding every record, the view kept from
//        data's row deltas: ns a record, heap a row
//   node --expose-gc bench.mjs scan <rows> <K>     a picture's scan at a copy: every row, keep this shard's: ns a row
//   node bench.mjs bytes <records> <K>             bytes a record: the log as is, and the routed messages
import { pathToFileURL, fileURLToPath } from 'node:url'
import { rng, bkey, shardOf, Bucket, SumBucket, out } from './lib.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url))
const FERO = process.env.FERO ?? fileURLToPath(new URL('../../../../../../', import.meta.url))
const [mode, a1, a2, a3, a4] = process.argv.slice(2)
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
const heap = () => process.memoryUsage().heapUsed
const NODE = Symbol.for('data.v4.node')

// The workload of E-64 O2's bench, so the options compare: rows of eight fields (about 100 B encoded); 25 % whole
// rows, 30 % cents, 12 % user (the bucket), 13 % score, 8 % paid, 3 % cents deleted, 9 % row removed (a later
// write inserts it again). The view reads user, cents and score.
const SKU = (r) => 'sku-' + Math.floor(r() * 1e5)
function rowOf(r, buckets) { return { user: 'u' + Math.floor(r() * buckets), cents: Math.floor(r() * 10000), score: Math.floor(r() * 1e6), paid: r() < 0.5, sku: SKU(r), title: 'item ' + Math.floor(r() * 1e9).toString(36) + ' blue large', at: 1.7e12 + Math.floor(r() * 1e10), qty: 1 + Math.floor(r() * 5) } }
function makeGen(N, buckets, seed = 1) {
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
const B = 1000 // buckets (users): the view's output keys
async function store(N) {
  const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
  const src = D.$({})
  const lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
  const r = rng(99)
  for (let i = 0; i < N; i += 4096) { const b = []; for (let j = i; j < Math.min(N, i + 4096); j++) b.push({ type: 1, key: [], at: 'k' + j, value: rowOf(r, B) }); lane(b) }
  return { D, src, lane }
}
const P = (row) => ({ u: row.user, c: row.cents, s: row.score }) // the fields the view reads
const same = (a, b) => a.u === b.u && Object.is(a.c, b.c) && Object.is(a.s, b.s)
// THE ROUTER (rule O4-1): per changed row, a leave to the old bucket's shard and the row to the new one's
function makeRouter(K) {
  const msgs = Array.from({ length: K }, () => [])
  const st = { msgs: 0, cross: 0, unchanged: 0, changes: 0 }
  const shardCache = new Map() // a bucket's shard, worked out once per bucket name
  const sh = (u) => { const b = bkey(u); if (b === undefined) return -1; let k = shardCache.get(b); if (k === undefined) { k = shardOf(b, K); shardCache.set(b, k) } return k }
  const apply = (b) => {
    for (const d of b.rows) {
      st.changes++
      const before = d.op === 'add' ? undefined : d.prev, after = d.op === 'remove' ? undefined : d.row
      const ko = before ? sh(before.user) : -1, kn = after ? sh(after.user) : -1
      if (ko === kn && ko >= 0 && same(P(before), P(after))) { st.unchanged++; continue }
      if (ko >= 0 && ko !== kn) { msgs[ko].push({ type: 2, key: [d.key] }); st.msgs++ }
      if (kn >= 0) { msgs[kn].push({ type: 0, key: [d.key], value: P(after) }); st.msgs++ }
      if (ko >= 0 && kn >= 0 && ko !== kn) st.cross++
    }
  }
  return { msgs, st, apply }
}
const fold = (lane, recs) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < recs.length; i += 256) lane(recs.slice(i, i + 256)); return Number(process.hrtime.bigint() - t0) }
// per-bucket view state kept from data's row deltas (the same Bucket the sim checks): count, exact sum, scores in order
function viewSink(src, rowsAreProj, full) {
  const Kind = full ? Bucket : SumBucket
  const buckets = new Map()
  const put = (k, row, sgn) => {
    const p = rowsAreProj ? row : P(row)
    const b = bkey(p.u); if (b === undefined) return
    let bk = buckets.get(b); if (!bk) { bk = new Kind(); buckets.set(b, bk) }
    bk.add(k, p, sgn); if (bk.n === 0) buckets.delete(b)
  }
  src[NODE].each((k, row) => put(k, row, +1))
  src.sink({ apply(b) { for (const d of b.rows) { if (d.op !== 'add') put(d.key, d.prev, -1); if (d.op !== 'remove') put(d.key, d.row, +1) } } })
  return buckets
}

if (mode === 'route') {
  const N = +a1, H = +a2, K = +a3, v = a4
  const { src, lane } = await store(N)
  const gen = makeGen(N, B), warm = gen(20000), recs = gen(H)
  const R = makeRouter(K)
  let C = null
  if (v !== 'plain') src.sink(R)
  if (v.startsWith('encode')) C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
  let bytes = 0
  const min = v === 'encode256' ? 256 : 1
  const flush = () => { for (let k = 0; k < K; k++) { const m = R.msgs[k]; if (m.length >= min) { if (C) bytes += C.encodeFrame(m).length; m.length = 0 } } }
  for (let i = 0; i < warm.length; i += 256) { lane(warm.slice(i, i + 256)); flush() }
  Object.assign(R.st, { msgs: 0, cross: 0, unchanged: 0, changes: 0 }); bytes = 0
  gc()
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < H; i += 256) { lane(recs.slice(i, i + 256)); flush() }
  const ns = Number(process.hrtime.bigint() - t0) / H
  out({ exp: 'E-64', opt: 'O4', bench: 'route', variant: v, rows: N, records: H, K, node: process.version, ns_per_record: +ns.toFixed(1), changes_per_record: v === 'plain' ? null : +(R.st.changes / H).toFixed(3), msgs_per_record: v === 'plain' ? null : +(R.st.msgs / H).toFixed(3), cross_shard_per_record: v === 'plain' ? null : +(R.st.cross / H).toFixed(4), unchanged_per_record: v === 'plain' ? null : +(R.st.unchanged / H).toFixed(3), msg_bytes_per_record: C ? +(bytes / H).toFixed(1) : null })
} else if (mode === 'shard') {
  const N = +a1, H = +a2, K = +a3, full = a4 === 'full'
  const C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
  // make shard 0's input: a source store routed (not timed), its rows at the start and its messages
  const { src, lane } = await store(N)
  const R = makeRouter(K)
  const init = []
  src[NODE].each((k, row) => { const b = bkey(row.user); if (b !== undefined && shardOf(b, K) === 0) init.push({ type: 1, key: [], at: k, value: P(row) }) })
  const gen = makeGen(N, B), warm = gen(20000), recs = gen(H)
  src.sink(R)
  const frames = []
  for (const part of [warm, recs]) {
    const fs = []
    for (let i = 0; i < part.length; i += 256) { // shard 0's frames, 256 messages each, as the encode256 router sends them
      lane(part.slice(i, i + 256))
      for (let k = 1; k < K; k++) R.msgs[k].length = 0
      if (R.msgs[0].length >= 256) { fs.push(C.encodeFrame(R.msgs[0])); R.msgs[0].length = 0 }
    }
    if (R.msgs[0].length) { fs.push(C.encodeFrame(R.msgs[0])); R.msgs[0].length = 0 }
    frames.push(fs)
  }
  const nWarm = frames[0].length
  // the shard: a fresh process-side store with only its rows; its view kept from data's deltas
  gc(); const h0 = heap()
  const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
  const s2 = D.$({}), lane2 = D.lane(s2, { onReject: (rj) => { throw rj.error } })
  for (let i = 0; i < init.length; i += 4096) lane2(init.slice(i, i + 4096))
  const buckets = viewSink(s2, true, full)
  gc(); const h1 = heap()
  const rowsHeld = init.length
  // a shard folds what it received in batches of about 256 messages, one lane call each, as a copy folds a
  // batch per call; a row message is an upsert at [key] and a leave a remove (data takes both as they are)
  const applyFrames = (fs) => {
    let n = 0, buf = []
    for (const f of fs) {
      for (const rv of new C.Frame(f).records()) { buf.push(rv.rec()); n++ }
      if (buf.length >= 256) { lane2(buf); buf = [] }
    }
    if (buf.length) lane2(buf)
    return n
  }
  applyFrames(frames[0])
  gc()
  const t0 = process.hrtime.bigint()
  const n = applyFrames(frames[1])
  const ns = Number(process.hrtime.bigint() - t0) / n
  out({ exp: 'E-64', opt: 'O4', bench: 'shard', view: full ? 'full' : 'sum', rows: N, records: H, K, node: process.version, rows_held: rowsHeld, buckets: buckets.size, heap_b_per_row: +((h1 - h0) / rowsHeld).toFixed(0), msgs: n, msgs_per_source_record: +(n / H).toFixed(4), ns_per_msg: +ns.toFixed(1), warm_frames: nWarm })
} else if (mode === 'r0') {
  const N = +a1, H = +a2, full = a3 === 'full'
  const gen = makeGen(N, B), partA = gen(H), warm = gen(20000), recs = gen(H)
  gc(); const h0 = heap()
  const { src, lane } = await store(N)
  gc(); const h1 = heap()
  const plainNs = fold(lane, partA) / H
  gc(); const h2 = heap()
  const buckets = viewSink(src, false, full)
  gc(); const h3 = heap()
  fold(lane, warm)
  gc()
  const viewNs = fold(lane, recs) / H
  out({ exp: 'E-64', opt: 'O4', bench: 'r0', view: full ? 'full' : 'sum', rows: N, records: H, node: process.version, heap_b_per_row: +((h1 - h0) / N).toFixed(0), view_heap_b_per_row: +((h3 - h2) / N).toFixed(0), ns_fold: +plainNs.toFixed(1), ns_fold_and_view: +viewNs.toFixed(1), ns_view: +(viewNs - plainNs).toFixed(1), buckets: buckets.size })
} else if (mode === 'scan') {
  const N = +a1, K = +a2
  const { src } = await store(N)
  const node = src[NODE]
  const once = () => { const rows = []; node.each((k, row) => { const b = bkey(row.user); if (b !== undefined && shardOf(b, K) === 0) rows.push([k, P(row)]) }); return rows.length }
  once(); gc()
  const reps = 5
  const t0 = process.hrtime.bigint()
  let kept = 0
  for (let i = 0; i < reps; i++) kept = once()
  const ns = Number(process.hrtime.bigint() - t0) / reps
  out({ exp: 'E-64', opt: 'O4', bench: 'scan', rows: N, K, node: process.version, ms_per_scan: +(ns / 1e6).toFixed(1), ns_per_row: +(ns / N).toFixed(1), kept })
} else if (mode === 'bytes') {
  const H = +a1, K = +a2, N = 100000
  const C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
  const { src, lane } = await store(N)
  const R = makeRouter(K)
  src.sink(R)
  const recs = makeGen(N, B)(H)
  let logB = 0, msgB = 0, frames = 0
  for (let i = 0; i < H; i += 256) {
    const sl = recs.slice(i, i + 256)
    logB += C.encodeFrame(sl).length
    lane(sl)
    for (let k = 0; k < K; k++) { const m = R.msgs[k]; if (m.length >= 256) { msgB += C.encodeFrame(m).length; frames++; m.length = 0 } }
  }
  for (let k = 0; k < K; k++) { const m = R.msgs[k]; if (m.length) { msgB += C.encodeFrame(m).length; frames++; m.length = 0 } }
  out({ exp: 'E-64', opt: 'O4', bench: 'bytes', records: H, K, log_b_per_record: +(logB / H).toFixed(1), msg_b_per_record: +(msgB / H).toFixed(1), msgs_per_record: +(R.st.msgs / H).toFixed(3), msgs_per_frame: +(R.st.msgs / frames).toFixed(1), cross_shard_per_record: +(R.st.cross / H).toFixed(4) })
}
