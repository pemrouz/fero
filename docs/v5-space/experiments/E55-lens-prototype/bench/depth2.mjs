// Claim 19: `depth: 2` (a row one level down; the first key its partition) against a flat store with PA-17's
// index (row key 'p/r', plus a Map from partition to its rows, kept on every fold).
//   node --expose-gc --experimental-strip-types depth2.mjs <way> <rows> <rowsPerPartition>
// ways, all on data's real engine unless named "plain":
//   d2data      one data SourceNode per partition (the two-level store with today's data: D3 not built)
//   flatidx     one data SourceNode keyed 'p/r', and a Map partition → Set of row keys, kept on each fold
//   d2plain     a plain two-level Map (partition → Map row → value), data's path-copy rule, no engine: the floor
//   flatplain   a plain Map keyed 'p/r' plus the same index: the floor for flat
// Measured: fold (ns per record, the E-54 mix: 45% field writes, 45% row writes, 5% adds, 5% removes; one commit
// each), a 100-row partition's first picture, bytes kept per partition (heap after build minus the rows alone),
// a row write in partitions of 1 to 10,000 rows, and the bytes one record's key adds on the wire (JSON).
import { SourceNode, D } from '../proto/lens.mjs'
import { gc, heap, out, r1, r3, rng, med, now } from './common.mjs'

const WAY = process.argv[2], N = +process.argv[3], P = +process.argv[4]
const parts = Math.ceil(N / P)
const row = (i, s) => ({ name: 'user-' + i, email: 'u' + i + '.example.com', region: 'r' + (i % 16), n: s, active: (i & 1) === 0 })
const pOf = (i) => 'p' + Math.floor((i % N) / P), rOf = (i) => 'm' + i // a row added later joins an existing partition
// the rows alone, for the per-partition overhead
gc(); const h00 = heap()
let rowsOnly = new Array(N); for (let i = 0; i < N; i++) rowsOnly[i] = row(i, 0)
gc(); const rowsBytes = heap() - h00
rowsOnly = null; gc()

const rt = D.runtime()
let st
const h0 = heap()
const t0 = performance.now()
if (WAY === 'd2data') {
  const m = new Map()
  for (let i = 0; i < N; i++) { const p = pOf(i); let o = m.get(p); if (!o) { o = {}; m.set(p, o) } o[rOf(i)] = row(i, 0) }
  st = new Map(); for (const [p, o] of m) { const s = new SourceNode(rt, o); s.promote(); st.set(p, s) }
} else if (WAY === 'flat') { // the base: the same rows in one data source, no index
  const o = {}; for (let i = 0; i < N; i++) o[pOf(i) + '/' + rOf(i)] = row(i, 0)
  st = { src: new SourceNode(rt, o), idx: null }; st.src.promote()
} else if (WAY === 'flatidx') {
  const o = {}; const idx = new Map()
  for (let i = 0; i < N; i++) { const p = pOf(i), r = rOf(i); o[p + '/' + r] = row(i, 0); let s = idx.get(p); if (!s) { s = new Set(); idx.set(p, s) } s.add(r) }
  st = { src: new SourceNode(rt, o), idx }; st.src.promote()
} else if (WAY === 'd2plain') {
  st = new Map(); for (let i = 0; i < N; i++) { const p = pOf(i); let m = st.get(p); if (!m) { m = new Map(); st.set(p, m) } m.set(rOf(i), row(i, 0)) }
} else if (WAY === 'flatplain') {
  const m = new Map(), idx = new Map()
  for (let i = 0; i < N; i++) { const p = pOf(i), r = rOf(i); m.set(p + '/' + r, row(i, 0)); let s = idx.get(p); if (!s) { s = new Set(); idx.set(p, s) } s.add(r) }
  st = { m, idx }
}
const buildMs = performance.now() - t0
gc(); const h1 = heap()
const storeBytes = h1 - h0 // rows and structure; per-partition overhead = (this - the flat base) / partitions

// the fold: one record per commit, E-54's mix
const H = Math.min(1000000, Math.max(200000, N))
const r = rng(19)
const live = new Int32Array(N + H); for (let i = 0; i < N; i++) live[i] = i
let nl = N, next = N
const recs = new Array(H)
for (let i = 0; i < H; i++) {
  const m = r() % 100
  if (m < 45) { const j = live[r() % nl]; recs[i] = [0, pOf(j), rOf(j), 'n', i] }
  else if (m < 90) { const j = live[r() % nl]; recs[i] = [0, pOf(j), rOf(j), null, row(j, i)] }
  else if (m < 95) { const j = next++; live[nl++] = j; recs[i] = [1, pOf(j), rOf(j), null, row(j, i)] }
  else { const x = r() % nl, j = live[x]; live[x] = live[--nl]; recs[i] = [2, pOf(j), rOf(j)] }
}
// adds land in an existing partition (pOf(j % N)), so the partition count stays put
const EMPTY = []
const one = ['n']
let fold
if (WAY === 'd2data') fold = (x) => { const s = st.get(x[1]); if (x[0] === 2) s.remove(x[2]); else s.write(x[2], x[3] === null ? EMPTY : one, x[4]) }
else if (WAY === 'flat') fold = (x) => { const k = x[1] + '/' + x[2]; if (x[0] === 2) st.src.remove(k); else st.src.write(k, x[3] === null ? EMPTY : one, x[4]) }
else if (WAY === 'flatidx') fold = (x) => {
  const k = x[1] + '/' + x[2]
  if (x[0] === 2) { st.src.remove(k); st.idx.get(x[1])?.delete(x[2]) }
  else { if (x[0] === 1) st.idx.get(x[1]).add(x[2]); st.src.write(k, x[3] === null ? EMPTY : one, x[4]) }
}
else if (WAY === 'd2plain') fold = (x) => { const m = st.get(x[1]); if (x[0] === 2) m.delete(x[2]); else if (x[3] === null) m.set(x[2], x[4]); else { const c = { ...m.get(x[2]) }; c.n = x[4]; m.set(x[2], c) } }
else fold = (x) => {
  const k = x[1] + '/' + x[2]
  if (x[0] === 2) { st.m.delete(k); st.idx.get(x[1])?.delete(x[2]) }
  else { if (x[0] === 1) st.idx.get(x[1]).add(x[2]); if (x[3] === null) st.m.set(k, x[4]); else { const c = { ...st.m.get(k) }; c.n = x[4]; st.m.set(k, c) } }
}
gc()
let tf = now()
for (let i = 0; i < H; i++) fold(recs[i])
const foldNs = r1(Number(now() - tf) / H)

// a partition's first picture: every row of one partition, as a sink's init would walk them
const pic = () => {
  const p = 'p' + (r() % parts)
  let n = 0
  if (WAY === 'd2data') st.get(p).each(() => n++)
  else if (WAY === 'flatidx') { for (const rk of st.idx.get(p)) if (st.src.get(p + '/' + rk) !== undefined) n++ }
  else if (WAY === 'flat') { st.src.each((k) => { if (k.startsWith(p + '/')) n++ }) } // no index: a walk of every row
  else if (WAY === 'd2plain') { for (const _ of st.get(p).values()) n++ }
  else { for (const rk of st.idx.get(p)) if (st.m.get(p + '/' + rk) !== undefined) n++ }
  return n
}
const picMs = []; let picRows = 0
for (let i = 0; i < 21; i++) { const t = now(); picRows += pic(); picMs.push(Number(now() - t) / 1e6) }

// a row write (whole row, a live row) in this store: ns each, 100,000 writes spread over the rows
const W = 100000
const wr = []
for (let rep = 0; rep < 5; rep++) {
  gc(); const t = now()
  for (let i = 0; i < W; i++) { const j = (i * 7919) % N; fold([0, pOf(j), rOf(j), null, row(j, rep * W + i)]) }
  wr.push(Number(now() - t) / W)
}
// the key's bytes on the wire (JSON): ["p12","m1234"] against ["p12/m1234"]
const sample = 'p' + Math.floor(N / 2 / P), rk = 'm' + Math.floor(N / 2)
const keyExtra = JSON.stringify([0, [sample, rk, 'n'], 5]).length - JSON.stringify([0, [sample + '/' + rk, 'n'], 5]).length
out({ claim: 19, bench: 'depth2', way: WAY, rows: N, rowsPerPartition: P, partitions: parts, buildMs: Math.round(buildMs), storeBytes, rowsBytes, foldNsPerRecord: foldNs, records: H, firstPictureMs: r3(med(picMs)), picRowsAvg: Math.round(picRows / 21), rowWriteNs: r1(med(wr)), keyExtraBytesJson: keyExtra })
