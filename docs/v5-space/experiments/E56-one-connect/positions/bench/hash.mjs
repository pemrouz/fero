// E-56 positions, measurement 1: the cost of hashing one commit's encoded records.
//   node --expose-gc hash.mjs [way...]          (no way named: all of them)
// A commit here is the bytes of its records, as the log holds them: 1 record or 256 records (a full batch),
// each record exactly 100 B or 1,000 B (a JSON record [type, [key], row], padded to the size).
// Ways:
//   crc32        zlib.crc32 (native CRC-32/IEEE): what every batch already pays (LAYERS 1.2, "Batch")
//   xxh32        E-05's xxHash32 in plain JS, one seed: a 32-bit hash
//   xxh64x2      the same under two seeds (64 bits), E-05's row-hash form
//   xxh32s       common.mjs's copy of it that returns a signed int (no heap box); the same bits
//   sha256       node:crypto one-shot crypto.hash('sha256', bytes)
//   sha256obj    node:crypto createHash('sha256').update(bytes).digest()
//   sha256chain  a hash chain: createHash().update(previous 32 B).update(bytes).digest(), like git's parent link
// Each way and shape: 7 rounds of about 0.2 s in one process; the median, min and max ns per commit.
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { xxh32, xxh32e05, now, median, out, row, loadavg } from './common.mjs'

const te = new TextEncoder()
// one record as JSON text of exactly `size` bytes: a 1 KB record is E-05's row plus a pad field; a 100 B
// record is a short row ({ name, n }) plus a pad, since E-05's row alone makes a record of about 115 B
function record(i, size) {
  const value = size >= 300 ? row(i, i) : { name: 'user-' + i, n: i }
  const base = te.encode(JSON.stringify([0, ['k' + i], value])).length
  const pad = size - base - 7 // ,"p":"" is 7 bytes
  if (pad < 0) throw new Error('record too small for ' + size)
  const b = te.encode(JSON.stringify([0, ['k' + i], { ...value, p: 'x'.repeat(pad) }]))
  if (b.length !== size) throw new Error('record size ' + b.length + ' != ' + size)
  return b
}
function commit(c, recs, size) {
  const buf = Buffer.alloc(recs * size)
  for (let r = 0; r < recs; r++) buf.set(record(c * recs + r, size), r * size)
  return buf
}

const SHAPES = [[1, 100], [1, 1000], [256, 100], [256, 1000]]
const POOL = 32
let prev = Buffer.alloc(32)
const WAYS = {
  crc32: (b) => zlib.crc32(b),
  xxh32: (b) => xxh32e05(b, 0, b.length, 0),
  xxh64x2: (b) => xxh32e05(b, 0, b.length, 1) ^ xxh32e05(b, 0, b.length, 2),
  xxh32s: (b) => xxh32(b, 0, b.length, 0),
  sha256: (b) => crypto.hash('sha256', b, 'buffer')[0],
  sha256obj: (b) => crypto.createHash('sha256').update(b).digest()[0],
  sha256chain: (b) => { prev = crypto.createHash('sha256').update(prev).update(b).digest(); return prev[0] },
}
// check the hashes against known values before timing
if (crypto.hash('sha256', 'abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('sha256')
if (zlib.crc32('123456789') !== 0xcbf43926) throw new Error('crc32 check value')

const pick = process.argv.slice(2)
for (const [recs, size] of SHAPES) {
  const pool = Array.from({ length: POOL }, (_, c) => commit(c, recs, size))
  for (const [name, fn] of Object.entries(WAYS)) {
    if (pick.length && !pick.includes(name)) continue
    // calibrate: iterations for about 0.2 s
    let iters = 256, sink = 0
    for (;;) {
      const t0 = now(); for (let i = 0; i < iters; i++) sink ^= fn(pool[i & (POOL - 1)]) | 0
      const ns = Number(now() - t0)
      if (ns > 50e6) { iters = Math.max(256, Math.round(iters * 200e6 / ns)); break }
      iters *= 4
    }
    const per = []
    for (let r = 0; r < 7; r++) {
      const t0 = now(); for (let i = 0; i < iters; i++) sink ^= fn(pool[i & (POOL - 1)]) | 0
      per.push(Number(now() - t0) / iters)
    }
    const m = median(per), bytes = recs * size
    out({ exp: 'E-56', part: 'hash', way: name, recs, rec_bytes: size, commit_bytes: bytes, iters,
      ns_commit: +m.toFixed(1), ns_min: +Math.min(...per).toFixed(1), ns_max: +Math.max(...per).toFixed(1),
      ns_record: +(m / recs).toFixed(1), mb_s: +(bytes / m * 1e3).toFixed(0), sink: sink & 1, loadavg: loadavg() })
  }
}
