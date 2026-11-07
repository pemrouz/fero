// xxHash32 (Yann Collet's algorithm) in plain JS over a byte range; checked against the reference vectors
// below at import. Used for F-21's state hash: one 32-bit hash per row with two seeds = 64 bits per row,
// summed over rows (an order-free sum, so two replicas whose stores iterate in different orders agree).
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
  return h >>> 0
}
// reference vectors (xxHash's own test values for seed 0)
const t = (s) => { const b = new TextEncoder().encode(s); return xxh32(b, 0, b.length, 0) }
if (t('') !== 0x02cc5d05 || t('a') !== 0x550d7456 || t('abc') !== 0x32d153ff || t('Nobody inspects the spammish repetition') !== 0xe2293b2f)
  throw new Error('xxh32 does not match the reference vectors')
