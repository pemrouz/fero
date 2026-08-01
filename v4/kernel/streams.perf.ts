//! Perf sibling: the descriptor sits on the receive path (one lookup + two field writes per record run
// element) — it replaced a same-shaped {seen} object literal, so the durable claim is structural
// (no extra allocation, no extra map). The absolute below is a tripwire (WSL2 swings 2-3x); the REAL
// guard for this path is node.perf.ts's 2k-record inbound-apply ceiling, which runs the whole chain.

import { test } from 'node:test'
import assert from 'node:assert'
import { Streams } from './streams.ts'
import { bench } from '#utils'

test('absolute: 1M get-or-create + ladder advances under the tripwire ceiling', () => {
  const s = new Streams()
  const origins = Array.from({ length: 64 }, (_, i) => `origin-${i}`)
  let seq = 0
  const ms = bench.time(() => {
    for (let i = 0; i < 1_000_000; i++) {
      const d = s.for(origins[i & 63])
      const n = ++seq
      if (n > d.applied) { d.applied = n; d.shippable = n }
    }
  })
  assert.equal(s.size, 64)
  assert.ok(ms < 300, `1M ladder advances took ${ms.toFixed(1)}ms (ceiling 300ms)`)
})
