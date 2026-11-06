// Port of go.etcd.io/raft/v3/types.go at c51f010.
import { type Entry } from './raftpb.ts'
import { sprintf } from './gofmt.ts'

export type entryID = { term: number; index: number }

export function pbEntryID(entry: Entry): entryID {
  return { term: entry.GetTerm(), index: entry.GetIndex() }
}

export class logSlice {
  term: number
  prev: entryID
  entries: Entry[]
  constructor(term: number, prev: entryID, entries: Entry[]) {
    this.term = term
    this.prev = prev
    this.entries = entries
  }
  lastIndex(): number {
    return this.prev.index + this.entries.length
  }
  lastEntryID(): entryID {
    const ln = this.entries.length
    if (ln !== 0) return pbEntryID(this.entries[ln - 1])
    return this.prev
  }
  valid(): Error | null {
    let prev = this.prev
    for (const e of this.entries) {
      const id = pbEntryID(e)
      if (id.term < prev.term || id.index !== prev.index + 1) {
        return new Error(sprintf('leader term %d: entries %+v and %+v not consistent', this.term, prev, id))
      }
      prev = id
    }
    if (this.term < prev.term) return new Error(sprintf('leader term %d: entry %+v has a newer term', this.term, prev))
    return null
  }
}
