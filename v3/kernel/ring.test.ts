//! Ring suite: determinism (the split-brain-relevant property), the consistent-hashing minimal-motion
// property, balance sanity, the empty-ring genesis answer, and the two test seams (injectable hash,
// placement override). The ring has no protocol behaviour of its own — everything here is about it
// being a PURE, IDENTICAL function of the committed view on every node.

import { test } from 'node:test'
import assert from 'node:assert'
import { Ring, VNODES } from './ring.ts'

const members = (...uuids: string[]): [string, string][] => uuids.map((u) => [u, `sim:${u}`])
const keys = Array.from({ length: 1000 }, (_, i) => `part${i}`)

test('two independently-built rings from the same view answer identically for every key', () => {
  const a = new Ring()
  const b = new Ring()
  a.build(1, members('n01', 'n02', 'n03'))
  b.build(1, members('n01', 'n02', 'n03'))
  for (const k of keys) assert.equal(a.ownerOf(k), b.ownerOf(k))
})

test('every owner is a member; holds() agrees with ownerOf(); the empty ring answers ""', () => {
  const r = new Ring()
  assert.equal(r.ownerOf('anything'), '', 'open genesis: no ring, no owner')
  r.build(1, members('n01', 'n02', 'n03'))
  const set = new Set(['n01', 'n02', 'n03'])
  for (const k of keys) {
    const o = r.ownerOf(k)
    assert.ok(set.has(o))
    assert.ok(r.holds(o, k))
    for (const u of set) if (u !== o) assert.ok(!r.holds(u, k))
  }
})

test('balance sanity: with vnodes, no member owns a degenerate share', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03'))
  const count = new Map<string, number>()
  for (const k of keys) count.set(r.ownerOf(k), (count.get(r.ownerOf(k)) ?? 0) + 1)
  for (const [u, n] of count) assert.ok(n > keys.length * 0.1, `${u} owns ${n}/${keys.length} — vnode spread degenerate`)
  assert.equal(count.size, 3, 'every member owns something')
})

test('minimal motion: removing a member moves ONLY its keys — survivors keep theirs (the consistent-hash property)', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03'))
  const before = new Map(keys.map((k) => [k, r.ownerOf(k)]))
  r.build(2, members('n01', 'n02'))
  for (const k of keys) {
    const was = before.get(k)!
    if (was !== 'n03') assert.equal(r.ownerOf(k), was, `${k} moved off a surviving owner — not a consistent hashring`)
    else assert.notEqual(r.ownerOf(k), 'n03')
  }
  assert.equal(r.epoch, 2, 'the ring records the view epoch it was built from')
})

test('the hash is injectable, and the placement override wins and survives rebuilds', () => {
  //! a constant hash puts every vnode point at 7 — the first member by tie-break owns everything:
  // proves the injected fn is actually used AND that equal points order deterministically
  const r = new Ring(() => 7)
  r.build(1, members('n02', 'n01')) // build order ≠ uuid order — tie-break is by member INDEX as given
  const all = new Set(keys.map((k) => r.ownerOf(k)))
  assert.equal(all.size, 1, 'constant hash ⇒ single owner by deterministic tie-break')
  const s = new Ring()
  s.build(1, members('n01', 'n02', 'n03'))
  s.place('pinned', 'n03')
  assert.equal(s.ownerOf('pinned'), 'n03')
  s.build(2, members('n01', 'n02', 'n03'))
  assert.equal(s.ownerOf('pinned'), 'n03', 'place() survives a rebuild (a test pin outlives view churn)')
})

test('vnode count is the documented constant (the balance/size trade is a decision, not an accident)', () => {
  assert.equal(VNODES, 32)
})
