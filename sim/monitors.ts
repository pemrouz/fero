//! ── sim/monitors — invariants evaluated after EVERY event, not at scenario end ─
// v2 found its four write-path conflict sources one adversarial review at a
// time; a monitor evaluated per event under seed sweep finds the violating
// trajectory automatically, at the exact event that violated it. M0 ships the
// invariants the M0 kernel claims; each later milestone ADDS monitors
// (single-writer-per-(partition,epoch) at M3, watermark ordering at M4,
// exactly-R at M6) — the monitor list is the machine-checkable form of the
// plan's semantics section.

import { Node, stable, newer } from '../kernel/node.ts'
import { SCOPE } from '../kernel/scope.ts'
import { LS } from '../kernel/link.ts'
import { partitionOf, REC } from '../kernel/env.ts'
import { foldInto, type Folded } from './fold.ts'
import type { Sim } from './exec.ts'

//! ── the walk (wave 5e, 2026-10-11): what a monitor pass reads ──────────────────────────────────────
// A pass used to read every node on every event: at n=100 that is about 16 ms a pass (measured: the four log and
// stream cursors 3.3-3.9 ms each, the stamp oracle's ledger scan 3.6, queued-implies-paused 1.3), more than the
// event itself costs. A node's state changes only inside its own step(), so a monitor that judges ONE node's
// state owes a look only at the nodes a step touched. Each monitor below is in one of three classes:
//
//   LOCAL      judges one node's own state (or feeds a memory from one node's own log tail or view). Walks only
//              the due nodes: those that stepped since the last pass (sim.stepped), all of them when a pass
//              follows run() entry or an at() task (sim.allDirty: hand edits and restarts happen there), and the
//              ones the monitor itself still owes (see Due). Same nodes in the same order, so the same verdict.
//   CROSS-NODE compares nodes to each other. None runs per event: the cross-node laws (converged, exactlyR,
//              scopedConverged, floorsAgree, marksAgree, stampOracle, boundedLogs, confirmedIntact, drained) are
//              horizon checks, read at a quiet point. A per-event monitor that looks cross-node is a LOCAL walk
//              feeding a shared MEMORY (the first view seen per epoch, the first writer per partition, the
//              first commit per attempt): each node feeds the memory from its own change, which is exact
//              because a node's view and log tail change only in its own step.
//   LEDGER     reads the sim's ledger (sim/monitors.ts Ledger: every record ever appended, every release) or a
//              sim map (sim.left, sim.inflight). Runs on the events that touched it.
//
//   queued-implies-paused   LOCAL   the node's links
//   one-view-per-epoch      LOCAL   the node's view, into a first-seen-per-epoch memory
//   epoch-monotone          LOCAL   the node's epoch, against its own last
//   log-monotone            LOCAL   the node's lane tails, by cursor
//   single-writer           LOCAL   the node's lane tails, into a writer-per-(partition, epoch) memory
//   attempt-exactly-once    LOCAL   the node's lane tails, into a commit-per-attempt memory
//   watermark-monotone      LOCAL   the node's applied marks, against its own last
//   watermark-ordering      LOCAL   the node's streams
//   scoped-lawful-holding   LOCAL   the node's scope against its ring
//   orphan-frozen           LOCAL   the node's orphan floors (stale snapshots are dropped for every node first)
//   stamp-oracle  M1        LEDGER  the cells the stepped nodes changed, against the ledger's removes
//   frontier-sound M2       LOCAL   the stepped armed nodes' replaced lanes (reads the holders' floors)
//   release-safety M3       LEDGER  the cells the stepped nodes changed, against the releases
//   index-oracle  M4        LOCAL   the stepped nodes' indexes (the cost is the node's own entries)
//   floor-truth   M5        LOCAL   the stepped armed nodes' floors, against the ledger
//   census-truth  M6        LEDGER  runs only when the ledger queued a release
//   leave-drain   M9        LEDGER  runs only when sim.left holds a row, or the ledger still remembers one
//   resync-end   M10        LOCAL   the stepped spokes' resync ends
//   resync-behind M11       LOCAL   the same ends, against the feeder
//
// What "the same verdict" costs, and why it holds. A full pass returns the FIRST violation in node order, and
// repeats it on every pass while the state stays bad (a violation here is a state, and a cursor that has not
// moved past a bad entry reports it again). So a scoped pass must (1) visit due nodes in node order, (2) stop at
// the first violation as the full pass does, and (3) keep owing a look at the node it stopped on and at every due
// node it did not reach: those are the nodes the full pass would have read next time. `Due` is that debt.
// sim/monitor-walk.test.ts runs the same Sim both ways, violations planted, and compares the lists.
//! sim.full (Sim.fullWalk = true before the Sim is built) walks every node on every pass, the way every pass used to run.
class Due {
  #owed = new Set<string>()
  //! walk — read the due nodes, in node order, with `look`; return the first violation. Nodes that were due and
  // not read (after the first violation), and the node the violation names, stay owed to the next pass.
  walk(sim: Sim, look: (id: string, n: Node) => string | null): string | null {
    const all = sim.full || sim.allDirty
    let bad: string | null = null
    let next: Set<string> | null = null
    for (const [id, n] of sim.nodes) {
      if (!all && !sim.stepped.has(id) && !this.#owed.has(id)) continue
      if (bad !== null) { (next ??= new Set()).add(id); continue }
      bad = look(id, n)
      if (bad !== null) (next ??= new Set()).add(id)
    }
    this.#owed = next ?? NOBODY
    return bad
  }
}
const NOBODY: Set<string> = new Set()

//! cursorOf — the per-(node, lane) scan position the log monitors keep, found without building a key string per
// lane. The cursor keys on the node object AND the lane array's identity: compact() replaces the array (rescan
// from 0 — idempotent), appends mutate it in place (incremental), a restart replaces the node. A length check
// alone was blind to a same-tick append+compact that left the length unchanged while entries below the cursor
// were new (M4-review monitor-blindness finding).
type Cursor = { node: Node; arr: unknown; len: number }
const cursorOf = (tails: Map<string, Map<string, Cursor>>, id: string, origin: string, n: Node, entries: unknown): Cursor => {
  let per = tails.get(id)
  if (per === undefined) { per = new Map(); tails.set(id, per) }
  let prev = per.get(origin)
  if (prev === undefined || prev.node !== n || prev.arr !== entries) { prev = { node: n, arr: entries, len: 0 }; per.set(origin, prev) }
  return prev
}

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
    check: (() => {
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        for (const l of n.links.values()) {
          if (l.queued.length > 0 && !l.paused) return `${id} link ${l.id} has ${l.queued.length} queued frames while FLOWING`
          if (l.queued.length > n.tune.queued) return `${id} link ${l.id} queued ${l.queued.length} > ${n.tune.queued}`
        }
        return null
      })
    })(),
  },
  {
    //! M2's headline safety invariant: at most ONE view commits per epoch — two nodes installing
    // DIFFERENT member sets for the same epoch is split-brain, the exact bug class ballots exist to kill.
    name: 'one-view-per-epoch',
    check: (() => {
      const seen = new Map<number, string>()
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        const v = n.membership.view
        if (v.epoch === 0) return null
        const key = JSON.stringify(v.members)
        const prev = seen.get(v.epoch)
        if (prev === undefined) seen.set(v.epoch, key)
        else if (prev !== key) return `${id} installed a DIFFERENT view for epoch ${v.epoch}: ${key} vs ${prev}`
        return null
      })
    })(),
  },
  {
    //! committed epochs never go backwards — install() only accepts strictly newer views. MEMBERS only: a
    // client's epoch is its feeder's number (I-23, amended 2026-10-08), and the cluster it looks at may be
    // reborn under fresh uuids at epoch 1 after it saw epoch 2 — the row follows the feeder, by design.
    name: 'epoch-monotone',
    check: (() => {
      const last = new Map<string, number>()
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        if (n.client) return null
        const prev = last.get(id) ?? 0
        if (n.epoch < prev) return `${id} epoch went backwards: ${n.epoch} < ${prev}`
        last.set(id, n.epoch)
        return null
      })
    })(),
  },
  {
    //! per-origin LOGS are strictly seq-ascending — the structural invariant the AE suffix-slicer's
    // tail walk depends on. Checked incrementally (only appended tails), so it names the exact event
    // that poisoned a log (seed-79 regression: a self-echo append made a log non-monotone and an
    // interior record became permanently unshippable). The cursor is keyed to the NODE OBJECT (see cursorOf):
    // a sim restart (sim.add replacing a node) resets the scan, or a stale cursor would silently skip the
    // reborn node's early entries (adversarial-review monitor-blindness finding).
    name: 'log-monotone',
    check: (() => {
      const tails = new Map<string, Map<string, Cursor>>()
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        for (const [origin, entries] of n.logs) {
          const prev = cursorOf(tails, id, origin, n, entries)
          if (entries.length > prev.len) {
            for (let i = Math.max(prev.len, 1); i < entries.length; i++)
              if (entries[i].seq <= entries[i - 1].seq)
                return `${id} log[${origin}] non-ascending at ${i}: ${entries[i].seq} after ${entries[i - 1].seq}`
            prev.len = entries.length
          }
        }
        return null
      })
    })(),
  },
  {
    //! THE LANE RULE (wave 6b, 2026-10-12): a lane holds each (origin, seq) ONCE — what stage 3's compaction will assume
    // when it rewrites a lane (a seq held twice is a winner beside its own copy, and the per-partition index holds both).
    // log-monotone proves it for the tail it scans (strictly ascending ⇒ no repeat), but it scans from the length it
    // last saw, so a copy an interior insert puts BELOW that length is outside its window. This monitor keeps the entry
    // it last saw at the tail: while that entry is still at that index the lane only grew at the end and the new tail is
    // scanned; otherwise (an interior insert moved it, a replaced array) the whole lane is. The scan is STRICTLY
    // ASCENDING over every pair it reads (`<=`, the same test as log-monotone's), not "equal neighbours": a lane that is
    // strictly ascending holds each seq once, wherever a copy sits. An equal pair is named as the repeat it is; a lesser
    // one as an entry out of place — which is what a copy put anywhere but beside its original reads as ([l0, l2', l1,
    // l2]: `l1 after l2'`). The 2026-10-12 review's probe showed `===` alone misses such a copy, and no other monitor
    // reads a lane's interior. Found by the wave-6a review: the fold spliced a teacher record above the cut and the
    // live replay appended it again (lane bb at aa [3, 5, 7, 7]); fixed in kernel/scope.ts onAcqDone (the fence rises
    // to the fold's top). Counted: `counts.pairs` is the neighbouring pairs compared, `counts.lanes` the lane scans
    // (laneUniqueCounts reads them).
    ...(() => {
      const counts = { lanes: 0, pairs: 0 }
      const tails = new Map<string, Map<string, { node: Node; arr: unknown; len: number; last: unknown }>>()
      const due = new Due()
      return {
        name: 'lane-unique',
        counts,
        check: (sim: Sim): string | null => due.walk(sim, (id, n) => {
          let per = tails.get(id)
          if (per === undefined) { per = new Map(); tails.set(id, per) }
          for (const [origin, entries] of n.logs) {
            let prev = per.get(origin)
            if (prev === undefined || prev.node !== n || prev.arr !== entries) { prev = { node: n, arr: entries, len: 0, last: undefined }; per.set(origin, prev) }
            const tailStands = prev.len > 0 && prev.len <= entries.length && entries[prev.len - 1] === prev.last
            if (tailStands && entries.length === prev.len) continue
            const from = tailStands ? prev.len : 1
            counts.lanes++
            counts.pairs += Math.max(0, entries.length - from)
            for (let i = from; i < entries.length; i++) {
              if (entries[i].seq === entries[i - 1].seq)
                return `${id} lane ${origin} holds seq ${entries[i].seq} TWICE (at ${i - 1} and ${i}; epochs ${entries[i - 1].epoch} and ${entries[i].epoch}) — the lane rule`
              if (entries[i].seq < entries[i - 1].seq)
                return `${id} lane ${origin} holds seq ${entries[i].seq} OUT OF PLACE at ${i}: after ${entries[i - 1].seq} (a copy away from its original, or a misplaced insert) — the lane rule`
            }
            prev.len = entries.length
            prev.last = entries.length ? entries[entries.length - 1] : undefined
          }
          return null
        }),
      }
    })(),
  },
  {
    //! M3's headline invariant (the plan's single-writer monitor, v2 DECISIONS AA made structural):
    // for any (partition, epoch>0), at most ONE origin ever stamps a record — every AA conflict source
    // was some node stamping a partition it didn't solely own. Epoch 0 is exempt BY DESIGN (open
    // genesis is multi-writer LWW). Incremental over appended log tails, like log-monotone; fed from ALL nodes'
    // logs so a violation is caught wherever the colliding record first lands. The
    // cursor is keyed to the NODE OBJECT so a sim restart rescans from 0 (a stale cursor would blind
    // the monitor exactly around the AA #4 restart shape it exists to police).
    name: 'single-writer',
    check: (() => {
      const owner = new Map<string, string>()
      const tails = new Map<string, Map<string, Cursor>>()
      const due = new Due()
      //! provenance LANES (uuid~incarnation) normalize to the NODE: the invariant is one WRITER per
      // (partition, epoch), and a reborn life stamping the partition its uuid still owns is the same writer
      const writerOf = (origin: string) => { const i = origin.indexOf('~'); return i < 0 ? origin : origin.slice(0, i) }
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        for (const [origin, entries] of n.logs) {
          const prev = cursorOf(tails, id, origin, n, entries)
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
        }
        return null
      })
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
      const tails = new Map<string, Map<string, Cursor>>()
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        for (const [origin, entries] of n.logs) {
          const prev = cursorOf(tails, id, origin, n, entries)
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
        }
        return null
      })
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
      const last = new Map<string, Map<string, { streams: unknown; applied: number }>>()
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        let per = last.get(id)
        if (per === undefined) { per = new Map(); last.set(id, per) }
        for (const [origin, s] of n.streams) {
          let prev = per.get(origin)
          if (!prev || prev.streams !== n.streams) prev = { streams: n.streams, applied: 0 }
          if (s.applied < prev.applied) return `${id} stream ${origin} watermark went backwards: ${s.applied} < ${prev.applied}`
          prev.applied = s.applied
          per.set(origin, prev)
        }
        return null
      })
    })(),
  },
  {
    //! the watermark LADDER (M4a, plan §5 verbatim): applied ≥ shippable ≥ durable, per stream, at every
    // instant. This ordering is what makes v2's recvReplProbe false positive unwritable — evidence for a
    // stronger guarantee can never run ahead of the weaker one it implies. Durable stays 0 until M4b's
    // storage lands; the monitor is armed FIRST so nothing can ever violate the contract unobserved.
    name: 'watermark-ordering',
    check: (() => {
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        for (const [origin, s] of n.streams) {
          if (s.shippable > s.applied) return `${id} stream ${origin}: shippable ${s.shippable} > applied ${s.applied}`
          if (s.durable > s.shippable) return `${id} stream ${origin}: durable ${s.durable} > shippable ${s.shippable}`
        }
        return null
      })
    })(),
  },
  {
    //! M6 scoped-lawful-holding (the exactly-R shadow oracle's per-event half): a node's HELD entries
    // are always ring-ASSIGNED at its own committed epoch — a held-but-unassigned partition means the
    // inbound gate leaked or a rescope was missed (the freeze must fire the instant duty changes).
    // Skipped wholesale on unscoped nodes (scope is null — zero cost at R=∞).
    name: 'scoped-lawful-holding',
    check: (() => {
      const due = new Due()
      return (sim: Sim): string | null => due.walk(sim, (id, n) => {
        if (!n.scope || !n.armed) return null
        const ring = n.writes.ring
        if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
        for (const [p, e] of n.scope.entries)
          if (e.state === SCOPE.held && !ring.holdsAny(n.uuid, p, n.replicas))
            return `${id} HOLDS '${p}' while epoch ${n.epoch}'s ring assigns it elsewhere — gate leak or missed rescope`
        return null
      })
    })(),
  },
  {
    //! M6 orphan-frozen (expected-empty): an orphan's possession floors never advance — the freeze is
    // what fixes the shed bar, and a moving orphan floor means some ingest path fed a frozen partition
    // (the gate, the splice, or the stamp site leaked). Keyed to the node OBJECT (restart = fresh scan).
    name: 'orphan-frozen',
    check: (() => {
      const frozen = new Map<string, { node: Node; floors: Map<string, number> }>()
      const due = new Due()
      return (sim: Sim): string | null => {
        //! snapshot invalidation (M6-review finding 32): a shed or re-acquire ends the freeze — a
        // partition that is not CURRENTLY an orphan drops its snapshot, so a later re-orphaning of
        // the same (node, partition) starts a FRESH scan instead of comparing across lawful
        // held-era floor advances (the false-violation class). Read for EVERY node, due or not: it walks the
        // snapshots (the orphans), not the nodes, and a scoped pass that deferred a node's drop could meet its
        // re-orphaning with the old floors.
        for (const [k, snap] of frozen) {
          const bar = k.indexOf('|')
          const cur = sim.nodes.get(k.slice(0, bar))
          if (cur !== snap.node || cur.scope?.entries.get(k.slice(bar + 1))?.state !== SCOPE.orphan) frozen.delete(k)
        }
        return due.walk(sim, (id, n) => {
          if (!n.scope) return null
          for (const [p, e] of n.scope.entries) {
            if (e.state !== SCOPE.orphan) continue
            const k = id + '|' + p
            let snap = frozen.get(k)
            if (!snap || snap.node !== n) {
              const floors = new Map<string, number>()
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
          return null
        })
      }
    })(),
  },
]

//! laneUniqueCounts — the lane rule's non-vacuity counts off the Sim's own monitor set (null when perEvent() is not
// installed): `lanes` scans made, `pairs` neighbouring (seq, seq) pairs compared.
export const laneUniqueCounts = (sim: Sim): { lanes: number; pairs: number } | null => {
  const m = sim.monitors.find((x) => x.name === 'lane-unique') as { counts?: { lanes: number; pairs: number } } | undefined
  return m?.counts ?? null
}

//! scopedConverged — the R-SCOPED quiescence check (M6): for every partition, every node HOLDING it
// agrees cell-for-cell. Orphans are deliberately outside the comparison — a frozen copy is lawfully
// stale until shed (3b); the plain converged() stays the oracle for unscoped runs.
export const scopedConverged = (sim: Sim): string | null => {
  //! group every live cell by partition, then compare across that partition's holding nodes
  const parts = new Set<string>()
  for (const [, n] of sim.nodes) {
    if (!n.scope) continue
    for (const [p, e] of n.scope.entries) if (e.state === SCOPE.held) parts.add(p)
  }
  for (const p of parts) {
    let refId: string | null = null
    let ref: Node | null = null
    for (const [id, n] of sim.nodes) {
      if (!n.scope?.held(p)) continue
      if (ref === null) { refId = id; ref = n; continue }
      //! compare the UNION of both holders' p-cells — a missing cell is a divergence, not a skip
      const keys = new Set<string>()
      for (const k of ref.state.keys()) if ((JSON.parse(k) as string[])[0] === p) keys.add(k)
      for (const k of n.state.keys()) if ((JSON.parse(k) as string[])[0] === p) keys.add(k)
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
export const exactlyR = (sim: Sim): string | null => {
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
  const parts = new Set<string>()
  for (const [, n] of nodes) for (const [p] of n.scope!.entries) parts.add(p)
  for (const p of parts) {
    const lawful = new Set(ring.holders(p, first.replicas))
    for (const [id, n] of nodes) {
      const holds = n.scope!.held(p)
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
export const projected = (sim: Sim): string | null => {
  let ref: string | null = null, refId = ''
  for (const [id, n] of sim.nodes) {
    const r = projectedOf(sim, id, n)
    if (typeof r === 'string') return r
    if (ref === null) { ref = r.s; refId = id } else if (r.s !== ref) return `${refId} vs ${id}: the projected objects differ (${clip(ref)} vs ${clip(r.s)})`
  }
  return null
}

//! projectedOf — one node's half of projected(): steps (1)-(3) for `n`, and its fold by depth as a stable string
// for the cross-node compare. A string is a violation.
const projectedOf = (sim: Sim, id: string, n: Node): string | { s: string } => {
  const indexed = new Set<string>()
  for (const [a, s] of n.deep) {
    if (s.size === 0) return `${id}: the deep index holds an empty set under ${a}`
    for (const c of s) {
      indexed.add(c)
      if (!c.startsWith(a.slice(0, -1) + ',')) return `${id}: deep index of ${a} holds ${c}, which is not under it`
      if (!n.versions.has(c)) return `${id}: deep index of ${a} holds ${c}, which has no version`
    }
  }
  for (const c of n.state.keys()) if (!indexed.has(c) && (JSON.parse(c) as string[]).length > 1) return `${id}: live field ${c} is missing from the deep index`
  const cells: [string, string[]][] = []
  for (const c of indexed) {
    const path = JSON.parse(c) as string[]
    const vc = n.versions.get(c)!
    for (let d = 1; d < path.length; d++) {
      const a = JSON.stringify(path.slice(0, d))
      if (!n.deep.get(a)?.has(c)) return `${id}: field ${c} is not indexed under its ancestor ${a}`
      const va = n.versions.get(a)
      if (va !== undefined && !newer(vc.epoch, vc.seq, vc.origin, va))
        return `${id}: ${n.state.has(c) ? 'field' : 'field remove'} ${c} @${vc.epoch}/${vc.seq}/${vc.origin} is ${n.state.has(c) ? 'live' : 'indexed'} under ${a} @${va.epoch}/${va.seq}/${va.origin} — an older field survived a newer row`
    }
    cells.push([c, path])
  }
  for (const c of n.state.keys()) if (!indexed.has(c)) cells.push([c, JSON.parse(c) as string[]])
  //! the fold by depth: rows first, then each deeper cell inside — a live cell set, a tombstone deleted
  cells.sort((x, y) => x[1].length - y[1].length || (x[0] < y[0] ? -1 : 1))
  const byDepth: Folded = {}
  for (const [c, path] of cells) foldInto(byDepth, n.state.has(c) ? { type: REC.update, key: path, value: n.state.get(c) } : { type: REC.remove, key: path })
  const s = stable(byDepth)
  const sunk = sim.folds.get(id)
  if (sunk !== undefined) {
    const t = stable(sunk)
    if (t !== s) return `${id}: the object that reached the sink differs from the kernel's cells folded by depth (${clip(t)} vs ${clip(s)})`
  }
  return { s }
}

//! screenMatches — the screen check for ONE node (2026-10-10, the review of the stale-reply fix): the object that
// reached its sink equals its kernel's cells folded by depth. projected() runs this for every node and then
// compares the nodes to each other; a SPOKE of a scoped cluster is not compared to anyone (it mirrors its feeder's
// held subset), so the scoped sweep runs this for each spoke alone at the horizon. It is what catches a cell the
// kernel dropped without telling the screen — a wipe whose cells the resync's ghost sweep did not know, for one.
export const screenMatches = (sim: Sim, id: string): string | null => {
  const n = sim.nodes.get(id)
  if (!n) return null
  const r = projectedOf(sim, id, n)
  return typeof r === 'string' ? r : null
}

const clip = (s: string) => (s.length > 200 ? s.slice(0, 200) + '…' : s)

//! confirmedIntact — the no-confirmed-write-lost check (plan §6): every probe the ladder answered OK
// names a record whose effect must survive — at every live node it is either still IN the log, or the
// node's stream is provably PAST it (applied ≥ seq: the record was folded, and compaction may then
// lawfully drop it — its winner survives in the fold, which converged() separately verifies). Run at
// end-of-horizon like converged(); the M4e restore proof runs it after killing and rebooting the whole
// cluster from WALs. `level` scopes the claim to what the ladder actually promised: after a MAJORITY-
// simultaneous crash only `persisted` writes are guaranteed (replicated guards node loss, not cluster-
// wide power loss) — full-crash proofs pass CONFIRM.persisted; minority-crash runs keep the default.
// Null = intact; else the lost coordinates.
export const confirmedIntact = (sim: Sim, level = 0): string | null => {
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
export const scopedConfirmedIntact = (sim: Sim, level = 0): string | null => {
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
          if ((JSON.parse(cell) as string[])[0] !== c.part) continue
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
export const drained = (sim: Sim): string | null => {
  for (const [id, n] of sim.nodes)
    for (const l of n.links.values()) if (l.queued.length) return `${id} link ${l.id} has ${l.queued.length} undelivered frames`
  return null
}

//! ── DESIGN-SCALE stage 0: the scale harness monitors M1-M10 (2026-10-09) ───────────────────────
// The record's §6 names nine invariants and the monitor that checks each. Stage 0 builds the monitors
// on TODAY's kernel so every later rule (anti-entropy, compaction, GC, the drain) must turn one of them
// red when it is switched off before it lands — the I-20 lesson (docs/DESIGN-LEAVE.md §9). Everything
// below is sim-only and reads the kernel; nothing here moves a trajectory.
//
// The LEDGER is the oracle the tree lacked (§6, M1): every record ever appended to any node's log, keyed
// (origin, seq), gathered by the same node-and-array-keyed cursors the log monitors above use, plus every
// tombstone RELEASE a node performed (a version that vanished while the cell stayed absent and the
// partition stayed on the node — tombstone GC today, the stage-4 release step tomorrow, or an injected
// drop in a mutation run). The per-event monitors walk only the nodes that stepped (sim.stepped) and
// diff each node's versions by stamp-object identity, so a quiet event costs one Map lookup per cell of
// one node. A life between restart() and its `start` is skipped (sim.restoring) and read whole at start.
//
//   M1 stamp-oracle    (per event, every node)  a cell shown with stamp s while a remove of it, or of an
//                      ancestor, stamped r > s is BELOW this node's coverage of r's lane (an armed node's
//                      possession floor for (lane, partition); an unscoped node's or a client's applied
//                      watermark; nothing for a spoke in resync — see `covers`). Fires at the exact event
//                      a resurrection lands. Red today on the two unscoped probes (sim/scale-probes.test.ts).
//   M2 frontier-sound  (per event, armed)       an entry compaction dropped at an armed node was not its
//                      cell's winner and sits at or below every CURRENT holder's REAL floor for its
//                      (lane, partition) — the sim reads the holders' floors, not their marks. Today an
//                      armed node never compacts (kernel/log.ts:160), so the counter stays 0 and the
//                      planted test calls compact() by hand; stage 3 makes it live.
//   M3 release-safety  (per event, every node)  after any node released tombstone t for cell k, no node
//                      shows k or a cell under k with a stamp below t. Red today on both probes.
//   M4 index-oracle    (stage 1)                inert until node.byPart exists; see the stub.
//   M5 floor-truth     (per event, armed)       when a possession floor (lane, p) advances from a to b,
//                      every ledger record of (lane, p) in (a, b] is in this node's log, or a version it
//                      holds (the cell's, or an ancestor's) dominates it, or it was released. A restored
//                      life checks its whole seed at start — the DESIGN-SCALE §2 seed probe (A4). A life
//                      restored from a disk that LIED (sim.g5) is the G5 residual and is skipped.
//   M6 census-truth    (at each release)        ground truth only the sim can see: at the moment node N
//                      releases t for k in p, no node anywhere (member or not), no frame on the wire
//                      (sim.inflight) and no row on a DOWN node's stored WAL holds a record of k, or of
//                      a cell under k, stamped below t that N neither contains nor covers. Red today on
//                      the zombie probe AT THE RELEASE, before the heal shows it. M3 and M6 both find the
//                      releases through Ledger.classify, so each stands alone when the other is off.
//   M7 floors-agree    (horizon, armed)         at a quiet point every partition's holders report equal
//                      floors on every lane (I6's horizon form; the cadence bound is the sweep's tail).
//      marks-agree     (horizon, armed)         M7's KNOWLEDGE form (stage 2's review): every holder's marks
//                      of each co-holder equal that co-holder's floors — h HEARD x. The floor form cannot see
//                      the owner's announcement or the sweep in the sim (every loss the sim can make is healed
//                      by a round of its own); this form can, and the stage-2 mutations are pinned on it.
//   M8 bounded-logs    (horizon, armed)         every lane holds at most winners + compactAt entries and
//                      every tombstone is fenced or pinned by a named uuid. RED TODAY by design (logs are
//                      unbounded under scoping; no gcWaitingOn surface exists): the sweep pins the count.
//   M9 leave-drain     (per event, armed)       a leaver that reports left(true) holds nothing some other
//                      live node does not contain-or-cover. Was red at R=1 until the drain landed; GREEN
//                      since DESIGN-SCALE stage 1 (b), 2026-10-10 (a clean leaver hands its rows over first).
//   M10 resync-end     (per event, spokes)      a spoke's resync (node.ts #resyncBegin) ends only on the r=0
//                      that answers an r=1 the spoke sent on that link AFTER the resync began — the
//                      reply that follows the re-download on the FIFO link. Ending on an older reply runs
//                      the ghost sweep before the re-download, and the re-download then lands record run by
//                      record run: the spoke shows older values of live rows, and rows whose removes are on
//                      the way. Not one of the record's nine; added when the sweep found it (A11).
//                      Fixed 2026-10-10: a client's r=1 carries `q`, the reply echoes it, the end is a
//                      reply whose q is at or above the resync's own (kernel/node.ts `resync`).
//   M12 spoke-mirror   (horizon, spokes)         a spoke of a scoped cluster shows its feeder's HELD subset, cell for
//                      cell by value (`spokeMirror`, wave 6a 2026-10-12). The one oracle that compares a spoke to its
//                      feeder: a row the feeder folded through the latch and never tapped was missing at every spoke
//                      and nothing fired. `spokeStale` counts the other direction (rows of partitions that moved OFF
//                      the feeder, which the spoke keeps) without judging it.
//   M11 resync-behind  (at each resync end, spokes) the FOLD form of M10, read from the kernel at the
//                      end (n.state, n.versions, the log), not from the screen: when a spoke's resync
//                      ends, every row it held at the reset that its feeder still holds (in the feeder's
//                      log, for a partition the feeder holds, at or below the ending reply's tail for its
//                      lane — the reply's `d` map is the feeder's tails when it built the reply) is
//                      contained-or-covered at the spoke: in its log, or a version at the cell or an
//                      ancestor at or above the feeder's. A record above that tail was applied after the
//                      reply and is on the wire behind it: excused. A stale end fails this at once: the
//                      ghost sweep removed rows the feeder holds, and the rows the re-download then
//                      re-applies land at older stamps first. It sees nothing between the reset and the
//                      end, and nothing the screen shows that the kernel does not: that is the horizon's
//                      screen check (`screenMatches`, run per spoke by the scoped sweep).
//
// Non-vacuity: ledgerOf(sim).counts says how many cells, drops, releases, floor advances, releases
// examined by M6, leaves and resync ends (and the rows M11 checked at them) each family saw — a sweep
// whose counters read 0 proved nothing.

import { Framer, Frame, VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { compact as _compact } from '../kernel/log.ts'
import type { Rec } from '../kernel/env.ts'
import type { LogEntry } from '../kernel/node.ts'
void _compact // the planted M2 test calls kernel/log.ts compact() by hand; named here so the dependency reads in one place

type Stamp = { epoch: number; seq: number; origin: string }
interface LEntry extends Stamp { rec: Rec; cell: string; path: string[]; p: string }
const stampOf = (s: Stamp) => `${s.epoch}/${s.seq}/${s.origin}`
const pathOf = (rec: Rec): string[] => rec.key.length ? rec.key : [rec.at ?? '']
const ancestorKeys = (path: string[]): string[] => { const out: string[] = []; for (let d = 1; d < path.length; d++) out.push(JSON.stringify(path.slice(0, d))); return out }
//! inLane — does this node's log for `origin` hold seq? Lanes are seq-ascending: binary search.
const inLane = (n: Node, origin: string, seq: number): boolean => {
  const lane = n.logs.get(origin)
  if (!lane) return false
  let lo = 0, hi = lane.length - 1
  while (lo <= hi) { const mid = (lo + hi) >>> 1; const s = lane[mid].seq; if (s === seq) return true; if (s < seq) lo = mid + 1; else hi = mid - 1 }
  return false
}
//! covers — how far this node's coverage of (lane, partition) reaches: an armed node's possession floor
// (the SOLE scoped possession claim, kernel/streams.ts), an unscoped node's or a client's applied watermark
// (the dedup fence: everything at or below it was folded, skipped or fenced here).
//! A spoke IN RESYNC covers nothing (2026-10-10): it wiped its fold and asked its feeder for everything, so a
// lane's applied watermark there is the top of whatever has landed so far, not a claim on what is below it —
// a reply to an older digest (the one the feeder's own digest crossed at the failover) ships the lane's newest
// entries first, and the re-download then fills the lane from its start as splices under that fence (write.ts
// #splice, the client leg). The screen lawfully shows a row at an older stamp until its newer record lands —
// the re-download flicker, a design property noted in STATUS — and M1 would read that as a resurrection.
// Coverage returns with the end (#resyncEnd), where M10 and M11 judge the result.
//! A spoke of a SCOPED feeder covers nothing per event either (wave 6a, 2026-10-12): its copy of each lane is the
// feeder's held subset, sparse by design, and an interior record lawfully lands at any time — the feeder forwards
// what it folds through the latch (kernel/scope.ts onAcqDone), a partition's history in lane order, one frame per
// contiguous run, so an older value of a row and its later remove on one lane arrive in separate events while the
// spoke's fence already sits above both (other partitions' records raised it): the row shows for as many events as
// there are frames between them (A12 seeds 2, 4 and 5 under the old reading; seed 4 showed p27 at two older stamps in
// two events before its remove). The kernel's own client leg says the same (write.ts #splice: a scoped feeder
// re-forwards out of seq order), so the applied watermark there is a dedup fence, not a claim on what is below it. The
// spoke's oracle is M12 (spokeMirror) at the quiet point, cell for cell against its feeder — which M1's horizon form,
// M3 and M6 judge. An UNSCOPED spoke's applied is still coverage: its feeder shows it whole lanes.
const covers = (n: Node, origin: string, p: string): number =>
  n.armed ? (n.streams.get(origin)?.parts?.get(p)?.s ?? 0) : n.client && (n.resync !== null || n.feederScoped) ? 0 : (n.streams.get(origin)?.applied ?? 0)
const isRemove = (rec: Rec) => rec.type === REC.remove

export class Ledger {
  recs = new Map<string, LEntry>()
  removes = new Map<string, LEntry[]>()
  lanes = new Map<string, Map<string, LEntry[]>>()
  //! released — cell → the newest tombstone stamp any node ever released for it (M3's memory, M6's trigger)
  released = new Map<string, Stamp>()
  pending: { node: Node; id: string; cell: string; p: string; t: Stamp }[] = []
  counts = { cells: 0, drops: 0, releases: 0, advances: 0, census: 0, leaves: 0, resyncs: 0, resyncRows: 0 }
  #cursors = new Map<string, { node: Node; arr: unknown; len: number }>()
  #snap = new Map<Node, Map<string, Stamp>>()
  #floors = new Map<Node, Map<string, number>>()
  #left = new Map<string, boolean>()
  #scanned = -1
  #scanPass = -2
  #walked = -1
  #classified = -1
  changed: { id: string; node: Node; cell: string; v: Stamp }[] = []
  vanished: { id: string; node: Node; cell: string; t: Stamp }[] = []

  add(origin: string, seq: number, epoch: number, rec: Rec) {
    const key = origin + '|' + seq
    if (this.recs.has(key)) return
    const path = pathOf(rec)
    const e: LEntry = { origin, seq, epoch, rec, cell: JSON.stringify(path), path, p: path[0] }
    this.recs.set(key, e)
    if (isRemove(rec)) { let rs = this.removes.get(e.cell); if (!rs) { rs = []; this.removes.set(e.cell, rs) } rs.push(e) }
    let per = this.lanes.get(origin); if (!per) { per = new Map(); this.lanes.set(origin, per) }
    let lane = per.get(e.p); if (!lane) { lane = []; per.set(e.p, lane) }
    //! sorted by seq (entries arrive from many nodes in any order; a splice may land below a seen tail)
    let i = lane.length
    while (i > 0 && lane[i - 1].seq > seq) i--
    lane.splice(i, 0, e)
  }

  //! scan — gather every entry appended to any log since the last scan (once per event count). The cursor keys
  // on the node object and the lane array like log-monotone's: a compaction replaces the array (rescan,
  // idempotent — add() dedups), a restart replaces the node. An entry a latch SPLICES into a lane's interior
  // was in its teacher's log and was gathered there.
  //! Wave 5e: when this scan runs INSIDE a monitor pass and the scan before it ran in the pass just before, only the
  // nodes that stepped since (sim.stepped, in node order) can hold an entry it has not gathered, so only those are
  // read; otherwise (a scan between passes, such as stampOracle's horizon read, where the last pass has already
  // cleared sim.stepped; the first scan; a pass after run() entry or an at() task; a gap in the passes; sim.full)
  // every node is. The same entries are added in the same order either way.
  scan(sim: Sim) {
    if (this.#scanned === sim.events) return
    this.#scanned = sim.events
    const some = sim.checking && !sim.full && !sim.allDirty && this.#scanPass === sim.passes - 1
    this.#scanPass = sim.passes
    for (const [id, n] of sim.nodes) {
      if (some && !sim.stepped.has(id)) continue
      for (const [origin, entries] of n.logs) {
        const k = id + '|' + origin
        let prev = this.#cursors.get(k)
        if (!prev || prev.node !== n || prev.arr !== entries) prev = { node: n, arr: entries, len: 0 }
        if (entries.length > prev.len) {
          for (let i = prev.len; i < entries.length; i++) { const e = entries[i]; this.add(origin, e.seq, e.epoch, e.rec) }
          prev.len = entries.length
        }
        this.#cursors.set(k, prev)
      }
    }
  }

  //! walk — once per pass: diff every stepped node's versions against its snapshot. `changed` = cells whose
  // stamp object changed and that are PRESENT (M1 and M3 read them); `vanished` = tombstones whose version is
  // gone with the cell still absent (classify() sorts them: shed, wipe, or a release).
  walk(sim: Sim) {
    if (this.#walked === sim.events) return
    this.#walked = sim.events
    this.changed.length = 0
    this.vanished.length = 0
    for (const id of sim.stepped) {
      const n = sim.nodes.get(id)
      if (!n || sim.restoring.has(id)) continue
      let snap = this.#snap.get(n)
      if (!snap) { snap = new Map(); this.#snap.set(n, snap) }
      for (const [k, v] of n.versions) {
        if (snap.get(k) === v) continue
        snap.set(k, v)
        if (n.state.has(k)) this.changed.push({ id, node: n, cell: k, v })
      }
      if (snap.size !== n.versions.size)
        for (const [k, t] of snap) if (!n.versions.has(k)) { snap.delete(k); if (!n.state.has(k)) this.vanished.push({ id, node: n, cell: k, t }) }
    }
  }

  //! classify — once per pass, after scan and walk: sort every vanished tombstone into a shed (the scope entry left
  // with it), a wiped fold (condemn, a spoke's resync), or a RELEASE (tombstone GC, the stage-4 release step, or an
  // injected drop). A release raises `released` (M3 reads it) and queues on `pending` (M6 reads it). Both
  // monitors call this, so switching either one off leaves the other whole.
  classify(sim: Sim) {
    if (this.#classified === sim.events) return
    this.#classified = sim.events
    this.scan(sim); this.walk(sim)
    for (const { id, node: n, cell, t } of this.vanished) {
      if (n.tainted || n.client) continue
      const p = (JSON.parse(cell) as string[])[0] ?? ''
      if (n.scope && !n.scope.entries.has(p)) continue
      if (n.logs.size === 0 && n.state.size === 0) continue
      const was = this.released.get(cell)
      if (was === undefined || newer(t.epoch, t.seq, t.origin, was)) this.released.set(cell, t)
      this.counts.releases++
      this.pending.push({ node: n, id, cell, p, t })
    }
  }

  floorsOf(n: Node): Map<string, number> { let m = this.#floors.get(n); if (!m) { m = new Map(); this.#floors.set(n, m) } return m }
  leftBefore(uuid: string): boolean | undefined { return this.#left.get(uuid) }
  remembersLeft(): boolean { return this.#left.size !== 0 }
  sawLeft(uuid: string, clean: boolean) { this.#left.set(uuid, clean) }
  forgetLeft(uuid: string) { this.#left.delete(uuid) }
}

const ledgers = new WeakMap<Sim, Ledger>()
//! ledgerOf — the one Ledger per Sim (the monitors fill it; the horizon oracles and the tests read it).
export const ledgerOf = (sim: Sim): Ledger => { let l = ledgers.get(sim); if (!l) { l = new Ledger(); ledgers.set(sim, l) } return l }

//! containsOrCovers — I3's right-hand side for one ledger record at one node: in my log, or a version I hold
// (the cell's or an ancestor's) at or above its stamp, or released under a tombstone at or above it.
const containsOrCovers = (L: Ledger, n: Node, e: LEntry): boolean => {
  if (inLane(n, e.origin, e.seq)) return true
  const v = n.versions.get(e.cell)
  if (v !== undefined && !newer(e.epoch, e.seq, e.origin, v)) return true
  for (const a of ancestorKeys(e.path)) { const va = n.versions.get(a); if (va !== undefined && !newer(e.epoch, e.seq, e.origin, va)) return true }
  const t = L.released.get(e.cell)
  if (t !== undefined && !newer(e.epoch, e.seq, e.origin, t)) return true
  for (const a of ancestorKeys(e.path)) { const ta = L.released.get(a); if (ta !== undefined && !newer(e.epoch, e.seq, e.origin, ta)) return true }
  return false
}

//! holdersNow — the live armed nodes the ring assigns p to at `n`'s epoch (M2's frontier reads their REAL floors).
const holdersNow = (sim: Sim, n: Node, p: string): [string, Node][] => {
  const ring = n.writes.ring
  if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
  const out: [string, Node][] = []
  for (const u of ring.holders(p, n.replicas)) { const h = sim.nodes.get(u); if (h && h.armed) out.push([u, h]) }
  return out
}

//! framesIn — every frame in one wire chunk or WAL row (a send carries one frame; a row is one frame).
const framesIn = (bytes: Uint8Array) => { try { return new Framer().push(bytes) } catch { return [] } }

export const scaleMonitors = () => [
  {
    name: 'stamp-oracle',
    check: (sim: Sim): string | null => {
      const L = ledgerOf(sim)
      L.scan(sim); L.walk(sim)
      for (const { id, node: n, cell, v } of L.changed) {
        L.counts.cells++
        const path = JSON.parse(cell) as string[]
        for (let d = path.length; d >= 1; d--) {
          const c = d === path.length ? cell : JSON.stringify(path.slice(0, d))
          const rs = L.removes.get(c)
          if (!rs) continue
          for (const r of rs)
            if (newer(r.epoch, r.seq, r.origin, v) && covers(n, r.origin, r.p) >= r.seq)
              return `${id} shows ${cell} @${stampOf(v)} while the ${c === cell ? 'remove' : 'ancestor remove ' + c} @${stampOf(r)} is at or below its ${n.armed ? 'floor' : 'applied'} for lane ${r.origin} — resurrected`
        }
      }
      return null
    },
  },
  {
    name: 'frontier-sound',
    check: (() => {
      const seen = new Map<string, { node: Node; arr: { rec: Rec; seq: number; epoch: number }[] }>()
      return (sim: Sim): string | null => {
        const L = ledgerOf(sim)
        for (const id of sim.stepped) {
          const n = sim.nodes.get(id)
          if (!n || !n.armed || !n.scope) continue
          for (const [o, entries] of n.logs) {
            const k = id + '|' + o
            const prev = seen.get(k)
            seen.set(k, { node: n, arr: entries })
            if (!prev || prev.node !== n || prev.arr === entries || n.tainted) continue
            //! the lane array was REPLACED in this life: compaction (kernel/log.ts compact) or a shed. Every old entry
            // missing from the new array was dropped; a shed's drops left with their scope entry and are lawful.
            for (const e of prev.arr) {
              if (inLane(n, o, e.seq)) continue
              const p = pathOf(e.rec)[0]
              if (!n.scope.entries.has(p)) continue
              L.counts.drops++
              const cell = JSON.stringify(pathOf(e.rec))
              const v = n.versions.get(cell)
              if (v !== undefined && v.origin === o && v.seq === e.seq && v.epoch === e.epoch)
                return `${id} compacted lane ${o} and dropped seq ${e.seq}, which is still the WINNER of ${cell}`
              for (const [hu, h] of holdersNow(sim, n, p)) {
                const f = h.streams.get(o)?.parts?.get(p)?.s ?? 0
                if (f < e.seq) return `${id} compacted (${o}, ${e.seq}) of '${p}' while holder ${hu}'s real floor for that lane is ${f} — below the frontier`
              }
            }
          }
        }
        return null
      }
    })(),
  },
  {
    name: 'release-safety',
    check: (sim: Sim): string | null => {
      const L = ledgerOf(sim)
      L.classify(sim)
      for (const { id, cell, v } of L.changed) {
        const path = JSON.parse(cell) as string[]
        for (let d = path.length; d >= 1; d--) {
          const c = d === path.length ? cell : JSON.stringify(path.slice(0, d))
          const t = L.released.get(c)
          if (t !== undefined && newer(t.epoch, t.seq, t.origin, v))
            return `${id} shows ${cell} @${stampOf(v)} below the RELEASED tombstone of ${c} @${stampOf(t)} — a record older than a released remove was applied`
        }
      }
      return null
    },
  },
  {
    //! M4 index-oracle (stage 1, built 2026-10-09): for every scoped node that stepped, the per-partition entry
    // index (node.byPart) equals the filter of every lane by partition — the same objects, in lane order — and
    // the tombstone index (node.tombs) equals the set of versions with no live value, per partition. Walks only
    // the stepped nodes' lanes and versions. A site that forgets the index makes a teach ship an incomplete base
    // or a shed destroy data on attested-but-wrong tails; this is what catches it (scale-probes.test.ts plants
    // one missed site each way).
    name: 'index-oracle',
    check: (sim: Sim): string | null => {
      for (const id of sim.stepped) {
        const n = sim.nodes.get(id)
        if (!n || n.byPart === null || n.tombs === null || sim.restoring.has(id)) continue
        const want = new Map<string, Map<string, LogEntry[]>>()
        for (const [origin, lane] of n.logs)
          for (const e of lane) {
            const p = partitionOf(e.rec)
            let per = want.get(p); if (!per) { per = new Map(); want.set(p, per) }
            let arr = per.get(origin); if (!arr) { arr = []; per.set(origin, arr) }
            arr.push(e)
          }
        for (const [p, per] of want) {
          const got = n.byPart.get(p)
          if (!got) return `${id} byPart lacks '${p}', which ${per.size} lane(s) hold entries of — an index site was missed`
          for (const [o, arr] of per) {
            const g = got.get(o)
            if (!g) return `${id} byPart['${p}'] lacks lane ${o}, which holds ${arr.length} entries of it`
            if (g.length !== arr.length) return `${id} byPart['${p}'][${o}] holds ${g.length} entries, the lane holds ${arr.length} of '${p}'`
            for (let i = 0; i < arr.length; i++) if (g[i] !== arr[i]) return `${id} byPart['${p}'][${o}] entry ${i} is seq ${g[i].seq}, the lane's is seq ${arr[i].seq}`
          }
        }
        for (const [p, got] of n.byPart) {
          const per = want.get(p)
          if (!per) return `${id} byPart names '${p}', of which no lane holds an entry`
          for (const o of got.keys()) if (!per.has(o)) return `${id} byPart['${p}'] names lane ${o}, which holds no entry of it`
        }
        for (const [k, v] of n.versions) {
          if (n.state.has(k)) continue
          const path = JSON.parse(k) as string[]
          if (!n.tombs.get(path.length ? path[0] : '')?.has(k)) return `${id} tombs lacks ${k} @${stampOf(v)}, a version with no live value`
        }
        for (const [p, s] of n.tombs)
          for (const k of s) {
            if (!n.versions.has(k)) return `${id} tombs['${p}'] names ${k}, which has no version`
            if (n.state.has(k)) return `${id} tombs['${p}'] names ${k}, which is live`
          }
      }
      return null
    },
  },
  {
    name: 'floor-truth',
    check: (sim: Sim): string | null => {
      const L = ledgerOf(sim)
      L.scan(sim)
      for (const id of sim.stepped) {
        const n = sim.nodes.get(id)
        if (!n || !n.armed || sim.restoring.has(id) || sim.g5.has(id)) continue
        const fl = L.floorsOf(n)
        for (const [o, d] of n.streams) {
          if (!d.parts) continue
          for (const [p, pe] of d.parts) {
            const key = o + '|' + p
            let prev = fl.get(key) ?? 0
            if (pe.s < prev) prev = 0 // a shed-then-reacquired floor restarts from zero: re-check its whole claim
            if (pe.s <= prev) { if (pe.s !== prev) fl.set(key, pe.s); continue }
            const lane = L.lanes.get(o)?.get(p)
            if (lane)
              for (const e of lane) {
                if (e.seq <= prev) continue
                if (e.seq > pe.s) break
                L.counts.advances++
                //! reported once per claim: the floor is recorded before the return, so the next event does not re-report it
                if (!containsOrCovers(L, n, e)) {
                  fl.set(key, pe.s)
                  return `${id} floor for (${o}, '${p}') is ${pe.s} but it neither holds nor covers (${o}, ${e.seq}) ${e.cell} @${stampOf(e)} — the floor overclaims`
                }
              }
            fl.set(key, pe.s)
          }
        }
      }
      return null
    },
  },
  {
    name: 'census-truth',
    check: (sim: Sim): string | null => {
      const L = ledgerOf(sim)
      //! M6 finds the releases itself: it does not lean on M3 having run first, so each monitor stands alone
      L.classify(sim)
      if (!L.pending.length) return null
      const rels = L.pending.splice(0)
      for (const { node: N, id, cell, p, t } of rels) {
        L.counts.census++
        const under = (c: string) => c === cell || c.startsWith(cell.slice(0, -1) + ',')
        const lacks = (origin: string, seq: number, part: string) => !inLane(N, origin, seq) && covers(N, origin, part) < seq
        const bad = (origin: string, seq: number, epoch: number, rec: Rec, where: string): string | null => {
          if (!newer(t.epoch, t.seq, t.origin, { epoch, seq, origin })) return null
          const path = pathOf(rec)
          const c = JSON.stringify(path)
          if (!under(c)) return null
          if (!lacks(origin, seq, path[0])) return null
          return `${id} released the tombstone of ${cell} @${stampOf(t)} while ${where} holds ${c} @${epoch}/${seq}/${origin}, older, which ${id} neither holds nor covers`
        }
        for (const [mid, m] of sim.nodes) {
          if (m === N) continue
          for (const [o, entries] of m.logs) for (const e of entries) { const r = bad(o, e.seq, e.epoch, e.rec, `node ${mid}`); if (r) return r }
        }
        for (const f of sim.inflight.values())
          for (const fr of framesIn(f.bytes)) {
            if (fr.verb !== VERB.RECORDS && fr.verb !== VERB.ACQ) continue
            for (const rv of fr.records()) { const r = bad(rv.origin, rv.seq, rv.epoch, rv.rec(), `a frame on the wire ${f.from} → ${f.to}`); if (r) return r }
          }
        for (const [uuid, store] of sim.stores) {
          if (sim.nodes.has(uuid)) continue
          for (const row of store.wal) {
            if (!row.resolved || row.lied) continue
            for (const fr of framesIn(row.bytes)) for (const rv of fr.records()) { const r = bad(rv.origin, rv.seq, rv.epoch, rv.rec(), `the stored WAL of ${uuid} (down)`); if (r) return r }
          }
        }
      }
      return null
    },
  },
  {
    name: 'leave-drain',
    check: (sim: Sim): string | null => {
      const L = ledgerOf(sim)
      //! LEDGER class: nothing to judge or forget while sim.left is empty and the ledger remembers no leaver
      if (sim.left.size === 0 && !L.remembersLeft()) return null
      for (const [uuid, clean] of sim.left) {
        if (L.leftBefore(uuid) === clean) continue
        L.sawLeft(uuid, clean)
        if (!clean) continue
        const n = sim.nodes.get(uuid)
        if (!n || !n.armed || !n.scope) continue
        L.counts.leaves++
        for (const [p, e] of n.scope.entries) {
          if (e.state === SCOPE.acquiring) continue
          for (const [o, entries] of n.logs) {
            let tail = 0
            for (const x of entries) if (x.seq > tail && pathOf(x.rec)[0] === p) tail = x.seq
            if (!tail) continue
            let kept = false
            for (const [, m] of sim.nodes) { if (m === n || m.client) continue; if (inLane(m, o, tail) || covers(m, o, p) >= tail) { kept = true; break } }
            if (!kept) return `${uuid} left clean (R=${n.replicas}) while it alone held ('${p}', lane ${o}) up to seq ${tail} — the leave did not drain, that data goes with it`
          }
        }
      }
      //! a uuid that restarts and leaves again re-enters sim.left fresh (the scenario deletes its row): forget it too
      for (const uuid of sim.nodes.keys()) if (!sim.left.has(uuid) && L.leftBefore(uuid) !== undefined) L.forgetLeft(uuid)
      return null
    },
  },
]

//! SpokeWire (M10) — the digest exchange on every link that has a spoke at one end, as the sim sees it at the
// sink: what r each digest the spoke sent carried (by its own link id), which of those each feeder reply
// answers, and per node the digestIn rows read so far from its journal. Filled by the tap armScale chains.
class SpokeWire {
  //! spoke-side link id → r of each DIGEST the spoke sent on it, in order
  sent = new Map<number, number[]>()
  //! spoke-side link id → per DIGEST the feeder sent on it, in order: the index into `sent` of the spoke digest an
  // r=0 answers (the feeder replies inside the step that handled it, so its digestIn count names it), -1 for r=1
  answers = new Map<number, number[]>()
  //! spoke-side link id → per DIGEST the feeder sent on it, in order: its `d` map (the feeder's lane tails when it
  // built the frame) for an r=0, null for an r=1 — M11 reads the ending reply's tails
  ds = new Map<number, (Record<string, number> | null)[]>()
  //! spoke → the resync it is in (the kernel's object) and, per link, the index of the first r=1 sent since it began
  began = new Map<Node, { obj: object; first: Map<number, number> }>()
  last = new Map<Node, Resync | null>()
  #din = new Map<Node, { at: number; per: Map<number, number> }>()
  //! endings — the spokes whose resync ENDED since the last pass (resync went from an object to null), with the
  // resync that ended; computed once per pass (M10 and M11 both read it) and counted as the non-vacuity row
  #endedAt = -1
  #ended: { id: string; n: Node; was: Resync }[] = []
  endings(sim: Sim): { id: string; n: Node; was: Resync }[] {
    if (this.#endedAt === sim.events) return this.#ended
    this.#endedAt = sim.events
    this.#ended.length = 0
    for (const id of sim.stepped) {
      const n = sim.nodes.get(id)
      if (!n || !n.client) continue
      const was = this.last.get(n) ?? null
      this.last.set(n, n.resync)
      if (was === null || n.resync !== null) continue
      ledgerOf(sim).counts.resyncs++
      this.#ended.push({ id, n, was })
    }
    return this.#ended
  }
  //! digestIns — how many digests node n has taken in on `link` (its journal's digestIn rows, read by cursor)
  digestIns(n: Node, link: number): number {
    let c = this.#din.get(n)
    if (!c) { c = { at: 0, per: new Map() }; this.#din.set(n, c) }
    if (n.journal.n !== c.at) {
      for (const e of n.journal.read(c.at)) if (e.kind === JK.digestIn) c.per.set(e.a as number, (c.per.get(e.a as number) ?? 0) + 1)
      c.at = n.journal.n
    }
    return c.per.get(link) ?? 0
  }
  push<T>(m: Map<number, T[]>, link: number, x: T) { let a = m.get(link); if (!a) { a = []; m.set(link, a) } a.push(x) }
}
type Resync = NonNullable<Node['resync']>
const wires = new WeakMap<Sim, SpokeWire>()
const wireOf = (sim: Sim): SpokeWire => { let w = wires.get(sim); if (!w) { w = new SpokeWire(); wires.set(sim, w) } return w }
const digestValue = (b: Uint8Array): { r: number; d: Record<string, number> } => {
  try { const v = new Frame(b).value as { r?: number; d?: Record<string, number> }; return { r: v.r ?? 0, d: v.d ?? {} } } catch { return { r: -1, d: {} } }
}
const digestR = (b: Uint8Array): number => digestValue(b).r

//! the M10 tap: one byte compare per frame; digests touching a spoke are decoded
const spokeTap = (sim: Sim, w: SpokeWire) => (from: string, to: string, link: number, peerLink: number, _dialed: boolean, b: Uint8Array) => {
  if (b[2] !== VERB.DIGEST) return
  const fn = sim.nodes.get(from), tn = sim.nodes.get(to)
  if (!fn || !tn) return
  if (fn.client) {
    const r = digestR(b)
    w.push(w.sent, link, r)
    if (r === 1 && fn.resync !== null) {
      let st = w.began.get(fn)
      if (!st || st.obj !== fn.resync) { st = { obj: fn.resync, first: new Map() }; w.began.set(fn, st) }
      if (!st.first.has(link)) st.first.set(link, w.sent.get(link)!.length - 1)
    }
  } else if (tn.client) {
    const { r, d } = digestValue(b)
    w.push(w.answers, peerLink, r === 0 ? w.digestIns(fn, link) - 1 : -1)
    w.push(w.ds, peerLink, r === 0 ? d : null)
  }
}

const resyncEnd = {
  name: 'resync-end',
  check: (sim: Sim): string | null => {
    const w = wires.get(sim)
    if (!w) return null
    for (const { id, n, was } of w.endings(sim)) {
      //! the resync ended in this step, on the primary's r=0 (node.ts: the `v.r === 0` arm of the DIGEST handler)
      const link = n.primary
      if (link === null) continue
      const j = w.digestIns(n, link)
      const ans = w.answers.get(link)?.[j - 1]
      if (ans === undefined || ans < 0) continue
      const st = w.began.get(n)
      const first = st && st.obj === was ? st.first.get(link) : undefined
      if (first === undefined || ans < first)
        return `${id}'s resync ended on link ${link} on the reply to its digest #${ans}, sent ${first === undefined ? 'before it asked this feeder for the re-download at all' : 'before the resync asked for the re-download (#' + first + ')'} — a stale reply: the re-download is still on its way`
    }
    return null
  },
}

//! M11 resync-behind — the fold form of M10 (2026-10-10): at the moment a spoke's resync ends, its fold is not
// behind its feeder on any row it held at the reset. The reply that ends a resync was built AFTER the ship that
// answered the same ask, and the link is FIFO, so every record the feeder held when it built the reply has landed
// at the spoke. The reply's `d` map IS the feeder's lane tails at that build (SpokeWire.ds), so a record the
// feeder holds at seq > d[lane] was applied after the reply and is excused (it is on the wire behind the reply);
// one at or below d[lane] was shipped before the reply and must have landed — the one exact line, where "on the
// wire" would excuse the re-download itself behind a stale reply. For every cell of `old` (the kernel's set of
// cells held at the reset) whose live version at the feeder is in the feeder's log, for a partition the feeder
// FEEDS a spoke (Scope.feeds, wave 6a: held, or acquiring from a held base or from nothing — the answer ships those,
// so their rows are judged too; an orphan's frozen copy and a re-entry from one are withheld, so theirs are not), at
// or below the reply's tail for its lane, the spoke must contain-or-cover that record: in its log, or a version at the
// cell or an ancestor at or above it. A latch fold between the reply's build and the end puts a record at or below the
// tail into the feeder's lane that the answer did not ship: M11 fires on it, rightly — the spoke's fold IS behind, the
// ghost sweep took the row and only the fold's forward brings it back (the KNOWN vanish-and-return in
// sim/scale-probes.test.ts).
// Fails at a stale end: the ghost sweep removed rows the feeder holds, and the rows the re-download then re-applies
// land at older stamps first. Reads the kernel only (n.state, n.versions, the log — not the screen, and only at
// the end); nothing here moves a trajectory. The screen against the kernel is `screenMatches` at the horizon.
const resyncBehind = {
  name: 'resync-behind',
  check: (sim: Sim): string | null => {
    const w = wires.get(sim)
    if (!w) return null
    for (const { id, n, was } of w.endings(sim)) {
      const link = n.primary
      if (link === null) continue
      const fu = n.links.get(link)?.uuid
      const F = fu !== undefined ? sim.nodes.get(fu) : undefined
      if (!F) continue
      const D = w.ds.get(link)?.[w.digestIns(n, link) - 1]
      if (!D) continue // the ending reply was not seen by the tap: nothing to judge against
      const L = ledgerOf(sim)
      L.scan(sim)
      for (const cell of was.old) {
        const vF = F.versions.get(cell)
        if (vF === undefined || !F.state.has(cell) || vF.seq > (D[vF.origin] ?? 0) || !inLane(F, vF.origin, vF.seq)) continue
        const path = JSON.parse(cell) as string[]
        if (F.armed && !F.scope!.feeds(path[0])) continue
        L.counts.resyncRows++
        const e = L.recs.get(vF.origin + '|' + vF.seq)
        if (e === undefined || containsOrCovers(L, n, e)) continue
        const vS = n.versions.get(cell)
        return `${id}'s resync ended with its fold behind its feeder ${fu}: it held ${cell} at the reset, ${fu} holds it @${stampOf(vF)} (at or below the reply's tail ${D[vF.origin]} for lane ${vF.origin}), and ${id} ${vS === undefined ? 'no longer has it (a ghost that is live at the feeder)' : (n.state.has(cell) ? 'shows' : 'holds') + ' it @' + stampOf(vS) + ', older'} — the re-download had not landed when the ghost sweep ran`
      }
    }
    return null
  },
}

//! armScale — install the stage-0 monitors on a Sim (after cluster(), before the first run): turns the exec's watch on
// (sim.stepped, sim.inflight), appends M1-M11 once and chains M10's tap onto sim.tap. Idempotent.
export const armScale = (sim: Sim): Ledger => {
  sim.watch = true
  if (!sim.monitors.some((m) => m.name === 'stamp-oracle')) {
    sim.monitors.push(...scaleMonitors(), resyncEnd, resyncBehind)
    const w = wireOf(sim), tap = spokeTap(sim, w), prev = sim.tap
    sim.tap = prev === null ? tap : (f, t, l, pl, d, b) => { tap(f, t, l, pl, d, b); prev(f, t, l, pl, d, b) }
  }
  return ledgerOf(sim)
}

//! stampOracle — M1's HORIZON form (§6): each lawful holder's value or absence equals the V4-18 fold, by stamp,
// of every committed record some LIVE node still contains-or-covers (a write that died with its only node is
// a lost unconfirmed write, not a resurrection). Unscoped nodes and clients answer for every cell; an armed
// node for the partitions it HOLDS (an orphan's copy is lawfully frozen); a spoke of a scoped cluster is skipped
// (it sees its feeder's held subset only). converged() compares nodes to each
// other and passes a UNIFORM resurrection; this does not.
export const stampOracle = (sim: Sim): string | null => {
  const L = ledgerOf(sim)
  L.scan(sim)
  const live = [...sim.nodes.values()]
  const counted = (e: LEntry): boolean => live.some((m) => inLane(m, e.origin, e.seq) || covers(m, e.origin, e.p) >= e.seq)
  const win = new Map<string, LEntry>()
  for (const e of L.recs.values()) {
    if (!counted(e)) continue
    const w = win.get(e.cell)
    if (!w || newer(e.epoch, e.seq, e.origin, w)) win.set(e.cell, e)
  }
  const expect = new Map<string, LEntry>()
  for (const [cell, w] of win) {
    if (isRemove(w.rec)) continue
    let swept = false
    for (const a of ancestorKeys(w.path)) { const wa = win.get(a); if (wa && newer(wa.epoch, wa.seq, wa.origin, w)) { swept = true; break } }
    if (!swept) expect.set(cell, w)
  }
  //! a spoke of a SCOPED cluster sees its feeder's held subset only (write.ts: the tap carries the feeder's held
  // partitions; STATUS "spokes subscribe to what they watch" is the idea that changes it), so it owes no whole
  // fold here; the per-event form (stamp-oracle) still checks every cell it shows against its applied fence
  const scoped = [...sim.nodes.values()].some((n) => n.armed)
  for (const [id, n] of sim.nodes) {
    if (scoped && n.client) continue
    const mine = (cell: string): boolean => !n.armed || n.scope!.held((JSON.parse(cell) as string[])[0] ?? '')
    for (const [cell, w] of expect) {
      if (!mine(cell)) continue
      if (!n.state.has(cell)) return `${id} lacks ${cell}, which the fold of every committed record by stamp sets to ${clip(stable(w.rec.value))} (@${stampOf(w)})`
      if (stable(n.state.get(cell)) !== stable(w.rec.value)) return `${id} shows ${cell} = ${clip(stable(n.state.get(cell)))}; the fold by stamp says ${clip(stable(w.rec.value))} (@${stampOf(w)})`
    }
    for (const cell of n.state.keys()) {
      if (expect.has(cell) || !mine(cell)) continue
      const w = win.get(cell)
      return `${id} shows ${cell} = ${clip(stable(n.state.get(cell)))}, which the fold by stamp ${w ? 'removes (@' + stampOf(w) + ')' : 'never wrote'} — resurrected`
    }
  }
  return null
}

//! floorsAgree — M7's horizon form: at a quiet point every partition's holders report equal floors on every lane.
// `counts.lanes` reports how many (partition, lane) floors it compared across ≥ 2 holders — the non-vacuity row (an
// R=1 run compares nothing, lawfully).
export const floorsAgree = (sim: Sim, counts?: { lanes: number }): string | null => {
  const nodes = [...sim.nodes.entries()].filter(([, n]) => n.scope && n.armed)
  if (nodes.length < 2) return null
  const epochs = new Set(nodes.map(([, n]) => n.epoch))
  if (epochs.size > 1) return `floorsAgree: armed nodes disagree on the epoch (${[...epochs].join(',')}) — not quiescent`
  const [, first] = nodes[0]
  const ring = first.writes.ring
  if (ring.epoch !== first.epoch) ring.build(first.epoch, first.membership.view.members)
  const parts = new Set<string>()
  for (const [, n] of nodes) for (const [p, e] of n.scope!.entries) if (e.state === SCOPE.held) parts.add(p)
  for (const p of parts) {
    const holders = nodes.filter(([, n]) => n.scope!.held(p) && ring.holdsAny(n.uuid, p, n.replicas))
    if (holders.length < 2) continue
    const lanes = new Set<string>()
    for (const [, h] of holders) for (const [o, d] of h.streams) if ((d.parts?.get(p)?.s ?? 0) > 0) lanes.add(o)
    for (const o of lanes) {
      if (counts) counts.lanes++
      const fl = holders.map(([id, h]) => `${id}=${h.streams.get(o)?.parts?.get(p)?.s ?? 0}`)
      if (new Set(fl.map((x) => x.split('=')[1])).size > 1) return `holders of '${p}' disagree on the floor for lane ${o}: ${fl.join(' ')}`
    }
  }
  return null
}

//! marksAgree — M7's KNOWLEDGE form (I6's "h hears x's floor"; DESIGN-SCALE stage 2, the review of 2026-10-10): at a
// quiet point every holder's MARKS of each co-holder equal that co-holder's floors for the partition, lane by lane
// (and its durable marks the co-holder's durable floors, when the co-holder is durable). Why a second form: the floor
// form above cannot see either of stage 2's repair legs in the sim. A live sim link loses no frame, and every loss
// the sim can make (a cut, a pause, an install) is followed by a round of its own (the re-admit, drain or install
// round), so floors agree at the horizon whether or not the owner announces what it stamped and whether or not the
// sweep runs. Knowledge can see them: with the sweep off, a co-holder↔co-holder pair of an R=3 partition (neither is
// the owner, so neither announces for it) never hears the other's floor again after a write; and with the owner's
// dirty mark dropped too, an owner↔co-holder pair does not either. The stage-2 mutations in sim/scoped-sweep.ts
// (`no-sweep`, `drop-dirty`) pin both reds; the clean sweep must stay green here on every family and seed. Stale
// knowledge is a repair-liveness hole, not a safety one (I6: compaction and GC wait on marks — the safe direction),
// so a red here is `notLive`. Skipped, by design: a pair with no admitted, flowing link between them; a durable
// entry still waiting for its seal (it attests nothing yet, by the attestation gate); a lane the co-holder has no
// floor for. `counts.pairs` reports the (holder, co-holder, partition) triples compared — the non-vacuity row.
export const marksAgree = (sim: Sim, counts?: { pairs: number }): string | null => {
  const nodes = [...sim.nodes.entries()].filter(([, n]) => n.scope && n.armed)
  if (nodes.length < 2) return null
  const epochs = new Set(nodes.map(([, n]) => n.epoch))
  if (epochs.size > 1) return `marksAgree: armed nodes disagree on the epoch (${[...epochs].join(',')}) — not quiescent`
  const [, first] = nodes[0]
  const ring = first.writes.ring
  if (ring.epoch !== first.epoch) ring.build(first.epoch, first.membership.view.members)
  const parts = new Set<string>()
  for (const [, n] of nodes) for (const [p, e] of n.scope!.entries) if (e.state === SCOPE.held) parts.add(p)
  const flowing = (h: Node, x: Node): boolean => {
    const id = h.byUuid.get(x.uuid)
    const l = id === undefined ? undefined : h.links.get(id)
    return l !== undefined && l.state === LS.admitted && !l.dead && !l.paused
  }
  for (const p of parts) {
    const holders = nodes.filter(([, n]) => n.scope!.held(p) && ring.holdsAny(n.uuid, p, n.replicas))
    if (holders.length < 2) continue
    for (const [hid, h] of holders) {
      const e = h.scope!.entries.get(p)!
      for (const [xid, x] of holders) {
        if (x === h || !flowing(h, x)) continue
        const xe = x.scope!.entries.get(p)!
        if (x.durable && xe.sealed === false) continue // x attests nothing of p yet: nothing to have heard
        const per = e.marks.get(x.uuid), perD = e.marksD.get(x.uuid)
        let compared = false
        for (const [o, d] of x.streams) {
          const s = d.parts?.get(p)?.s ?? 0
          if (s === 0) continue
          compared = true
          const m = per?.get(o) ?? 0
          if (m < s) return `M7 knowledge: ${hid} knows ${xid}'s floor for '${p}' lane ${o} as ${m}; ${xid} is at ${s} — never heard (no announcement reached ${hid}, and no sweep re-proved the pair)`
          if (m > s) return `M7 knowledge: ${hid} holds a mark of ${xid} for '${p}' lane ${o} at ${m} ABOVE ${xid}'s floor ${s} — an attestation ${xid} does not stand behind`
          if (x.durable) {
            const pd = d.parts?.get(p)?.d ?? 0
            const md = perD?.get(o) ?? 0
            if (pd > 0 && md < pd) return `M7 knowledge: ${hid} knows ${xid}'s DURABLE floor for '${p}' lane ${o} as ${md}; ${xid} is at ${pd} — the echo never reached ${hid}`
          }
        }
        if (compared && counts) counts.pairs++
      }
    }
  }
  return null
}

//! spokeMirror — M12 (wave 6a, 2026-10-12): the oracle for a spoke of a SCOPED cluster. At a quiet point the spoke
// shows its feeder's held subset, cell for cell: every cell of every partition its feeder HOLDS is at the spoke with
// the feeder's value (stable(): NaN-aware, bytes-aware), and the spoke shows no cell of such a partition that the
// feeder does not. Read from the kernel (n.state), never the screen (that is screenMatches). Why a spoke needed its
// own oracle: no check compared a spoke to anyone — scopedConverged ranges over holders, stampOracle skips a spoke of
// a scoped cluster (it sees a subset), the per-event M1 checks only what a spoke SHOWS against its fence, M10/M11
// judge a resync's end and M11 only the rows held at the reset — so a row a feeder learnt through the latch and never
// tapped was missing at its spokes on every seed and no monitor fired (STATUS's two sightings; the wave-5e review's
// probe P2). A spoke still in resync at the quiet point is reported (the point should have ended it); a spoke with no
// feeder, or whose feeder is not armed, is skipped. `counts` is the non-vacuity row: the (spoke, partition) pairs and
// the cells compared. The spoke's cells of partitions the feeder does NOT hold are not judged here — `spokeStale`
// below counts them: a partition that moved OFF the feeder (a join: an orphan, then its shed) leaves its rows at the
// spoke, which nothing tells, an older gap named on STATUS by wave 6a.
export const spokeMirror = (sim: Sim, id: string, counts?: { parts: number; cells: number }): string | null => {
  const s = sim.nodes.get(id)
  if (!s || !s.client) return null
  if (s.resync !== null) return `${id} is still in resync at the quiet point (its ask #${s.resync.q} has no reply yet)`
  if (s.primary === null) return null
  const fu = s.links.get(s.primary)?.uuid
  const F = fu !== undefined ? sim.nodes.get(fu) : undefined
  if (!F || !F.armed || !F.scope) return null
  const judged = new Set<string>()
  for (const [k, v] of F.state) {
    const p = partOfKey(k)
    if (!F.scope.held(p)) continue
    if (counts) { counts.cells++; if (!judged.has(p)) { judged.add(p); counts.parts++ } }
    const vF = F.versions.get(k)
    const at = vF ? ' @' + stampOf(vF) : ''
    if (!s.state.has(k)) return `M12: ${id} lacks ${k}, which its feeder ${fu} holds = ${clip(stable(v))}${at} for '${p}', a partition ${fu} holds`
    if (stable(s.state.get(k)) !== stable(v)) return `M12: ${id} shows ${k} = ${clip(stable(s.state.get(k)))}; its feeder ${fu} holds ${clip(stable(v))}${at}`
  }
  for (const k of s.state.keys()) {
    const p = partOfKey(k)
    if (!F.scope.held(p) || F.state.has(k)) continue
    return `M12: ${id} shows ${k} = ${clip(stable(s.state.get(k)))} of '${p}', a partition its feeder ${fu} holds without that cell`
  }
  return null
}

//! spokeStale — the other direction of M12, counted, not judged (wave 6a): the spoke's cells of partitions its feeder
// does not HOLD now — an orphan at the feeder (frozen: no new record of it reaches the feeder, so none reaches the
// spoke), or shed (gone from the feeder, kept at the spoke: a shed tells no spoke). Both are rows the spoke keeps
// showing while the cluster moves on, until a failover's resync wipes them. Returns the count and the first few, with
// the feeder's entry state for each partition ('orphan', or 'gone' when the feeder has no entry).
export const spokeStale = (sim: Sim, id: string): { n: number; some: string[] } => {
  const out = { n: 0, some: [] as string[] }
  const s = sim.nodes.get(id)
  if (!s || !s.client || s.primary === null) return out
  const fu = s.links.get(s.primary)?.uuid
  const F = fu !== undefined ? sim.nodes.get(fu) : undefined
  if (!F || !F.armed || !F.scope) return out
  for (const k of s.state.keys()) {
    const p = partOfKey(k)
    if (F.scope.held(p)) continue
    out.n++
    if (out.some.length < 3) out.some.push(`${k} ('${p}' is ${F.scope.entries.get(p)?.state === SCOPE.orphan ? 'an orphan' : 'gone'} at ${fu})`)
  }
  return out
}
const partOfKey = (k: string): string => (JSON.parse(k) as string[])[0] ?? ''

//! boundedLogs — M8's horizon form (I12): at every armed node every lane holds at most winners + compactAt
// entries, and every tombstone is fenced (a live row still needs it) or pinned by a named uuid. No pin surface
// exists today, so an unfenced tombstone reads as unbounded: RED TODAY wherever a scoped run removed a cell or
// a lane outgrew compactAt. The sweep pins the count of red seeds; stage 3 and stage 4 flip them.
export const boundedLogs = (sim: Sim): string | null => {
  let worst: string | null = null, worstBy = 0
  for (const [id, n] of sim.nodes) {
    if (!n.armed) continue
    for (const [o, entries] of n.logs) {
      let winners = 0
      for (const e of entries) { const v = n.versions.get(JSON.stringify(pathOf(e.rec))); if (v && v.origin === o && v.seq === e.seq && v.epoch === e.epoch) winners++ }
      const over = entries.length - (winners + n.tune.compactAt)
      if (over > worstBy) { worstBy = over; worst = `${id} lane ${o} holds ${entries.length} entries: ${winners} winners + compactAt ${n.tune.compactAt}, ${over} over — unbounded` }
    }
  }
  if (worst) return worst
  for (const [id, n] of sim.nodes) {
    if (!n.armed) continue
    for (const [k, v] of n.versions) if (!n.state.has(k) && !n.fenced(k)) return `${id} holds the tombstone of ${k} @${stampOf(v)}, neither fenced nor pinned by a named uuid`
  }
  return null
}
