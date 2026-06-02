// Built-in durable-log adapters for fero(name, { storage }). A Storage is just
// { load, append } (see ./index.ts) — restore the log at boot, persist each
// accepted record. The records ARE change records (the wire/log/memory shape is
// one and the same), so a WAL is the dumbest thing that works: one JSON record
// per line, appended on write, replayed on load.

import { appendFileSync, readFileSync } from 'node:fs'
import type { ChangeRecord } from '../transport/message.ts'
import type { Storage } from './index.ts'

// Append-only file WAL. `load` parses the newline-delimited records (a missing
// file is an empty log); `append` writes one line per record. Synchronous fsync
// per write — the simplest correct durability. Higher throughput (batched /
// async / fsync-coalesced writes) and compaction are deferred — see ./IDEAS.md.
export function fileStorage(path: string): Storage {
  return {
    load(): ChangeRecord[] {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return [] // ENOENT (or unreadable) → fresh log
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
