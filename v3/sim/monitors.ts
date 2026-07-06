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
    //! M2's headline safety invariant: at most ONE view commits per epoch — two nodes installing
    // DIFFERENT member sets for the same epoch is split-brain, the exact bug class ballots exist to kill.
    name: 'one-view-per-epoch',
    check: (() => {
      const seen = new Map<number, string>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes) {
          const v = n.membership.view
          if (v.epoch === 0) continue
          const key = JSON.stringify(v.members)
          const prev = seen.get(v.epoch)
          if (prev === undefined) seen.set(v.epoch, key)
          else if (prev !== key) return `${id} installed a DIFFERENT view for epoch ${v.epoch}: ${key} vs ${prev}`
        }
        return null
      }
    })(),
  },
  {
    //! committed epochs never go backwards — install() only accepts strictly newer views
    name: 'epoch-monotone',
    check: (() => {
      const last = new Map<string, number>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes) {
          const prev = last.get(id) ?? 0
          if (n.epoch < prev) return `${id} epoch went backwards: ${n.epoch} < ${prev}`
          last.set(id, n.epoch)
        }
        return null
      }
    })(),
  },
  {
    //! per-origin LOGS are strictly seq-ascending — the structural invariant the AE suffix-slicer's
    // tail walk depends on. Checked incrementally (only appended tails), so it names the exact event
    // that poisoned a log (seed-79 regression: a self-echo append made a log non-monotone and an
    // interior record became permanently unshippable).
    name: 'log-monotone',
    check: (() => {
      const tail = new Map<string, { len: number; seq: number }>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            const prev = tail.get(k) ?? { len: 0, seq: 0 }
            if (entries.length > prev.len) {
              for (let i = Math.max(prev.len, 1); i < entries.length; i++)
                if (entries[i].seq <= entries[i - 1].seq)
                  return `${id} log[${origin}] non-ascending at ${i}: ${entries[i].seq} after ${entries[i - 1].seq}`
              tail.set(k, { len: entries.length, seq: entries[entries.length - 1].seq })
            }
          }
        return null
      }
    })(),
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
