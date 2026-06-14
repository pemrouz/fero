// Perf sibling for the P1 fold. foldSnapshots runs on the capture path (~1/poll),
// never per write/replicate — but a large cluster (many nodes × many partitions)
// folds O(nodes × partitions) holder bookkeeping, so we guard it stays cheap.
// Median-of-5 (one untimed warmup) per #utils bench; don't widen to pass.

import { test } from 'node:test'
import { ok } from 'node:assert/strict'
import { bench } from '#utils'
import type { InspectSnapshot } from '../../resource/inspect.ts'
import { foldSnapshots, foldDivergence, foldOwnership, type VersionSample } from './export.ts'
import { DHT } from '../../transport/dht.ts'

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
// Each node's sample is the version-sample-CAP worth of keys (the drill bounds it), so the comparison
// is bounded by the cap, not the total keyspace. COLD path (once per capture, never on the data hot
// path), so — per the inspect.perf philosophy — the threshold flags a GROSS regression, not a tight
// latency budget. Quiet median ~3.3ms; threshold 15ms (~4-5x) tolerates a loaded box without flaking.
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
  console.log(`  foldDivergence ${N}×${M}: ${ms.toFixed(2)}ms`)
  ok(file.resources[0].partitions.every((p) => p.status !== 'diverged'), 'healthy → no divergence')
  ok(ms < 15, `foldDivergence ${N}×${M} took ${ms.toFixed(2)}ms (threshold 15ms)`)
})

//! foldOwnership rebuilds a REAL ring per past view (the dominant cost) then derives owner per partition
// 16 views (the history cap) × a real DHT build (members × 200 vnodes) + M owner() lookups each. Bounded
// by the cap. COLD path (once per capture); quiet median ~10.5ms; threshold 30ms (~3x) so the per-view
// DHT-build cost doesn't flake on a loaded box while still catching a gross/superlinear regression.
test('foldOwnership stays bounded over the full view-history cap', () => {
  const N = 5, M = 200, EPOCHS = 16
  const members = Array.from({ length: N }, (_, i) => ':' + (5000 + i))
  const file = foldSnapshots(cluster(N, M), { owner, replicas })
  // pin every partition's owner to the default ring's verdict so the guard passes (real derivation)
  const ref = new DHT(); for (const m of members) ref.add(m)
  for (const p of file.resources[0].partitions) p.owner = ref.owner(p.name)
  const views = new Map<number, string[]>()
  for (let e = 1; e <= EPOCHS; e++) views.set(e, members)
  const buildRing = (ms2: string[]) => { const ring = new DHT(); for (const m of ms2) ring.add(m); return (k: string) => ring.owner(k) }
  const t = bench.time(() => { foldOwnership(file, views, buildRing) })
  console.log(`  foldOwnership ${EPOCHS}×${M}: ${t.toFixed(2)}ms`)
  ok(file.resources[0].epochs!.length === EPOCHS, 'all epochs derived')
  ok(t < 30, `foldOwnership ${EPOCHS}×${M} took ${t.toFixed(2)}ms (threshold 30ms)`)
})
