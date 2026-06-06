// L2 distributed-aggregate hot paths (Milestone Q2). Two costs matter:
//
//  1. PARTIAL BUILD — `buildPartial` constructs an owner-scoped `data.filter(owned).
//     <op>()` pipeline; its constructor XU0 scans every owned key (one `mesh.owner`
//     hash per key) and folds the aggregate. This runs once per spec AND on every
//     view-commit rebind, so it must stay within `data`'s own aggregate envelope plus
//     the owner-filter overhead. A lone server owns everything it holds, so all N keys
//     are owned — the worst case for the scan.
//
//  2. PER-DELTA — once a partial is live (a connected sink, as the fold uses), each
//     write must flow through filter → aggregate → sink in O(1): one row change → one
//     partial delta. We measure N sequential writes against a live partial sink and
//     assert it stays linear (no per-write rescan of the keyspace).
//
// Median-of-5 + warmup via #utils bench. Thresholds are generous headroom over the
// observed standalone numbers; never widen to pass — investigate a regression. The
// R=∞ write hot path is unchanged (index.perf.ts guards it); aggregates are a
// scoped-only, opt-in read path.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { value } from '../../data/index.ts'
import { fero } from './index.ts'
import { ports, bench } from '#utils'

const N = 10_000

test('Q2: build an owner-scoped sum partial over N owned rows', async () => {
  const r = await fero('perf-agg-build', { port: await ports.free(), wait: 10 })
  for (let i = 0; i < N; i++) r.data['k' + i] = { v: i }
  const elapsed = bench.time(() => {
    // build + materialize the partial (XU0 scans all N owned keys, hashing each).
    void r.methods.aggregate({ op: 'sum', col: 'v' })[value]
  })
  console.log(`  build owner-scoped sum over ${N} owned rows: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 120, `partial build took ${elapsed.toFixed(3)}ms (threshold 120ms)`)
  r.destroy()
})

test('Q2: N incremental writes through a live owner-scoped sum partial (O(1)/delta)', async () => {
  const r = await fero('perf-agg-delta', { port: await ports.free(), wait: 10 })
  // a live partial with a connected sink — the shape the fold subscribes to.
  const partial = r.methods.aggregate({ op: 'sum', col: 'v' })
  let last = 0
  partial.connect({}, (c: any) => {
    last = c.value
  })
  const elapsed = bench.time(() => {
    for (let i = 0; i < N; i++) r.data['k' + i] = { v: i }
  })
  console.log(`  ${N} writes through a live sum partial: ${elapsed.toFixed(3)}ms (sum=${last})`)
  ok(elapsed < 220, `${N} writes through the partial took ${elapsed.toFixed(3)}ms (threshold 220ms)`)
  r.destroy()
})
