import { test } from 'node:test'
import { deepEqual, equal } from 'node:assert'
import { foldWal, birthEpochs } from './wal.ts'
import type { ChangeRecord } from '../../transport/message.ts'

//! a terse WAL record builder — key path + view-epoch + per-origin seq + origin.
const rec = (key: string[], epoch: number, seq: number, origin = 'A'): ChangeRecord => ({ type: 'update', key, value: seq, origin, seq, epoch })

test('foldWal: birth = lowest (epoch,seq) per partition', () => {
  const wal = [rec(['user42', 'score'], 2, 10), rec(['user42', 'score'], 3, 11), rec(['billing'], 4, 20), rec(['user42', 'name'], 4, 12)]
  const d = foldWal(wal)
  deepEqual(d.births['user42'], { epoch: 2, seq: 10 })
  deepEqual(d.births['billing'], { epoch: 4, seq: 20 })
})

test('foldWal: epoch wins over append order — a handoff resets the new owner seq low', () => {
  // order7 born at e3 (origin A, seq 900); handed to origin B at e4 whose per-origin
  // seq resets to 1. The e4 line is appended FIRST here — birth must still be e3, not
  // B's lower seq, because epoch is the primary key and e3 < e4.
  const wal = [rec(['order7'], 4, 1, 'B'), rec(['order7'], 3, 900, 'A')]
  equal(foldWal(wal).births['order7'].epoch, 3)
})

test('foldWal: log preserves per-partition append order (superseded values kept)', () => {
  const wal = [rec(['p'], 1, 1), rec(['q'], 1, 2), rec(['p'], 1, 3)]
  const d = foldWal(wal)
  deepEqual(d.log['p'].map((r) => r.seq), [1, 3])
  deepEqual(d.log['q'].map((r) => r.seq), [2])
})

test('birthEpochs: collapses a digest to partition → birth-epoch', () => {
  deepEqual(birthEpochs(foldWal([rec(['a'], 2, 5), rec(['b'], 4, 9)])), { a: 2, b: 4 })
})

test('foldWal: empty WAL → empty digest', () => {
  const d = foldWal([])
  deepEqual(d.births, {})
  deepEqual(d.log, {})
})
