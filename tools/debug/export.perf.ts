// Perf sibling for the P1 fold. foldSnapshots runs on the capture path (~1/poll),
// never per write/replicate — but a large cluster (many nodes × many partitions)
// folds O(nodes × partitions) holder bookkeeping, so we guard it stays cheap.
// Median-of-5 (one untimed warmup) per #utils bench; don't widen to pass.

import { test } from 'node:test'
import { ok } from 'node:assert/strict'
import { bench } from '#utils'
import type { InspectSnapshot } from '../../resource/inspect.ts'
import { foldSnapshots, foldDivergence, type VersionSample } from './export.ts'

//! build N server snapshots that each hold all M partitions (the heaviest fold: full holder bookkeeping)
function cluster(N: number, M: number): InspectSnapshot[] {
  const members = Array.from({ length: N }, (_, i) => `:${5000 + i}`)
  const heads: Record<string, number> = {}
  for (let j = 0; j < M; j++) heads['p' + j] = j * 7 + 1
  return members.map((me, i) => ({
    at: 0, name: 'bench', uuid: me, me, role: 'server', epoch: 4, members,
    writable: true, ring: { members, coverage: [], replicas: 3, scoped: true } as any,
    log: { size: M, partitions: M, heads }, marks: {}, versions: 1000 + i,
    pending: 0, orphans: [], subscriptions: 0, observing: false, peers: {},
  } as InspectSnapshot))
}

const owner = (_r: string, k: string) => ':5000'
const replicas = (_r: string, _k: string) => [':5000', ':5001', ':5002']

//! a big cluster (24 nodes × 500 partitions = 12k holder entries) folds in well under a frame
// Measured median ~8ms here; threshold 15ms (~2x) absorbs box noise while still
// catching an accidental superlinear regression. Don't widen to pass — investigate.
test('foldSnapshots stays cheap over a large cluster', () => {
  const snaps = cluster(24, 500)
  const ms = bench.time(() => { foldSnapshots(snaps, { owner, replicas }) })
  ok(ms < 15, `fold 24×500 took ${ms.toFixed(2)}ms (threshold 15ms)`)
})

//! foldDivergence over a healthy cluster scans every partition × node but flags nothing — the common case
// Each node's sample is the version-sample-CAP worth of keys (the drill bounds it), so the
// comparison is bounded by the cap, not the total keyspace. Measured ~1ms; threshold 8ms.
test('foldDivergence stays cheap over a converged cluster', () => {
  const N = 24, M = 200
  const file = foldSnapshots(cluster(N, M), { owner, replicas })
  // every node holds all M partitions at the SAME stamp → no divergence (the loop runs in full)
  const sample: VersionSample = {}
  for (let j = 0; j < M; j++) sample['p' + j] = { epoch: 4, seq: j, origin: 'o' }
  const samples = new Map<string, VersionSample>()
  for (let i = 0; i < N; i++) samples.set(':' + (5000 + i), sample)
  // owner is ':5000' for every partition → its sample is the reference
  const ms = bench.time(() => { foldDivergence(file, samples) })
  ok(file.resources[0].partitions.every((p) => p.status !== 'diverged'), 'healthy → no divergence')
  ok(ms < 8, `foldDivergence ${N}×${M} took ${ms.toFixed(2)}ms (threshold 8ms)`)
})
