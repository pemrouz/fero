//! Tier-2 bulk: a 300-seed sweep in-suite — the CI form of `npm run sim`.
// Each seed is a whole-cluster trajectory under a seed-drawn fault personality;
// monitors run per event; convergence and drain are asserted at true quiescence.
// Contrast with what this replaces in v2: protocol coverage lived in wall-clock
// TCP tests (a permanently-red 246/249 baseline on the dev box, ~1/8 flakes,
// sleep()-based negative assertions) and its randomized soak explored ONE frozen
// seed. Here 300 distinct trajectories run in well under a second, and any
// failure prints the seed that reproduces it bit-for-bit.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, drained } from './monitors.ts'

test('300-seed sweep: duplication/delay faults, writes racing formation, a partition/heal window on odd seeds', () => {
  const failures: string[] = []
  for (let seed = 0; seed < 300; seed++) {
    try {
      const sim = new Sim(seed)
      const nodes = cluster(sim, 3)
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
      //! writes start DURING formation — digest-on-admit AE is what makes this converge (the dial-race loss fix)
      writes(sim, nodes, 40)
      //! odd seeds also take a partition/heal hit mid-writes: tail loss both ways, healed by the re-admit digests.
      // The window is bounded well under redial exhaustion (base 20ms × 10 tries ≈ 2.5s of backoff runway).
      if (seed % 2) {
        const a = nodes[Math.floor(sim.rng() * 3)].uuid
        let b = a
        while (b === a) b = nodes[Math.floor(sim.rng() * 3)].uuid
        const cut = 20 + sim.rng() * 150
        sim.at(cut, () => sim.partition(a, b))
        sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
      }
      const violations = sim.run()
      const bad =
        (violations.length && `monitor ${violations[0].monitor}: ${violations[0].detail}`) ||
        (!formed(nodes) && 'never formed') ||
        (!sim.quiesced && 'never quiesced') ||
        converged(sim) ||
        drained(sim)
      if (bad) failures.push(`seed ${seed}: ${bad}`)
    } catch (e) {
      //! a throwing seed (runaway guard, kernel bug) must report its seed and let the sweep continue — one bad
      // seed aborting the loop would mask whether OTHER seeds fail (adversarial-review finding on the guard)
      failures.push(`seed ${seed}: threw ${e}`)
    }
  }
  assert.deepEqual(failures, [])
})
