#!/usr/bin/env node
// Turns results/timing.jsonl into tables: for each measure, the median of the
// runs' medians, and the range across runs.
//
//   node probes/p2/summarize.mjs probes/p2/results/timing.jsonl
import { readFileSync } from 'node:fs'

const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const range = (xs) => `${Math.min(...xs)} to ${Math.max(...xs)}`
const f = (x, d = 0) => x.toFixed(d)

// Rows come in run order; a {"run":n} line starts each bench of a run.
let run = 0
const loads = []
const by = new Map()
for (const r of rows) {
  if (r.run !== undefined) { run = r.run; loads.push(r.loadavg.split(' ')[0]); continue }
  const k = r.measure
  if (!by.has(k)) by.set(k, new Map())
  const m = by.get(k)
  if (!m.has(run)) m.set(run, [])
  m.get(run).push(r)
}
const runsOf = (k) => [...(by.get(k)?.values() ?? [])]

console.log('# Probe P2: the numbers\n')
console.log('Made by `summarize.mjs` from `timing.jsonl`. Each cell is the median of the runs\' medians; the range is across runs.')
console.log('**Provisional:** taken on a shared cloud machine, not on the quiet machine where bars are judged.\n')
console.log(`Runs: ${runsOf('seeds-200').length}. The machine's one-minute load average before each bench (Node, then native, run by run): ${loads.join(', ')}.\n`)

console.log('## 200 seeds\n')
console.log('| How | ms for 200 seeds | range of run medians | events | events per seed | ns per event |')
console.log('|---|---:|---|---:|---:|---:|')
const seedsRow = (label, k) => {
  const rs = runsOf(k).map((x) => x[0])
  if (!rs.length) return
  const ms = med(rs.map((r) => r.ms))
  console.log(`| ${label} | ${f(ms, 1)} | ${range(rs.map((r) => +f(r.ms, 1)))} | ${rs[0].events} | ${f(rs[0].events / rs[0].seeds, 1)} | ${f((ms * 1e6) / rs[0].events)} |`)
}
seedsRow('**WASM under Node, one instance, data folding (the bar: 1,000 ms)**', 'seeds-200')
seedsRow('WASM under Node, one instance, no fold', 'seeds-200-nofold')
{
  // The native runner prints one line per repeat; its run median is taken here.
  const rs = runsOf('native').map((reps) => ({ ms: med(reps.map((r) => r.ns / 1e6)), events: reps[0].events, seeds: reps[0].seeds }))
  if (rs.length) {
    const ms = med(rs.map((r) => r.ms))
    console.log(`| Native, no Node, no fold | ${f(ms, 1)} | ${range(rs.map((r) => +f(r.ms, 1)))} | ${rs[0].events} | ${f(rs[0].events / rs[0].seeds, 1)} | ${f((ms * 1e6) / rs[0].events)} |`)
  }
}
seedsRow('WASM under Node, a new instance per seed, data folding (reference)', 'seeds-200-fresh-instance')

console.log('\n## A fresh world plus a scenario\n')
console.log('| How | p50 ms | p99 ms | range of the runs\' p99 | p99.9 ms | max ms (median of runs) | largest max | events per world |')
console.log('|---|---:|---:|---|---:|---:|---:|---:|')
const freshRow = (label, k) => {
  const rs = runsOf(k).map((x) => x[0])
  if (!rs.length) return
  console.log(`| ${label} | ${f(med(rs.map((r) => r.p50ms)), 3)} | ${f(med(rs.map((r) => r.p99ms)), 3)} | ${range(rs.map((r) => +f(r.p99ms, 3)))} | ${f(med(rs.map((r) => r.p999ms)), 3)} | ${f(med(rs.map((r) => r.maxms)), 2)} | ${f(Math.max(...rs.map((r) => r.maxOfMax)), 2)} | ${f(rs[0].eventsPerWorld, 1)} |`)
}
freshRow('**One instance, reset in place (the bar: p99 5 ms)**', 'fresh-world')
freshRow('A new instance per world (reference)', 'fresh-world-fresh-instance')

const mod = runsOf('module').map((x) => x[0])
const work = runsOf('fold-work').map((x) => x[0])
if (mod.length) {
  console.log('\n## The module\n')
  console.log(`- Size: ${mod[0].bytes} bytes.`)
  console.log(`- Compile: ${f(med(mod.map((r) => r.compileUs)))} microseconds (the engine compiles lazily; the work moves to the first calls). Make an instance: ${f(med(mod.map((r) => r.instanceUs)))} microseconds.`)
}
if (work.length) {
  const w = work[0]
  console.log(`- One pass of ${w.seeds} seeds calls JavaScript ${w.batches} times, with ${w.entries} entries, ${w.writes} of them client writes. ${w.refolds} folds start again after a restart. The instance's memory after it: ${w.memoryBytes} bytes.`)
}
