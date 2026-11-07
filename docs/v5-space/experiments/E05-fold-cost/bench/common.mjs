// E-05 shared helpers: load fero's seam from the scratch tree, make rows and records, time things.
// The tree (tree.sh) holds fero/api/substrate.ts with data linked beside it, so `../../data/api/index.ts`
// resolves exactly as it does in fero v4.
import { pathToFileURL } from 'node:url'
import v8 from 'node:v8'

export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the scratch tree built by tree.sh')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href) // fero's seam
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href) // the same module instance the seam imports
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href) // fero's record codec (the log format)

// fero's record types (kernel/env.ts REC)
export const UPDATE = 0, INSERT = 1, REMOVE = 2

// A "small row": about 100 bytes as JSON (E-05's 100 B row sets). i is the row number, s a stamp.
export const row = (i, s) => ({
  name: 'user-' + i,
  email: 'u' + i + '@example.com',
  region: 'r' + (i % 16),
  room: i % 100,
  n: s,
  active: (i & 1) === 0,
  tags: ['a', 'b'],
})
export const key = (i) => 'k' + i

// the batched hot lane on a seam handle, made exactly as substrate.ts laneOf makes it (same origin token)
export const laneFor = (p) => D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })

// decode one frame the way a replica does: scan, then materialise each record (copies out of the bytes)
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }

// load n rows into a fresh seam handle the way a replica fills: insert records encoded into fero frames of
// 256, decoded, and folded through the lane (so row strings are flat decoded strings, as on a real replica)
export const fill = (p, n, from = 0, stamp = 0) => {
  const lane = laneFor(p)
  const B = 256
  for (let i = from; i < from + n; i += B) {
    const recs = []
    for (let j = i; j < Math.min(from + n, i + B); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(j, stamp) })
    lane(decodeFrame(C.encodeFrame(recs)))
  }
}

// views: 'none', 'group' (one group view by region, 16 buckets), 'filter100' (100 filter views, one per room)
// Each view gets one native sink, as a live subscriber would; the sink does nothing with its batches.
export const attachViews = (p, kind) => {
  const subs = []
  const sink = { apply() {} }
  if (kind === 'group') {
    const g = p.group((r) => r.region)
    subs.push(g.sink(sink))
  } else if (kind === 'filter100') {
    for (let j = 0; j < 100; j++) {
      const f = p.filter((r) => r.room === j)
      subs.push(f.sink(sink))
    }
  } else if (kind !== 'none') throw new Error('unknown views ' + kind)
  return subs
}

export const gc = () => { if (global.gc) { global.gc(); global.gc(); global.gc() } }
export const heap = () => { const m = process.memoryUsage(); return { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss } }
export const limit = () => v8.getHeapStatistics().heap_size_limit
export const now = () => process.hrtime.bigint()
export const cpu = () => { const u = process.cpuUsage(); return u.user + u.system } // µs, all threads of the process
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
export const env = () => ({ node: process.version, v8: process.versions.v8, loadavg: (globalThis.__loadavg ?? null) })
export const out = (o) => console.log(JSON.stringify(o))
