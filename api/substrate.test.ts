//! Tier-1 substrate suite: commit() and the apply seam's Fault, against data directly (no runtime, no network).
// What the user's views and taps throw as data closes a commit goes to the fault; fero's own throw stays loud.

import { test } from 'node:test'
import assert from 'node:assert'
import { proxy, commit, applyRec, applyStreamRec, errText, snapshot } from './substrate.ts'
import { REC } from '../kernel/env.ts'

test("commit(): a user's tap that throws goes to the fault, the writes land, and commit returns", () => {
  const p = proxy({})
  p.tap(() => { if ((snapshot(p) as { x?: number }).x === 1) throw new Error('tap boom') })
  const faults: unknown[] = []
  commit((e) => faults.push(e), () => { p.set('x', 1); p.set('y', 2) })
  assert.deepEqual(snapshot(p), { x: 1, y: 2 })
  assert.equal(faults.length, 1)
  assert.ok(faults[0] instanceof AggregateError && (faults[0] as AggregateError).errors[0].message === 'tap boom')
})

test("commit(): fero's own throw in fn is rethrown after the batch closed on what fn wrote; the fault hears nothing", () => {
  const p = proxy({})
  const faults: unknown[] = []
  assert.throws(() => commit((e) => faults.push(e), () => { p.set('x', 1); throw new Error('fero bug') }), /fero bug/)
  assert.deepEqual(snapshot(p), { x: 1 })
  assert.equal(faults.length, 0)
})

test("commit(): fn's own throw in a batch deferred by data's effect phase leaves from a microtask, never into the flush that drains it", () => {
  const a = proxy({}), b = proxy({})
  const later: (() => void)[] = []
  const real = globalThis.queueMicrotask
  globalThis.queueMicrotask = (f: () => void) => { later.push(f) }
  const outer: unknown[] = [], inner: unknown[] = []
  try {
    a.tap(() => { if ((snapshot(a) as { go?: number }).go === 1) commit((e) => inner.push(e), () => { b.set('x', 1); throw new Error('fero bug, deferred') }) })
    applyRec(a, { type: REC.update, key: ['go'], value: 1 }, (e) => outer.push(e))
  } finally {
    globalThis.queueMicrotask = real
  }
  assert.equal(outer.length, 0, 'the outer apply heard no failure: the bug did not ride its flush')
  assert.equal(inner.length, 0)
  assert.deepEqual(snapshot(b), { x: 1 }, 'the deferred batch still closed on what fn wrote')
  assert.equal(later.length, 1)
  assert.throws(() => later[0](), /fero bug, deferred/)
})

test('applyRec / applyStreamRec: a view that throws as the record lands goes to the fault (the record stands); without a fault it throws, as before', () => {
  for (const apply of [
    (p: unknown, f?: (e: unknown) => void) => applyRec(p, { type: REC.update, key: ['mochi'], value: null }, f),
    (p: unknown, f?: (e: unknown) => void) => applyStreamRec(p, { type: 'update', key: ['mochi'], value: null }, f),
  ]) {
    const p = proxy({})
    const hungry = p.filter((c: { mood: string }) => c.mood === 'hungry')
    const faults: unknown[] = []
    apply(p, (e) => faults.push(e))
    assert.deepEqual(snapshot(p), { mochi: null })
    assert.deepEqual(snapshot(hungry), {})
    assert.equal(faults.length, 1)
    const q = proxy({})
    q.filter((c: { mood: string }) => c.mood === 'hungry')
    assert.throws(() => apply(q), AggregateError)
  }
})

test('errText: any thrown value becomes text without throwing', () => {
  const bad = new Error('x')
  Object.defineProperty(bad, 'message', { get() { throw new Error('no') } })
  for (const v of [new Error('plain'), 'a string', Object.create(null), { toString: 1, valueOf: 1 }, bad, undefined, Symbol('s'), 10n])
    assert.equal(typeof errText(v), 'string')
  assert.equal(errText(new TypeError('t')), 'TypeError: t')
})
