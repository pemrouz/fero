// E-54 part 2: what the live fold in data pays to keep reverse records, through fero v4's seam (E-06's tree).
//   TREE=<E-06 scratch tree> node --expose-gc live.mjs <rows> <mode>
// The same log as structs.mjs (H records, default 1e6), folded into a data source filled with N rows the way a
// replica fills one (E-06's fill: fero frames of 256, decoded, folded by data's lane).
//   base     substrate.applyRec per record (fero v4's fold: one data commit per record)
//   sink     + one data sink that does nothing (data hands each commit's CommitBatch to it)
//   prev     + a sink that keeps each delta's prev (data's UpdateDelta.prev / RemoveDelta.prev: the row before
//            the commit, by reference): the reverse records data already makes, kept
//   prev256  the lane with 256 records a call (one commit per frame, as a v5 kernel would hand over a batch) and
//            the same sink: data consolidates a commit to one delta per row, so a row written twice in one
//            frame gives one prev, not two
//   bytes    no timing: the encoded size, with fero v4's codec, of the log's records and of their prior values
//            (the leaf a field write replaced, or the whole prior row), i.e. what the log would grow by if
//            each record carried its prior value
import { S, D, C, fill } from '../../E06-fork-rewind/bench/common.mjs'
import { tape, initMap, applyMap, INSERT, REMOVE, UPDATE, gc, heapUsed, now, ns, out, mb, freedWatch } from './common.mjs'

const N = +process.argv[2]
const MODE = process.argv[3]
const H = +(process.env.H ?? 1e6)
const { recs } = tape(N, H)
// fero's insert shape: key [] with the row key in `at`
const frec = recs.map((x) => x.type === INSERT ? { type: INSERT, key: [], at: x.key[0], value: x.value } : x)

// the prior value of every record from a plain fold (the oracle; also what the log would carry)
const priors = (leaf) => {
  const m = initMap(N), p = new Array(H)
  for (let i = 0; i < H; i++) {
    const x = recs[i], k = x.key[0], r = m.get(k)
    p[i] = leaf && x.type === UPDATE && x.key.length === 2 ? r[x.key[1]] : r
    applyMap(m, x)
  }
  return p
}

if (MODE === 'bytes') {
  const sizeOf = (rs) => { let b = 0; for (let i = 0; i < rs.length; i += 256) b += C.encodeFrame(rs.slice(i, i + 256)).length; return b }
  const fwd = sizeOf(frec)
  const bare = sizeOf(recs.map((x) => ({ type: REMOVE, key: x.key })))
  const withLeaf = (p) => sizeOf(recs.map((x, i) => p[i] === undefined ? { type: REMOVE, key: x.key } : { type: UPDATE, key: x.key, value: p[i] }))
  const leafB = withLeaf(priors(true)) - bare, rowB = withLeaf(priors(false)) - bare
  const kinds = { field: 0, row: 0, insert: 0, remove: 0 }
  for (const x of recs) kinds[x.type === INSERT ? 'insert' : x.type === REMOVE ? 'remove' : x.key.length === 2 ? 'field' : 'row']++
  out({ exp: 'E-54', part: 'live', mode: 'bytes', rows: N, history: H, kinds, log_b_per_record: +(fwd / H).toFixed(1), prior_leaf_b_per_record: +(leafB / H).toFixed(1), prior_row_b_per_record: +(rowB / H).toFixed(1), leaf_share: +(leafB / fwd).toFixed(3), row_share: +(rowB / fwd).toFixed(3) })
  process.exit(0)
}

const p = S.proxy({})
fill(p, N)
let prevs = null, deltas = 0
if (MODE === 'sink') p.sink({ apply() {} })
if (MODE === 'prev' || MODE === 'prev256') {
  prevs = []
  p.sink({ apply(b) { const rs = b.rows; deltas += rs.length; for (let j = 0; j < rs.length; j++) { const d = rs[j]; prevs.push(d.op === 'add' ? undefined : d.prev) } } })
}
const lane = D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
gc()
const h0 = heapUsed()
const freed = freedWatch()
const t0 = now()
if (MODE === 'prev256') for (let i = 0; i < H; i += 256) lane(frec.slice(i, i + 256))
else for (let i = 0; i < H; i++) S.applyRec(p, frec[i])
const t = ns(t0)
gc()
const garbage = freed()
const h1 = heapUsed()
// prev from data, checked against the plain fold's prior rows (the reverse records are right)
let checked = 0, wrong = 0
if (MODE === 'prev') { const want = priors(false); for (let i = 0; i < H; i += 7) { checked++; if (JSON.stringify(prevs[i]) !== JSON.stringify(want[i])) wrong++ } }
out({ exp: 'E-54', part: 'live', mode: MODE, rows: N, history: H, node: process.version, ns_per_record: +(t / H).toFixed(1), kept_b_per_record: +((h1 - h0) / H).toFixed(1), garbage_b_per_record: +(garbage / H).toFixed(1), deltas_per_record: prevs ? +(deltas / H).toFixed(3) : null, prev_checked: checked, prev_wrong: wrong, heap_mb: mb(h1) })
