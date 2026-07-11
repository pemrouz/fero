//! ── sim/monitors — invariants evaluated after EVERY event, not at scenario end ─
// v2 found its four write-path conflict sources one adversarial review at a
// time; a monitor evaluated per event under seed sweep finds the violating
// trajectory automatically, at the exact event that violated it. M0 ships the
// invariants the M0 kernel claims; each later milestone ADDS monitors
// (single-writer-per-(partition,epoch) at M3, watermark ordering at M4,
// exactly-R at M6) — the monitor list is the machine-checkable form of the
// plan's semantics section.

import { Node, stable } from '../kernel/node.ts'
import { MAX_QUEUED } from '../kernel/link.ts'
import { partitionOf } from '../kernel/env.ts'
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
    // interior record became permanently unshippable). The cursor is keyed to the NODE OBJECT: a sim
    // restart (sim.add replacing a node) resets the scan, or a stale cursor would silently skip the
    // reborn node's early entries (adversarial-review monitor-blindness finding).
    name: 'log-monotone',
    check: (() => {
      const tail = new Map<string, { node: Node; len: number }>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            if (!prev || prev.node !== n) prev = { node: n, len: 0 }
            if (entries.length > prev.len) {
              for (let i = Math.max(prev.len, 1); i < entries.length; i++)
                if (entries[i].seq <= entries[i - 1].seq)
                  return `${id} log[${origin}] non-ascending at ${i}: ${entries[i].seq} after ${entries[i - 1].seq}`
              prev.len = entries.length
            }
            tail.set(k, prev)
          }
        return null
      }
    })(),
  },
  {
    //! M3's headline invariant (the plan's single-writer monitor, v2 DECISIONS AA made structural):
    // for any (partition, epoch>0), at most ONE origin ever stamps a record — every AA conflict source
    // was some node stamping a partition it didn't solely own. Epoch 0 is exempt BY DESIGN (open
    // genesis is multi-writer LWW). Incremental over appended log tails, like log-monotone; checked
    // across ALL nodes' logs so a violation is caught wherever the colliding record first lands. The
    // cursor is keyed to the NODE OBJECT so a sim restart rescans from 0 (a stale cursor would blind
    // the monitor exactly around the AA #4 restart shape it exists to police).
    name: 'single-writer',
    check: (() => {
      const owner = new Map<string, string>()
      const tail = new Map<string, { node: Node; len: number }>()
      //! provenance LANES (uuid~incarnation) normalize to the NODE: the invariant is one WRITER per
      // (partition, epoch), and a reborn life stamping the partition its uuid still owns is the same writer
      const writerOf = (origin: string) => { const i = origin.indexOf('~'); return i < 0 ? origin : origin.slice(0, i) }
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            if (!prev || prev.node !== n) prev = { node: n, len: 0 }
            if (entries.length > prev.len) {
              const w = writerOf(origin)
              for (let i = prev.len; i < entries.length; i++) {
                const e = entries[i]
                if (e.epoch === 0) continue
                const pk = partitionOf(e.rec) + '|' + e.epoch
                const held = owner.get(pk)
                if (held === undefined) owner.set(pk, w)
                else if (held !== w)
                  return `TWO writers stamped partition '${partitionOf(e.rec)}' at epoch ${e.epoch}: ${held} and ${w} (seen at ${id})`
              }
              prev.len = entries.length
            }
            tail.set(k, prev)
          }
        return null
      }
    })(),
  },
  {
    //! attempt-exactly-once — invariant 2 pinned DIRECTLY: one (issuer, cid) commits at most one
    // distinct (origin, seq, epoch) anywhere in the cluster. Attempt identity rides committed records
    // (FLAG_ATTEMPT) precisely so this is checkable — the adversarial review's critical (a retry
    // crossing an ownership move re-committed, resurrecting a stale value over a newer write) is a
    // violation HERE at the re-committing event, even though single-writer (per-epoch) cannot see it.
    name: 'attempt-exactly-once',
    check: (() => {
      const committed = new Map<string, string>()
      const tail = new Map<string, { node: Node; len: number }>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            if (!prev || prev.node !== n) prev = { node: n, len: 0 }
            if (entries.length > prev.len) {
              for (let i = prev.len; i < entries.length; i++) {
                const e = entries[i]
                if (e.iss === undefined) continue
                const ak = e.iss + '|' + e.cid
                const at = origin + '|' + e.seq + '|' + e.epoch
                const held = committed.get(ak)
                if (held === undefined) committed.set(ak, at)
                else if (held !== at)
                  return `attempt ${ak} committed TWICE: ${held} and ${at} (seen at ${id})`
              }
              prev.len = entries.length
            }
            tail.set(k, prev)
          }
        return null
      }
    })(),
  },
  {
    //! per-origin applied watermarks are monotone by construction — a regression here means dup/dedup
    // broke. Keyed to the node OBJECT: a restarted node legitimately restarts its watermarks from 0.
    name: 'watermark-monotone',
    check: (() => {
      const last = new Map<string, { node: Node; applied: number }>()
      return (sim: Sim): string | null => {
        for (const [id, n] of sim.nodes)
          for (const [origin, s] of n.streams) {
            const k = id + '|' + origin
            let prev = last.get(k)
            if (!prev || prev.node !== n) prev = { node: n, applied: 0 }
            if (s.applied < prev.applied) return `${id} stream ${origin} watermark went backwards: ${s.applied} < ${prev.applied}`
            prev.applied = s.applied
            last.set(k, prev)
          }
        return null
      }
    })(),
  },
  {
    //! the watermark LADDER (M4a, plan §5 verbatim): applied ≥ shippable ≥ durable, per stream, at every
    // instant. This ordering is what makes v2's recvReplProbe false positive unwritable — evidence for a
    // stronger guarantee can never run ahead of the weaker one it implies. Durable stays 0 until M4b's
    // storage lands; the monitor is armed FIRST so nothing can ever violate the contract unobserved.
    name: 'watermark-ordering',
    check: (sim: Sim): string | null => {
      for (const [id, n] of sim.nodes)
        for (const [origin, s] of n.streams) {
          if (s.shippable > s.applied) return `${id} stream ${origin}: shippable ${s.shippable} > applied ${s.applied}`
          if (s.durable > s.shippable) return `${id} stream ${origin}: durable ${s.durable} > shippable ${s.shippable}`
        }
      return null
    },
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

//! confirmedIntact — the no-confirmed-write-lost check (plan §6): every probe the ladder answered OK
// names a record that must still EXIST — in at least one live node's log always, and (R=∞, converged)
// in EVERY live node's log. Run at end-of-horizon like converged(); the M4e restore proof runs it
// after killing and rebooting the whole cluster from WALs. Null = intact; else the lost coordinates.
export const confirmedIntact = (sim: Sim): string | null => {
  for (const c of sim.confirms.values()) {
    if (c.ok !== true) continue
    for (const [id, n] of sim.nodes) {
      const held = n.logs.get(c.origin)?.some((e) => e.seq === c.seq)
      if (!held) return `confirmed (${c.origin}, ${c.seq}) level ${c.level} is MISSING at ${id}`
    }
  }
  return null
}

//! drained — at quiescence nothing may be parked: every paused-link queue must be empty.
export const drained = (sim: Sim): string | null => {
  for (const [id, n] of sim.nodes)
    for (const l of n.links.values()) if (l.queued.length) return `${id} link ${l.id} has ${l.queued.length} undelivered frames`
  return null
}
