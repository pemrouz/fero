//! ── sim/scale.perf — speed-at-scale pins: counts → ratios → tripwires ─────────
// The scaling economics of formation, anti-entropy, and fan-out, pinned in the
// order DECISIONS V3-15 prescribes: exact structural counts first (machine-
// independent), a flatness ratio second (survives protocol changes that move
// both sides), one generous wall ceiling last (WSL2 swings 2-3x — the absolute
// is a tripwire, never the load-bearing claim). Goldens are measured on THIS
// tree at zero-jitter fault personalities ({delay:[1,1]}) so the counts are
// seed-exact; a deliberate protocol change re-pins them with a DECISIONS entry
// (the shrink T1 / frozen-sweep-count precedent). Built on cluster() directly —
// NEVER sweepBuild, whose draw order is nNodes-scoped.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import type { Node } from '../kernel/node.ts'

const formOnly = (n: number): { sim: Sim; nodes: Node[] } => {
  const sim = new Sim(0)
  const nodes = cluster(sim, n, { fault: { delay: [1, 1] } })
  sim.monitors.length = 0 // measurements, not laws — the monitors have their own suites
  sim.run({ maxEvents: 3_000_000 })
  assert.ok(formed(nodes), `n=${n}: a cheap-but-broken formation must not pin a number`)
  return { sim, nodes }
}

const jtotal = (sim: Sim, kind: number): number =>
  [...sim.nodes.values()].reduce((s, n) => s + n.journal.read().filter((e) => e.kind === kind).length, 0)

test('counted: 100-node formation is EXACTLY 59,500 events at seed 0 — the whole protocol cost of a 9,900-dial mesh, pinned', () => {
  //! RE-PINNED 2026-10-06, 69,400 → 59,500: the admit digest exchange has ONE opener now (the lower
  // uuid sends r=1, the higher answers r=0). It used to have two, so every pair paid four digest
  // frames where two do the job. The drop is exactly 2 frames × 4,950 pairs = 9,900 deliveries;
  // nothing else in formation moved. The DECISIONS record is "the lower uuid opens the admit
  // digest exchange".
  const { sim } = formOnly(100)
  assert.equal(
    sim.events, 59_500,
    `100-node formation cost ${sim.events} events (pinned 59,500) — the formation protocol changed: ` +
    're-pin deliberately with a DECISIONS entry, never to green a drifted count',
  )
})

test('counted ratio: formation scales with PAIRS — events(n=100)/events(n=25) stays under 25 (pair ratio 16.5, measured ~16.4)', () => {
  //! the anti-superquadratic tripwire: dials, HELLOs, dedup, and digest-on-admit are all per-pair,
  // so formation events / pairs is empirically FLAT (12.02/pair at n=100 vs 12.08 at n=25 — 59,500 / 3,625).
  // Any change that makes formation worse than O(pairs) blows through the 1.5x slack long before
  // it needs a wall clock to see.
  const a = formOnly(25).sim.events
  const b = formOnly(100).sim.events
  assert.ok(b / a < 25, `events(100)/events(25) = ${(b / a).toFixed(2)} exceeds 25 — formation went superquadratic`)
})

test('counted: the idle AE floor at n=25 is EXACTLY k·n(n-1) digests over k ticks — and ships nothing', () => {
  //! the digest law: every heartbeat tick, the lower-uuid side of every admitted pair sends its
  // digest (r=1) and the peer answers (r=0) — BOTH legs journal digestOut, so an idle converged
  // mesh costs exactly n(n-1) digest frames per tick, and an idle floor must ship ZERO records
  // (extends exec.test's 2-node quiet-floor law to a 300-pair mesh). Virtual time makes the
  // window exact: [1000, 1200) at hb=50 is precisely 4 ticks.
  const sim = new Sim(0)
  const nodes = cluster(sim, 25, { heartbeatMs: 50, fault: { delay: [1, 1] } })
  sim.monitors.length = 0
  sim.run({ until: 1000, maxEvents: 3_000_000 })
  assert.ok(formed(nodes) && converged(sim) === null, 'converged before the idle window opens')
  const d0 = jtotal(sim, JK.digestOut), a0 = jtotal(sim, JK.aeShip)
  sim.run({ until: 1200, maxEvents: 3_000_000 })
  assert.equal(jtotal(sim, JK.digestOut) - d0, 4 * 25 * 24, 'the AE floor is exactly two digest legs per pair per tick')
  assert.equal(jtotal(sim, JK.aeShip) - a0, 0, 'an idle floor ships NOTHING — digests carry real tails')
})

test('counted: unscoped fan-out is exactly n-1 — one write at a formed 100-node mesh applies inbound at every other node once', () => {
  const { sim } = formOnly(100)
  const a0 = jtotal(sim, JK.applyInbound)
  sim.post('n001', { kind: 'write', recs: [{ type: 0, key: ['fanout'], value: 1 }] })
  sim.run({ maxEvents: 3_000_000 })
  assert.equal(jtotal(sim, JK.applyInbound) - a0, 99, 'one record → exactly 99 inbound applies: no echo, no dup, no miss')
  assert.equal(converged(sim), null)
})

test('wall tripwire: the 100-node headline trajectory (formation + 40 writes, monitors sampled at K=1000) completes under 20s', () => {
  //! generous ceiling, structurally justified: measured ~2.5-4s on the pinned-era WSL2 box, and
  // WSL2 swings 2-3x. This doubles as the monitor-cost regression guard — a change that drags the
  // sampled monitor pass back toward per-event cost trips here first.
  const t0 = performance.now()
  const sim = new Sim(0)
  const nodes = cluster(sim, 100, { fault: { delay: [1, 15], dupP: 0.1 } })
  writes(sim, nodes, 40, 300)
  const violations = sim.run({ checkEvery: 1000, maxEvents: 3_000_000 })
  const ms = performance.now() - t0
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes) && converged(sim) === null, 'the trajectory is the real one — formed and converged')
  assert.ok(ms < 20_000, `100-node headline trajectory took ${ms.toFixed(0)}ms (ceiling 20,000ms)`)
})
