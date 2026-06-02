// owner() is on the per-record routing hot path. This guards lookup latency on
// a realistic ring (5 peers × 200 vnodes = 1000 sorted entries) and the
// rebuild-on-churn cost. Median-of-5, hard thresholds (never widened). The
// hash-function bake-off (djb2 vs wy/xxhash) is deferred — see IDEAS.md.

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
