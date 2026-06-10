// tools/observe/bridge.perf.ts — the SCALE-TIER rollup is the bridge's new hot path: deriveAggregate
// folds every held snapshot once per poll (O(N·origins) in the live-origin frontier loop), and at
// N=200 it competes with consensus for the bridge event loop (plan §6 risk). Guard it: median-of-5
// over 200 fabricated snapshots LADEN with dead-origin debris (the worst case for the live-origin
// filter). Never widen the threshold to pass — move work off the tick or tighten the reduction.

import { test } from 'node:test'
import { ok } from 'node:assert/strict'
import { bench } from '#utils'
import { deriveAggregate } from './bridge.ts'
import type { InspectSnapshot } from '../../resource/inspect.ts'

const N = 200
const members = Array.from({ length: N }, (_, i) => `127.0.0.1:${4000 + i}`)
const liveUuids = Array.from({ length: N }, (_, i) => 'u' + i)
// a full 120-segment ownership donut (member-index per segment) so the consensus-`cover` resolution
// (largest view's coverage → owner addresses, for the key-movement heatmap) is measured, not skipped
const coverage = Array.from({ length: 120 }, (_, i) => i % N)
// 60 live origins + 40 DEAD origins (retired uuids from past restarts) — the rollup must skip the
// dead ones when building the frontier (else it reports debris as "behind"); skipping is per-key work.
const origins = [...liveUuids.slice(0, 60), ...Array.from({ length: 40 }, (_, i) => 'dead' + i)]
const snaps: InspectSnapshot[] = members.map(
  (me, i) =>
    ({
      name: 'perf', uuid: liveUuids[i], me, role: 'server', epoch: 5, members, writable: true,
      ring: { coverage, members, replicas: 3, scoped: true } as any,
      log: { size: 1000 + i, partitions: 8, heads: {} },
      // ~100 seenKeys/node (60 live + 40 dead origins × partitioned), each node a bit behind the frontier
      marks: Object.fromEntries(origins.map((o, j) => [`${o}\x00p${j % 8}`, 1000 - (i % 30) * 3])),
      versions: 0, pending: 0, orphans: [], subscriptions: 0, peers: [], at: 0,
    }) as InspectSnapshot,
)

test('perf: deriveAggregate over 200 snapshots (with dead-origin debris) stays well under the poll budget', () => {
  const ms = bench.time(() => {
    deriveAggregate(snaps, 'blobs', N)
  })
  console.log(`  deriveAggregate(N=${N}, ${origins.length} origins, ~${origins.length} seenKeys/node): ${ms.toFixed(3)}ms median`)
  // the bridge poll runs this once per ~1000ms — a few ms median leaves the loop free for the source pulls
  ok(ms < 8, `deriveAggregate median ${ms.toFixed(3)}ms must stay under 8ms`)
})
