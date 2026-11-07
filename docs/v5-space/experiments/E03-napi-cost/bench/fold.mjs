// E-03 part 2 (X3): a batch of 256 records handed from a Rust kernel to data's JS fold.
// node --experimental-strip-types bench/fold.mjs <addon.node>
// The records are fero v4's wire records (kernel/codec.ts), the fold is data's hot lane (the
// same call fero v4's api/substrate.ts makes). Measures, in ns per record at batch 256:
//   lane          data's lane on ready JS records (the fold alone)
//   decode+lane   decode v4 frame bytes JS already holds, then the lane: what a TS kernel's follower does
//   pull          JS asks Rust for the next frame (copied into a JS scratch Buffer), decode, lane
//   push          Rust calls a JS function per frame with the scratch Buffer, decode, lane
//   objects       Rust builds the record objects itself through napi, then the lane
//   pull-only / push-only / objects-only: the same crossings without the fold
// The crossing's cost is the difference against decode+lane (or against lane, for objects).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const A = require(process.argv[2])
const DATA = process.env.DATA ?? '/home/user/pemrouz/data'
const FERO = process.env.FERO ?? '/home/user/fero'
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const C = await import(pathToFileURL(FERO + '/kernel/codec.ts').href)
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const B = 256, ROWS = 10_000, NB = 8
const now = () => process.hrtime.bigint()
const out = (o) => console.log(JSON.stringify({ node: process.version, batch: B, rows: ROWS, ...o }))

const makeBatch = (salt) => {
  const recs = []
  for (let i = 0; i < B; i++) {
    const k = 'u' + ((i * 7 + salt) % ROWS)
    if (i % 2 === 0) recs.push({ type: 0, key: [k, 'n'], value: i + salt })
    else recs.push({ type: 0, key: [k], value: { name: 'user', n: i + salt, tags: ['a', 'b'] } })
  }
  return recs
}
const init = {}
for (let i = 0; i < ROWS; i++) init['u' + i] = { name: 'user', n: i, tags: ['a', 'b'] }
const src = D.$(init)
const lane = D.lane(src, { onReject: (r) => { throw r.error } })
const batches = Array.from({ length: NB }, (_, s) => makeBatch(s + 1))
const frames = batches.map((b) => C.encodeFrame(b))
const frameBytes = frames.reduce((a, f) => a + f.length, 0) / NB
A.framesLoad(frames.map((f) => Buffer.from(f)))
const scratch = Buffer.alloc(1 << 16)
const decode = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }

// sanity: decoded records equal the originals, and fold the same
{
  const d = decode(frames[0])
  if (JSON.stringify(d) !== JSON.stringify(batches[0])) throw new Error('decode mismatch: ' + JSON.stringify(d[1]) + ' vs ' + JSON.stringify(batches[0][1]))
  const o = A.buildRecords(B, ROWS, 1)
  if (JSON.stringify(o) !== JSON.stringify(batches[0])) throw new Error('objects mismatch: ' + JSON.stringify(o[1]))
}

let sink = 0
function measure(name, iters, fn) {
  fn(Math.max(1, iters >> 3))
  const xs = []
  for (let r = 0; r < REPS; r++) { const t0 = now(); fn(iters); xs.push(Number(now() - t0) / (iters * B)) }
  xs.sort((a, b) => a - b)
  out({ measure: name, ns: +xs[xs.length >> 1].toFixed(2), min: +xs[0].toFixed(2), max: +xs[xs.length - 1].toFixed(2), reps: REPS, frameBytes })
}
const IT = quick ? 500 : 4_000
measure('lane', IT, (n) => { for (let i = 0; i < n; i++) sink += lane(batches[i % NB]).applied })
measure('decode', IT, (n) => { for (let i = 0; i < n; i++) sink += decode(frames[i % NB]).length })
measure('decode+lane', IT, (n) => { for (let i = 0; i < n; i++) sink += lane(decode(frames[i % NB])).applied })
measure('pull-only', IT * 4, (n) => { for (let i = 0; i < n; i++) sink += A.framePull(i % NB, scratch) })
measure('pull+decode+lane', IT, (n) => { for (let i = 0; i < n; i++) { const len = A.framePull(i % NB, scratch); sink += lane(decode(scratch.subarray(0, len))).applied } })
measure('push-only', IT * 4, (n) => A.framePush((len) => { sink += len }, scratch, n))
measure('push+decode+lane', IT, (n) => A.framePush((len) => { sink += lane(decode(scratch.subarray(0, len))).applied }, scratch, n))
measure('objects-only', IT, (n) => { for (let i = 0; i < n; i++) sink += A.buildRecords(B, ROWS, (i % NB) + 1).length })
measure('objects+lane', IT, (n) => { for (let i = 0; i < n; i++) sink += lane(A.buildRecords(B, ROWS, (i % NB) + 1)).applied })
if (sink === 42) console.error('')
