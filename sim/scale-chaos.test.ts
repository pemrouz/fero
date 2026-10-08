//! ── Tier-2 SCALE-CHAOS suite: churn + durability scale-models ─────────────────
// Companions to sim/scale.test.ts: the membership-churn and durability laws at
// mid-scale (n=8..30), where interleaving fidelity is affordable — these are the
// per-event / phase-boundary counterparts the sampled 100-node runs lean on. The
// n=100 variants of the heavy shapes here (batch eviction, join storms, full
// restores) are CLI-tier: `npm run sim:scale`. Scenarios using sim.restart are
// NOT shrinkable (the Step vocabulary is write|partition|heal) — a failure here
// ships its full capture only.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, drained, confirmedIntact, scopedConverged, exactlyR } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import type { Node } from '../kernel/node.ts'

const epochs = (nodes: Node[]) => nodes.map((n) => n.epoch)
const jcount = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length
const live = (sim: Sim): Node[] => [...sim.nodes.values()]

test('CHAOS install-crosses-the-burst: an epoch bump lands mid-write-storm — stale-epoch NACKs re-resolve, exactly-once holds', () => {
  const sim = new Sim(10)
  //! the per-pair delays are load-bearing: a stale-epoch NACK needs an attempt IN FLIGHT at the
  // install instant — at the default [1,5)ms the window is ~nothing and the guard below goes vacuous
  const nodes = cluster(sim, 30, { heartbeatMs: 100, fault: { delay: [5, 40] } })
  sim.run({ until: 1500, checkEvery: 500, maxEvents: 3_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1), 'view 1 up before the storm')

  writes(sim, nodes, 400, 800) // the burst: 400 owner-routed writes over [1500, 2300)
  sim.at(200, () => {
    //! the joiner lands its ballot mid-burst: every in-flight WRITE/WACK crosses a ring rebuild
    sim.add({
      uuid: 'n31', listen: 'sim:n31', hosts: nodes.map((m) => `sim:${m.uuid}`),
      heartbeatMs: 100, redialMs: 20, journalCap: 1 << 16,
    })
    sim.post('n31', { kind: 'start' }, 0)
  })
  const violations = sim.run({ until: 4000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [], 'attempt-exactly-once + single-writer clean across the ownership move')
  const all = live(sim)
  assert.deepEqual(epochs(all), Array(31).fill(2), 'the join committed everywhere')
  for (const n of all) assert.equal(n.membership.view.members.length, 31)
  //! non-vacuity: the install actually crossed the burst — somebody's attempt hit a moved epoch
  const nacks = all.reduce((s, n) => s + n.journal.read().filter((e) => e.kind === JK.writeNack && e.a === 'stale-epoch').length, 0)
  assert.ok(nacks > 0, `the epoch bump must land MID-burst (stale-epoch NACKs: ${nacks})`)
  for (const n of all) assert.equal(n.writes.droppedPending, 0, `${n.uuid}: nothing overflowed — every attempt resolved`)
  assert.equal(converged(sim), null, 'all 300 burst writes present at all 31 nodes')
})

test('CHAOS batch-eviction: suspicion holds while dialing, then a BATCH ballot evicts the cut 4; CP minority parks; heal → join wave home', () => {
  //! heartbeat 100 (2026-10-08): a dead MEMBER runs the short chain (MEMBER_REDIALS 5 ≈ 620 ms at base 20 + jitter),
  // so suspicion must fire INSIDE that runway for the hold to be observable: at 100 ms it fires at 1800, the
  // first give-up is ≈ 2160 and the first ballot ≈ 2210 — the probe at 2000 sits between them
  const sim = new Sim(11)
  const nodes = cluster(sim, 30, { heartbeatMs: 100 })
  const cut = ['n27', 'n28', 'n29', 'n30']
  const kept = nodes.filter((n) => !cut.includes(n.uuid))
  for (const c of cut) for (const k of kept) sim.at(1500, () => sim.partition(c, k.uuid))
  //! background writes ride every phase: majority-side before/during/after, minority-side parking
  for (let i = 0; i < 12; i++) sim.post('n02', { kind: 'write', recs: [{ type: 0, key: [`mw${i}`], value: i }] }, 1600 + i * 600)
  sim.post('n28', { kind: 'write', recs: [{ type: 0, key: ['minority'], value: 'parked' }] }, 2600)

  sim.run({ until: 2000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.deepEqual(epochs(nodes), Array(30).fill(1), 'suspects held while dialing — "gone" means the dial chain exhausted, not "one tick late"')
  assert.ok(kept.some((n) => jcount(n, JK.suspect) > 0), 'suspicion IS firing — the hold is the dialing-hold, not blindness')

  sim.run({ until: 9000, checkEvery: 500, maxEvents: 5_000_000 })
  const e1 = kept[0].epoch
  assert.ok(e1 >= 2 && e1 <= 4, `give-up → eviction ballot(s) committed (epoch ${e1}; batching may split under give-up jitter but never 1-per-evictee)`)
  assert.deepEqual(new Set(epochs(kept)), new Set([e1]), 'the majority agrees on the shrunk view')
  assert.equal(kept[0].membership.view.members.length, 26)
  const evicted = new Set(kept[0].journal.read().filter((e) => e.kind === JK.evict).map((e) => e.a))
  assert.deepEqual([...evicted].sort(), cut, 'exactly the cut 4 were evicted')
  for (const c of cut) {
    const n = sim.nodes.get(c)!
    assert.equal(n.epoch, 1, `${c}: still on the old view`)
    assert.deepEqual(n.membership.gate(n), { open: false, reason: 'minority' }, `${c}: CP — gated, not diverging`)
  }
  assert.ok(sim.nodes.get('n28')!.writes.pending.size > 0, 'the minority write parked (bounded, journal-visible)')

  for (const c of cut) for (const k of kept) sim.heal(c, k.uuid)
  const violations = sim.run({ until: 25_000, checkEvery: 500, maxEvents: 8_000_000 })
  assert.deepEqual(violations, [])
  const all = live(sim)
  assert.deepEqual(new Set(epochs(all)).size, 1, 'one view everywhere after the join wave')
  for (const n of all) assert.equal(n.membership.view.members.length, 30, `${n.uuid}: full membership restored`)
  assert.equal(sim.nodes.get('n28')!.writes.pending.size, 0, 'the parked write flushed on readmission')
  assert.equal(converged(sim), null, 'majority-era, minority-parked, and heal-era writes all present everywhere')
})

test('CHAOS join-storm 24+6: six serialized one-joiner ballots, ONE proposer, six ring reshapes under live writes', () => {
  const sim = new Sim(12)
  const members = cluster(sim, 24, { heartbeatMs: 100 })
  const allAddrs = [...members.map((m) => `sim:${m.uuid}`), ...Array.from({ length: 6 }, (_, i) => `sim:n${25 + i}`)]
  for (let i = 0; i < 6; i++)
    sim.at(1500 + i * 100, () => {
      const uuid = `n${25 + i}`
      sim.add({ uuid, listen: `sim:${uuid}`, hosts: allAddrs.filter((a) => a !== `sim:${uuid}`), heartbeatMs: 100, redialMs: 20, journalCap: 1 << 16 })
      sim.post(uuid, { kind: 'start' }, 0)
    })
  for (let i = 0; i < 15; i++) sim.post(members[i % 24].uuid, { kind: 'write', recs: [{ type: 0, key: [`jw${i}`], value: i }] }, 1400 + i * 250)
  const violations = sim.run({ until: 20_000, checkEvery: 500, maxEvents: 8_000_000 })
  assert.deepEqual(violations, [], 'cursor monitors clean across six ownership migrations')
  const all = live(sim)
  assert.equal(all.length, 30)
  assert.deepEqual(epochs(all), Array(30).fill(7), 'epoch 1 + exactly one ballot per joiner — admission is SERIALIZED, never batched')
  for (const n of all) assert.equal(n.membership.view.members.length, 30)
  for (const n of all)
    if (n.uuid === 'n01') assert.ok(jcount(n, JK.propose) >= 6, 'n01 proposed every admission')
    else assert.equal(jcount(n, JK.propose), 0, `${n.uuid}: the JOIN relay keeps ONE proposer under a 6-wide storm`)
  assert.equal(converged(sim), null, 'writes crossing six installs land everywhere, joiners included')
})

test('CHAOS rescope-storm: a join at R=3 moves ~1/31 of the ring — sheds pair with acquires, nothing wedges, exactly-R restores', () => {
  const sim = new Sim(13)
  const nodes = cluster(sim, 30, { heartbeatMs: 200, replicas: 3 })
  sim.run({ until: 4000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  writes(sim, nodes, 100, 300) // steady-state scoped workload, owner-routed at epoch 1
  sim.run({ until: 8000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.equal(exactlyR(sim), null, 'settled at epoch 1 before the storm')

  sim.add({
    uuid: 'n31', listen: 'sim:n31', hosts: nodes.map((m) => `sim:${m.uuid}`),
    heartbeatMs: 200, redialMs: 20, journalCap: 1 << 16, replicas: 3,
  })
  sim.post('n31', { kind: 'start' }, 0)
  const violations = sim.run({ until: 20_000, checkEvery: 500, maxEvents: 8_000_000 })
  assert.deepEqual(violations, [])
  const all = live(sim)
  assert.ok(all.every((n) => n.epoch >= 2), 'the join committed')
  assert.equal(exactlyR(sim), null, 'exactly-R at the new epoch — duty followed the ring')
  assert.equal(scopedConverged(sim), null)
  let orphaned = 0, sheds = 0, acquires = 0
  for (const n of all) {
    const t = n.scope!.tallies()
    assert.equal(t.orphaned, 0, `${n.uuid}: every orphan drained`)
    assert.equal(t.acquiring, 0, `${n.uuid}: no acquisition wedged open`)
    assert.equal(jcount(n, JK.shedStall), 0, `${n.uuid}: no shed stalled`)
    orphaned += jcount(n, JK.orphaned); sheds += jcount(n, JK.shed); acquires += jcount(n, JK.acquire)
  }
  //! non-vacuity: the ring actually moved partitions (else this seed tests nothing) — and the
  // economics: what orphaned was shed, what moved was acquired — proportional to the MOVE, not to n
  assert.ok(orphaned > 0 && acquires > 0, `the storm engaged (orphaned ${orphaned}, acquires ${acquires})`)
  assert.ok(sheds >= orphaned, 'every orphaned partition eventually shed')
})

test('CHAOS mass-restart-with-torn-tails: 6 of 20 durable nodes crash mid-workload on slow disks — floors clear, lanes rebirth, confirms hold', () => {
  const sim = new Sim(14)
  const nodes = cluster(sim, 20, { heartbeatMs: 100, durable: true })
  const victims = ['n03', 'n06', 'n09', 'n12', 'n15', 'n18']
  for (const v of victims) sim.storeFault(v, { delay: [30, 120] }) // slow fsync: unresolved rows at crash = the torn tail
  sim.run({ until: 1500, checkEvery: 500, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))

  writes(sim, nodes, 200, 500) // [1500, 2000) — the workload the crashes land inside
  let id = 0
  sim.at(600, () => {
    for (const n of live(sim)) {
      const tail = n.logs.get(n.uuid)?.at(-1)
      if (tail && id < 8) sim.post(n.uuid, { kind: 'confirm', id: ++id, origin: n.uuid, seq: tail.seq, level: CONFIRM.replicated })
    }
  })
  //! the crashes land INSIDE the write window ([1500,2000) absolute; now=1500 here) while the slow
  // fsync queue is backed up — that in-flight tail is exactly what a crash tears
  const torn: number[] = []
  victims.forEach((v, i) =>
    sim.at(350 + i * 60, () => {
      torn.push(sim.stores.get(v)!.wal.filter((r) => !r.resolved).length)
      sim.restart(v)
    }),
  )
  const violations = sim.run({ until: 10_000, checkEvery: 500, maxEvents: 8_000_000 })
  assert.deepEqual(violations, [], 'cursor monitors survive six lane rebirths (their node-object cursors reset lawfully)')
  assert.ok(torn.some((t) => t > 0), `the torn tail actually bit (unresolved rows at crash: ${torn.join(',')})`)
  assert.ok(id >= 6, 'confirm probes were real')
  for (const v of victims) {
    const n = sim.nodes.get(v)!
    assert.ok(jcount(n, JK.replayed) > 0, `${v}: restored from its own WAL, not just re-taught`)
    assert.equal(n.membership.rejoining(), false, `${v}: the rejoin floor cleared — a live peer confirmed the epoch`)
    assert.ok(n.membership.gate(n).open, `${v}: writable again`)
  }
  assert.equal(converged(sim), null, 'reborn uuid~inc lanes included — everyone agrees')
  assert.equal(confirmedIntact(sim), null, '6 < majority: every replicated-level confirm still holds')
  assert.equal(drained(sim), null)
})

test('CHAOS full-cluster-restore-at-25: kill everyone mid-workload; 25 disks alone rebuild; mutual re-confirmation resumes the view — NO ballot', () => {
  const sim = new Sim(15)
  const nodes = cluster(sim, 25, { heartbeatMs: 100, durable: true })
  sim.run({ until: 1500, checkEvery: 500, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  writes(sim, nodes, 150, 500)
  let id = 0
  sim.at(800, () => {
    for (const n of live(sim)) {
      const tail = n.logs.get(n.uuid)?.at(-1)
      if (tail && id < 8) sim.post(n.uuid, { kind: 'confirm', id: ++id, origin: n.uuid, seq: tail.seq, level: CONFIRM.persisted })
    }
  })
  sim.at(1000, () => { for (const n of [...sim.nodes.values()]) sim.restart(n.uuid) }) // the whole cluster dies at one instant
  const violations = sim.run({ until: 10_000, checkEvery: 500, maxEvents: 8_000_000 })
  assert.deepEqual(violations, [])
  const all = live(sim)
  assert.equal(all.length, 25)
  //! the restored view IS the view: every boot record says epoch 1, and a peer's VIEW at EQUAL epoch
  // clears the rejoin floor (mutual re-confirmation) — so 25 simultaneous rejoiners resume epoch 1
  // with NO ballot at all. The REJOIN_TICKS self-ballot is the nobody-confirms fallback only; a race
  // of 25 competing epoch-2 proposers is exactly what must NOT happen here.
  assert.deepEqual(epochs(all), Array(25).fill(1), 'the committed view RESUMED — no self-ballot, no competing proposers')
  for (const n of all) assert.equal(jcount(n, JK.propose), 0, `${n.uuid}: nobody proposed — mutual confirmation beat the fallback`)
  for (const n of all) {
    assert.equal(n.membership.rejoining(), false, `${n.uuid}: floor cleared`)
    assert.ok(jcount(n, JK.replayed) > 0, `${n.uuid}: state came from ITS disk`)
    assert.equal(jcount(n, JK.walTaint), 0, `${n.uuid}: clean disks — no condemnation`)
  }
  assert.ok([...sim.confirms.values()].some((c) => c.ok === true && c.level === CONFIRM.persisted), 'persisted confirms resolved pre-crash')
  assert.equal(confirmedIntact(sim, CONFIRM.persisted), null, 'full-crash scopes the guarantee to the persisted rung — and it holds')
  assert.equal(converged(sim), null, '25 WALs alone rebuilt one agreeing cluster')
})

test('CHAOS fsync-liars-among-12: lying disks are CONDEMNED at replay, and the cluster re-teaches them — never silent', () => {
  const sim = new Sim(16)
  const nodes = cluster(sim, 12, { heartbeatMs: 100, durable: true })
  const liars = ['n10', 'n11', 'n12']
  for (const l of liars) sim.storeFault(l, { lieP: 0.3 }) // 30% of fsync batches resolve but never really landed
  sim.run({ until: 1200, checkEvery: 500, maxEvents: 3_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  writes(sim, nodes, 150, 500)
  liars.forEach((l, i) => sim.at(700 + i * 100, () => sim.restart(l)))
  const violations = sim.run({ until: 8000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [])
  for (const l of liars) {
    const n = sim.nodes.get(l)!
    //! an interior lie surfaces as a chain hole (walHole) and can escalate to condemnation
    // (walTaint); a tail lie is plain tail loss — either way the loss is journal-visible at replay
    // and AE re-teaches. The aggregate guard below pins that lying was DETECTED somewhere.
    assert.ok(jcount(n, JK.replayed) > 0 || jcount(n, JK.walTaint) > 0, `${l}: replayed or condemned — never a silent fresh boot`)
  }
  const detected = liars.reduce((s, l) => s + jcount(sim.nodes.get(l)!, JK.walHole) + jcount(sim.nodes.get(l)!, JK.walTaint), 0)
  assert.ok(detected > 0, `an interior lie was DETECTED at replay (holes+taints: ${detected}) — the lie class is exercised, not dodged`)
  for (const n of live(sim)) assert.equal(jcount(n, JK.dropOldest), 0, `${n.uuid}: the re-teach storm never tripped backpressure`)
  assert.equal(converged(sim), null, 'the liars were re-taught everything')
  assert.equal(drained(sim), null)
})

test('CHAOS flap-never-evicts: a node flapping longer than suspicion but shorter than the dial-hold stays a member', () => {
  const sim = new Sim(17)
  const nodes = cluster(sim, 10, { heartbeatMs: 50 })
  sim.run({ until: 600, checkEvery: 200, maxEvents: 3_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  //! each flap: 200ms cut (> SUSPECT_TICKS×hb = 150ms, so suspicion FIRES) then 200ms healed
  // (≪ the ~4s dial-chain runway, so eviction's give-up precondition never arrives)
  const peers = nodes.filter((n) => n.uuid !== 'n05')
  for (let c = 0; c < 10; c++) {
    sim.at(1000 + c * 400, () => { for (const p of peers) sim.partition('n05', p.uuid) })
    sim.at(1000 + c * 400 + 200, () => { for (const p of peers) sim.heal('n05', p.uuid) })
  }
  for (let i = 0; i < 10; i++) sim.post(peers[i % 9].uuid, { kind: 'write', recs: [{ type: 0, key: [`fw${i}`], value: i }] }, 1100 + i * 380)
  const violations = sim.run({ until: 7000, checkEvery: 200, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(nodes.some((n) => jcount(n, JK.suspect) > 0), 'suspicion fired at least once — the flap was seen, not missed')
  for (const n of nodes) {
    assert.equal(jcount(n, JK.evict), 0, `${n.uuid}: a returning suspect aborts every eviction ballot — no churn`)
    assert.equal(jcount(n, JK.viewInstall), 1, `${n.uuid}: epoch pinned at 1 through ten flaps`)
  }
  assert.equal(converged(sim), null)
  assert.equal(drained(sim), null)
})

test('CHAOS shed-stall-alarms-then-completes (H7): a molasses mesh stalls the inheritance sheds — the alarm fires, safety holds, everything drains', () => {
  const sim = new Sim(18)
  //! every link crawls at [400,500)ms RTT legs while SHED_TICKS polls every 2 ticks (100ms): the
  // shed poll outpaces its own attestations, so JK.shedStall MUST alarm — and because the fault is
  // delay (never loss), every attestation eventually lands and every shed completes. Per-event
  // monitors (checkEvery 1): this is the full-fidelity companion for orphan-frozen and
  // scoped-lawful-holding that the sampled big-n scoped runs lean on.
  const nodes = cluster(sim, 8, { heartbeatMs: 50, replicas: 2, fault: { delay: [400, 500] } })
  writes(sim, nodes, 40, 300) // epoch-0 writes → everyone holds everything → the arming install mass-orphans
  const violations = sim.run({ until: 60_000, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [], 'orphan-frozen + scoped-lawful-holding at PER-EVENT fidelity throughout')
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  const stalls = nodes.reduce((s, n) => s + jcount(n, JK.shedStall), 0)
  assert.ok(stalls > 0, `the stall alarm FIRED (${stalls}) — a live-but-slow holder is surfaced, never silent`)
  for (const n of nodes) {
    const t = n.scope!.tallies()
    assert.equal(t.orphaned, 0, `${n.uuid}: the stall is liveness-alarmed, not a wedge — every orphan drained`)
    assert.equal(t.acquiring, 0)
  }
  assert.equal(exactlyR(sim), null)
  assert.equal(scopedConverged(sim), null)
})

test('CHAOS pending-overflow-is-counted-loss: 1500 gated writes at one issuer — 1024 survive, 476 are COUNTED away, the flush is exactly-once', () => {
  const sim = new Sim(19)
  const nodes = cluster(sim, 20, { heartbeatMs: 100 })
  sim.run({ until: 1200, checkEvery: 500, maxEvents: 3_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.epoch === 1))
  const peers = nodes.filter((n) => n.uuid !== 'n20')
  for (const p of peers) sim.partition('n20', p.uuid)
  sim.run({ until: 1500, checkEvery: 500, maxEvents: 3_000_000 })
  const n20 = sim.nodes.get('n20')!
  assert.deepEqual(n20.membership.gate(n20), { open: false, reason: 'minority' }, 'cut from all 19: gated')
  //! 1500 parked writes vs MAX_PENDING=1024: drop-OLDEST — p0..p475 die counted, p476..p1499 park
  for (let i = 0; i < 1500; i++) sim.post('n20', { kind: 'write', recs: [{ type: 0, key: [`p${i}`], value: i }] }, i * 0.05)
  sim.run({ until: 1700, checkEvery: 500, maxEvents: 3_000_000 })
  assert.equal(n20.writes.droppedPending, 476, 'the loss is EXACT and surfaced — never silent')
  assert.ok(jcount(n20, JK.writeBufferDrop) > 0, 'and journal-visible')
  //! heal INSIDE the dial-chain runway (a dead MEMBER's chain: MEMBER_REDIALS 5 ≈ 620 ms at base 20 — the first
  // give-up is ≈ 1860 for this seed): the suspects return, every eviction ballot aborts
  for (const p of peers) sim.heal('n20', p.uuid)
  const violations = sim.run({ until: 8000, checkEvery: 500, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [], 'attempt-exactly-once across the park-then-flush (cursor monitor: full fidelity under sampling)')
  assert.deepEqual(epochs(nodes), Array(20).fill(1), 'healed before give-up — membership never moved')
  assert.equal(n20.writes.pending.size, 0, 'the surviving 1024 flushed owner-routed')
  assert.equal(converged(sim), null)
  const pKeys = [...nodes[0].state.keys()].filter((k) => k.startsWith(JSON.stringify(['p']).slice(0, -2))).length
  assert.equal(pKeys, 1024, 'exactly the surviving window landed')
  assert.ok(nodes[0].state.has(JSON.stringify(['p1499'])) && !nodes[0].state.has(JSON.stringify(['p0'])), 'drop-oldest: the tail survives, the head is the counted loss')
})
