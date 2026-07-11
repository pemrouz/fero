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

interface Probe { id: number; origin: string; seq: number; level: number }

export class Confirm {
  #probes = new Map<number, Probe>()
  //! per-peer evidence marks: uuid → origin → {s: shippable tail, d: durable tail}, fed by digests (monotone).
  #marks = new Map<string, Map<string, { s: number; d: number }>>()

  //! register — open a probe; it may resolve synchronously (evidence can already suffice).
  register(node: Node, id: number, origin: string, seq: number, level: number) {
    const j = node.journal
    this.#probes.set(id, { id, origin, seq, level })
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

  //! recount — re-evaluate every open probe against CURRENT membership and CURRENT evidence. Called
  // after digests, own-ladder advances (commit/persisted/ingest), and every view install. Early-outs
  // when no probes are open, so the steady state pays one size check.
  recount(node: Node) {
    if (this.#probes.size === 0) return
    for (const p of [...this.#probes.values()]) {
      const count = this.#count(node, p)
      const members = node.membership.view.members.length
      const threshold = members === 0 ? 1 : (members >> 1) + 1
      if (count >= threshold) this.#answer(node, p, true, count)
    }
  }

  //! #count — members (self included) whose ladder covers (origin, seq) at the probe's level.
  #count(node: Node, p: Probe): number {
    const level = p.level
    const evid = (s: number, d: number) => (level === CONFIRM.persisted ? d : s) >= p.seq
    const own = node.streams.get(p.origin)
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
