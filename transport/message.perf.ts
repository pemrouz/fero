// Perf sibling for the wire codec — the repo's hottest path. Per CLAUDE.md
// ("Performance is a hard requirement"): median-of-5, hard thresholds, never
// widened. Two things matter most: encode+frame a batch, and the LAZY decode —
// framing + record-boundary scan that touches NO value bytes until read. The
// last test guards exactly that laziness (scan-only must beat full-parse).

import { test } from 'node:test'
import { ok } from 'node:assert'
import { encodeFrame, Framer, type ChangeRecord } from './message.ts'
import { bench } from '#utils'

// Thresholds below carry ~2–2.5× headroom over the steady-state median on a
// loaded WSL2 box — loose enough to survive scheduling variance, tight enough to
// catch a real 2×+ regression. bench.time() does one untimed warmup (JIT +
// caches), then the median of five timed runs.

const N = 1000
// Realistic steady-state replication: object-valued updates with sibling keys.
const batch: ChangeRecord[] = Array.from({ length: N }, (_, i) => ({
  type: 'update',
  key: ['users', String(i)],
  value: { name: 'user' + i, active: (i & 1) === 0, score: i },
}))
const frame = encodeFrame(batch)

test(`encode+frame ${N} object-valued records`, () => {
  const elapsed = bench.time(() => void encodeFrame(batch))
  console.log(`  encode ${N}: ${elapsed.toFixed(3)}ms (${frame.length} bytes)`)
  ok(elapsed < 12, `encode ${N} took ${elapsed.toFixed(3)}ms (threshold 12ms)`)
})

test(`frame + lazy scan ${N} records (no value read)`, () => {
  const elapsed = bench.time(() => {
    const records = new Framer().push(frame).flatMap((f) => f.records())
    // touch only type — the relay/route path; values must stay unparsed
    let n = 0
    for (const r of records) if (r.type === 'update') n++
    if (n !== N) throw new Error('count')
  })
  console.log(`  scan   ${N}: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 6, `scan ${N} took ${elapsed.toFixed(3)}ms (threshold 6ms)`)
})

test(`frame + full decode ${N} records (read key + value)`, () => {
  const elapsed = bench.time(() => {
    const records = new Framer().push(frame).flatMap((f) => f.records())
    for (const r of records) {
      if (r.key.length === 0) throw new Error('key')
      if ((r.value as any).score === undefined) throw new Error('value')
    }
  })
  console.log(`  decode ${N}: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 14, `full decode ${N} took ${elapsed.toFixed(3)}ms (threshold 14ms)`)
})

test('lazy scan is meaningfully cheaper than full decode', () => {
  const scan = bench.time(() => {
    for (const r of new Framer().push(frame).flatMap((f) => f.records())) if (r.type !== 'update') throw 0
  })
  const full = bench.time(() => {
    for (const r of new Framer().push(frame).flatMap((f) => f.records())) void (r.value as any).score
  })
  console.log(`  scan ${scan.toFixed(3)}ms vs full ${full.toFixed(3)}ms`)
  // not reading values must skip the JSON.parse of N objects — a real gap
  ok(scan < full, `expected scan (${scan.toFixed(3)}) < full (${full.toFixed(3)})`)
})
