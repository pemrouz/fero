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

//! one staged record — teacher transfer and live records share the buffer, discriminated by `live`.
interface Staged { origin: string; seq: number; epoch: number; iss?: string; cid?: number; rec: Rec; live: boolean; pp?: number }

//! ScopeEntry: one partition's machine state.
export interface ScopeEntry {
  state: number
  //! attested per-lane possession marks per peer uuid (HAVEQ-in declares, HAVEA-ok-in echoes)
  marks: Map<string, Map<string, number>>
  //! the durable mirror (HAVEA md) — scoped persisted-level confirm evidence reads THESE
  marksD: Map<string, Map<string, number>>
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

  #entry(state: number): ScopeEntry { return { state, marks: new Map(), marksD: new Map() } }

  //! held — the api/monitor view: is p live here (folds records, serves reads, attests possession)?
  held(p: string): boolean { return this.entries.get(p)?.state === SCOPE.held }

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
    for (const e of this.entries.values()) { e.marks.delete(uuid); e.marksD.delete(uuid) }
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

  //! round — one batched handshake round: for every entry, HAVEQ the peers who matter (co-holders of
  // held/acquiring partitions — announce + probe; CURRENT holders of orphaned partitions — the shed
  // poll doubles as the teaching offer). One frame per admitted member link per round.
  round(node: Node) {
    if (!node.armed) return
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const perLink = new Map<Link, Record<string, Record<string, number>>>()
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) continue // the latch is the active protocol for this partition
      //! floors computed ONCE per partition, not per (partition × link) — finding 44
      let mine: Record<string, number> | null = null
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const id = node.byUuid.get(uuid) // byUuid maps to the link ID (the keeper rule) — resolve it
        const link = id === undefined ? undefined : node.links.get(id)
        if (!link || link.state !== LS.admitted || link.dead) continue
        let q = perLink.get(link)
        if (!q) { q = {}; perLink.set(link, q) }
        q[p] = (mine ??= this.#announceFloors(node, p, e))
      }
    }
    //! the PROBE-driven leg (finding 38): partitions with open scoped confirms this node does NOT
    // hold — a non-holder issuer asks the partition's holders with empty floors (a pure probe,
    // never an attestation); their ok answers land in the probe's own ev map via feedScoped.
    const probeParts = new Set<string>()
    node.confirm.scopedParts(probeParts)
    for (const p of probeParts) {
      if (this.entries.has(p)) continue // a holder's entry already announces above
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const id = node.byUuid.get(uuid)
        const link = id === undefined ? undefined : node.links.get(id)
        if (!link || link.state !== LS.admitted || link.dead) continue
        let q = perLink.get(link)
        if (!q) { q = {}; perLink.set(link, q) }
        q[p] = {}
      }
    }
    for (const [link, q] of perLink) {
      link.ship(encodeControl(VERB.HAVEQ, { e: node.epoch, q }), node.env.sink, node.journal)
      link.flush(node.env.sink, node.journal)
    }
  }

  //! onHaveQ — a peer announced its floors for partitions we co-own (or it is shedding). Their
  // declared floors ARE possession attestations (feed marks), then answer HAVEA per partition:
  // ok=1 (+ echoed floors m) when we cover; need=1 (+ our marks) latches THEM as our teacher when
  // we are behind or absent-and-assigned; busy (ok:0, need:0) while our own latch is open.
  onHaveQ(node: Node, link: Link, v: { e?: number; q?: Record<string, Record<string, number>> }) {
    const j = node.journal
    if (v.e !== node.epoch || typeof v.q !== 'object' || v.q === null) {
      j.armed && j.emit(JK.frameDrop, link.id, 'haveq epoch skew')
      return
    }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const a: Record<string, { ok: number; need: number; m?: Record<string, number>; md?: Record<string, number> }> = {}
    for (const [p, asked] of Object.entries(v.q)) {
      const e = this.entries.get(p)
      //! feed marks: the asker possesses what it declares (frozen or live, floors are sound claims)
      if (e) {
        let per = e.marks.get(link.uuid)
        if (!per) { per = new Map(); e.marks.set(link.uuid, per) }
        for (const [o, s] of Object.entries(asked)) if (typeof s === 'number' && s > (per.get(o) ?? 0)) per.set(o, s)
      }
      if (e === undefined) {
        if (ring.holdsAny(node.uuid, p, node.replicas)) {
          //! absent + assigned: acquire from the announcer — the from-zero latch (empty marks)
          this.#latch(node, p, link.uuid)
          a[p] = { ok: 0, need: 1, m: {} }
        }
        continue // not ours, not assigned: silence (the asker's ring knows who its holders are)
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
      const ans: { ok: number; need: number; m?: Record<string, number>; md?: Record<string, number> } = behind ? { ok: 0, need: 0 } : { ok: 1, need: 0, m: this.#announceFloors(node, p, e) }
      if (!behind && node.durable && e.sealed !== false) {
        const md: Record<string, number> = {}
        for (const [origin, d] of node.streams) { const pd = d.parts?.get(p)?.d ?? 0; if (pd > 0) md[origin] = pd }
        ans.md = md
      }
      a[p] = ans
    }
    if (Object.keys(a).length) {
      link.ship(encodeControl(VERB.HAVEA, { e: node.epoch, a }), node.env.sink, j)
      link.flush(node.env.sink, j)
    }
    this.evaluateSheds(node)
  }

  //! onHaveA — answers to our HAVEQ round (or an unprompted teach-me request). ok answers feed marks
  // (the answerer's echoed floors are its self-attested possession claim); need answers make US the
  // teacher — ship the one-teacher delta.
  onHaveA(node: Node, link: Link, v: { e?: number; a?: Record<string, { ok?: number; need?: number; m?: Record<string, number>; md?: Record<string, number> }> }) {
    const j = node.journal
    if (v.e !== node.epoch || typeof v.a !== 'object' || v.a === null) {
      j.armed && j.emit(JK.frameDrop, link.id, 'havea epoch skew')
      return
    }
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    for (const [p, ans] of Object.entries(v.a)) {
      const e = this.entries.get(p)
      if (ans.need === 1) { this.#teach(node, link, p, ans.m ?? {}); continue }
      if (ans.ok === 1 && e) {
        let per = e.marks.get(link.uuid)
        if (!per) { per = new Map(); e.marks.set(link.uuid, per) }
        for (const [o, s] of Object.entries(ans.m ?? {})) if (typeof s === 'number' && s > (per.get(o) ?? 0)) per.set(o, s)
        if (ans.md) {
          let perD = e.marksD.get(link.uuid)
          if (!perD) { perD = new Map(); e.marksD.set(link.uuid, perD) }
          for (const [o, s] of Object.entries(ans.md)) if (typeof s === 'number' && s > (perD.get(o) ?? 0)) perD.set(o, s)
        }
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
    if (!e || e.state === SCOPE.acquiring) return // nothing to teach / mid-latch ourselves
    let n = 0
    //! through the per-partition index (DESIGN-SCALE stage 1): only the lanes that hold p, only its
    // entries — the ship is O(entries of p), not O(entries of the node). Lane order is node.logs order,
    // as before, so the frames leave in the same order they always did.
    const per = node.byPart!.get(p)
    for (const origin of node.logs.keys()) {
      const entries = per?.get(origin)
      if (entries === undefined) continue
      const above = marks[origin] ?? 0
      let lo = 0, hi = entries.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].seq <= above) lo = mid + 1; else hi = mid }
      if (lo === entries.length) continue
      const ship = lo === 0 ? entries : entries.slice(lo)
      //! stored pp rides the teach (the floor law): the learner's post-fold lane re-ships to OTHERS
      // with intact chain evidence. The fold itself trusts the CUT, not the chain.
      const runs = ship.map((x) => ({ rec: x.rec, origin, seq: x.seq, epoch: x.epoch, iss: x.iss, cid: x.cid, pp: x.pp }))
      for (const bytes of encodeRuns(runs, VERB.ACQ, true)) link.ship(bytes, node.env.sink, j)
      n += ship.length
    }
    const cut = this.#myFloors(node, p)
    link.ship(encodeControl(VERB.ACQDONE, { p, e: node.epoch, t: cut, n }), node.env.sink, j)
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
  onAcqDone(node: Node, link: Link, v: { p?: string; e?: number; t?: Record<string, number>; n?: number }) {
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
    //! fold the teacher records: insert into lanes at seq position through the LWW election. The
    // teacher walked each lane ascending, so per-lane order is preserved by construction.
    for (const s of teach) {
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
      if (s.iss) node.writes.remember(node, s.iss, s.cid!, s.seq, s.epoch)
    }
    //! floors and fences advance to the CUT (the teacher's attestation), never past it on the
    // teacher's word; the scalar fence merges up so replayed-live below the cut dedups
    for (const [o, c] of Object.entries(cut)) {
      if (typeof c !== 'number') continue
      const d = node.streams.for(o)
      const pe = d.part(p)
      if (c > pe.s) pe.s = c
      if (c > d.applied) d.applied = c
      if (c > d.shippable) d.shippable = c
    }
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
    // covered; above-cut folds/splices, feeds dedup windows, and forwards to spokes — pp intact
    for (const s of live) {
      if (s.seq <= (cut[s.origin] ?? 0)) continue
      node.writes.inbound(node, s.origin, s.seq, s.epoch, { rec: () => s.rec, issuer: s.iss ?? '', cid: s.cid ?? 0, pp: s.pp })
    }
    //! durable: the base entered memory only — arm the snapshot swap so it reaches disk atomically
    // (never persistRun: interior rows condemn the chain), and dirty until the echo
    if (node.durable) node.spliced(p)
    node.persistBoot()
    this.round(node) // the post-fold round: announce possession (sealed-gated), true the floor up, seed confirm
    node.confirm.recount(node)
  }

  //! sealed — the snapshot echo's callback (node.ts 'persisted', the dirty-clear leg): the acquired
  // base is now disk-restorable — attest it (the deferred post-fold announce) and re-enter the boot
  // record's held list.
  sealed(node: Node, p: string) {
    const e = this.entries.get(p)
    if (!e || e.sealed !== false) return
    e.sealed = true
    if (node.durable) node.persistBoot()
    this.round(node)
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
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const tails = e.tails ??= this.#tailsOf(node, p) // captured at the freeze; rebuilt here only for legacy entries
      const lanes = Object.entries(tails)
      if (!lanes.length) { this.#shed(node, p, e); continue } // no content anywhere: a true husk
      let covered = true
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder === node.uuid) { covered = false; break } // still assigned?! never shed our own duty
        const per = e.marks.get(holder)
        for (const [o, s] of lanes) if ((per?.get(o) ?? 0) < s) { covered = false; break }
        if (!covered) break
      }
      if (covered) this.#shed(node, p, e)
    }
  }

  //! #shed — the crash-safe execution order (C10/H1): (1) boot record WITHOUT p (a crash after this
  // boots shed-complete — sound: the predicate already proved every holder covered); (2) memory —
  // lanes filtered (ascending preserved: a filtered subsequence), cells, tombstones, floors, the
  // entry; (3) durable: the snapshot swap purges p's rows atomically.
  #shed(node: Node, p: string, e: ScopeEntry) {
    let dropped = 0
    this.entries.delete(p)
    this.n++
    if (node.durable) node.persistBoot()
    //! through the per-partition index (DESIGN-SCALE stage 1): only the lanes that hold p are filtered
    // (a filtered subsequence of an ascending lane stays ascending); p's floors leave every stream (the
    // old walk visited lanes with entries only — a floor for a lane with no entry of p outlived the shed)
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

  //! tick — the heartbeat hook: orphan shed polls (every SHED_TICKS, with the escalating shedStall
  // alarm), latch timeouts, the probe-driven re-round for pending scoped confirms, and the
  // MARKS-LAG round (M6-review findings 13/23): a stable cluster whose co-holder evidence is
  // missing or behind keeps announcing at the poll cadence until it converges — a lost install
  // offer, a clean latch abort, or a skew-dropped round self-heals within SHED_TICKS instead of
  // waiting for the next membership change. Converged marks go silent (zero steady-state chatter).
  #ticks = 0
  tick(node: Node) {
    if (!node.armed) return
    const { shedTicks, stageTicks, stallAt } = node.tune
    this.#ticks++
    let pollDue = false
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) {
        if (++e.ticks! >= stageTicks) this.#abort(node, p, 'timeout')
        continue
      }
      if (e.state !== SCOPE.orphan) continue
      e.polls = (e.polls ?? 0) + 1
      if (e.polls % shedTicks === 0) pollDue = true
      if (e.polls >= (e.nextStall ?? stallAt)) {
        e.nextStall = (e.nextStall ?? stallAt) * 2
        node.journal.armed && node.journal.emit(JK.shedStall, p, e.polls)
      }
    }
    this.evaluateSheds(node)
    if (pollDue || node.confirm.pendingScoped() ||
        (this.#ticks % shedTicks === 0 && this.#lagging(node))) this.round(node)
  }

  //! #lagging — is any co-holder's attested evidence missing or behind our announceable floors?
  // (Sealed-pending entries skip — they announce nothing yet, so peers cannot be "behind" them.)
  #lagging(node: Node): boolean {
    const ring = node.writes.ring
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.held || (node.durable && e.sealed === false)) continue
      const mine = this.#myFloors(node, p)
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder === node.uuid) continue
        const per = e.marks.get(holder)
        if (!per) return true // never exchanged — the (re)offer leg
        for (const o in mine) if ((per.get(o) ?? 0) < mine[o]) return true
      }
    }
    return false
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
  // Reads the SAME tails bar as evaluateSheds — the surface must name who actually pins the shed.
  shedWaitingOn(node: Node): string[] {
    if (!node.armed) return []
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const waiting = new Set<string>()
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const tails = e.tails ??= this.#tailsOf(node, p)
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder === node.uuid) continue
        const per = e.marks.get(holder)
        for (const [o, s] of Object.entries(tails)) if ((per?.get(o) ?? 0) < s) { waiting.add(holder); break }
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
