// B5: a journal thread of its own. The kernel thread hands a 128 B record to a dedicated thread through a
// SharedArrayBuffer and Atomics.notify; that thread does writeSync + fdatasyncSync and answers through the same
// buffer (the kernel waits with Atomics.waitAsync, so its event loop keeps running). Against sys.mjs's 'fsync-over'
// (the flush done in place, blocking the caller) and 'a1' (writeSync + fs.fdatasync on libuv's pool).
//   node jthread.mjs [n]      prints one JSON line. The file is preallocated, as in fsync-over and a1.
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const n = Number(process.argv[2] ?? 1500)
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = process.env.WORK ? path.join(process.env.WORK, 'tmp') : path.join(here, 'tmp')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `jt-${process.pid}.dat`)
const fd = fs.openSync(file, 'w+')
fs.writeSync(fd, Buffer.alloc((n + 100) * 128 + 4096)); fs.fsyncSync(fd)
// [0] = requests posted, [1] = requests done; then 128 B of record
const sab = new SharedArrayBuffer(8 + 128)
const ctl = new Int32Array(sab, 0, 2)
const w = new Worker(`
const { workerData } = require('node:worker_threads'); const fs = require('node:fs')
const ctl = new Int32Array(workerData.sab, 0, 2), rec = new Uint8Array(workerData.sab, 8, 128)
let seen = 0
for (;;) {
  Atomics.wait(ctl, 0, seen)
  const want = Atomics.load(ctl, 0)
  if (want < 0) break
  while (seen < want) { fs.writeSync(workerData.fd, rec, 0, 128, seen * 128); seen++ }
  fs.fdatasyncSync(workerData.fd)
  Atomics.store(ctl, 1, seen); Atomics.notify(ctl, 1)
}`, { eval: true, workerData: { sab, fd } })
const one = async (i) => {
  Atomics.store(ctl, 0, i + 1); Atomics.notify(ctl, 0)
  for (;;) {
    if (Atomics.load(ctl, 1) >= i + 1) return
    const r = Atomics.waitAsync(ctl, 1, Atomics.load(ctl, 1))
    if (r.async) await r.value
  }
}
let i = 0
for (; i < 50; i++) await one(i)
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(p * s.length)].toFixed(1) }
const lat = []
const c0 = process.cpuUsage(), r0 = process.resourceUsage(), t0 = performance.now()
for (let k = 0; k < n; k++, i++) { const t = performance.now(); await one(i); lat.push((performance.now() - t) * 1e3) }
const c = process.cpuUsage(c0), r = process.resourceUsage(), t1 = performance.now()
Atomics.store(ctl, 0, -1); Atomics.notify(ctl, 0)
await w.terminate()
fs.closeSync(fd); fs.unlinkSync(file)
console.log(JSON.stringify({
  bench: 'sys', mode: 'jthread', node: process.version, n,
  wall_us_per_op: +((t1 - t0) * 1e3 / n).toFixed(2), cpu_us_per_op: +((c.user + c.system) / n).toFixed(2),
  user_us_per_op: +(c.user / n).toFixed(2), sys_us_per_op: +(c.system / n).toFixed(2),
  vol_ctx_per_op: +((r.voluntaryContextSwitches - r0.voluntaryContextSwitches) / n).toFixed(2),
  p50_us: q(lat, 0.5), p99_us: q(lat, 0.99),
}))
