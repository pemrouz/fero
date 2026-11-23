// E-66 review probe: the key index's own stall. data keeps a source's keys in one JavaScript Map (`keySlot`,
// kernel/store.ts). V8 keeps a Map in one hash table and, when it fills, builds a table twice the size in one
// go (E-63 saw this as a 140 to 441 ms p99 at 1e6 rows). One Map also stops at 2^24 = 16,777,216 entries (E-34).
// This inserts N keys ('k' + i, a small-integer value, as keySlot holds) and times every insert:
//   map      one Map
//   blocks   64 Maps, the key's hash picking one (a stand-in for many small tables by slot block)
//   ix       E-65 X1's typed-array index, grown from empty (it too doubles its table in one go)
// Each insert that takes 1 ms or more is a stall. Stalls during which V8 ran a collection are counted apart
// (a PerformanceObserver on 'gc'), so `rebuild_ms` is the longest stall with no collection in it.
//   node --expose-gc --max-old-space-size=3000 keyindex.mjs --form=map|blocks|ix --rows=4000000
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { args, out, loadavg, hash32 } from '../../E65-every-row/X1/src/lib.mjs'
import { KeyIndex } from '../../E65-every-row/X1/src/compact.mjs'

const A = args(), N = A.rows ?? 4e6, form = A.form ?? 'map'
const base = { exp: 'E-66', probe: 'keyindex', form, rows: N, node: process.version, loadavg: loadavg() }
const gcs = []
const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]) })
obs.observe({ entryTypes: ['gc'] })

let add
if (form === 'map') { const m = new Map(); add = (k, v) => m.set(k, v) }
else if (form === 'blocks') { const ms = Array.from({ length: 64 }, () => new Map()); add = (k, v) => ms[hash32(k) & 63].set(k, v) }
else if (form === 'ix') { const ix = new KeyIndex({ cap: 0 }); add = (k) => ix.add(k) }
else throw new Error('form?')

const stalls = [] // [ms, at, t0, t1]
let capAt = null
const t0 = performance.now()
for (let i = 0; i < N; i++) {
  const k = 'k' + i, a = performance.now()
  try { add(k, i) } catch (e) { capAt = i; base.cap_error = String(e.message); break }
  const b = performance.now()
  if (b - a >= 1) stalls.push([b - a, i, a, b])
}
const total = performance.now() - t0
await new Promise((res) => setTimeout(res, 50)) // let the observer deliver
obs.disconnect()
const withGc = (s) => gcs.some(([g0, g1]) => g0 < s[3] && g1 > s[2])
const plain = stalls.filter((s) => !withGc(s)), gced = stalls.filter(withGc)
const top = (xs) => xs.sort((x, y) => y[0] - x[0]).slice(0, 4).map((s) => [+s[0].toFixed(1), s[1]])
out({ ...base, inserted: capAt ?? N, cap_at: capAt, total_ms: Math.round(total), stalls: stalls.length,
  rebuild_ms: plain.length ? +Math.max(...plain.map((s) => s[0])).toFixed(1) : 0, rebuild_top: top(plain),
  gc_stall_ms: gced.length ? +Math.max(...gced.map((s) => s[0])).toFixed(1) : 0, gc_top: top(gced),
  heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576), rss_mb: Math.round(process.memoryUsage().rss / 1048576) })
