// E-57 group A benches: shared helpers. A copy (proto/served.mjs's Copy, unchanged) inside a stub world: no links,
// no clients; every message a copy sends is counted (and its bytes), so a bench measures the copy's own work:
// data's fold, the views, and the one encode per change.
import { Copy, table, D } from '../proto/served.mjs'
import { newStats } from '../sim/world.mjs'

export const now = () => process.hrtime.bigint()
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
// a full collection after the current job ends: data's runtime keeps a WeakRef to every node, and a WeakRef keeps its
// target alive until the job that made it ends, so a collection inside one long job frees nothing (found here: the
// 1e6-row build ran out of memory; every timed loop now yields before it collects)
export const gcAsync = async () => { await new Promise((r) => setImmediate(r)); gc(); await new Promise((r) => setImmediate(r)); gc() }
export const heap = () => process.memoryUsage().heapUsed
export const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
export const r1 = (x) => Math.round(x * 10) / 10
export const r3 = (x) => Math.round(x * 1000) / 1000
export const out = (o) => console.log(JSON.stringify({ exp: 'E-57', group: 'A', node: process.version, ...o }))
// mulberry32, as the sims
export const rng = (seed) => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) & 0x7fffffff } }
export const row = (i, r) => ({ id: 'k' + i, points: r() % 10, pts: ((r() % 2001) - 1000) / 10, team: 't' + (r() % 4), name: 'u' + (r() % 4), at: 0 })
export function rows(n, seed = 7) { const r = rng(seed), m = []; for (let i = 0; i < n; i++) { const x = row(i, r); m.push([x.id, x]) } return m }

export function stubWorld(cfg = {}) {
  const w = {
    t: 0, stats: newStats(), sent: { n: 0, bytes: 0 }, last: null,
    cfg: { ring: 64, linger: 1e9, viewsMax: 1e9, viewsClient: 1e9, viewsRows: 0, headroom: 0, budget: 0, shapes: 1e9, place: false, ...cfg },
    tables: (tv) => table(tv),
    toClient: (copy, linkId, m) => { w.sent.n++; w.sent.bytes += typeof m === 'string' ? m.length : JSON.stringify(m).length; w.last = m },
    owner: () => 0, costOf: () => 0, checkAdmit() {}, checkJoin() {}, onBuild() {}, onAttach() {}, onRefused() {}, fail() {},
  }
  return w
}
export function newCopy(n, { depth = 1, cfg = {}, seed = 7, promote = true } = {}) {
  const w = stubWorld(cfg), c = new Copy(w, 0)
  const rs = rows(n, seed)
  if (depth === 1) c.start(rs, 0, 1, 1)
  else c.start([['p0', new Map(rs)]], 0, 1, 2)
  if (promote) { if (depth === 1) c.src.promote(); else for (const s of c.parts.values()) s.promote() }
  return { w, c, rs }
}
// a SUB from link `link` (client `ci`) for { method, arg }
let hs = 0
export function sub(c, spec, link = 1, ci = 0) { c.onMsg(link, ci, { t: 'sub', h: ++hs, cls: spec.cls ?? 'C', method: spec.method, arg: spec.arg, part: spec.part, ops: spec.ops, place: 'x', seen: 0, claims: { sub: 'u0' } }); return hs }
export { D }
