// TEST-01 on the prototype (bars: a fresh node plus a scenario <= 5 ms; 200 chaos seeds <= 1 s).
// (a) node:     fero.world + a socketless solo node (listen: false), then close
// (b) scenario: (a) plus a seed row, an incr with a bound, a set, a sync read, then close
// (c) chaos200: 200 seeds of three servers and a client, 10 writes, one leader change and one slot
//               move, the monitors after each seed (the harness's runOne)
// Prints one JSON line. Run it under the timing lock (run.sh does).
import { fero, op } from '../proto/index.ts'
import { runOne } from '../proto/check.ts'

const node = async (seed: number) => { const w = fero.world({ seed }); await fero('shop', { listen: false }); await w.close() }
const scenario = async (seed: number) => {
  const w = fero.world({ seed })
  const shop = await fero('shop', { listen: false, data: { widgets: { stock: 10 } } })
  const a = await shop.set(['widgets', 'stock'], op.incr(-1, { min: 0 }))
  await shop.set('gadgets', { stock: 3 })
  const left = shop.snapshot.widgets.stock
  await w.close()
  if (left !== 9 || a.value !== 9) throw new Error(`scenario wrong: ${left} ${a.value}`)
}
const chaosBody = async (c: any) => {
  const [s1, s2, s3, a] = c.procs('s1', 's2', 's3', 'a')
  for (const s of [s1, s2, s3]) await s.run(() => fero('shop', { server: true }))
  c.chaos({ leaderChanges: 1, moves: 1, within: 5 })
  await a.run(async () => { const shop = await fero('shop'); for (let i = 0; i < 10; i++) await shop.set(`k${i % 3}`, op.incr(1)) })
}
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const timeEach = async (fn: (s: number) => Promise<void>, n: number, warm: number) => {
  for (let i = 0; i < warm; i++) await fn(1e6 + i)
  const ts: number[] = []
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(i + 1); ts.push(performance.now() - t0) }
  ts.sort((a, b) => a - b)
  return { n, p50: +pct(ts, 0.5).toFixed(4), p90: +pct(ts, 0.9).toFixed(4), p99: +pct(ts, 0.99).toFixed(4), max: +ts[n - 1].toFixed(3) }
}
const out: Record<string, unknown> = { node: process.version, load: (await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').trim() }
out.node_only_ms = await timeEach(node, 2000, 200)
out.scenario_ms = await timeEach(scenario, 2000, 200)
for (let i = 0; i < 20; i++) await runOne('warm', chaosBody, 1e6 + i, {})
let events = 0, failed = 0
const t0 = performance.now()
for (let seed = 1; seed <= 200; seed++) { const r = await runOne('chaos200', chaosBody, seed, {}); events += r.events; if (r.error) failed++ }
out.chaos200 = { ms: +(performance.now() - t0).toFixed(1), events, failed, us_per_event: +(((performance.now() - t0) * 1000) / events).toFixed(2) }
console.log(JSON.stringify(out))
