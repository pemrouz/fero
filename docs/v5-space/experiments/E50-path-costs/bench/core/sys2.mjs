// B10: what makes v4's flush dear: the second pool hop, or fsync against fdatasync? Moved here from the skeptic's
// check of PATHS.md (its sys2.mjs). One 128 B write and one flush per operation, one at a time, on a preallocated
// file (as core/sys.mjs's 'fsync-over'), CPU of the whole process and time per operation. Modes:
//   inplace   writeSync + fdatasyncSync          (no hop)
//   inplacef  writeSync + fsyncSync              (no hop, fsync)
//   a1        writeSync + async fdatasync        (one pool hop)
//   a1f       writeSync + async fsync            (one pool hop, fsync)
//   a2d       async write + async fdatasync      (two pool hops)
//   a2        async write + async fsync          (two pool hops: v4's way, shell/runtime.ts:460-488)
// Usage: node sys2.mjs <mode> [ops]     prints one JSON line. Files go in $WORK/tmp (outside the repo).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const n = Number(process.argv[3] ?? 1500)
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = process.env.WORK ? path.join(process.env.WORK, 'tmp') : path.join(here, 'tmp')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `s2-${process.pid}.dat`)
const buf = Buffer.alloc(128, 7)
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) }
const P = (f, ...a) => new Promise((ok, no) => f(...a, (e) => (e ? no(e) : ok())))
const fd = fs.openSync(file, 'w+')
fs.writeSync(fd, Buffer.alloc((n + 50) * 128 + 4096)); fs.fsyncSync(fd)
const one = async (i) => {
  const pos = i * 128
  if (mode === 'inplace') { fs.writeSync(fd, buf, 0, 128, pos); fs.fdatasyncSync(fd) }
  else if (mode === 'inplacef') { fs.writeSync(fd, buf, 0, 128, pos); fs.fsyncSync(fd) }
  else if (mode === 'a1') { fs.writeSync(fd, buf, 0, 128, pos); await P(fs.fdatasync, fd) }
  else if (mode === 'a1f') { fs.writeSync(fd, buf, 0, 128, pos); await P(fs.fsync, fd) }
  else if (mode === 'a2') { await P(fs.write, fd, buf, 0, 128, pos); await P(fs.fsync, fd) }
  else if (mode === 'a2d') { await P(fs.write, fd, buf, 0, 128, pos); await P(fs.fdatasync, fd) }
  else throw new Error('unknown mode ' + mode)
}
for (let i = 0; i < 50; i++) await one(i)
const lat = []
const c0 = process.cpuUsage()
for (let i = 0; i < n; i++) { const t = performance.now(); await one(50 + i); lat.push((performance.now() - t) * 1e3) }
const c = process.cpuUsage(c0)
fs.closeSync(fd); fs.unlinkSync(file)
console.log(JSON.stringify({ bench: 'sys2', mode, n, cpu_us: +((c.user + c.system) / n).toFixed(1), p50_us: q(lat, 0.5), p99_us: q(lat, 0.99) }))
