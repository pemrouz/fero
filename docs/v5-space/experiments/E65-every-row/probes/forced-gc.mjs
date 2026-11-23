// E-65 skeptic probe: how long one forced full collection pauses the main thread when the process holds N rows
// in one data source (X1's guard forces one at each tenth of the budget from 50 % and before each line).
// X1 timed the guard only at a 32 MB budget; its "about 1 s" at millions of rows is V8's own collections while
// loading. This times the forced kind itself, three in a row, after the load.
//   node --expose-gc --max-old-space-size=3000 forced-gc.mjs --rows=5000000
import { args, out, loadData, inserts, loadavg } from '../X1/src/lib.mjs'
import v8 from 'node:v8'
const A = args(), N = A.rows ?? 1e6
const D = await loadData()
const src = D.$({}), lane = D.lane(src, { onReject: (rj) => { throw rj.error } })
for (const b of inserts(N)) lane(b)
const ms = []
for (let i = 0; i < 3; i++) { const t = performance.now(); globalThis.gc(); ms.push(+(performance.now() - t).toFixed(1)) }
const h = v8.getHeapStatistics()
out({ probe: 'forced-gc', rows: N, forced_gc_ms: ms, heap_used_mb: Math.round(h.used_heap_size / 2 ** 20), rss_mb: Math.round(process.memoryUsage.rss() / 2 ** 20), node: process.version, loadavg: loadavg() })
