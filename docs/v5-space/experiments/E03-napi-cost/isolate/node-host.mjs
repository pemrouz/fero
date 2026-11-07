// E-03 part 3, the Node row: run data's bundle and work.js in Node's own context, exactly as the
// isolate hosts do, and print the same JSON lines. node --expose-gc isolate/node-host.mjs <bundle> <shim> <work>
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const [bundle, shim, work] = process.argv.slice(2)
const quick = process.env.QUICK === '1'
const REPS = quick ? 2 : 5
const host = 'node ' + process.version
const out = (o) => console.log(JSON.stringify({ host, ...o }))
const gc = globalThis.gc ?? (() => {})
const now = () => process.hrtime.bigint()
gc(); const h0 = process.memoryUsage().heapUsed
const t0 = now()
vm.runInThisContext(readFileSync(shim, 'utf8')); vm.runInThisContext(readFileSync(bundle, 'utf8')); vm.runInThisContext(readFileSync(work, 'utf8'))
const loadMs = Number(now() - t0) / 1e6
gc(); const h1 = process.memoryUsage().heapUsed
const ROWS = 10_000
globalThis.W.setup(ROWS)
gc(); const h2 = process.memoryUsage().heapUsed
out({ measure: 'memory', loadMs: +loadMs.toFixed(2), heapDataLoadedBytes: h1 - h0, heapPerRowBytes: Math.round((h2 - h1) / ROWS), rssBytes: process.memoryUsage().rss, note: 'heap delta after gc; a fresh Node process, not a fresh isolate' })
function measure(name, units, iters, fn) {
  fn(Math.max(1, iters >> 3))
  const xs = []
  for (let r = 0; r < REPS; r++) { const t = now(); fn(iters); xs.push(Number(now() - t) / (iters * units)) }
  xs.sort((a, b) => a - b)
  out({ measure: name, ns: +xs[xs.length >> 1].toFixed(2), min: +xs[0].toFixed(2), max: +xs[xs.length - 1].toFixed(2), reps: REPS })
}
const W = globalThis.W
measure('js loop floor', 1, quick ? 1e6 : 1e7, (n) => W.loop(n))
measure('data fold, batch 256 (ns/record)', 256, quick ? 500 : 5000, (n) => W.fold(n))
