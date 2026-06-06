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

// The (origin,partition) composite key for scoped mode: origin is a uuid,
// partition a top-level key — neither contains \0, the separator the resource's
// versionKey also relies on. Shared with L2 so the digest a node sends and the
// records a peer ships back agree on the key byte-for-byte.
export const originKey = (origin: string, partition: string): string => origin + '\x00' + partition

export type AppendListener = (record: ChangeRecord, partition: string, offset: number) => void

export type LogOpts = {
  // false (default): index by origin — full-replication anti-entropy (compact).
  // true: index by (origin,partition) — scoped-holding anti-entropy (Milestone P).
  scoped?: boolean
}

export class Log {
  #segments = new Map<string, ChangeRecord[]>() // partition → ordered records
  #index = new Map<string, ChangeRecord[]>() // provenance key (origin OR origin\0partition) → records, seq-ascending
  #listeners = new Set<AppendListener>()
  #scoped: boolean

  constructor({ scoped = false }: LogOpts = {}) {
    this.#scoped = scoped
  }

  // The provenance-index key for a record: origin (full) or origin\0partition
  // (scoped). Callers of marks()/recordsSince() build their vector with the same
  // granularity (full replication ⇒ per-origin; finite R ⇒ per-(origin,partition)).
  #key(record: ChangeRecord): string {
    return this.#scoped ? originKey(record.origin!, partitionOf(record)) : record.origin!
  }

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

  // Observe appends. Returns an unsubscribe. (Internal plumbing, not a public
  // event — the view and the replicator subscribe here.)
  onAppend(fn: AppendListener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  // Current head (entry count) of a partition.
  head(partition: string): number {
    return this.#segments.get(partition)?.length ?? 0
  }

  // The offset vector: { partition → head } across all partitions. A peer sends
  // this; we reply with diff(theirHeads).
  heads(): Record<string, number> {
    const h: Record<string, number> = {}
    for (const [p, seg] of this.#segments) h[p] = seg.length
    return h
  }

  // Records appended to `partition` at or after `offset` (the catch-up tail).
  since(partition: string, offset: number): ChangeRecord[] {
    const seg = this.#segments.get(partition)
    return seg ? seg.slice(offset) : []
  }

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

  // This log's high-water marks: { provenance-key → highest seq held }. The digest
  // a node sends a peer so the peer can compute what to ship back. Per-origin in
  // full mode, per-(origin,partition) in scoped mode (then naturally bounded to the
  // partitions this node holds — it only has records for those).
  marks(): Record<string, number> {
    const v: Record<string, number> = {}
    for (const [key, recs] of this.#index) v[key] = recs.length ? (recs[recs.length - 1].seq ?? 0) : 0
    return v
  }

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
    if (this.#scoped)
      out.sort((a, b) => (a.origin! < b.origin! ? -1 : a.origin! > b.origin! ? 1 : (a.seq ?? 0) - (b.seq ?? 0)))
    return out
  }

  get size(): number {
    let n = 0
    for (const seg of this.#segments.values()) n += seg.length
    return n
  }
}
