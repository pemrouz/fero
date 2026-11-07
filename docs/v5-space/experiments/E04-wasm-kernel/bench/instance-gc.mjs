// Why a fresh WASM instance per test has a slow tail: count V8 GC pauses while making 2,000 instances of K.
// node bench/instance-gc.mjs <k.wasm>   (a smoke under the heavy lock, not a timing run; gc kinds: 1 scavenge, 4 mark-compact, 8 incremental)
import { readFileSync } from 'node:fs'
import { PerformanceObserver } from 'node:perf_hooks'
const mod = new WebAssembly.Module(readFileSync(process.argv[2]))
const gcs = []
new PerformanceObserver((l) => { for (const e of l.getEntries()) gcs.push([e.detail?.kind ?? e.kind, e.duration]) }).observe({ entryTypes: ['gc'] })
const xs = []
for (let i = 0; i < 2000; i++) { const t = performance.now(); const ex = new WebAssembly.Instance(mod, {}).exports; ex.k_reset(); xs.push(performance.now() - t) }
await new Promise((r) => setTimeout(r, 50))
xs.sort((a, b) => a - b)
const kinds = {}; for (const [k, d] of gcs) { kinds[k] = kinds[k] ?? [0, 0, 0]; kinds[k][0]++; kinds[k][1] += d; kinds[k][2] = Math.max(kinds[k][2], d) }
console.log({ p50: xs[1000].toFixed(3), p99: xs[1980].toFixed(3), max: xs[1999].toFixed(3), gcByKind: kinds, rssMB: (process.memoryUsage().rss / 1e6).toFixed(0) })
