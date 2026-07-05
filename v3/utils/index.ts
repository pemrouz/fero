//! Shared test/perf helpers — v2's #utils conventions carried over (noun.verb() namespaces, flat one-offs).
// Deliberately smaller than v2's: the simulation tiers don't need until()/sleep()
// at all (quiescence is a query, not a poll) — these exist for the thin Tier-3
// real-socket smoke tests and the perf siblings only.

import net from 'node:net'

//! ── ports ────────────────────────────────────────────────────────────────────
export const ports = {
  //! free(): OS-confirmed free port via listen(0)→readback→close — a now-snapshot, not a reservation.
  free: (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port
        s.close(() => resolve(port))
      })
    }),
}

//! ── bench ────────────────────────────────────────────────────────────────────
// One untimed warmup + median-of-5 — v2's primitive, kept verbatim. Absolute
// thresholds are the LAST line of perf defence here (WSL2 swings 2-3x); counted
// invariants and interleaved ratios come first (plan-v3.md §7).
export const bench = {
  median: (xs: number[]): number => xs.slice().sort((a, b) => a - b)[xs.length >> 1],
  time: (fn: () => void): number => {
    fn() // warmup
    return bench.median([0, 0, 0, 0, 0].map(() => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    }))
  },
}

//! ratio.interleaved — THE hot-path perf guard (plan §7): baseline and candidate alternated in ONE process, median
// ratio asserted. This is the v2 pattern that survived WSL2's 2-3x noise where absolute gates did not — promoted
// into #utils instead of being copy-pasted between perf files (it was duplicated verbatim in two v2 files).
export const ratio = {
  interleaved: (baseline: () => void, candidate: () => void, rounds = 7): number => {
    baseline(); candidate() // warmup both paths
    const rs: number[] = []
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now(); baseline(); const tb = performance.now() - t0
      const t1 = performance.now(); candidate(); const tc = performance.now() - t1
      rs.push(tc / Math.max(tb, 1e-6))
    }
    return bench.median(rs)
  },
}

//! ── flat helpers (Tier-3 only) ───────────────────────────────────────────────
//! A setTimeout you can await.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

//! Poll `check` every 5ms until pass or timeout — returns false on timeout so the test fails loudly, not hangs.
export const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await sleep(5)
  }
  return true
}
