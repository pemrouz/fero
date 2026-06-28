// Unit tests for the cluster.writes controller (resource/writes.ts) — the pure
// ring-buffer/lifecycle logic, no network. The fero()-level gating + real confirm
// integration is in index.test.ts ("cluster.writes: …"); the rejected path under
// a real partition is in tests/chaos/cluster.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { value } from '../../data/index.ts'
import { makeWritesLog } from './writes.ts'

const rows = (w: ReturnType<typeof makeWritesLog>) => (w.proxy as any)[value] as Record<string, any>

test('writes: a record goes pending → confirmed and carries a measured latency', async () => {
  const w = makeWritesLog()
  const id = w.onStart('committed', 'users.42')
  let r = rows(w)[String(id)]
  assert.equal(r.state, 'pending', 'inserted pending')
  assert.equal(r.guarantee, 'committed')
  assert.equal(r.key, 'users.42', 'the dotted key path, not the value')
  assert.equal(typeof r.startedAt, 'number')
  assert.equal(r.latency, undefined, 'no latency while in flight')

  w.onSettle(id, 'confirmed', { reachedTier: 'committed', seq: 5, epoch: 2 })
  r = rows(w)[String(id)]
  assert.equal(r.state, 'confirmed')
  assert.equal(r.reachedTier, 'committed')
  assert.equal(r.seq, 5)
  assert.equal(r.epoch, 2)
  assert.equal(typeof r.settledAt, 'number')
  assert.equal(typeof r.latency, 'number', 'settle stamps the measured latency')
  assert.ok(r.latency >= 0 && r.latency === r.settledAt - r.startedAt, 'latency = settledAt − startedAt')
})

test('writes: a rejected settle records the reason + how far it reached', () => {
  const w = makeWritesLog()
  const id = w.onStart('replicated', 'k')
  w.onSettle(id, 'rejected', { reachedTier: 'committed', reason: 'quorum', seq: 9, epoch: 3 })
  const r = rows(w)[String(id)]
  assert.equal(r.state, 'rejected')
  assert.equal(r.reason, 'quorum', "committed but not replicated to W")
  assert.equal(r.reachedTier, 'committed')
  assert.equal(r.seq, 9, 'a rejected replicated write still carries its durable commit seq')
})

test('writes: the ring is bounded — drop-oldest once over capacity', () => {
  const w = makeWritesLog({ buffer: 4 })
  const ids = Array.from({ length: 6 }, (_, i) => w.onStart('committed', 'k' + i)) // ids 0..5
  const present = rows(w)
  assert.equal(Object.keys(present).length, 4, 'capped at the buffer size')
  assert.ok(!(String(ids[0]) in present) && !(String(ids[1]) in present), 'the two oldest were evicted')
  assert.ok([2, 3, 4, 5].every((i) => String(ids[i]) in present), 'the four newest survive')
})

test('writes: settling an already-evicted record is a no-op (no resurrection)', () => {
  const w = makeWritesLog({ buffer: 2 })
  const a = w.onStart('committed', 'a')
  w.onStart('committed', 'b')
  w.onStart('committed', 'c') // evicts `a`
  assert.ok(!(String(a) in rows(w)), 'a was evicted by drop-oldest')
  w.onSettle(a, 'confirmed', { reachedTier: 'committed' }) // late settle for the evicted record
  assert.equal(Object.keys(rows(w)).length, 2, 'still capped — the evicted record was not resurrected')
  assert.ok(!(String(a) in rows(w)), 'and stays gone')
})

test('writes: a fractional buffer floors to 0 → falls back to the default (never a zero/NaN ring)', () => {
  const w = makeWritesLog({ buffer: 0.5 }) // floor(0.5)=0 → would be an unbounded NaN-slot ring; must fall back
  w.onStart('committed', 'a')
  w.onStart('committed', 'b')
  w.onStart('committed', 'c')
  assert.equal(Object.keys(rows(w)).length, 3, 'kept all three (cap ≥ 1, not 0)')
})
