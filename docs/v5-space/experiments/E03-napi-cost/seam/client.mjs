// E-03 part 4 (SIDE): the Node side of the local seam. Starts the Rust daemon, takes batches of
// 100 B records from it by a Unix socket (streamed, and request/reply) and by a /dev/shm ring,
// and prints ns per record (wall), Node's CPU ns per record and the daemon's.
// node seam/client.mjs <daemon binary> <addon.node>
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const [daemon, addon] = process.argv.slice(2)
const A = require(addon)
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const REC = 100
const now = () => process.hrtime.bigint()
const out = (o) => console.log(JSON.stringify({ node: process.version, recBytes: REC, ...o }))
const dir = process.env.SEAM_DIR ?? tmpdir()
async function start(args) {
  const p = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  p.stderr.on('data', (d) => { err += d })
  await new Promise((res) => p.stdout.once('data', res))
  return { p, done: async () => { await once(p, 'exit'); return JSON.parse(err.trim().split('\n').pop()).daemonCpuUs } }
}
let acc = 0
async function udsStream(total, B) {
  const sock = `${dir}/e03-${process.pid}.sock`
  const d = await start(['uds-stream', sock, String(total), String(B), String(REC)])
  const s = net.connect(sock)
  await once(s, 'connect')
  const t0 = now(); const c0 = process.cpuUsage()
  let got = 0, pend = null
  await new Promise((resolve) => {
    s.on('data', (chunk) => {
      let b = pend ? Buffer.concat([pend, chunk]) : chunk
      let o = 0
      while (b.length - o >= 4) {
        const k = b.readUInt32LE(o)
        const need = 4 + k * REC
        if (b.length - o < need) break
        for (let j = 0; j < k; j++) acc += b.readUInt32LE(o + 4 + j * REC)
        got += k; o += need
      }
      pend = o < b.length ? b.subarray(o) : null
      if (got >= total) resolve()
    })
  })
  const wall = Number(now() - t0); const c = process.cpuUsage(c0)
  s.end()
  const dcpu = await d.done()
  return { wall: wall / total, cpu: (c.user + c.system) * 1000 / total, dcpu: dcpu * 1000 / total }
}
async function udsPingpong(rounds, B) {
  const sock = `${dir}/e03-${process.pid}.sock`
  const d = await start(['uds-pingpong', sock, String(rounds), String(B), String(REC)])
  const s = net.connect(sock); s.setNoDelay?.(true)
  await once(s, 'connect')
  const need = 4 + B * REC
  const one = Buffer.from([1])
  const t0 = now(); const c0 = process.cpuUsage()
  let r = 0, have = 0, parts = []
  await new Promise((resolve) => {
    s.on('data', (chunk) => {
      have += chunk.length; parts.push(chunk)
      if (have >= need) {
        const b = parts.length === 1 ? parts[0] : Buffer.concat(parts)
        for (let j = 0; j < B; j++) acc += b.readUInt32LE(4 + j * REC)
        have = 0; parts = []; r++
        if (r >= rounds) return resolve()
        s.write(one)
      }
    })
    s.write(one)
  })
  const wall = Number(now() - t0); const c = process.cpuUsage(c0)
  s.end()
  const dcpu = await d.done()
  const recs = rounds * B
  return { wall: wall / recs, cpu: (c.user + c.system) * 1000 / recs, dcpu: dcpu * 1000 / recs, rttUs: wall / rounds / 1000 }
}
const LSLOTS = 16384
const local = new Uint8Array(LSLOTS * REC), ldv = new DataView(local.buffer)
async function shm(total, B, bulk = false) {
  const SLOTS = 16384
  const file = `/dev/shm/e03-${process.pid}`
  const d = await start(['shm', file, String(SLOTS), String(REC), String(total), String(B)])
  const ab = A.mapShm(file, 64 + SLOTS * REC)
  const hdr = new Uint32Array(ab, 0, 16)
  const dv = new DataView(ab)
  const body = new Uint8Array(ab, 64)
  const t0 = now(); const c0 = process.cpuUsage()
  Atomics.store(hdr, 2, 1)
  let t = 0, got = 0
  while (got < total) {
    const h = Atomics.load(hdr, 0)
    if (h === t) continue
    const n = (h - t) >>> 0
    if (bulk) {
      const a = t % SLOTS, first = Math.min(n, SLOTS - a)
      local.set(body.subarray(a * REC, (a + first) * REC), 0)
      if (first < n) local.set(body.subarray(0, (n - first) * REC), first * REC)
      for (let j = 0; j < n; j++) acc += ldv.getUint32(j * REC, true)
    } else for (let x = t; x !== h; x = (x + 1) >>> 0) acc += dv.getUint32(64 + (x % SLOTS) * REC, true)
    got += n; t = h
    Atomics.store(hdr, 1, t)
  }
  const wall = Number(now() - t0); const c = process.cpuUsage(c0)
  Atomics.store(hdr, 2, 2)
  const dcpu = await d.done()
  ;(await import('node:fs')).unlinkSync(file)
  return { wall: wall / total, cpu: (c.user + c.system) * 1000 / total, dcpu: dcpu * 1000 / total }
}
async function measure(name, B, fn) {
  await fn()
  const rs = []
  for (let r = 0; r < REPS; r++) rs.push(await fn())
  const med = (k) => { const xs = rs.map((x) => x[k]).sort((a, b) => a - b); return { m: +xs[xs.length >> 1].toFixed(2), lo: +xs[0].toFixed(2), hi: +xs[xs.length - 1].toFixed(2) } }
  const w = med('wall')
  out({ measure: name, batch: B, ns: w.m, min: w.lo, max: w.hi, nodeCpuNsPerRec: med('cpu').m, daemonCpuNsPerRec: med('dcpu').m, ...(rs[0].rttUs ? { rttUs: med('rttUs').m } : {}), reps: REPS })
}
const total = quick ? 400_000 : 4_000_000
for (const B of [16, 256, 4096]) await measure(`uds stream, batch ${B}`, B, () => udsStream(total, B))
for (const B of [1, 16, 256]) await measure(`uds request/reply, batch ${B}`, B, () => udsPingpong(quick ? 2000 : 20000, B))
for (const B of [16, 256, 4096]) await measure(`shm ring, batch ${B}`, B, () => shm(quick ? 400_000 : 8_000_000, B))
for (const B of [256, 4096]) await measure(`shm ring (bulk copy out), batch ${B}`, B, () => shm(quick ? 400_000 : 8_000_000, B, true))
if (acc === 42) console.error('')
