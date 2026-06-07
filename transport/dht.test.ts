import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DHT, hash32 } from './dht.ts'

const keys = (n: number) => Array.from({ length: n }, (_, i) => 'key-' + i)

test('empty ring owns nothing', () => {
  const dht = new DHT()
  assert.equal(dht.owner('x'), undefined)
  assert.deepEqual(dht.owners('x', 3), [])
})

test('owner is stable and a member of the ring', () => {
  const dht = new DHT()
  for (const a of ['a:1', 'b:1', 'c:1']) dht.add(a)
  const o = dht.owner('user42')
  assert.ok(['a:1', 'b:1', 'c:1'].includes(o!))
  assert.equal(dht.owner('user42'), o) // deterministic
  assert.equal(dht.owner('user42'), o) // and after the lazy rebuild settled
})

test('distribution across 4 nodes is roughly even', () => {
  const dht = new DHT()
  const nodes = ['n0:1', 'n1:1', 'n2:1', 'n3:1']
  for (const n of nodes) dht.add(n)
  const counts: Record<string, number> = {}
  const K = 12000
  for (const k of keys(K)) counts[dht.owner(k)!] = (counts[dht.owner(k)!] ?? 0) + 1
  // ideal 25% each; loose bounds (10%–45%) to catch gross imbalance without flaking
  for (const n of nodes) {
    const share = counts[n] / K
    assert.ok(share > 0.1 && share < 0.45, `${n} owns ${(share * 100).toFixed(1)}% (expected ~25%)`)
  }
})

test('adding a node moves ≈1/N of keys (consistent hashing)', () => {
  const before = new DHT()
  for (const n of ['n0:1', 'n1:1', 'n2:1', 'n3:1']) before.add(n)
  const K = 12000
  const ks = keys(K)
  const owners0 = ks.map((k) => before.owner(k))

  const after = new DHT()
  for (const n of ['n0:1', 'n1:1', 'n2:1', 'n3:1', 'n4:1']) after.add(n)
  let moved = 0
  for (let i = 0; i < K; i++) if (after.owner(ks[i]) !== owners0[i]) moved++

  const frac = moved / K
  // ideal on 4→5 is ~1/5 = 0.20; allow 0.08–0.40 (smoothness varies with vnodes)
  assert.ok(frac > 0.08 && frac < 0.4, `moved ${(frac * 100).toFixed(1)}% (expected ~20%)`)
})

test('owners(key, R) returns R distinct peers clockwise', () => {
  const dht = new DHT({ replicas: 3 })
  for (const a of ['a:1', 'b:1', 'c:1', 'd:1']) dht.add(a)
  const os = dht.owners('user42', 3)
  assert.equal(os.length, 3)
  assert.equal(new Set(os).size, 3, 'distinct')
  assert.equal(os[0], dht.owner('user42'), 'first owner matches owner()')
  // can never return more than the membership
  assert.equal(dht.owners('user42', 99).length, 4)
})

test('remove updates ownership', () => {
  const dht = new DHT()
  for (const a of ['a:1', 'b:1', 'c:1']) dht.add(a)
  dht.remove('b:1')
  assert.equal(dht.has('b:1'), false)
  assert.ok(['a:1', 'c:1'].includes(dht.owner('whatever')!))
})

test('hash32 is deterministic and 32-bit unsigned', () => {
  assert.equal(hash32('user42'), hash32('user42'))
  assert.ok(hash32('user42') >= 0 && hash32('user42') <= 0xffffffff)
  assert.notEqual(hash32('a'), hash32('b'))
})
