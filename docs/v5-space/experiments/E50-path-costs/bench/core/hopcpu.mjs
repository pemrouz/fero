// B6: the CPU of one main -> worker -> main round trip, one message at a time (a write when the box is not busy):
// postMessage with a transferred 64 B ArrayBuffer each way. The write walker timed the same hop's latency
// (write-bench/hop.mjs); E-07 timed its busy time under load, 32 batches in flight. This counts the whole process's
// CPU per round trip, the wake-ups included.
//   node hopcpu.mjs [n]       prints one JSON line
import { Worker } from 'node:worker_threads'
const n = Number(process.argv[2] ?? 20000)
const w = new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', (ab) => parentPort.postMessage(ab, [ab]))`, { eval: true })
let ab = new ArrayBuffer(64)
const rt = () => new Promise((ok) => { w.once('message', (b) => { ab = b; ok() }); w.postMessage(ab, [ab]) })
for (let i = 0; i < 2000; i++) await rt()
const c0 = process.cpuUsage(), r0 = process.resourceUsage(), t0 = performance.now()
for (let i = 0; i < n; i++) await rt()
const c = process.cpuUsage(c0), r = process.resourceUsage(), t1 = performance.now()
await w.terminate()
console.log(JSON.stringify({
  bench: 'sys', mode: 'hop', node: process.version, n,
  wall_us_per_op: +((t1 - t0) * 1e3 / n).toFixed(2), cpu_us_per_op: +((c.user + c.system) / n).toFixed(2),
  user_us_per_op: +(c.user / n).toFixed(2), sys_us_per_op: +(c.system / n).toFixed(2),
  vol_ctx_per_op: +((r.voluntaryContextSwitches - r0.voluntaryContextSwitches) / n).toFixed(2),
}))
