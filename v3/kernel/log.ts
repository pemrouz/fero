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
//   still fence (a slow resurrect). It is droppable once NO stale record can
//   freshly apply ANYWHERE: for every lane l, either every member's applied[l]
//   ≥ the stamp's seq (anything older is dedup-dropped on arrival), or the lane
//   is fully quiesced (every member holds its entire known history — nothing
//   old remains in flight). Once the version drops, the next compaction pass
//   drops the remove record itself (it is no longer its cell's winner-of-record).
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

//! frontier — the highest seq of origin `o` that EVERY committed-view member has provably applied
// (0 when unknown, when any member has announced nothing, or at open genesis).
export const frontier = (node: Node, o: string): number => {
  const members = node.membership.view.members
  if (members.length === 0) return 0
  let f = Infinity
  for (const [uuid] of members) {
    const s = uuid === node.uuid ? (node.streams.get(o)?.applied ?? 0) : node.confirm.mark(uuid, o)
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
  //! the straggler bound: for each lane, the oldest thing still deliverable anywhere — Infinity when
  // the lane is fully quiesced (every member at the lane's known tail: nothing old is in flight)
  let bound = Infinity
  const lanes = new Set<string>(node.logs.keys())
  for (const [l] of node.streams) lanes.add(l)
  for (const l of lanes) {
    let minApplied = Infinity
    let maxTail = node.streams.get(l)?.shippable ?? 0
    for (const [uuid] of members) {
      const s = uuid === node.uuid ? (node.streams.get(l)?.applied ?? 0) : node.confirm.mark(uuid, l)
      if (s < minApplied) minApplied = s
      if (s > maxTail) maxTail = s
    }
    if (minApplied >= maxTail) continue // lane quiesced — contributes no straggler bound
    if (minApplied < bound) bound = minApplied
  }
  let dropped = 0
  for (const [k, v] of node.versions) {
    if (node.state.has(k)) continue // a live cell's stamp is its guard — never GC'd
    if (v.seq <= bound) { node.versions.delete(k); dropped++ }
  }
  if (dropped) node.journal.armed && node.journal.emit(JK.tombstoneGC, dropped)
  return dropped
}

//! maybeCompact — the tick hook: size-armed, frontier-bounded, then the tombstone pass. One cheap
// length check per origin in the steady state.
export const maybeCompact = (node: Node) => {
  if (node.membership.view.members.length === 0) return
  for (const [o, entries] of node.logs) {
    if (entries.length < COMPACT_AT) continue
    const f = frontier(node, o)
    if (f > 0) compact(node, o, f)
  }
  gcTombstones(node)
}
