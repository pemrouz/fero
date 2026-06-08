// Built-in durable-log adapters for fero(name, { storage }): records ARE change records, so a WAL suffices.

import { appendFileSync, readFileSync } from 'node:fs'
import type { ChangeRecord } from '../transport/message.ts'
import type { Storage } from './index.ts'

// Append-only file WAL: newline-delimited JSON records, synchronous fsync per write (simplest correct durability).
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
