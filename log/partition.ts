// L1 — the per-partition append-only log of change records. A change record IS
// a log entry (no translation), so the log is just ordered records segmented by
// partition (top-level key). It is the durable history + the replication source:
//
//   • append(record)         — add a record to its partition's segment
//   • onAppend(fn)           — observe appends (the view + replication subscribe)
//   • heads() / since() / diff(base) — the offset-vector sync primitives (per-
//                              partition catch-up).
//   • recordsSince(vector)   — the per-ORIGIN anti-entropy primitive: given a
//                              peer's {origin→highest seq}, the records it lacks.
//                              This is what L2's catch-up ships on (re)connect.
//
// Segmenting by partition (not one flat log) means ownership — which moves
// per-partition via the DHT — maps cleanly onto log segments for rebalancing.
// A parallel per-origin index (records carry provenance since Milestone A) backs
// recordsSince: each origin's records arrive in strictly increasing seq order
// (the resource layer dedups before appending), so the index stays seq-sorted
// and a peer's missing tail is a binary-search slice.

import { partitionOf, type ChangeRecord } from '../transport/message.ts'

export { partitionOf }

export type AppendListener = (record: ChangeRecord, partition: string, offset: number) => void

export class Log {
  #segments = new Map<string, ChangeRecord[]>() // partition → ordered records
  #byOrigin = new Map<string, ChangeRecord[]>() // origin → records, seq-ascending
  #listeners = new Set<AppendListener>()

  // Append a record to its partition's segment; returns the partition's new head
  // (entry count). Notifies listeners synchronously. Records carrying provenance
  // are also threaded onto their origin's seq-ordered index (for recordsSince).
  append(record: ChangeRecord): number {
    const p = partitionOf(record)
    let seg = this.#segments.get(p)
    if (!seg) this.#segments.set(p, (seg = []))
    seg.push(record)
    if (record.origin !== undefined) {
      let byO = this.#byOrigin.get(record.origin)
      if (!byO) this.#byOrigin.set(record.origin, (byO = []))
      byO.push(record)
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

  // Per-origin high-water marks: { origin → highest seq held }. The digest a node
  // sends a peer so the peer can compute what to ship back.
  originHeads(): Record<string, number> {
    const v: Record<string, number> = {}
    for (const [origin, recs] of this.#byOrigin) v[origin] = recs.length ? (recs[recs.length - 1].seq ?? 0) : 0
    return v
  }

  // The anti-entropy delta: every record whose seq exceeds the peer's high-water
  // for that origin. Origins the peer has never seen (absent from `vector`) ship
  // in full. Output is grouped by origin, each group seq-ascending — ready for
  // provenance-preserving framing. Each origin's index is seq-sorted, so the
  // first record past the peer's mark is a binary search.
  recordsSince(vector: Record<string, number> = {}): ChangeRecord[] {
    const out: ChangeRecord[] = []
    for (const [origin, recs] of this.#byOrigin) {
      const mark = vector[origin] ?? 0
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
    return out
  }

  get size(): number {
    let n = 0
    for (const seg of this.#segments.values()) n += seg.length
    return n
  }
}
