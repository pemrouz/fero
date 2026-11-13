// crc.mjs — what one checksum pass costs, per size, three ways.
//   v4      : fero v4's crc32c (kernel/codec.ts: a 256-entry table, one byte a step), copied verbatim
//   sb8     : crc32c, slice-by-8 in plain JS (8 tables, 8 bytes a step): the best a pure-JS crc32c does
//   zlib    : node:zlib crc32 (CRC-32/IEEE, native, Node >= 22.2): a different polynomial, so a format change
// Prints ns per call and MB/s, median of 7 rounds of ~200 ms each.
import zlib from 'node:zlib'

const T = new Uint32Array(256)
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; T[i] = c >>> 0 }
const v4 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

const T8 = Array.from({ length: 8 }, () => new Uint32Array(256))
T8[0].set(T)
for (let i = 0; i < 256; i++) for (let s = 1; s < 8; s++) T8[s][i] = (T8[s - 1][i] >>> 8) ^ T[T8[s - 1][i] & 0xff]
const [t0, t1, t2, t3, t4, t5, t6, t7] = T8
const sb8 = (b) => {
  let c = 0xffffffff, i = 0
  const n = b.length - (b.length & 7)
  for (; i < n; i += 8) {
    const a = (c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24))) >>> 0
    c = t7[a & 0xff] ^ t6[(a >>> 8) & 0xff] ^ t5[(a >>> 16) & 0xff] ^ t4[a >>> 24] ^
      t3[b[i + 4]] ^ t2[b[i + 5]] ^ t1[b[i + 6]] ^ t0[b[i + 7]]
  }
  for (; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// sanity: the two crc32c agree, and match the published check value of "123456789" (0xE3069283)
const chk = new TextEncoder().encode('123456789')
if (v4(chk) !== 0xe3069283 || sb8(chk) !== 0xe3069283) throw new Error('crc32c self-check failed')
for (const n of [1, 7, 100, 4097]) { const b = new Uint8Array(n).map((_, i) => i * 31); if (v4(b) !== sb8(b)) throw new Error('sb8 differs at ' + n) }

const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
const time = (fn, b) => {
  let reps = 1
  for (;;) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(b); if (performance.now() - t > 20) break; reps *= 2 }
  reps = Math.max(1, Math.round(reps * 10))
  const rounds = []
  let sink = 0
  for (let r = 0; r < 7; r++) { const t = performance.now(); for (let i = 0; i < reps; i++) sink ^= fn(b); rounds.push((performance.now() - t) * 1e6 / reps) }
  globalThis.__sink = sink
  return median(rounds)
}
const out = []
for (const size of [128, 1024, 65536, 1 << 20]) {
  const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = (i * 2654435761) >>> 24
  const row = { size }
  for (const [name, fn] of [['v4', v4], ['sb8', sb8], ['zlib', (x) => zlib.crc32(x)]]) {
    const ns = time(fn, b)
    row[name + '_ns'] = +ns.toFixed(1)
    row[name + '_MBps'] = +(size / ns * 1e3).toFixed(0)
  }
  out.push(row)
}
console.log(JSON.stringify({ bench: 'crc', node: process.version, rows: out }))
