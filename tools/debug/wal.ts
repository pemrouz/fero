// ════════════════════════════════════════════════════════════════════════
// wal — read the durable WAL as the debug viewer's ACCURATE-history source.
//
// The in-memory log COMPACTS to stay bounded ([log.ts](../../log/log.ts)
// compact()), so reconstructing history from a live snapshot is lossy: a
// partition's first write can be gone, and foldOwnership back-projects the
// CURRENT partition set onto every past view — fabricating a pre-birth owner,
// so a partition's BIRTH gets miscounted as an ownership MOVE.
//
// The persistence WAL ([resource/storage.ts](../../resource/storage.ts) →
// fileStorage) is the SAME change records, one JSON line each, kept UNCOMPACTED
// on disk (DECISIONS C; WAL-compaction deferred). So it carries the TWO history
// facts a compacted snapshot loses — and foldWal folds the raw records
// (exactly what fileStorage.load() returns) into them:
//   • births — each partition's earliest (epoch,seq), so the owner-timeline can
//     ANCHOR at birth instead of back-projecting (move vs placement, honestly).
//   • log    — each partition's ordered records (superseded values included —
//     we WANT the full history here), so the viewer's log panel + divergence
//     replay read REAL records, not the rows shape.js synthesizes when a
//     snapshot carries none.
//
// Pure + dependency-light (only the record shape + partitionOf) — a reader or
// test folds a captured WAL with no live cluster. This is the data half;
// ownership still needs the view-change + ring-config records (the journal's
// `view` kind — IDEAS "Debug history over the WAL"), which the WAL doesn't
// carry yet.
// ════════════════════════════════════════════════════════════════════════

import { partitionOf, type ChangeRecord } from '../../transport/message.ts'

//! WalDigest: the two history facts a compacted snapshot loses — per-partition birth stamp + ordered records.
export type WalDigest = {
  births: Record<string, { epoch: number; seq: number }> // partition → earliest (epoch,seq) seen
  log: Record<string, ChangeRecord[]> // partition → records, in WAL (append) order
}

//! foldWal: raw WAL change records → per-partition births + ordered log (the uncompacted-history projection).
// Birth = the LOWEST (epoch,seq) across a partition's records. Epoch is the
// PRIMARY key: the cluster view-epoch is monotonic, so the smallest epoch is the
// view a partition first appeared under — exactly what the owner-timeline anchors
// on. seq only breaks ties within one epoch. We take the min rather than trusting
// the first appended line because after an ownership HANDOFF a partition's records
// interleave two origins' independent (reset) seq streams, so the file's first
// line for a partition isn't necessarily its earliest write.
export function foldWal(records: ChangeRecord[]): WalDigest {
  const births: Record<string, { epoch: number; seq: number }> = {}
  const log: Record<string, ChangeRecord[]> = {}
  for (const r of records) {
    const p = partitionOf(r)
    ;(log[p] ??= []).push(r)
    const e = r.epoch ?? 0
    const s = r.seq ?? 0
    const b = births[p]
    if (!b || e < b.epoch || (e === b.epoch && s < b.seq)) births[p] = { epoch: e, seq: s }
  }
  return { births, log }
}

//! birthEpochs: collapse a digest to partition → birth-epoch — what foldOwnership needs to gate pre-birth owners.
export const birthEpochs = (digest: WalDigest): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const p in digest.births) out[p] = digest.births[p].epoch
  return out
}
