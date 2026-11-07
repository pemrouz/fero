// E-06 shared helpers: fero's seam from the scratch tree (tree.sh), Immutable.js from $IMMUTABLE, rows, timing.
import { pathToFileURL } from 'node:url'

export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the scratch tree built by tree.sh')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href) // fero's seam
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href) // the module instance the seam uses
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
export const I = process.env.IMMUTABLE ? await import(pathToFileURL(process.env.IMMUTABLE).href) : null // Immutable.js (npm)
export const VALUE = D.value
export const UPDATE = 0, INSERT = 1, REMOVE = 2

// the same ~100 B small row as E-05
export const row = (i, s) => ({ name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] })
export const key = (i) => 'k' + i
export const laneFor = (p) => D.lane(p, { origin: S.ORIGIN, onReject: (rj) => { throw rj.error } })
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }
// fill n rows through the seam the way a replica does (fero frames of 256, decoded, folded by the lane)
export const fill = (p, n) => {
  const lane = laneFor(p)
  for (let i = 0; i < n; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(n, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(j, 0) })
    lane(decodeFrame(C.encodeFrame(recs)))
  }
}
// one group view with one sink, as a live subscriber (the resource's own view)
export const groupView = (p) => p.group((r) => r.region).sink({ apply() {} })

// a seeded generator and the tape: inputs of two records each, like a booking call: a status field update
// of one existing row, then a whole-row rewrite of another (no input adds rows, so the state stays at n rows)
export const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
export const tape = (n, T, seed = 7) => {
  const r = rng(seed), out = []
  let s = 1
  for (let i = 0; i < T; i++) {
    const a = r() % n, b = r() % n
    out.push([{ type: UPDATE, key: [key(a), 'n'], value: ++s }, { type: UPDATE, key: [key(b)], value: row(b, ++s) }])
  }
  return out
}

export const gc = () => { if (global.gc) { global.gc(); global.gc() } }
export const now = () => process.hrtime.bigint()
export const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
export const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
export const out = (o) => console.log(JSON.stringify(o))
export const heapMB = () => Math.round(process.memoryUsage().heapUsed / 2 ** 20)
