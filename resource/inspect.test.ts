// resource/inspect.ts — the L4 pull spine. Two layers of coverage:
//   • makeSnapshot() shape + live-read behaviour, over SYNTHETIC deps (deterministic,
//     no network) — every field maps through, marks keep raw seenKey granularity, and
//     a later mutation is reflected (it's a live read, not a frozen copy).
//   • a REAL observe server — [diagnostics].snapshot() reports truthful internals, and
//     the in-process seam works WITH and WITHOUT the observe opt (only the WIRE path is gated).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fero, diagnostics } from './index.ts'
import { makeSnapshot, VERSION_SAMPLE_CAP, type SnapshotDeps } from './inspect.ts'
import { ports, sleep } from '#utils'

//! Synthetic deps — a fake cluster/log/state, so the shape assertions are deterministic and network-free.
const synthetic = (over: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
  name: 'res',
  cluster: { uuid: 'U', me: 'h:1', epoch: 7, members: ['h:1', 'h:2'], writable: true } as any,
  viewHistory: () => [{ epoch: 6, members: ['h:1', 'h:2'] }, { epoch: 7, members: ['h:1', 'h:2', 'h:3'] }],
  ringSnapshot: () => ({ members: ['h:1', 'h:2'], vnodes: 200, coverage: [0, 1, 0, 1, 0, 1] }),
  peers: () => ({
    'h:1': { address: 'h:1', host: 'h', port: 1, role: 'server', status: 3, uuid: 'U' },
    'h:2': { address: 'h:2', host: 'h', port: 2, role: 'server', status: 3 },
  }),
  log: { size: 42, partitions: () => ['p1', 'p2'], heads: () => ({ p1: 10, p2: 32 }) } as any,
  seen: new Map([['o1', 5], ['o2\x00p', 3]]),
  versions: new Map<string, { epoch: number; seq: number; origin: string }>([
    ['user42', { epoch: 4, seq: 1287, origin: 'U' }],
    ['user42\x00score', { epoch: 4, seq: 1290, origin: 'U' }],
    ['billing', { epoch: 3, seq: 842, origin: 'V' }],
  ]),
  pending: { length: 2 },
  orphans: new Set(['pX']),
  servedCount: () => 4,
  servedSubs: () => [
    { to: ':9001', method: 'read', key: 'user42', kind: 'forward', owner: 'h:2' },
    { to: ':9002', method: 'read', kind: 'gather' },
  ],
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
  assert.equal(s.versions, 3)
  assert.equal(s.versionSample, undefined) // no drill requested → absent, steady poll unchanged
  assert.deepEqual(s.viewHistory, [{ epoch: 6, members: ['h:1', 'h:2'] }, { epoch: 7, members: ['h:1', 'h:2', 'h:3'] }])
  assert.equal(s.pending, 2)
  assert.deepEqual(s.orphans, ['pX'])
  assert.equal(s.subscriptions, 4)
  assert.deepEqual(s.subs, [
    { to: ':9001', method: 'read', key: 'user42', kind: 'forward', owner: 'h:2' },
    { to: ':9002', method: 'read', kind: 'gather' },
  ]) // the bounded subscription-topology sample (who we serve, of what kind) rides the poll
  assert.equal(s.observing, true) // the push-gate state rides the poll (a bridge detects its dead push leg with it)
  assert.equal(s.peers['h:1'].status, 3)
  assert.equal(s.peers['h:1'].uuid, 'U')
  assert.equal(s.peers['h:2'].port, 2)
  assert.ok(Date.now() - s.at < 1000)
})

test('makeSnapshot({sample}) returns per-key LWW stamps for the requested partitions only', () => {
  const make = makeSnapshot(synthetic())
  assert.equal(make().versionSample, undefined) // no sample → absent
  // drill into partition 'user42' → its own key + the nested key, NOT billing
  const s = make({ sample: ['user42'] })
  assert.deepEqual(s.versionSample, {
    user42: { epoch: 4, seq: 1287, origin: 'U' },
    'user42\x00score': { epoch: 4, seq: 1290, origin: 'U' },
  })
  assert.ok(!('billing' in s.versionSample!))
})

test('viewHistory is absent when the node runs no membership (a client)', () => {
  const s = makeSnapshot(synthetic({ viewHistory: undefined }))()
  assert.equal(s.viewHistory, undefined)
  // an empty history is omitted too (not an empty array)
  assert.equal(makeSnapshot(synthetic({ viewHistory: () => [] }))().viewHistory, undefined)
})

test('subs is absent when the node serves no subscriptions (no empty array on the steady poll)', () => {
  assert.equal(makeSnapshot(synthetic({ servedSubs: undefined }))().subs, undefined) // no accessor (e.g. a client)
  assert.equal(makeSnapshot(synthetic({ servedSubs: () => [] }))().subs, undefined) // serves nothing → omitted, not []
})

test('versionSample is capped at VERSION_SAMPLE_CAP', () => {
  const versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  for (let i = 0; i < VERSION_SAMPLE_CAP + 50; i++) versions.set('hot\x00f' + i, { epoch: 4, seq: i, origin: 'U' })
  const s = makeSnapshot(synthetic({ versions }))({ sample: ['hot'] })
  assert.equal(Object.keys(s.versionSample!).length, VERSION_SAMPLE_CAP)
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

test('snapshot.subs reflects a live served subscription (the topology, captured at subscribe)', async () => {
  const port = await ports.free()
  const server: any = await fero('subs-topo', { port, wait: 10 })
  const client: any = await fero('subs-topo', { ports: [port], wait: 10 })
  try {
    // a read-only client opens a reactive whole-resource read() → a server-pushed projection sub
    client.methods.read().connect([], () => {})
    await sleep(40)
    const s = server[diagnostics].snapshot()
    assert.ok(s.subs && s.subs.length >= 1, 'the server reports the served sub in its topology sample')
    const sub = s.subs.find((x: any) => x.method === 'read')
    assert.ok(sub, 'the read subscription appears')
    assert.equal(sub.kind, 'projection') // full replication → no-key read streams the local projection
    assert.ok(sub.to, 'the downstream address is recorded')
    assert.equal(s.subs.length, s.subscriptions, 'topology sample size tracks the served count (under the cap)')
  } finally {
    server.destroy()
    client.destroy()
  }
})
