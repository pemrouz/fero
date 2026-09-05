//! Tier-2 client suite (M5b): spokes under the executive — the client convergence contract (a client's
// fold equals the cluster's at quiescence, through ONE feeder), the relay rule end-to-end (ae=0 →
// re-stamp at the primary → owner commit → exactly-once), failover mid-flight (partition the feeder
// with attempts in the air: repark + re-relay, dedup absorbs), the lost-WACK ambiguity on the client
// hop, and a seeded mini-sweep mixing member and client writers under client-feeder partitions.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, client, writes } from './harness.ts'
import { converged } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { VERB } from '../kernel/codec.ts'
import { REC } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'

const key = (k: string) => JSON.stringify([k])
const pin = (nodes: Node[], k: string, owner: string) => { for (const n of nodes) n.writes.ring.place(k, owner) }
const jk = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind)

test('spokes converge: two clients on a 3-member cluster fold the identical state through their single feeders', () => {
  const sim = new Sim(71)
  const members = cluster(sim, 3, { heartbeatMs: 50 })
  const c1 = client(sim, 'zc1', members, { heartbeatMs: 50 })
  const c2 = client(sim, 'zc2', [members[0], members[1]], { heartbeatMs: 50 })
  sim.run({ until: 500 })
  //! formed() counts strictly — spokes ADD admitted links, so check the member mesh explicitly
  for (const m of members)
    for (const other of members)
      if (m !== other) assert.ok(m.admitted().includes(other.uuid), `${m.uuid} admits ${other.uuid}`)
  assert.equal(members[0].epoch, 1, 'genesis committed with clients connected — spokes never block or join it')
  assert.equal(members[0].membership.view.members.length, 3, 'three members, zero spokes')
  assert.ok(c1.primary !== null && c2.primary !== null, 'both spokes elected a feeder')
  //! mixed writers: members AND clients (client writes relay as ae=0 attempts)
  writes(sim, members, 20, 300)
  for (let i = 0; i < 8; i++) {
    const c = i % 2 ? c1 : c2
    sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: [`ck${i}`], value: `from-${c.uuid}` }] }, 600 + i * 40)
  }
  sim.run({ until: 5000 })
  assert.equal(converged(sim), null, 'EVERY node — spokes included — holds the identical fold')
  assert.deepEqual(sim.violations, [])
  assert.equal(c1.writes.pending.size + c2.writes.pending.size, 0, 'every client route completed')
  assert.equal(c1.state.size, members[0].state.size, 'the spoke fold is the cluster fold')
})

test('the relay rule end-to-end: a client write re-stamps at the primary, commits exactly-once at the owner, and the spoke hears its own commit back', () => {
  const sim = new Sim(72)
  const members = cluster(sim, 3, { heartbeatMs: 50 })
  const c = client(sim, 'zc1', members, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  const primary = [...c.links.values()].find((l) => l.id === c.primary)!.uuid
  //! own the key at a member that is NOT the primary: the route is client → relay → owner
  const owner = members.map((m) => m.uuid).find((u) => u !== primary)!
  pin([...members, c], 'routed', owner)
  sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['routed'], value: 'via-relay' }] })
  sim.run({ until: 3000 })
  const relay = members.find((m) => m.uuid === primary)!
  assert.ok(jk(relay, JK.writeRelay).length >= 1, 'the primary re-stamped the ae=0 attempt (the relay boundary)')
  const ownerNode = members.find((m) => m.uuid === owner)!
  assert.equal(ownerNode.logs.get(owner)!.filter((e) => JSON.stringify(e.rec.key) === key('routed')).length, 1, 'exactly-once at the owner')
  assert.equal(c.writes.pending.size, 0, 'the WACK hopped back through the relay')
  assert.equal(JSON.stringify(c.state.get(key('routed'))), '"via-relay"', 'and the spoke folded its own commit')
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [])
})

test('the relay validates under the executive: a refused client record is WNACKed `invalid` and terminal, the admitted one commits exactly-once, every monitor stays green', () => {
  const sim = new Sim(74)
  const members = cluster(sim, 3, { heartbeatMs: 50, validate: (rec) => (rec.key[0] === 'admin' ? 'reserved' : true) })
  const c = client(sim, 'zc1', members, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  const primary = [...c.links.values()].find((l) => l.id === c.primary)!.uuid
  //! own both keys at a member that is NOT the primary: the refusal must happen at the RELAY, before any forward
  const owner = members.map((m) => m.uuid).find((u) => u !== primary)!
  pin([...members, c], 'admin', owner)
  pin([...members, c], 'open', owner)
  sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['open'], value: 1 }, { type: REC.update, key: ['admin'], value: 'x' }] })
  sim.run({ until: 3000 })
  const relay = members.find((m) => m.uuid === primary)!
  assert.deepEqual(jk(relay, JK.writeNack).map((e) => e.a), ['invalid'], 'the relay refused it — typed')
  assert.equal(jk(members.find((m) => m.uuid === owner)!, JK.writeNack).length, 0, 'the owner never saw the refused record')
  assert.equal(c.writes.pending.size, 0, 'both routes ended: one WACK, one terminal WNACK')
  assert.equal(c.writes.rejected.get('zc1~1|2'), 'reserved', 'the reason waits for the api at the client (issuer lane = uuid~incarnation)')
  assert.equal(c.writes.rejectedPending, 1)
  for (const n of [...members, c]) {
    assert.equal(n.state.has(key('admin')), false, `${n.uuid} never held the refused row`)
    assert.equal(JSON.stringify(n.state.get(key('open'))), '1', `${n.uuid} holds the admitted one`)
  }
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [])
})

test('feeder failover mid-flight: the primary is partitioned away with attempts in the air — repark, re-relay, dedup; exactly-once', () => {
  const sim = new Sim(73)
  const members = cluster(sim, 3, { heartbeatMs: 50 })
  const c = client(sim, 'zc1', members, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  const primary = [...c.links.values()].find((l) => l.id === c.primary)!.uuid
  pin([...members, c], 'fk', primary) // owned by the DYING feeder — worst case: relay and owner die together
  //! the write leaves, then the feeder is cut before anything can come back
  sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['fk'], value: 'survives' }] }, 10)
  sim.severOnFrame(primary, 'zc1', VERB.WACK)
  sim.at(30, () => sim.partition('zc1', primary))
  sim.run({ until: 8000 })
  assert.notEqual(c.primary, null, 'a new feeder was elected')
  assert.notEqual([...c.links.values()].find((l) => l.id === c.primary)?.uuid, primary)
  assert.equal(c.writes.pending.size, 0, 'the route completed through the new relay')
  //! the commit is exactly-once cluster-wide, whatever the ambiguity: count the key across ALL member lanes
  let commits = 0
  for (const m of members)
    for (const [, entries] of m.logs)
      if (m.uuid !== 'zc1') commits = Math.max(commits, entries.filter((e) => JSON.stringify(e.rec.key) === key('fk')).length)
  assert.equal(commits, 1, 'one commit of the key in any single lane — dedup absorbed every retransmit')
  assert.equal(JSON.stringify(c.state.get(key('fk'))), '"survives"')
  assert.deepEqual(sim.violations, [])
})

test('mini-sweep: 30 seeds of members+spokes with mixed writers and a mid-run feeder partition — converged, zero violations, every route complete', () => {
  for (let seed = 500; seed < 530; seed++) {
    const sim = new Sim(seed)
    const members = cluster(sim, 3, { heartbeatMs: 50 })
    const c1 = client(sim, 'zc1', members, { heartbeatMs: 50 })
    const c2 = client(sim, 'zc2', [members[seed % 3], members[(seed + 1) % 3]], { heartbeatMs: 50 })
    sim.run({ until: 500 })
    writes(sim, members, 12, 400)
    for (let i = 0; i < 10; i++) {
      const c = i % 2 ? c1 : c2
      sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: [`ck${i % 4}`], value: `s${seed}-${i}` }] }, 550 + sim.rng() * 500)
    }
    //! cut one spoke's feeder mid-workload and leave it cut: failover is the healing path — the spoke
    // must converge through its NEW feeder alone (the other spoke keeps its feeder throughout)
    sim.at(700, () => { if (c1.primary !== null) sim.partition('zc1', [...c1.links.values()].find((l) => l.id === c1.primary)!.uuid) })
    sim.run({ until: 9000 })
    assert.equal(converged(sim), null, `seed ${seed}: converged (spokes included)`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: monitors green`)
    assert.equal(c1.writes.pending.size + c2.writes.pending.size, 0, `seed ${seed}: all client routes complete`)
  }
})
