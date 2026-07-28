//! ── sim/run — the M0 demonstrable: `npm run sim -- --seeds 1000` ─────────────
// Sweeps N seeded whole-cluster trajectories with per-pair fault personalities
// (delay spread, duplication — which under a delay range also manufactures
// reordering) and asserts formation, convergence, drain, and the per-event
// bound monitors on every one. A failure prints its seed + violation — the
// failure IS the reproduction command (plan §6). Contrast: v2's randomized
// soak explored exactly ONE frozen trajectory (seed 0x9e3779b9, 16 steps,
// sleep(250) granularity) and each run cost wall-clock seconds.

import { mkdirSync, writeFileSync } from 'node:fs'
import type { Sim } from './exec.ts'
import { formed } from './harness.ts'
import { converged, drained } from './monitors.ts'
import { shrink, sweepBuild } from './shrink.ts'
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

//! auto-shrink (M7, DESIGN-M7 §2): a failing seed's capture is joined by a MINIMAL one — same class,
// 1-minimal steps, frozen at the violation. Opt-out with --no-shrink. The baseline-events check is the
// empirical build-contract gate: if sweepBuild(null) doesn't replay the failing run exactly, say so and
// keep only the honest full capture.
const noShrink = process.argv.includes('--no-shrink')
const autoShrink = (seed: number, orig: Sim | null) => {
  if (noShrink) return
  const s = shrink(sweepBuild(seed, nNodes, nWrites))
  if (!s) { console.error('  shrink: could not reproduce — keeping the full capture only'); return }
  if (orig && s.from.events !== orig.events) {
    console.error(`  shrink: baseline diverged from the failing run (${s.from.events} vs ${orig.events} events) — keeping the full capture only`)
    return
  }
  mkdirSync('captures', { recursive: true })
  const path = `captures/seed-${seed}.shrunk.json`
  writeFileSync(path, JSON.stringify(captureSim(s.sim, s)))
  console.error(`  shrunk ${s.from.steps}→${s.steps.length} steps (${s.runs} runs${s.capped ? ', budget-capped' : ''}): npm run debug -- ${path}`)
  console.error(`    original: ${s.from.fail}`)
  console.error(`    minimal:  ${s.fail}`)
}

let failed = 0
let events = 0
const t0 = performance.now()

for (let seed = 0; seed < seeds; seed++) {
  try {
    //! the sweep scenario lives in sweepBuild (shrink.ts) — ONE definition serves the sweep AND the shrinker;
    // draw order is byte-identical to the pre-M7 inline block (pinned by shrink.test.ts + the frozen event count)
    const { sim, nodes } = sweepBuild(seed, nNodes, nWrites)(null)
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
      autoShrink(seed, sim)
    } else if (seed === forceCapture) {
      saveCapture(sim, 'requested via --capture')
    }
  } catch (e) {
    failed++ // a throwing seed reports and the sweep continues — never mask the rest of the seed space
    console.error(`✗ seed ${seed}: threw ${e}`)
    autoShrink(seed, null)
  }
}

const ms = performance.now() - t0
console.log(
  `${seeds - failed}/${seeds} seeds green · ${nNodes} nodes · ${nWrites} writes/run · ` +
    `${events.toLocaleString()} events in ${ms.toFixed(0)}ms (${Math.round(events / (ms / 1000)).toLocaleString()} events/s)`,
)
if (failed) process.exit(1)
