// Shared helpers for the test + perf suites (and any pure bits the library can
// reuse). These were copy-pasted into nearly every *.test.ts / *.perf.ts before
// they were collected here.
//
// Naming convention (see CLAUDE.md): group related operations under a lowercase
// NOUN namespace and name the method for the ACTION — `ports.free()`,
// `bench.time()`, `bench.median()`. Keep one-off predicates and actions FLAT —
// `until()`, `sleep()`, `connected()`, `apply()`. Prefer `ports.free()` over a
// `freePort`/`free_port` free function: the noun reads as the thing you're
// asking for, the verb as what you want done to it.

import net from 'node:net'
import { value } from '../../data/index.ts'
import { STATUS } from '../transport/peer.ts'
import type { ChangeRecord } from '../transport/message.ts'

// ── ports ────────────────────────────────────────────────────────────────────
export const ports = {
  // Ask the OS for a port it just confirmed free (listen(0) → read it back →
  // close). This is a now-snapshot, not a reservation — the port is free at
  // resolve time, which is exactly what a fresh test listener wants.
  free: (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port
        s.close(() => resolve(port))
      })
    }),
}

// ── bench ────────────────────────────────────────────────────────────────────
// The perf-suite timing primitive: one untimed warmup (JIT + caches), then the
// median of five timed runs — robust to a single scheduling spike on a loaded
// box. Per CLAUDE.md, perf siblings assert `ok(elapsed < threshold)` against
// this; never widen a threshold to pass — investigate the regression instead.
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

// ── flat helpers ─────────────────────────────────────────────────────────────

// A setTimeout you can await.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Poll `check` every 5ms until it passes or `ms` elapses. Resolves true if it
// passed, false on timeout — callers `assert.ok(await until(...))` so a timeout
// fails the test loudly instead of hanging it.
export const until = async (check: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await sleep(5)
  }
  return true
}

// True when `addr` is a connected peer in a mesh/cluster's `peers` ViewProxy.
// Works for both the L0 mesh and the L2 cluster surface — both expose `.peers`.
export const connected = (mesh: any, addr: string): boolean =>
  (mesh.peers[addr]?.status?.[value] ?? -1) === STATUS.connected

// Apply one change record to a `data` res (the [view].res write contract) — the
// receive path every replica runs. Callers applying a whole frame iterate
// `frame.records()` and call this per record.
export const apply = (res: any, record: ChangeRecord): void => {
  if (record.type === 'update') res.update(record.value, record.key)
  else if (record.type === 'insert') res.insert(record.value, record.key, record.at)
  else if (record.type === 'remove') res.remove(record.key)
}
