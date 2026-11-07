// E-03 part 1: the napi seam micro-benchmarks. One JSON line per measure on stdout.
// node bench/napi.mjs <addon.node>
// Each measure runs `reps` times after a warm-up; the line carries the median and min/max of
// those reps (ns per call or per record). run.sh runs this file 3 times under the timing lock.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const A = require(process.argv[2])
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const out = (o) => console.log(JSON.stringify({ node: process.version, ...o }))
const now = () => process.hrtime.bigint()

function measure(name, unitsPerIter, iters, fn, extra = {}) {
  fn(Math.max(1, iters >> 3)) // warm-up
  const xs = []
  for (let r = 0; r < REPS; r++) {
    const t0 = now(); fn(iters); const dt = Number(now() - t0)
    xs.push(dt / (iters * unitsPerIter))
  }
  xs.sort((a, b) => a - b)
  out({ measure: name, ns: +xs[xs.length >> 1].toFixed(2), min: +xs[0].toFixed(2), max: +xs[xs.length - 1].toFixed(2), reps: REPS, ...extra })
}
const N = quick ? 200_000 : 2_000_000

// baseline: a plain JS function call the JIT cannot inline away entirely
let sink = 0
const jsAdd1 = new Function('x', 'return (x + 1) | 0')
measure('js-call-baseline', 1, N, (n) => { for (let i = 0; i < n; i++) sink += jsAdd1(i) })

// 1. empty calls
measure('napi-empty-call', 1, N, (n) => { for (let i = 0; i < n; i++) A.noop() })
measure('napi-call-u32', 1, N, (n) => { for (let i = 0; i < n; i++) sink += A.add1(i) })

// 2. a 4 KB Buffer
const b4 = Buffer.alloc(4096, 7)
measure('buf4k-in-owned(napi-rs Buffer)', 1, N, (n) => { for (let i = 0; i < n; i++) sink += A.bufInOwned(b4) })
measure('buf4k-in-slice(&[u8])', 1, N, (n) => { for (let i = 0; i < n; i++) sink += A.bufInSlice(b4) })
measure('buf4k-fill(JS-owned, Rust writes)', 1, N, (n) => { for (let i = 0; i < n; i++) sink += A.bufFill(b4, i) })
measure('buf4k-out-new(Vec->external Buffer)', 1, N >> 2, (n) => { for (let i = 0; i < n; i++) sink += A.bufOutNew(i)[0] })
measure('buf4k-out-copy(create_buffer_copy)', 1, N >> 2, (n) => { for (let i = 0; i < n; i++) sink += A.bufOutCopy(i)[0] })

// 3. Rust calls JS once per record, directly (inside one napi call)
let acc = 0
const cb = (i) => { acc += i }
measure('rust->js per record, napi-rs Function::call', 1, N, (n) => A.callEach(cb, n))
measure('rust->js per record, raw napi_call_function', 1, N, (n) => A.callEachRaw(cb, n))

// 3b. Rust calls JS once per batch with a scratch buffer of 100 B records; JS reads each record's first u32
const REC = 100
for (const B of [1, 16, 256, 4096]) {
  const scratch = Buffer.alloc(B * REC)
  const dv = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength)
  const onBatch = (k) => { for (let j = 0; j < k; j++) acc += dv.getUint32(j * REC, true) }
  const total = quick ? 400_000 : 4_000_000
  measure(`rust->js direct, batch ${B}`, 1, total, (n) => A.callBatches(onBatch, scratch, n, B, REC), { batch: B, recBytes: REC })
}

// 4. threadsafe function from a Rust thread: one call per batch, a copied Buffer per batch
async function tsfnRun(total, B) {
  return new Promise((resolve) => {
    let got = 0
    const t0 = now()
    const cpu0 = process.cpuUsage()
    A.tsfnStart((buf, k) => {
      for (let j = 0; j < k; j++) acc += buf.readUInt32LE(j * REC)
      got += k
      if (got >= total) { const cpu = process.cpuUsage(cpu0); resolve({ wall: Number(now() - t0), cpuUs: cpu.user + cpu.system }) }
    }, total, B, REC, 1024)
  })
}
for (const B of [1, 16, 256, 4096]) {
  const total = quick ? (B === 1 ? 100_000 : 400_000) : (B === 1 ? 1_000_000 : 4_000_000)
  await tsfnRun(total >> 3, B)
  const xs = [], cs = []
  for (let r = 0; r < REPS; r++) { const { wall, cpuUs } = await tsfnRun(total, B); xs.push(wall / total); cs.push(cpuUs * 1000 / total) }
  xs.sort((a, b) => a - b); cs.sort((a, b) => a - b)
  out({ measure: `rust thread->js tsfn, batch ${B}`, ns: +xs[xs.length >> 1].toFixed(2), min: +xs[0].toFixed(2), max: +xs[xs.length - 1].toFixed(2), processCpuNsPerRec: +cs[cs.length >> 1].toFixed(2), reps: REPS, batch: B, recBytes: REC, note: 'wall ns per record, producer thread and JS run in parallel' })
}

// 5. a SharedArrayBuffer ring, Rust thread -> JS, JS spins on head
// bulk = false: read one u32 of each record in place; bulk = true: first copy each published span
// out of the ring into a private buffer in one go (as a consumer that decodes off-ring would), then read it
const SLOTS = 16384
const local = new Uint8Array(SLOTS * REC), ldv = new DataView(local.buffer)
function ringRun(total, B, bulk = false) {
  const sab = new SharedArrayBuffer(64 + SLOTS * REC)
  const hdr = new Uint32Array(sab, 0, 16)
  const dv = new DataView(sab)
  const body = new Uint8Array(sab, 64)
  A.ringStart(new Uint8Array(sab), SLOTS, REC, total, B)
  const t0 = now()
  const cpu0 = process.cpuUsage()
  let t = 0, got = 0, spins = 0
  while (got < total) {
    const h = Atomics.load(hdr, 0)
    if (h === t) { spins++; continue }
    const n = (h - t) >>> 0
    if (bulk) {
      const a = t % SLOTS, first = Math.min(n, SLOTS - a)
      local.set(body.subarray(a * REC, (a + first) * REC), 0)
      if (first < n) local.set(body.subarray(0, (n - first) * REC), first * REC)
      for (let j = 0; j < n; j++) acc += ldv.getUint32(j * REC, true)
    } else for (let x = t; x !== h; x = (x + 1) >>> 0) acc += dv.getUint32(64 + (x % SLOTS) * REC, true)
    got += n
    t = h
    Atomics.store(hdr, 1, t)
  }
  const cpu = process.cpuUsage(cpu0)
  return { wall: Number(now() - t0), cpuUs: cpu.user + cpu.system, spins }
}
for (const [B, bulk] of [[1, false], [16, false], [256, false], [4096, false], [256, true], [4096, true]]) {
  const total = quick ? 400_000 : 8_000_000
  ringRun(total >> 3, B, bulk)
  const xs = [], cs = []
  for (let r = 0; r < REPS; r++) { const { wall, cpuUs } = ringRun(total, B, bulk); xs.push(wall / total); cs.push(cpuUs * 1000 / total) }
  xs.sort((a, b) => a - b); cs.sort((a, b) => a - b)
  out({ measure: `rust thread->js SAB ring${bulk ? ' (bulk copy out)' : ''}, batch ${B}`, ns: +xs[xs.length >> 1].toFixed(2), min: +xs[0].toFixed(2), max: +xs[xs.length - 1].toFixed(2), processCpuNsPerRec: +cs[cs.length >> 1].toFixed(2), reps: REPS, batch: B, recBytes: REC, note: 'wall ns per record; JS spins (both threads busy)' })
}
if (sink === 42 && acc === 42) console.error('')
