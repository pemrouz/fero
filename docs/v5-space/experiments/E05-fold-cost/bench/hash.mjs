// E-05 part 5 (F-21): time to hash a replica's folded state, on the thread that holds the rows.
//   node --expose-gc hash.mjs <rows> [way...]      (no way named: all of them)
// The rows sit in a data source filled through fero's seam (the main-thread form, as in fero v4).
// Five ways to hash them:
//   xx-sum      each row's key and value encoded with fero's codec (Writer.str + Writer.value), hashed with
//               xxHash32 under two seeds (64 bits a row), summed over rows: order-free, so replicas whose
//               stores iterate in different orders agree
//   sha-sorted  keys sorted, rows encoded into one stream in key order, one SHA-256 over the stream (node:crypto)
//   md5-each    each row's bytes through node:crypto's one-shot md5, summed like xx-sum (native hash per row)
//   json-xx     as xx-sum, but each row encoded by V8's native JSON.stringify and TextEncoder.encodeInto
//               (replicas that fold the same log build rows with the same key order, so this is deterministic)
//   encode-only fero's codec encode of every row with no hash: how much of xx-sum is the encoding
// Each is timed 3 times in the process; the median is reported. The rows are hashed in place, no snapshot copy.
import crypto from 'node:crypto'
import { S, C, fill, gc, now, median, out } from './common.mjs'
import { xxh32 } from './xxh.mjs'

const N = +process.argv[2]
const p = S.proxy({})
fill(p, N)
gc()

const w = new C.Writer()
const enc = (k, row) => { w.len = 0; w.str(k); w.value(row); return w }

const ways = {
  'xx-sum': () => {
    let a = 0, b = 0
    p.each((k, row) => { const x = enc(k, row); a = (a + xxh32(x.buf, 0, x.len, 1)) >>> 0; b = (b + xxh32(x.buf, 0, x.len, 2)) >>> 0 })
    return a.toString(16) + b.toString(16)
  },
  'sha-sorted': () => {
    const keys = []
    p.each((k) => keys.push(k))
    keys.sort()
    const h = crypto.createHash('sha256')
    const rows = new Map()
    p.each((k, row) => rows.set(k, row))
    const big = new C.Writer()
    for (const k of keys) {
      big.str(k); big.value(rows.get(k))
      if (big.len > 1 << 20) { h.update(big.buf.subarray(0, big.len)); big.len = 0 }
    }
    h.update(big.buf.subarray(0, big.len))
    return h.digest('hex').slice(0, 16)
  },
  'md5-each': () => {
    let a = 0, b = 0
    p.each((k, row) => { const x = enc(k, row); const d = crypto.hash('md5', x.buf.subarray(0, x.len), 'buffer'); a = (a + d.readUInt32LE(0)) >>> 0; b = (b + d.readUInt32LE(4)) >>> 0 })
    return a.toString(16) + b.toString(16)
  },
  'json-xx': () => {
    let a = 0, b = 0
    const te = new TextEncoder(), buf = new Uint8Array(1 << 16)
    p.each((k, row) => { const r = te.encodeInto(k + '\u0000' + JSON.stringify(row), buf); a = (a + xxh32(buf, 0, r.written, 1)) >>> 0; b = (b + xxh32(buf, 0, r.written, 2)) >>> 0 })
    return a.toString(16) + b.toString(16)
  },
  'encode-only': () => {
    let n = 0
    p.each((k, row) => { n += enc(k, row).len })
    return String(n)
  },
}
const pick = process.argv.slice(3)
for (const [name, fn] of Object.entries(ways)) {
  if (pick.length && !pick.includes(name)) continue
  const ts = []
  let digest
  for (let r = 0; r < 3; r++) { gc(); const t0 = now(); digest = fn(); ts.push(Number(now() - t0) / 1e6) }
  out({ exp: 'E-05', part: 'hash', rows: N, way: name, thread: 'main', ms: +median(ts).toFixed(1), ms_min: +Math.min(...ts).toFixed(1), ms_max: +Math.max(...ts).toFixed(1), digest })
}
