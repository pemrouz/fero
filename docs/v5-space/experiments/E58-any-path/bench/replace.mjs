// E-58 timing T1: a room replaced at depth 2 (what `room.set(rows)` would cost if the leader expanded it into one batch),
// against the same rows written one by one, on data's real engine. One room of R rows { text, at }; a raw sink on the
// room (a link on the partition) and data's per-path reader on one row's field. Prints one JSON line:
// µs per replace (median of 15 rounds, the two ways interleaved round by round) and the deliveries each way.
//   node replace.mjs <rows>
import { D, SourceNode } from '../../E55-lens-prototype/proto/lens.mjs'

const R = Number(process.argv[2] ?? 100)
const rt = new D.Runtime()
const keys = Array.from({ length: R }, (_, i) => 'm' + i)
const src = new SourceNode(rt, Object.fromEntries(keys.map((k) => [k, { text: 'x', at: 0 }])))
let sinkCalls = 0, fieldCalls = 0
const h1 = src.connect({ wantsOrder: false, origin: null, apply: () => { sinkCalls++ } })
const h2 = D.handleFor(src).get('m0').get('at').connect({}, () => { fieldCalls++ }, { clone: false })
let gen = 0
const ways = {
  batch: () => { gen++; rt.batch(() => { for (const k of keys) src.write(k, [], { text: 'x', at: gen }) }) },
  onebyone: () => { gen++; for (const k of keys) src.write(k, [], { text: 'x', at: gen }) },
}
const reps = Math.max(5, Math.round(200000 / R))
const out = { exp: 'E-58', bench: 'replace', rows: R, node: process.version, reps }
for (const w of Object.keys(ways)) for (let i = 0; i < reps; i++) ways[w]() // warm both
// the two ways interleaved round by round
const xs = { batch: [], onebyone: [] }, calls = { batch: [0, 0], onebyone: [0, 0] }
for (let round = 0; round < 15; round++) for (const w of Object.keys(ways)) {
  globalThis.gc?.()
  sinkCalls = 0; fieldCalls = 0
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < reps; i++) ways[w]()
  xs[w].push(Number(process.hrtime.bigint() - t0) / 1e3 / reps)
  calls[w][0] += sinkCalls; calls[w][1] += fieldCalls
}
for (const w of Object.keys(ways)) {
  const v = xs[w].sort((a, b) => a - b)
  out[w] = { usPerReplace: +v[7].toFixed(3), usLo: +v[0].toFixed(3), usHi: +v[14].toFixed(3), nsPerRow: Math.round((v[7] * 1000) / R), sinkCallsPerReplace: calls[w][0] / (15 * reps), fieldCallsPerReplace: calls[w][1] / (15 * reps) }
}
out.ratio = +(out.onebyone.usPerReplace / out.batch.usPerReplace).toFixed(2)
h1.dispose(); h2.dispose()
console.log(JSON.stringify(out))
