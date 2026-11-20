// E-56 positions, measurement 3: a client resumes a partition after the log it needs was compacted.
//   node --expose-gc resume.mjs <n> <k> <rowBytes: 100 | 1000>
// The client holds a picture of one partition of n rows at version v0. Since then the server took k changes:
// k - floor(k / 10) rows rewritten (a new version each) and floor(k / 10) rows removed. The log from v0 on is
// gone (history 0, a snapshot since). Four ways to bring the client up to date, each checked: the client's
// rows and versions must equal the server's afterwards.
//   (a) full     the server sends a new picture of the partition: every row. 1 round trip.
//   (c) since    the client sends its position (one partition: a version, 22 to 25 B by E-19). The server sends
//                every row whose version is above it, and every key removed above it. That needs a per-row
//                version on the server and the removed keys (tombstones) kept back to v0. 1 round trip.
//   (d) list     the client sends every key it holds with its version; the server answers with the rows that
//                differ and the keys it lacks. No tombstones, no tree. 1 round trip.
//   (b) walk     both sides keep a 16-ary hash tree over (key, version), as tree.mjs's `mkver` (depth from
//                common.mjs; 8 B node hashes). The client sends the root; the server answers with the 16
//                children of each node that differs; the client names the children that differ, level by
//                level; at the leaves the client sends its entries for each differing leaf and the server
//                answers with the rows to set and the keys to remove. d + 1 round trips.
// Bytes are counted exactly under one encoding, the same for every way: 8 B a message header; a key is
// 1 B of length plus its bytes; a version 8 B; a row sent is 2 B of length plus the key, version and its JSON;
// a removed key is the key plus (for (c), whose answer names it by version) its version; a node id 4 B; a
// node hash 8 B. `hashes` counts the node hashes sent (the root up, the rest down), so the same walk with
// 32 B hashes (SHA-256) is up_sha and down_sha. Times (server plus client CPU, tree builds excluded, 5 tries,
// the median) are given for 100 B rows only, under the timing lock.
import { now, median, out, row, bigRow, key, rng, hashKeyVer, depthFor, bucketOf, loadavg, xxh32, heap } from './common.mjs'

const N = +process.argv[2], K = +process.argv[3], RB = +process.argv[4] || 100
const mk = RB >= 1000 ? bigRow : row
const HDR = 8, H = 8, ID = 4, VER = 8, CURSOR = 25
const kb = (k) => 1 + Buffer.byteLength(k)
const D = depthFor(N), LEAVES = 16 ** D

// ── the partition at v0 on both sides, then k changes on the server ───────
const srv = new Map(), cli = new Map()
for (let i = 0; i < N; i++) { const e = { v: i + 1, val: mk(i, 0) }; srv.set(key(i), e); cli.set(key(i), e) }
const v0 = N
let seq = N
const r = rng(5600 + N + K), picked = new Set()
while (picked.size < K) picked.add(Math.floor(r() * N))
const nDel = Math.floor(K / 10), tomb = []
let j = 0
for (const i of picked) {
  const k = key(i)
  if (j++ < nDel) { srv.delete(k); tomb.push({ k, v: ++seq }) } else srv.set(k, { v: ++seq, val: mk(i, j) })
}

// value byte lengths (JSON, ASCII), cached once: the encoding is not what is being timed
const vlen = new Map()
const lenOf = (k, e) => { let l = vlen.get(e); if (l === undefined) { l = JSON.stringify(e.val).length; vlen.set(e, l) } return l }
const rowBytes = (k, e) => 2 + kb(k) + VER + lenOf(k, e)

// apply an answer to a copy of the client and compare with the server
function check(sets, dels) {
  const c = new Map(cli)
  for (const [k, e] of sets) c.set(k, e)
  for (const k of dels) c.delete(k)
  if (c.size !== srv.size) return 'MISMATCH size'
  for (const [k, e] of srv) { const x = c.get(k); if (!x || x.v !== e.v) return 'MISMATCH ' + k }
  return 'ok'
}
const timeIt = (fn) => { const t = []; let res; for (let i = 0; i < 5; i++) { const t0 = now(); res = fn(); t.push(Number(now() - t0) / 1e3) } return { us: +median(t).toFixed(1), res } }
const lines = []
const emit = (o) => lines.push({ exp: 'E-56', part: 'resume', rows: N, k: K, deleted: nDel, row_bytes: RB, depth: D, ...o })

// (a) the full picture
{
  let down = HDR; for (const [k, e] of srv) down += rowBytes(k, e)
  const { us, res } = timeIt(() => { const s = []; for (const [k, e] of srv) s.push([k, e]); return s })
  // a picture replaces the client's rows: every client key not in it goes
  const dels = []; for (const k of cli.keys()) if (!srv.has(k)) dels.push(k)
  emit({ way: 'a-full', trips: 1, up: HDR + CURSOR, down, cpu_us: us, check: check(res, dels) })
}
// (c) rows above my version, plus the removes kept back to v0
{
  const { us, res } = timeIt(() => {
    const sets = [], dels = []
    for (const [k, e] of srv) if (e.v > v0) sets.push([k, e])
    for (const t of tomb) if (t.v > v0) dels.push(t.k)
    return { sets, dels }
  })
  let down = HDR
  for (const [k, e] of res.sets) down += rowBytes(k, e)
  for (const k of res.dels) down += kb(k) + VER
  emit({ way: 'c-since', trips: 1, up: HDR + CURSOR, down, cpu_us: us, tombstones: tomb.length, check: check(res.sets, res.dels) })
}
// (d) the client's keys and versions
{
  let up = HDR; for (const k of cli.keys()) up += kb(k) + VER
  const { us, res } = timeIt(() => {
    const sets = [], dels = []
    for (const [k, e] of cli) { const s = srv.get(k); if (!s) dels.push(k); else if (s.v !== e.v) sets.push([k, s]) }
    for (const [k, e] of srv) if (!cli.has(k)) sets.push([k, e])
    return { sets, dels }
  })
  let down = HDR
  for (const [k, e] of res.sets) down += rowBytes(k, e)
  for (const k of res.dels) down += kb(k)
  emit({ way: 'd-list', trips: 1, up, down, cpu_us: us, check: check(res.sets, res.dels) })
}
// (b) the hash-tree walk
function tree(m) {
  const levels = [], views = []
  for (let l = 0; l <= D; l++) { const a = new Uint32Array(2 * 16 ** l); levels.push(a); views.push(new Uint8Array(a.buffer)) }
  const buckets = Array.from({ length: LEAVES }, () => [])
  const lv = levels[D]
  for (const [k, e] of m) {
    const b = bucketOf(k, D); buckets[b].push(k)
    const h = hashKeyVer(k, e.v); lv[2 * b] += h[0]; lv[2 * b + 1] += h[1]
  }
  for (let l = D - 1; l >= 0; l--) {
    const v = views[l + 1], a = levels[l]
    for (let p = 0; p < 16 ** l; p++) { const s = p * 128; a[2 * p] = xxh32(v, s, s + 128, 1); a[2 * p + 1] = xxh32(v, s, s + 128, 2) }
  }
  return { levels, buckets }
}
const mem = () => heap() + process.memoryUsage().arrayBuffers
const h0 = mem()
const T = { s: tree(srv), c: tree(cli) }
const treeBytesRow = (mem() - h0) / 2 / N // both trees with their bucket lists; per row per side
{
  const same = (a, b, l, i) => a.levels[l][2 * i] === b.levels[l][2 * i] && a.levels[l][2 * i + 1] === b.levels[l][2 * i + 1]
  const walk = () => {
    let up = HDR + H, down = HDR, trips = 1, hashes = 1
    const per = []
    if (same(T.s, T.c, 0, 0)) return { up, down: down + 1, trips, hashes, sets: [], dels: [], per }
    let frontier = [0]
    for (let l = 0; l < D; l++) {
      // the server sends the 16 children of each node in the frontier
      down += frontier.length * 16 * H; hashes += frontier.length * 16
      const next = []
      for (const p of frontier) for (let c = 16 * p; c < 16 * p + 16; c++) if (!same(T.s, T.c, l + 1, c)) next.push(c)
      per.push(next.length)
      frontier = next
      if (l + 1 < D) { trips++; up += HDR + ID * next.length; down += HDR } // the client names them
    }
    // the leaves: the client sends its entries of each differing leaf; the server answers
    trips++; up += HDR; down += HDR
    const sets = [], dels = []
    for (const b of frontier) {
      up += ID + 2
      const mine = new Map()
      for (const k of T.c.buckets[b]) { up += kb(k) + VER; mine.set(k, cli.get(k).v) }
      for (const k of T.s.buckets[b]) { const e = srv.get(k); if (mine.get(k) !== e.v) { sets.push([k, e]); down += rowBytes(k, e) } mine.delete(k) }
      for (const k of mine.keys()) { dels.push(k); down += kb(k) }
    }
    return { up, down, trips, hashes, sets, dels, per }
  }
  const { us, res } = timeIt(walk)
  emit({ way: 'b-walk', trips: res.trips, up: res.up, down: res.down, hashes: res.hashes, differing_per_level: res.per.join('/'),
    up_sha: res.up + 24, down_sha: res.down + 24 * (res.hashes - 1), tree_bytes_row: +treeBytesRow.toFixed(1), cpu_us: us, check: check(res.sets, res.dels) })
}
const la = loadavg()
for (const l of lines) { if (RB !== 100) delete l.cpu_us; out({ ...l, loadavg: la }) }
