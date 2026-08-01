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
  //! timeAsync — the SAME discipline (one untimed warmup + median-of-5) for Tier-3 probes whose rep
  // completes via the event loop (a socket round-trip awaited on a counter). Lives here so every
  // async perf probe measures identically to the sync ones (the perf-primitive-lives-in-#utils rule).
  timeAsync: async (fn: () => Promise<void>): Promise<number> => {
    await fn() // warmup
    const xs: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      await fn()
      xs.push(performance.now() - t0)
    }
    return bench.median(xs)
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

//! ── alloc — the --expose-gc heap instruments (M8, DESIGN-M8): count-shaped, physics-backed ────
// Plain Node has no allocation counter; what IS honestly assertable is gc-fenced heap deltas plus
// GC-EVENT PHYSICS: a loop that allocates nothing can never trigger a scavenge, so gcEvents === 0
// across a measured window is a categorical zero-garbage witness. The conjunct matters (the M8
// panel's adjudicated finding): scavenges EAT a naked heap delta, so the delta SHRINKS as a
// regression grows — min-of-k over naked deltas selects the most-truncated window and false-passes
// exactly the failures the gate exists to catch. delta-≤-slack catches sub-scavenge totals, the
// event count catches scavenge-truncated ones — sound at every regression magnitude. Heap counters
// do not inherit WSL2 CPU contention: these are count-class gates, legal on any box.
import { PerformanceObserver } from 'node:perf_hooks'

const gcOrThrow = (): (() => void) => {
  const g = (globalThis as { gc?: () => void }).gc
  if (typeof g !== 'function') throw new Error('alloc.* needs --expose-gc — run via `npm run perf`')
  return g
}
//! 'gc' performance entries deliver ASYNC — a double setImmediate flushes them before counters are read
const gcSettle = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)))

export const alloc = {
  //! garbage — the best window of {bytes, gcEvents} over k runs of fn(n): gc-fenced BEFORE, never
  // after (a trailing collect would erase the very garbage being measured). fn must be strictly
  // synchronous — anything async inside a window breaks the event attribution. The caller's PASS is
  // the conjunct: gcEvents === 0 && bytes ≤ instrument slack.
  async garbage(fn: (n: number) => void, n: number, opts: { k?: number; warm?: number } = {}): Promise<{ bytes: number; gcEvents: number }> {
    const gc = gcOrThrow()
    const k = opts.k ?? 5
    fn(opts.warm ?? Math.min(n, 10_000)) // JIT warmup allocates (compilation, IC transitions) — never measured
    let events = 0
    const obs = new PerformanceObserver((list) => { events += list.getEntries().length })
    obs.observe({ entryTypes: ['gc'] })
    let best: { bytes: number; gcEvents: number } | null = null
    for (let w = 0; w < k; w++) {
      gc(); gc()
      await gcSettle()
      const e0 = events
      const h0 = process.memoryUsage().heapUsed
      fn(n)
      const d = process.memoryUsage().heapUsed - h0
      await gcSettle()
      const win = { bytes: Math.max(0, d), gcEvents: events - e0 }
      if (!best || win.gcEvents < best.gcEvents || (win.gcEvents === best.gcEvents && win.bytes < best.bytes)) best = win
    }
    obs.disconnect()
    return best!
  },
  //! retained — min over FULLY-fenced windows (gc both sides) of what fn(n) durably kept. min-of-k
  // is valid HERE because retention noise is one-sided additive — unlike over naked garbage deltas.
  async retained(fn: (n: number) => void, n: number, opts: { k?: number; warm?: number } = {}): Promise<number> {
    const gc = gcOrThrow()
    const k = opts.k ?? 5
    fn(opts.warm ?? Math.min(n, 10_000))
    let min = Infinity
    for (let w = 0; w < k; w++) {
      gc(); gc()
      await gcSettle()
      const h0 = process.memoryUsage().heapUsed
      fn(n)
      gc(); gc()
      await gcSettle()
      min = Math.min(min, Math.max(0, process.memoryUsage().heapUsed - h0))
    }
    return min
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
