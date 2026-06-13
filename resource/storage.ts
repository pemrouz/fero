//! Built-in durable-log adapters for fero(name, { storage }): records ARE change records, so a WAL suffices.
// Built-in durable-log adapters for fero(name, { storage }). A Storage is just
// { load, append } (see ./index.ts) — restore the log at boot, persist each
// accepted record. The records ARE change records (the wire/log/memory shape is
// one and the same), so a WAL is the dumbest thing that works: one JSON record
// per line, appended on write, replayed on load.

import { appendFileSync, readFileSync } from 'node:fs'
import type { ChangeRecord } from '../transport/message.ts'
import type { Storage } from './index.ts'

//! Append-only file WAL: newline-delimited JSON records, one synchronous appendFileSync per write (PAGE-CACHE durable — survives a process crash, NOT power loss).
// Append-only file WAL. `load` parses the newline-delimited records (a missing
// file is an empty log); `append` writes one line per record. The write is a
// synchronous `appendFileSync` — it reaches the OS PAGE CACHE and returns; it does
// NOT fsync, so it survives a process crash (the kernel still holds the bytes) but
// NOT power loss. confirm:'persisted' built on this seam therefore means
// "page-cache-durable on a W-quorum" — strictly stronger than 'replicated'
// (in-memory only), weaker than a power-loss guarantee. A real-fsync variant (an
// open fd + fsyncSync, returning a Promise) is a drop-in upgrade behind the async
// seam contract — see ../IDEAS.md. Higher throughput (batched / coalesced) +
// compaction are likewise deferred.
export function fileStorage(path: string): Storage {
  return {
    load(): ChangeRecord[] {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return [] //! ENOENT (or unreadable) → fresh log
      }
      const out: ChangeRecord[] = []
      for (const line of text.split('\n')) if (line) out.push(JSON.parse(line) as ChangeRecord)
      return out
    },
    append(record: ChangeRecord): void {
      appendFileSync(path, JSON.stringify(record) + '\n')
    },
  }
}
