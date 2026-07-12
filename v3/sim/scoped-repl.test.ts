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
import type { Node } from '../kernel/node.ts'
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

test('epoch-0 inheritance: pre-formation data freezes into orphans at the arming install, then DRAINS — the shed lifecycle end-to-end', () => {
  const sim = new Sim(23)
  const members = cluster(sim, 4, { heartbeatMs: 50, replicas: 2 })
  //! epoch-0 writes: posted before any view can commit — full broadcast puts them on ALL FOUR nodes
  sim.post(members[0].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['inherit', 'v'], value: 'old' }] }, 1)
  sim.run({ until: 6000 })
  assert.ok(formed(members) && members.every((n) => n.armed), 'formed + armed')
  assert.deepEqual(sim.violations, [], 'incl. orphan-frozen: nothing fed a frozen copy on its way out')
  const ring = members[0].writes.ring
  const lawful = new Set(ring.holders('inherit', 2))
  assert.equal(lawful.size, 2)
  const cell = JSON.stringify(['inherit', 'v'])
  for (const n of members) {
    if (lawful.has(n.uuid)) {
      assert.equal(n.scope!.held('inherit'), true, `holder ${n.uuid} kept the partition`)
      assert.equal(n.state.get(cell), 'old', `holder ${n.uuid} kept the epoch-0 value`)
    } else {
      //! the non-holder's FULL lifecycle: orphaned at the install (the freeze), then SHED once every
      // current holder attested coverage over the handshake — data, floors, and the entry all gone
      const journal = n.journal.read()
      assert.ok(journal.some((e) => e.kind === JK.orphaned && e.a === 'inherit'), `${n.uuid} froze at the install`)
      assert.ok(journal.some((e) => e.kind === JK.shed && e.a === 'inherit'), `${n.uuid} shed after coverage was attested`)
      assert.equal(n.scope!.entries.get('inherit'), undefined, `${n.uuid} dropped the entry`)
      assert.equal(n.state.has(cell), false, `${n.uuid} dropped the data`)
      for (const [, d] of n.streams) assert.equal(d.parts?.get('inherit'), undefined, `${n.uuid} dropped the floors`)
    }
  }
  //! a post-shed write converges among holders; the departed copies stay gone (exactly-R both ways)
  const owner = members.find((n) => n.uuid === ring.holders('inherit', 2)[0])!
  sim.post(owner.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['inherit', 'v'], value: 'new' }] }, 0)
  sim.run({ until: 10_000 })
  assert.deepEqual(sim.violations, [])
  for (const n of members) {
    if (lawful.has(n.uuid)) assert.equal(n.state.get(cell), 'new', `holder ${n.uuid} converged`)
    else assert.equal(n.state.has(cell), false, `${n.uuid} stays clean post-shed`)
  }
  assert.equal(exactlyR(sim), null)
  assert.equal(scopedConverged(sim), null)
})

//! the global fold as its HOLDERS see it: cell → value, drawn only from nodes holding the partition.
const holderUnion = (members: Node[]): Map<string, unknown> => {
  const union = new Map<string, unknown>()
  for (const n of members) {
    if (!n.scope) continue
    for (const [k, v] of n.state) {
      const p = (JSON.parse(k) as string[])[0] ?? ''
      if (n.scope.held(p)) union.set(k, v)
    }
  }
  return union
}

test('GROW past R: a join re-scopes ownership — new holders ACQUIRE through one teacher, old holders shed, no cell is lost', () => {
  const sim = new Sim(31)
  const members = cluster(sim, 3, { heartbeatMs: 50, replicas: 2 })
  sim.run({ until: 1500 })
  assert.ok(formed(members) && members.every((n) => n.armed))
  writes(sim, members, 30, 300)
  sim.run({ until: 6000 })
  assert.deepEqual(sim.violations, [])
  const before = holderUnion(members)
  assert.ok(before.size >= 10, `enough cells to move (${before.size})`)
  //! the join: a fourth scoped node dials in mid-life — membership ballots it into epoch 2, the ring
  // moves ~1/4 of the partitions onto it, and every moved partition must ACQUIRE (the no-bypass rule)
  const joiner = sim.add({
    uuid: 'n99', listen: 'sim:n99', hosts: members.map((m) => `sim:${m.uuid}`),
    heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, replicas: 2,
  })
  sim.post('n99', { kind: 'start' }, 0)
  sim.run({ until: 20_000 })
  const all = [...members, joiner]
  assert.ok(all.every((n) => n.epoch >= 2), `the join committed (epochs: ${all.map((n) => n.epoch).join(',')})`)
  assert.deepEqual(sim.violations, [], 'monitors green across the handover')
  assert.equal(exactlyR(sim), null, 'exactly-R restored at the new epoch')
  assert.equal(scopedConverged(sim), null)
  assert.equal(drained(sim), null)
  //! NOTE on the healing path: while scoped compaction is PINNED (kernel/log.ts), the joiner may
  // complete moved partitions through ring-gated AE (multi-source is provably safe with no
  // compaction — the H3 resurrection needs differently-compacted teachers) — so a fold is not
  // REQUIRED here; the latch legs are driven deterministically in kernel/scoped.test.ts. What IS
  // required: duty restored (exactly-R), nothing lost (the union oracle below), sheds gated on real
  // per-lane coverage (an orphan's old-lane floors are satisfiable only by actual history arriving).
  //! sheds ran where duty left (growth moves partitions OFF old holders)
  const sheds = all.flatMap((n) => n.journal.read().filter((e) => e.kind === JK.shed))
  assert.ok(sheds.length > 0, 'old holders shed once the new set attested coverage')
  //! THE data-intactness oracle: every pre-growth cell survives at its post-growth holders, verbatim
  const after = holderUnion(all)
  for (const [k, v] of before)
    assert.deepEqual(after.get(k), v, `cell ${k} lost or changed across the handover`)
})

test('H1 — an orphan crashes mid-shed (durable): the boot record re-derives the frozen orphan, the poll resumes, the re-shed completes', () => {
  const sim = new Sim(41)
  const members = cluster(sim, 3, { heartbeatMs: 50, replicas: 2, durable: true })
  sim.run({ until: 1500 })
  assert.ok(formed(members) && members.every((n) => n.armed))
  writes(sim, members, 20, 300)
  sim.run({ until: 5000 })
  //! grow: the join moves partitions; orphans appear at the old holders
  const joiner = sim.add({
    uuid: 'n99', listen: 'sim:n99', hosts: members.map((m) => `sim:${m.uuid}`),
    heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, replicas: 2, durable: true,
  })
  sim.post('n99', { kind: 'start' }, 0)
  //! freeze the victim mid-lifecycle: every handshake frame touching n01 dies with a re-armed sever
  // through the install window (marks feed from BOTH directions — a peer's own HAVEQ announce is an
  // attestation too), then the full cut holds the freeze; kill −9 and restart from its own disk
  const others = [...members.slice(1), joiner].map((m) => m.uuid)
  for (let t = 0; t <= 650; t += 25)
    sim.at(t, () => {
      for (const u of others) {
        sim.severOnFrame('n01', u, 19 /* VERB.HAVEQ */)
        sim.severOnFrame(u, 'n01', 19 /* VERB.HAVEQ */)
      }
    })
  sim.at(675, () => { for (const m of [...members, joiner]) if (m.uuid !== 'n01') sim.partition('n01', m.uuid) })
  sim.run({ until: 8000 })
  const old = members[0]
  const orphanedPre = old.journal.read().filter((e) => e.kind === JK.orphaned).map((e) => e.a as string)
  const shedPre = new Set(old.journal.read().filter((e) => e.kind === JK.shed).map((e) => e.a as string))
  const frozenAtCrash = orphanedPre.filter((p) => !shedPre.has(p))
  const reborn = sim.restart('n01')
  sim.run({ until: 8200 })
  //! BOTH crash legs, decided by where the crash landed (the boot record is the authority):
  // shed-then-crash ⇒ the WAL rows for the shed partition replay-gate away (no resurrection);
  // crash-mid-shed ⇒ the orphan re-derives FROZEN from (boot record ∪ restored ring) pre-network
  for (const p of shedPre)
    assert.equal(reborn.scope!.entries.get(p), undefined, `${p} shed pre-crash — its WAL rows must not resurrect it`)
  for (const p of frozenAtCrash)
    assert.equal(reborn.scope!.entries.get(p)?.state, SCOPE.orphan, `${p} was mid-shed at the crash — re-derived frozen`)
  assert.ok(frozenAtCrash.length > 0, `the sever+cut froze at least one shed mid-flight (orphaned: ${orphanedPre.length}, shed pre-crash: ${shedPre.size})`)
  //! heal: the poll resumes against the current holders, the stateless predicate re-fires, re-shed
  for (const m of [...members, joiner]) if (m.uuid !== 'n01') sim.heal('n01', m.uuid)
  sim.run({ until: 30_000 })
  const all = [members[1], members[2], joiner, reborn]
  assert.deepEqual(sim.violations, [], 'monitors green across crash + restore + re-shed')
  assert.equal(exactlyR(sim), null)
  assert.equal(scopedConverged(sim), null)
  assert.equal([...reborn.scope!.entries.values()].filter((e) => e.state === SCOPE.orphan).length, 0,
    'every restored orphan drained — the crash never wedges a shed')
  assert.ok(all.every((n) => n.epoch >= 2))
})

test('CHURN mini-sweep: 25 seeds of grow + member restart + partition/heal under faults — the full handover lifecycle converges every time', () => {
  for (let seed = 800; seed < 825; seed++) {
    const sim = new Sim(seed)
    const members = cluster(sim, 4, { heartbeatMs: 50, replicas: 2, durable: true, fault: { delay: [1, 12], dupP: 0.05 } })
    sim.run({ until: 2000 })
    assert.ok(formed(members), `seed ${seed}: formed`)
    writes(sim, members, 25, 400)
    //! the churn schedule: a join mid-workload, a member crash+restore, one partition/heal pair
    sim.at(300, () => {
      sim.add({
        uuid: 'n99', listen: 'sim:n99', hosts: members.map((m) => `sim:${m.uuid}`),
        heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16, replicas: 2, durable: true,
      })
      sim.post('n99', { kind: 'start' }, 0)
    })
    const victim = members[1 + Math.floor(sim.rng() * 3)].uuid
    sim.at(1200, () => sim.restart(victim))
    const a = members[0].uuid
    sim.at(600, () => sim.partition(a, victim))
    sim.at(1000, () => sim.heal(a, victim))
    sim.run({ until: 40_000 })
    assert.deepEqual(sim.violations, [], `seed ${seed}: monitors green through the churn`)
    assert.equal(exactlyR(sim), null, `seed ${seed}: exactly-R restored`)
    assert.equal(scopedConverged(sim), null, `seed ${seed}: holders converged`)
    //! every orphan drained: churn must never wedge a shed (H7's liveness, minus the true laggard)
    for (const [id, n] of sim.nodes)
      assert.equal([...n.scope!.entries.values()].filter((e) => e.state === SCOPE.orphan).length, 0,
        `seed ${seed}: ${id} drained its orphans`)
  }
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
