// L1 — per-partition append-only log of change records (durable history + replication source).

import { partitionOf, type ChangeRecord } from '../transport/message.ts'

export { partitionOf }

// The (origin,partition) composite key for scoped mode — \0-separated, shared with L2 so digests agree.
export const originKey = (origin: string, partition: string): string => origin + '\x00' + partition

// versionKey: the key a record contends on for LWW — `at` folded into the path → field-level LWW. Shared with L2 so compaction collapses EXACTLY the records L2 treats as one cell.
export const versionKey = (record: ChangeRecord): string => {
  const key = record.key
  if (record.at !== undefined) return key.length === 0 ? record.at : key.join('\x00') + '\x00' + record.at
  return key.length === 1 ? key[0] : key.join('\x00')
}

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

  // Compact: collapse superseded same-key UPDATES per partition (latest-update-per-key); off the hot path. Returns records dropped.
  compact({ min = 2 }: { min?: number } = {}): number {
    let dropped = 0
    for (const [p, seg] of this.#segments) {
      if (seg.length < min) continue
      let groups: Map<string, ChangeRecord[]> | undefined
      let nestedRemove = false
      for (const r of seg) {
        if (r.type === 'remove' && r.key.length >= 2) { nestedRemove = true; break }
        if (r.origin === undefined || r.type !== 'update' || r.key.length === 0) continue
        const gk = r.origin + '\x00' + versionKey(r)
        const g = (groups ??= new Map()).get(gk)
        if (g) g.push(r)
        else groups.set(gk, [r])
      }
      if (nestedRemove || !groups) continue
      // mark each group's strictly-superseded updates (a higher-seq update with epoch ≥ it) for dropping.
      let toDrop: Set<ChangeRecord> | undefined
      for (const g of groups.values()) {
        if (g.length < 2) continue
        g.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        let maxEpochAbove = -1
        for (let i = g.length - 1; i >= 0; i--) {
          const e = g[i].epoch ?? 0
          if (maxEpochAbove >= e) (toDrop ??= new Set()).add(g[i])
          if (e > maxEpochAbove) maxEpochAbove = e
        }
      }
      if (!toDrop || toDrop.size === 0) continue
      // rebuild the segment + the dropped records' index groups by object identity (order preserved → still seq-ascending).
      this.#segments.set(p, seg.filter((r) => !toDrop!.has(r)))
      const ikeys = new Set<string>()
      for (const r of toDrop) ikeys.add(this.#key(r))
      for (const ik of ikeys) {
        const grp = this.#index.get(ik)
        if (!grp) continue
        const ng = grp.filter((r) => !toDrop!.has(r))
        if (ng.length) this.#index.set(ik, ng)
        else this.#index.delete(ik)
      }
      dropped += toDrop.size
    }
    return dropped
  }

  // Total record count across every partition segment.
  get size(): number {
    let n = 0
    for (const seg of this.#segments.values()) n += seg.length
    return n
  }
}
