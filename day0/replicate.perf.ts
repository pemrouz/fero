// Perf sibling for the Day 0 replication primitive. The socket itself is I/O and
// environment-bound; what fero actually pays per change in the steady state is
// the CPU path: serialize a record → parse it → apply it onto the replica. That
// is what this measures, in isolation, median-of-5 with a hard threshold.
//
// Per CLAUDE.md ("Performance is a hard requirement"): if a change regresses
// this, investigate — do not widen the threshold.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { $, value } from '../../data/index.ts'
import { apply, view, type Change } from './replicate.ts'
import { bench } from '#utils'

function timeApply(records: string[]): number {
  const proxy = $({})
  const res = (proxy as any)[view].res
  const t0 = performance.now()
  for (const line of records) apply(res, JSON.parse(line) as Change)
  return performance.now() - t0
}

test('apply 10k object updates — serialize→parse→apply', () => {
  const N = 10_000
  // Pre-serialize the wire lines so we measure the receive path, not record gen.
  const records = Array.from({ length: N }, (_, i) =>
    JSON.stringify({ type: 'update', key: ['user' + i], value: { name: 'P', active: true, score: i } }),
  )
  const elapsed = bench.median([0, 0, 0, 0, 0].map(() => timeApply(records)))
  console.log(`  apply ${N} updates: ${elapsed.toFixed(2)}ms`)
  ok(elapsed < 60, `apply ${N} updates took ${elapsed.toFixed(2)}ms (threshold 60ms)`)
})

test('apply 10k array inserts — ordered push path', () => {
  const N = 10_000
  const records = Array.from({ length: N }, (_, i) =>
    JSON.stringify({ type: 'insert', key: [], value: { id: i }, at: String(i) }),
  )
  // arrays: seed the root as [] via an initial update, then inserts
  const seed = JSON.stringify({ type: 'update', key: [], value: [] })
  const elapsed = bench.median([0, 0, 0, 0, 0].map(() => timeApply([seed, ...records])))
  console.log(`  apply ${N} inserts: ${elapsed.toFixed(2)}ms`)
  ok(elapsed < 80, `apply ${N} inserts took ${elapsed.toFixed(2)}ms (threshold 80ms)`)
})
