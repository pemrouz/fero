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

//! SCOPED COMPACTION (DESIGN-SCALE stage 3, §4; the owner's yes, §14 Q2). On an ARMED node the member-ranged
// frontier above is unsound (a non-holder's lane tail says nothing about a holder's possession), so the pass was
// pinned until the handshake evidence plane fed per-(lane, partition) marks. It does now. Rule C, per lane o and
// partition p, entry e = (o, seq, p) drops iff:
//   C1  p is HELD and SEALED here with no latch open — an orphan is frozen (its content tails are the shed evidence),
//       an acquiring or unsealed base attests nothing, so none of them compacts;
//   C2  e is not its cell's current winner (the test below; a remove is a winner while its tombstone lives, so it
//       stays until stage 4 releases it; V4-18: a field a row write swept carries the row's stamp, so its entry is a
//       loser; a fenced field remove keeps its stamp and its entry);
//   C3  seq ≤ F(o, p) = the minimum over every CURRENT holder of p, self included, of its CRASH-STABLE attested
//       floor for (o, p): self reads its durable floor when durable, else its possession floor; a peer reads the
//       marks it announced through the handshake (kernel/scope.ts stableMark: durable marks for a peer that has
//       announced any, volatile for a memory peer). Absent is 0 and pins; so an acquiring or unsealed holder, which
//       attests nothing this epoch, pins F at 0. Orphans are not in F (they never advance and never learn);
//   C4  e is not the lane's last entry: the digest to a client reports the lane tail as the last entry's seq, and a
//       spoke resyncs when its applied runs past its feeder's tail, so the tail entry keeps the spoke contract.
// Why F holds when the holder set can change: it ranges over the holders at the pass; every one of them holds or
// covers e; a future holder learns through the one-teacher fold (its cut sets its floors, its records are the
// winners), never through a seq chain, since stage 2 retired the member digest's suffixes; the stored pp chains of
// later entries are needed only by nodes below F, and there are none among the current holders. A lane holds each
// seq once and the fence covers its tail (the lane rule, wave 6b), so a pass reasons about lanes as sets.
// ONE predicate, keep(), decides what compaction keeps AND what a teacher ships (kernel/scope.ts #teach): the
// learner's fold equals the teacher's state while a pass is mid-way, and in stage 4 a released cell's dead entry
// is shipped to nobody. In stage 3 the acquiring learner itself pins the teacher's F at 0 (C3), so the teacher
// ships everything above the learner's marks, as before: the filter bites the day a stamp is released.
// Tombstone GC stays PINNED while armed (stage 4: census + holder quorum + lane accounting).
// The memo: a lane at or over compactAt whose pass dropped nothing is not re-walked until its length or the
// evidence changes (Scope.evidence: a counter bumped where a mark rises or is voided, at an install, a seal, a fold,
// a shed, and where a durable floor advances) — keyed on BOTH, since a memo on length alone can stop compaction
// for good when F was pinned at the pass (the storage critique). A winner on lane o that a newer record on ANOTHER
// lane supersedes waits for the next evidence change or growth of lane o; under writes marks move every tick.

import { JK } from './journal.ts'
import { partitionOf } from './env.ts'
import { SCOPE } from './scope.ts'
import type { Node, LogEntry } from './node.ts'

//! COMPACT_AT: per-origin entry count that arms a compaction pass (the size-aware trigger). The default of the tune row `compactAt` (kernel/tune.ts); maybeCompact reads node.tune.compactAt.
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

//! winner — C2: is entry e of lane o still the current winner of its cell (its stamp is the cell's version)?
export const winner = (node: Node, o: string, e: LogEntry): boolean => {
  const v = node.versions.get(JSON.stringify(e.rec.key.length ? e.rec.key : [e.rec.at ?? '']))
  return v !== undefined && v.origin === o && v.seq === e.seq && v.epoch === e.epoch
}

//! compact — rewrite origin `o`'s prefix ≤ upTo: keep each entry only if it is still the current
// winner of its cell (the snapshot record, original stamps — attempt identity kept so catch-up feeds
// dedup windows too); drop the rest. Returns the number of entries dropped. Ascending order is
// preserved by construction (a filtered subsequence of an ascending log). The UNSCOPED pass (and the
// tests that drive a pass by hand); an armed node compacts through compactScoped below.
export const compact = (node: Node, o: string, upTo: number): number => {
  const entries = node.logs.get(o)
  if (!entries || entries.length === 0) return 0
  const kept: typeof entries = []
  let dropped = 0
  let gone: typeof entries | null = null // the dropped entries, for the per-partition index (scoped only)
  for (const e of entries) {
    if (e.seq > upTo || winner(node, o, e)) kept.push(e)
    else { dropped++; if (node.byPart !== null) (gone ??= []).push(e) }
  }
  if (dropped) {
    node.logs.set(o, kept)
    if (gone !== null) node.indexDrop(o, gone)
    node.journal.armed && node.journal.emit(JK.compacted, o, dropped)
  }
  return dropped
}

//! scopedFrontier — F(o, p) at an armed node (C1 + C3 of the banner): the highest seq of lane o that every
// CURRENT holder of p, self included, has attested it is past, on crash-stable floors. 0 (nothing may drop) when
// p is not held and sealed here, when self is not among p's holders, or when any holder's mark is absent.
export const scopedFrontier = (node: Node, o: string, p: string): number => {
  const scope = node.scope!
  const e = scope.entries.get(p)
  if (e === undefined || e.state !== SCOPE.held || e.sealed === false) return 0 // C1: orphans, acquiring, unsealed never
  const pe = node.streams.get(o)?.parts?.get(p)
  let f = pe === undefined ? 0 : node.durable ? pe.d : pe.s
  if (f === 0) return 0
  const ring = node.writes.ring
  if (ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
  let mine = false
  for (const h of ring.holders(p, node.replicas)) {
    if (h === node.uuid) { mine = true; continue }
    const m = scope.stableMark(node, e, h, o)
    if (m < f) { f = m; if (f === 0) return 0 }
  }
  return mine ? f : 0
}

//! keep — THE ONE predicate (C2-C4): entry e of lane o stays when it is the lane's last entry, above the
// frontier f for its partition, or the current winner of its cell. compactScoped keeps exactly these; the
// teacher (kernel/scope.ts #teach) ships exactly these above the learner's marks.
export const keep = (node: Node, o: string, e: LogEntry, f: number, last: boolean): boolean =>
  last || e.seq > f || winner(node, o, e)

//! compactScoped — one pass over lane o at an armed node: F per partition memoized for the pass, the entries
// keep() refuses dropped, the per-partition index following, one `compacted` row per lane per pass (a=lane,
// b=entries dropped, c=the partitions dropped from — a count, not a name: a pass over a lane holding thousands
// of partitions would otherwise flood the bounded journal ring with one row each and evict everything else), and
// the durable snapshot armed (node.compacted) so the compacted lane reaches disk atomically and the boot record's
// floor seed is written when that swap is issued (replay chains from the seed, and compaction opened pp gaps below it).
// Returns the number of entries dropped.
export const compactScoped = (node: Node, o: string): number => {
  const entries = node.logs.get(o)
  if (!entries || entries.length === 0) return 0
  const F = new Map<string, number>()
  const kept: typeof entries = []
  let gone: typeof entries | null = null
  let parts: Set<string> | null = null
  const last = entries.length - 1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (i === last) { kept.push(e); continue } // C4
    const p = partitionOf(e.rec)
    let f = F.get(p)
    if (f === undefined) F.set(p, f = scopedFrontier(node, o, p))
    if (keep(node, o, e, f, false)) { kept.push(e); continue }
    ;(gone ??= []).push(e)
    ;(parts ??= new Set()).add(p)
  }
  if (gone === null) return 0
  node.logs.set(o, kept)
  node.indexDrop(o, gone)
  node.compacted()
  node.journal.armed && node.journal.emit(JK.compacted, o, gone.length, parts!.size)
  return gone.length
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
    //! V4-18: a field remove stamped above a row that is still live is a fact a late joiner needs (the
    // row's value still carries that field) — its stamp stays, so compaction keeps its entry
    if (node.fenced(k)) continue
    node.versions.delete(k)
    node.unlink(k)
    node.tombDrop(k) // the tombstone index follows (scoped only; unreachable while armed, kept exact anyway)
    dropped++
  }
  if (dropped) node.journal.armed && node.journal.emit(JK.tombstoneGC, dropped)
  return dropped
}

//! maybeCompact — the tick hook: size-armed, frontier-bounded, then (unscoped) the tombstone pass. One cheap
// length check per origin in the steady state.
export const maybeCompact = (node: Node) => {
  if (node.membership.view.members.length === 0) return
  //! ARMED (DESIGN-SCALE stage 3): the per-(lane, partition) frontier over the current holders' crash-stable
  // attested marks (the banner's rule C), one lane at a time, the memo skipping a lane the last pass could not
  // advance. Tombstone GC stays PINNED under scoping until stage 4 (the global-quiescence rule below never
  // settles at scale and is unsound under scoping): memory over loss, journal-visible in the tombstone count.
  if (node.armed) {
    const scope = node.scope!
    const compactAt = node.tune.compactAt
    for (const [o, entries] of node.logs) {
      if (entries.length < compactAt) continue
      const m = scope.memo.get(o)
      if (m !== undefined && m.len === entries.length && m.v === scope.evidence) continue
      compactScoped(node, o)
      scope.memo.set(o, { len: node.logs.get(o)!.length, v: scope.evidence })
    }
    return
  }
  const compactAt = node.tune.compactAt
  for (const [o, entries] of node.logs) {
    if (entries.length < compactAt) continue
    const f = frontier(node, o)
    if (f > 0) compact(node, o, f)
  }
  gcTombstones(node)
}
