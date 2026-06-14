// P1 producer test: fold realistic per-node InspectSnapshots into the store-once
// debug file, then feed it through the SAME normalize() the viewer uses — proving
// the inverse-of-normalize contract on the REAL InspectSnapshot shape, and that the
// signals that matter (under-replication, a stale-view node) survive the round-trip.
//
// Deterministic — synthetic snapshots, no live cluster (that's the next bite). The
// fixtures mirror exactly the fields foldSnapshots reads from a real snapshot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InspectSnapshot } from '../../resource/inspect.ts'
import { fero } from '../../resource/index.ts'
import { ports, until } from '#utils'
import { foldSnapshots, captureInProcess } from './export.ts'
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
  } finally {
    A.destroy(); B.destroy(); C.destroy()
  }
})
