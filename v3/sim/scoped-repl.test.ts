//! Tier-2 M6 slice-3a suite: scoped replication under the sim — STATIC membership (the handover
// protocol is 3b's; here the R-set never changes after formation, so the invariant core is exactly:
// commits fan out to holders only, the inbound gate holds the line, epoch-0 data freezes into orphans
// at the arming install, and holders converge partition-wise. The exactly-R and scoped-convergence
// horizons plus the per-event scoped monitors (lawful-holding, orphan-frozen) run on every scenario.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { drained, exactlyR, scopedConverged } from './monitors.ts'
import { SCOPE } from '../kernel/scope.ts'
import { JK } from '../kernel/journal.ts'
import { REC } from '../kernel/env.ts'
import { partitionOf } from '../kernel/env.ts'

test('R=2 of 5: post-formation writes land on exactly their R-sets — holders converge, non-holders hold nothing, wire scope enforced', () => {
  const sim = new Sim(11)
  const members = cluster(sim, 5, { heartbeatMs: 50, replicas: 2 })
  sim.run({ until: 1500 })
  assert.ok(formed(members), 'the mesh formed')
  for (const n of members) assert.ok(n.armed, `${n.uuid} armed (scoped ∧ committed view)`)
  writes(sim, members, 40, 400)
  sim.run({ until: 10_000 })
  assert.deepEqual(sim.violations, [], 'per-event monitors green (incl. scoped-lawful-holding, orphan-frozen)')
  assert.equal(exactlyR(sim), null, 'every partition held by exactly its R-set')
  assert.equal(scopedConverged(sim), null, 'holders agree cell-for-cell per partition')
  assert.equal(drained(sim), null)
  //! engagement guard: scoping actually happened — some node holds a strict subset of the data
  const parts = new Set<string>()
  for (const n of members) for (const [p] of n.scope!.entries) parts.add(p)
  assert.ok(parts.size >= 3, `enough distinct partitions to scope (${parts.size})`)
  const holdCounts = members.map((n) => [...n.scope!.entries.values()].filter((e) => e.state === SCOPE.held).length)
  assert.ok(holdCounts.some((c) => c < parts.size), `no node holds everything (held per node: ${holdCounts.join(',')})`)
})

test('epoch-0 inheritance: pre-formation data freezes into orphans at the arming install; a later write moves holders while the orphan stays stale', () => {
  const sim = new Sim(23)
  const members = cluster(sim, 4, { heartbeatMs: 50, replicas: 2 })
  //! epoch-0 writes: posted before any view can commit — full broadcast puts them on ALL FOUR nodes
  sim.post(members[0].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['inherit', 'v'], value: 'old' }] }, 1)
  sim.run({ until: 2500 })
  assert.ok(formed(members) && members.every((n) => n.armed), 'formed + armed')
  assert.deepEqual(sim.violations, [])
  //! classification: the ring's two holders keep it HELD; the other two hold FROZEN orphans
  const ring = members[0].writes.ring
  const lawful = new Set(ring.holders('inherit', 2))
  assert.equal(lawful.size, 2)
  for (const n of members) {
    const e = n.scope!.entries.get('inherit')!
    assert.ok(e, `${n.uuid} classified 'inherit' at the install`)
    assert.equal(e.state, lawful.has(n.uuid) ? SCOPE.held : SCOPE.orphan, `${n.uuid} classified lawfully`)
    assert.equal(n.state.get(JSON.stringify(['inherit', 'v'])), 'old', `${n.uuid} kept the epoch-0 value`)
  }
  const orphanNode = members.find((n) => !lawful.has(n.uuid))!
  assert.ok(orphanNode.journal.read().some((e) => e.kind === JK.orphaned && e.a === 'inherit'), 'the freeze journaled')
  //! a post-arm write to the partition: the OWNER commits, holders converge, the orphan stays frozen
  const owner = members.find((n) => n.uuid === ring.holders('inherit', 2)[0])!
  sim.post(owner.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['inherit', 'v'], value: 'new' }] }, 0)
  sim.run({ until: 6000 })
  assert.deepEqual(sim.violations, [], 'orphan-frozen stayed empty — nothing fed the frozen copy')
  for (const n of members) {
    const v = n.state.get(JSON.stringify(['inherit', 'v']))
    if (lawful.has(n.uuid)) assert.equal(v, 'new', `holder ${n.uuid} converged`)
    else assert.equal(v, 'old', `orphan ${n.uuid} is FROZEN — stale by design until shed (3b)`)
  }
  assert.equal(exactlyR(sim), null)
  assert.equal(scopedConverged(sim), null)
})

test('mini-sweep: 30 seeds of R=2/5 with dup+delay faults and a mid-run partition/heal — exactly-R, scoped convergence, zero violations', () => {
  for (let seed = 700; seed < 730; seed++) {
    const sim = new Sim(seed)
    const members = cluster(sim, 5, { heartbeatMs: 50, replicas: 2, fault: { delay: [1, 15], dupP: 0.08 } })
    sim.run({ until: 2000 })
    assert.ok(formed(members), `seed ${seed}: formed under faults`)
    assert.ok(members.every((n) => n.armed), `seed ${seed}: armed`)
    writes(sim, members, 30, 500)
    //! cut one PAIR mid-workload and heal it — AE over the scoped answer filter is the healing path
    const a = members[Math.floor(sim.rng() * 5)].uuid
    let b = members[Math.floor(sim.rng() * 5)].uuid
    if (b === a) b = members[(members.findIndex((n) => n.uuid === a) + 1) % 5].uuid
    sim.at(300, () => sim.partition(a, b))
    sim.at(900, () => sim.heal(a, b))
    sim.run({ until: 15_000 })
    assert.deepEqual(sim.violations, [], `seed ${seed}: monitors green`)
    assert.equal(exactlyR(sim), null, `seed ${seed}: exactly-R`)
    assert.equal(scopedConverged(sim), null, `seed ${seed}: holders converged`)
    assert.equal(drained(sim), null, `seed ${seed}: drained`)
  }
})
