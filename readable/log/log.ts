// L1 — per-partition append-only log of change records (durable history + replication source).

import { partitionOf, type ChangeRecord } from '../transport/message.ts'

export { partitionOf }

// The (origin,partition) composite key for scoped mode — \0-separated, shared with L2 so digests agree.
export const originKey = (origin: string, partition: string): string => origin + '\x00' + partition

export type AppendListener = (record: ChangeRecord, partition: string, offset: number) => void

// Log construction opts — `scoped` fixes the provenance-index granularity (full vs finite-R holding).
export type LogOpts = {
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

  // The provenance-index key for a record: origin (full) or origin\0partition (scoped).
  #key(record: ChangeRecord): string {
    return this.#scoped ? originKey(record.origin!, partitionOf(record)) : record.origin!
  }

  // Append a record to its partition segment, thread it onto the provenance index, notify listeners; returns new head.
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

  // Observe appends (the view + replicator subscribe here); returns an unsubscribe.
  onAppend(fn: AppendListener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  // Current head (entry count) of a partition.
  head(partition: string): number {
    return this.#segments.get(partition)?.length ?? 0
  }

  // The offset vector { partition → head } — a peer sends this, we reply with diff(theirHeads).
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

  // Full delta past the caller's per-partition offsets — partitions absent from `base` stream from 0.
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

  // Shed a partition (segment + index entries) so it stops appearing in marks — scoped-only (P4).
  drop(partition: string): void {
    this.#segments.delete(partition)
    if (!this.#scoped) return
    const suffix = '\x00' + partition
    for (const key of this.#index.keys()) if (key.endsWith(suffix)) this.#index.delete(key)
  }

  // This log's high-water marks { provenance-key → highest seq } — the digest a node sends for anti-entropy.
  marks(): Record<string, number> {
    const v: Record<string, number> = {}
    for (const [key, recs] of this.#index) v[key] = recs.length ? (recs[recs.length - 1].seq ?? 0) : 0
    return v
  }

  // Anti-entropy delta: every record whose seq exceeds the peer's mark (binary-search slice per index group).
  recordsSince(vector: Record<string, number> = {}): ChangeRecord[] {
    const out: ChangeRecord[] = []
    for (const [key, recs] of this.#index) {
      const mark = vector[key] ?? 0
      let lo = 0
      let hi = recs.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if ((recs[mid].seq ?? 0) <= mark) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < recs.length; i++) out.push(recs[i])
    }
    // Scoped mode: re-sort by (origin,seq) so an origin's cross-partition records coalesce into the fewest frames.
    if (this.#scoped)
      out.sort((a, b) => (a.origin! < b.origin! ? -1 : a.origin! > b.origin! ? 1 : (a.seq ?? 0) - (b.seq ?? 0)))
    return out
  }

  // Total record count across every partition segment.
  get size(): number {
    let n = 0
    for (const seg of this.#segments.values()) n += seg.length
    return n
  }
}
