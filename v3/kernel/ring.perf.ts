//! Perf sibling: the ring is consulted on EVERY issued record (owner resolution) — the lookup must be
// noise next to the write path it gates. Build cost is per view install (cold) but still bounded here
// so a pathological rebuild can't hide inside membership churn. Absolute numbers on this runner are
// tripwires only (WSL2 swings 2-3x); the load-bearing claims are structural: allocation-free lookups
// (typed arrays + interned strings — verified by inspection + the M8 heap-delta gate) and O(log n) search.

import { test } from 'node:test'
import assert from 'node:assert'
import { Ring } from './ring.ts'
import { bench } from '#utils'

const members = (n: number): [string, string][] =>
  Array.from({ length: n }, (_, i) => [`n${String(i + 1).padStart(2, '0')}`, `sim:${i}`])
const keys = Array.from({ length: 4096 }, (_, i) => `part${i}`)

test('absolute: 1M ownerOf lookups on a 5-member ring under the tripwire ceiling', () => {
  const r = new Ring()
  r.build(1, members(5))
  let sink = 0
  const ms = bench.time(() => {
    for (let i = 0; i < 1_000_000; i++) sink += r.ownerOf(keys[i & 4095]).length
  })
  assert.ok(sink > 0)
  assert.ok(ms < 400, `1M lookups took ${ms.toFixed(1)}ms (ceiling 400ms)`)
})

test('absolute: view-install rebuild cost — 1k rebuilds of a 5-member ring under the ceiling', () => {
  const r = new Ring()
  const m = members(5)
  const ms = bench.time(() => { for (let i = 0; i < 1_000; i++) r.build(i, m) })
  assert.ok(ms < 300, `1k rebuilds took ${ms.toFixed(1)}ms (ceiling 300ms)`)
})

test('absolute: 1M holdersOf(k, 3) R-set walks on a 5-member ring under the tripwire ceiling', () => {
  //! the scoped fan-out (M6) consults holdersOf per committed record — it must stay noise like
  // ownerOf. The walk is the binary search + a short distinct-collect (coupon-collector expected
  // steps, single-digit at small r), reusing one scratch array: zero allocations per call.
  const r = new Ring()
  r.build(1, members(5))
  let sink = 0
  const ms = bench.time(() => {
    for (let i = 0; i < 1_000_000; i++) sink += r.holdersOf(keys[i & 4095], 3).length
  })
  assert.ok(sink > 0 && sink % 3_000_000 === 0, `every walk returned exactly 3 holders (sink ${sink})`)
  assert.ok(ms < 800, `1M R-set walks took ${ms.toFixed(1)}ms (ceiling 800ms)`)
})

test('counted: lookup cost is flat in member count (binary search, not a scan)', () => {
  //! not a wall-clock ratio (too noisy here) — a structural check: 128 members costs at most ~2x the
  // per-lookup time of 4 members over a big batch, which a linear scan (32x points) could never satisfy
  const small = new Ring(); small.build(1, members(4))
  const big = new Ring(); big.build(1, members(128))
  const run = (r: Ring) => bench.time(() => { for (let i = 0; i < 200_000; i++) r.ownerOf(keys[i & 4095]) })
  const s = run(small)
  const b = run(big)
  assert.ok(b < s * 3 + 50, `128-member lookups ${b.toFixed(1)}ms vs 4-member ${s.toFixed(1)}ms — search is not logarithmic`)
})
