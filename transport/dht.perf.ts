// owner() is on the per-record routing hot path. This guards lookup latency on
// a realistic ring (5 peers × 200 vnodes = 1000 sorted entries) and the
// rebuild-on-churn cost. Median-of-5, hard thresholds (never widened). The
// hash-function bake-off (djb2 vs wy/xxhash) is deferred — see ../IDEAS.md.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { DHT } from './dht.ts'
import { bench } from '#utils'

// Thresholds below carry ~2× headroom over the loaded-box median — catch a real
// 2×+ regression without flaking on variance. bench.time() does one untimed
// warmup, then median-of-5.

const ring = () => {
  const dht = new DHT()
  for (let i = 0; i < 5; i++) dht.add('10.0.0.' + i + ':3000')
  dht.owner('warm') // force the lazy rebuild before timing
  return dht
}

const KEYS = Array.from({ length: 100_000 }, (_, i) => 'user' + i)

test('owner() lookup — 100k routes over a 1000-entry ring', () => {
  const dht = ring()
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < KEYS.length; i++) sink += dht.owner(KEYS[i])!.length
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  100k owner() lookups: ${elapsed.toFixed(3)}ms (${(elapsed * 1000 / KEYS.length).toFixed(3)}µs each)`)
  ok(elapsed < 50, `100k lookups took ${elapsed.toFixed(3)}ms (threshold 50ms)`)
})

test('owners(key, R=3) — 100k R-set lookups over a 1000-entry ring', () => {
  // The R-set computation is on the write path once P2 scopes replication
  // (owner forwards the committed record to replicas(P)). A walk from the owner
  // slot collecting R distinct peers — should stay within ~3× of owner().
  const dht = ring()
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < KEYS.length; i++) sink += dht.owners(KEYS[i], 3).length
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  100k owners(_,3) lookups: ${elapsed.toFixed(3)}ms (${((elapsed * 1000) / KEYS.length).toFixed(3)}µs each)`)
  ok(elapsed < 120, `100k R-set lookups took ${elapsed.toFixed(3)}ms (threshold 120ms)`)
})

test('holds(key, me, R=3) — 100k membership predicates over a 1000-entry ring', () => {
  // The allocation-free predicate (resource holds() first-touch + the catch-up digest
  // filter, neither of which is memoized for a foreign address). It answers the same
  // yes/no as owners(key,3).includes(me) but materializes no array/Set, so it must be
  // at LEAST as fast as owners() AND allocate nothing per call (GC pressure off the
  // catch-up path). Threshold tracks owner()'s (50ms — holds is owner-cost: one hash +
  // a short distinct-owner walk), NOT owners()' looser gate — no array/Set to build.
  const dht = ring()
  const me = '10.0.0.2:3000'
  const elapsed = bench.time(() => {
    let hits = 0
    for (let i = 0; i < KEYS.length; i++) if (dht.holds(KEYS[i], me, 3)) hits++
    if (hits < 0) throw new Error('sink')
  })
  console.log(`  100k holds(_,me,3): ${elapsed.toFixed(3)}ms (${((elapsed * 1000) / KEYS.length).toFixed(3)}µs each)`)
  ok(elapsed < 50, `100k holds() took ${elapsed.toFixed(3)}ms (threshold 50ms)`)
})

test('rebuild on membership churn — add/remove a peer (5→6→5)', () => {
  const dht = ring()
  const elapsed = bench.time(() => {
    dht.add('10.0.0.99:3000')
    dht.owner('warm') // trigger rebuild (1200 entries)
    dht.remove('10.0.0.99:3000')
    dht.owner('warm') // trigger rebuild back to 1000
  })
  console.log(`  add+rebuild+remove+rebuild: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 4, `churn rebuild took ${elapsed.toFixed(3)}ms (threshold 4ms)`)
})

test('coverage(120) — 10k samplings of the ownership donut over a 1000-entry ring', () => {
  // The L4 ownership-donut sampler (once per observe poll). 120 binary searches + a
  // small members→index Map per call — should track ~120× owner()'s per-lookup cost
  // (owner ≈ 0.1µs, so ~12µs/call → ~120ms for 10k), with headroom. Scale-independent:
  // the cost is fixed at k regardless of cluster size (that's the whole point of sampling
  // vs shipping the members × vnodes arcs).
  const dht = ring()
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < 10_000; i++) sink += dht.coverage(120).segments.length
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  10k coverage(120): ${elapsed.toFixed(3)}ms (${(elapsed * 1000 / 10_000).toFixed(2)}µs each)`)
  ok(elapsed < 300, `10k coverage(120) took ${elapsed.toFixed(3)}ms (threshold 300ms)`)
})

test('snapshot() — 100k cold-path reads over a 1000-entry ring (must not regress owner())', () => {
  // The L4 observe accessor is COLD path (once per observe poll, never per routed
  // record), but it must add zero burden to the hot ring: snapshot() returns the
  // arrays BY REFERENCE after the same lazy rebuild owner() does, so a warm ring
  // makes it a near-free struct return (+ a small members[] copy). Guards that it
  // never accidentally rebuilds or copies the big arrays per call — it should be
  // FASTER than 100k owner() lookups (50ms), since there's no per-call hash+search.
  const dht = ring()
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < KEYS.length; i++) sink += dht.snapshot().owners.length
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  100k snapshot() reads: ${elapsed.toFixed(3)}ms (${((elapsed * 1000) / KEYS.length).toFixed(3)}µs each)`)
  ok(elapsed < 50, `100k snapshot() reads took ${elapsed.toFixed(3)}ms (threshold 50ms)`)
})
