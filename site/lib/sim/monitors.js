//! ── sim/monitors — invariants evaluated after EVERY event, not at scenario end ─
// v2 found its four write-path conflict sources one adversarial review at a
// time; a monitor evaluated per event under seed sweep finds the violating
// trajectory automatically, at the exact event that violated it. M0 ships the
// invariants the M0 kernel claims; each later milestone ADDS monitors
// (single-writer-per-(partition,epoch) at M3, watermark ordering at M4,
// exactly-R at M6) — the monitor list is the machine-checkable form of the
// plan's semantics section.

import { Node, stable, newer } from '../kernel/node.js'
import { SCOPE } from '../kernel/scope.js'
import { partitionOf, REC } from '../kernel/env.js'
import { foldInto,             } from './fold.js'
                                    

//! perEvent — invariants that must hold at every instant, checked after every event.
// A FACTORY, not a shared array: the watermark monitor carries per-run memory, and
// module-level monitor state bleeding across seeds would poison every sweep after the first.
export const perEvent = () => [
  {
    //! the REAL send-plane invariant: frames may sit queued ONLY while the link is paused — a drain that
    // fails to release the queue, or a ship that queues while flowing, violates this immediately. (The raw
    // queued bound (the node's tune row) is deliberately NOT monitored alone: ship() enforces it at the only push site, so a
    // bound-only check is a tautology — an adversarial-review finding.)
    name: 'queued-implies-paused',
    check: (sim     )                => {
      for (const [id, n] of sim.nodes)
        for (const l of n.links.values()) {
          if (l.queued.length > 0 && !l.paused) return `${id} link ${l.id} has ${l.queued.length} queued frames while FLOWING`
          if (l.queued.length > n.tune.queued) return `${id} link ${l.id} queued ${l.queued.length} > ${n.tune.queued}`
        }
      return null
    },
  },
  {
    //! M2's headline safety invariant: at most ONE view commits per epoch — two nodes installing
    // DIFFERENT member sets for the same epoch is split-brain, the exact bug class ballots exist to kill.
    name: 'one-view-per-epoch',
    check: (() => {
      const seen = new Map                ()
      return (sim     )                => {
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
    //! committed epochs never go backwards — install() only accepts strictly newer views. MEMBERS only: a
    // client's epoch is its feeder's number (I-23, amended 2026-10-08), and the cluster it looks at may be
    // reborn under fresh uuids at epoch 1 after it saw epoch 2 — the row follows the feeder, by design.
    name: 'epoch-monotone',
    check: (() => {
      const last = new Map                ()
      return (sim     )                => {
        for (const [id, n] of sim.nodes) {
          if (n.client) continue
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
      const tail = new Map                                                   ()
      return (sim     )                => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            //! the cursor keys on the log ARRAY's identity, not its length: compact() replaces the
            // array (rescan from 0 — idempotent), appends mutate it in place (incremental). A length
            // check alone was blind to a same-tick append+compact that left the length unchanged
            // while entries below the cursor were new (M4-review monitor-blindness finding).
            if (!prev || prev.node !== n || prev.arr !== entries) prev = { node: n, arr: entries, len: 0 }
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
      const owner = new Map                ()
      const tail = new Map                                                   ()
      //! provenance LANES (uuid~incarnation) normalize to the NODE: the invariant is one WRITER per
      // (partition, epoch), and a reborn life stamping the partition its uuid still owns is the same writer
      const writerOf = (origin        ) => { const i = origin.indexOf('~'); return i < 0 ? origin : origin.slice(0, i) }
      return (sim     )                => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            //! the cursor keys on the log ARRAY's identity, not its length: compact() replaces the
            // array (rescan from 0 — idempotent), appends mutate it in place (incremental). A length
            // check alone was blind to a same-tick append+compact that left the length unchanged
            // while entries below the cursor were new (M4-review monitor-blindness finding).
            if (!prev || prev.node !== n || prev.arr !== entries) prev = { node: n, arr: entries, len: 0 }
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
      const committed = new Map                ()
      const tail = new Map                                                   ()
      return (sim     )                => {
        for (const [id, n] of sim.nodes)
          for (const [origin, entries] of n.logs) {
            const k = id + '|' + origin
            let prev = tail.get(k)
            //! the cursor keys on the log ARRAY's identity, not its length: compact() replaces the
            // array (rescan from 0 — idempotent), appends mutate it in place (incremental). A length
            // check alone was blind to a same-tick append+compact that left the length unchanged
            // while entries below the cursor were new (M4-review monitor-blindness finding).
            if (!prev || prev.node !== n || prev.arr !== entries) prev = { node: n, arr: entries, len: 0 }
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
    // broke. Keyed to the STREAMS OBJECT (not the node): a restarted node restarts its watermarks from 0
    // (fresh node, fresh streams), and a CONDEMNED restore (kernel condemn(): the disk proved itself a
    // liar, the fold resets) legitimately replaces node.streams mid-life — both are new-object resets,
    // never in-place regressions.
    name: 'watermark-monotone',
    check: (() => {
      const last = new Map                                               ()
      return (sim     )                => {
        for (const [id, n] of sim.nodes)
          for (const [origin, s] of n.streams) {
            const k = id + '|' + origin
            let prev = last.get(k)
            if (!prev || prev.streams !== n.streams) prev = { streams: n.streams, applied: 0 }
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
    check: (sim     )                => {
      for (const [id, n] of sim.nodes)
        for (const [origin, s] of n.streams) {
          if (s.shippable > s.applied) return `${id} stream ${origin}: shippable ${s.shippable} > applied ${s.applied}`
          if (s.durable > s.shippable) return `${id} stream ${origin}: durable ${s.durable} > shippable ${s.shippable}`
        }
      return null
    },
  },
  {
    //! M6 scoped-lawful-holding (the exactly-R shadow oracle's per-event half): a node's HELD entries
    // are always ring-ASSIGNED at its own committed epoch — a held-but-unassigned partition means the
    // inbound gate leaked or a rescope was missed (the freeze must fire the instant duty changes).
    // Skipped wholesale on unscoped nodes (scope is null — zero cost at R=∞).
    name: 'scoped-lawful-holding',
    check: (sim     )                => {
      for (const [id, n] of sim.nodes) {
        if (!n.scope || !n.armed) continue
        const ring = n.writes.ring
        if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
        for (const [p, e] of n.scope.entries)
          if (e.state === SCOPE.held && !ring.holdsAny(n.uuid, p, n.replicas))
            return `${id} HOLDS '${p}' while epoch ${n.epoch}'s ring assigns it elsewhere — gate leak or missed rescope`
      }
      return null
    },
  },
  {
    //! M6 orphan-frozen (expected-empty): an orphan's possession floors never advance — the freeze is
    // what fixes the shed bar, and a moving orphan floor means some ingest path fed a frozen partition
    // (the gate, the splice, or the stamp site leaked). Keyed to the node OBJECT (restart = fresh scan).
    name: 'orphan-frozen',
    check: (() => {
      const frozen = new Map                                                     ()
      return (sim     )                => {
        //! snapshot invalidation (M6-review finding 32): a shed or re-acquire ends the freeze — a
        // partition that is not CURRENTLY an orphan drops its snapshot, so a later re-orphaning of
        // the same (node, partition) starts a FRESH scan instead of comparing across lawful
        // held-era floor advances (the false-violation class).
        for (const [k, snap] of frozen) {
          const bar = k.indexOf('|')
          const cur = sim.nodes.get(k.slice(0, bar))
          if (cur !== snap.node || cur.scope?.entries.get(k.slice(bar + 1))?.state !== SCOPE.orphan) frozen.delete(k)
        }
        for (const [id, n] of sim.nodes) {
          if (!n.scope) continue
          for (const [p, e] of n.scope.entries) {
            if (e.state !== SCOPE.orphan) continue
            const k = id + '|' + p
            let snap = frozen.get(k)
            if (!snap || snap.node !== n) {
              const floors = new Map                ()
              for (const [origin, d] of n.streams) { const pe = d.parts?.get(p); if (pe) floors.set(origin, pe.s) }
              snap = { node: n, floors }
              frozen.set(k, snap)
              continue
            }
            for (const [origin, d] of n.streams) {
              const s = d.parts?.get(p)?.s ?? 0
              const was = snap.floors.get(origin) ?? 0
              if (s > was) return `${id} orphan '${p}' floor ADVANCED on lane ${origin}: ${was} → ${s} — the freeze leaked`
            }
          }
        }
        return null
      }
    })(),
  },
]

//! scopedConverged — the R-SCOPED quiescence check (M6): for every partition, every node HOLDING it
// agrees cell-for-cell. Orphans are deliberately outside the comparison — a frozen copy is lawfully
// stale until shed (3b); the plain converged() stays the oracle for unscoped runs.
export const scopedConverged = (sim     )                => {
  //! group every live cell by partition, then compare across that partition's holding nodes
  const parts = new Set        ()
  for (const [, n] of sim.nodes) {
    if (!n.scope) continue
    for (const [p, e] of n.scope.entries) if (e.state === SCOPE.held) parts.add(p)
  }
  for (const p of parts) {
    let refId                = null
    let ref              = null
    for (const [id, n] of sim.nodes) {
      if (!n.scope?.held(p)) continue
      if (ref === null) { refId = id; ref = n; continue }
      //! compare the UNION of both holders' p-cells — a missing cell is a divergence, not a skip
      const keys = new Set        ()
      for (const k of ref.state.keys()) if ((JSON.parse(k)            )[0] === p) keys.add(k)
      for (const k of n.state.keys()) if ((JSON.parse(k)            )[0] === p) keys.add(k)
      for (const k of keys) {
        const inRef = ref.state.has(k), inN = n.state.has(k)
        if (inRef !== inN || stable(ref.state.get(k)) !== stable(n.state.get(k)))
          return `holders of '${p}' diverge: ${refId} vs ${id} at ${k}: ${JSON.stringify(ref.state.get(k))}${inRef ? '' : '(absent)'} vs ${JSON.stringify(n.state.get(k))}${inN ? '' : '(absent)'}`
      }
    }
  }
  return null
}

//! exactlyR — the horizon half of the M6 invariant: at quiescence, every partition present anywhere
// is HELD by exactly its ring's R-set (both directions: every assigned holder has it; nobody else
// holds it un-frozen). Orphans may still possess frozen data (3b's shed drains them) — they count as
// lawful non-holders here, the exactly-R claim is about the HELD state.
export const exactlyR = (sim     )                => {
  const nodes = [...sim.nodes.entries()].filter(([, n]) => n.scope && n.armed)
  //! honesty guards (M6-review finding 35): a scoped-configured sim with NO armed node at horizon
  // is a vacuous pass hiding a never-formed seed — report it; and the claim is per the COMMITTED
  // epoch, so armed nodes still split across epochs at horizon is non-quiescence, not a baseline.
  if (!nodes.length)
    return [...sim.nodes.values()].some((n) => n.scope) ? 'exactlyR: scoped sim reached the horizon with NO armed node — vacuous (never formed?)' : null
  const epochs = new Set(nodes.map(([, n]) => n.epoch))
  if (epochs.size > 1) return `exactlyR: armed nodes disagree on the epoch at horizon (${[...epochs].join(',')}) — not quiescent`
  const [, first] = nodes[0]
  const ring = first.writes.ring
  if (ring.epoch !== first.epoch) ring.build(first.epoch, first.membership.view.members)
  const parts = new Set        ()
  for (const [, n] of nodes) for (const [p] of n.scope .entries) parts.add(p)
  for (const p of parts) {
    const lawful = new Set(ring.holders(p, first.replicas))
    for (const [id, n] of nodes) {
      const holds = n.scope .held(p)
      if (holds && !lawful.has(n.uuid)) return `'${p}' HELD at ${id} which epoch ${first.epoch}'s ring excludes`
      if (!holds && lawful.has(n.uuid)) return `'${p}' NOT held at ${id} which epoch ${first.epoch}'s ring assigns (holders: ${[...lawful].join(',')})`
    }
  }
  return null
}

//! converged — the quiescence check: every node holds the identical state (hash first, then a real diff for the report),
// and (V4-18) the identical OBJECT with every field cell lawfully on top of its row — projected() below.
// Null = converged; otherwise a human-readable divergence description — the
// monitor's job is not just to fail but to say WHERE (plan §8 honesty rules).
export const converged = (sim     )                => {
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
  return projected(sim)
}

//! projected — the OBJECT oracle (V4-18, overlapping cells). The cell map agreeing is not enough: a
// whole-row write and a field write on one row are two cells, and what a screen shows is their fold
// by depth. Per node: (1) every indexed field cell — live, or the tombstone a field remove left — is
// stamped strictly above every ancestor's version (the kernel's across-depth rule; a violation means
// an older field survived a newer row, and the projection then depends on arrival order); (2) the
// index holds every live field cell, under every ancestor, with no empty set; (3) the object that
// REACHED THE SINK (sim/exec.ts folds, record by record — the downstream half) equals the fold of the
// kernel's cells by depth (live cells set, fenced tombstones deleted) — so a sweep, a re-apply or a
// resync that left the screen different from the kernel is caught here, not by a reader. Across
// nodes: one object everywhere.
export const projected = (sim     )                => {
  let ref                = null, refId = ''
  for (const [id, n] of sim.nodes) {
    const indexed = new Set        ()
    for (const [a, s] of n.deep) {
      if (s.size === 0) return `${id}: the deep index holds an empty set under ${a}`
      for (const c of s) {
        indexed.add(c)
        if (!c.startsWith(a.slice(0, -1) + ',')) return `${id}: deep index of ${a} holds ${c}, which is not under it`
        if (!n.versions.has(c)) return `${id}: deep index of ${a} holds ${c}, which has no version`
      }
    }
    for (const c of n.state.keys()) if (!indexed.has(c) && (JSON.parse(c)            ).length > 1) return `${id}: live field ${c} is missing from the deep index`
    const cells                       = []
    for (const c of indexed) {
      const path = JSON.parse(c)            
      const vc = n.versions.get(c) 
      for (let d = 1; d < path.length; d++) {
        const a = JSON.stringify(path.slice(0, d))
        if (!n.deep.get(a)?.has(c)) return `${id}: field ${c} is not indexed under its ancestor ${a}`
        const va = n.versions.get(a)
        if (va !== undefined && !newer(vc.epoch, vc.seq, vc.origin, va))
          return `${id}: ${n.state.has(c) ? 'field' : 'field remove'} ${c} @${vc.epoch}/${vc.seq}/${vc.origin} is ${n.state.has(c) ? 'live' : 'indexed'} under ${a} @${va.epoch}/${va.seq}/${va.origin} — an older field survived a newer row`
      }
      cells.push([c, path])
    }
    for (const c of n.state.keys()) if (!indexed.has(c)) cells.push([c, JSON.parse(c)            ])
    //! the fold by depth: rows first, then each deeper cell inside — a live cell set, a tombstone deleted
    cells.sort((x, y) => x[1].length - y[1].length || (x[0] < y[0] ? -1 : 1))
    const byDepth         = {}
    for (const [c, path] of cells) foldInto(byDepth, n.state.has(c) ? { type: REC.update, key: path, value: n.state.get(c) } : { type: REC.remove, key: path })
    const s = stable(byDepth)
    const sunk = sim.folds.get(id)
    if (sunk !== undefined) {
      const t = stable(sunk)
      if (t !== s) return `${id}: the object that reached the sink differs from the kernel's cells folded by depth (${clip(t)} vs ${clip(s)})`
    }
    if (ref === null) { ref = s; refId = id } else if (s !== ref) return `${refId} vs ${id}: the projected objects differ (${clip(ref)} vs ${clip(s)})`
  }
  return null
}

const clip = (s        ) => (s.length > 200 ? s.slice(0, 200) + '…' : s)

//! confirmedIntact — the no-confirmed-write-lost check (plan §6): every probe the ladder answered OK
// names a record whose effect must survive — at every live node it is either still IN the log, or the
// node's stream is provably PAST it (applied ≥ seq: the record was folded, and compaction may then
// lawfully drop it — its winner survives in the fold, which converged() separately verifies). Run at
// end-of-horizon like converged(); the M4e restore proof runs it after killing and rebooting the whole
// cluster from WALs. `level` scopes the claim to what the ladder actually promised: after a MAJORITY-
// simultaneous crash only `persisted` writes are guaranteed (replicated guards node loss, not cluster-
// wide power loss) — full-crash proofs pass CONFIRM.persisted; minority-crash runs keep the default.
// Null = intact; else the lost coordinates.
export const confirmedIntact = (sim     , level = 0)                => {
  for (const c of sim.confirms.values()) {
    if (c.ok !== true || c.level < level) continue
    for (const [id, n] of sim.nodes) {
      const held = n.logs.get(c.origin)?.some((e) => e.seq === c.seq)
      const folded = (n.streams.get(c.origin)?.applied ?? 0) >= c.seq
      if (!held && !folded) return `confirmed (${c.origin}, ${c.seq}) level ${c.level} is MISSING at ${id}`
    }
  }
  return null
}

//! scopedConfirmedIntact — the R-SCOPED no-confirmed-write-lost oracle (M6-review finding 29: the
// unscoped confirmedIntact's `applied ≥ seq` predicate is unsound under scoping — an armed node's
// per-origin applied lawfully runs past records of partitions it never held, so a LOST confirmed
// record reads as "folded"). The scoped claim: every OK-answered partition-scoped confirm names a
// record every CURRENT holder of its partition must contain-or-cover — lane presence, or a
// possession floor ≥ seq (sound evidence under the pp chain law), or a NEWER same-cell version
// (LWW lawfully superseded it and compaction dropped the loser). Non-holders and frozen orphans
// owe nothing — the holders are the R copies the confirm promised.
export const scopedConfirmedIntact = (sim     , level = 0)                => {
  for (const c of sim.confirms.values()) {
    if (c.ok !== true || c.level < level || c.part === undefined) continue
    for (const [id, n] of sim.nodes) {
      if (!n.scope || !n.armed) continue
      const ring = n.writes.ring
      if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
      if (!ring.holdsAny(n.uuid, c.part, n.replicas)) continue // not this node's duty
      if (!n.scope.held(c.part)) continue // mid-acquisition at horizon is exactlyR's complaint, not P2's
      const inLane = n.logs.get(c.origin)?.some((e) => e.seq === c.seq) === true
      const floor = (n.streams.get(c.origin)?.parts?.get(c.part)?.s ?? 0) >= c.seq
      //! LWW supersede (same lane only — cross-origin stamps say nothing about THIS record): a
      // version in the partition from the SAME origin at seq ≥ c.seq proves the lane folded through
      // the confirmed record here; compaction may then have dropped the loser row lawfully.
      let superseded = false
      if (!inLane && !floor) {
        for (const [cell, v] of n.versions) {
          if (v.origin !== c.origin || v.seq < c.seq) continue
          if ((JSON.parse(cell)            )[0] !== c.part) continue
          superseded = true
          break
        }
      }
      if (!inLane && !floor && !superseded)
        return `scoped confirmed (${c.origin}, ${c.seq}) part '${c.part}' level ${c.level} is MISSING at holder ${id}`
    }
  }
  return null
}

//! drained — at quiescence nothing may be parked: every paused-link queue must be empty.
export const drained = (sim     )                => {
  for (const [id, n] of sim.nodes)
    for (const l of n.links.values()) if (l.queued.length) return `${id} link ${l.id} has ${l.queued.length} undelivered frames`
  return null
}
