// E-34 side probe: the longest GC pauses while one thread fills a Map of 5e6 row keys (the worker form's index),
// on the main thread and then on a worker thread, in one process. Optional OLD (MB) gives the worker explicit
// resourceLimits.maxOldGenerationSizeMb. Prints the five longest pauses on each (ms, perf_hooks GC kind: 1 minor,
// 4 major).
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { PerformanceObserver } from 'node:perf_hooks'
const run = (where) => {
  const xs = []
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) xs.push([e.duration, e.detail.kind]) })
  obs.observe({ entryTypes: ['gc'] })
  const m = new Map()
  const t0 = Date.now()
  for (let i = 0; i < 5e6; i++) m.set('k' + i, i * 65536 + 125)
  const t1 = Date.now()
  return new Promise((r) => setTimeout(() => { obs.disconnect(); xs.sort((a, b) => b[0] - a[0]); r({ exp: 'E-34', part: 'worker-gc', where, worker_old_mb: process.env.OLD ?? 'default', build_ms: t1 - t0, gcs: xs.length, longest: xs.slice(0, 5).map(([d, k]) => [+d.toFixed(1), k]), size: m.size }) }, 200))
}
if (isMainThread) {
  console.log(JSON.stringify(await run('main')))
  const w = new Worker(new URL(import.meta.url), { resourceLimits: process.env.OLD ? { maxOldGenerationSizeMb: +process.env.OLD } : undefined })
  w.on('message', (m) => { console.log(JSON.stringify(m)); w.terminate() })
} else parentPort.postMessage(await run('worker'))
