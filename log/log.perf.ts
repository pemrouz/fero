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

test('compact is single-pass over the index: K churned partitions under ONE full-replication origin', () => {
  // The worst case for the old per-partition index rebuild: under full replication #key(r) is
  // the BARE origin, so one origin's index group spans every partition — and each compacted
  // partition re-filtered that whole group (K × total ≈ quadratic, inside the 30s timer tick).
  // The union-set rebuild filters each affected group exactly once. Threshold includes the log
  // build (no median-subtraction — subtracting two independently-noisy medians can mask a real
  // regression); the quadratic shape blows well past it, single-pass sits far under.
  const P = 500
  const W = 20 // 500 partitions × 20 same-key writes each = 10k records, 19 collapsible per partition
  let seq = 0
  const churned: ChangeRecord[] = []
  for (let p = 0; p < P; p++)
    for (let w = 0; w < W; w++) churned.push({ type: 'update', key: ['part' + p], value: w, origin: 'ONE', seq: ++seq, epoch: 1 })
  let dropped = 0
  const elapsed = bench.time(() => {
    const log = new Log() // full replication — the bare-origin index granularity
    for (const r of churned) log.append(r)
    dropped = log.compact()
  })
  console.log(`  compact ${P} partitions × ${W} writes (one origin, incl. build): ${elapsed.toFixed(3)}ms (dropped ${dropped})`)
  ok(dropped === P * (W - 1), `every superseded update collapsed (dropped ${dropped})`)
  ok(elapsed < 40, `build+compact took ${elapsed.toFixed(3)}ms (threshold 40ms) — the index rebuild must be one pass, not one per partition`)
})
