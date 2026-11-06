// Port of go.etcd.io/raft/v3/storage.go at c51f010 (Storage and MemoryStorage).
// Go's (value, error) pairs are [value, Error | null] tuples; errors are sentinels.
import {
  Entry, type HardState, type ConfState, type Snapshot, EnsureSnapshot, EnsureConfState, cloneSnapshot, cloneConfState,
} from './raftpb.ts'
import { getLogger } from './logger.ts'
import { limitSize } from './util.ts'

export const ErrCompacted = new Error('requested index is unavailable due to compaction')
export const ErrSnapOutOfDate = new Error('requested index is older than the existing snapshot')
export const ErrUnavailable = new Error('requested entry at index is unavailable')
export const ErrSnapshotTemporarilyUnavailable = new Error('snapshot is temporarily unavailable')

export interface Storage {
  InitialState(): [HardState | null, ConfState, Error | null]
  Entries(lo: number, hi: number, maxSize: number): [Entry[], Error | null]
  Term(i: number): [number, Error | null]
  LastIndex(): [number, Error | null]
  FirstIndex(): [number, Error | null]
  Snapshot(): [Snapshot | null, Error | null]
}

export class MemoryStorage implements Storage {
  hardState: HardState | null = null
  snapshot: Snapshot
  ents: Entry[]
  callStats = { initialState: 0, firstIndex: 0, lastIndex: 0, entries: 0, term: 0, snapshot: 0 }

  constructor() {
    this.ents = [new Entry()]
    this.snapshot = EnsureSnapshot(undefined)
  }

  InitialState(): [HardState | null, ConfState, Error | null] {
    this.callStats.initialState++
    const cs = EnsureConfState(this.snapshot.Metadata?.ConfState)
    return [this.hardState, cs, null]
  }

  SetHardState(st: HardState): Error | null {
    this.hardState = st
    return null
  }

  Entries(lo: number, hi: number, maxSize: number): [Entry[], Error | null] {
    this.callStats.entries++
    const offset = this.ents[0].GetIndex()
    if (lo <= offset) return [[], ErrCompacted]
    if (hi > this.lastIndex() + 1) getLogger().Panicf("entries' hi(%d) is out of bound lastindex(%d)", hi, this.lastIndex())
    if (this.ents.length === 1) return [[], ErrUnavailable]
    const ents = limitSize(this.ents.slice(lo - offset, hi - offset), maxSize)
    return [ents, null]
  }

  Term(i: number): [number, Error | null] {
    this.callStats.term++
    const offset = this.ents[0].GetIndex()
    if (i < offset) return [0, ErrCompacted]
    if (i - offset >= this.ents.length) return [0, ErrUnavailable]
    return [this.ents[i - offset].GetTerm(), null]
  }

  LastIndex(): [number, Error | null] {
    this.callStats.lastIndex++
    return [this.lastIndex(), null]
  }

  lastIndex(): number {
    return this.ents[0].GetIndex() + this.ents.length - 1
  }

  FirstIndex(): [number, Error | null] {
    this.callStats.firstIndex++
    return [this.firstIndex(), null]
  }

  firstIndex(): number {
    return this.ents[0].GetIndex() + 1
  }

  Snapshot(): [Snapshot | null, Error | null] {
    this.callStats.snapshot++
    this.snapshot = EnsureSnapshot(this.snapshot)
    return [cloneSnapshot(this.snapshot), null]
  }

  ApplySnapshot(snap: Snapshot): Error | null {
    snap = EnsureSnapshot(snap)
    const msIndex = this.snapshot.Metadata?.GetIndex() ?? 0
    const snapIndex = snap.Metadata!.GetIndex()
    if (msIndex !== 0 && msIndex >= snapIndex) return ErrSnapOutOfDate
    this.snapshot = cloneSnapshot(snap)
    this.ents = [new Entry({ Term: snap.Metadata!.GetTerm(), Index: snap.Metadata!.GetIndex() })]
    return null
  }

  CreateSnapshot(i: number, cs: ConfState | null, data: Uint8Array | undefined): [Snapshot | null, Error | null] {
    if (i <= (this.snapshot.Metadata?.GetIndex() ?? 0)) return [null, ErrSnapOutOfDate]
    const offset = this.ents[0].GetIndex()
    if (i > this.lastIndex()) getLogger().Panicf('snapshot %d is out of bound lastindex(%d)', i, this.lastIndex())
    this.snapshot = EnsureSnapshot(this.snapshot)
    this.snapshot.Metadata!.Index = i
    this.snapshot.Metadata!.Term = this.ents[i - offset].GetTerm()
    if (cs) this.snapshot.Metadata!.ConfState = cloneConfState(cs)
    this.snapshot.Data = data
    return [cloneSnapshot(this.snapshot), null]
  }

  Compact(compactIndex: number): Error | null {
    const offset = this.ents[0].GetIndex()
    if (compactIndex <= offset) return ErrCompacted
    if (compactIndex > this.lastIndex()) getLogger().Panicf('compact %d is out of bound lastindex(%d)', compactIndex, this.lastIndex())
    const i = compactIndex - offset
    const ents = [new Entry({ Index: this.ents[i].GetIndex(), Term: this.ents[i].GetTerm() })]
    this.ents = ents.concat(this.ents.slice(i + 1))
    return null
  }

  Append(entries: Entry[]): Error | null {
    if (entries.length === 0) return null
    const first = this.firstIndex()
    const last = entries[0].GetIndex() + entries.length - 1
    if (last < first) return null
    if (first > entries[0].GetIndex()) entries = entries.slice(first - entries[0].GetIndex())
    const offset = entries[0].GetIndex() - this.ents[0].GetIndex()
    if (this.ents.length > offset) {
      this.ents = this.ents.slice(0, offset).concat(entries)
    } else if (this.ents.length === offset) {
      this.ents = this.ents.concat(entries)
    } else {
      getLogger().Panicf('missing log entry [last: %d, append at: %d]', this.lastIndex(), entries[0].GetIndex())
    }
    return null
  }
}
