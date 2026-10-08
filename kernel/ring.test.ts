//! Ring suite: determinism (the split-brain-relevant property), the consistent-hashing minimal-motion
// property, balance sanity, the empty-ring genesis answer, and the two test seams (injectable hash,
// placement override). The ring has no protocol behaviour of its own — everything here is about it
// being a PURE, IDENTICAL function of the committed view on every node.

import { test } from 'node:test'
import assert from 'node:assert'
import { Ring, VNODES, fnv } from './ring.ts'

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

//! I-24 spread pin. Real member ids are 8 hex chars (api/index.ts mints them). Under plain fnv-1a,
// `uuid#0..#31` differ only in the tail, so one member's 32 points bunch into ~4 narrow bands and
// shares go wild (2.85x fair worst, 160 of 300 sets outside [0.5x, 2x]). Sim ids like n01 spread
// fine under plain fnv, which is why no sim test caught it: this pin MUST use hex-shaped ids.
test('spread: hex-shaped member ids get a fair share, and k1..k24 do not pile onto one owner (I-24)', () => {
  let seed = 0x2545f491
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32
  const hex8 = () => Math.floor(rnd() * 2 ** 32).toString(16).padStart(8, '0')
  const sets = Array.from({ length: 50 }, () => Array.from({ length: 4 }, hex8).sort())
  const outside: string[] = []
  const piled: string[] = []
  for (const uuids of sets) {
    const r = new Ring()
    r.build(1, members(...uuids))
    const count = new Map<string, number>()
    for (let i = 0; i < 20_000; i++) { const o = r.ownerOf(hex8()); count.set(o, (count.get(o) ?? 0) + 1) }
    for (const u of uuids) {
      const share = ((count.get(u) ?? 0) / 20_000) * uuids.length
      if (share < 0.5 || share > 2) outside.push(`${u} in [${uuids}] owns ${share.toFixed(2)}x fair`)
    }
    const seq = new Map<string, number>()
    for (let i = 1; i <= 24; i++) { const o = r.ownerOf(`k${i}`); seq.set(o, (seq.get(o) ?? 0) + 1) }
    const most = Math.max(...seq.values())
    if (most > 16) piled.push(`[${uuids}]: one owner holds ${most} of k1..k24`)
  }
  assert.deepEqual(outside, [], `${outside.length}/200 members outside [0.5x, 2x] of fair`)
  assert.deepEqual(piled, [], `${piled.length}/50 sets pile k1..k24 onto one owner`)
})

//! I-24 golden. The ring hash is part of the wire contract: every member must pick the same owner.
// The spread pin above cannot tell fmix32 from a weaker mix that still spreads well but moves every
// owner, so this pins the exact function: known vectors, a BigInt reference of fnv-1a + fmix32
// (written apart from the kernel's Math.imul code) over many inputs, and owners for fixed keys.
test('golden: the default ring hash is exactly fnv-1a finished with fmix32 (wire contract, I-24)', () => {
  const M = 0xffffffffn
  const ref = (s: string): number => {
    let h = 0x811c9dc5n
    for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x01000193n) & M }
    h ^= h >> 16n; h = (h * 0x85ebca6bn) & M
    h ^= h >> 13n; h = (h * 0xc2b2ae35n) & M
    h ^= h >> 16n
    return Number(h)
  }
  const vectors: [string, number][] = [['', 0xab3e7c0b], ['a', 0x1a80b1b3], ['k1', 0xde1cf9f2], ['3f2a9c01#0', 0x76f939c5], ['3f2a9c01#31', 0x1dbe8e1d]]
  for (const [s, h] of vectors) {
    assert.equal(ref(s), h, `reference hash of ${JSON.stringify(s)}`)
    assert.equal(fnv(s), h, `ring hash of ${JSON.stringify(s)}`)
  }
  for (let i = 0; i < 2000; i++) {
    const s = `${(Math.imul(i, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0')}#${i % VNODES}`
    assert.equal(fnv(s), ref(s), `ring hash of ${s} is not fnv-1a + fmix32`)
  }
  const real = new Ring()
  real.build(1, members('3f2a9c01', '7be04d12', 'a91c5e33', 'e4d07f54'))
  const owners = Array.from({ length: 12 }, (_, i) => real.ownerOf(`k${i + 1}`))
  assert.deepEqual(owners, [
    '7be04d12', 'e4d07f54', 'a91c5e33', '7be04d12', '3f2a9c01', 'e4d07f54',
    '7be04d12', 'e4d07f54', 'a91c5e33', 'a91c5e33', 'e4d07f54', '3f2a9c01',
  ], 'owners of k1..k12 moved: the ring hash changed, and mixed versions would disagree on owners')
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

//! ── holdersOf (M6 scoped replication): the R-set is a pure, deterministic extension of ownerOf ──

test('holdersOf: holder[0] === ownerOf, members distinct, r clamps to the member count, empty ring answers []', () => {
  const r = new Ring()
  assert.deepEqual([...r.holdersOf('anything', 2)], [], 'open genesis: no ring, no holders')
  r.build(1, members('n01', 'n02', 'n03', 'n04', 'n05'))
  const set = new Set(['n01', 'n02', 'n03', 'n04', 'n05'])
  for (const k of keys) {
    const h = [...r.holdersOf(k, 3)] // copy — the scratch is invalidated by the next call
    assert.equal(h.length, 3)
    assert.equal(h[0], r.ownerOf(k), `${k}: the owner IS the first holder (single-writer untouched)`)
    assert.equal(new Set(h).size, 3, `${k}: holders are distinct members`)
    for (const u of h) assert.ok(set.has(u))
  }
  //! degeneracies: r ≥ members = everyone (the R=∞ mode by another door); r ≤ 0 = nobody
  assert.equal(new Set(r.holdersOf('k', 99)).size, 5)
  assert.equal(r.holdersOf('k', Infinity).length, 5)
  assert.equal(r.holdersOf('k', 0).length, 0)
})

test('holdersOf: two independently-built rings compute identical R-sets for every key (the split-brain property)', () => {
  const a = new Ring()
  const b = new Ring()
  a.build(3, members('n01', 'n02', 'n03', 'n04'))
  b.build(3, members('n01', 'n02', 'n03', 'n04'))
  for (const k of keys) assert.deepEqual([...a.holdersOf(k, 2)], [...b.holdersOf(k, 2)])
})

test('holdersOf: minimal motion — removing a member never reassigns a surviving pair', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03', 'n04'))
  const before = new Map(keys.map((k) => [k, [...r.holdersOf(k, 2)]]))
  r.build(2, members('n01', 'n02', 'n03'))
  let moved = 0
  for (const k of keys) {
    const was = before.get(k)!
    const now = [...r.holdersOf(k, 2)]
    assert.ok(!now.includes('n04'), `${k}: a departed member cannot hold`)
    if (was.includes('n04')) { moved++; continue } // its slots legitimately reassign
    //! a pair untouched by the departure must not churn — successor-walk stability
    assert.deepEqual(now, was, `${k} rescoped though neither holder departed`)
  }
  assert.ok(moved > 0 && moved < keys.length, `only n04's share moves (${moved}/${keys.length})`)
})

test('holders(): the memo answers identically to the walk, keeps a stable frozen reference per epoch, and invalidates on build/place', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03', 'n04'))
  for (const k of keys.slice(0, 50)) assert.deepEqual([...r.holders(k, 2)], [...r.holdersOf(k, 2)])
  const first = r.holders('part7', 2)
  assert.equal(r.holders('part7', 2), first, 'same epoch, same r ⇒ the SAME array (one walk, then Map.get)')
  assert.ok(Object.isFrozen(first), 'the memoized copy is frozen — retainable, unlike the scratch')
  assert.notEqual(r.holdersOf('part8', 2), first, 'the scratch walk does not disturb the memo')
  assert.equal(r.holders('part7', 2), first, 'still the same reference after unrelated walks')
  //! r participates in the hit test: R_eff shifts when the view shrinks below replicas
  const wider = r.holders('part7', 3)
  assert.notEqual(wider, first)
  assert.equal(wider.length, 3)
  r.build(2, members('n01', 'n02', 'n03', 'n04'))
  assert.notEqual(r.holders('part7', 2), first, 'build() clears the memo (a new view is a new world)')
  const before = r.holders('pinme', 2)
  r.place('pinme', 'n04')
  assert.equal(r.holders('pinme', 2)[0], 'n04', 'place() invalidates its partition entry')
  assert.notEqual(r.holders('pinme', 2), before)
})

test('holdsAny: R-set membership agrees with the walk for every member and every key', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03', 'n04', 'n05'))
  for (const k of keys.slice(0, 200)) {
    const set = new Set(r.holdersOf(k, 2))
    for (const u of ['n01', 'n02', 'n03', 'n04', 'n05'])
      assert.equal(r.holdsAny(u, k, 2), set.has(u), `${k}/${u}`)
    assert.ok(r.holdsAny(r.ownerOf(k), k, 2), 'the owner is always in its own R-set')
  }
})

test('holdersOf: place() pins an ordered holder list; a single pin still draws the rest from the walk', () => {
  const r = new Ring()
  r.build(1, members('n01', 'n02', 'n03', 'n04'))
  r.place('p', 'n03', 'n01')
  assert.deepEqual([...r.holdersOf('p', 2)], ['n03', 'n01'], 'the pin list IS the R-set prefix, in order')
  assert.equal(r.ownerOf('p'), 'n03', 'pins[0] is the owner')
  const three = [...r.holdersOf('p', 3)]
  assert.deepEqual(three.slice(0, 2), ['n03', 'n01'])
  assert.ok(['n02', 'n04'].includes(three[2]), 'the walk fills past the pins with distinct members')
  r.place('p') // unpin
  assert.notEqual(r.ownerOf('p'), undefined)
  assert.equal(r.holdersOf('p', 2).length, 2)
})
