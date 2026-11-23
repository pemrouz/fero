// E-65 skeptic probe: what one live view of data's own costs per write over a whole-resource hold.
// X1's fold bench ran data's four views together (sum, length, za(score, 10), median(score)) and got about 284
// records a second at 1e6 rows. This probe runs each view alone, so the stated fold limit of `hold: 'all'`
// can name which operator sets it.
//   node --expose-gc --max-old-space-size=3000 views-fold.mjs --rows=1000000 --view=za [--ms=3000]
// view: none | sum | length | za | median | all. One JSON line: ns a record, records a second.
import { args, out, loadData, gc, inserts, makeGen, now, nsSince, loadavg } from '../X1/src/lib.mjs'
const A = args(), N = A.rows ?? 1e6, view = A.view ?? 'none', budgetMs = A.ms ?? 3000
const D = await loadData()
const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
for (const b of inserts(N)) lane(b)
const VALUE = Symbol.for('data.v4.value')
const vs = []
if (view === 'sum' || view === 'all') vs.push(src.sum('cents'))
if (view === 'length' || view === 'all') vs.push(src.length())
if (view === 'za' || view === 'all') vs.push(src.za('score', 10))
if (view === 'median' || view === 'all') vs.push(src.median('score'))
for (const v of vs) void v[VALUE]
const gen = makeGen(N), warm = gen(2048), recs = gen(A.recs ?? 400000)
for (let i = 0; i < warm.length; i += 256) lane(warm.slice(i, i + 256))
gc()
const t0 = now(); let done = 0
for (let i = 0; i < recs.length; i += 256) { lane(recs.slice(i, i + 256)); done = Math.min(recs.length, i + 256); if (nsSince(t0) > budgetMs * 1e6) break }
const ns = nsSince(t0) / done
for (const v of vs) void v[VALUE]
out({ probe: 'views-fold', rows: N, view, records: done, ns_per_record: Math.round(ns), records_per_s: Math.round(1e9 / ns), node: process.version, loadavg: loadavg() })
