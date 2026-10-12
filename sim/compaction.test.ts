//! DESIGN-SCALE stage 3 (2026-10-12): compaction on scoped nodes, under the executive — the §7 row's sim tests and
// its counted pin P4. The kernel rule (C1-C4, the frontier over the holders' crash-stable attested marks) is pinned
// by hand-driven events in kernel/scoped.test.ts; here the same bytes run on seeded schedules with the scale
// monitors armed (M2 frontier-sound judges every replaced lane; M5 floor-truth every floor advance and a restored
// node's whole seed), so what this file proves is the rule's EFFECT: a durable holder restored from a compacted
// disk, a spoke fed across a pass, and the memory bound the record is for.
//
//   restore   a durable holder restarted after its lanes compacted and its WAL swapped comes back with the floors
//             it had (the boot record's seed, rewritten at the swap's echo, sits above every gap the pass opened),
//             re-latches nothing, and M5 is green on the whole seed. Red without the boot rewrite at the echo: the
//             seed is stale, replay chains from it, stalls at the first compacted gap, the reborn announces floors
//             below its content and latches a holder for rows it holds.
//   spoke     a client of a scoped server across its feeder's passes: zero resyncs (C4 keeps the lane's last entry,
//             so the feeder's digest tail never regresses), the spoke mirrors its feeder (M12), screen = kernel.
// The counted pin P4 (50,000 updates over 500 cells at n=8 R=3) lives in sim/scale.perf.ts with the other
// expensive counted pins: it takes about a minute here.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { formed } from './harness.ts'
import { mesh, type MeshOpts } from './scoped-sweep.ts'
import { scopedConverged, exactlyR, floorsAgree, spokeMirror, screenMatches } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { REC } from '../kernel/env.ts'
import { SCOPE } from '../kernel/scope.ts'
import type { Node } from '../kernel/node.ts'

const count = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length
//! floorsOf — a node's possession floors for the partitions it holds, as 'lane|partition' → s
const floorsOf = (n: Node): Map<string, number> => {
  const out = new Map<string, number>()
  for (const [o, d] of n.streams) for (const [p, pe] of d.parts ?? []) if (n.scope!.entries.get(p)?.state === SCOPE.held && pe.s > 0) out.set(o + '|' + p, pe.s)
  return out
}
//! hot — `count` writes over `cells` row cells, round-robin over the members, one every `gap` ms: lanes pass compactAt
export const hot = (sim: Sim, nodes: Node[], cells: number, count: number, gap: number) => {
  for (let i = 0; i < count; i++) sim.post(nodes[i % nodes.length].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['c' + (i % cells)], value: i }] }, i * gap)
}

test('a durable holder restarted after compaction restores its floors from the seed and does not re-latch: the boot record rewritten at the swap\'s echo covers the gaps the pass opened; M2 and M5 green throughout', () => {
  const sim = new Sim(31)
  const o: MeshOpts = { replicas: 2, durable: true, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 1] } }
  const nodes = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 3000 })
  assert.deepEqual(sim.violations, [], 'lawful so far')
  for (const n of nodes) {
    assert.ok(count(n, JK.compacted) > 0, `${n.uuid} compacted (${count(n, JK.compacted)} rows)`)
    assert.ok(count(n, JK.snapshot) > 0, `${n.uuid} swapped its WAL`)
  }
  const victim = nodes[1]
  const before = floorsOf(victim)
  assert.ok(before.size >= 2, `n02 holds floors for ${before.size} (lane, partition) pairs`)
  //! every lane of n02 compacted below its floor: a restore that chained from a stale seed would stall under it
  const gaps = [...victim.logs].filter(([o, lane]) => { const f = Math.max(...[...before].filter(([k]) => k.startsWith(o + '|')).map(([, s]) => s), 0); return lane.length > 0 && lane[0].seq < f && lane.length < f }).length
  assert.ok(gaps >= 1, `${gaps} lane(s) of n02 hold fewer entries than their floor spans: the pass opened gaps the seed must cover`)
  const reborn = sim.restart('n02')
  sim.run({ until: sim.now + 3000 })
  assert.equal(reborn.armed, true)
  const after = floorsOf(reborn)
  for (const [k, s] of before) assert.equal(after.get(k), s, `${k}: the floor restored from the seed equals the pre-crash floor`)
  assert.equal(count(reborn, JK.acquireStart), 0, 'no re-latch: the reborn announced the floors it holds, nobody found it behind')
  assert.equal(count(reborn, JK.walHole), 0)
  assert.deepEqual(sim.violations, [], 'M5 (the whole seed at start), M2 and every per-event monitor green')
  assert.equal(scopedConverged(sim), null)
  assert.equal(exactlyR(sim), null)
  assert.equal(floorsAgree(sim), null)
})

test('a client on a scoped server across a compaction pass: zero resyncs (the lane\'s last entry stays, so the feeder\'s digest tail never regresses), the spoke mirrors its feeder, screen = kernel', () => {
  const sim = new Sim(32)
  const nodes = mesh(sim, 3, { replicas: 2, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 1] } })
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  const spoke = sim.add({ uuid: 's1', listen: 'sim:s1', hosts: nodes.map((n) => `sim:${n.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
  sim.post('s1', { kind: 'start' }, 0)
  sim.run({ until: sim.now + 500 })
  assert.notEqual(spoke.primary, null, 'the spoke has a feeder')
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 3000 })
  const feeder = sim.nodes.get(spoke.links.get(spoke.primary!)!.uuid)!
  assert.ok(count(feeder, JK.compacted) > 0, `the feeder ${feeder.uuid} compacted (${count(feeder, JK.compacted)} rows)`)
  assert.equal(count(spoke, JK.resync), 0, 'zero resyncs across the passes')
  assert.equal(spokeMirror(sim, 's1'), null, 'M12: the spoke holds exactly its feeder\'s held subset')
  assert.equal(screenMatches(sim, 's1'), null)
  assert.deepEqual(sim.violations, [])
})
