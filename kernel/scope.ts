//! ── kernel/scope — the per-(node, partition) scoped-replication state machine ──
// M6 (DESIGN-M6 organizing rule 1). Constructed ONLY on scoped nodes (node.scope
// is null at R=∞ — the module is structurally unreachable unscoped). States:
//
//   held      — this node is a current R-set member for p and its base is
//               complete. THE NO-BYPASS RULE: every entry into held passes
//               through one atomic one-teacher fold (the ACQ latch below),
//               with exactly three teacher-less exceptions, each complete by
//               construction: (1) the owner minting a partition's FIRST
//               record, (2) the inbound gate admitting a first-ever record to
//               its lawful holder, (3) the pre-arm inheritance — the arming
//               install finds every open-genesis partition on every node
//               (epoch 0 is full broadcast), so completeness is inherited.
//   acquiring — a one-teacher latch is open: teacher ACQ records and live
//               RECORDS for p both STAGE in the latch buffer; nothing touches
//               lanes, state, versions, floors, or the WAL until the fold at
//               ACQDONE. An abort drops the buffer whole (nothing folded,
//               nothing to unwind) and the next handshake round re-offers.
//   orphan    — locally-present data whose partition left this node's R-set:
//               HARD-FROZEN. New records gate-drop, the fan-out excludes it,
//               its floors never advance; it answers HAVEA (its frozen floors
//               are sound possession claims) and teaches, until the STATELESS
//               shed predicate proves every CURRENT holder covers its frozen
//               tails — then the data leaves this node (boot-write → memory
//               drop → snapshot, crash-safe on both sides of every step).
//
// THE EVIDENCE PLANE (C3): per-(origin, partition) possession marks ride the
// HAVEQ/HAVEA handshake, never the DIGEST (whose wire shape is untouched in
// both modes). marks are epoch-scoped (cleared wholesale at install — an old
// epoch's attestations must not satisfy a new epoch's shed predicate, the H2
// corner) and voided per peer at rebirth (forget, beside confirm.forget).
// The shed DECISION is stateless — re-evaluated fresh from current marks ×
// the current ring on every arrival/install/tick, so "invalidated on any
// high-water bump and on R-set change" is enforcement-by-construction (there
// is no stored confirmation to forget). Orphan tails cannot bump anyway (the
// freeze), so the journal story is orphaned → (shedStall)* → shed.

import { JK } from './journal.ts'
import { VERB, encodeControl, encodeRuns } from './codec.ts'
import { partitionOf, type Rec } from './env.ts'
import { LS, type Link } from './link.ts'
import { keep, scopedFrontier } from './log.ts'
import type { Node } from './node.ts'

//! SCOPE: the state discriminants (journal/capture-stable).
export const SCOPE = { held: 1, acquiring: 2, orphan: 3 } as const

//! The four pacing constants below are the DEFAULTS of their tune-table rows (kernel/tune.ts: shedTicks,
// stageTicks, acqLiveMax, stallAt); the read sites consult `node.tune.<row>`.
//! SHED_TICKS: heartbeat ticks between an orphan's shed polls / a probing holder's re-HAVEQs.
export const SHED_TICKS = 2
//! STAGE_TICKS: latch ticks without ACQDONE before the attempt aborts ('timeout') and re-offers.
export const STAGE_TICKS = 8
//! ACQ_LIVE_MAX: staged live-record bound per latch — overflow aborts (safe: nothing folded; the
// re-offered delta re-ships everything above the learner's marks), killing the big-partition livelock.
export const ACQ_LIVE_MAX = 8192
//! STALL_AT: polls without shed progress before the FIRST shedStall alarm (then doubling cadence).
export const STALL_AT = 8
//! AE_FAN (DESIGN-SCALE stage 2, §3 trigger 4; the owner's yes, §14 Q1): co-holder links the sweep re-announces to
// per tick, in uuid order behind a cursor, so every held partition is re-proved with each co-holder within
// ⌈co-holders / aeFan⌉ ticks (about 9 at n=100). A tune row, not a config key (V4-19). 0 = no sweep (a measurement
// posture for the counted pins: announce-on-change alone); every real cluster keeps the default.
export const AE_FAN = 8

//! covers — THE shed bar as one predicate: do a holder's attested marks (`per`: HAVEA ok `m` / HAVEQ feed) reach
// every frozen content tail (`lanes`)? evaluateSheds (the shed), undrained (the leave drain) and shedWaitingOn
// (the stall surface) all read it, so the three cannot drift apart: an ok answer whose floors sit BELOW the tail is not cover — under the pp law floors
// lawfully under-claim (M6 findings 12/21), and the drain must wait for the right event, not any ok answer.
const covers = (per: Map<string, number> | undefined, lanes: [string, number][]): boolean => {
  for (const [o, s] of lanes) if ((per?.get(o) ?? 0) < s) return false
  return true
}

//! one staged record — teacher transfer and live records share the buffer, discriminated by `live`.
interface Staged { origin: string; seq: number; epoch: number; iss?: string; cid?: number; rec: Rec; live: boolean; pp?: number }

//! one partition's HAVEA answer: ok/need as always; m the echoed floors, md the durable ones; `g: 1` gapless (stage 2);
// `x: 1` none — the answerer neither holds nor is assigned p (stage 2, where the old code was silent)
interface Answer { ok: number; need: number; m?: Record<string, number>; md?: Record<string, number>; g?: number; x?: number }

//! ScopeEntry: one partition's machine state.
export interface ScopeEntry {
  state: number
  //! attested per-lane possession marks per peer uuid (HAVEQ-in declares, HAVEA-ok-in echoes)
  marks: Map<string, Map<string, number>>
  //! the durable mirror (HAVEQ `d` declares, HAVEA `md` echoes) — scoped persisted-level confirm evidence reads THESE
  marksD: Map<string, Map<string, number>>
  //! gapless (DESIGN-SCALE stage 2): the peers whose LAST announcement or answer for p said `g` — their content
  // tail equals their floor on every lane of p, so their floors speak for their content (G4). A last-value bit per
  // peer, not monotone: an announcement without `g` clears it. Stage 4's holder quorum (R2) reads it.
  gl: Set<string>
  //! latch state (acquiring only)
  teacher?: string
  buf?: Staged[]
  teachN?: number
  //! the pre-latch state (held/orphan → acquiring; undefined = from-zero). Keeps the on-disk base
  // foldable in the boot record through the latch window under its OWN classification (an orphan
  // base restores frozen; the staged buffer stays excluded — it is memory-only).
  preState?: number
  //! staged LIVE count — an O(1) counter beside the buffer (M6-review findings 17/24: the overflow
  // check was a full-buffer filter per staged record, O(n²) inside one synchronous handover step)
  liveN?: number
  ticks?: number
  //! orphan shed-poll bookkeeping
  polls?: number
  nextStall?: number
  //! frozen per-lane CONTENT tails (max (o,p) seq actually present), captured at the orphan
  // transition — THE shed evidence (M6-review findings 12/21 + the pp-law panel's fatal: floors may
  // lawfully under-claim content (epoch-0 data, bootDirty restores, pp-gapped folds), so shedding on
  // floor-coverage alone destroys above-floor records no holder proved it covers)
  tails?: Record<string, number>
  //! durable ACQDONE echo gate (findings 19/37/46): false = base folded in MEMORY only — the entry
  // is held (folds live records) but ATTESTS nothing and stays out of the boot record until the
  // snapshot swap's persisted echo seals it (never attest what disk can't restore).
  sealed?: boolean
}

export class Scope {
  entries = new Map<string, ScopeEntry>()
  //! n — a version counter bumped on every entry create/transition/drop: the api's cluster.partitions
  // fold compares it per step instead of re-walking the map (tallies drift on plain held-mints, which
  // journal nothing scope-specific).
  n = 0
  //! evidence (DESIGN-SCALE stage 3) — a counter bumped wherever the compaction frontier's inputs can RISE or a
  // partition can become compactable: a mark or durable mark raised (onHaveQ, onHaveA), voided (#void), cleared
  // (rescope), a seal, a fold, a shed, and a durable floor advance at the snapshot or persist echo (node.ts). The
  // memo below keys a lane's last fruitless pass on (length, evidence), so a lane at compactAt whose frontier is
  // pinned costs one Map.get per tick until something that could unpin it happens (kernel/log.ts maybeCompact).
  evidence = 0
  //! memo — lane → the length and evidence version at its last compaction pass (kernel/log.ts); cleared with the fold
  memo = new Map<string, { len: number; v: number }>()

  #entry(state: number): ScopeEntry { return { state, marks: new Map(), marksD: new Map(), gl: new Set() } }

  //! stableMarks — one peer's CRASH-STABLE attested marks for p (DESIGN-SCALE §4 C3; the shed bar and the drain read
  // the same ladder): a peer that has announced durable floors for p (HAVEQ `d`, HAVEA `md`), or that confirm has
  // ever seen a durable digest from, is durable — its durable marks are what its disk restores, and its volatile
  // marks can overclaim rows a crash eats (the seed-27 resurrection's class). A peer that never has is a memory node:
  // its crash is a total refold, so its volatile marks are sound. Undefined = nothing attested = 0 everywhere.
  stableMarks(node: Node, e: ScopeEntry, uuid: string): Map<string, number> | undefined {
    return e.marksD.has(uuid) || node.confirm.durablePeer(uuid) ? e.marksD.get(uuid) : e.marks.get(uuid)
  }
  //! stableMark — one peer's crash-stable floor for (lane o, partition p): the frontier's unit. Absent is 0 and pins.
  stableMark(node: Node, e: ScopeEntry, uuid: string, o: string): number { return this.stableMarks(node, e, uuid)?.get(o) ?? 0 }

  //! held — the api/monitor view: is p live here (folds records, serves reads, attests possession)?
  held(p: string): boolean { return this.entries.get(p)?.state === SCOPE.held }

  //! feeds — THE SPOKE FEED (wave 6a, its review): is what this node holds of p a spoke's to have? Everything but a
  // FROZEN copy: held; or acquiring from a held base or from nothing (a repair, a hand-off: the base in the lane was
  // served and tapped while held, or is this owner's own commits, and the fold only adds to it). An orphan's frozen
  // copy is a teacher for holders, never a spoke feed, and a latch re-entering FROM an orphan (preState) stays so
  // until its fold. node.ts #answer walks a client's digest answer with this, so a spoke that syncs while its feeder
  // repairs a partition gets the base at once (held() alone skipped it: the spoke missed the base for good, or lost
  // it at a resync's end and saw it return at the fold), and onAcqDone's forward can give every synced spoke the
  // delta alone — a re-entry from an orphan is the one fold that owes its spokes the whole of p.
  feeds(p: string): boolean {
    const e = this.entries.get(p)
    return e !== undefined && (e.state === SCOPE.held || (e.state === SCOPE.acquiring && e.preState !== SCOPE.orphan))
  }

  //! verdict — THE INBOUND-GATE decision (write.ts ingest, armed only), the §0 law's first rows:
  // 1 = fold (held; a first-ever record to its lawful holder mints held), 2 = stage (an open latch
  // buffers live records for p), 0 = gate-drop (orphan freeze / not assigned / epoch skew).
  verdict(node: Node, p: string): number {
    const e = this.entries.get(p)
    if (e !== undefined) {
      if (e.state === SCOPE.held) return 1
      if (e.state === SCOPE.acquiring) return 2
      return 0 // orphan: hard-frozen
    }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    if (!ring.holdsAny(node.uuid, p, node.replicas)) return 0
    this.entries.set(p, this.#entry(SCOPE.held))
    this.n++
    //! the creating mint persists the boot record (finding 51) — the fan-out rows about to WAL for
    // this partition must replay under a boot record that names it. SOUNDNESS NOTE (findings
    // 10/18/25): this mint makes NO possession claim — the floor law (write.ts, the pp chain)
    // advances floors only when the sender-stamped predecessor is already covered, so a mid-lane
    // first arrival folds here with floor 0, announces nothing, and the next handshake round
    // latches the real base. Only a genuine first-ever record (pp = 0) floors at full speed.
    if (node.durable) node.persistBoot()
    return 1
  }

  //! expects — will a live record for p FOLD here (now or after an open latch)? verdict() without the mint
  // and without a side effect: held or acquiring, or absent and assigned (the arrival would mint held).
  // An orphan, or a partition the ring gives to others, never folds here — the write pipeline reads this
  // to know when an attempt's commit can only be learned from its WACK (the `acked` effect, env.ts).
  expects(node: Node, p: string): boolean {
    const e = this.entries.get(p)
    if (e !== undefined) return e.state !== SCOPE.orphan
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    return ring.holdsAny(node.uuid, p, node.replicas)
  }

  //! stage — buffer one live record for a latched partition (verdict 2). Overflow aborts the latch —
  // safe because nothing has folded; the next offer re-ships everything above the learner's marks.
  // The bound reads the O(1) liveN counter (M6-review findings 17/24 — the full-buffer filter per
  // staged record was O(n²) inside the very handover step the bound exists to keep short).
  stage(node: Node, p: string, origin: string, seq: number, epoch: number, rec: Rec, iss?: string, cid?: number, pp?: number) {
    const e = this.entries.get(p)!
    e.buf!.push({ origin, seq, epoch, rec, iss, cid, live: true, pp })
    if (++e.liveN! > node.tune.acqLiveMax) this.#abort(node, p, 'overflow')
  }

  //! mintHeld — the STAMP-SITE twin of verdict(): an armed owner committing a record for p holds p
  // by definition (single-writer: the ring routed the write here). A CREATING mint persists the boot
  // record (M6-review finding 51): the WAL rows about to land for p must replay under a boot record
  // that names p, or a crash orphans disk truth behind the C10 held-gate.
  mintHeld(node: Node, p: string) {
    if (!this.entries.has(p)) {
      this.entries.set(p, this.#entry(SCOPE.held))
      this.n++
      if (node.durable) node.persistBoot()
    }
  }

  //! rescope — the INSTALL hook (membership install + the arming transition + a restored boot):
  // re-derive every partition's duty against the new ring. Held partitions that left the R-set
  // freeze into orphans; every open latch ABORTS (the machine is epoch-scoped — H2/window 7); marks
  // clear wholesale; then one batched HAVEQ round announces/probes so acquisition offers, confirm
  // evidence, and shed polls all re-drive against the new world.
  rescope(node: Node) {
    const ring = node.writes.ring
    if (node.epoch > 0 && ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    for (const k of node.state.keys()) this.#ensure(node, keyPartition(k))
    for (const k of node.versions.keys()) this.#ensure(node, keyPartition(k))
    for (const p of node.byPart!.keys()) this.#ensure(node, p) // the partition census through the index (stage 1): O(partitions), not O(entries)
    const j = node.journal
    this.evidence++ // the marks clear and partitions change state: the compaction memo re-reads (kernel/log.ts)
    for (const [p, e] of this.entries) {
      const assigned = ring.holdsAny(node.uuid, p, node.replicas)
      e.marks.clear()
      e.marksD.clear()
      if (e.state === SCOPE.acquiring) this.#abort(node, p, 'epoch') // may transition to orphan (residue) or drop the entry
      const cur = this.entries.get(p)
      if (!cur) continue
      if (cur.state === SCOPE.held && !assigned) {
        cur.state = SCOPE.orphan
        cur.polls = 0
        cur.nextStall = node.tune.stallAt
        cur.tails = this.#tailsOf(node, p) // the FREEZE capture: the shed evidence, fixed from here
        cur.sealed = undefined
        this.n++
        j.armed && j.emit(JK.orphaned, p, node.epoch)
      }
      //! orphan re-assigned (H2's A leg): stays FROZEN — the lawful re-entry is an acquiring latch
      // (delta above the frozen tails) opened by the next handshake round, never a silent un-freeze
    }
    //! a cleared write whose record was expected here but whose partition just left this node (an
    // aborted latch, a new orphan, an unassigned partition) settles from its WACK now (write.ts #awaiting)
    node.writes.rescoped(node)
    //! THE ARMING TRUING (pre-arm inheritance, the no-bypass rule's door 3): the FIRST armed rescope
    // of a life BORN AT EPOCH 0 trues every entry's floors to its lane tails — epoch-0 replication
    // is full-broadcast, so tails are complete-by-construction and the claim is sound. Without it
    // every genesis record sits below a pp chain no floor can enter (their rows carry no pp), the
    // handshake sees nobody behind, and floors never recover (the panel's seam hole). A BOOT-
    // RESTORED life (epoch > 0 at construction) never trues — its floors seed from the boot record
    // and replayed lanes may hold lawful gaps the truing would overclaim.
    if (!this.#trued && node.armed && node.bornAt0) {
      this.#trued = true
      for (const [p] of this.entries) {
        const tails = this.#tailsOf(node, p)
        for (const [origin, t] of Object.entries(tails)) {
          const pe = node.streams.for(origin).part(p)
          if (t > pe.s) pe.s = t
        }
      }
    }
    this.round(node)
  }
  #trued = false

  #ensure(node: Node, p: string) {
    if (this.entries.has(p)) return
    //! a BOOT-RESTORED ORPHAN stays frozen even when the restored ring re-assigns it (finding 48):
    // its base froze BEFORE records it never received — the lawful re-entry is the latch, exactly as
    // for a live re-assignment. The boot record's orphanParts half carries the classification.
    const frozen = node.bootOrphans !== null && node.bootOrphans.has(p)
    const assigned = !frozen && node.writes.ring.holdsAny(node.uuid, p, node.replicas)
    this.entries.set(p, this.#entry(assigned ? SCOPE.held : SCOPE.orphan))
    this.n++
    if (!assigned) {
      const e = this.entries.get(p)!
      e.polls = 0
      e.nextStall = node.tune.stallAt
      e.tails = this.#tailsOf(node, p) // freeze capture (rescope runs after replay — lanes are full)
      node.journal.armed && node.journal.emit(JK.orphaned, p, node.epoch)
    }
  }

  //! forget — a peer was reborn: every mark its previous life attested is void.
  forget(uuid: string) {
    for (const e of this.entries.values()) this.#void(e, uuid)
  }

  //! #void — one peer's attestations for one partition are gone: its marks, its durable marks, its gapless bit.
  // Three callers: a rebirth (forget), a release the peer announced (HAVEQ `x`), a `none` answer (HAVEA `x: 1`).
  #void(e: ScopeEntry, uuid: string) { e.marks.delete(uuid); e.marksD.delete(uuid); e.gl.delete(uuid); this.evidence++ }

  //! #gapless — does this node's CONTENT for p reach its floor on every lane that holds p? (The `g` bit, DESIGN-
  // SCALE stage 2.) Through the per-partition index: each (lane, p) array is ascending, so its tail is its last
  // entry. Floors may lawfully trail content (a gapped record folds and waits for the chain); a floor never
  // exceeds content before stage 3's compaction. So: gapless iff tail === floor on every lane with entries of p.
  // O(lanes of p), once per announced partition per frame.
  #gapless(node: Node, p: string): boolean {
    const per = node.byPart!.get(p)
    if (per === undefined) return true // nothing held: nothing can be missing
    for (const [origin, arr] of per) {
      if (!arr.length) continue
      if (arr[arr.length - 1].seq !== (node.streams.get(origin)?.parts?.get(p)?.s ?? 0)) return false
    }
    return true
  }

  //! #durableFloors — this node's per-lane DURABLE floors for p (the HAVEQ `d` body / the HAVEA `md` echo).
  #durableFloors(node: Node, p: string): Record<string, number> {
    const md: Record<string, number> = {}
    for (const [origin, d] of node.streams) { const pd = d.parts?.get(p)?.d ?? 0; if (pd > 0) md[origin] = pd }
    return md
  }

  //! linkDown — a peer died: abort every latch it was teaching (window 6; the buffer drops whole).
  linkDown(node: Node, uuid: string) {
    for (const [p, e] of this.entries)
      if (e.state === SCOPE.acquiring && e.teacher === uuid) this.#abort(node, p, 'linkDown')
  }

  //! heldList — the boot record's data-authority (C10, split by the M6 review): held, plus acquiring
  // entries whose PRE-LATCH base is on disk (hadBase — the staged buffer itself never persists, so
  // restoring the base and re-latching is strictly better than dropping attested data on a mid-latch
  // crash). Orphans ride the SEPARATE orphanList (finding 48): merging them let a boot rescope
  // silently un-freeze a restored orphan into held when the ring re-assigned it — the exact
  // no-silent-unfreeze rule rescope enforces live.
  heldList(): string[] {
    const out: string[] = []
    for (const [p, e] of this.entries)
      //! sealed === false is excluded: the freshly-folded base is memory-only until the snapshot
      // echo — a boot record naming it would replay post-fold WAL appends onto a missing base
      if ((e.state === SCOPE.held && e.sealed !== false) ||
          (e.state === SCOPE.acquiring && e.preState === SCOPE.held)) out.push(p)
    return out
  }

  //! orphanList — the boot record's frozen half: restored orphans re-enter ONLY through the latch.
  orphanList(): string[] {
    const out: string[] = []
    for (const [p, e] of this.entries)
      if (e.state === SCOPE.orphan || (e.state === SCOPE.acquiring && e.preState === SCOPE.orphan)) out.push(p)
    return out
  }

  //! #link — the one link a HAVEQ to peer `uuid` may ride: admitted, alive and FLOWING. byUuid maps to the link ID
  // (the keeper rule) and is resolved here. A paused link is skipped like the heartbeat skips it (DESIGN-SCALE §3):
  // a control frame queued into a drop-oldest queue is doomed work, and the drain round re-announces on a flowing
  // link. Undefined ⇒ nothing is sent to that peer now.
  #link(node: Node, uuid: string): Link | undefined {
    const id = node.byUuid.get(uuid)
    const link = id === undefined ? undefined : node.links.get(id)
    return link !== undefined && link.state === LS.admitted && !link.dead && !link.paused ? link : undefined
  }

  //! myFloors — this node's per-lane possession floors for p (the HAVEQ q-body / the ACQDONE cut).
  #myFloors(node: Node, p: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [origin, d] of node.streams) {
      const s = d.parts?.get(p)?.s ?? 0
      if (s > 0) out[origin] = s
    }
    return out
  }

  //! announceFloors — what we ATTEST to peers: raw floors, except a durable just-folded base still
  // waiting for its snapshot echo announces NOTHING (findings 19/37/46 — an orphan shedding against
  // memory-only marks loses persisted-confirmed data when the learner crashes pre-echo). Compares
  // (behind-detection, teach cuts) keep reading the raw floors — the gate is on attestation only.
  #announceFloors(node: Node, p: string, e: ScopeEntry | undefined): Record<string, number> {
    if (node.durable && e?.sealed === false) return {}
    return this.#myFloors(node, p)
  }

  //! tailsOf — per-lane CONTENT tails for p (max seq actually present): the shed evidence. Captured
  // once at each orphan transition (orphan lanes are frozen — the gate drops, the stamp parks). Through
  // the per-partition index (DESIGN-SCALE stage 1): each (lane, p) array is ascending, so the tail is
  // its last entry — O(lanes), never a walk of every entry the node holds. Lanes are visited in
  // node.logs order, as before, so the record's key order is unchanged.
  #tailsOf(node: Node, p: string): Record<string, number> {
    const out: Record<string, number> = {}
    const per = node.byPart!.get(p)
    if (per === undefined) return out
    for (const origin of node.logs.keys()) {
      const arr = per.get(origin)
      if (arr !== undefined && arr.length) out[origin] = arr[arr.length - 1].seq
    }
    return out
  }

  //! dirty (DESIGN-SCALE stage 2, §3 "on change") — the partitions whose floors this node ADVANCED AT ITS STAMP SITE
  // since its last announcement: one Set.add per committed record on an armed owner (node.ts commit), nothing on the
  // inbound path. At the next tick every dirty partition goes to each co-holder in one batched HAVEQ per link, and
  // the ok answers carry the co-holders' floors back: marks converge in one round trip. Why the stamp site alone
  // (a deviation from §3's list, settled at the build — the record's own arithmetic in §3 and §8 counts (R−1)
  // announcement entries per write, which is the owner's): on a scoped cluster a holder's floor moves at an
  // inbound site only as the echo of the owner's stamp (the live fan-out, or that fan-out replayed from a latch
  // buffer), and the owner announces it; a fold, a seal, the arming truing and a boot each run their own round
  // right away; a durable echo is carried by the next sweep or answer (`d`/`md`). Announcing those again would
  // cost R(R−1) entries per write where (R−1) do the work. Cleared by a FULL round (every entry to every
  // co-holder covers it) and by the tick's own announcement; never by a targeted round.
  dirty = new Set<string>()

  //! round — one batched handshake round, FILTERED (DESIGN-SCALE stage 2): HAVEQ the peers who matter for the
  // partitions that matter — co-holders of held partitions (announce + probe), CURRENT holders of orphaned
  // partitions (the shed poll doubles as the teaching offer), the holders of a non-holder's probe partitions (a
  // pure probe, {}). `only` restricts the links (the admit round, the drain round: that one peer); `parts` the
  // partitions (the post-fold and sealed rounds: that one partition; the probe-driven round: the probe
  // partitions). Neither ⇒ the FULL round of an install. One frame per link per round; a paused link is skipped
  // (#link) and caught up by the drain round.
  round(node: Node, only?: ReadonlySet<Link>, parts?: ReadonlySet<string>) {
    if (!node.armed) return
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const plan = new Map<Link, Set<string>>()
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) continue // the latch is the active protocol for this partition
      if (parts !== undefined && !parts.has(p)) continue
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const link = this.#link(node, uuid)
        if (link === undefined || (only !== undefined && !only.has(link))) continue
        this.#plan(plan, link, p)
      }
    }
    //! the PROBE-driven leg (finding 38): partitions with open scoped confirms this node does NOT
    // hold — a non-holder issuer asks the partition's holders with empty floors (a pure probe,
    // never an attestation); their ok answers land in the probe's own ev map via feedScoped.
    const probeParts = new Set<string>()
    node.confirm.scopedParts(probeParts)
    for (const p of probeParts) {
      if (this.entries.has(p) || (parts !== undefined && !parts.has(p))) continue // a holder's entry already announces above
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const link = this.#link(node, uuid)
        if (link === undefined || (only !== undefined && !only.has(link))) continue
        this.#plan(plan, link, p)
      }
    }
    this.#ship(node, plan)
    if (only === undefined && parts === undefined) this.dirty.clear()
  }

  #plan(plan: Map<Link, Set<string>>, link: Link, p: string) {
    let ps = plan.get(link)
    if (ps === undefined) plan.set(link, ps = new Set())
    ps.add(p)
  }

  //! #ship — one HAVEQ per planned link: q = this node's attested floors per partition (computed ONCE per partition,
  // not per partition × link — finding 44; {} for a partition it has no entry for, a pure probe), plus the stage-2
  // keys where it attests: `d` (durable nodes), `g` (gapless). An acquiring entry is never planned; an unsealed
  // durable base announces {} and claims nothing.
  #ship(node: Node, plan: Map<Link, Set<string>>) {
    if (plan.size === 0) return
    const floors = new Map<string, Record<string, number>>()
    const durs = node.durable ? new Map<string, Record<string, number>>() : null
    const gap = new Map<string, boolean>()
    for (const [link, ps] of plan) {
      const q: Record<string, Record<string, number>> = {}
      let d: Record<string, Record<string, number>> | undefined
      let g: string[] | undefined
      for (const p of ps) {
        const e = this.entries.get(p)
        let f = floors.get(p)
        if (f === undefined) floors.set(p, f = this.#announceFloors(node, p, e))
        q[p] = f
        if (e === undefined || e.state === SCOPE.acquiring || (node.durable && e.sealed === false)) continue // no attestation
        if (durs !== null) {
          let dd = durs.get(p)
          if (dd === undefined) durs.set(p, dd = this.#durableFloors(node, p))
          ;(d ??= {})[p] = dd
        }
        let gl = gap.get(p)
        if (gl === undefined) gap.set(p, gl = this.#gapless(node, p))
        if (gl) (g ??= []).push(p)
      }
      const body: { e: number; q: typeof q; d?: typeof d; g?: string[] } = { e: node.epoch, q }
      if (d !== undefined) body.d = d
      if (g !== undefined) body.g = g
      link.ship(encodeControl(VERB.HAVEQ, body), node.env.sink, node.journal)
      link.flush(node.env.sink, node.journal)
    }
  }

  //! onHaveQ — a peer announced its floors for partitions we co-own (or it is shedding). Their
  // declared floors ARE possession attestations (feed marks), then answer HAVEA per partition:
  // ok=1 (+ echoed floors m) when we cover; need=1 (+ our marks) latches THEM as our teacher when
  // we are behind or absent-and-assigned; busy (ok:0, need:0) while our own latch is open.
  //! The three optional top-level keys (DESIGN-SCALE stage 2, §3; no MAGIC bump under V4-14): `d` {p: {o: durable
  // floor}} from a durable asker feeds marksD; `g` [p…] names the partitions the asker is gapless for (a last-value
  // bit per peer: an attestation without it clears the bit); `x` [p…] names the partitions the asker has RELEASED
  // (sent by #shed) — every mark it ever attested for them is void here. Per partition the answer gains `g: 1` on
  // an ok we are gapless for, and `x: 1` ("none": we neither hold nor are assigned p) where the old code was silent,
  // so a stale pin at the asker clears the next time it asks us about p.
  onHaveQ(node: Node, link: Link, v: { e?: number; q?: Record<string, Record<string, number>>; d?: Record<string, Record<string, number>>; g?: string[]; x?: string[] }) {
    const j = node.journal
    if (v.e !== node.epoch || typeof v.q !== 'object' || v.q === null) {
      j.armed && j.emit(JK.frameDrop, link.id, 'haveq epoch skew')
      return
    }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    if (Array.isArray(v.x)) for (const p of v.x) { const e = typeof p === 'string' ? this.entries.get(p) : undefined; if (e) this.#void(e, link.uuid) }
    const gset = Array.isArray(v.g) ? new Set(v.g) : null
    const dmap = typeof v.d === 'object' && v.d !== null ? v.d : null
    const a: Record<string, Answer> = {}
    let rose = false // a mark or durable mark rose: the compaction frontier may have moved (the memo's evidence)
    for (const [p, asked] of Object.entries(v.q)) {
      const e = this.entries.get(p)
      //! feed marks: the asker possesses what it declares (frozen or live, floors are sound claims)
      if (e) {
        let per = e.marks.get(link.uuid)
        if (!per) { per = new Map(); e.marks.set(link.uuid, per) }
        let attested = false
        for (const [o, s] of Object.entries(asked)) if (typeof s === 'number') { attested = true; if (s > (per.get(o) ?? 0)) { per.set(o, s); rose = true } }
        const dd = dmap?.[p]
        if (typeof dd === 'object' && dd !== null) {
          let perD = e.marksD.get(link.uuid)
          if (!perD) { perD = new Map(); e.marksD.set(link.uuid, perD); rose = true }
          for (const [o, s] of Object.entries(dd)) if (typeof s === 'number' && s > (perD.get(o) ?? 0)) { perD.set(o, s); rose = true }
        }
        //! the gapless bit is last-value, judged only on an attestation (a pure probe `{}` says nothing about content)
        if (attested) { if (gset?.has(p)) e.gl.add(link.uuid); else e.gl.delete(link.uuid) }
      }
      if (e === undefined) {
        if (ring.holdsAny(node.uuid, p, node.replicas)) {
          //! absent + assigned: acquire from the announcer — the from-zero latch (empty marks)
          this.#latch(node, p, link.uuid)
          a[p] = { ok: 0, need: 1, m: {} }
        } else a[p] = { ok: 0, need: 0, x: 1 } // none: not ours, not assigned — the asker's pin on us for p is stale
        continue
      }
      if (e.state === SCOPE.acquiring) { a[p] = { ok: 0, need: 0 }; continue } // busy: one teacher per attempt
      const mine = this.#myFloors(node, p)
      let behind = false
      for (const [o, s] of Object.entries(asked)) if (typeof s === 'number' && s > (mine[o] ?? 0)) { behind = true; break }
      //! behind + assigned ⇒ latch the announcer (held-found-lagging AND the orphan re-entry — H2's
      // A-leg goes orphan → acquiring here, delta above the frozen floors, never straight to held).
      // A RE-ASSIGNED ORPHAN latches even at EQUAL floors (M6-review finding 26): with no writes in
      // the interval, behind never fires and the orphan would sit assigned-but-frozen forever — the
      // empty-delta latch (teach ships nothing, ACQDONE attests the cut) is the lawful un-freeze.
      if ((behind || e.state === SCOPE.orphan) && ring.holdsAny(node.uuid, p, node.replicas)) {
        this.#latch(node, p, link.uuid)
        a[p] = { ok: 0, need: 1, m: mine }
        continue
      }
      //! we cover (or we are a frozen orphan answering the shed poll of ANOTHER orphan — still a
      // sound claim; the shed predicate ranges over CURRENT holders regardless of who answers).
      // The ANSWERED floors go through the attestation gate (a sealed-pending base announces {}).
      const ans: Answer = behind ? { ok: 0, need: 0 } : { ok: 1, need: 0, m: this.#announceFloors(node, p, e) }
      if (!behind && !(node.durable && e.sealed === false)) {
        if (node.durable) ans.md = this.#durableFloors(node, p)
        if (this.#gapless(node, p)) ans.g = 1
      }
      a[p] = ans
    }
    if (rose) this.evidence++
    if (Object.keys(a).length) {
      link.ship(encodeControl(VERB.HAVEA, { e: node.epoch, a }), node.env.sink, j)
      link.flush(node.env.sink, j)
    }
    this.evaluateSheds(node)
  }

  //! onHaveA — answers to our HAVEQ round (or an unprompted teach-me request). ok answers feed marks
  // (the answerer's echoed floors are its self-attested possession claim); need answers make US the
  // teacher — ship the one-teacher delta.
  onHaveA(node: Node, link: Link, v: { e?: number; a?: Record<string, { ok?: number; need?: number; m?: Record<string, number>; md?: Record<string, number>; g?: number; x?: number }> }) {
    const j = node.journal
    if (v.e !== node.epoch || typeof v.a !== 'object' || v.a === null) {
      j.armed && j.emit(JK.frameDrop, link.id, 'havea epoch skew')
      return
    }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    let rose = false // a mark or durable mark rose: the compaction frontier may have moved (the memo's evidence)
    for (const [p, ans] of Object.entries(v.a)) {
      const e = this.entries.get(p)
      //! `x: 1` — none: the answerer neither holds nor is assigned p; whatever it attested for p here is a stale pin
      if (ans.x === 1) { if (e) this.#void(e, link.uuid); continue }
      if (ans.need === 1) { this.#teach(node, link, p, ans.m ?? {}); continue }
      if (ans.ok === 1 && e) {
        let per = e.marks.get(link.uuid)
        if (!per) { per = new Map(); e.marks.set(link.uuid, per) }
        for (const [o, s] of Object.entries(ans.m ?? {})) if (typeof s === 'number' && s > (per.get(o) ?? 0)) { per.set(o, s); rose = true }
        if (ans.md) {
          let perD = e.marksD.get(link.uuid)
          if (!perD) { perD = new Map(); e.marksD.set(link.uuid, perD); rose = true }
          for (const [o, s] of Object.entries(ans.md)) if (typeof s === 'number' && s > (perD.get(o) ?? 0)) { perD.set(o, s); rose = true }
        }
        if (ans.g === 1) e.gl.add(link.uuid); else e.gl.delete(link.uuid)
        //! the ASKER-BEHIND leg: the answerer's echoed floors exceed ours on a partition that is OURS
        // to hold (held-found-lagging, or the orphan re-entry) — the behind party always requests:
        // latch them and send the unprompted need (one extra round-trip, no new verbs, symmetric).
        // A RE-ASSIGNED ORPHAN latches even at equal floors (finding 26 — the empty-delta un-freeze).
        if (e.state !== SCOPE.acquiring && ring.holdsAny(node.uuid, p, node.replicas)) {
          const mine = this.#myFloors(node, p)
          let behind = false
          for (const [o, s] of Object.entries(ans.m ?? {})) if (typeof s === 'number' && s > (mine[o] ?? 0)) { behind = true; break }
          if (behind || e.state === SCOPE.orphan) {
            this.#latch(node, p, link.uuid)
            link.ship(encodeControl(VERB.HAVEA, { e: node.epoch, a: { [p]: { ok: 0, need: 1, m: mine } } }), node.env.sink, j)
            link.flush(node.env.sink, j)
          }
        }
      } else if (ans.ok === 1 && e === undefined) {
        if (ring.holdsAny(node.uuid, p, node.replicas)) {
          //! ENTRY-LESS ok answer on an assigned partition (a probe-driven HAVEQ answered before any
          // record arrived): the answerer possesses a base we lack entirely — the from-zero latch,
          // same shape as onHaveQ's absent-and-assigned leg.
          this.#latch(node, p, link.uuid)
          link.ship(encodeControl(VERB.HAVEA, { e: node.epoch, a: { [p]: { ok: 0, need: 1, m: {} } } }), node.env.sink, j)
          link.flush(node.env.sink, j)
        } else {
          //! entry-less and UNASSIGNED: this was the NON-holder issuer's confirm probe (finding
          // 38) — the holder's attested floors feed the probe's own evidence map.
          node.confirm.feedScoped(node, link.uuid, p, ans.m, ans.md)
        }
      }
    }
    if (rose) this.evidence++
    node.confirm.recount(node) // attested marks are scoped confirm evidence
    this.evaluateSheds(node)
  }

  //! #latch — open the one-teacher latch for p (from-zero, orphan re-entry, or held-found-lagging).
  // hadBase records whether a PRE-LATCH base exists (held/orphan → acquiring): that base is on-disk,
  // attested data a mid-latch boot record must keep foldable (M6-review: C10's "unfolded base is not
  // restorable" is true of the STAGED buffer only — the pre-latch base restores fine and re-latches).
  #latch(node: Node, p: string, teacher: string) {
    const prev = this.entries.get(p)
    const e = prev ?? this.#entry(SCOPE.acquiring)
    if (!prev) this.entries.set(p, e)
    //! an UNSEALED held base (memory-only, pre-echo) re-latching classifies as from-zero: the boot
    // record must not name a base no disk restores (the dirty ledger already covers its rows)
    if (prev !== undefined && prev.state !== SCOPE.acquiring)
      e.preState = prev.state === SCOPE.held && prev.sealed === false ? undefined : prev.state
    else if (prev === undefined) e.preState = undefined
    e.sealed = undefined
    e.state = SCOPE.acquiring
    e.teacher = teacher
    e.buf = []
    e.teachN = 0
    e.liveN = 0
    e.ticks = 0
    this.n++
    node.journal.armed && node.journal.emit(JK.acquireStart, p, teacher)
  }

  //! #teach — the teacher side: walk every lane in seq order shipping (·,p) entries above the
  // learner's marks as ACQ runs, then ACQDONE {p, e, t: cut, n}. The cut is OUR possession floor
  // captured at walk time — authoritative even where compaction made the last surviving entry's seq
  // trail the floor (the effect below the floor is materialized in the shipped winners).
  #teach(node: Node, link: Link, p: string, marks: Record<string, number>) {
    const j = node.journal
    const e = this.entries.get(p)
    //! A node teaches WHATEVER IT HOLDS of p — a held base, an orphan's frozen content, or the PRE-LATCH base of an
    // entry that is itself acquiring — with its current floors as the cut: floors never regress inside a life and a
    // latch stages new records outside the lanes, so the cut is a sound claim whatever the latch state. Until
    // DESIGN-SCALE stage 2 an acquiring node refused ("mid-latch ourselves"), and with no member digest to ship lane
    // suffixes that left one repair path a deadlock: two holders each ahead on a DIFFERENT lane of p (A2's demoted
    // owner and the joiner that re-committed its attempt; any owner change) each find themselves behind the other's
    // announcement, latch each other, neither teaches, both time out to orphan on their residue and re-latch — for
    // ever (A2 seed 9 at FERO_SCOPED_SEEDS=12, found by the sweep when the digest retired). Now both teach, both
    // fold, both hold both lanes. Only an absent entry has nothing to teach.
    if (!e) return
    let n = 0
    //! through the per-partition index (DESIGN-SCALE stage 1): only the lanes that hold p, only its
    // entries — the ship is O(entries of p), not O(entries of the node). Lane order is node.logs order,
    // as before, so the frames leave in the same order they always did.
    //! THE TEACHER SHIPS EXACTLY WHAT COMPACTION KEEPS (DESIGN-SCALE stage 3, §4): above the learner's marks, each
    // entry passes the one keep() predicate of kernel/log.ts — the lane's last entry, anything above this node's
    // frontier for (lane, p), or its cell's winner — so the learner's fold equals this node's state whether or not a
    // pass has run here yet. The learner is a current holder that attests nothing while it acquires, so in stage 3
    // the frontier it pins at 0 makes keep() pass everything above its marks (what a teach always shipped); the
    // filter bites in stage 4, when a released cell's entry is no winner and must reach nobody.
    const per = node.byPart!.get(p)
    const logs = node.logs
    for (const [origin, lane] of logs) {
      const entries = per?.get(origin)
      if (entries === undefined) continue
      const above = marks[origin] ?? 0
      let lo = 0, hi = entries.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].seq <= above) lo = mid + 1; else hi = mid }
      if (lo === entries.length) continue
      const f = scopedFrontier(node, origin, p)
      const tail = lane[lane.length - 1]
      const runs: { rec: Rec; origin: string; seq: number; epoch: number; iss?: string; cid?: number; pp?: number }[] = []
      for (let i = lo; i < entries.length; i++) {
        const x = entries[i]
        if (!keep(node, origin, x, f, x === tail)) continue
        runs.push({ rec: x.rec, origin, seq: x.seq, epoch: x.epoch, iss: x.iss, cid: x.cid, pp: x.pp })
      }
      if (!runs.length) continue
      //! stored pp rides the teach (the floor law): the learner's post-fold lane re-ships to OTHERS
      // with intact chain evidence. The fold itself trusts the CUT, not the chain. Cut at this node's frame cap
      // (V4-51): ACQDONE's n counts records, so cut frames change nothing at the learner, and a clear mid-teach still
      // aborts its latch ('torn') and the partition is offered again.
      for (const bytes of encodeRuns(runs, VERB.ACQ, true, node.tune.frame)) link.ship(bytes, node.env.sink, j)
      n += runs.length
    }
    const cut = this.#myFloors(node, p)
    //! `w` (DESIGN-SCALE stage 3, §4 "the dedup window"): this node's dedup-window entries for p, as [issuer, cid, seq,
    // epoch, lane] tuples, so a from-zero learner dedups a retry whose original commit compaction dropped here (a
    // loser that carried an attempt identity feeds no window once it is gone from the lane): after an owner move the
    // new owner dup-acks the issuer's retry with the ORIGINAL coordinates instead of re-committing an old value on
    // top of a newer one (A9). The lane rides along (the stage-1 review's K1: a dup WACK must name it). Bounded by
    // the window (dedupKeep × issuers); omitted when the window holds nothing of p.
    const w = node.writes.windowOf(p)
    const done: { p: string; e: number; t: Record<string, number>; n: number; w?: (string | number)[][] } = { p, e: node.epoch, t: cut, n }
    if (w.length) done.w = w
    link.ship(encodeControl(VERB.ACQDONE, done), node.env.sink, j)
    link.flush(node.env.sink, j)
    j.armed && j.emit(JK.teachShip, p, n)
  }

  //! onAcq — teacher transfer records stage into the latch; anything else is a foreign ACQ (a
  // previous aborted attempt's stragglers, a second teacher) — dropped, journaled, monitored.
  onAcq(node: Node, link: Link, f: { prov(): { origin: string; baseSeq: number; epoch: number; issuer?: string; baseCid?: number } | null; records(): Iterable<{ origin: string; seq: number; epoch: number; issuer: string; cid: number; pp?: number; rec(): Rec }> }) {
    const j = node.journal
    for (const rv of f.records()) {
      const rec = rv.rec()
      const p = partitionOf(rec)
      const e = this.entries.get(p)
      if (!e || e.state !== SCOPE.acquiring || e.teacher !== link.uuid) {
        j.armed && j.emit(JK.stageDrop, p, rv.seq)
        continue
      }
      e.buf!.push({ origin: rv.origin, seq: rv.seq, epoch: rv.epoch, rec, iss: rv.issuer || undefined, cid: rv.issuer ? rv.cid : undefined, live: false, pp: rv.pp })
      e.teachN!++
    }
  }

  //! onAcqDone — THE ATOMIC FOLD (one synchronous step; window 6/7-safe because until here nothing
  // touched lanes, state, versions, floors, or the WAL):
  //   verify the staged teacher count = n (a torn ship aborts whole);
  //   splice every teacher record through the one LWW election;
  //   floors := the teacher's attested cut (never staged-max — only the cut was attested);
  //   discard staged live ≤ cut (the completeness floor: their effect is in the fold or was
  //   lawfully compacted by the teacher); replay the rest through the normal ingest;
  //   then held (durable: after the snapshot swap's echo — never attest what disk can't restore)
  //   and the post-fold round announces possession + trues the floor up.
  onAcqDone(node: Node, link: Link, v: { p?: string; e?: number; t?: Record<string, number>; n?: number; w?: unknown }) {
    const j = node.journal
    const p = v.p
    if (typeof p !== 'string') return
    const e = this.entries.get(p)
    if (!e || e.state !== SCOPE.acquiring || e.teacher !== link.uuid || v.e !== node.epoch) {
      j.armed && j.emit(JK.stageDrop, p ?? '', -1)
      return
    }
    const teach = e.buf!.filter((s) => !s.live)
    if (teach.length !== (v.n ?? 0)) { this.#abort(node, p, 'torn'); return }
    const cut = v.t ?? {}
    //! THE SPOKE FORWARD (wave 6a, 2026-10-12; its review the same day). THE RULE: a synced client link holds the
    // whole of every partition this node FEEDS it (`feeds`, above). The fold adds records to p, so the fold forwards:
    //   p was fed through the latch (acquiring from a held base or from nothing: preState is not orphan) — every
    //     synced spoke already holds p's pre-fold content (the digest answer shipped it, node.ts #answer; the tap and
    //     the owner's own commits fed it), so each gets the records this fold ADDS, in the loop below, exactly as the
    //     live tap gives a spoke a fresh inbound record (write.ts inbound): the record, its lane coordinates and its
    //     attempt identity (the spoke's write-route join reads it; V4-7's order holds — the value shows, then the
    //     write settles), no pp (a spoke attests nothing). An UNSYNCED link is not fed (the live tap does not feed it
    //     either): the answer that syncs it covers p, and node.indexInsert lowers a stopped or queued answer's cover
    //     under each insert made here.
    //   p RE-ENTERS from an orphan (preState orphan): its frozen copy was no spoke's to have, so a spoke synced since
    //     the freeze has nothing of p, and one synced before it holds the frozen rows. Every synced spoke gets the
    //     WHOLE of p after the loop (#forwardWhole), base and delta, in lane order; the spoke's dual fence (write.ts
    //     #splice, the client leg) takes a record below its lane tail and drops one it already holds, so a record sent
    //     twice costs a frame, never a row. An unsynced link with a stopped or queued answer, or a clear's ceiling
    //     (Link.torn / Link.inQueue; node.ts #answer, #clearCover), may hold a cover above p's rows on a lane that
    //     answer walked while p was frozen: the cover is lowered to just under p's lowest entry on each lane of p, so
    //     the answer that resumes from it ships p whole. A link with no cover has had no answer since its admit; its
    //     first answer ships p, held by then.
    // The review's probes (2026-10-12): with held() as the answer's filter and the delta alone forwarded, a spoke that
    // synced mid-latch missed the base for good, showed an OVERWRITTEN value as current (the delta it got was older
    // than a base record it never got), and at a resync ending across the fold lost the base rows it held and saw them
    // return. Before wave 6a a feeder folded here through node.apply alone and its spokes never heard: a spoke's floor
    // exchange ships only what is above its own tail on each lane, so once a later record on the lane had been tapped
    // live, the rows the latch brought never came while that feeder lived (STATUS, two sightings: a lost
    // owner-to-holder frame repaired through the latch; an acquire in a hand-off).
    const taps = node.clientLinks.size !== 0
    const reentry = e.preState === SCOPE.orphan
    //! THE FOLD GROUP (wave 6c, 2026-10-21): the forward below leaves in lane order, one frame per contiguous run, and
    // before this each frame landed at the spoke in its own event — an older value of a row and its later remove on
    // one lane in separate events, the row showing between them (STATUS; A12 seed 4). Now FEED {b: p} goes before the
    // forward and FEED {e: p} after it on every synced client link (the forward's links), and the spoke buffers the
    // frames between them until the end: a partition's history lands as ONE apply (node.ts `group`). The flush before
    // {b} ships whatever an earlier handler of this step left in the outbox, so the group holds the fold's frames alone.
    if (taps)
      for (const cl of node.clientLinks)
        if (cl.state === LS.admitted && cl.synced && !cl.dead) { cl.flush(node.env.sink, j); cl.ship(encodeControl(VERB.FEED, { b: p }), node.env.sink, j) }
    //! THE LANE RULE (wave 6b, 2026-10-12): a lane holds each (origin, seq) ONCE, so the scalar fence (streams.applied)
    // never sits below the lane's tail. The fast path appends at the tail on `seq > applied` alone (write.ts inbound), and
    // the teacher ships every entry of p it holds with its OWN floor as the cut — an entry above its floor (a gapped
    // chain there) arrives above the cut. With the fence raised only to the cut, the same record staged live during the
    // latch was appended again by the replay below ([3, 5, 7, 7] in the wave-6a review's probe; the forward shipped it
    // twice), a later re-ship of it a third time, and a record between the cut and it landed out of order. So the fence
    // rises to the top of what the teacher shipped on each lane (`top`); everything at or under it takes the dual fence
    // (#splice: present ⇒ dropped, absent ⇒ spliced at its seq, forwarded once). The FLOOR stays at the cut: the fold
    // attests what the teacher attested, never the chain (the floor law), and the next announce trues it up.
    const top = new Map<string, number>()
    //! fold the teacher records: insert into lanes at seq position through the LWW election. The
    // teacher walked each lane ascending, so per-lane order is preserved by construction.
    for (const s of teach) {
      if (s.seq > (top.get(s.origin) ?? 0)) top.set(s.origin, s.seq)
      const lane = node.logFor(s.origin)
      let lo = 0, hi = lane.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (lane[mid].seq < s.seq) lo = mid + 1; else hi = mid }
      if (lo < lane.length && lane[lo].seq === s.seq) continue // already present (an orphan re-entry overlap)
      //! the staged pp folds into the lane entry: later AE re-ships from THIS node keep the chain
      const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number; pp?: number } = { rec: s.rec, seq: s.seq, epoch: s.epoch }
      if (s.iss) { entry.iss = s.iss; entry.cid = s.cid }
      if (s.pp !== undefined && s.pp >= 0) entry.pp = s.pp
      lane.splice(lo, 0, entry)
      node.indexInsert(s.origin, entry)
      node.apply(s.rec, s.origin, s.seq, s.epoch, s.iss, s.cid)
      if (s.iss) node.writes.remember(node, s.iss, s.cid!, s.seq, s.epoch, s.origin, p) // the lane too: a dup WACK from here must name it
      if (taps && !reentry)
        for (const cl of node.clientLinks)
          if (cl.state === LS.admitted && cl.synced && !cl.dead)
            cl.add(s.rec, { origin: s.origin, baseSeq: s.seq, epoch: s.epoch }, s.iss ? { issuer: s.iss, baseCid: s.cid! } : undefined)
    }
    if (taps && reentry) this.#forwardWhole(node, p)
    //! the teacher's dedup-window tuples for p (`w`, see #teach): a retry whose original commit compaction dropped at
    // the teacher is still dedup'd here, with its original coordinates and lane
    if (Array.isArray(v.w))
      for (const t of v.w)
        if (Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'number' && typeof t[2] === 'number' && typeof t[3] === 'number')
          node.writes.remember(node, t[0], t[1], t[2], t[3], typeof t[4] === 'string' && t[4] !== '' ? t[4] : undefined, p)
    this.evidence++ // a fold: the partition is held now and its floors moved (the compaction memo re-reads)
    //! floors advance to the CUT (the teacher's attestation), never past it on the teacher's word; the scalar fence
    // merges up to the cut so replayed-live below the cut dedups, then to the lane's tail (the lane rule, below)
    for (const [o, c] of Object.entries(cut)) {
      if (typeof c !== 'number') continue
      const d = node.streams.for(o)
      const pe = d.part(p)
      if (c > pe.s) pe.s = c
      if (c > d.applied) d.applied = c
      if (c > d.shippable) d.shippable = c
    }
    //! the fence to the lane's tail (the lane rule above): the fast path below must never append what the fold holds
    for (const [o, t] of top) { const d = node.streams.for(o); if (t > d.applied) d.applied = t }
    const live = e.buf!.filter((s) => s.live)
    e.state = SCOPE.held
    this.n++
    e.teacher = undefined
    e.buf = undefined
    e.teachN = undefined
    e.liveN = undefined
    e.preState = undefined
    e.ticks = undefined
    e.tails = undefined
    //! DURABLE echo gate (findings 19/37/46, C8): the base is memory-only until the snapshot swap's
    // persisted echo — the entry is held (folds live, serves reads) but ATTESTS NOTHING (announce
    // gate) and stays out of the boot record's held list until node's snap-echo calls sealed().
    // An orphan polling this learner cannot count its marks, so persisted-confirmed data can never
    // be shed against evidence one crash erases. Memory nodes attest immediately (their crash is a
    // rebirth; marks void at forget — the §6.5 durable-marks refinement stays deferred).
    if (node.durable) e.sealed = false
    j.armed && j.emit(JK.acquire, p, teach.length, link.uuid)
    //! replay the staged live span through the NORMAL ingest law (held now): ≤ cut discards as
    // covered; above-cut folds/splices, feeds dedup windows, and forwards to spokes — pp intact; a record the fold
    // already holds (a teacher entry above the cut) is under the fence now and drops as present (the lane rule)
    for (const s of live) {
      if (s.seq <= (cut[s.origin] ?? 0)) continue
      node.writes.inbound(node, s.origin, s.seq, s.epoch, { rec: () => s.rec, issuer: s.iss ?? '', cid: s.cid ?? 0, pp: s.pp })
    }
    //! one flush per fold on each client link, as the RECORDS handler flushes once per frame: the forwarded teacher
    // records and the replayed live span (inbound added them to the same outbox; before wave 6a nothing flushed them
    // here, so they left with the feeder's next frame or commit) leave in this step
    if (taps)
      for (const cl of node.clientLinks) {
        cl.flush(node.env.sink, j)
        if (cl.state === LS.admitted && cl.synced && !cl.dead) cl.ship(encodeControl(VERB.FEED, { e: p }), node.env.sink, j) // the group's end (a clear in the flush unsynced the link: no end, the drain digest closes the group)
      }
    //! durable: the base entered memory only — arm the snapshot swap so it reaches disk atomically
    // (never persistRun: interior rows condemn the chain), and dirty until the echo
    if (node.durable) node.spliced(p)
    node.persistBoot()
    this.round(node, undefined, new Set([p])) // the post-fold round, to p's holders only: announce possession (sealed-gated), true the floor up, seed confirm
    node.confirm.recount(node)
  }

  //! #forwardWhole — the fold's re-entry leg (onAcqDone, the rule above it): every client link gets the whole of p.
  // Synced: every lane entry of p through the per-partition index, in node.logs order and ascending per lane (the
  // order the live tap would have given them), attempt identity intact, no pp. Unsynced with a stopped or queued
  // answer or a clear's ceiling: its cover is lowered to just under p's lowest entry on each lane of p, so the answer
  // that resumes from it ships p whole (node.ts #answer; the DIGEST handler for a ceiling). O(entries of p) per
  // synced link, O(lanes of p) per covered link; only at a re-entry from an orphan with a client link up.
  #forwardWhole(node: Node, p: string) {
    const per = node.byPart!.get(p)
    if (per === undefined) return
    for (const cl of node.clientLinks) {
      if (cl.state !== LS.admitted || cl.dead) continue
      if (cl.synced) {
        for (const origin of node.logs.keys()) {
          const arr = per.get(origin)
          if (arr === undefined) continue
          for (const x of arr) cl.add(x.rec, { origin, baseSeq: x.seq, epoch: x.epoch }, x.iss ? { issuer: x.iss, baseCid: x.cid! } : undefined)
        }
      } else if (cl.torn !== null || cl.inQueue !== null) {
        for (const [origin, arr] of per) {
          if (!arr.length) continue
          const under = arr[0].seq - 1
          if (cl.torn !== null && (cl.torn.d[origin] ?? 0) > under) cl.torn.d[origin] = under
          if (cl.inQueue !== null && (cl.inQueue.d[origin] ?? 0) > under) cl.inQueue.d[origin] = under
        }
      }
    }
  }

  //! sealed — the snapshot echo's callback (node.ts 'persisted', the dirty-clear leg): the acquired
  // base is now disk-restorable — attest it (the deferred post-fold announce) and re-enter the boot
  // record's held list.
  sealed(node: Node, p: string) {
    const e = this.entries.get(p)
    if (!e || e.sealed !== false) return
    e.sealed = true
    this.evidence++ // a sealed base may compact now (C1)
    if (node.durable) node.persistBoot()
    this.round(node, undefined, new Set([p])) // the sealed round, to p's holders only (DESIGN-SCALE stage 2)
    node.confirm.recount(node)
  }

  //! #abort — drop the latch whole. With log residue (an acquiring OWNER committed own-lane records
  // mid-transfer — the H2 corner) the entry becomes an orphan (possession ⇒ retention obligation ⇒
  // freeze + poll + shed); clean latches drop to `out` (re-offered by the next round).
  #abort(node: Node, p: string, reason: string) {
    const e = this.entries.get(p)
    if (!e || e.state !== SCOPE.acquiring) return
    node.journal.armed && node.journal.emit(JK.acquireAbort, p, reason)
    const residue = node.byPart!.has(p) // the index holds p iff some lane holds an entry of p
    this.n++
    if (residue) {
      e.state = SCOPE.orphan
      e.teacher = undefined
      e.buf = undefined
      e.teachN = undefined
      e.liveN = undefined
      e.ticks = undefined
      e.polls = 0
      e.nextStall = node.tune.stallAt
      e.tails = this.#tailsOf(node, p) // freeze capture — the residue IS the retained content
      node.journal.armed && node.journal.emit(JK.orphaned, p, node.epoch)
    } else {
      this.entries.delete(p)
    }
    //! either leg changes the boot record's lists (an abort-to-orphan joins orphanParts; a clean
    // drop leaves both) — persist so a crash in the window classifies correctly (finding 31's class)
    if (node.durable) node.persistBoot()
    //! no write settlement here (write.ts rescoped): a clean drop keeps the duty and the next latch brings
    // the record; an abort to orphan only befalls an acquiring OWNER (the residue is its own commits), whose
    // attempts never wait on a WACK. The install's rescope above is the one place the scope leaves a writer.
  }

  //! evaluateSheds — THE STATELESS SHED DECISION (C3, D1's graft), re-based onto CONTENT TAILS by
  // the M6 review (findings 12/21 + the pp-law panel's fatal hole): for each orphaned p, shed iff
  // for every member of holdersOf(p) at the CURRENT ring, for every lane where my frozen tail > 0,
  // the holder's attested mark covers that TAIL. Floors are claims; tails are what is actually
  // held — and under the pp law floors lawfully under-claim (epoch-0 data, bootDirty restores,
  // gap-folded records), so a floor-based bar either shed real data with zero evidence (the empty-
  // floors husk drop) or wedged forever. The husk test is likewise content-based: an orphan with NO
  // (·,p) entries anywhere holds nothing and drops immediately. Nothing is stored between
  // evaluations — an R-set change re-ranges the quantifier by construction (tails are frozen).
  evaluateSheds(node: Node) {
    if (!node.armed) return
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    let released: Map<Link, string[]> | null = null
    let gone: string[] | null = null // the partitions shed in this evaluation: the spokes' word (FEED {x}), one frame per client link
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const tails = e.tails ??= this.#tailsOf(node, p) // captured at the freeze; rebuilt here only for legacy entries
      const lanes = Object.entries(tails)
      let covered = true
      if (lanes.length) // no content anywhere: a true husk sheds at once
        for (const holder of ring.holders(p, node.replicas)) {
          if (holder === node.uuid) { covered = false; break } // still assigned?! never shed our own duty
          //! on CRASH-STABLE marks (DESIGN-SCALE stage 3, §4): a durable holder counts at its durable floors — what
          // its disk restores — never at the volatile ones a crash before the fsync would take with it
          if (!covers(this.stableMarks(node, e, holder), lanes)) { covered = false; break }
        }
      if (!covered) continue
      //! the release rides to p's CURRENT holders as HAVEQ `x` (DESIGN-SCALE stage 2): the marks this orphan's
      // polls fed there are void from here. Gathered per link across the loop, one frame per link after it.
      for (const uuid of ring.holders(p, node.replicas)) {
        const link = this.#link(node, uuid)
        if (link === undefined) continue
        released ??= new Map()
        let xs = released.get(link)
        if (!xs) released.set(link, xs = [])
        xs.push(p)
      }
      (gone ??= []).push(p)
      this.#shed(node, p, e)
    }
    if (released !== null)
      for (const [link, x] of released) {
        link.ship(encodeControl(VERB.HAVEQ, { e: node.epoch, q: {}, x }), node.env.sink, node.journal)
        link.flush(node.env.sink, node.journal)
      }
    //! THE SHED'S WORD TO THE SPOKES (wave 6c, 2026-10-21): a spoke is a view of its feeder's held subset, and until now
    // nothing told it that a partition LEFT — its rows of p stayed on the screen, frozen (the orphan gate-dropped every
    // new record of p, so none reached the spoke), until a failover's resync wiped them (STATUS; M12's other direction,
    // spokeStale, counted 6, 5, 1, 2 and 1 such rows on A12 seeds 3, 5, 6, 8 and 11). One FEED {x} per client link
    // names every partition this evaluation shed; the spoke drops each with its feeder (node.ts #unfeed). Every
    // admitted client link gets it, synced or not: a spoke whose answer is still torn held p's rows from before.
    if (gone !== null && node.clientLinks.size)
      for (const cl of node.clientLinks)
        if (cl.state === LS.admitted && !cl.dead) cl.ship(encodeControl(VERB.FEED, { x: gone }), node.env.sink, node.journal)
    //! a DRAINING leaver (membership.ts, DESIGN-SCALE stage 1 (b)) re-reads its bar the instant marks moved or a
    // shed landed — one field read on every other armed node
    if (node.membership.leaving?.drain !== undefined) node.membership.drain(node)
  }

  //! undrained — the leave drain's evidence (DESIGN-SCALE §7 stage 1 (b)): what this node still holds that no
  // survivor has proved it holds. For every entry with content — an orphan's frozen tails; a held entry's live
  // tails (the solo view's case: no install ever froze them) — over the CURRENT holders other than this node:
  // `waiting` counts the partitions some REACHABLE holder (an admitted, live link) has not yet attested covering,
  // lane by lane — the shed bar of evaluateSheds with its quantifier narrowed to the holders that can still
  // answer, so the drain can still progress; `stranded` the partitions with content and no reachable holder at
  // all — nobody to drain to. A partition every holder covers has shed already and is in neither count.
  undrained(node: Node): { waiting: number; stranded: number } {
    let waiting = 0, stranded = 0
    if (!node.armed) return { waiting, stranded }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) continue // a staged buffer is the teacher's data, not this node's
      const tails = e.state === SCOPE.orphan ? (e.tails ??= this.#tailsOf(node, p)) : this.#tailsOf(node, p)
      const lanes = Object.entries(tails)
      if (!lanes.length) continue // a husk: nothing to hand over
      let reachable = false, behind = false
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder === node.uuid) continue
        const id = node.byUuid.get(holder)
        const link = id === undefined ? undefined : node.links.get(id)
        if (!link || link.state !== LS.admitted || link.dead) continue
        reachable = true
        if (!covers(this.stableMarks(node, e, holder), lanes)) { behind = true; break } // the shed bar's ladder (crash-stable)
      }
      if (behind) waiting++
      else if (!reachable) stranded++
    }
    return { waiting, stranded }
  }

  //! #shed — the crash-safe execution order (C10/H1): (1) boot record WITHOUT p (a crash after this
  // boots shed-complete — sound: the predicate already proved every holder covered); (2) memory —
  // lanes filtered (ascending preserved: a filtered subsequence), cells, tombstones, floors, the
  // entry; (3) durable: the snapshot swap purges p's rows atomically.
  #shed(node: Node, p: string, e: ScopeEntry) {
    let dropped = 0
    this.entries.delete(p)
    this.n++
    this.evidence++ // lanes are filtered: the compaction memo re-reads them
    if (node.durable) node.persistBoot()
    //! through the per-partition index (DESIGN-SCALE stage 1): only the lanes that hold p are touched, and
    // each of those is filtered whole (a lane is an array, so taking entries out of it is O(that lane)
    // whatever the index says — the index saves the lanes with nothing of p and the version-key parse,
    // not the filter; the stage-1 skeptic's reading). A filtered subsequence of an ascending lane stays
    // ascending. p's floors leave EVERY stream, lane or no lane: the old walk ran over node.logs, so a
    // stream with no lane at all (a floor learned from a cut, with no record of that origin) kept it.
    const per = node.byPart!.get(p)
    if (per !== undefined) {
      for (const [origin, gone] of per) {
        const entries = node.logs.get(origin)
        if (entries === undefined) continue
        dropped += gone.length
        node.logs.set(origin, gone.length === entries.length ? [] : entries.filter((x) => partitionOf(x.rec) !== p))
      }
      node.byPart!.delete(p)
    }
    for (const [, d] of node.streams) d.parts?.delete(p)
    //! the cells of p are its row cell plus the deep index's field cells (V4-18: live fields and the
    // tombstones a live row fences — dropCell unlinks each) — no full scan. Its versions are those cells'
    // plus the tombstone index's (every stamp of p with no live value) — never a parse of every key.
    const fields = node.fields(p)
    const row = JSON.stringify([p])
    node.dropCell(row)
    for (const k of fields) node.dropCell(k)
    node.versions.delete(row)
    for (const k of fields) node.versions.delete(k)
    const tombs = node.tombs!.get(p)
    if (tombs !== undefined) { for (const k of tombs) node.versions.delete(k); node.tombs!.delete(p) }
    node.journal.armed && node.journal.emit(JK.shed, p, dropped)
    if (node.durable) node.snapshot()
  }

  //! tick — the heartbeat hook (DESIGN-SCALE stage 2 reshaped it): latch timeouts and the shedStall alarm as before,
  // then ONE announcement plan, one HAVEQ per link, built from four legs —
  //   dirty      every partition whose floor this owner advanced since the last tick, to each co-holder (§3 trigger 1);
  //   never-answered  every held partition to each co-holder that has never attested it (the `!per` leg of the old
  //              #lagging, kept: a lost install offer still heals within a tick). Its "trails" clause is GONE — after
  //              a write the owner's announcement carries the new floor and the answer carries the co-holder's, so
  //              marks converge in one round trip instead of a full round every two ticks;
  //   orphan poll  every orphan whose poll is due (every shedTicks), its frozen floors to the CURRENT holders;
  //   probe      the partitions of open scoped confirms, to their holders (held: our floors; else a pure probe);
  //   sweep      the next aeFan co-holder links in uuid order get every held partition they share (§3 trigger 4): a
  //              cursor over the sorted co-holders, surviving installs, so every held partition is re-proved with
  //              each co-holder within ⌈c / aeFan⌉ ticks. This replaces the member heartbeat DIGEST's belt and
  //              braces with a bounded cost; aeFan 0 switches the sweep off (a measurement posture).
  // Converged marks and an idle cluster cost exactly the sweep: Σ min(aeFan, cᵢ) HAVEQ frames per node per tick.
  #ticks = 0
  #cursor = 0
  tick(node: Node) {
    if (!node.armed) return
    const { shedTicks, stageTicks, stallAt, aeFan } = node.tune
    this.#ticks++
    const due = new Set<string>()
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) {
        if (++e.ticks! >= stageTicks) this.#abort(node, p, 'timeout')
        continue
      }
      if (e.state !== SCOPE.orphan) continue
      e.polls = (e.polls ?? 0) + 1
      if (e.polls % shedTicks === 0) due.add(p)
      if (e.polls >= (e.nextStall ?? stallAt)) {
        e.nextStall = (e.nextStall ?? stallAt) * 2
        node.journal.armed && node.journal.emit(JK.shedStall, p, e.polls)
      }
    }
    this.evaluateSheds(node)
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const plan = new Map<Link, Set<string>>()
    //! shared — co-holder uuid → the held partitions it shares with us, the sweep's list (one walk serves every leg)
    const shared = new Map<string, string[]>()
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) continue
      const orphan = e.state === SCOPE.orphan
      if (orphan && !due.has(p)) continue
      if (!orphan && node.durable && e.sealed === false) continue // announces nothing yet: no leg applies
      const dirty = this.dirty.has(p)
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const link = this.#link(node, uuid)
        if (link === undefined) continue
        if (orphan) { this.#plan(plan, link, p); continue }
        let list = shared.get(uuid)
        if (list === undefined) shared.set(uuid, list = [])
        list.push(p)
        if (dirty || !e.marks.has(uuid)) this.#plan(plan, link, p)
      }
    }
    if (node.confirm.pendingScoped()) {
      const probeParts = new Set<string>()
      node.confirm.scopedParts(probeParts)
      for (const p of probeParts) {
        const e = this.entries.get(p)
        if (e !== undefined && e.state === SCOPE.acquiring) continue
        for (const uuid of ring.holders(p, node.replicas)) {
          if (uuid === node.uuid) continue
          const link = this.#link(node, uuid)
          if (link !== undefined) this.#plan(plan, link, p)
        }
      }
    }
    if (aeFan > 0 && shared.size) {
      const peers = [...shared.keys()].sort()
      const n = Math.min(aeFan, peers.length)
      if (this.#cursor >= peers.length) this.#cursor = 0
      for (let i = 0; i < n; i++) {
        const uuid = peers[(this.#cursor + i) % peers.length]
        const link = this.#link(node, uuid)!
        for (const p of shared.get(uuid)!) this.#plan(plan, link, p)
      }
      this.#cursor = (this.#cursor + n) % peers.length
    }
    this.#ship(node, plan)
    this.dirty.clear()
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

  //! shedWaitingOn — the H7 surface: uuids currently pinning any orphan's shed (≤ view size).
  // Reads the SAME bar as evaluateSheds and undrained — `covers`, the one predicate — so the surface
  // names exactly who pins the shed and cannot drift from it (the third review found it re-inlined).
  shedWaitingOn(node: Node): string[] {
    if (!node.armed) return []
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const waiting = new Set<string>()
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const lanes = Object.entries(e.tails ??= this.#tailsOf(node, p))
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder !== node.uuid && !covers(this.stableMarks(node, e, holder), lanes)) waiting.add(holder)
      }
    }
    return [...waiting]
  }
}

//! keyPartition — state/versions keys are JSON path arrays ('["p","x"]'): the partition is elem 0.
const keyPartition = (k: string): string => {
  const path = JSON.parse(k) as string[]
  return path.length ? path[0] : ''
}
