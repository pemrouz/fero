// B2: what the per-batch constants cost in CPU, not only in time: one fsync, one pool hop, one small write, one
// event-loop turn, an idle 1 ms tick. E-02 saw 0.2-0.3 of a core per process "whatever the rate" (ticks, wakeups,
// one round of syscalls per batch) and E-01 timed fsyncs but never their CPU. This splits that fixed part.
// CPU is process.cpuUsage() (getrusage RUSAGE_SELF: every thread, so libuv's pool thread counts).
//   node sys.mjs <mode> [n]      modes: fsync-grow fsync-over a1 a2 write writev imm tick1 idle
// Prints one JSON line. Files go in $WORK/tmp (on the box's real disk, /dev/vda; run.sh sets WORK outside the repo).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] ?? 'fsync-over'
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = process.env.WORK ? path.join(process.env.WORK, 'tmp') : path.join(here, 'tmp')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `sys-${process.pid}.dat`)
const buf = Buffer.alloc(128, 7)
const hdr = Buffer.alloc(16, 1)
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) }
const cpu0 = () => ({ c: process.cpuUsage(), r: process.resourceUsage(), t: performance.now() })
const cpuEnd = (s, n) => {
  const c = process.cpuUsage(s.c), r = process.resourceUsage(), t = performance.now()
  return {
    n,
    wall_us_per_op: +((t - s.t) * 1e3 / n).toFixed(2),
    cpu_us_per_op: +((c.user + c.system) / n).toFixed(2),
    user_us_per_op: +(c.user / n).toFixed(2),
    sys_us_per_op: +(c.system / n).toFixed(2),
    vol_ctx_per_op: +((r.voluntaryContextSwitches - s.r.voluntaryContextSwitches) / n).toFixed(2),
    invol_ctx_per_op: +((r.involuntaryContextSwitches - s.r.involuntaryContextSwitches) / n).toFixed(3),
  }
}
const out = (o) => { console.log(JSON.stringify({ bench: 'sys', mode, node: process.version, ...o })); try { fs.unlinkSync(file) } catch {} }
const fdatasync = (fd) => new Promise((ok, no) => fs.fdatasync(fd, (e) => (e ? no(e) : ok())))
const write = (fd, b, pos) => new Promise((ok, no) => fs.write(fd, b, 0, b.length, pos, (e) => (e ? no(e) : ok())))
const fsync = (fd) => new Promise((ok, no) => fs.fsync(fd, (e) => (e ? no(e) : ok())))

if (mode === 'fsync-grow' || mode === 'fsync-over') {
  // one small write then one fdatasync, n times, synchronously on this thread: the disk's flush, and its CPU
  const n = Number(process.argv[3] ?? 1500)
  const fd = fs.openSync(file, 'w+')
  if (mode === 'fsync-over') { fs.writeSync(fd, Buffer.alloc(n * 128 + 4096)); fs.fsyncSync(fd) } // preallocated: no size change per flush
  for (let i = 0; i < 50; i++) { fs.writeSync(fd, buf, 0, 128, i * 128); fs.fdatasyncSync(fd) }
  const lat = []
  const s = cpu0()
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fs.writeSync(fd, buf, 0, 128, (50 + i) * 128)
    fs.fdatasyncSync(fd)
    lat.push((performance.now() - t) * 1e3)
  }
  const r = cpuEnd(s, n)
  fs.closeSync(fd)
  out({ ...r, p50_us: q(lat, 0.5), p99_us: q(lat, 0.99) })
} else if (mode === 'a1' || mode === 'a2') {
  // a1: writeSync + one async fdatasync (one pool hop, E-02's journal shape); a2: async write then async fsync
  // (two pool hops, v4's shell/runtime.ts:460-488). Sequential, one at a time, on a preallocated file.
  const n = Number(process.argv[3] ?? 1500)
  const fd = fs.openSync(file, 'w+')
  fs.writeSync(fd, Buffer.alloc((n + 50) * 128 + 4096)); fs.fsyncSync(fd)
  const one = async (i) => {
    if (mode === 'a1') { fs.writeSync(fd, buf, 0, 128, i * 128); await fdatasync(fd) }
    else { await write(fd, buf, i * 128); await fsync(fd) }
  }
  for (let i = 0; i < 50; i++) await one(i)
  const lat = []
  const s = cpu0()
  for (let i = 0; i < n; i++) { const t = performance.now(); await one(50 + i); lat.push((performance.now() - t) * 1e3) }
  const r = cpuEnd(s, n)
  fs.closeSync(fd)
  out({ ...r, p50_us: q(lat, 0.5), p99_us: q(lat, 0.99) })
} else if (mode === 'write' || mode === 'writev') {
  // one small write (or a writev of [16 B header, 128 B body]) to the page cache, no flush: the syscall alone
  const n = Number(process.argv[3] ?? 200000)
  const fd = fs.openSync(file, 'w')
  const go = (k) => { for (let i = 0; i < k; i++) mode === 'write' ? fs.writeSync(fd, buf) : fs.writevSync(fd, [hdr, buf]) }
  go(5000)
  const s = cpu0()
  go(n)
  const r = cpuEnd(s, n)
  fs.closeSync(fd)
  out(r)
} else if (mode === 'imm') {
  // one event-loop turn with nothing else to do (setImmediate chain)
  const n = Number(process.argv[3] ?? 200000)
  await new Promise((ok) => { let k = 0; const f = () => (++k < 5000 ? setImmediate(f) : ok()); f() })
  const s = cpu0()
  await new Promise((ok) => { let k = 0; const f = () => (++k < n ? setImmediate(f) : ok()); f() })
  out(cpuEnd(s, n))
} else if (mode === 'tick1' || mode === 'idle') {
  // an otherwise idle process for 3 s: with a 1 ms setInterval (E-02's batch tick; v4 cuts no tick, it sends at the
  // end of the turn) or with nothing but one timer that ends the run
  const ms = Number(process.argv[3] ?? 3000)
  let ticks = 0
  const iv = mode === 'tick1' ? setInterval(() => { ticks++ }, 1) : null
  await new Promise((ok) => setTimeout(ok, 200))
  const s = cpu0(); const t0 = ticks
  await new Promise((ok) => setTimeout(ok, ms))
  const r = cpuEnd(s, 1)
  if (iv) clearInterval(iv)
  const n = ticks - t0
  out({ seconds: ms / 1000, ticks: n, cpu_share_of_core: +(r.cpu_us_per_op / (ms * 1e3)).toFixed(4), cpu_us_per_tick: n ? +(r.cpu_us_per_op / n).toFixed(2) : null, vol_ctx_per_s: +(r.vol_ctx_per_op / (ms / 1000)).toFixed(0) })
} else throw new Error('unknown mode ' + mode)
