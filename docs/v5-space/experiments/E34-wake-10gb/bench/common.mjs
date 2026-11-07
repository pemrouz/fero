// E-34 shared helpers: fero's seam and codec from the scratch tree (tree.sh), the two row shapes, frame reading.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks'

export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the scratch tree built by tree.sh')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href)
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
export const UPDATE = 0, INSERT = 1, REMOVE = 2

// small: E-05's ~100 B row (125 B in fero's codec). big: the same plus a 1,900-character text field, about
// 2 KB a row in the codec (DEP-13's "2 KB a row", so 5e6 rows = 10 GB of snapshot).
const BODY = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(25).slice(0, 1900)
export const row = (shape, i, s) => {
  const r = { name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] }
  if (shape === 'big') r.body = BODY.slice(0, 1890) + String(s % 1e9).padStart(10, '0')
  return r
}
export const key = (i) => 'k' + i
export const laneFor = (p) => D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }

// read a file of fero frames in 64 MiB chunks, calling onFrame(u8) for each frame after checking its crc.
// A frame cut by a chunk edge is carried to the next read. The bytes passed are only valid during the call.
// LIMIT_ROWS (env) stops after the frames that hold that many rows (256 a frame): the 5 GB case is the first
// half of the 10 GB snapshot.
const MAXF = process.env.LIMIT_ROWS ? Math.ceil(+process.env.LIMIT_ROWS / 256) : Infinity
export const readFrames = (file, onFrame, CH = 64 << 20) => {
  const fd = fs.openSync(file, 'r')
  let buf = Buffer.allocUnsafeSlow(CH), have = 0, total = 0, frames = 0, readMs = 0, crcMs = 0
  for (;;) {
    const r0 = performance.now()
    const n = fs.readSync(fd, buf, have, buf.length - have, null)
    readMs += performance.now() - r0
    have += n
    let pos = 0
    while (have - pos >= C.HEADER) {
      const len = C.HEADER + buf.readUInt32LE(pos + 3)
      if (len > buf.length) { const b = Buffer.allocUnsafeSlow(len * 2); buf.copy(b, 0, pos, have); have -= pos; pos = 0; buf = b; break }
      if (have - pos < len) break
      const u8 = buf.subarray(pos, pos + len)
      const c0 = performance.now()
      if (C.crcFrame(u8, len) !== buf.readUInt32LE(pos + 7)) throw new Error('crc mismatch')
      crcMs += performance.now() - c0
      onFrame(u8)
      frames++
      pos += len
      total += len
      if (frames >= MAXF) { fs.closeSync(fd); return { bytes: total, frames, read_s: +(readMs / 1000).toFixed(2), crc_s: +(crcMs / 1000).toFixed(2) } }
    }
    if (pos > 0) { buf.copy(buf, 0, pos, have); have -= pos }
    if (n === 0) break
  }
  fs.closeSync(fd)
  if (have !== 0) throw new Error('trailing bytes: ' + have)
  return { bytes: total, frames, read_s: +(readMs / 1000).toFixed(2), crc_s: +(crcMs / 1000).toFixed(2) }
}

// GC pauses as perf_hooks reports them (entry.duration, ms, on this thread). The observer's callback runs only
// when the thread is idle, so entries are sorted into phases by their own startTime, never by when they arrive:
// w.mark(name) starts a phase at performance.now(); a GC belongs to the last phase begun before it started.
export const gcWatch = () => {
  const KIND = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb' } // perf_hooks.constants NODE_PERFORMANCE_GC_*
  const w = { marks: [['load', 0]], list: [] }
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.list.push({ start: e.startTime, ms: e.duration, kind: KIND[e.detail?.kind] ?? String(e.detail?.kind) }) })
  obs.observe({ entryTypes: ['gc'] })
  w.mark = (name) => w.marks.push([name, performance.now()])
  w.phaseOf = (t) => { let ph = w.marks[0][0]; for (const [n, at] of w.marks) if (t >= at) ph = n; return ph }
  w.stop = () => { const rest = obs.takeRecords?.() ?? []; for (const e of rest) w.list.push({ start: e.startTime, ms: e.duration, kind: KIND[e.detail?.kind] ?? String(e.detail?.kind) }); obs.disconnect() }
  return w
}
export const stats = (xs) => {
  if (xs.length === 0) return { n: 0, max: 0, p99: 0, p999: 0, sum: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  return { n: s.length, max: +s[s.length - 1].toFixed(1), p99: +q(0.99).toFixed(1), p999: +q(0.999).toFixed(1), sum: +s.reduce((a, b) => a + b, 0).toFixed(0) }
}
export const gcSummary = (w, phase) => {
  const xs = w.list.filter((e) => w.phaseOf(e.start) === phase)
  const by = (k) => stats(xs.filter((e) => e.kind === k).map((e) => e.ms))
  return { all: stats(xs.map((e) => e.ms)), major: by('major'), minor: by('minor') }
}
export const eld = () => { const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); return h }
export const eldSummary = (h) => ({ p99: +(h.percentile(99) / 1e6).toFixed(1), p999: +(h.percentile(99.9) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) })
export const mb = (b) => Math.round(b / 2 ** 20)
export const out = (o) => console.log(JSON.stringify(o))
