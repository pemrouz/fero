// L2 whole-resource GATHER hot path (Milestone Q3). The gather is the explicitly-expensive
// "download everything" path holistic ops (sort/distinct/group/reduce) run AFTER read() — so the
// guard here is against SUPERLINEARITY, not against the inherent O(N) cost of materializing the
// whole resource. Two costs matter:
//
//  1. PARTIAL BUILD — a holder's {op:'rows'} partial is its owner-scoped row set (`ownedView()`);
//     materializing its snapshot scans every owned key (one `mesh.owner` hash each) and clones the
//     whole owned object. This is what each holder ships and what the querier folds (unionRule).
//     A lone server owns everything it holds, so all N keys are owned — the worst-case scan.
//
//  2. UNION FOLD — the querier recombine folds K per-holder snapshots into the whole resource via
//     Object.assign by key. We measure the rebuild over K shards of N/K rows. This re-runs on every
//     shard delta (the gather is O(total)/delta by design — a live holistic-after-read recomputes
//     the whole answer; the per-delta cost is inherent, so we only guard the SHAPE stays linear).
//
// Median-of-5 + warmup via #utils bench. Thresholds are generous headroom over observed numbers;
// never widen to pass — investigate a regression. The gather only arms under scoping; the R=∞ write
// hot path is unchanged (index.perf.ts guards it).

import { test } from 'node:test'
import { ok } from 'node:assert'
import { value } from '../../data/index.ts'
import { fero } from './index.ts'
import { ports, bench } from '#utils'

const N = 10_000

test('Q3: build a holder’s owner-scoped {op:rows} partial over N owned rows', async () => {
  const r = await fero('perf-gather-build', { port: await ports.free(), wait: 10 })
  for (let i = 0; i < N; i++) r.data['k' + i] = { v: i }
  const elapsed = bench.time(() => {
    // materialize the rows partial (XU0 scans all N owned keys, hashing each, and clones the set).
    void r.methods.aggregate({ op: 'rows' })[value]
  })
  console.log(`  build owner-scoped {op:rows} over ${N} owned rows: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 30, `rows partial build took ${elapsed.toFixed(3)}ms (threshold 30ms)`)
  r.destroy()
})

test('Q3: union-fold K shard snapshots into the whole resource (linear in total rows)', async () => {
  const K = 8
  // K disjoint shard snapshots of N/K rows each — the per-holder partials the querier folds.
  const shards = Array.from({ length: K }, (_, s) => {
    const o: Record<string, { v: number }> = {}
    for (let i = 0; i < N / K; i++) o['s' + s + '_' + i] = { v: i }
    return o
  })
  // mirrors RULES.rows (unionRule): Object.assign by key over the defined shard partials.
  const fold = (vs: unknown[]) => Object.assign({}, ...vs.filter((x) => x != null && typeof x === 'object'))
  let total = 0
  const elapsed = bench.time(() => {
    const merged = fold(shards) as Record<string, unknown>
    total = Object.keys(merged).length
  })
  console.log(`  union-fold ${K} shards into ${total} rows: ${elapsed.toFixed(3)}ms`)
  ok(total === N, `union covered all ${N} rows (got ${total})`)
  ok(elapsed < 30, `union fold took ${elapsed.toFixed(3)}ms (threshold 30ms)`)
})
