// skeptic: E-54 says a data store rewritten as a HAMT would cost "+3.3-5.7 µs and 1.3-1.7 KB garbage per write",
// reasoned from a HAMT that KEPT every root. Here: the same HAMT keeping only the latest root (a store), against a Map.
import { PerformanceObserver } from 'node:perf_hooks'
const B = new URL('./', import.meta.url).href
const C = await import(B + 'common.mjs'), HM = await import(B + 'hamt.mjs')
const N = +process.argv[2], WAY = process.argv[3], H = 1000000
const { recs } = C.tape(N, H + 1000)
let gcMs = 0
new PerformanceObserver((l) => { for (const e of l.getEntries()) gcMs += e.duration }).observe({ entryTypes: ['gc'] })
const m0 = C.initMap(N)
let st, write
if (WAY === 'map') { st = m0; write = (x) => C.applyMap(st, x) }
else {
  let r = HM.fromMap(m0); const roots = WAY === 'hamt-all' ? [r] : null
  write = (x) => { const k = x.key[0]; r = x.type === C.REMOVE ? HM.del(r, k) : x.key.length === 1 ? HM.set(r, k, x.value) : HM.set(r, k, C.pathCopy(HM.get(r, k), x.key[1], x.value)); if (roots) roots.push(r) }
  st = { get r() { return r }, roots }
}
C.gc(); await new Promise((r) => setTimeout(r, 20)); gcMs = 0
const h0 = C.heapUsed()
const t0 = C.now()
for (let i = 0; i < H; i++) write(recs[i])
const ns = C.ns(t0)
await new Promise((r) => setTimeout(r, 20))
const gcDuring = gcMs
C.gc(); const h1 = C.heapUsed()
C.out({ skeptic: 'hamtstore', node: process.version, rows: N, way: WAY, nsPerWrite: +(ns / H).toFixed(1), gcMsDuring: +gcDuring.toFixed(0), keptBPerWrite: +((h1 - h0) / H).toFixed(1), keep: st ? 1 : 0 })
