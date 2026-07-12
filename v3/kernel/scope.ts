//! ── kernel/scope — the per-(node, partition) scoped-replication state machine ──
// M6 (DESIGN-M6 organizing rule 1). Constructed ONLY on scoped nodes (node.scope
// is null at R=∞ — the module is structurally unreachable unscoped). States:
//
//   held      — this node is a current R-set member for p and its base is
//               complete (the no-bypass rule: every entry into held passes
//               through one atomic one-teacher fold — slice 3b — except the
//               owner minting a partition's FIRST record, complete by
//               construction, and the pre-arm inheritance below).
//   acquiring — (slice 3b) a one-teacher latch is open; inbound records for p
//               stage in the latch buffer, nothing folds until ACQDONE.
//   orphan    — locally-present data whose partition left this node's R-set:
//               HARD-FROZEN. New records gate-drop (feeding orphans would make
//               shed-confirm chase a moving target — H7 becomes the common
//               case), the fan-out excludes it, its floors never advance (the
//               orphan-frozen monitor asserts exactly this), and it serves as
//               a teacher until the stateless shed predicate (3b) proves every
//               CURRENT holder covers its frozen tails.
//
// PRE-ARM INHERITANCE: the arming install (epoch 0 → 1 on a scoped node) finds
// every partition of the open-genesis era on every node (epoch 0 is full
// broadcast by design). rescope() classifies them: ring-assigned ⇒ held (the
// node provably holds the complete prefix — everyone does), else ⇒ orphan.
// This is the one entry into held that needs no teacher: completeness is
// inherited from the R=∞ era, not asserted.
//
// Every transition is journaled (JK 59-67) and re-derivable at boot from
// BootRecord.heldPartitions + the restored ring (DESIGN-M6 C10) — no protocol
// state survives a crash except through those two.

import { JK } from './journal.ts'
import { partitionOf } from './env.ts'
import type { Node } from './node.ts'

//! SCOPE: the state discriminants (journal/capture-stable).
export const SCOPE = { held: 1, acquiring: 2, orphan: 3 } as const

//! ScopeEntry: one partition's machine state. `marks` (3b) holds the handshake-ATTESTED per-lane
// possession marks per peer uuid — the sole scoped evidence confirm counting and the shed predicate
// may read; epoch-scoped (cleared wholesale at install) and voided per peer at rebirth (forget).
export interface ScopeEntry {
  state: number
  marks: Map<string, Map<string, number>>
}

export class Scope {
  entries = new Map<string, ScopeEntry>()

  #entry(state: number): ScopeEntry { return { state, marks: new Map() } }

  //! held — the api/monitor view: is p live here (folds records, serves reads)?
  held(p: string): boolean { return this.entries.get(p)?.state === SCOPE.held }

  //! accepts — THE INBOUND-GATE decision (write.ts ingest, armed only): does a record for p fold
  // here? Held ⇒ yes. Orphan ⇒ no (the freeze). No entry ⇒ yes iff ring-assigned — the partition's
  // first-ever record reaching its lawful holder mints a held entry (complete by construction: a
  // first record has no history to miss). Everything else is the epoch-skew window: gate-drop,
  // journaled, never evidence (the dropper never attests marks for p).
  accepts(node: Node, p: string): boolean {
    const e = this.entries.get(p)
    if (e !== undefined) return e.state === SCOPE.held
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    if (!ring.holdsAny(node.uuid, p, node.replicas)) return false
    this.entries.set(p, this.#entry(SCOPE.held))
    return true
  }

  //! mintHeld — the STAMP-SITE twin of accepts(): an armed owner committing a record for p holds p
  // by definition (single-writer: the ring routed the write here). First-ever commit mints the held
  // entry — the second lawful teacher-less entry into held (complete by construction).
  mintHeld(p: string) {
    if (!this.entries.has(p)) this.entries.set(p, this.#entry(SCOPE.held))
  }

  //! rescope — the INSTALL hook (membership install + the arming transition): re-derive every
  // partition's duty against the new ring. Locally-present partitions get entries (the pre-arm
  // inheritance — see the banner); a held partition that left the R-set freezes into an orphan
  // (JK.orphaned); marks clear wholesale (evidence is epoch-scoped — an old epoch's attestations
  // must not satisfy a new epoch's shed predicate, the H2 corner). Slice 3b adds: orphan→acquiring
  // re-entry (never straight to held), latch aborts, and the shed poll arming.
  rescope(node: Node) {
    const ring = node.writes.ring
    if (node.epoch > 0 && ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    //! local presence = live cells + tombstones + lane history (cold walk, per install only)
    for (const k of node.state.keys()) this.#ensure(node, keyPartition(k))
    for (const k of node.versions.keys()) this.#ensure(node, keyPartition(k))
    for (const entries of node.logs.values()) for (const e of entries) this.#ensure(node, partitionOf(e.rec))
    const j = node.journal
    for (const [p, e] of this.entries) {
      const assigned = ring.holdsAny(node.uuid, p, node.replicas)
      e.marks.clear()
      if (e.state === SCOPE.held && !assigned) {
        e.state = SCOPE.orphan
        j.armed && j.emit(JK.orphaned, p, node.epoch)
      }
      //! orphan re-assigned (H2's A leg): stays FROZEN in 3a — the lawful re-entry is 3b's
      // acquiring (delta above the frozen tails), never a silent un-freeze
    }
  }

  #ensure(node: Node, p: string) {
    if (this.entries.has(p)) return
    const assigned = node.writes.ring.holdsAny(node.uuid, p, node.replicas)
    this.entries.set(p, this.#entry(assigned ? SCOPE.held : SCOPE.orphan))
    if (!assigned) node.journal.armed && node.journal.emit(JK.orphaned, p, node.epoch)
  }

  //! forget — a peer was reborn: every mark its previous life attested is void (the confirm.forget
  // twin — dead evidence must not satisfy a shed predicate or count for a probe).
  forget(uuid: string) {
    for (const e of this.entries.values()) e.marks.delete(uuid)
  }

  //! tallies — the cluster.partitions projection (api slice 4): bounded scalars, one walk.
  tallies(): { held: number; acquiring: number; orphaned: number } {
    let held = 0, acquiring = 0, orphaned = 0
    for (const e of this.entries.values()) {
      if (e.state === SCOPE.held) held++
      else if (e.state === SCOPE.acquiring) acquiring++
      else orphaned++
    }
    return { held, acquiring, orphaned }
  }
}

//! keyPartition — state/versions keys are JSON path arrays ('["p","x"]'): the partition is elem 0.
const keyPartition = (k: string): string => {
  const path = JSON.parse(k) as string[]
  return path.length ? path[0] : ''
}
