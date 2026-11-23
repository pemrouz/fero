// E-65 probe (after the skeptic): an asker that holds every row folds the write mix, with the rows kept in S
// data sources by block (S = 1 is one store; S = 64 is one store per group of a 64-group resource), the records
// handed over in frames of B records per store, frames of the S stores interleaved (as G groups' streams arrive).
// Optionally one live view of data's on every store: za('score', 10) (a top 10, combined at read from the S
// lists) or sum('cents'). It answers two skeptic findings: the fold rate with small frames from many groups
// (finding 9), and what data's top k costs when each store holds 1/S of the rows (finding 1).
//   node --expose-gc --max-old-space-size=3000 asker-fold.mjs --rows=1000000 --stores=64 --frame=4 --view=za [--ms=3000]
// No network decode is timed: records are already objects. One JSON line.
import { args, out, loadData, gc, inserts, makeGen, now, nsSince, loadavg, slotOf } from '../X1/src/lib.mjs'
const A = args(), N = A.rows ?? 1e6, S = A.stores ?? 1, B = A.frame ?? 256, view = A.view ?? 'none', budgetMs = A.ms ?? 3000
const D = await loadData()
const VALUE = Symbol.for('data.v4.value')
const st = Array.from({ length: S }, () => { const src = D.$({}); return { src, lane: D.lane(src, { onReject: (rj) => { throw rj.error } }) } })
const keyOf = (r) => (r.type === 1 && r.key.length === 0 ? r.at : r.key[0])
const blockOf = (k) => slotOf(k) % S
for (const b of inserts(N)) { const parts = Array.from({ length: S }, () => []); for (const r of b) parts[blockOf(keyOf(r))].push(r); for (let i = 0; i < S; i++) if (parts[i].length) st[i].lane(parts[i]) }
const views = st.map((s) => (view === 'za' ? s.src.za('score', 10) : view === 'sum' ? s.src.sum('cents') : null))
for (const v of views) if (v) void v[VALUE]
// split the record stream by store, then deal frames of B records per store, round robin over the stores
const frames = (recs) => {
  const per = Array.from({ length: S }, () => [])
  for (const r of recs) per[blockOf(keyOf(r))].push(r)
  const fs = [], at = new Array(S).fill(0)
  for (let left = recs.length; left > 0;) for (let i = 0; i < S; i++) { const p = per[i]; if (at[i] < p.length) { const f = p.slice(at[i], at[i] + B); at[i] += f.length; left -= f.length; fs.push([i, f]) } }
  return fs
}
const gen = makeGen(N)
for (const [i, f] of frames(gen(4096))) st[i].lane(f) // warm
const fs = frames(gen(A.recs ?? 400000))
gc()
const t0 = now(); let done = 0
for (let j = 0; j < fs.length; j++) { const [i, f] = fs[j]; st[i].lane(f); done += f.length; if ((j & 63) === 0 && nsSince(t0) > budgetMs * 1e6) break }
const ns = nsSince(t0) / done
// one combined read: the top 10 over every store (each store's list is already sorted), so the views are live
let readNs = null
if (view === 'za') { const t = now(); const all = []; for (const v of views) for (const row of v[VALUE]) all.push(row?.score); all.sort((a, b) => b - a); all.length = Math.min(10, all.length); readNs = nsSince(t) }
out({ probe: 'asker-fold', rows: N, stores: S, frame: B, view, records: done, frames: fs.length, ns_per_record: Math.round(ns), records_per_s: Math.round(1e9 / ns), read_ns: readNs, node: process.version, loadavg: loadavg() })
