// resource/inspect.ts — the L4 pull spine. Two layers of coverage:
//   • makeSnapshot() shape + live-read behaviour, over SYNTHETIC deps (deterministic,
//     no network) — every field maps through, marks keep raw seenKey granularity, and
//     a later mutation is reflected (it's a live read, not a frozen copy).
//   • a REAL observe server — [diagnostics].snapshot() reports truthful internals, and
//     the in-process seam works WITH and WITHOUT the observe opt (only the WIRE path is gated).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fero, diagnostics } from './index.ts'
import { makeSnapshot, type SnapshotDeps } from './inspect.ts'
import { ports, sleep } from '#utils'

//! Synthetic deps — a fake cluster/log/state, so the shape assertions are deterministic and network-free.
const synthetic = (over: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
  name: 'res',
  cluster: { uuid: 'U', me: 'h:1', epoch: 7, members: ['h:1', 'h:2'], writable: true } as any,
  ringSnapshot: () => ({ members: ['h:1', 'h:2'], vnodes: 200, coverage: [0, 1, 0, 1, 0, 1] }),
  peers: () => ({
    'h:1': { address: 'h:1', host: 'h', port: 1, role: 'server', status: 3, uuid: 'U' },
    'h:2': { address: 'h:2', host: 'h', port: 2, role: 'server', status: 3 },
  }),
  log: { size: 42, partitions: () => ['p1', 'p2'], heads: () => ({ p1: 10, p2: 32 }) } as any,
  seen: new Map([['o1', 5], ['o2\x00p', 3]]),
  versions: new Map([['k1', {}], ['k2', {}]]),
  pending: { length: 2 },
  orphans: new Set(['pX']),
  servedCount: () => 4,
  observing: () => true,
  R: 3,
  scoped: true,
  ...over,
})

test('makeSnapshot() maps every field through (scoped node)', () => {
  const s = makeSnapshot(synthetic())()
  assert.equal(s.name, 'res')
  assert.equal(s.uuid, 'U')
  assert.equal(s.me, 'h:1')
  assert.equal(s.role, 'server')
  assert.equal(s.epoch, 7)
  assert.deepEqual(s.members, ['h:1', 'h:2'])
  assert.equal(s.writable, true)
  assert.deepEqual(s.ring.members, ['h:1', 'h:2'])
  assert.equal(s.ring.vnodes, 200)
  assert.deepEqual(s.ring.coverage, [0, 1, 0, 1, 0, 1]) // ownership donut: member-index per segment
  assert.equal(s.ring.replicas, 3)
  assert.equal(s.ring.scoped, true)
  assert.equal(s.log.size, 42)
  assert.equal(s.log.partitions, 2)
  assert.deepEqual(s.log.heads, { p1: 10, p2: 32 })
  assert.deepEqual(s.marks, { o1: 5, 'o2\x00p': 3 }) // raw seenKey granularity — NOT collapsed to per-origin
  assert.equal(s.versions, 2)
  assert.equal(s.pending, 2)
  assert.deepEqual(s.orphans, ['pX'])
  assert.equal(s.subscriptions, 4)
  assert.equal(s.observing, true) // the push-gate state rides the poll (a bridge detects its dead push leg with it)
  assert.equal(s.peers['h:1'].status, 3)
  assert.equal(s.peers['h:1'].uuid, 'U')
  assert.equal(s.peers['h:2'].port, 2)
  assert.ok(Date.now() - s.at < 1000)
})

test('makeSnapshot() is a LIVE read — a later mutation shows up in the next snapshot', () => {
  const deps = synthetic()
  const snap = makeSnapshot(deps)
  assert.equal(snap().marks.o1, 5)
  deps.seen.set('o1', 99) // mutate the underlying state
  ;(deps.orphans as Set<string>).add('pY')
  const s2 = snap()
  assert.equal(s2.marks.o1, 99) // reflected, not frozen
  assert.deepEqual(s2.orphans.sort(), ['pX', 'pY'])
})

test('full replication: R=∞ maps to replicas:null (JSON-safe) with scoped:false', () => {
  const s = makeSnapshot(synthetic({ R: Infinity, scoped: false }))()
  assert.equal(s.ring.replicas, null) // ∞ doesn't survive JSON → null; `scoped` carries the distinction
  assert.equal(s.ring.scoped, false)
})

test('read-only client shape: me undefined ⇒ role client', () => {
  const s = makeSnapshot(synthetic({ cluster: { uuid: 'C', me: undefined, epoch: 1, members: [], writable: true } as any }))()
  assert.equal(s.role, 'client')
  assert.equal(s.me, undefined)
  assert.deepEqual(s.members, [])
})

test('[diagnostics].snapshot() over a REAL observe server reports truthful internals', async () => {
  const r = await fero('inspect-real', { port: await ports.free(), wait: 10, observe: true })
  r.data.user42 = { name: 'a' }
  r.data.user7 = { name: 'b' }
  await sleep(20)
  const s = (r as any)[diagnostics].snapshot()
  assert.equal(s.role, 'server')
  assert.equal(s.name, 'inspect-real')
  assert.equal(typeof s.uuid, 'string')
  assert.ok(s.me, 'a server reports its listen address')
  assert.ok(s.log.size >= 2, `log has the writes (size=${s.log.size})`)
  assert.ok(Object.keys(s.marks).length >= 1, 'our origin appears in the marks digest')
  assert.ok(s.ring.members.includes(s.me), 'self is a ring member')
  assert.ok(s.peers[s.me!], 'self is in the peer table')
  assert.equal(s.ring.replicas, null) // default full replication
  assert.equal(s.ring.coverage.length, 120, 'the ownership donut is sampled at RING_SEGMENTS')
  for (const seg of s.ring.coverage) assert.equal(seg, 0, 'a sole member owns the whole keyspace')
  r.destroy()
})

test('the [diagnostics].snapshot seam works even WITHOUT observe (only the wire path is gated)', async () => {
  const r = await fero('inspect-off', { port: await ports.free(), wait: 10 })
  const s = (r as any)[diagnostics].snapshot()
  assert.equal(typeof s.uuid, 'string')
  assert.equal(s.role, 'server')
  r.destroy()
})
