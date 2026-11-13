// hop.mjs — what one thread hop costs in LATENCY when the box is idle (one message in flight at a time).
// E-07 measured the crossing's throughput cost per record under load; this measures the wait a lone write pays.
//   turn     : one event-loop turn on the same thread (setImmediate), the floor for any async step
//   worker   : main -> worker -> main, a 64-byte ArrayBuffer transferred each way (postMessage + transfer list)
//   pool     : one libuv pool hop: fs.write of 100 B to a tmpfs file (async: main -> pool thread -> main)
//   poolSync : the same write done synchronously on the calling thread (no hop)
// Prints p50 / p90 / p99 in microseconds of n sequential round trips.
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const N = 20000
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
const report = (name, a) => { a.sort((x, y) => x - y); return { name, n: a.length, p50: +pct(a, 0.5).toFixed(1), p90: +pct(a, 0.9).toFixed(1), p99: +pct(a, 0.99).toFixed(1) } }
const rows = []

{ // turn
  const a = []
  await new Promise((done) => {
    let i = 0, t = 0
    const step = () => { if (i > 0) a.push((performance.now() - t) * 1e3); if (i++ === N) return done(); t = performance.now(); setImmediate(step) }
    step()
  })
  rows.push(report('turn', a))
}
{ // worker ping-pong
  const w = new Worker(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', (ab) => parentPort.postMessage(ab, [ab]))`, { eval: true })
  const a = []
  await new Promise((done) => {
    let i = 0, t = 0
    w.on('message', (ab) => { a.push((performance.now() - t) * 1e3); if (++i === N) return done(); t = performance.now(); w.postMessage(ab, [ab]) })
    // warm-up message first
    const ab = new ArrayBuffer(64); t = performance.now(); w.postMessage(ab, [ab])
  })
  a.splice(0, 100)
  rows.push(report('worker-rtt', a))
  await w.terminate()
}
const dir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()
const file = path.join(dir, 'hop-' + process.pid)
const fd = fs.openSync(file, 'w')
const buf = Buffer.alloc(100, 7)
{ // pool
  const a = []
  await new Promise((done) => {
    let i = 0, t = 0
    const step = () => { t = performance.now(); fs.write(fd, buf, 0, 100, 0, () => { a.push((performance.now() - t) * 1e3); if (++i === N) return done(); step() }) }
    step()
  })
  a.splice(0, 100)
  rows.push(report('pool-write', a))
}
{ // sync
  const a = []
  for (let i = 0; i < N; i++) { const t = performance.now(); fs.writeSync(fd, buf, 0, 100, 0); a.push((performance.now() - t) * 1e3) }
  rows.push(report('sync-write', a))
}
fs.closeSync(fd); fs.unlinkSync(file)
console.log(JSON.stringify({ bench: 'hop', node: process.version, unit: 'us', dir, rows }))
