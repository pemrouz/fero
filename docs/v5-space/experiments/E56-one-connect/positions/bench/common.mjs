// E-56 positions: shared helpers. No fero or data code is imported: these benches price hashing and
// tree upkeep on their own, with E-05's small row and E-05's xxHash32 (checked at import against
// xxHash's reference vectors).
import { xxh32 as xxh32e05 } from '../../../E05-fold-cost/bench/xxh.mjs'
export { xxh32e05 }

// E-05's xxHash32, line for line, except that it returns the 32 bits as a signed int (h | 0), not h >>> 0.
// Why: a uint32 above 2^31 is not a small integer to V8, so a call that is not inlined boxes it on the
// heap. In a probe, a 128 B node hash cost about 70 ns alone and about 335 ns inside the tree bench, where
// the boxes made the collector the top line of the profile. Checked below against E-05's function (which is
// checked against xxHash's reference vectors at its import) on 2,000 random inputs of 0 to 300 bytes.
const P1 = 0x9e3779b1 | 0, P2 = 0x85ebca77 | 0, P3 = 0xc2b2ae3d | 0, P4 = 0x27d4eb2f | 0, P5 = 0x165667b1 | 0
const rotl = (x, r) => (x << r) | (x >>> (32 - r))
const rd = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
export function xxh32(b, start, end, seed) {
  let i = start, h
  const len = end - start
  if (len >= 16) {
    let v1 = (seed + P1 + P2) | 0, v2 = (seed + P2) | 0, v3 = seed | 0, v4 = (seed - P1) | 0
    const lim = end - 16
    while (i <= lim) {
      v1 = Math.imul(rotl((v1 + Math.imul(rd(b, i), P2)) | 0, 13), P1); i += 4
      v2 = Math.imul(rotl((v2 + Math.imul(rd(b, i), P2)) | 0, 13), P1); i += 4
      v3 = Math.imul(rotl((v3 + Math.imul(rd(b, i), P2)) | 0, 13), P1); i += 4
      v4 = Math.imul(rotl((v4 + Math.imul(rd(b, i), P2)) | 0, 13), P1); i += 4
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0
  } else h = (seed + P5) | 0
  h = (h + len) | 0
  while (i + 4 <= end) { h = Math.imul(rotl((h + Math.imul(rd(b, i), P3)) | 0, 17), P4); i += 4 }
  while (i < end) { h = Math.imul(rotl((h + Math.imul(b[i], P5)) | 0, 11), P1); i++ }
  h ^= h >>> 15; h = Math.imul(h, P2); h ^= h >>> 13; h = Math.imul(h, P3); h ^= h >>> 16
  return h | 0
}
{
  let s = 12345
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) | 0; return (s >>> 8) & 255 }
  const b = new Uint8Array(400)
  for (let t = 0; t < 2000; t++) {
    const len = t % 301, off = t % 7
    for (let i = 0; i < len + off; i++) b[i] = rnd()
    if ((xxh32(b, off, off + len, t) >>> 0) !== xxh32e05(b, off, off + len, t)) throw new Error('xxh32 copy differs from E-05')
  }
}

export const now = () => process.hrtime.bigint()
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
export const heap = () => { gc(); return process.memoryUsage().heapUsed }
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
export const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// E-05's small row: about 100 bytes as JSON. i is the row number, s a stamp that changes per write.
export const row = (i, s) => ({
  name: 'user-' + i,
  email: 'u' + i + '\u0040example.com', // the same bytes as E-05's row; the escape keeps an address out of the file
  region: 'r' + (i % 16),
  room: i % 100,
  n: s,
  active: (i & 1) === 0,
  tags: ['a', 'b'],
})
// the same row padded to about 1 KB as JSON (a "1 KB row")
export const PAD = 'x'.repeat(900)
export const bigRow = (i, s) => ({ ...row(i, s), pad: PAD })
export const key = (i) => 'k' + i

// a seeded PRNG (mulberry32), so every run picks the same rows
export const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// 64 bits from two xxHash32 seeds, as E-05's order-free set hash makes them (seeds 1 and 2)
export const te = new TextEncoder()
const SCR = new Uint8Array(1 << 16)
// hash of a key and a version (the resume tree's leaf entry); returns [a, b] in a shared pair
const PAIR = new Uint32Array(2)
const DV = new DataView(SCR.buffer)
export function hashKeyVer(k, v) {
  const r = te.encodeInto(k, SCR)
  DV.setFloat64(r.written, v, true)
  const len = r.written + 8
  PAIR[0] = xxh32(SCR, 0, len, 1); PAIR[1] = xxh32(SCR, 0, len, 2)
  return PAIR
}
// hash of a key and its row's content: the row encoded by V8's JSON.stringify (E-05's fastest encoder)
export function hashKeyRow(k, r) {
  const w = te.encodeInto(k + '\u0000' + JSON.stringify(r), SCR).written
  PAIR[0] = xxh32(SCR, 0, w, 1); PAIR[1] = xxh32(SCR, 0, w, 2)
  return PAIR
}
export function encKeyRow(k, r) { return te.encodeInto(k + '\u0000' + JSON.stringify(r), SCR).written }
export const SCRATCH = SCR

// tree shape for a partition of n rows: 16-ary, depth d = max(1, ceil(log16(n / 16))), so a leaf holds
// about 1 to 16 rows. Leaves are buckets by the key's hash (its top bits), so a row never changes leaf.
export const depthFor = (n) => Math.max(1, Math.ceil(Math.log(n / 16) / Math.log(16)))
export function bucketOf(k, d) {
  const w = te.encodeInto(k, SCR).written
  return xxh32(SCR, 0, w, 7) >>> (32 - 4 * d)
}

// the load average, for each JSON line
import { readFileSync } from 'node:fs'
export const loadavg = () => { try { return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ') } catch { return '' } }
