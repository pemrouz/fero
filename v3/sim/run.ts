//! ── sim/run — the M0 demonstrable: `npm run sim -- --seeds 1000` ─────────────
// Sweeps N seeded whole-cluster trajectories with per-pair fault personalities
// (delay spread, duplication — which under a delay range also manufactures
// reordering) and asserts formation, convergence, drain, and the per-event
// bound monitors on every one. A failure prints its seed + violation — the
// failure IS the reproduction command (plan §6). Contrast: v2's randomized
// soak explored exactly ONE frozen trajectory (seed 0x9e3779b9, 16 steps,
// sleep(250) granularity) and each run cost wall-clock seconds.

import { mkdirSync, writeFileSync } from 'node:fs'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, drained } from './monitors.ts'
import { captureSim } from '../tools/debug/capture.ts'

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}

const seeds = arg('seeds', 1000)
const nNodes = arg('nodes', 3)
const nWrites = arg('writes', 40)
//! --capture N: force-write seed N's capture even when green (for exploring a healthy trajectory in the viewer)
const forceCapture = arg('capture', -1)

//! tests ARE debug artifacts (plan §8): a failing seed doesn't just print — it writes a capture the
// viewer opens directly, so triage starts from a rendered timeline instead of a repro command.
const saveCapture = (sim: Sim, why: string): string => {
  mkdirSync('captures', { recursive: true })
  const path = `captures/seed-${sim.seed}.json`
  writeFileSync(path, JSON.stringify(captureSim(sim)))
  console.error(`  capture (${why}): npm run debug -- ${path}`)
  return path
}

let failed = 0
let events = 0
const t0 = performance.now()

for (let seed = 0; seed < seeds; seed++) {
  try {
    const sim = new Sim(seed)
    const nodes = cluster(sim, nNodes)
    //! per-pair personalities drawn from the seed: uneven delays + up to 25% duplication
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        sim.fault(nodes[i].uuid, nodes[j].uuid, {
          delay: [1, 1 + sim.rng() * 25],
          dupP: sim.rng() * 0.25,
        })
    //! writes race mesh formation deliberately — digest-on-admit AE (the dial-race loss fix) must make them converge
    writes(sim, nodes, nWrites)
    //! odd seeds add a partition/heal window mid-writes: tail loss both directions, healed by re-admit digests
    if (seed % 2) {
      const a = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      let b = a
      while (b === a) b = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      const cut = 20 + sim.rng() * 150
      sim.at(cut, () => sim.partition(a, b))
      sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
    }
    const violations = sim.run()
    events += sim.events

    const fail =
      (violations.length && `monitor: ${violations[0].monitor} — ${violations[0].detail} (event ${violations[0].event})`) ||
      (!formed(nodes) && 'mesh never fully formed') ||
      (!sim.quiesced && 'never quiesced') ||
      converged(sim) ||
      drained(sim)
    if (fail) {
      failed++
      console.error(`✗ seed ${seed}: ${fail}`)
      console.error(`  repro: new Sim(${seed}) + cluster(${nNodes}) + writes(${nWrites})`)
      saveCapture(sim, String(fail))
    } else if (seed === forceCapture) {
      saveCapture(sim, 'requested via --capture')
    }
  } catch (e) {
    failed++ // a throwing seed reports and the sweep continues — never mask the rest of the seed space
    console.error(`✗ seed ${seed}: threw ${e}`)
  }
}

const ms = performance.now() - t0
console.log(
  `${seeds - failed}/${seeds} seeds green · ${nNodes} nodes · ${nWrites} writes/run · ` +
    `${events.toLocaleString()} events in ${ms.toFixed(0)}ms (${Math.round(events / (ms / 1000)).toLocaleString()} events/s)`,
)
if (failed) process.exit(1)
