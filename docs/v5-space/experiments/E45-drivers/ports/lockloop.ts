// lockloop — PERF-07's lock row, fero's side: E-09e's lock loop (lockbench/main.go) ported to
// fero's own lock() (API.md §3, the L5 library E-22 built), as PERF-07 says ("lock (vs the locks
// library)"). Same shape as lockbench: N clients, each with its own session (here: its own
// process), one lock name per client unless --locks names fewer; each loop is Lock then Unlock;
// a warm-up is not measured; acquire and cycle times are kept. Latencies go into HdrHistogram
// (hdr-histogram-js), raw as lockbench keeps them, and corrected for coordinated omission
// (each sample recorded with the expected interval = the mean cycle, HdrHistogram's own method).
//
//   node --experimental-strip-types --no-warnings ports/lockloop.ts --clients 100 --locks 0 --duration 20s
//
// It runs on the E-22 SIMULATOR: three servers and N client processes in one world, so every
// time here is VIRTUAL (the world's clock), not a measurement of fero.

import '../../E22-api-prototype/patterns/timers.ts'   // the libraries' timers run on the world's clock
import { createRequire } from 'node:module'
import { fero } from '../../E22-api-prototype/proto/index.ts'
import { lock } from '../../E22-api-prototype/patterns/lib/index.ts'

const NPM = process.env.E45_NPM ?? '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/dl/e45-npm/'
const hdr = createRequire(NPM.endsWith('/') ? NPM : NPM + '/')('hdr-histogram-js')

const argv = process.argv.slice(2)
const flag = (k: string, d: string): string => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const ms = (s: string): number => (s.endsWith('ms') ? Number(s.slice(0, -2)) : s.endsWith('s') ? Number(s.slice(0, -1)) * 1000 : Number(s))
const clients = Number(flag('clients', '1')), locks = Number(flag('locks', '0'))
const duration = ms(flag('duration', '20s')), warmup = ms(flag('warmup', '2s'))
const lease = flag('lease', '10s')

const t0real = Date.now()
const w = fero.world({ seed: Number(flag('seed', '1')), shuffle: false })
const servers = ['s1', 's2', 's3'].map((id) => w.proc(id))
for (const s of servers) await s.run(() => s.fero('#app', { server: true }))
await w.settle()

const mk = () => hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 3_600_000_000, numberOfSignificantValueDigits: 3 })
const acq = mk(), cyc = mk()
const raw: { a: number; c: number }[] = []
let errors = 0
const start = w.time, measFrom = start + warmup, end = measFrom + duration
const loops = Array.from({ length: clients }, (_, i) => {
  const p = w.proc('c' + (i + 1))
  const name = `/lockbench/${locks > 0 ? i % locks : i}`
  return p.run(async () => {
    for (;;) {
      const a0 = fero.now()
      if (a0 > end) break
      let l
      try { l = await lock(name, { lease, wait: 'forever', renew: false }) } catch { errors++; continue }
      const a1 = fero.now()
      try { await l.release() } catch { errors++; continue }
      const a2 = fero.now()
      if (a0 >= measFrom && a2 <= end) raw.push({ a: Math.round((a1 - a0) * 1000), c: Math.round((a2 - a0) * 1000) })   // µs
    }
  })
})
await Promise.all(loops)

const meanCycle = raw.length ? Math.max(1, Math.round(raw.reduce((x, r) => x + r.c, 0) / raw.length)) : 1
const acqCO = mk(), cycCO = mk()
for (const r of raw) {
  acq.recordValue(Math.max(1, r.a)); cyc.recordValue(Math.max(1, r.c))
  acqCO.recordValueWithExpectedInterval(Math.max(1, r.a), meanCycle); cycCO.recordValueWithExpectedInterval(Math.max(1, r.c), meanCycle)
}
const pcts = (h: any) => Object.fromEntries([50, 90, 99, 99.9, 100].map((p) => [p === 100 ? 'max' : `p${String(p).replace('.', '')}`, h.getValueAtPercentile(p) / 1000]))
console.log(JSON.stringify({
  tool: 'lockloop (lockbench ported to fero lock())', virtual: true, clients, conns: clients, locks, seconds: duration / 1000,
  cycles: raw.length, cycles_per_s: raw.length / (duration / 1000), errors,
  acquire_ms: pcts(acq), cycle_ms: pcts(cyc),
  co_corrected: { expected_interval_ms: meanCycle / 1000, acquire_ms: pcts(acqCO), cycle_ms: pcts(cycCO) },
  sim: { events: w.events, verbs: w.history.length, real_s: (Date.now() - t0real) / 1000 },
}))
await w.close()
process.exit(0)
