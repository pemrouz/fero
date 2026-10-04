// sections/cluster/vote.worker.js — the caption's two vote times, off the main thread. They come from the SAME own
// runs section 02 prints (sections/break/runs.js, imported here, never copied), so one seed gives one crash instant,
// one stepping rule and one number wherever the page shows it:
//   x: break/runs.js scenario('crash') — this page's settings (core.js HOUSE: heartbeat 100 ms, the harness's redial,
//      links 30–90 ms simulated): view 1 forms, the owner of gadgets crashes, c1 writes, and x is the crash to the
//      first survivor's install of a view without it (journal viewInstall, simulated clock).
//   z: break/runs.js defaultsRun — the same vote at fero's defaults (heartbeat.ms and redial.ms as api/index.ts sets
//      them, passed in from the build facts), three durable servers built with sim.add, the house link delay.
// Both are simulated times, produced by the kernel. Nothing here is typed into the page.
import { scenario, defaultsRun } from '../break/runs.js'

self.onmessage = (e) => {
  const { seed, heartbeatMs, redialMs, delay } = e.data
  try {
    const c = scenario('crash', seed)
    const d = defaultsRun(seed, { heartbeatMs, redialMs, delay })
    const x = c.vote ? { ms: c.vote.at - c.t0, victim: c.target, violations: c.violations } : { ms: null }
    const z = d.voteMs != null ? { ms: d.voteMs, violations: d.violations } : { ms: null }
    self.postMessage({ seed, x, z })
  } catch (err) { self.postMessage({ seed, error: String(err && err.message || err) }) }
}
