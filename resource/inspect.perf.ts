// makeSnapshot() is the L4 pull spine — COLD path: built once per node, called once
// per observe poll (~1/s), NEVER per write/replicate. So the real perf guarantee for
// Slice 0 is "the write path is unchanged" — that stays under resource/index.perf.ts
// (the pull adds no hot-path code; the gate is a construction-time closure nothing
// invokes on the write path).
//
// This file bounds the per-POLL cost instead: building one snapshot over a
// realistically-LARGE node (1000 origins in the dedup digest, 200 peers, 200
// partitions) must stay cheap, so a poll never stalls and a future fat snapshot is
// caught early. Median-of-5 + warmup, like every *.perf.ts.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { makeSnapshot, VERSION_SAMPLE_CAP, type SnapshotDeps } from './inspect.ts'
import { bench } from '#utils'

const ORIGINS = 1000
const PEERS = 200
const PARTS = 200

//! A deliberately large node: 1000-entry dedup digest, 200 peers, 200 partitions — the cold-path worst case.
const bigDeps = (): SnapshotDeps => {
  const seen = new Map<string, number>()
  for (let i = 0; i < ORIGINS; i++) seen.set('origin-' + i, i)
  const heads: Record<string, number> = {}
  const partitions: string[] = []
  for (let i = 0; i < PARTS; i++) {
    heads['p' + i] = i
    partitions.push('p' + i)
  }
  const peers: Record<string, any> = {}
  const members: string[] = []
  for (let i = 0; i < PEERS; i++) {
    const a = '10.0.0.' + i + ':3000'
    peers[a] = { address: a, host: '10.0.0.' + i, port: 3000, role: 'server', status: 3, uuid: 'u' + i }
    members.push(a)
  }
  const versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  for (let i = 0; i < ORIGINS; i++) versions.set('k' + i, { epoch: 4, seq: i, origin: 'o0' })
  // coverage is pre-built ONCE: this test measures snapshot ASSEMBLY, not the ring-sampling
  // cost (that's guarded directly in transport/dht.perf.ts via coverage()).
  const cov = Array.from({ length: 120 }, (_, i) => i % PEERS)
  return {
    name: 'big',
    cluster: { uuid: 'u0', me: members[0], epoch: 12, members, writable: true } as any,
    ringSnapshot: () => ({ members, vnodes: 200, coverage: cov }),
    peers: () => peers,
    log: { size: ORIGINS, partitions: () => partitions, heads: () => heads } as any,
    seen,
    versions,
    pending: { length: 0 },
    orphans: new Set<string>(),
    servedCount: () => 100,
    // worst case: a node serving SUBS_CAP (100) subscriptions — servedSubs builds the capped sample
    // FRESH each poll (as dispatch's accessor does), so the assembly threshold below honestly covers
    // the per-poll subscription-topology cost too (it's the only new per-poll work P3 adds).
    servedSubs: () => Array.from({ length: 100 }, (_, i) => ({ to: '10.0.1.' + i + ':5000', method: 'read', key: 'k' + i, kind: 'forward', owner: members[i % PEERS] })),
    observing: () => false,
    R: 3,
    scoped: true,
  }
}

test('makeSnapshot() — 1000 polls over a large node (1000 origins · 200 peers · 200 partitions)', () => {
  const snap = makeSnapshot(bigDeps())
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < 1000; i++) sink += snap().peers ? 1 : 0
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  1000 large snapshots: ${elapsed.toFixed(3)}ms (${(elapsed).toFixed(3)}µs each)`)
  // One big snapshot is O(origins + peers + partitions) of plain copies — the dominant
  // costs are Object.fromEntries over the 1000-entry digest and the 200-peer row copy.
  // COLD path (one snapshot per node per ~1s poll), so even a half-millisecond worst-case
  // is amply fine. This absolute number is MACHINE-VARIANCE-SENSITIVE: the same assembly
  // measured ~250µs on a quiet box and ~350–420µs on a busy one. A same-process A/B
  // confirmed the ring-coverage field adds only ~4% — the rest is box drift (the precise
  // coverage-generation cost is guarded tightly in transport/dht.perf.ts). So the threshold
  // carries generous headroom to flag a true 2× blowup (>~800µs) without flaking on a
  // loaded dev box — it is NOT a tight latency target (cold path doesn't need one).
  ok(elapsed < 700, `1000 large snapshots took ${elapsed.toFixed(3)}ms (threshold 700ms)`)
})

test('makeSnapshot({sample}) — a drill-down over a large version map stays bounded', () => {
  // The sample is a DRILL-DOWN (forensic), not the steady poll. Worst case it scans the
  // whole version map to collect a partition's keys, capped at VERSION_SAMPLE_CAP — so the
  // cost is O(versions) scan + O(cap) allocation, paid only when a sample is requested.
  const deps = bigDeps()
  for (let i = 0; i < VERSION_SAMPLE_CAP * 2; i++) deps.versions.set('hot\x00f' + i, { epoch: 4, seq: i, origin: 'oH' })
  const snap = makeSnapshot(deps)
  // the cap holds no matter how many keys match
  ok(Object.keys(snap({ sample: ['hot'] }).versionSample!).length === VERSION_SAMPLE_CAP, 'sample capped')
  const elapsed = bench.time(() => {
    let sink = 0
    for (let i = 0; i < 1000; i++) sink += snap({ sample: ['hot'] }).versionSample ? 1 : 0
    if (sink === 0) throw new Error('sink')
  })
  console.log(`  1000 sampled drills (cap ${VERSION_SAMPLE_CAP} over ${ORIGINS + VERSION_SAMPLE_CAP * 2} keys): ${elapsed.toFixed(3)}ms`)
  // 1000 drills × (~1200-entry scan + 200 small allocs). Drill-down path, so generous
  // headroom over the assembly threshold; flags a real superlinear regression, not box drift.
  ok(elapsed < 1200, `1000 sampled drills took ${elapsed.toFixed(3)}ms (threshold 1200ms)`)
})
