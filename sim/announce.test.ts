//! DESIGN-SCALE stage 2 (2026-10-10): the counted pins P1-P3 of §8 — the holder handshake IS the anti-entropy on a
// scoped cluster, and these are its laws, machine-independent (frames per verb from the sink tally, sim/scoped-
// sweep.ts frameTally, on seed-exact schedules at delay [1,1]). A pin that moves is re-recorded only with the WHY
// (V4-18, V4-34).
//
//   P1  idle armed n=25 R=3 over 4 ticks: member DIGEST = 0; HAVEQ = HAVEA = Σᵢ min(aeFan, cᵢ) per tick EXACTLY,
//       cᵢ = the co-holders of node i (the peers it shares a held partition with); nothing shipped to a member.
//   P2  n=100 R=3 3,000 rows idle: the non-PING frames per tick are exactly that law (both legs) and the bytes
//       are under the bound recorded below. The record's §8 wrote "≤ 1,000 frames" with aeFan 8 at n=100: at
//       c ≥ 8 everywhere the law is 100 × 2 × 8 = 1,600 frames — the record's own §3 arithmetic (800 HAVEQ + 800
//       HAVEA) — so the frame pin is the law, not 1,000. Today's idle cost at this shape was 9,900 DIGEST frames
//       and 2.93 MB per tick (§2).
//   P3  one write on a settled n=100 R=3 mesh with the sweep OFF (aeFan 0, the one measurement posture): exactly
//       (R−1) = 2 RECORDS deliveries, then at the next tick exactly (R−1) HAVEQ frames of one entry each and
//       (R−1) HAVEA answers, then silence — no DIGEST, no HAVEQ, no HAVEA, no RECORDS for three more ticks.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { formed } from './harness.ts'
import { mesh, frameTally, perTick, type Tally } from './scoped-sweep.ts'
import { exactlyR, scopedConverged, floorsAgree } from './monitors.ts'
import { VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { REC } from '../kernel/env.ts'
import { SCOPE, AE_FAN } from '../kernel/scope.ts'
import type { Node } from '../kernel/node.ts'

//! coHolders — per armed node, how many OTHER members it shares at least one held partition with (its ring, its epoch)
const coHolders = (nodes: Node[]): number[] => nodes.map((n) => {
  const ring = n.writes.ring
  if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
  const peers = new Set<string>()
  for (const [p, e] of n.scope!.entries) if (e.state === SCOPE.held) for (const u of ring.holders(p, n.replicas)) if (u !== n.uuid) peers.add(u)
  return peers.size
})
const law = (cs: number[], fan = AE_FAN) => cs.reduce((s, c) => s + Math.min(fan, c), 0)
const aeShips = (sim: Sim) => [...sim.nodes.values()].reduce((s, n) => s + n.journal.read().filter((e) => e.kind === JK.aeShip).length, 0)
const settled = (sim: Sim) => { assert.equal(exactlyR(sim), null); assert.equal(scopedConverged(sim), null); assert.equal(floorsAgree(sim), null) }
//! nonPing — frames and bytes of every verb but PING/PONG since a mark (the tally keeps bytes per verb)
const nonPing = (t: Tally, frames0: Float64Array, bytes0: Float64Array) => {
  let frames = 0, bytes = 0
  for (let v = 0; v < 256; v++) { if (v === VERB.PING || v === VERB.PONG) continue; frames += t.frames[v] - frames0[v]; bytes += t.bytes[v] - bytes0[v] }
  return { frames, bytes }
}

test('P1 — idle armed n=25 R=3 over 4 ticks: member DIGEST = 0, HAVEQ = HAVEA = Σᵢ min(aeFan, cᵢ) per tick exactly, and nothing is shipped to a member', () => {
  const sim = new Sim(1)
  const t = frameTally(sim)
  const nodes = mesh(sim, 25, { replicas: 3, hb: 50, fault: { delay: [1, 1] } })
  sim.monitors.length = 0 // measurements, not laws
  sim.run({ until: 1500, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed))
  for (let i = 0; i < 300; i++) sim.post(nodes[i % 25].uuid, { kind: 'write', recs: [{ type: REC.update, key: [`r${i}`], value: i }] }, i)
  sim.run({ until: sim.now + 2000, maxEvents: 5_000_000 })
  settled(sim)
  const cs = coHolders(nodes)
  assert.ok(cs.every((c) => c > AE_FAN), `every node has more co-holders than aeFan (${Math.min(...cs)}): the pin exercises the cursor`)
  const L = law(cs)
  assert.equal(L, 25 * AE_FAN)
  const a0 = aeShips(sim)
  assert.deepEqual(perTick(sim, t, 50, 4, VERB.DIGEST), [0, 0, 0, 0], 'no member DIGEST on a scoped cluster')
  assert.deepEqual(perTick(sim, t, 50, 4, VERB.HAVEQ), [L, L, L, L], 'HAVEQ per tick = Σ min(aeFan, cᵢ): the sweep, exactly')
  assert.deepEqual(perTick(sim, t, 50, 4, VERB.HAVEA), [L, L, L, L], 'and every sweep frame is answered once')
  assert.deepEqual(perTick(sim, t, 50, 4, VERB.RECORDS), [0, 0, 0, 0], 'idle: no record moves')
  assert.equal(aeShips(sim) - a0, 0, 'nothing shipped to a member by a digest')
  settled(sim)
})

test('P2 — n=100 R=3 3,000 rows idle: the non-PING frames per tick are exactly Σᵢ 2·min(aeFan, cᵢ) and under the recorded bytes (today: 9,900 DIGEST frames, 2.93 MB)', () => {
  const sim = new Sim(0)
  const t = frameTally(sim)
  const nodes = mesh(sim, 100, { replicas: 3, hb: 200, fault: { delay: [1, 1] } })
  sim.monitors.length = 0
  sim.run({ until: 4000, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed))
  for (let i = 0; i < 3000; i++) sim.post(nodes[i % 100].uuid, { kind: 'write', recs: [{ type: REC.update, key: [`row${i}`], value: { v: i } }] }, i)
  sim.run({ until: sim.now + 6000, maxEvents: 10_000_000 })
  settled(sim)
  const cs = coHolders(nodes)
  const held = nodes.map((n) => n.scope!.tallies().held)
  assert.ok(cs.every((c) => c >= AE_FAN), `every node has at least aeFan co-holders (${Math.min(...cs)}); held per node ${Math.min(...held)}-${Math.max(...held)}`)
  const L = law(cs)
  assert.equal(L, 100 * AE_FAN)
  for (let i = 0; i < 2; i++) {
    const f0 = t.frames.slice(), b0 = t.bytes.slice()
    sim.run({ until: sim.now + 200, maxEvents: 10_000_000 })
    const { frames, bytes } = nonPing(t, f0, b0)
    assert.equal(frames, 2 * L, `tick ${i + 1}: non-PING frames = 2 × Σ min(aeFan, cᵢ) = ${2 * L} (HAVEQ + HAVEA, nothing else)`)
    //! RECORDED 2026-10-10: 249,878 bytes per idle tick here (today 2,930,000: an 11.7× cut, not the record's
    // estimated 100 KB — a sweep frame is about 156 bytes: the epoch, the ~1.8 partitions a pair shares with their
    // lane floors and the `g` list, and the HAVEA echoes `m` back). Stage 5's "lanes changed since the last answer"
    // is the next cut. The bound leaves 4% for a longer uuid or key.
    assert.ok(bytes <= 260_000, `tick ${i + 1}: ${bytes} bytes of non-PING traffic (recorded 249,878; today 2.93 MB)`)
  }
  assert.deepEqual(perTick(sim, t, 200, 1, VERB.DIGEST), [0])
})

test('P3 — one write on a settled n=100 R=3 mesh (aeFan 0): exactly (R−1) RECORDS deliveries, then exactly (R−1) HAVEQ entries + (R−1) HAVEA at the next tick, then silence', () => {
  const sim = new Sim(0)
  const t = frameTally(sim)
  const nodes = mesh(sim, 100, { replicas: 3, hb: 50, tune: { aeFan: 0 }, fault: { delay: [1, 1] } })
  sim.monitors.length = 0
  sim.run({ until: 3000, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed))
  for (let i = 0; i < 300; i++) sim.post(nodes[i % 100].uuid, { kind: 'write', recs: [{ type: REC.update, key: [`r${i}`], value: i }] }, i)
  sim.run({ until: sim.now + 2000, maxEvents: 5_000_000 })
  settled(sim)
  //! settled with the sweep off: every co-holder has attested every held partition once (the never-answered leg
  // has nothing left to ask), so an idle tick costs nothing at all
  assert.deepEqual(perTick(sim, t, 50, 2, VERB.HAVEQ), [0, 0], 'quiet before the write')
  const m = t.mark()
  //! the write lands on the first node 1 ms after a tick boundary: its fan-out, then the announcement at the next tick
  sim.post(nodes[0].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['r0'], value: 'again' }] }, 1)
  sim.run({ until: sim.now + 55, maxEvents: 5_000_000 }) // through the next tick (at +50) and its answers (at +51)
  assert.equal(t.since(m, VERB.RECORDS), 2, 'exactly (R−1) RECORDS deliveries: the owner\'s fan-out to its two co-holders')
  assert.equal(t.since(m, VERB.HAVEQ), 2, 'exactly (R−1) HAVEQ frames: the owner tells each co-holder the new floor')
  assert.equal(t.since(m, VERB.HAVEA), 2, 'exactly (R−1) HAVEA: each co-holder answers with its floor — marks converge in one round trip')
  assert.equal(t.since(m, VERB.DIGEST), 0)
  //! one entry each: the HAVEQ bodies name r0 alone
  assert.deepEqual(perTick(sim, t, 50, 3, VERB.HAVEQ), [0, 0, 0], 'then silence')
  assert.deepEqual(perTick(sim, t, 50, 3, VERB.HAVEA), [0, 0, 0])
  assert.deepEqual(perTick(sim, t, 50, 3, VERB.RECORDS), [0, 0, 0])
  settled(sim)
})
