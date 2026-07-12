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
interface Staged { origin: string; seq: number; epoch: number; iss?: string; cid?: number; rec: Rec; live: boolean }

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
  ticks?: number
  //! orphan shed-poll bookkeeping
  polls?: number
  nextStall?: number
}

export class Scope {
  entries = new Map<string, ScopeEntry>()

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
    return 1
  }

  //! stage — buffer one live record for a latched partition (verdict 2). Overflow aborts the latch —
  // safe because nothing has folded; the next offer re-ships everything above the learner's marks.
  stage(node: Node, p: string, origin: string, seq: number, epoch: number, rec: Rec, iss?: string, cid?: number) {
    const e = this.entries.get(p)!
    e.buf!.push({ origin, seq, epoch, rec, iss, cid, live: true })
    if (e.buf!.filter((s) => s.live).length > ACQ_LIVE_MAX) this.#abort(node, p, 'overflow')
  }

  //! mintHeld — the STAMP-SITE twin of verdict(): an armed owner committing a record for p holds p
  // by definition (single-writer: the ring routed the write here).
  mintHeld(p: string) {
    if (!this.entries.has(p)) this.entries.set(p, this.#entry(SCOPE.held))
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
    for (const entries of node.logs.values()) for (const e of entries) this.#ensure(node, partitionOf(e.rec))
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
        cur.nextStall = STALL_AT
        j.armed && j.emit(JK.orphaned, p, node.epoch)
      }
      //! orphan re-assigned (H2's A leg): stays FROZEN — the lawful re-entry is an acquiring latch
      // (delta above the frozen tails) opened by the next handshake round, never a silent un-freeze
    }
    this.round(node)
  }

  #ensure(node: Node, p: string) {
    if (this.entries.has(p)) return
    const assigned = node.writes.ring.holdsAny(node.uuid, p, node.replicas)
    this.entries.set(p, this.#entry(assigned ? SCOPE.held : SCOPE.orphan))
    if (!assigned) {
      const e = this.entries.get(p)!
      e.polls = 0
      e.nextStall = STALL_AT
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

  //! heldList — the boot record's data-authority (C10): held ∪ orphan. Acquiring is deliberately
  // ABSENT — an unfolded base is not restorable data; a crash mid-latch re-acquires cleanly.
  heldList(): string[] {
    const out: string[] = []
    for (const [p, e] of this.entries) if (e.state !== SCOPE.acquiring) out.push(p)
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
      for (const uuid of ring.holders(p, node.replicas)) {
        if (uuid === node.uuid) continue
        const id = node.byUuid.get(uuid) // byUuid maps to the link ID (the keeper rule) — resolve it
        const link = id === undefined ? undefined : node.links.get(id)
        if (!link || link.state !== LS.admitted || link.dead) continue
        let q = perLink.get(link)
        if (!q) { q = {}; perLink.set(link, q) }
        q[p] = this.#myFloors(node, p)
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
      // A-leg goes orphan → acquiring here, delta above the frozen floors, never straight to held)
      if (behind && ring.holdsAny(node.uuid, p, node.replicas)) {
        this.#latch(node, p, link.uuid)
        a[p] = { ok: 0, need: 1, m: mine }
        continue
      }
      //! we cover (or we are a frozen orphan answering the shed poll of ANOTHER orphan — still a
      // sound claim; the shed predicate ranges over CURRENT holders regardless of who answers)
      const ans: { ok: number; need: number; m?: Record<string, number>; md?: Record<string, number> } = behind ? { ok: 0, need: 0 } : { ok: 1, need: 0, m: mine }
      if (!behind && node.durable) {
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
        // latch them and send the unprompted need (one extra round-trip, no new verbs, symmetric)
        if (e.state !== SCOPE.acquiring && ring.holdsAny(node.uuid, p, node.replicas)) {
          const mine = this.#myFloors(node, p)
          let behind = false
          for (const [o, s] of Object.entries(ans.m ?? {})) if (typeof s === 'number' && s > (mine[o] ?? 0)) { behind = true; break }
          if (behind) {
            this.#latch(node, p, link.uuid)
            link.ship(encodeControl(VERB.HAVEA, { e: node.epoch, a: { [p]: { ok: 0, need: 1, m: mine } } }), node.env.sink, j)
            link.flush(node.env.sink, j)
          }
        }
      }
    }
    node.confirm.recount(node) // attested marks are scoped confirm evidence
    this.evaluateSheds(node)
  }

  //! #latch — open the one-teacher latch for p (from-zero, orphan re-entry, or held-found-lagging).
  #latch(node: Node, p: string, teacher: string) {
    const prev = this.entries.get(p)
    const e = prev ?? this.#entry(SCOPE.acquiring)
    if (!prev) this.entries.set(p, e)
    e.state = SCOPE.acquiring
    e.teacher = teacher
    e.buf = []
    e.teachN = 0
    e.ticks = 0
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
    for (const [origin, entries] of node.logs) {
      const above = marks[origin] ?? 0
      const ship = entries.filter((x) => x.seq > above && partitionOf(x.rec) === p)
      if (!ship.length) continue
      const runs = ship.map((x) => ({ rec: x.rec, origin, seq: x.seq, epoch: x.epoch, iss: x.iss, cid: x.cid }))
      for (const bytes of encodeRuns(runs, VERB.ACQ)) link.ship(bytes, node.env.sink, j)
      n += ship.length
    }
    const cut = this.#myFloors(node, p)
    link.ship(encodeControl(VERB.ACQDONE, { p, e: node.epoch, t: cut, n }), node.env.sink, j)
    link.flush(node.env.sink, j)
    j.armed && j.emit(JK.teachShip, p, n)
  }

  //! onAcq — teacher transfer records stage into the latch; anything else is a foreign ACQ (a
  // previous aborted attempt's stragglers, a second teacher) — dropped, journaled, monitored.
  onAcq(node: Node, link: Link, f: { prov(): { origin: string; baseSeq: number; epoch: number; issuer?: string; baseCid?: number } | null; records(): Iterable<{ origin: string; seq: number; epoch: number; issuer: string; cid: number; rec(): Rec }> }) {
    const j = node.journal
    for (const rv of f.records()) {
      const rec = rv.rec()
      const p = partitionOf(rec)
      const e = this.entries.get(p)
      if (!e || e.state !== SCOPE.acquiring || e.teacher !== link.uuid) {
        j.armed && j.emit(JK.stageDrop, p, rv.seq)
        continue
      }
      e.buf!.push({ origin: rv.origin, seq: rv.seq, epoch: rv.epoch, rec, iss: rv.issuer || undefined, cid: rv.issuer ? rv.cid : undefined, live: false })
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
      const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number } = { rec: s.rec, seq: s.seq, epoch: s.epoch }
      if (s.iss) { entry.iss = s.iss; entry.cid = s.cid }
      lane.splice(lo, 0, entry)
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
    e.teacher = undefined
    e.buf = undefined
    e.teachN = undefined
    e.ticks = undefined
    j.armed && j.emit(JK.acquire, p, teach.length, link.uuid)
    //! replay the staged live span through the NORMAL ingest law (held now): ≤ cut discards as
    // covered; above-cut folds/splices, feeds dedup windows, and forwards to spokes
    for (const s of live) {
      if (s.seq <= (cut[s.origin] ?? 0)) continue
      node.writes.inbound(node, s.origin, s.seq, s.epoch, { rec: () => s.rec, issuer: s.iss ?? '', cid: s.cid ?? 0 })
    }
    //! durable: the base entered memory only — arm the snapshot swap so it reaches disk atomically
    // (never persistRun: interior rows condemn the chain), and dirty until the echo
    if (node.durable) node.spliced(p)
    node.persistBoot()
    this.round(node) // the post-fold round: announce possession, true the floor up, seed confirm
    node.confirm.recount(node)
  }

  //! #abort — drop the latch whole. With log residue (an acquiring OWNER committed own-lane records
  // mid-transfer — the H2 corner) the entry becomes an orphan (possession ⇒ retention obligation ⇒
  // freeze + poll + shed); clean latches drop to `out` (re-offered by the next round).
  #abort(node: Node, p: string, reason: string) {
    const e = this.entries.get(p)
    if (!e || e.state !== SCOPE.acquiring) return
    node.journal.armed && node.journal.emit(JK.acquireAbort, p, reason)
    let residue = false
    for (const entries of node.logs.values()) if (entries.some((x) => partitionOf(x.rec) === p)) { residue = true; break }
    if (residue) {
      e.state = SCOPE.orphan
      e.teacher = undefined
      e.buf = undefined
      e.teachN = undefined
      e.ticks = undefined
      e.polls = 0
      e.nextStall = STALL_AT
      node.journal.armed && node.journal.emit(JK.orphaned, p, node.epoch)
    } else {
      this.entries.delete(p)
    }
  }

  //! evaluateSheds — THE STATELESS SHED DECISION (C3, D1's graft): for each orphaned p, shed iff for
  // every member of holdersOf(p) at the CURRENT ring, for every lane where my frozen floor > 0, the
  // holder's attested mark covers it. Nothing is stored between evaluations — an R-set change
  // re-ranges the quantifier, a (impossible) tail bump re-raises the bar, both by construction.
  evaluateSheds(node: Node) {
    if (!node.armed) return
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const mine = this.#myFloors(node, p)
      const lanes = Object.entries(mine)
      if (!lanes.length) { this.#shed(node, p, e); continue } // nothing possessed: drop the husk
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
    if (node.durable) node.persistBoot()
    for (const [origin, entries] of node.logs) {
      const kept = entries.filter((x) => partitionOf(x.rec) !== p)
      if (kept.length !== entries.length) { dropped += entries.length - kept.length; node.logs.set(origin, kept) }
      node.streams.get(origin)?.parts?.delete(p)
    }
    for (const k of [...node.state.keys()]) if (keyPartition(k) === p) node.dropCell(k)
    for (const k of [...node.versions.keys()]) if (keyPartition(k) === p) node.versions.delete(k)
    node.journal.armed && node.journal.emit(JK.shed, p, dropped)
    if (node.durable) node.snapshot()
  }

  //! tick — the heartbeat hook: orphan shed polls (every SHED_TICKS, with the escalating shedStall
  // alarm), latch timeouts, and the probe-driven re-round for pending scoped confirms.
  tick(node: Node) {
    if (!node.armed) return
    let pollDue = false
    for (const [p, e] of this.entries) {
      if (e.state === SCOPE.acquiring) {
        if (++e.ticks! >= STAGE_TICKS) this.#abort(node, p, 'timeout')
        continue
      }
      if (e.state !== SCOPE.orphan) continue
      e.polls = (e.polls ?? 0) + 1
      if (e.polls % SHED_TICKS === 0) pollDue = true
      if (e.polls >= (e.nextStall ?? STALL_AT)) {
        e.nextStall = (e.nextStall ?? STALL_AT) * 2
        node.journal.armed && node.journal.emit(JK.shedStall, p, e.polls)
      }
    }
    this.evaluateSheds(node)
    if (pollDue || node.confirm.pendingScoped()) this.round(node)
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
  shedWaitingOn(node: Node): string[] {
    if (!node.armed) return []
    const ring = node.writes.ring
    if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const waiting = new Set<string>()
    for (const [p, e] of this.entries) {
      if (e.state !== SCOPE.orphan) continue
      const mine = this.#myFloors(node, p)
      for (const holder of ring.holders(p, node.replicas)) {
        if (holder === node.uuid) continue
        const per = e.marks.get(holder)
        for (const [o, s] of Object.entries(mine)) if ((per?.get(o) ?? 0) < s) { waiting.add(holder); break }
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
