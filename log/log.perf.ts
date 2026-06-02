// L1 hot paths: appending records to the log, and projecting a log into a view
// (replay). Both run on every write / every catch-up. Median-of-5 + warmup,
// thresholds with ~2–2.5× headroom over the loaded-box median (per CLAUDE.md).

import { test } from 'node:test'
import { ok } from 'node:assert'
import { Log } from './partition.ts'
import { view } from './index.ts'
import type { ChangeRecord } from '../transport/message.ts'
import { bench } from '../utils/index.ts'

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
