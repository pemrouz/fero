// Port of go.etcd.io/raft/v3/log_unstable.go at c51f010.
// Go slices alias; here every stored array is our own copy.
import { type Entry, type Snapshot, cloneSnapshot } from './raftpb.ts'
import type { Logger } from './logger.ts'
import type { entryID } from './types.ts'

export class unstable {
  snapshot: Snapshot | null = null
  entries: Entry[] = []
  offset = 0
  snapshotInProgress = false
  offsetInProgress = 0
  logger: Logger
  constructor(offset: number, logger: Logger) {
    this.offset = offset
    this.offsetInProgress = offset
    this.logger = logger
  }

  maybeFirstIndex(): [number, boolean] {
    if (this.snapshot) return [this.snapshot.Metadata!.GetIndex() + 1, true]
    return [0, false]
  }

  maybeLastIndex(): [number, boolean] {
    const l = this.entries.length
    if (l !== 0) return [this.offset + l - 1, true]
    if (this.snapshot) return [this.snapshot.Metadata!.GetIndex(), true]
    return [0, false]
  }

  maybeTerm(i: number): [number, boolean] {
    if (i < this.offset) {
      if (this.snapshot && this.snapshot.Metadata!.GetIndex() === i) return [this.snapshot.Metadata!.GetTerm(), true]
      return [0, false]
    }
    const [last, ok] = this.maybeLastIndex()
    if (!ok) return [0, false]
    if (i > last) return [0, false]
    return [this.entries[i - this.offset].GetTerm(), true]
  }

  nextEntries(): Entry[] {
    const inProgress = this.offsetInProgress - this.offset
    if (this.entries.length === inProgress) return []
    return this.entries.slice(inProgress)
  }

  nextSnapshot(): Snapshot | null {
    if (!this.snapshot || this.snapshotInProgress) return null
    return cloneSnapshot(this.snapshot)
  }

  acceptInProgress(): void {
    if (this.entries.length > 0) this.offsetInProgress = this.entries[this.entries.length - 1].GetIndex() + 1
    if (this.snapshot) this.snapshotInProgress = true
  }

  stableTo(id: entryID): void {
    const [gt, ok] = this.maybeTerm(id.index)
    if (!ok) {
      this.logger.Infof('entry at index %d missing from unstable log; ignoring', id.index)
      return
    }
    if (id.index < this.offset) {
      this.logger.Infof('entry at index %d matched unstable snapshot; ignoring', id.index)
      return
    }
    if (gt !== id.term) {
      this.logger.Infof('entry at (index,term)=(%d,%d) mismatched with ' +
        'entry at (%d,%d) in unstable log; ignoring', id.index, id.term, id.index, gt)
      return
    }
    const num = id.index + 1 - this.offset
    this.entries = this.entries.slice(num)
    this.offset = id.index + 1
    this.offsetInProgress = Math.max(this.offsetInProgress, this.offset)
    this.shrinkEntriesArray()
  }

  shrinkEntriesArray(): void {
    if (this.entries.length === 0) this.entries = []
  }

  stableSnapTo(i: number): void {
    if (this.snapshot && this.snapshot.Metadata!.GetIndex() === i) {
      this.snapshot = null
      this.snapshotInProgress = false
    }
  }

  restore(s: Snapshot): void {
    this.offset = s.Metadata!.GetIndex() + 1
    this.offsetInProgress = this.offset
    this.entries = []
    this.snapshot = cloneSnapshot(s)
    this.snapshotInProgress = false
  }

  truncateAndAppend(ents: Entry[]): void {
    const fromIndex = ents[0].GetIndex()
    if (fromIndex === this.offset + this.entries.length) {
      this.entries = this.entries.concat(ents)
    } else if (fromIndex <= this.offset) {
      this.logger.Infof('replace the unstable entries from index %d', fromIndex)
      this.entries = ents.slice()
      this.offset = fromIndex
      this.offsetInProgress = this.offset
    } else {
      this.logger.Infof('truncate the unstable entries before index %d', fromIndex)
      const keep = this.slice(this.offset, fromIndex)
      this.entries = keep.concat(ents)
      this.offsetInProgress = Math.min(this.offsetInProgress, fromIndex)
    }
  }

  slice(lo: number, hi: number): Entry[] {
    this.mustCheckOutOfBounds(lo, hi)
    return this.entries.slice(lo - this.offset, hi - this.offset)
  }

  mustCheckOutOfBounds(lo: number, hi: number): void {
    if (lo > hi) this.logger.Panicf('invalid unstable.slice %d > %d', lo, hi)
    const upper = this.offset + this.entries.length
    if (lo < this.offset || hi > upper) this.logger.Panicf('unstable.slice[%d,%d) out of bound [%d,%d]', lo, hi, this.offset, upper)
  }
}
