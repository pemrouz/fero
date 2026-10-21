// sections/trust/sweep.worker.js — 04 Why trust it: the repo's chaos sweep, in a module Worker, so the page stays free.
// Adapted from next/sections/contract/sweep.worker.js. One seed here is exactly one seed of `npm run sim`
// (sim/run.ts at HEAD): sweepBuild(seed, nodes, writes)(null), then sim.run({ checkEvery, maxEvents }) at run.ts's
// defaults, judged the way run.ts judges it — the first broken rule, then formed, quiesced, converged, drained — and a
// throwing seed is a failed seed, never a skipped one. The kernel and simulator files are the stripped copies in
// ../../lib, the same ones the page's own cluster runs.
//
// In:  { id, from, to, nodes, writes }
// Out: { id, type: 'seed', seed, events, cut, fail, t }   after every seed (t: ms since this run began, this machine)
//      { id, type: 'done', from, to, seeds, events, failed, ms, rules }
import { sweepBuild } from '../../lib/sim/shrink.js'
import { formed } from '../../lib/sim/harness.js'
import { converged, drained } from '../../lib/sim/monitors.js'

const CHECK_EVERY = 1          // sim/run.ts: arg('check-every', 1) — a monitor pass after every event
const MAX_EVENTS = 1_000_000   // sim/run.ts: arg('max-events', 1_000_000) — the runaway guard

onmessage = ({ data }) => {
  const { id, from, to, nodes, writes } = data
  let events = 0, failed = 0, rules = 0
  const t0 = performance.now()
  for (let seed = from; seed < to; seed++) {
    let ev = 0, fail = null, cut = false
    try {
      const { sim, nodes: ns, planned } = sweepBuild(seed, nodes, writes)(null)
      // the run's own plan says whether it cuts the network (odd seeds, sweepBuild's partition/heal window)
      cut = planned.some((s) => s.op === 'partition')
      rules = sim.monitors.length
      const violations = sim.run({ checkEvery: CHECK_EVERY, maxEvents: MAX_EVENTS })
      ev = sim.events
      fail =
        (violations.length && `rule ${violations[0].monitor} broke at event ${violations[0].event}: ${violations[0].detail}`) ||
        (!formed(ns) && 'the servers never all connected') ||
        (!sim.quiesced && 'it never went quiet') ||
        converged(sim) ||
        drained(sim) ||
        null
    } catch (e) {
      fail = `threw ${e}` // run.ts: a throwing seed reports and the sweep continues
    }
    events += ev
    if (fail) failed++
    postMessage({ id, type: 'seed', seed, events: ev, cut, fail, t: performance.now() - t0 })
  }
  postMessage({ id, type: 'done', from, to, seeds: to - from, events, failed, ms: performance.now() - t0, rules })
}
