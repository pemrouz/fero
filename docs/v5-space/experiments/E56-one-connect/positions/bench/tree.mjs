// E-56 positions, measurement 2: what it costs a write to keep a hash structure over a partition's rows.
//   node --expose-gc tree.mjs <rows> <way>
// One partition of n rows (E-05's small row, about 100 B as JSON) in a Map, the fold's stand-in. Each write
// replaces one row, picked at random (seeded), with a new row object made before the clock starts. The way
// then does its own extra work. Ways:
//   base     only the Map write (the reference; "extra" below is a way's time minus this)
//   ver      + a per-row version, kept in a Map from key to version (what "rows newer than mine" needs)
//   rowhash  + one 64-bit hash of the new row: JSON.stringify, then xxHash32 under two seeds
//   sum      E-05's order-free set hash, kept per write: minus the old row's hash (recomputed from prev, as
//            data hands prev to a sink), plus the new row's hash. Nothing is kept per row
//   sumkept  the same, with each row's hash kept (a Map from key to index, and 8 B a row), so the old one is
//            read, not recomputed
//   mkver    a 16-ary hash tree over (key, version), eager: each leaf is a bucket by the key's hash and holds the
//            order-free sum of its rows' (key, version) hashes; each inner node is a 64-bit hash (xxHash32 under
//            two seeds) of its 16 children's 8 B. Every write rehashes the path to the root (d nodes of 128 B).
//            It rides on `ver`, since the old version must be known. What a resume walk needs
//   mkverb   the same, but the path is rehashed once per 256 writes (a batch), for the leaves the batch dirtied
//   mkleaf   the same leaves, kept per write; the inner nodes are not kept, but built when a peer asks for them
//            (inner_ms below): the cheapest form, as Cassandra builds its repair trees on demand
//   mkrow    the same tree over each row's content hash (as `sum`, old from prev): what a replica check needs
//   mksha    a crypto tree: SHA-256 per row over (key, row) kept (32 B a row); a leaf is SHA-256 of its rows'
//            hashes in key order; an inner node is SHA-256 of its 16 children's 32 B. What a proof needs
// Depth d = max(1, ceil(log16(n / 16))): 2 at 1,000 rows (256 leaves), 4 at 100,000 and 1,000,000 (65,536).
// After the timed writes, every structure is rebuilt from scratch and compared with the kept one (check).
// inner_ms: for each tree, the time to build every inner node from the leaves (median of 5): what a peer's
// question costs when nothing above the leaves is kept. tree_b_row: the tree's own typed arrays, exact, per row
// (bytes_row is measured from the heap: it adds the per-row Maps, and is noisy at 1,000 rows).
import crypto from 'node:crypto'
import { xxh32, now, median, out, row, key, rng, heap, gc, hashKeyVer, hashKeyRow, depthFor, bucketOf, loadavg, te, SCRATCH } from './common.mjs'

const N = +process.argv[2], WAY = process.argv[3]
const WARM = 30000, ROUND = 90000, ROUNDS = 3, W = WARM + ROUND * ROUNDS
const keys = Array.from({ length: N }, (_, i) => key(i))
const rows = new Map()
for (let i = 0; i < N; i++) rows.set(keys[i], row(i, 0))
const r = rng(56)
const idx = new Int32Array(W)
for (let w = 0; w < W; w++) idx[w] = Math.floor(r() * N)
const fresh = new Array(W)
for (let w = 0; w < W; w++) fresh[w] = row(idx[w], w + 1)
let seq = N // versions: row i was inserted at version i + 1

gc()
const before = heap() + process.memoryUsage().arrayBuffers
const t0build = now()

// ── structures ────────────────────────────────────────────────────────────
const D = depthFor(N), LEAVES = 16 ** D
let vmap, rix, kept, levels, views, dirty, dirtyList, rowH, buckets, shaLv
const acc = new Uint32Array(2) // the order-free sum, 64 bits as two words
const usesVer = WAY === 'ver' || WAY === 'mkver' || WAY === 'mkverb' || WAY === 'mkleaf'
if (usesVer) { vmap = new Map(); for (let i = 0; i < N; i++) vmap.set(keys[i], i + 1) }
if (WAY === 'sum' || WAY === 'sumkept' || WAY === 'mkrow') {
  if (WAY === 'sumkept') { rix = new Map(); kept = new Uint32Array(2 * N) }
  for (let i = 0; i < N; i++) {
    const h = hashKeyRow(keys[i], rows.get(keys[i]))
    acc[0] += h[0]; acc[1] += h[1]
    if (kept) { rix.set(keys[i], i); kept[2 * i] = h[0]; kept[2 * i + 1] = h[1] }
  }
}
function xxLevels() {
  levels = []; views = []
  for (let l = 0; l <= D; l++) { const a = new Uint32Array(2 * 16 ** l); levels.push(a); views.push(new Uint8Array(a.buffer)) }
}
function rehashUp(leaf) { // the path from a leaf's parent to the root
  let p = leaf >>> 4
  for (let l = D - 1; l >= 0; l--) {
    const s = p * 128, v = views[l + 1]
    levels[l][2 * p] = xxh32(v, s, s + 128, 1); levels[l][2 * p + 1] = xxh32(v, s, s + 128, 2)
    p >>>= 4
  }
}
function rehashAll() {
  for (let l = D - 1; l >= 0; l--) {
    const v = views[l + 1], a = levels[l]
    for (let p = 0; p < 16 ** l; p++) { const s = p * 128; a[2 * p] = xxh32(v, s, s + 128, 1); a[2 * p + 1] = xxh32(v, s, s + 128, 2) }
  }
}
function leafAdd(lv, b, h, sign) { // a Uint32Array wraps the sum mod 2^32 by itself
  if (sign > 0) { lv[2 * b] += h[0]; lv[2 * b + 1] += h[1] } else { lv[2 * b] -= h[0]; lv[2 * b + 1] -= h[1] }
}
function buildXX(entry) { // entry(i) -> hash pair of row i
  xxLevels()
  const lv = levels[D]
  for (let i = 0; i < N; i++) leafAdd(lv, bucketOf(keys[i], D), entry(i), 1)
  rehashAll()
}
if (WAY === 'mkver' || WAY === 'mkverb' || WAY === 'mkleaf') buildXX((i) => hashKeyVer(keys[i], vmap.get(keys[i])))
if (WAY === 'mkrow') buildXX((i) => hashKeyRow(keys[i], rows.get(keys[i])))
if (WAY === 'mkverb') { dirty = new Uint8Array(LEAVES); dirtyList = [] }

// the crypto tree
const shaRow = (k, rw) => crypto.hash('sha256', te.encode(k + '\u0000' + JSON.stringify(rw)), 'buffer')
let leafScratch
function shaLeaf(b) {
  const m = buckets[b]
  for (let j = 0; j < m.length; j++) leafScratch.set(rowH.subarray(32 * m[j], 32 * m[j] + 32), 32 * j)
  shaLv[D].set(crypto.hash('sha256', leafScratch.subarray(0, 32 * m.length), 'buffer'), 32 * b)
}
function shaUp(leaf) {
  let p = leaf >>> 4
  for (let l = D - 1; l >= 0; l--) {
    shaLv[l].set(crypto.hash('sha256', shaLv[l + 1].subarray(p * 512, p * 512 + 512), 'buffer'), 32 * p)
    p >>>= 4
  }
}
function buildSha() {
  rix = new Map(); rowH = new Uint8Array(32 * N)
  buckets = Array.from({ length: LEAVES }, () => [])
  for (let i = 0; i < N; i++) { rix.set(keys[i], i); rowH.set(shaRow(keys[i], rows.get(keys[i])), 32 * i); buckets[bucketOf(keys[i], D)].push(i) }
  let most = 0
  for (const m of buckets) { m.sort((a, b) => (keys[a] < keys[b] ? -1 : 1)); most = Math.max(most, m.length) }
  leafScratch = new Uint8Array(32 * Math.max(1, most))
  shaLv = []; for (let l = 0; l <= D; l++) shaLv.push(new Uint8Array(32 * 16 ** l))
  for (let b = 0; b < LEAVES; b++) shaLeaf(b)
  for (let l = D - 1; l >= 0; l--) for (let p = 0; p < 16 ** l; p++) shaLv[l].set(crypto.hash('sha256', shaLv[l + 1].subarray(p * 512, p * 512 + 512), 'buffer'), 32 * p)
}
if (WAY === 'mksha') buildSha()

const buildMs = Number(now() - t0build) / 1e6
const after = heap() + process.memoryUsage().arrayBuffers
const bytesRow = (after - before) / N

// ── one write ─────────────────────────────────────────────────────────────
let sink = 0
function flush() {
  const lv = D - 1
  // rehash dirty parents level by level, each node once
  let cur = dirtyList.map((b) => b >>> 4)
  for (let l = lv; l >= 0; l--) {
    const seen = new Set(cur)
    for (const p of seen) { const s = p * 128, v = views[l + 1]; levels[l][2 * p] = xxh32(v, s, s + 128, 1); levels[l][2 * p + 1] = xxh32(v, s, s + 128, 2) }
    cur = [...seen].map((p) => p >>> 4)
  }
  for (const b of dirtyList) dirty[b] = 0
  dirtyList.length = 0
}
const WRITE = {
  base: () => {},
  ver: (k) => { vmap.set(k, ++seq) },
  rowhash: (k, prev, nr) => { const h = hashKeyRow(k, nr); sink ^= h[0] },
  sum: (k, prev, nr) => {
    let h = hashKeyRow(k, prev); acc[0] -= h[0]; acc[1] -= h[1]
    h = hashKeyRow(k, nr); acc[0] += h[0]; acc[1] += h[1]
  },
  sumkept: (k, prev, nr) => {
    const j = rix.get(k)
    acc[0] -= kept[2 * j]; acc[1] -= kept[2 * j + 1]
    const h = hashKeyRow(k, nr); kept[2 * j] = h[0]; kept[2 * j + 1] = h[1]
    acc[0] += h[0]; acc[1] += h[1]
  },
  mkver: (k) => {
    const old = vmap.get(k), v = ++seq; vmap.set(k, v)
    const b = bucketOf(k, D), lv = levels[D]
    leafAdd(lv, b, hashKeyVer(k, old), -1); leafAdd(lv, b, hashKeyVer(k, v), 1)
    rehashUp(b)
  },
  mkverb: (k) => {
    const old = vmap.get(k), v = ++seq; vmap.set(k, v)
    const b = bucketOf(k, D), lv = levels[D]
    leafAdd(lv, b, hashKeyVer(k, old), -1); leafAdd(lv, b, hashKeyVer(k, v), 1)
    if (!dirty[b]) { dirty[b] = 1; dirtyList.push(b) }
  },
  mkleaf: (k) => {
    const old = vmap.get(k), v = ++seq; vmap.set(k, v)
    const b = bucketOf(k, D), lv = levels[D]
    leafAdd(lv, b, hashKeyVer(k, old), -1); leafAdd(lv, b, hashKeyVer(k, v), 1)
  },
  mkrow: (k, prev, nr) => {
    const b = bucketOf(k, D), lv = levels[D]
    leafAdd(lv, b, hashKeyRow(k, prev), -1); leafAdd(lv, b, hashKeyRow(k, nr), 1)
    rehashUp(b)
  },
  mksha: (k, prev, nr) => {
    const j = rix.get(k)
    rowH.set(shaRow(k, nr), 32 * j)
    const b = bucketOf(k, D)
    shaLeaf(b); shaUp(b)
  },
}
const fn = WRITE[WAY]
if (!fn) throw new Error('unknown way ' + WAY)
const batched = WAY === 'mkverb'
let w = 0
function run(count) {
  const t0 = now()
  for (let c = 0; c < count; c++, w++) {
    const k = keys[idx[w]], prev = rows.get(k), nr = fresh[w]
    rows.set(k, nr)
    fn(k, prev, nr)
    if (batched && (w & 255) === 255) flush()
  }
  if (batched) flush()
  return Number(now() - t0) / count
}
run(WARM)
const per = []
for (let i = 0; i < ROUNDS; i++) per.push(run(ROUND))

// ── the inner nodes built on demand, and the tree's exact bytes ───────────
let innerMs = null, treeB = null
const shaInner = () => { for (let l = D - 1; l >= 0; l--) for (let p = 0; p < 16 ** l; p++) shaLv[l].set(crypto.hash('sha256', shaLv[l + 1].subarray(p * 512, p * 512 + 512), 'buffer'), 32 * p) }
if (levels) {
  const t = []; for (let i = 0; i < 5; i++) { const t0 = now(); rehashAll(); t.push(Number(now() - t0) / 1e6) }
  innerMs = +median(t).toFixed(3)
  treeB = +(levels.reduce((a, x) => a + x.byteLength, 0) / N).toFixed(2)
} else if (shaLv) {
  const t = []; for (let i = 0; i < 5; i++) { const t0 = now(); shaInner(); t.push(Number(now() - t0) / 1e6) }
  innerMs = +median(t).toFixed(3)
  treeB = +((shaLv.reduce((a, x) => a + x.byteLength, 0) + rowH.byteLength) / N).toFixed(2)
}

// ── check: rebuild from scratch and compare ───────────────────────────────
let check = 'n/a'
if (WAY === 'sum' || WAY === 'sumkept') {
  let a = 0, b = 0
  for (let i = 0; i < N; i++) { const h = hashKeyRow(keys[i], rows.get(keys[i])); a = (a + h[0]) >>> 0; b = (b + h[1]) >>> 0 }
  check = a === acc[0] && b === acc[1] ? 'ok' : 'MISMATCH'
} else if (WAY === 'mkver' || WAY === 'mkverb' || WAY === 'mkleaf' || WAY === 'mkrow') {
  if (WAY === 'mkleaf') rehashAll() // its inner nodes are built when asked
  const root = [levels[0][0], levels[0][1]]
  if (WAY === 'mkrow') buildXX((i) => hashKeyRow(keys[i], rows.get(keys[i])))
  else buildXX((i) => hashKeyVer(keys[i], vmap.get(keys[i])))
  check = root[0] === levels[0][0] && root[1] === levels[0][1] ? 'ok' : 'MISMATCH'
} else if (WAY === 'mksha') {
  const root = Buffer.from(shaLv[0]).toString('hex')
  for (let i = 0; i < N; i++) rowH.set(shaRow(keys[i], rows.get(keys[i])), 32 * i)
  for (let b = 0; b < LEAVES; b++) shaLeaf(b)
  shaInner()
  check = Buffer.from(shaLv[0]).toString('hex') === root ? 'ok' : 'MISMATCH'
}
out({ exp: 'E-56', part: 'tree', rows: N, way: WAY, depth: D, leaves: LEAVES, writes_timed: ROUND * ROUNDS,
  ns_write: +median(per).toFixed(1), ns_min: +Math.min(...per).toFixed(1), ns_max: +Math.max(...per).toFixed(1),
  bytes_row: +bytesRow.toFixed(1), tree_b_row: treeB, inner_ms: innerMs, build_ms: +buildMs.toFixed(1), check, sink: sink & 1, loadavg: loadavg() })
