// Shared test/perf helpers, noun.verb()-namespaced — collected from copy-paste across every *.test.ts/*.perf.ts.

import net from 'node:net'
import { value } from '../../data/index.ts'
import { STATUS } from '../transport/peer.ts'

// ── ports ────────────────────────────────────────────────────────────────────
export const ports = {
  // free(): OS-confirmed free port via listen(0)→readback→close — a now-snapshot, not a reservation.
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
export const bench = {
  median: (xs: number[]): number => xs.slice().sort((a, b) => a - b)[xs.length >> 1],
  time: (fn: () => void): number => {
    fn()
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

// Poll `check` every 5ms until pass or timeout — returns false on timeout so the test fails loudly, not hangs.
export const until = async (check: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await sleep(5)
  }
  return true
}

// True when `addr` is a connected peer in a mesh/cluster `.peers` ViewProxy — works for both L0 mesh and L2 cluster.
export const connected = (mesh: any, addr: string): boolean =>
  (mesh.peers[addr]?.status?.[value] ?? -1) === STATUS.connected

// apply: re-export L1's applyRecord so the fixture provably IS the replica receive path and can't drift.
export { applyRecord as apply } from '../log/index.ts'
