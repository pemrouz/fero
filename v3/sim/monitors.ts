//! ── sim/monitors — invariants evaluated after EVERY event, not at scenario end ─
// v2 found its four write-path conflict sources one adversarial review at a
// time; a monitor evaluated per event under seed sweep finds the violating
// trajectory automatically, at the exact event that violated it. M0 ships the
// invariants the M0 kernel claims; each later milestone ADDS monitors
// (single-writer-per-(partition,epoch) at M3, watermark ordering at M4,
// exactly-R at M6) — the monitor list is the machine-checkable form of the
// plan's semantics section.

import { stable } from '../kernel/node.ts'
import { MAX_QUEUED } from '../kernel/link.ts'
import type { Sim } from './exec.ts'

//! perEvent — invariants that must hold at every instant, checked after every event.
// A FACTORY, not a shared array: the watermark monitor carries per-run memory, and
// module-level monitor state bleeding across seeds would poison every sweep after the first.
export const perEvent = () => [
  {
    //! the REAL send-plane invariant: frames may sit queued ONLY while the link is paused — a drain that
    // fails to release the queue, or a ship that queues while flowing, violates this immediately. (The raw
    // MAX_QUEUED bound is deliberately NOT monitored alone: ship() enforces it at the only push site, so a
    // bound-only check is a tautology — an adversarial-review finding.)
    name: 'queued-implies-paused',
    check: (sim: Sim): string | null => {
      for (const [id, n] of sim.nodes)
        for (const l of n.links.values()) {
          if (l.queued.length > 0 && !l.paused) return `${id} link ${l.id} has ${l.queued.length} queued frames while FLOWING`
          if (l.queued.length > MAX_QUEUED) return `${id} link ${l.id} queued ${l.queued.length} > ${MAX_QUEUED}`
        }
      return null
    },
  },
  {
    //! per-origin applied watermarks are monotone by construction — a regression here means dup/dedup broke
    name: 'watermark-monotone',
    check: (() => {
      const last = new Map<string, number>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, s] of n.streams) {
            const k = id + '|' + origin
            const prev = last.get(k) ?? 0
            if (s.seen < prev) return `${id} stream ${origin} watermark went backwards: ${s.seen} < ${prev}`
            last.set(k, s.seen)
          }
        return null
      }
    })(),
  },
]

//! converged — the quiescence check: every node holds the identical state (hash first, then a real diff for the report).
// Null = converged; otherwise a human-readable divergence description — the
// monitor's job is not just to fail but to say WHERE (plan §8 honesty rules).
export const converged = (sim: Sim): string | null => {
  const nodes = [...sim.nodes.entries()]
  if (nodes.length < 2) return null
  const [refId, ref] = nodes[0]
  for (const [id, n] of nodes.slice(1)) {
    if (n.stateHash === ref.stateHash && n.state.size === ref.state.size) continue
    //! hashes differ — produce the actual diff so a failed seed's report names keys, not just numbers.
    // Values compare via stable() (the hash's own equality: NaN-aware, bytes-aware) — JSON.stringify
    // renders NaN as null and Uint8Array as a plain object, which would report matching entries under a
    // genuinely different state.
    const keys = new Set([...ref.state.keys(), ...n.state.keys()])
    for (const k of keys) {
      const inRef = ref.state.has(k), inN = n.state.has(k)
      if (inRef !== inN || stable(ref.state.get(k)) !== stable(n.state.get(k)))
        return `${refId} vs ${id} at ${k}: ${JSON.stringify(ref.state.get(k))}${inRef ? '' : '(absent)'} vs ${JSON.stringify(n.state.get(k))}${inN ? '' : '(absent)'}`
    }
    return `${refId} vs ${id}: hash differs (${ref.stateHash} vs ${n.stateHash}) but entries match — hash bug`
  }
  return null
}

//! drained — at quiescence nothing may be parked: every paused-link queue must be empty.
export const drained = (sim: Sim): string | null => {
  for (const [id, n] of sim.nodes)
    for (const l of n.links.values()) if (l.queued.length) return `${id} link ${l.id} has ${l.queued.length} undelivered frames`
  return null
}
