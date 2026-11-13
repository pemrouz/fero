// b1: what a checksum and a copy cost per byte, per record and per batch, on Node 22.
// Two checksums: fero v4's JS crc32c (kernel/codec.ts, imported read-only) and Node's native zlib.crc32
// (CRC-32/IEEE, not Castagnoli). A JS slice-by-8 crc32c is kept only as a check-value self-test (a first try ran
// slower than v4's table loop, so it is not timed). Two copies: dst.set(src) into a reused buffer, and
// src.slice() (a new buffer and a copy, as v4's restore and rowOf do per frame).
// Usage: node --experimental-strip-types b1-checksum.mjs <run>
import zlib from 'node:zlib'
import { crc32c } from '../../../../../../kernel/codec.ts'

const run = Number(process.argv[2] ?? 1)
const REC = 100, PER = 256, BATCH = REC * PER // 25,600 B: E-05's 256 small records
const TOTAL = 32 << 20
const buf = new Uint8Array(TOTAL)
for (let i = 0; i < TOTAL; i++) buf[i] = (i * 2654435761 >>> 13) & 0xff

// crc32c sliced by 8 (Castagnoli, reflected 0x82f63b78), table built once
const T = Array.from({ length: 8 }, () => new Uint32Array(256))
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; T[0][i] = c >>> 0 }
for (let i = 0; i < 256; i++) for (let t = 1; t < 8; t++) T[t][i] = (T[t - 1][i] >>> 8) ^ T[0][T[t - 1][i] & 0xff]
const [T0, T1, T2, T3, T4, T5, T6, T7] = T
const crc8 = (b, s, e) => {
  let c = 0xffffffff, i = s
  for (; i + 8 <= e; i += 8) {
    const lo = c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24))
    c = T7[lo & 0xff] ^ T6[(lo >>> 8) & 0xff] ^ T5[(lo >>> 16) & 0xff] ^ T4[lo >>> 24] ^
        T3[b[i + 4]] ^ T2[b[i + 5]] ^ T1[b[i + 6]] ^ T0[b[i + 7]]
  }
  for (; i < e; i++) c = T0[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// self-check: crc32c("123456789") = 0xe3069283
const nine = new TextEncoder().encode('123456789')
if (crc32c(nine) !== 0xe3069283 || crc8(nine, 0, 9) !== 0xe3069283) throw new Error('crc32c check value')
if (zlib.crc32(Buffer.from('123456789')) !== 0xcbf43926) throw new Error('crc32 check value')

const nb = Buffer.from(buf.buffer, buf.byteOffset, buf.length)
const dst = new Uint8Array(1 << 20)
const hot = Buffer.from(nb.subarray(0, 1 << 20)), hb = new Uint8Array(hot.buffer, hot.byteOffset, hot.length)
let sink = 0
const cases = {
  'v4-js-crc32c/record': () => { for (let o = 0; o < TOTAL; o += REC) sink ^= crc32c(buf, o, o + REC) },
  'v4-js-crc32c/batch': () => { for (let o = 0; o < TOTAL; o += BATCH) sink ^= crc32c(buf, o, o + BATCH) },
  'zlib-crc32/record': () => { for (let o = 0; o < TOTAL; o += REC) sink ^= zlib.crc32(nb.subarray(o, o + REC)) },
  'zlib-crc32/batch': () => { for (let o = 0; o < TOTAL; o += BATCH) sink ^= zlib.crc32(nb.subarray(o, o + BATCH)) },
  'zlib-crc32/1MiB': () => { for (let o = 0; o < TOTAL; o += 1 << 20) sink ^= zlib.crc32(nb.subarray(o, o + (1 << 20))) },
  // the same batches over one 1 MiB buffer read 32 times: bytes already in the CPU's cache, as a frame just read from
  // a socket is (added for E-50: on this host the native crc runs about 2.5 times faster on cached bytes)
  'zlib-crc32/batch-cached': () => { for (let k = 0; k < TOTAL >> 20; k++) for (let o = 0; o < 1 << 20; o += BATCH) sink ^= zlib.crc32(hot.subarray(o, Math.min(o + BATCH, 1 << 20))) },
  'v4-js-crc32c/batch-cached': () => { for (let k = 0; k < TOTAL >> 20; k++) for (let o = 0; o < 1 << 20; o += BATCH) sink ^= crc32c(hb, o, Math.min(o + BATCH, 1 << 20)) },
  'copy-set/batch': () => { for (let o = 0; o < TOTAL; o += BATCH) { dst.set(buf.subarray(o, o + BATCH), 0); sink ^= dst[7] } },
  'copy-slice/batch': () => { for (let o = 0; o < TOTAL; o += BATCH) sink ^= buf.slice(o, o + BATCH)[7] },
  'copy-slice/record': () => { for (let o = 0; o < TOTAL; o += REC) sink ^= buf.slice(o, o + REC)[7] },
  'copy-set/1MiB': () => { for (let o = 0; o < TOTAL; o += 1 << 20) { dst.set(buf.subarray(o, o + (1 << 20)), 0); sink ^= dst[7] } },
}
const time = (fn) => { const t = process.hrtime.bigint(); const c = process.cpuUsage(); fn(); const u = process.cpuUsage(c); return [Number(process.hrtime.bigint() - t), (u.user + u.system) * 1000] }
const load = (await import('node:os')).loadavg()[0]
for (const [name, fn] of Object.entries(cases)) {
  fn(); fn() // warm
  const walls = [], cpus = []
  for (let r = 0; r < 7; r++) { const [w, c] = time(fn); walls.push(w); cpus.push(c) }
  walls.sort((a, b) => a - b); cpus.sort((a, b) => a - b)
  const w = walls[3], c = cpus[3]
  console.log(JSON.stringify({ bench: 'b1', run, case: name, load, mb: TOTAL / 2 ** 20, ns_per_byte: +(w / TOTAL).toFixed(4), ns_per_100B_record: +(w / (TOTAL / REC)).toFixed(1), cpu_ns_per_byte: +(c / TOTAL).toFixed(4), mb_per_s: +(TOTAL / 2 ** 20 / (w / 1e9)).toFixed(0) }))
}
if (sink === 0.5) console.log('')
