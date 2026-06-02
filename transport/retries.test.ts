import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Retries } from './retries.ts'

test('no jitter: exponential backoff capped at cap', () => {
  const r = new Retries({ base: 100, cap: 1000, jitter: 0 })
  assert.deepEqual(
    [r.next(), r.next(), r.next(), r.next(), r.next(), r.next()],
    [100, 200, 400, 800, 1000, 1000], // 1600/3200 clamped to the 1000 plateau
  )
})

test('jitter stays within ± jitter·backoff', () => {
  // random=0 → low edge, random=1 → high edge; jitter=0.5 → ±50%
  const lo = new Retries({ base: 100, cap: 1e9, jitter: 0.5, random: () => 0 })
  const hi = new Retries({ base: 100, cap: 1e9, jitter: 0.5, random: () => 1 })
  assert.equal(lo.next(), 50) // 100 - 50
  assert.equal(hi.next(), 150) // 100 + 50
  // mid
  const mid = new Retries({ base: 100, cap: 1e9, jitter: 0.5, random: () => 0.5 })
  assert.equal(mid.next(), 100)
})

test('reset() returns to the first backoff', () => {
  const r = new Retries({ base: 100, cap: 1e9, jitter: 0 })
  r.next()
  r.next()
  assert.equal(r.attempt, 2)
  r.reset()
  assert.equal(r.attempt, 0)
  assert.equal(r.next(), 100)
})

test('max attempts then -1 (give up)', () => {
  const r = new Retries({ base: 10, cap: 1e9, max: 3, jitter: 0 })
  assert.equal(r.next(), 10)
  assert.equal(r.next(), 20)
  assert.equal(r.next(), 40)
  assert.equal(r.exhausted, true)
  assert.equal(r.next(), -1)
})
