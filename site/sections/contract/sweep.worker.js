// sections/contract/sweep.worker.js — the repo's chaos sweep, in a module Worker (05 The contract).
// One seed here is exactly one seed of `npm run sim` (sim/run.ts): sweepBuild(seed, nodes, writes)(null), then
// sim.run({ checkEvery, maxEvents }) at run.ts's defaults, judged the way run.ts judges it — the first broken
// rule, then formed, quiesced, converged, drained — and a throwing seed is a failed seed, never a skipped one.
// The kernel and simulator files are the stripped copies in ../../lib, the same ones the page runs.
import { sweepBuild } from '../../lib/sim/shrink.js'
import { formed } from '../../lib/sim/harness.js'
import { converged, drained } from '../../lib/sim/monitors.js'

const CHECK_EVERY = 1          // sim/run.ts: arg('check-every', 1) — a monitor pass after every event
const MAX_EVENTS = 1_000_000   // sim/run.ts: arg('max-events', 1_000_000) — the runaway guard

onmessage = ({ data }) => {
  const { id, from, to, nodes, writes } = data
  let events = 0, failed = 0
  const t0 = performance.now()
  for (let seed = from; seed < to; seed++) {
    let ev = 0, fail = null
    try {
      const { sim, nodes: ns } = sweepBuild(seed, nodes, writes)(null)
      const violations = sim.run({ checkEvery: CHECK_EVERY, maxEvents: MAX_EVENTS })
      ev = sim.events
      fail =
        (violations.length && `monitor: ${violations[0].monitor} — ${violations[0].detail} (event ${violations[0].event})`) ||
        (!formed(ns) && 'mesh never fully formed') ||
        (!sim.quiesced && 'never quiesced') ||
        converged(sim) ||
        drained(sim) ||
        null
    } catch (e) {
      fail = `threw ${e}` // run.ts: a throwing seed reports and the sweep continues
    }
    events += ev
    if (fail) failed++
    postMessage({ id, type: 'seed', seed, events: ev, fail, t: performance.now() - t0 })
  }
  postMessage({ id, type: 'done', from, to, seeds: to - from, events, failed, ms: performance.now() - t0, nodes, writes })
}
