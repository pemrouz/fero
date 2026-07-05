//! Tier-2 executive suite: determinism canary, fault tolerance, partition/heal — all virtual-time, zero sleeps.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, drained } from './monitors.ts'

//! the determinism canary (plan §3.1): the same seed twice must produce byte-identical trajectories.
// This catches unrecorded nondeterminism (Map-iteration dependence, ambient time,
// stray Math.random) THE DAY it lands — v2 had no equivalent, so scheduling
// sensitivity was only discovered as flake, months later, on a loaded box.
test('same seed ⇒ identical trajectory (event count + per-event state-hash trace)', () => {
  const runOnce = () => {
    const sim = new Sim(1234)
    const nodes = cluster(sim, 3)
    sim.fault('n01', 'n02', { delay: [1, 20], dupP: 0.3 })
    writes(sim, nodes, 25)
    sim.run()
    return { events: sim.events, trace: sim.trace.join(',') }
  }
  const a = runOnce()
  const b = runOnce()
  assert.equal(a.events, b.events)
  assert.equal(a.trace, b.trace)
})

test('different seeds explore different trajectories', () => {
  const traceFor = (seed: number) => {
    const sim = new Sim(seed)
    writes(sim, cluster(sim, 3), 25)
    sim.run()
    return sim.trace.join(',')
  }
  assert.notEqual(traceFor(1), traceFor(2))
})

test('duplication + uneven delays: mesh forms, cluster converges, nothing left parked', () => {
  const sim = new Sim(42)
  const nodes = cluster(sim, 4)
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 30], dupP: 0.4 })
  writes(sim, nodes, 60)
  const violations = sim.run()
  assert.deepEqual(violations, [])
  assert.ok(sim.quiesced)
  assert.ok(formed(nodes), 'mesh formed')
  assert.equal(converged(sim), null)
  assert.equal(drained(sim), null)
  //! exactly one logical link per pair survived the full dial mesh (4 nodes → 3 links each)
  for (const n of nodes) assert.equal(n.admitted().length, 3)
})

test('partition severs links; heal + redial re-forms the mesh — asserted at quiescence, not after a sleep', () => {
  const sim = new Sim(7)
  const nodes = cluster(sim, 2)
  sim.run({ until: 50 })
  assert.ok(formed(nodes), 'formed before partition')

  sim.partition('n01', 'n02')
  sim.run({ until: 100 })
  assert.ok(!formed(nodes), 'links severed')

  sim.heal('n01', 'n02')
  sim.run() // to quiescence: pending redial timers fire, reconnect, HELLO, admit
  assert.ok(formed(nodes), 'mesh re-formed after heal')

  //! and the re-formed mesh still replicates
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['after-heal'], value: 1 }] })
  sim.run()
  assert.equal(converged(sim), null)
})

test('writes RACING mesh formation converge: replay-on-admit heals the dial-race loss window', () => {
  // The adversarial review proved the original kernel lost writes here: a write
  // issued while the eventual dup-race LOSER was the sole admitted link shipped
  // only on that link and died with it — silent permanent divergence (repro:
  // seed 0, write at t=8, 2 nodes). The fix is the own-log replay on every
  // admit; this test drives writes INTO the formation window (span 1-40ms
  // overlapping dial/HELLO/dup-close) across many seeds to keep the race hot.
  for (let seed = 0; seed < 40; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, 3)
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.3 })
    writes(sim, nodes, 25, 40) // deliberately concurrent with formation
    const violations = sim.run()
    assert.deepEqual(violations, [], `seed ${seed}`)
    assert.ok(formed(nodes), `seed ${seed}: formed`)
    assert.equal(converged(sim), null, `seed ${seed}`)
    assert.equal(drained(sim), null, `seed ${seed}`)
  }
})

test('partition installed while a dial is IN FLIGHT: no zombie link; heal re-forms the mesh', () => {
  // regression (adversarial review): linkDown delivered before linkUp minted a
  // Link that never died and never redialed — permanent silent unreachability
  const sim = new Sim(11)
  const nodes = cluster(sim, 2)
  sim.partition('n01', 'n02') // dials from 'start' are still in flight
  sim.run({ until: 300 })
  assert.ok(!formed(nodes), 'partitioned during dial — must not form')
  for (const n of nodes) assert.equal(n.links.size, 0, 'no zombie links may survive a refused dial')

  sim.heal('n01', 'n02')
  sim.run()
  assert.ok(formed(nodes), 'backoff redial reconnects after heal')
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['after'], value: 1 }] })
  sim.run()
  assert.equal(converged(sim), null)
})

test('tail loss heals: writes lost to a partition (in-flight and during) converge after heal via digest AE', () => {
  // The M1 slice's headline: real loss is TAIL loss at link death (TCP never
  // drops mid-stream on a live connection). Writes issued right at partition
  // time die in flight; writes during the partition never ship; the heal-time
  // re-admit exchanges digests and ships exactly the missing suffixes.
  const sim = new Sim(5)
  const nodes = cluster(sim, 2)
  sim.run()
  assert.ok(formed(nodes))

  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['at-cut'], value: 1 }] }, 1)
  sim.at(1, () => sim.partition('n01', 'n02')) // the write's frame is in flight when the cable dies
  sim.at(40, () => sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['during'], value: 2 }] }, 0))
  sim.at(40, () => sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['other-side'], value: 3 }] }, 0))
  sim.at(120, () => sim.heal('n01', 'n02'))
  const violations = sim.run()
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes), 're-formed after heal')
  assert.equal(converged(sim), null, 'digest AE must re-ship every lost suffix, both directions')
  assert.equal(nodes[1].state.size, 3)
})

test('backpressure overflow heals: the queue clears to a tail hole, the drain-time digest exchange re-ships it all', () => {
  const sim = new Sim(9)
  const nodes = cluster(sim, 2)
  sim.run()
  assert.ok(formed(nodes))
  //! pause n01's link to n02, write past MAX_QUEUED so the overflow clears the queue and de-syncs, then drain
  const link = [...nodes[0].links.values()].find((l) => l.uuid === 'n02')!
  sim.post('n01', { kind: 'pause', link: link.id })
  sim.run()
  for (let i = 0; i < 300; i++) sim.post('n01', { kind: 'write', recs: [{ type: 0, key: [`k${i}`], value: i }] }, i * 0.1)
  sim.run()
  assert.equal(link.queued.length, 0, 'overflow clears the WHOLE queue — pure tail loss')
  assert.equal(link.synced, false, 'overflow de-syncs the link until the heal completes')
  assert.ok(nodes[0].journal.read().some((e) => e.kind === 11 /* dropOldest */), 'loss is journal-visible')
  sim.post('n01', { kind: 'drain', link: link.id })
  sim.run()
  assert.equal(converged(sim), null, 'the post-drain digest exchange must re-ship the shed tail')
  assert.equal(nodes[1].state.size, 300)
  assert.equal(link.synced, true)
})
