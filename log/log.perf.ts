// L1 hot paths: appending records to the log, and projecting a log into a view
// (replay). Both run on every write / every catch-up. Median-of-5 + warmup,
// thresholds with ~2–2.5× headroom over the loaded-box median (per CLAUDE.md).

import { test } from 'node:test'
import { ok } from 'node:assert'
import { Log } from './log.ts'
import { view } from './index.ts'
import type { ChangeRecord } from '../transport/message.ts'
import { bench } from '#utils'

const N = 10_000
const records: ChangeRecord[] = Array.from({ length: N }, (_, i) => ({
  type: 'update',
  key: ['user' + i],
  value: { name: 'user' + i, active: (i & 1) === 0, score: i },
}))

test(`append ${N} records to the log`, () => {
  const elapsed = bench.time(() => {
    const log = new Log()
    for (let i = 0; i < N; i++) log.append(records[i])
  })
  console.log(`  append ${N}: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 12, `append ${N} took ${elapsed.toFixed(3)}ms (threshold 12ms)`)
})

test(`project a ${N}-record log into a view (replay)`, () => {
  const log = new Log()
  for (let i = 0; i < N; i++) log.append(records[i])
  const elapsed = bench.time(() => void view(log))
  console.log(`  project ${N}: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 60, `project ${N} took ${elapsed.toFixed(3)}ms (threshold 60ms)`)
})

// Compaction: a high-churn partition — N updates over K live keys (one origin, the
// owner-routed steady state). The pass groups by (origin,versionKey), marks the
// superseded updates, and rebuilds the segment + index group. Off the write hot path
// (an unref'd timer), but it sweeps every partition, so it must stay well sub-linear-ish.
const K = 100
const churn: ChangeRecord[] = Array.from({ length: N }, (_, i) => ({
  type: 'update',
  key: ['hot', 'k' + (i % K)],
  value: i,
  origin: 'O',
  seq: i + 1,
  epoch: 1,
}))

test(`compact a churned ${N}-record partition down to ${K} live keys`, () => {
  // bench.time runs the body 6× (1 warmup + median-of-5); rebuild a fresh churned log each run
  // so every iteration compacts the full N→K (compact is idempotent, so re-running a compacted
  // log would measure a no-op). The rebuild is excluded from the assertion via a separate baseline.
  let droppedCount = 0
  const elapsed = bench.time(() => {
    const log = new Log()
    for (let i = 0; i < N; i++) log.append(churn[i])
    droppedCount = log.compact()
  })
  const build = bench.time(() => {
    const log = new Log()
    for (let i = 0; i < N; i++) log.append(churn[i])
  })
  const compactOnly = elapsed - build
  console.log(`  compact ${N}→${K}: ${compactOnly.toFixed(3)}ms (dropped ${droppedCount}; build ${build.toFixed(3)}ms)`)
  ok(droppedCount === N - K, `collapsed to ${K} live keys (dropped ${droppedCount})`)
  ok(compactOnly < 40, `compact ${N} took ${compactOnly.toFixed(3)}ms (threshold 40ms)`)
})
