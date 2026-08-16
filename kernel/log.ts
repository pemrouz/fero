//! ── kernel/log — compaction: the snapshot record supersedes the prefix ───────
// M4d (plan §4 module table). The M0 debt this closes: per-origin logs and the
// per-cell versions map (tombstones included) grew without bound. The bound:
//
//   COMPACTION — for an origin's log prefix ≤ the FRONTIER, every entry that is
//   not the CURRENT WINNER of its cell is dropped; winners survive AS ORDINARY
//   RECORDS with their ORIGINAL provenance (the "snapshot record"). Catch-up
//   needs zero new machinery: a lagging peer served a compacted log folds the
//   survivors through the same LWW election and reaches the same state — the
//   two properties pinned by log.test.ts (replay-from-0 ≡ live; compacted
//   catch-up ≡ uncompacted). Loser HISTORY vanishes — by construction the
//   election has already settled everywhere past the frontier, so losers are
//   dead weight, not evidence.
//
//   THE FRONTIER (per-origin, the safety condition) — a cut at seq S for origin
//   o is safe only when EVERY member of the committed view is provably applied
//   past S for o (their digest tails, via confirm's evidence marks; self reads
//   live). Below the frontier no member can ever need a dropped record (their
//   dedup would discard it) — a LAGGING MEMBER PINS COMPACTION, which is the
//   honest trade: memory is spent exactly where a peer still needs history.
//   Open genesis (epoch 0) never compacts: no committed view, no frontier.
//
//   TOMBSTONE GC — a remove's version stamp must outlive every record it could
//   still fence (a slow resurrect). Stamps are droppable only at FULL
//   quiescence: every member at every lane's known tail, on crash-stable marks
//   (nothing old remains in flight anywhere — seq bounds cannot substitute:
//   LWW is epoch-first, and an in-flight lower-epoch/higher-seq record escapes
//   any seq comparison). Once the version drops, the next compaction pass
//   drops the remove record itself (it is no longer its cell's winner-of-record).
//
//   KNOWN RESIDUAL (tracked for M6, stated per plan §8 honesty): after a
//   tombstone and its remove record are gone, a FRESH fold (a new joiner or a
//   condemned refold) can race two teachers — fold a still-held update from an
//   uncompacted peer, then have a compacted peer's sparse suffix advance its
//   applied past the (now nonexistent) remove — resurrecting the cell at that
//   node only. Members are safe (quiescence ranges over them); fresh folds
//   need the M6 state-transfer semantics (an atomic snapshot fold from one
//   teacher before live suffixes mix). converged() catches it per event in
//   every sweep, and no seed has produced it in 300 restore-proof runs.
//
// Triggers are SIZE-AWARE and ride the heartbeat tick (like membership): an
// origin's log arms at COMPACT_AT entries; a pass that cannot advance (frontier
// pinned) costs one comparison. Journal-surfaced, never silent. The durable
// (WAL) counterpart — snapshot+truncate of the on-disk rows — lands with M4e's
// restore proof, where its correctness must be demonstrated anyway.

import { JK } from './journal.ts'
import type { Node } from './node.ts'

//! COMPACT_AT: per-origin entry count that arms a compaction pass (the size-aware trigger).
export const COMPACT_AT = 4096

//! frontier — the highest seq of origin `o` that EVERY committed-view member is provably past, on
// marks that survive that member's crash (0 when unknown, when any member has announced nothing, or
// at open genesis). In durable mode that means DURABLE marks (self reads its own ladder; peers via
// the digest p-map evidence): applied/shippable regress when a crash eats un-fsynced rows, and a cut
// taken over volatile marks strands the reborn — the records it needs to refold (removes especially)
// are gone from every log (the sweep's seed-27 resurrection). A non-durable peer never announces p,
// so its presence pins durable-cluster compaction at 0 — honest, and journal-visible in log sizes.
// In non-durable mode applied marks are sound: a non-durable crash restores NOTHING (fresh incarnation,
// empty fold), and a total refold from compacted winners converges — only PARTIAL restores are hazardous.
// Known residual (documented, not closed): a disk that lies about the newest un-chained-over row of a
// lane evades replay's hole detector (nothing after it points back), so its durable mark can overclaim
// by that one row; closing it needs chained-over durable marks in the digest — M6 digest work.
//! stableMark — one member's crash-stable contribution to the frontier/quiescence math. Crash-stability
// is a property of THAT member, not of the asking node (the M4-review mixed-cluster finding: a
// non-durable member compacting over a durable peer's VOLATILE marks re-opens the seed-27
// resurrection): a peer that has ever announced a p map is durable — read it at markD (its crash
// restores at least its durable); a never-announced-p peer is non-durable — its crash is a TOTAL
// refold, so its volatile shippable mark is sound. Self reads its own ladder directly.
const stableMark = (node: Node, uuid: string, o: string): number =>
  uuid === node.uuid
    ? (node.durable ? (node.streams.get(o)?.durable ?? 0) : (node.streams.get(o)?.applied ?? 0))
    : (node.confirm.durablePeer(uuid) ? node.confirm.markD(uuid, o) : node.confirm.mark(uuid, o))

export const frontier = (node: Node, o: string): number => {
  const members = node.membership.view.members
  if (members.length === 0) return 0
  let f = Infinity
  for (const [uuid] of members) {
    const s = stableMark(node, uuid, o)
    if (s < f) f = s
  }
  return f === Infinity ? 0 : f
}

//! compact — rewrite origin `o`'s prefix ≤ upTo: keep each entry only if it is still the current
// winner of its cell (the snapshot record, original stamps — attempt identity kept so catch-up feeds
// dedup windows too); drop the rest. Returns the number of entries dropped. Ascending order is
// preserved by construction (a filtered subsequence of an ascending log).
export const compact = (node: Node, o: string, upTo: number): number => {
  const entries = node.logs.get(o)
  if (!entries || entries.length === 0) return 0
  const kept: typeof entries = []
  let dropped = 0
  for (const e of entries) {
    if (e.seq > upTo) { kept.push(e); continue }
    const k = JSON.stringify(e.rec.key.length ? e.rec.key : [e.rec.at ?? ''])
    const v = node.versions.get(k)
    if (v && v.origin === o && v.seq === e.seq && v.epoch === e.epoch) kept.push(e)
    else dropped++
  }
  if (dropped) {
    node.logs.set(o, kept)
    node.journal.armed && node.journal.emit(JK.compacted, o, dropped)
  }
  return dropped
}

//! gcTombstones — drop version stamps of REMOVED cells that nothing can ever contest again (see the
// banner's quiescence condition). Live cells keep their stamps: they are the LWW guard for the value.
export const gcTombstones = (node: Node): number => {
  const members = node.membership.view.members
  if (members.length === 0) return 0
  //! FULL quiescence, every lane, or nothing (M4-review major): the old per-lane straggler bound
  // compared SEQS while the LWW election is EPOCH-FIRST — an in-flight record with a LOWER epoch but
  // HIGHER seq than the tombstone (stamped at genesis, delayed across the view change) escaped both
  // the dedup fence (seq above the receiver's applied) and the released stamp, resurrecting the cell
  // with an old-epoch value. Seqs across lanes/epochs are not comparable to a tombstone's stamp, so
  // the only sound cheap condition is: NO lane has anything in flight anywhere (every member at every
  // lane's known tail, on the same crash-stable marks the frontier uses). Then nothing old remains
  // deliverable, and every non-live stamp is uncontestable. Tombstones ride out busy periods and
  // release at quiet points — bounded in practice, honest always.
  const lanes = new Set<string>(node.logs.keys())
  for (const [l] of node.streams) lanes.add(l)
  node.confirm.origins(lanes) // lanes known only from digests count too — their suffixes are in flight BY DEFINITION
  for (const l of lanes) {
    let min = Infinity
    let maxTail = node.streams.get(l)?.shippable ?? 0
    for (const [uuid] of members) {
      const s = stableMark(node, uuid, l)
      if (s < min) min = s
      if (s > maxTail) maxTail = s
    }
    if (min < maxTail) return 0 // something is still in flight — a straggler could contest ANY tombstone
  }
  let dropped = 0
  for (const [k] of node.versions) {
    if (node.state.has(k)) continue // a live cell's stamp is its guard — never GC'd
    node.versions.delete(k)
    dropped++
  }
  if (dropped) node.journal.armed && node.journal.emit(JK.tombstoneGC, dropped)
  return dropped
}

//! maybeCompact — the tick hook: size-armed, frontier-bounded, then the tombstone pass. One cheap
// length check per origin in the steady state.
export const maybeCompact = (node: Node) => {
  if (node.membership.view.members.length === 0) return
  //! M6 (armed): compaction and tombstone GC are PINNED until the handshake evidence plane (slice 3b)
  // feeds per-(origin, partition) attested marks — the member-ranged frontier above is unsound under
  // scoping (a non-holder's lane tail says nothing about a holder's possession, and vice versa), and
  // pinning is the safe direction (memory over loss; DESIGN-M6 C3 lands the scoped frontier: min over
  // holdersOf(p) ∪ announcers of the per-(o,p) stable marks, with acquiring holders contributing 0).
  if (node.armed) return
  for (const [o, entries] of node.logs) {
    if (entries.length < COMPACT_AT) continue
    const f = frontier(node, o)
    if (f > 0) compact(node, o, f)
  }
  gcTombstones(node)
}
