// Port of go.etcd.io/raft/v3/log.go at c51f010.
import { type Entry, type Snapshot, cloneSnapshot } from './raftpb.ts'
import type { Logger } from './logger.ts'
import { unstable } from './log_unstable.ts'
import { type Storage, ErrCompacted, ErrUnavailable } from './storage.ts'
import { type entryID, type logSlice, pbEntryID } from './types.ts'
import { limitSize, entsSize, extend } from './util.ts'
import { sprintf } from './gofmt.ts'

export const noLimit = Infinity

export class raftLog {
  storage: Storage
  unstable: unstable
  committed: number
  applying: number
  applied: number
  logger: Logger
  maxApplyingEntsSize: number
  applyingEntsSize = 0
  applyingEntsPaused = false

  constructor(storage: Storage, logger: Logger, maxApplyingEntsSize: number) {
    const [firstIndex, e1] = storage.FirstIndex()
    if (e1) throw e1
    const [lastIndex, e2] = storage.LastIndex()
    if (e2) throw e2
    this.storage = storage
    this.unstable = new unstable(lastIndex + 1, logger)
    this.maxApplyingEntsSize = maxApplyingEntsSize
    this.committed = firstIndex - 1
    this.applying = firstIndex - 1
    this.applied = firstIndex - 1
    this.logger = logger
  }

  String(): string {
    return sprintf('committed=%d, applied=%d, applying=%d, unstable.offset=%d, unstable.offsetInProgress=%d, len(unstable.Entries)=%d',
      this.committed, this.applied, this.applying, this.unstable.offset, this.unstable.offsetInProgress, this.unstable.entries.length)
  }

  maybeAppend(a: logSlice, committed: number): [number, boolean] {
    if (!this.matchTerm(a.prev)) return [0, false]
    const lastnewi = a.prev.index + a.entries.length
    const ci = this.findConflict(a.entries)
    if (ci === 0) {
      // no conflict
    } else if (ci <= this.committed) {
      this.logger.Panicf('entry %d conflict with committed entry [committed(%d)]', ci, this.committed)
    } else {
      const offset = a.prev.index + 1
      if (ci - offset > a.entries.length) this.logger.Panicf('index, %d, is out of range [%d]', ci - offset, a.entries.length)
      this.append(...a.entries.slice(ci - offset))
    }
    this.commitTo(Math.min(committed, lastnewi))
    return [lastnewi, true]
  }

  append(...ents: Entry[]): number {
    if (ents.length === 0) return this.lastIndex()
    const after = ents[0].GetIndex() - 1
    if (after < this.committed) this.logger.Panicf('after(%d) is out of range [committed(%d)]', after, this.committed)
    this.unstable.truncateAndAppend(ents)
    return this.lastIndex()
  }

  findConflict(ents: Entry[]): number {
    for (const e of ents) {
      const id = pbEntryID(e)
      if (!this.matchTerm(id)) {
        if (id.index <= this.lastIndex()) {
          this.logger.Infof('found conflict at index %d [existing term: %d, conflicting term: %d]',
            id.index, this.zeroTermOnOutOfBounds(this.term(id.index)), id.term)
        }
        return id.index
      }
    }
    return 0
  }

  findConflictByTerm(index: number, term: number): [number, number] {
    for (; index > 0; index--) {
      const [ourTerm, err] = this.term(index)
      if (err) return [index, 0]
      else if (ourTerm <= term) return [index, ourTerm]
    }
    return [0, 0]
  }

  nextUnstableEnts(): Entry[] { return this.unstable.nextEntries() }
  hasNextUnstableEnts(): boolean { return this.nextUnstableEnts().length > 0 }
  hasNextOrInProgressUnstableEnts(): boolean { return this.unstable.entries.length > 0 }

  nextCommittedEnts(allowUnstable: boolean): Entry[] {
    if (this.applyingEntsPaused) return []
    if (this.hasNextOrInProgressSnapshot()) return []
    const lo = this.applying + 1
    const hi = this.maxAppliableIndex(allowUnstable) + 1
    if (lo >= hi) return []
    const maxSize = this.maxApplyingEntsSize - this.applyingEntsSize
    if (maxSize <= 0) {
      this.logger.Panicf('applying entry size (%d-%d)=%d not positive', this.maxApplyingEntsSize, this.applyingEntsSize, maxSize)
    }
    const [ents, err] = this.slice(lo, hi, maxSize)
    if (err) this.logger.Panicf('unexpected error when getting unapplied entries (%v)', err)
    return ents
  }

  hasNextCommittedEnts(allowUnstable: boolean): boolean {
    if (this.applyingEntsPaused) return false
    if (this.hasNextOrInProgressSnapshot()) return false
    const lo = this.applying + 1
    const hi = this.maxAppliableIndex(allowUnstable) + 1
    return lo < hi
  }

  maxAppliableIndex(allowUnstable: boolean): number {
    let hi = this.committed
    if (!allowUnstable) hi = Math.min(hi, this.unstable.offset - 1)
    return hi
  }

  nextUnstableSnapshot(): Snapshot | null { return this.unstable.nextSnapshot() }
  hasNextUnstableSnapshot(): boolean { return this.unstable.nextSnapshot() !== null }
  hasNextOrInProgressSnapshot(): boolean { return this.unstable.snapshot !== null }

  snapshot(): [Snapshot | null, Error | null] {
    if (this.unstable.snapshot) return [cloneSnapshot(this.unstable.snapshot), null]
    return this.storage.Snapshot()
  }

  firstIndex(): number {
    const [i, ok] = this.unstable.maybeFirstIndex()
    if (ok) return i
    const [index, err] = this.storage.FirstIndex()
    if (err) throw err
    return index
  }

  lastIndex(): number {
    const [i, ok] = this.unstable.maybeLastIndex()
    if (ok) return i
    const [li, err] = this.storage.LastIndex()
    if (err) throw err
    return li
  }

  commitTo(tocommit: number): void {
    if (this.committed < tocommit) {
      if (this.lastIndex() < tocommit) {
        this.logger.Panicf('tocommit(%d) is out of range [lastIndex(%d)]. Was the raft log corrupted, truncated, or lost?', tocommit, this.lastIndex())
      }
      this.committed = tocommit
    }
  }

  appliedTo(i: number, size: number): void {
    if (this.committed < i || i < this.applied) {
      this.logger.Panicf('applied(%d) is out of range [prevApplied(%d), committed(%d)]', i, this.applied, this.committed)
    }
    this.applied = i
    this.applying = Math.max(this.applying, i)
    if (this.applyingEntsSize > size) this.applyingEntsSize -= size
    else this.applyingEntsSize = 0
    this.applyingEntsPaused = this.applyingEntsSize >= this.maxApplyingEntsSize
  }

  acceptApplying(i: number, size: number, allowUnstable: boolean): void {
    if (this.committed < i) {
      this.logger.Panicf('applying(%d) is out of range [prevApplying(%d), committed(%d)]', i, this.applying, this.committed)
    }
    this.applying = i
    this.applyingEntsSize += size
    this.applyingEntsPaused = this.applyingEntsSize >= this.maxApplyingEntsSize || i < this.maxAppliableIndex(allowUnstable)
  }

  stableTo(id: entryID): void { this.unstable.stableTo(id) }
  stableSnapTo(i: number): void { this.unstable.stableSnapTo(i) }
  acceptUnstable(): void { this.unstable.acceptInProgress() }

  lastEntryID(): entryID {
    const index = this.lastIndex()
    const [t, err] = this.term(index)
    if (err) this.logger.Panicf('unexpected error when getting the last term at %d: %v', index, err)
    return { term: t, index }
  }

  term(i: number): [number, Error | null] {
    const [t, ok] = this.unstable.maybeTerm(i)
    if (ok) return [t, null]
    if (i + 1 < this.firstIndex()) return [0, ErrCompacted]
    if (i > this.lastIndex()) return [0, ErrUnavailable]
    const [t2, err] = this.storage.Term(i)
    if (!err) return [t2, null]
    if (err === ErrCompacted || err === ErrUnavailable) return [0, err]
    throw err
  }

  entries(i: number, maxSize: number): [Entry[], Error | null] {
    if (i > this.lastIndex()) return [[], null]
    return this.slice(i, this.lastIndex() + 1, maxSize)
  }

  allEntries(): Entry[] {
    const [ents, err] = this.entries(this.firstIndex(), noLimit)
    if (!err) return ents
    if (err === ErrCompacted) return this.allEntries()
    throw err
  }

  isUpToDate(their: entryID): boolean {
    const our = this.lastEntryID()
    return their.term > our.term || (their.term === our.term && their.index >= our.index)
  }

  matchTerm(id: entryID): boolean {
    const [t, err] = this.term(id.index)
    if (err) return false
    return t === id.term
  }

  maybeCommit(at: entryID): boolean {
    if (at.term !== 0 && at.index > this.committed && this.matchTerm(at)) {
      this.commitTo(at.index)
      return true
    }
    return false
  }

  restore(s: Snapshot): void {
    this.logger.Infof('log [%s] starts to restore snapshot [index: %d, term: %d]', this, s.Metadata!.GetIndex(), s.Metadata!.GetTerm())
    this.committed = s.Metadata!.GetIndex()
    this.unstable.restore(s)
  }

  scan(lo: number, hi: number, pageSize: number, v: (ents: Entry[]) => Error | null): Error | null {
    while (lo < hi) {
      const [ents, err] = this.slice(lo, hi, pageSize)
      if (err) return err
      else if (ents.length === 0) return new Error(sprintf('got 0 entries in [%d, %d)', lo, hi))
      const e2 = v(ents)
      if (e2) return e2
      lo += ents.length
    }
    return null
  }

  slice(lo: number, hi: number, maxSize: number): [Entry[], Error | null] {
    const err = this.mustCheckOutOfBounds(lo, hi)
    if (err) return [[], err]
    if (lo === hi) return [[], null]
    if (lo >= this.unstable.offset) {
      const ents = limitSize(this.unstable.slice(lo, hi), maxSize)
      return [ents.slice(), null]
    }
    const cut = Math.min(hi, this.unstable.offset)
    const [ents, e2] = this.storage.Entries(lo, cut, maxSize)
    if (e2 === ErrCompacted) return [[], e2]
    else if (e2 === ErrUnavailable) this.logger.Panicf('entries[%d:%d) is unavailable from storage', lo, cut)
    else if (e2) throw e2
    if (hi <= this.unstable.offset) return [ents, null]
    if (ents.length < cut - lo) return [ents, null]
    const size = entsSize(ents)
    if (size >= maxSize) return [ents, null]
    const unst = limitSize(this.unstable.slice(this.unstable.offset, hi), maxSize - size)
    if (unst.length === 1 && size + entsSize(unst) > maxSize) return [ents, null]
    return [extend(ents, unst), null]
  }

  mustCheckOutOfBounds(lo: number, hi: number): Error | null {
    if (lo > hi) this.logger.Panicf('invalid slice %d > %d', lo, hi)
    const fi = this.firstIndex()
    if (lo < fi) return ErrCompacted
    const length = this.lastIndex() + 1 - fi
    if (hi > fi + length) this.logger.Panicf('slice[%d,%d) out of bound [%d,%d]', lo, hi, fi, this.lastIndex())
    return null
  }

  zeroTermOnOutOfBounds([t, err]: [number, Error | null]): number {
    if (!err) return t
    if (err === ErrCompacted || err === ErrUnavailable) return 0
    this.logger.Panicf('unexpected error (%v)', err)
  }
}

export function newLog(storage: Storage, logger: Logger): raftLog {
  return new raftLog(storage, logger, noLimit)
}

export function newLogWithSize(storage: Storage, logger: Logger, maxApplyingEntsSize: number): raftLog {
  return new raftLog(storage, logger, maxApplyingEntsSize)
}
