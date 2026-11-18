// Claim 6, follow-up: connect.mjs times each first picture right after a full collection, and every room, even a
// one-row room, came out near 0.15 ms. Is that the picture, or the first work after a collection? 200 first
// pictures of different 100-row rooms (depth 2, 100,000 rows), each a here()-less tap that walks c.changes, then
// closed; with and without a full collection right before; and its parts: data's connect on the partition's
// source, the selection made and dropped.
//   node --expose-gc --experimental-strip-types firstprobe.mjs
import { fero } from '../proto/lens.mjs'
import { out, r1, q } from './common.mjs'

const seed = {}
for (let i = 0; i < 100000; i++) { const p = 'p' + Math.floor(i / 100); (seed[p] ??= {})['m' + i] = { n: i } }
const g = fero('g', { depth: 2, data: seed }); g.eng.promote()
const rooms = Object.keys(seed)
let got = 0
const time = (salt, collect, fn) => {
  const xs = []
  for (let r = 0; r < 200; r++) {
    const room = rooms[(r * 7919 + salt) % rooms.length]
    if (collect) globalThis.gc()
    const t0 = process.hrtime.bigint()
    fn(room)
    xs.push(Number(process.hrtime.bigint() - t0) / 1000)
  }
  return { p50: r1(q(xs, 0.5)), p90: r1(q(xs, 0.9)) }
}
const tap = (room) => { const l = g.data[room].tap((c) => { for (const ch of c.changes) got++ }); l.close() }
const res = {
  'tap + close, no collection before': time(17, false, tap),
  'tap + close, a full collection before': time(13, true, tap),
  'data connect + dispose, a full collection before': time(19, true, (room) => g.eng.parts.get(room).connect({ wantsOrder: false, origin: null, apply() {} }).dispose()),
  'data connect + dispose, no collection before': time(23, false, (room) => g.eng.parts.get(room).connect({ wantsOrder: false, origin: null, apply() {} }).dispose()),
}
out({ claim: 6, bench: 'first-probe', rows: 100000, roomRows: 100, us: res, picturesWalked: got })
