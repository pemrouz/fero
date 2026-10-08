//! Tier-2 write-pipeline suite: v2's four AA conflict sources (DECISIONS AA — the complete list of
// single-writer violators) + lost-frame ambiguity, EACH as a named fault schedule, run end-to-end
// with the single-writer monitor armed. v2 discovered these one production audit at a time; here
// each is a deterministic trajectory the sweep re-checks forever. The v3 answers, per source:
//   AA#1 never-drop fallback → deleted: a forwarder RETRIES (cid-deduped), never self-commits.
//   AA#2 validate-nothing commitForwarded → the owner validates (owner + attemptEpoch + gate) or NACKs.
//   AA#3 flush re-stamp at commit → parked attempts re-resolve OWNERSHIP at the flush boundary and
//        forward; the open stale-ring residual dies at the owner's validation (mis-route ⇒ NACK).
//   AA#4 restore-boot solo-owner collision → a restored node is REJOINING (read-only) until a live
//        view confirms; its parked writes then owner-route at the merged epoch.
// One schedule (aa3) also runs as a MUTANT — a deliberately-v2-shaped flush — proving the monitor
// actually catches the class (the V1d pattern, applied to M3's invariant).

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { VERB } from '../kernel/codec.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { Node } from '../kernel/node.ts'
import type { Writes } from '../kernel/write.ts'

const key = (k: string) => JSON.stringify([k])
const pin = (nodes: Node[], k: string, owner: string) => { for (const n of nodes) n.writes.ring.place(k, owner) }
const jk = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind)

test('AA#1 lost-ACK: the owner committed but the WACK died with the link — the retry dedups; NEVER a second origin', () => {
  const sim = new Sim(61)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  assert.equal(nodes[0].epoch, 1)
  pin(nodes, 'aa1', 'n02')
  //! the trap: the very WACK answering our forward dies IN the kernel buffer as the link severs
  sim.severOnFrame('n02', 'n01', VERB.WACK)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['aa1'], value: 'once' }] })
  sim.run({ until: 3000 }) // redial reconnects; EITHER replication-as-ACK clears the route (the record
  // carries its attempt identity) OR the tick-clock retransmit hits the owner's dedup window — both
  // complete the route without a second commit
  assert.equal(nodes[1].logs.get('n02')!.filter((e) => JSON.stringify(e.rec.key) === key('aa1')).length, 1, 'exactly-once at the commit site')
  assert.equal(nodes[0].writes.pending.size, 0, 'the route completed despite the lost WACK')
  assert.equal(jk(nodes[0], JK.writeAck).length, 1, 'the issuer observed the commit ONCE — replication-ACK or the re-sent WACK, whichever landed first; the other clears nothing and journals nothing')
  assert.equal(nodes[0].logs.get('n01'), undefined, 'v2 would have fallen back to a LOCAL commit here — that path no longer exists')
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [], 'single-writer + attempt-exactly-once held through the whole ambiguity window')
})

test('lost-WRITE: the forward itself dies with the link — the retry delivers; committed once, no dup needed', () => {
  const sim = new Sim(62)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  pin(nodes, 'lw', 'n02')
  sim.severOnFrame('n01', 'n02', VERB.WRITE)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['lw'], value: 'v' }] })
  sim.run({ until: 3000 })
  assert.equal(nodes[1].logs.get('n02')!.filter((e) => JSON.stringify(e.rec.key) === key('lw')).length, 1)
  assert.equal(jk(nodes[1], JK.writeDup).length, 0, 'first delivery — nothing to dedup')
  assert.equal(nodes[0].writes.pending.size, 0)
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [])
})

test('AA#2 the view-install window: a laggard\'s writes crossing an eviction commit land exactly-once at the owner, at the committed epoch', () => {
  //! v2's window was an issuer routing to an owner that had not yet validated ANYTHING (commitForwarded
  // — DECISIONS AA #2). v3 attacks it twice over. First, the window is structurally squeezed shut on
  // honest paths by FOUR independent guards: (1) FIFO links — a view shipped before a forward cannot be
  // overtaken; (2) install-time flooding — every install re-announces one hop onward; (3) view-on-admit
  // — every re-admitted link carries the view before anything else the peer sends on it; (4) the
  // minority gate — a lagged node cannot flush until TWO member links re-admit, and the first admit's
  // view lands during the redial stagger before the second admit opens the gate. (Building this
  // schedule tried five fault constructions; every one was beaten by one of the four.) Second, if a
  // stale forward ever DOES land — frame loss aligning with the flush, a future non-FIFO shell — the
  // owner validates and answers a typed stale-epoch NACK; that leg is pinned deterministically in
  // kernel/write.test.ts (the NACK → re-park → re-stamp → re-forward loop). This schedule asserts the
  // end-to-end fact the monitor demands: a laggard's parked writes crossing a real eviction commit
  // exactly-once, at the owner, at the committed epoch — never locally, never at a stale one.
  const sim = new Sim(63)
  const nodes = cluster(sim, 5, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  assert.deepEqual(nodes.map((n) => n.epoch), [1, 1, 1, 1, 1])
  pin(nodes, 'aa2', 'n03')
  //! n05 goes dark for good → its give-up (the member chain, MEMBER_REDIALS 5 at base 20: ≈ 1205 for this seed)
  // triggers the eviction ballot; view 2 commits ≈ 1260 everywhere but n02
  for (const other of ['n01', 'n02', 'n03', 'n04']) sim.partition('n05', other)
  //! n02 is cut just before the commit — a member of the new view that will MISS the install (at() and
  // post() delays are relative to now = 500: the cut lands at 1150, the writes at 1250 and 1300)
  sim.at(650, () => { for (const other of ['n01', 'n03', 'n04']) sim.partition('n02', other) })
  sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: ['aa2'], value: 'laggard' }] }, 750)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['aa2'], value: 'current' }] }, 800)
  //! probe and heal BEFORE n01's chain to n02 gives up (≈ 1855 for this seed: the cut at 1150, then the full
  // member chain of five tries; the view-2 install at 1210 leaves n02 to that running chain — before
  // 2026-10-09 it dialed n02 too, the failed dial forked the chain into two timer lines that shared the
  // five tries, and the give-up came at ≈ 1420): n02 must stay a member of view 2
  sim.run({ until: 1350 })
  assert.deepEqual(nodes.filter((n) => !['n02', 'n05'].includes(n.uuid)).map((n) => n.epoch), [2, 2, 2], 'view 2 committed while n02 was away')
  assert.equal(nodes[1].epoch, 1, 'n02 still holds view 1 — the stale issuer')
  assert.equal(nodes[1].writes.pending.size, 1, 'its write is parked under the minority gate')
  //! heal n02: its parked write must cross the epoch boundary through the guards above
  for (const other of ['n01', 'n03', 'n04']) sim.heal('n02', other)
  sim.run({ until: 8000 })
  assert.equal(nodes[1].epoch, 2, 'the laggard healed its view before (or through) the flush')
  assert.equal(nodes[1].writes.pending.size, 0, 'the parked write committed')
  const aa2 = nodes[2].logs.get('n03')!.filter((e) => JSON.stringify(e.rec.key) === key('aa2'))
  assert.equal(aa2.length, 2, 'both writes, exactly once each')
  assert.ok(aa2.every((e) => e.epoch === 2), 'at the OWNER, at the COMMITTED epoch — v2 committed these at the stale one')
  assert.equal(nodes[1].logs.get('n02'), undefined, 'the laggard stamped nothing under its own origin')
  //! heal n05 → JOIN → view 3 → digest AE catches it up; everyone converges
  for (const other of ['n01', 'n02', 'n03', 'n04']) sim.heal('n05', other)
  sim.run({ until: 16000 })
  assert.deepEqual(nodes.map((n) => n.epoch), [3, 3, 3, 3, 3], 'the evictee re-joined')
  for (const n of nodes) assert.equal(n.writes.pending.size, 0, `${n.uuid} has stuck attempts`)
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [], 'single-writer held across the ownership handoff')
})

test('AA#3 the parked flush re-validates OWNERSHIP: it forwards to the owner — the mutant (v2-shaped local flush) is CAUGHT', () => {
  //! v2's flushPending committed a parked write LOCALLY at flush time — a second origin for a partition
  // someone else owns (DECISIONS AA #3; the open stale-ring residual is the same commit reached through
  // a stale owner lookup). v3's flush re-enters #drain: ownership re-resolves and the write FORWARDS.
  // The mutant restores the v2 shape and the single-writer monitor must catch it at the violating event.
  const run = (mutate: boolean) => {
    const sim = new Sim(64)
    const nodes = cluster(sim, 3, { heartbeatMs: 50 })
    sim.run({ until: 400 })
    pin(nodes, 'aa3', 'n01')
    if (mutate) {
      const w = nodes[2].writes
      //! the mutant: v2's flushPending — parked writes commit LOCALLY at the then-current epoch,
      // no ownership re-resolution (DECISIONS AA #3, verbatim behaviour)
      w.flush = function (this: Writes, node: Node) {
        const recs = [...this.pending.values()].map((a) => a.rec as Rec)
        this.pending.clear()
        if (recs.length) node.commit(recs)
      }
    }
    //! n03 into the minority with a parked write; the OWNER commits the same partition meanwhile —
    // the collision partner. Heal BEFORE give-up (the member chain, MEMBER_REDIALS 5 at base 20: n01 gives up
    // ≈ 1090 for this seed): no eviction, everyone stays at view 1 — so the mutant's local flush lands at
    // the SAME epoch as the owner's commit: the exact AA #3 conflict.
    sim.partition('n01', 'n03')
    sim.partition('n02', 'n03')
    sim.run({ until: 600 })
    sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['aa3'], value: 'parked' }] })
    sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['aa3'], value: 'owner-value' }] }, 100)
    sim.run({ until: 900 })
    assert.equal(nodes[2].writes.pending.size, 1, 'the write is still parked under the minority gate')
    sim.heal('n01', 'n03')
    sim.heal('n02', 'n03')
    sim.run({ until: 6000 })
    return { sim, nodes }
  }
  const broken = run(true)
  assert.ok(
    broken.sim.violations.some((v) => v.monitor === 'single-writer'),
    'the v2-shaped flush commits under a second origin at the same epoch — and the monitor CATCHES it',
  )
  const real = run(false)
  assert.deepEqual(real.sim.violations, [], 'the real kernel: same trajectory, single-writer holds')
  assert.deepEqual(real.nodes.map((n) => n.epoch), [1, 1, 1], 'healed before give-up: no eviction churn')
  assert.equal(real.nodes[2].logs.get('n03'), undefined, 'n03 never stamped ANYTHING under its own origin — its write owner-routed')
  const aa3 = real.nodes[0].logs.get('n01')!.filter((e) => JSON.stringify(e.rec.key) === key('aa3'))
  assert.equal(aa3.length, 2, 'both writes committed at the owner — one origin, LWW by seq within it')
  assert.equal(converged(real.sim), null)
})

test('AA#4 restore-boot: a restarted node is read-only while rejoining; its writes owner-route at the merged epoch — never a solo-epoch collision', () => {
  const sim = new Sim(65)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  pin(nodes, 'aa4', 'n01')
  const restoredView: [string, string][] = nodes[0].membership.view.members.map((m) => [m[0], m[1]])
  //! n03 dies (fully partitioned) and the survivors evict it — the live cluster moves on to view 2
  sim.partition('n01', 'n03')
  sim.partition('n02', 'n03')
  sim.run({ until: 5500 })
  assert.deepEqual(nodes.slice(0, 2).map((n) => n.epoch), [2, 2])
  //! restart n03 FROM ITS BOOT RECORD (view 1) while STILL partitioned — v2's AA#4 booted this node
  // as a solo owner at a stale epoch and collided with the live owner during catch-up. v3 boots it
  // REJOINING: read-only, pulling for a live confirmation that cannot arrive yet.
  nodes[2].destroy()
  sim.run({ until: 5600 })
  const reborn = sim.add({
    uuid: 'n03', listen: 'sim:n03', hosts: ['sim:n01', 'sim:n02'], heartbeatMs: 50, redialMs: 20,
    journalCap: 1 << 16, incarnation: 2, boot: { epoch: 1, members: restoredView },
  })
  reborn.writes.ring.place('aa4', 'n01')
  sim.post('n03', { kind: 'start' }, 1)
  //! a write lands DURING the rejoin window — the read-only gate must park it, not commit it at epoch 1
  sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['aa4'], value: 'after-restart' }] }, 100)
  sim.run({ until: 6500 })
  assert.deepEqual(reborn.membership.gate(reborn), { open: false, reason: 'rejoining' }, 'restored-with-peers must not self-trust')
  assert.equal(reborn.writes.pending.size, 1, 'parked, not committed')
  assert.equal(reborn.logs.get('n03'), undefined, 'nothing stamped at the restored epoch')
  //! heal → PULL answered with view 2 → n03 learns it was evicted → JOIN → view 3 → flush owner-routes
  sim.heal('n01', 'n03')
  sim.heal('n02', 'n03')
  sim.run({ until: 12000 })
  assert.equal(reborn.epoch, 3)
  assert.equal(reborn.logs.get('n03'), undefined, 'the restored node stamped nothing under its own origin')
  const committed = nodes[0].logs.get('n01')!.filter((e) => JSON.stringify(e.rec.key) === key('aa4'))
  assert.equal(committed.length, 1, 'the post-restart write committed exactly once, at the owner')
  assert.equal(committed[0].epoch, 3, 'at the merged epoch — never the restored one')
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [])
})

test('M3 mini-sweep: 30 seeds × heartbeats × owner-routed writes racing genesis, with partition/heal churn — single-writer expected-empty', () => {
  for (let seed = 200; seed < 230; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, 3, { heartbeatMs: 50 })
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.2 })
    //! writes span genesis: the early ones commit in open epoch-0 mode, the late ones owner-route —
    // the mode TRANSITION is exactly where a routing/stamping bug would surface
    writes(sim, nodes, 24, 3000)
    if (seed % 2) {
      const a = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      let b = a
      while (b === a) b = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      const cut = 600 + sim.rng() * 900
      sim.at(cut, () => sim.partition(a, b))
      sim.at(cut + 1000 + sim.rng() * 1500, () => sim.heal(a, b))
    }
    const violations = sim.run({ until: 15000 })
    assert.deepEqual(violations, [], `seed ${seed}: ${violations[0]?.monitor} — ${violations[0]?.detail}`)
    assert.ok(formed(nodes), `seed ${seed}: mesh did not re-form`)
    assert.equal(converged(sim), null, `seed ${seed}: ${converged(sim)}`)
    for (const n of nodes) assert.equal(n.writes.pending.size, 0, `seed ${seed}: ${n.uuid} finished with stuck attempts`)
    for (const n of nodes) assert.equal(n.membership.gate(n).open, true, `seed ${seed}: ${n.uuid} gate closed at rest`)
  }
})
