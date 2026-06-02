import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Log, partitionOf } from './partition.ts'

test('append segments by partition (key[0]) and tracks per-partition heads', () => {
  const log = new Log()
  assert.equal(log.append({ type: 'update', key: ['user42'], value: { a: 1 } }), 1)
  assert.equal(log.append({ type: 'update', key: ['user42', 'active'], value: false }), 2) // same partition
  assert.equal(log.append({ type: 'update', key: ['user99'], value: { b: 2 } }), 1) // new partition
  assert.deepEqual(log.heads(), { user42: 2, user99: 1 })
  assert.equal(log.size, 3)
})

test('root insert is partitioned by `at` (the BI0 first-write case)', () => {
  const log = new Log()
  log.append({ type: 'insert', key: [], value: { name: 'P' }, at: 'user42' })
  assert.deepEqual(log.partitions(), ['user42'])
  assert.equal(partitionOf({ type: 'insert', key: [], at: 'user42' }), 'user42')
  assert.equal(partitionOf({ type: 'update', key: ['k', 'sub'] }), 'k')
})

test('onAppend observes appends; unsubscribe stops it', () => {
  const log = new Log()
  const seen: any[] = []
  const off = log.onAppend((record, p, offset) => seen.push([p, offset, record.type]))
  log.append({ type: 'update', key: ['a'], value: 1 })
  log.append({ type: 'remove', key: ['a'] })
  off()
  log.append({ type: 'update', key: ['a'], value: 2 })
  assert.deepEqual(seen, [
    ['a', 1, 'update'],
    ['a', 2, 'remove'],
  ])
})

test('since/diff give the catch-up tail (the sync primitives)', () => {
  const log = new Log()
  for (let i = 0; i < 5; i++) log.append({ type: 'update', key: ['p'], value: i })
  log.append({ type: 'update', key: ['q'], value: 'x' })

  assert.deepEqual(log.since('p', 3).map((r) => r.value), [3, 4])
  assert.equal(log.diff({ p: 5, q: 1 }).length, 0) // caller fully caught up
  assert.equal(log.diff({ p: 5 }).length, 1) // missing all of q
  assert.equal(log.diff({}).length, 6) // fresh join → everything
  assert.deepEqual(log.heads(), { p: 5, q: 1 })
})

test('recordsSince / originHeads: the per-origin anti-entropy primitives', () => {
  const log = new Log()
  // two origins; seqs strictly increasing per origin (Lamport — note A's gap 2→5)
  log.append({ type: 'update', key: ['x'], value: 1, origin: 'A', seq: 1 })
  log.append({ type: 'update', key: ['y'], value: 2, origin: 'A', seq: 2 })
  log.append({ type: 'update', key: ['z'], value: 3, origin: 'B', seq: 1 })
  log.append({ type: 'update', key: ['x'], value: 9, origin: 'A', seq: 5 }) // Lamport jump

  assert.deepEqual(log.originHeads(), { A: 5, B: 1 })

  // a peer that has A up to seq 2 and nothing from B gets A's seq-5 record + all of B
  assert.deepEqual(
    log.recordsSince({ A: 2 }).map((r) => [r.origin, r.seq]),
    [['A', 5], ['B', 1]],
  )
  // fully caught up → nothing
  assert.equal(log.recordsSince({ A: 5, B: 1 }).length, 0)
  // fresh peer (empty vector) → everything, grouped by origin in seq order
  assert.deepEqual(
    log.recordsSince({}).map((r) => [r.origin, r.seq]),
    [['A', 1], ['A', 2], ['A', 5], ['B', 1]],
  )
})
