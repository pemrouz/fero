// sections/contract/replay.worker.js — "same seed, same run" (05 The contract), in a module Worker.
// Builds a twin of the page's house cluster from its seed (core.js LiveCluster — DOM-free, unpaced), replays the
// visitor's action log into it the way LiveCluster.replay does, and compares the twin with the page:
//   · at checkpoints the page recorded between frames: events, traceCount and traceHash (the rolling hash of
//     sim.trace — the stepped node's state hash after every event),
//   · and at the end of each check: the same three, at the page's simulated time when the check was asked for.
// The twin is KEPT between checks: each message carries only the entries since the last one, so a check costs
// the new events, not the whole session. Feeding the same entries in pieces is the same run as feeding them at
// once: runTo() only runs the events due by a time, and an action posts at the twin's clock, exactly as on the
// page. `fresh` starts a new twin (first check, or after the page's reset).
// Entries arrive merged in the order they happened on the page:
//   { op: <a LiveCluster action>, at, ev, args }   page.actions, verbatim — including { op: 'probe' }: the sections
//                                                   log each confirm probe there, since a probe is an event too
//   { op: 'cp', at, events, tc, th }                a checkpoint
// A divergence is sticky: once a checkpoint or an end state differs, the run stays "diverged" until a fresh twin.
import { LiveCluster } from '../../core.js'

let twin = null, run = null

onmessage = ({ data }) => {
  const { id, fresh, opts, entries, final } = data
  const t0 = performance.now()
  try {
    if (fresh || !twin) {
      twin = new LiveCluster({ ...opts, paced: false })
      run = { lastGood: null, firstBad: null, threw: null, ms: 0 }
    }
    for (const e of entries) {
      twin.runTo(e.at)
      if (e.op === 'cp') {
        if (run.firstBad !== null) continue
        if (twin.events === e.events && twin.traceCount === e.tc && twin.traceHash === e.th) run.lastGood = e.events
        else run.firstBad = e.events
        continue
      }
      try { twin[e.op](...e.args) } catch (err) { if (!run.threw) run.threw = { op: e.op, ev: e.ev, message: String((err && err.message) || err) } }
    }
    twin.runTo(final.now)
    if (run.firstBad === null) {
      if (twin.events === final.events && twin.traceCount === final.tc && twin.traceHash === final.th) run.lastGood = final.events
      else run.firstBad = final.events
    }
    run.ms += performance.now() - t0
    postMessage({
      id, ok: true, same: run.firstBad === null,
      events: twin.events, tc: twin.traceCount, th: twin.traceHash, now: twin.now,
      // where they parted: after the last check that matched, at or before the first that did not
      after: run.lastGood ?? 0, by: run.firstBad ?? final.events,
      threw: run.threw,
      ms: run.ms, // the twin's compute so far, summed over every check (measured here, on this machine)
    })
  } catch (err) {
    twin = null; run = null
    postMessage({ id, ok: false, error: String((err && err.message) || err), ms: performance.now() - t0 })
  }
}
