// P1 producer test: fold realistic per-node InspectSnapshots into the store-once
// debug file, then feed it through the SAME normalize() the viewer uses — proving
// the inverse-of-normalize contract on the REAL InspectSnapshot shape, and that the
// signals that matter (under-replication, a stale-view node) survive the round-trip.
//
// Deterministic — synthetic snapshots, no live cluster (that's the next bite). The
// fixtures mirror exactly the fields foldSnapshots reads from a real snapshot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InspectSnapshot, InspectSub } from '../../resource/inspect.ts'
import { fero } from '../../resource/index.ts'
import { ports, until } from '#utils'
import { foldSnapshots, foldDivergence, foldOwnership, foldSubs, captureInProcess, type VersionSample } from './export.ts'
// @ts-ignore — shape.js is the untyped browser/Node shared seam
import { normalize } from './mockups/shape.js'

//! build a minimal-but-valid snapshot with only the fields foldSnapshots reads
function snap(o: {
  name: string; me: string; epoch: number; members: string[]
  role?: 'server' | 'client'; writable?: boolean; replicas?: number | null
  heads?: Record<string, number>; versions?: number; orphans?: string[]
  pending?: number; subscriptions?: number
}): InspectSnapshot {
  return {
    at: 0, name: o.name, uuid: o.me, me: o.me, role: o.role ?? 'server',
    epoch: o.epoch, members: o.members, writable: o.writable ?? true,
    ring: { members: o.members, coverage: [], replicas: o.replicas ?? 3, scoped: true } as any,
    log: { size: 0, partitions: Object.keys(o.heads ?? {}).length, heads: o.heads ?? {} },
    marks: {}, versions: o.versions ?? 0, pending: o.pending ?? 0,
    orphans: o.orphans ?? [], subscriptions: o.subscriptions ?? 0,
    observing: false, peers: {},
  } as InspectSnapshot
}

const MEMBERS = [':49801', ':49803', ':49805']
const fixture = () => [
  snap({ name: 'sessions', me: ':49801', epoch: 4, members: MEMBERS, versions: 856, subscriptions: 2,
         heads: { user42: 1287, order7: 9205, billing: 842 } }),
  snap({ name: 'sessions', me: ':49803', epoch: 4, members: MEMBERS, versions: 102, subscriptions: 1,
         heads: { user42: 1287, order7: 9210, billing: 840 } }),
  // C is a node on a STALE view (epoch 3) and holds an orphan — both real signals
  snap({ name: 'sessions', me: ':49805', epoch: 3, members: MEMBERS, versions: 46, orphans: ['billing'],
         heads: { user42: 1287, order7: 9201 } }),                // ← does NOT hold billing → held 2/3
  // a read-only client snapshot must be ignored (not a node row)
  snap({ name: 'sessions', me: undefined as any, epoch: 1, members: [], role: 'client' }),
]
const LOOKUP = {
  owner: (_r: string, k: string) => ({ user42: ':49801', order7: ':49803', billing: ':49801' } as any)[k],
  replicas: (_r: string, _k: string) => MEMBERS, // intended R-set of 3 for all
}

//! the fold emits real facts, once each, on their natural owner
test('foldSnapshots emits committed view, per-node keys, and authoritative ownership', () => {
  const file = foldSnapshots(fixture(), LOOKUP)
  assert.equal(file['fero.debug'], 1)
  assert.equal(file.view, 'e4')                       // max committed epoch
  assert.equal(file.resources.length, 1)

  const r = file.resources[0]
  assert.equal(r.name, 'sessions')
  assert.deepEqual(r.members, MEMBERS)
  assert.equal(r.R, 3)                                // from ring.replicas

  assert.equal(r.nodes.length, 3)                     // the client snapshot is excluded
  const a = r.nodes.find((n) => n.addr === ':49801')!
  assert.equal(a.keys, 856)                           // real LWW-winner count
  assert.equal(a.status, 'healthy')
  const c = r.nodes.find((n) => n.addr === ':49805')!
  assert.equal(c.status, 'stale')                     // epoch 3 < committed 4
  assert.match(c.note, /orphan/)                      // held-but-unreplicated

  const billing = r.partitions.find((p) => p.name === 'billing')!
  assert.equal(billing.owner, ':49801')               // authoritative cluster.owner
  assert.equal(billing.R, 3)
  assert.equal(billing.held, 2)                       // only A,B hold it → under-replicated
  assert.equal(billing.status, 'under')
  assert.match(billing.note, /2\/3/)
  const user42 = r.partitions.find((p) => p.name === 'user42')!
  assert.equal(user42.held, 3)
  assert.equal(user42.status, 'healthy')
})

//! the captured file round-trips through the viewer's normalize() with signals intact
test('captured file renders through normalize() with the real signals preserved', () => {
  const file = foldSnapshots(fixture(), LOOKUP)
  const model = normalize(file)
  const s = model.resources[0]

  assert.equal(s.members, 3)
  assert.equal(s.nodes.find((n: any) => n.id === ':49801').keys, 856)
  assert.equal(s.nodes.find((n: any) => n.id === ':49805').st, 'stale')

  const billing = s.parts.find((p: any) => p.id === 'billing')
  assert.equal(billing.held, 2)
  assert.equal(billing.R, 3)
  assert.equal(billing.st, 'under')

  // P1 boundary, asserted explicitly: per-partition keys have no seam yet, so the
  // derived resource rollup is 0 until P2 adds the sampled accessor. (Node-level
  // keys ARE real — see the 856 above.) This locks where P1 ends and P2 begins.
  assert.equal(s.keys, 0)
})

//! graceful without an owner lookup — still produces holders/held, owner just unknown
test('fold works without an owner lookup (held still derived)', () => {
  const file = foldSnapshots(fixture())
  const billing = file.resources[0].partitions.find((p) => p.name === 'billing')!
  assert.equal(billing.owner, undefined)
  assert.equal(billing.held, 2)
  assert.equal(billing.R, 3)            // falls back to the resource R
  assert.equal(billing.status, 'under')
})

//! cross-node version diff flags the stuck replica (the user42.score-on-:49807 case)
test('foldDivergence flags a replica parked on a lower (epoch,seq) than its owner', () => {
  const file = foldSnapshots(fixture(), LOOKUP)
  const owner: VersionSample = { user42: { epoch: 4, seq: 1287, origin: 'A' }, 'user42\x00score': { epoch: 4, seq: 1290, origin: 'A' } }
  const current: VersionSample = { user42: { epoch: 4, seq: 1287, origin: 'A' }, 'user42\x00score': { epoch: 4, seq: 1290, origin: 'A' } }
  const stuck: VersionSample = { user42: { epoch: 4, seq: 1287, origin: 'A' }, 'user42\x00score': { epoch: 3, seq: 1241, origin: 'X' } }
  const samples = new Map([[':49801', owner], [':49803', current], [':49805', stuck]])

  foldDivergence(file, samples)
  const r = file.resources[0]
  const u42 = r.partitions.find((p) => p.name === 'user42')!
  assert.equal(u42.status, 'diverged')
  assert.equal(u42.replicas!.length, 1)              // only the stuck one, not the current replica
  const rep = u42.replicas![0]
  assert.equal(rep.addr, ':49805')
  assert.equal(rep.stuckAt, 'e3·s1241')
  assert.equal(rep.stale, true)
  assert.equal(rep.lag, 49)                          // 1290 − 1241
  assert.match(rep.note!, /user42\.score/)

  // billing had no version sample → its P1 under-replication status is left intact
  assert.equal(r.partitions.find((p) => p.name === 'billing')!.status, 'under')

  // and it round-trips through the viewer as diverged
  assert.equal(normalize(file).resources[0].parts.find((p: any) => p.id === 'user42').st, 'diverged')
})

//! a fully caught-up cluster shows NO divergence (no false positives)
test('foldDivergence flags nothing when every replica matches the owner', () => {
  const file = foldSnapshots(fixture(), LOOKUP)
  const same: VersionSample = { user42: { epoch: 4, seq: 1287, origin: 'A' }, 'user42\x00score': { epoch: 4, seq: 1290, origin: 'A' } }
  foldDivergence(file, new Map([[':49801', same], [':49803', { ...same }], [':49805', { ...same }]]))
  const u42 = file.resources[0].partitions.find((p) => p.name === 'user42')!
  assert.equal(u42.replicas, undefined)
  assert.notEqual(u42.status, 'diverged')
})

//! ownerByEpoch is re-derived by rebuilding the ring from each past committed view
test('foldOwnership re-derives ownerByEpoch from the view history', () => {
  const file: any = {
    'fero.debug': 1, _about: '', view: 'e3',
    resources: [{ name: 'r', members: ['A', 'B', 'C'], R: 3, nodes: [], partitions: [{ name: 'user42', owner: 'C' }, { name: 'order7', owner: 'A' }] }],
  }
  const views = new Map([[1, ['A']], [2, ['A', 'B']], [3, ['A', 'B', 'C']]])
  // fake ring: user42 → the LAST member, order7 → the FIRST (so user42 changes hands each view)
  const buildRing = (m: string[]) => (k: string) => (k === 'user42' ? m[m.length - 1] : m[0])
  foldOwnership(file, views, buildRing)
  const r = file.resources[0]
  assert.deepEqual(r.partitions.find((p: any) => p.name === 'user42').ownerByEpoch, { e1: 'A', e2: 'B', e3: 'C' })
  assert.deepEqual(r.partitions.find((p: any) => p.name === 'order7').ownerByEpoch, { e1: 'A', e2: 'A', e3: 'A' })
  assert.deepEqual(r.epochs, [{ id: 'e1', members: 1, current: false }, { id: 'e2', members: 2, current: false }, { id: 'e3', members: 3, current: true }])
})

//! the config guard: if the rebuilt ring disagrees with the authoritative owner, emit nothing
test('foldOwnership skips when the rebuilt ring disagrees with cluster.owner (config guard)', () => {
  const file: any = { 'fero.debug': 1, _about: '', view: 'e2', resources: [{ name: 'r', members: ['A', 'B'], R: 2, nodes: [], partitions: [{ name: 'k', owner: 'WRONG' }] }] }
  const views = new Map([[1, ['A']], [2, ['A', 'B']]])
  foldOwnership(file, views, (m) => () => m[0]) // latest ring → 'A', but owner says 'WRONG'
  assert.equal(file.resources[0].partitions[0].ownerByEpoch, undefined)
  assert.equal(file.resources[0].epochs, undefined)
})

//! foldSubs folds served-sub topology into client→sub rows, revealing the forward chain
test('foldSubs groups served subs into client rows (and surfaces the client→relay→owner chain)', () => {
  const file = foldSnapshots(fixture(), LOOKUP) // members :49801/:49803/:49805
  // :49801 (owner of user42) serves the relay :49803; :49803 relays a forwarded read to a real client :60000
  const subsByNode = new Map<string, InspectSub[]>([
    [':49801', [{ to: ':49803', method: 'read', key: 'user42', kind: 'forward', owner: ':49801' }]],
    [':49803', [
      { to: ':60000', method: 'read', key: 'user42', kind: 'forward', owner: ':49801' },
      { to: ':60000', method: 'aggregate', key: 'sum', kind: 'fold' },
    ]],
  ])
  foldSubs(file, subsByNode)
  const r = file.resources[0]
  const clients = r.clients!
  // two distinct downstreams: the member :49803 (a relay — role server) and the real reader :60000
  assert.equal(clients.length, 2)
  const relay = clients.find((c) => c.id === ':49803')!
  assert.equal(relay.role, 'server') // a committed member appearing as a downstream = a relay's upstream
  assert.equal(relay.subs.length, 1)
  assert.equal(relay.subs[0].owner, ':49801')
  const reader = clients.find((c) => c.id === ':60000')!
  assert.equal(reader.role, 'reader') // not a member → a real read-only client
  assert.equal(reader.subs.length, 2)
  assert.ok(reader.subs.some((s) => s.kind === 'forward' && s.key === 'user42'))
  assert.ok(reader.subs.some((s) => s.kind === 'fold'))

  // round-trips through the viewer: clients render with their subs (lag degrades to '0', no fabrication)
  const model = normalize(file)
  const mReader = model.resources[0].clients.find((c: any) => c.id === ':60000')
  assert.ok(mReader, 'the reader renders as a client row')
  assert.equal(mReader.subs.length, 2)
  assert.equal(mReader.subs[0].lag, '0') // no head/delivered → honest default, not a fabricated rate
})

//! no served subs → no clients array (a quiet cluster renders without fabricated rows)
test('foldSubs leaves clients undefined when nothing is subscribed', () => {
  const file = foldSnapshots(fixture(), LOOKUP)
  foldSubs(file, new Map())
  assert.equal(file.resources[0].clients, undefined)
})

//! the live path: capture a real in-process cluster; ownership must match ground truth
test('captureInProcess snapshots a live 3-node cluster with authoritative ownership', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const opts = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 200 })
  const A = await fero('exp-live', opts(p1))
  const B = await fero('exp-live', opts(p2))
  const C = await fero('exp-live', opts(p3))
  try {
    // form a committed 3-member view
    assert.ok(await until(() => [A, B, C].every((n) => n.cluster.members.length === 3), 8000),
      'cluster formed a 3-member view')

    // real writes → real partitions; wait until every node's capture sees all three
    A.data.alpha = { v: 1 }
    B.data.beta = { v: 2 }
    C.data.gamma = { v: 3 }
    assert.ok(await until(() => {
      const r = captureInProcess([A, B, C]).resources.find((x) => x.name === 'exp-live')
      const names = new Set((r?.partitions ?? []).map((p) => p.name))
      return names.has('alpha') && names.has('beta') && names.has('gamma')
    }, 8000), 'all three partitions visible in the capture')

    // full replication applies every record on every node → replicas converge, so the
    // divergence drill must flag NOTHING (no false positives on a healthy cluster)
    assert.ok(await until(() => {
      const r = captureInProcess([A, B, C]).resources.find((x) => x.name === 'exp-live')
      return !!r && r.partitions.every((p) => p.status !== 'diverged')
    }, 8000), 'replicas converge — capture shows no divergence')

    const file = captureInProcess([A, B, C])
    assert.equal(file['fero.debug'], 1)
    assert.ok(typeof file.capturedAt === 'string')
    const r = file.resources.find((x) => x.name === 'exp-live')!
    assert.equal(r.members.length, 3)
    assert.equal(r.nodes.length, 3)

    // OWNERSHIP IS AUTHORITATIVE — the captured owner equals cluster.owner ground truth
    for (const p of r.partitions) {
      assert.equal(p.owner, A.cluster.owner(p.name), `captured owner of ${p.name} matches cluster.owner`)
      assert.ok(p.held! >= 1)
    }
    // per-node keys is the real LWW-winner count, and the capture round-trips
    for (const n of r.nodes) assert.equal(typeof n.keys, 'number')
    assert.equal(normalize(file).resources.find((x: any) => x.id === 'exp-live').members, 3)

    // P4: real ownership history — committed views became epochs, and the current-epoch
    // owner re-derived from the ring matches the authoritative owner (the guard passed)
    assert.ok(r.epochs && r.epochs.length >= 1, 'view history → epochs')
    assert.ok(r.epochs!.some((e) => e.current), 'a current epoch is marked')
    for (const p of r.partitions) {
      assert.ok(p.ownerByEpoch, `ownerByEpoch derived for ${p.name}`)
      assert.equal(p.ownerByEpoch![file.view], p.owner, `ownerByEpoch[${file.view}] matches owner for ${p.name}`)
    }

    // P3: open a real reactive subscription and confirm the capture surfaces the topology
    const reader: any = await fero('exp-live', { ports: [p1, p2, p3], wait: 200 })
    try {
      reader.methods.read().connect([], () => {}) // a server-pushed whole-resource subscription
      assert.ok(await until(() => {
        const cs = captureInProcess([A, B, C]).resources.find((x) => x.name === 'exp-live')?.clients
        return !!cs && cs.some((c) => c.subs.length >= 1)
      }, 8000), 'the live subscription shows up as a client→sub row in the capture')
      const cap = captureInProcess([A, B, C]).resources.find((x) => x.name === 'exp-live')!
      const client = cap.clients!.find((c) => c.subs.some((s) => s.kind === 'projection' || s.kind === 'gather'))
      assert.ok(client, 'the read subscription is captured (projection under full replication)')
      assert.ok(client!.server, 'the serving node is recorded')
    } finally {
      reader.destroy()
    }
  } finally {
    A.destroy(); B.destroy(); C.destroy()
  }
})
