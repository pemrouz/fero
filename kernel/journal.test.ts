//! Tier-1 journal suite: bounded drop-oldest ring, monotone cursor reads, surfaced drop counter.

import { test } from 'node:test'
import assert from 'node:assert'
import { Journal, JK } from './journal.ts'

test('ring retains the newest cap events; overflow surfaces in .dropped, never silently', () => {
  const j = new Journal(4)
  for (let i = 0; i < 10; i++) j.emit(JK.writeLocal, i)
  assert.equal(j.n, 10)
  assert.equal(j.dropped, 6)
  const rows = j.read()
  assert.deepEqual(rows.map((r) => r.a), [6, 7, 8, 9])
  assert.deepEqual(rows.map((r) => r.t), [6, 7, 8, 9]) // t is the global monotone counter, not a ring slot
})

test('read(from) is a cursor: consumers resume where they left off, clamped to retention', () => {
  const j = new Journal(8)
  for (let i = 0; i < 5; i++) j.emit(JK.ping, i)
  const first = j.read(0)
  assert.equal(first.length, 5)
  for (let i = 5; i < 7; i++) j.emit(JK.ping, i)
  assert.deepEqual(j.read(5).map((r) => r.a), [5, 6])
  assert.deepEqual(j.read(100), []) // a future cursor reads nothing, not garbage
})
