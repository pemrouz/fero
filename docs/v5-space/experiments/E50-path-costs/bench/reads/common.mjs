// Shared helpers (after E-05's bench/common.mjs): load fero's seam and codec from the scratch tree, make rows and
// records, time things. TREE is the folder tree.sh built.
import { pathToFileURL } from 'node:url'
export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the folder ../../tree.sh built (run.sh does this)')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href) // fero's seam
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)     // the same data instance
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)  // fero v4's record codec
export const UPDATE = 0, INSERT = 1, REMOVE = 2
// E-05's small row: about 100 B as JSON, 125 B as one insert record in fero's codec
export const row = (i, s) => ({ name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] })
export const key = (i) => 'k' + i
export const laneFor = (p) => D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }
// fill n rows the way a replica fills: insert records in frames of 256, decoded, folded through the lane
export const fill = (p, n) => {
  const lane = laneFor(p)
  for (let i = 0; i < n; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(n, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(j, 0) })
    lane(decodeFrame(C.encodeFrame(recs)))
  }
}
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
export const now = () => process.hrtime.bigint()
export const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1] }
export const load = () => { try { return +require('node:fs').readFileSync('/proc/loadavg', 'utf8').split(' ')[0] } catch { return null } }
// time fn over m calls, `rounds` rounds; ns per call, median of rounds
export const nsPer = (fn, m, rounds = 5) => {
  const r = []
  for (let k = 0; k < rounds; k++) { gc(); const t0 = now(); fn(m); r.push(Number(now() - t0) / m) }
  return median(r)
}
export const out = (o) => console.log(JSON.stringify(o))
