// B4: what a server spends to answer one `state`-mode SUB of one room (a prefix partition: rows `room<r>/<i>`), and the
// first picture shared by many subscribers. Rows are E-05's small rows, folded into data through fero's seam.
//   node --expose-gc snapshot-serve.mjs <rows>          rooms of 100 rows each
// Ways, per SUB:
//   scan      walk every row with data's no-copy each() and keep the room's rows by prefix, then encode them as one
//             frame of insert records (the same work as fero v4's rowsPartial, api/fold.ts:85-95: one walk of everything
//             held, even for one partition)
//   index     a partition → row keys index kept beside the fold (in memory), then read the 100 rows and encode them
//   shared    the index way, encoded once and handed to S subscribers at the same position: the encode divided by S
//   encode    the encode of the 100 rows alone (in the two ways above)
import { S, D, C, row, nsPer, out, laneFor, decodeFrame, gc } from './common.mjs'
const N = +process.argv[2], PER = 100, ROOMS = N / PER
const p = S.proxy({})
const lane = laneFor(p)
const rk = (i) => 'room' + (i % ROOMS) + '/' + i
for (let i = 0; i < N; i += 256) {
  const recs = []
  for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: 1, key: [], at: rk(j), value: row(j, 0) })
  lane(decodeFrame(C.encodeFrame(recs)))
}
const VALUE = Symbol.for('data.v4.value')
const index = new Map()
for (let i = 0; i < N; i++) { const r = 'room' + (i % ROOMS); let s = index.get(r); if (!s) index.set(r, (s = [])); s.push(rk(i)) }
gc()
let sink = 0, q = 0
const room = () => 'room' + ((q++ * 7919) % ROOMS)
const encodeRows = (pairs) => C.encodeFrame(pairs.map(([k, v]) => ({ type: 1, key: [], at: k, value: v }))).length
const scan = nsPer((c) => { for (let j = 0; j < c; j++) { const pre = room() + '/'; const got = []; p.each((k, v) => { if (k.startsWith(pre)) got.push([k, v]) }); sink += encodeRows(got) } }, N >= 1e6 ? 5 : 50, 3)
const idx = nsPer((c) => { for (let j = 0; j < c; j++) { const ks = index.get(room()); const got = ks.map((k) => [k, p.get(k)[VALUE]]); sink += encodeRows(got) } }, 2000)
const enc = nsPer((c) => { const ks = index.get('room1'); const got = ks.map((k) => [k, p.get(k)[VALUE]]); for (let j = 0; j < c; j++) sink += encodeRows(got) }, 2000)
out({ bench: 'snapshot-serve', rows: N, rowsPerRoom: PER, us: { scan: +(scan / 1e3).toFixed(1), index: +(idx / 1e3).toFixed(1), encode: +(enc / 1e3).toFixed(1), 'shared, 100 subscribers': +(idx / 1e3 / 100).toFixed(2), 'shared, 1000 subscribers': +(idx / 1e3 / 1000).toFixed(3) }, sink: sink > 0 })
