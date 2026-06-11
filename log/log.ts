//! L1 — per-partition append-only log of change records (durable history + replication source).
// L1 — the per-partition append-only log of change records. A change record IS
// a log entry (no translation), so the log is just ordered records segmented by
// partition (top-level key). It is the durable history + the replication source:
//
//   • append(record)         — add a record to its partition's segment
//   • onAppend(fn)           — observe appends (the view + replication subscribe)
//   • heads() / since() / diff(base) — the offset-vector sync primitives (per-
//                              partition catch-up).
//   • recordsSince(vector)   — the anti-entropy primitive: given a peer's
//                              {key→highest seq} high-water vector, the records it
//                              lacks. This is what L2's catch-up ships on
//                              (re)connect. The vector's KEY GRANULARITY follows
//                              the holding mode (see `scoped` below).
//   • marks()                — this log's own high-water vector (the digest a node
//                              would send), in the same key granularity.
//
// Segmenting by partition (not one flat log) means ownership — which moves
// per-partition via the DHT — maps cleanly onto log segments for rebalancing.
// A parallel provenance index (records carry origin+seq since Milestone A) backs
// recordsSince: each stream arrives in strictly increasing seq order (the resource
// layer dedups before appending), so the index stays seq-sorted and a peer's
// missing tail is a binary-search slice.
//
// Granularity (Milestone P). Under FULL replication the index is keyed by ORIGIN:
// every node holds every partition, so an origin's whole seq stream is one
// contiguous in-order run — a compact O(origins) digest, and catch-up frames
// coalesce into one. Under SCOPED holding (finite R) a node materializes only the
// partitions it replicates, so it sees just a SUBSET of an origin's writes; a
// per-origin mark would then conflate partitions — a node that acquires a
// partition on rebalance, or misses one, couldn't tell what's missing and catch-up
// would silently drop records. So `scoped` mode keys the index by
// (ORIGIN,PARTITION): each partition's stream is independently complete (its single
// owner is one in-order source), the digest is naturally bounded to the partitions
// the node holds, and a newly-held partition re-syncs from seq 0. The mode is fixed
// at construction (R is fixed per resource), so only ONE index is ever maintained —
// full replication keeps the per-origin path byte-for-byte and pays nothing.

import { partitionOf, type ChangeRecord } from '../transport/message.ts'

export { partitionOf }

//! The (origin,partition) composite key for scoped mode — \0-separated, shared with L2 so digests agree.
// The (origin,partition) composite key for scoped mode: origin is a uuid,
// partition a top-level key — neither contains \0, the separator the resource's
// versionKey also relies on. Shared with L2 so the digest a node sends and the
// records a peer ships back agree on the key byte-for-byte.
export const originKey = (origin: string, partition: string): string => origin + '\x00' + partition

//! versionKey: the key a record contends on for LWW — `at` folded into the path → field-level LWW. Shared with L2 so compaction collapses EXACTLY the records L2 treats as one cell.
// The key path a record contends on for last-writer-wins. An insert folds `at`
// into the path so an insert and a later update to the same key contend as one
// key; distinct leaves (k1 vs k1.score) are independent → field-level LWW. The
// single-segment cases (top-level set, whether insert or update) reuse an existing
// string — no `join` allocation on the hot path. Lives here (not L2) because
// compaction's notion of "the same cell" MUST be byte-identical to L2's LWW key —
// sharing the one definition is what guarantees they can never drift (a coarser
// compaction key would over-collapse and lose data; see compact()).
export const versionKey = (record: ChangeRecord): string => {
  const key = record.key
  if (record.at !== undefined) return key.length === 0 ? record.at : key.join('\x00') + '\x00' + record.at
  return key.length === 1 ? key[0] : key.join('\x00')
}

export type AppendListener = (record: ChangeRecord, partition: string, offset: number) => void

//! Log construction opts — `scoped` fixes the provenance-index granularity (full vs finite-R holding).
export type LogOpts = {
  // false (default): index by origin — full-replication anti-entropy (compact).
  // true: index by (origin,partition) — scoped-holding anti-entropy (Milestone P).
  scoped?: boolean
}

export class Log {
  #segments = new Map<string, ChangeRecord[]>() //! partition → ordered records
  #index = new Map<string, ChangeRecord[]>() //! provenance key (origin OR origin\0partition) → records, seq-ascending
  #listeners = new Set<AppendListener>()
  #scoped: boolean

  constructor({ scoped = false }: LogOpts = {}) {
    this.#scoped = scoped
  }

  //! The provenance-index key for a record: origin (full) or origin\0partition (scoped).
  // The provenance-index key for a record: origin (full) or origin\0partition
  // (scoped). Callers of marks()/recordsSince() build their vector with the same
  // granularity (full replication ⇒ per-origin; finite R ⇒ per-(origin,partition)).
  #key(record: ChangeRecord): string {
    return this.#scoped ? originKey(record.origin!, partitionOf(record)) : record.origin!
  }

  //! Append a record to its partition segment, thread it onto the provenance index, notify listeners; returns new head.
  // Append a record to its partition's segment; returns the partition's new head
  // (entry count). Notifies listeners synchronously. Records carrying provenance
  // are also threaded onto their seq-ordered provenance index (for recordsSince).
  append(record: ChangeRecord): number {
    const p = partitionOf(record)
    let seg = this.#segments.get(p)
    if (!seg) this.#segments.set(p, (seg = []))
    seg.push(record)
    if (record.origin !== undefined) {
      const k = this.#key(record)
      let idx = this.#index.get(k)
      if (!idx) this.#index.set(k, (idx = []))
      idx.push(record)
    }
    const head = seg.length
    for (const fn of this.#listeners) fn(record, p, head)
    return head
  }

  //! Observe appends (the view + replicator subscribe here); returns an unsubscribe.
  // Observe appends. Returns an unsubscribe. (Internal plumbing, not a public
  // event — the view and the replicator subscribe here.)
  onAppend(fn: AppendListener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  //! Current head (entry count) of a partition.
  head(partition: string): number {
    return this.#segments.get(partition)?.length ?? 0
  }

  //! The offset vector { partition → head } — a peer sends this, we reply with diff(theirHeads).
  // The offset vector: { partition → head } across all partitions. A peer sends
  // this; we reply with diff(theirHeads).
  heads(): Record<string, number> {
    const h: Record<string, number> = {}
    for (const [p, seg] of this.#segments) h[p] = seg.length
    return h
  }

  //! Records appended to `partition` at or after `offset` (the catch-up tail).
  since(partition: string, offset: number): ChangeRecord[] {
    const seg = this.#segments.get(partition)
    return seg ? seg.slice(offset) : []
  }

  //! Full delta past the caller's per-partition offsets — partitions absent from `base` stream from 0.
  // Every record past the caller's per-partition offsets — the full delta to
  // bring a peer at `base` up to our head. Partitions the caller hasn't seen
  // (absent from base) stream from 0.
  diff(base: Record<string, number> = {}): ChangeRecord[] {
    const out: ChangeRecord[] = []
    for (const [p, seg] of this.#segments) {
      for (let i = base[p] ?? 0; i < seg.length; i++) out.push(seg[i])
    }
    return out
  }

  partitions(): string[] {
    return [...this.#segments.keys()]
  }

  //! Shed a partition (segment + index entries) so it stops appearing in marks — scoped-only (P4).
  // Drop a partition entirely — its segment AND its provenance-index entries — when
  // a node SHEDS a partition it no longer replicates (Milestone P4). Scoped-only:
  // the index is keyed (origin,partition) so a partition's groups are removable; in
  // full mode there's nothing to shed (every node holds every partition). After this
  // the node no longer claims the partition in its digest (marks), so a stale shed
  // copy can't mislead anti-entropy.
  drop(partition: string): void {
    this.#segments.delete(partition)
    if (!this.#scoped) return
    const suffix = '\x00' + partition // index keys are origin\0partition; the \0 anchors the match
    for (const key of this.#index.keys()) if (key.endsWith(suffix)) this.#index.delete(key)
  }

  //! This log's high-water marks { provenance-key → highest seq } — the digest a node sends for anti-entropy.
  // This log's high-water marks: { provenance-key → highest seq held }. The digest
  // a node sends a peer so the peer can compute what to ship back. Per-origin in
  // full mode, per-(origin,partition) in scoped mode (then naturally bounded to the
  // partitions this node holds — it only has records for those).
  marks(): Record<string, number> {
    const v: Record<string, number> = {}
    for (const [key, recs] of this.#index) v[key] = recs.length ? (recs[recs.length - 1].seq ?? 0) : 0
    return v
  }

  //! Anti-entropy delta: every record whose seq exceeds the peer's mark (binary-search slice per index group).
  // The anti-entropy delta: every record whose seq exceeds the peer's high-water
  // for its provenance key. Keys the peer has never seen (absent from `vector`)
  // ship in full — so a partition acquired on rebalance re-syncs from the start.
  // Each index group is seq-sorted, so the first record past the peer's mark is a
  // binary search. In scoped mode the groups are per (origin,partition); the output
  // is re-sorted by (origin,seq) so an origin's records across partitions coalesce
  // into the fewest frames (encodeFrames breaks a run on an origin change or a
  // seq gap), recovering the single-frame full-replication behavior wherever the
  // held partitions' seqs happen to be contiguous.
  recordsSince(vector: Record<string, number> = {}): ChangeRecord[] {
    const out: ChangeRecord[] = []
    for (const [key, recs] of this.#index) {
      const mark = vector[key] ?? 0
      // binary search for the first index whose seq > mark
      let lo = 0
      let hi = recs.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if ((recs[mid].seq ?? 0) <= mark) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < recs.length; i++) out.push(recs[i])
    }
    //! Scoped mode: re-sort by (origin,seq) so an origin's cross-partition records coalesce into the fewest frames.
    if (this.#scoped)
      out.sort((a, b) => (a.origin! < b.origin! ? -1 : a.origin! > b.origin! ? 1 : (a.seq ?? 0) - (b.seq ?? 0)))
    return out
  }

  //! Compact: collapse superseded same-key UPDATES per partition (latest-update-per-key); off the hot path. Returns records dropped.
  // Bound the log against high-churn keys: a key written N times accumulates N
  // records even though only the latest value is live (under owner-routing those
  // N records mostly share ONE origin — the owner — so this collapses them). We
  // drop a record D ONLY when it is strictly superseded within its own origin's
  // stream, leaving the proxy (the source of truth at L2) and seq-keyed catch-up
  // exactly correct. The append path is untouched — this runs on an unref'd timer.
  //
  // WHY ONLY `update`s (the safety crux — three traps this avoids):
  //  • An `insert` is POSITIONAL — two same-`at` array inserts are DISTINCT live
  //    elements (each splices/shifts), not an overwrite, so collapsing them by
  //    versionKey would delete a real element. Inserts are never dropped.
  //  • A `remove` is a TOMBSTONE. data's res.remove of a NESTED path (key.length≥2)
  //    THROWS when an ancestor is absent — and dropping any update that vivified that
  //    ancestor (the dropped update can sit BEFORE a remove that re-removes the path
  //    in a set/delete/set cycle) would leave the remove to replay against a missing
  //    ancestor and crash catch-up. So a partition whose segment holds ANY nested
  //    remove is left untouched this pass (below): with no nested remove, no replay
  //    can hit an absent ancestor whatever we drop (a top-level remove of a missing
  //    key is already a no-op). Removes themselves are never dropped.
  //  • Two `update`s to the same path ARE an idempotent overwrite of one cell, and
  //    a nested update auto-vivifies its ancestors on replay, so keeping just the
  //    LWW winner reconstructs identical state. This is the collapsible case.
  //
  // SUPERSESSION is LWW dominance within an (origin,versionKey) group, NOT raw
  // max-seq: drop D iff a HIGHER-seq update S with epoch ≥ D.epoch exists (same
  // origin, so (epoch,seq) decides). The epoch guard matters on a stable-uuid
  // restart, where the Lamport clock is restored but the view epoch resets — a
  // higher-seq local write can then carry a LOWER epoch than a restored record, so
  // it is NOT the winner; max-seq would drop the true winner. Because we drop only
  // when a STRICTLY-higher-seq survivor exists, a group's overall-highest-seq record
  // is never dropped — so marks() (= last index entry's seq) is preserved EXACTLY,
  // and P4 shed-confirmation (which gates on log.marks()) is undisturbed.
  compact({ min = 2 }: { min?: number } = {}): number {
    //! drops accumulate ACROSS partitions; each affected index group is rebuilt ONCE at the end.
    // Under full replication #key(r) is the bare origin, so an origin's index group spans every
    // partition it ever wrote — rebuilding it inside the per-partition loop re-filtered that
    // whole group once PER compacted partition: K churned partitions × O(origin's total records)
    // ≈ quadratic, synchronously inside the 30s timer tick. Deferring the index rebuild to one
    // union-set pass makes the whole sweep O(total records), identical drops.
    let allDrop: Set<ChangeRecord> | undefined
    for (const [p, seg] of this.#segments) {
      if (seg.length < min) continue // nothing to collapse below a pair
      // Group candidate records — origin-bearing real-path updates — by (origin,versionKey).
      // A NESTED remove (key.length≥2) in this segment makes the whole partition
      // non-compactable: dropping a vivifier of its ancestor would crash replay (see above).
      let groups: Map<string, ChangeRecord[]> | undefined
      let nestedRemove = false
      for (const r of seg) {
        if (r.type === 'remove' && r.key.length >= 2) { nestedRemove = true; break }
        if (r.origin === undefined || r.type !== 'update' || r.key.length === 0) continue
        const gk = r.origin + '\x00' + versionKey(r) // origin has no \0 → injective
        const g = (groups ??= new Map()).get(gk)
        if (g) g.push(r)
        else groups.set(gk, [r])
      }
      if (nestedRemove || !groups) continue
      //! mark each group's strictly-superseded updates (a higher-seq update with epoch ≥ it) for dropping.
      let toDrop: Set<ChangeRecord> | undefined
      for (const g of groups.values()) {
        if (g.length < 2) continue
        g.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) // seqs are unique per origin; ascending
        let maxEpochAbove = -1 // max epoch among strictly-higher-seq records seen so far
        for (let i = g.length - 1; i >= 0; i--) {
          const e = g[i].epoch ?? 0
          if (maxEpochAbove >= e) (toDrop ??= new Set()).add(g[i]) // a higher-seq, ≥-epoch update dominates → dead
          if (e > maxEpochAbove) maxEpochAbove = e
        }
      }
      if (!toDrop || toDrop.size === 0) continue
      //! rebuild the segment now (order preserved → still seq-ascending); fold the drops into the union.
      this.#segments.set(p, seg.filter((r) => !toDrop!.has(r))) // never empties: each group keeps its max + all non-candidates survive
      if (allDrop) for (const r of toDrop) allDrop.add(r)
      else allDrop = toDrop
    }
    if (!allDrop) return 0
    //! one pass over the AFFECTED index groups — each filtered exactly once against the union, however many partitions fed it.
    const ikeys = new Set<string>()
    for (const r of allDrop) ikeys.add(this.#key(r)) // origin (full) or origin\0partition (scoped)
    for (const ik of ikeys) {
      const grp = this.#index.get(ik)
      if (!grp) continue
      const ng = grp.filter((r) => !allDrop.has(r))
      if (ng.length) this.#index.set(ik, ng)
      else this.#index.delete(ik)
    }
    return allDrop.size
  }

  //! Total record count across every partition segment.
  get size(): number {
    let n = 0
    for (const seg of this.#segments.values()) n += seg.length
    return n
  }
}
