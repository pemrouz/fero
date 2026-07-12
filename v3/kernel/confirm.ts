//! ── kernel/confirm — the guarantee ladder: what is PROVEN, to whom, when ─────
// M4c (plan §4 module table + §5 durability). A confirm probe asks: "has
// (origin, seq) reached this guarantee level?" and the ONLY admissible evidence
// is the watermark ladder (kernel/streams.ts):
//
//   replicated — a MAJORITY of the committed view (self included) holds the
//                record SHIPPABLE (logged: it survives any single link, and the
//                log is the retransmit buffer that re-ships it forever).
//   persisted  — a majority holds it DURABLE (a storage batch covering the seq
//                RESOLVED; strength equals the plugged store's honesty × the
//                quorum — one lying disk cannot fake a majority).
//
// NEVER `applied`: v2's recvReplProbe answered confirm:'replicated' off the
// apply watermark — a documented guaranteed-false-positive (applied advances on
// LWW losers and dedup skips; it proves observation, not possession). Here the
// evidence fields are read straight off StreamDescriptors, so the wrong-field
// read has no code path.
//
// Evidence arrives three ways, all existing machinery: my OWN ladder (read live
// at recount), peers' SHIPPABLE tails (every DIGEST already announces them —
// the `d` map), and peers' DURABLE tails (the DIGEST `p` map, sent only in
// durable mode so pre-M4 trajectories stay byte-identical). Confirm therefore
// converges on the heartbeat cadence with ZERO new frame types.
//
// VIEW-CHANGE RECOUNT (plan, verbatim): thresholds are majorities OF THE
// COMMITTED VIEW, so every install recounts every open probe — members that
// left stop counting, a shrunk view may resolve a stalled probe, a grown view
// may raise the bar. Open genesis (epoch 0) has no view: the threshold is SELF
// alone — solo semantics, honestly weaker, stated here.
//
// The kernel never answers `false` on its own: evidence is monotone and R=∞
// anti-entropy makes every level eventually reachable, so a probe that cannot
// resolve YET simply waits. Deadlines are the embedder's (M5's confirm option
// wraps a timer around cancel()); cancel answers false with the count reached.
// The registry is bounded (MAX_PROBES, drop-oldest answered false, surfaced).

import { JK } from './journal.ts'
import type { Node } from './node.ts'

//! CONFIRM: the guarantee levels (wire/api-stable discriminants, REC-style).
export const CONFIRM = { replicated: 0, persisted: 1 } as const

//! MAX_PROBES: registry bound — overflow answers the OLDEST probe false (surfaced), never grows silently.
export const MAX_PROBES = 1024

//! `part` (M6): the record's partition — armed nodes range the count over holdersOf(part) at the
// derived W-quorum instead of the view majority. Absent (or unscoped) keeps the M4 math verbatim.
interface Probe { id: number; origin: string; seq: number; level: number; part?: string }

export class Confirm {
  #probes = new Map<number, Probe>()
  //! per-peer evidence marks: uuid → origin → {s: shippable tail, d: durable tail}, fed by digests (monotone).
  #marks = new Map<string, Map<string, { s: number; d: number }>>()
  //! peers that have EVER announced a durable (p) map — the "this peer is durable" signal. The
  // compaction frontier keys crash-stability off it: a durable peer's marks must be read at markD
  // (its crash restores at least its durable), a never-announced-p peer is non-durable and its crash
  // is a TOTAL refold (volatile marks are then sound) — the mixed-cluster resurrection finding.
  #hasP = new Set<string>()

  //! register — open a probe; it may resolve synchronously (evidence can already suffice).
  register(node: Node, id: number, origin: string, seq: number, level: number, part?: string) {
    const j = node.journal
    const probe: Probe = { id, origin, seq, level }
    if (node.armed && part !== undefined) probe.part = part
    this.#probes.set(id, probe)
    j.armed && j.emit(JK.confirmReq, id, level, origin)
    if (this.#probes.size > MAX_PROBES) {
      const oldest = this.#probes.keys().next().value!
      this.#answer(node, this.#probes.get(oldest)!, false, 0)
    }
    this.recount(node)
  }

  //! cancel — the embedder's deadline fired: answer false with the count reached (an honest reject).
  cancel(node: Node, id: number) {
    const p = this.#probes.get(id)
    if (p) this.#answer(node, p, false, this.#count(node, p))
  }

  //! mark — a peer's recorded shippable tail for an origin (0 = never announced). The compaction
  // frontier (kernel/log.ts) reads these: a cut is safe only when EVERY member is provably past it.
  mark(uuid: string, origin: string): number { return this.#marks.get(uuid)?.get(origin)?.s ?? 0 }

  //! markD — a peer's recorded DURABLE tail (0 = never announced / non-durable peer). In durable mode
  // the compaction frontier and tombstone quiescence read THESE, never the shippable marks: applied and
  // shippable regress when a crash eats un-fsynced rows, and a frontier computed over crash-volatile
  // marks compacts away history a reborn member still needs (the seed-27 resurrection: a remove's
  // record and its GC'd tombstone were both gone cluster-wide when the crashed lane came back without
  // them). Durable marks are exactly the crash-stable lower bound — an honest disk restores at least
  // everything it resolved.
  markD(uuid: string, origin: string): number { return this.#marks.get(uuid)?.get(origin)?.d ?? 0 }

  //! feed — a peer digest announced its tails: record (monotone) and recount. `d` < 0 means the digest
  // carried no durable map (a non-durable peer) — its durable evidence never advances.
  feed(node: Node, uuid: string, origin: string, s: number, d: number) {
    let per = this.#marks.get(uuid)
    if (!per) { per = new Map(); this.#marks.set(uuid, per) }
    let m = per.get(origin)
    if (!m) { m = { s: 0, d: 0 }; per.set(origin, m) }
    if (s > m.s) m.s = s
    if (d > m.d) m.d = d
  }

  //! sawP — the peer's digest carried a p map (even an empty one): it runs in durable mode.
  sawP(uuid: string) { this.#hasP.add(uuid) }

  //! origins — add every lane ANY peer has ever announced to `into`. The tombstone-GC lane universe
  // must include lanes this node has not received a single record of yet (only a digest mention):
  // their in-flight suffixes are exactly as capable of contesting a released stamp as a known lane's.
  origins(into: Set<string>) { for (const per of this.#marks.values()) for (const o of per.keys()) into.add(o) }
  //! durablePeer — has this peer ever announced durable evidence? (See #hasP.)
  durablePeer(uuid: string): boolean { return this.#hasP.has(uuid) }

  //! pendingScoped — any partition-scoped probe still open? (The scope tick re-drives handshake
  // rounds while one waits — evidence converges on tick cadence, priced per open probe.)
  pendingScoped(): boolean {
    for (const p of this.#probes.values()) if (p.part !== undefined) return true
    return false
  }

  //! forget — a peer was REBORN (its HELLO carries a higher incarnation): every mark it ever announced
  // is void. Marks are monotone by design (feed only raises), which is correct within one life and a
  // LIE across lives — a crash regresses shippable/applied outright, and even durable regresses when
  // the disk lied or the restore was condemned. Counting a dead life's marks handed replicated-probes
  // a quorum member that provably holds nothing, and held the compaction frontier open over evidence
  // no disk backs (M4-review finding). Open probes are NOT re-answered — evidence became weaker, so
  // they simply wait for the reborn's fresh digests.
  forget(uuid: string) {
    this.#marks.delete(uuid)
    this.#hasP.delete(uuid)
  }

  //! recount — re-evaluate every open probe against CURRENT membership and CURRENT evidence. Called
  // after digests, own-ladder advances (commit/persisted/ingest), and every view install. Early-outs
  // when no probes are open, so the steady state pays one size check.
  recount(node: Node) {
    if (this.#probes.size === 0) return
    for (const p of [...this.#probes.values()]) {
      const count = this.#count(node, p)
      //! M6 scoped threshold: a partition-scoped probe on an armed node needs W = majority of the
      // R-SET holders, not of the view — the record only ever lives on holdersOf(part) (DESIGN-M6 C3)
      let threshold: number
      if (p.part !== undefined && node.armed) {
        const r = node.writes.ring
        if (node.epoch > 0 && r.epoch !== node.epoch) r.build(node.epoch, node.membership.view.members)
        threshold = (r.holders(p.part, node.replicas).length >> 1) + 1
      } else {
        const members = node.membership.view.members.length
        threshold = members === 0 ? 1 : (members >> 1) + 1
      }
      if (count >= threshold) this.#answer(node, p, true, count)
    }
  }

  //! #count — members (self included) whose ladder covers (origin, seq) at the probe's level.
  // M6 (armed, partition-scoped probe): the range is holdersOf(part) and the evidence is the
  // per-(origin, partition) POSSESSION floors — self reads its own `parts` ladder; a peer counts only
  // on handshake-ATTESTED marks (slice 3b feeds them — until then peers honestly count 0). The bare
  // digest `d[o] ≥ seq` is NEVER sufficient scoped evidence: under partition-filtered multi-source
  // shipping a steady-held peer's lane tail can run past an interior hole (the judge-proven overclaim).
  #count(node: Node, p: Probe): number {
    const level = p.level
    const evid = (s: number, d: number) => (level === CONFIRM.persisted ? d : s) >= p.seq
    const own = node.streams.get(p.origin)
    if (p.part !== undefined && node.armed) {
      const r = node.writes.ring
      if (node.epoch > 0 && r.epoch !== node.epoch) r.build(node.epoch, node.membership.view.members)
      const entry = node.scope!.entries.get(p.part)
      let n = 0
      for (const uuid of r.holders(p.part, node.replicas)) {
        if (uuid === node.uuid) {
          const pe = own?.parts?.get(p.part)
          if (pe && evid(pe.s, pe.d)) n++
        } else if (entry) {
          //! peers count on handshake-ATTESTED per-(origin, partition) marks ONLY (never the bare
          // digest d[o] — it provably overclaims past an interior hole under multi-source shipping);
          // the persisted level reads the md-fed durable mirror. Absent attestation counts nothing —
          // the honest direction; the scope tick re-HAVEQs while this probe stays open.
          const s = entry.marks.get(uuid)?.get(p.origin) ?? 0
          const dm = entry.marksD.get(uuid)?.get(p.origin) ?? 0
          if (evid(s, dm)) n++
        }
      }
      return n
    }
    const members = node.membership.view.members
    if (members.length === 0) return own && evid(own.shippable, own.durable) ? 1 : 0
    let n = 0
    for (const [uuid] of members) {
      if (uuid === node.uuid) {
        if (own && evid(own.shippable, own.durable)) n++
      } else {
        const m = this.#marks.get(uuid)?.get(p.origin)
        if (m && evid(m.s, m.d)) n++
      }
    }
    return n
  }

  #answer(node: Node, p: Probe, ok: boolean, count: number) {
    this.#probes.delete(p.id)
    node.journal.armed && node.journal.emit(JK.confirmed, p.id, ok ? 1 : 0, count)
    node.env.sink.confirm(p.id, ok, count)
  }
}
