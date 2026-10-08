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
const members = (n: Node) => n.membership.view.members.map((m) => m[0])

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

test("a feeder dies holding a record only it and its spoke had: the spoke fails over to a LAGGING member, resyncs DOWN (never re-teaches), and the record returns through the cluster when the feeder does", () => {
  const sim = new Sim(75)
  const members = cluster(sim, 3, { heartbeatMs: 50 })
  const c = client(sim, 'zc1', members, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  const primary = [...c.links.values()].find((l) => l.id === c.primary)!.uuid
  const others = members.map((m) => m.uuid).filter((u) => u !== primary)
  pin([...members, c], 'only', primary) // owned by the feeder: it commits, WACKs + tap-forwards to the spoke, broadcasts to the members…
  //! …but that broadcast never reaches the other members, and from then on the feeder is cut off from them
  for (const o of others) sim.severOnFrame(primary, o, VERB.RECORDS)
  sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['only'], value: 'mine' }] }, 10)
  sim.at(25, () => { for (const o of others) sim.partition(primary, o) })
  sim.run({ until: 800 })
  assert.equal(JSON.stringify(c.state.get(key('only'))), '"mine"', 'the spoke holds the commit (WACK + tap-forward from its feeder)')
  assert.equal(c.writes.pending.size, 0, 'the route completed')
  for (const o of others) assert.equal(sim.nodes.get(o)!.state.has(key('only')), false, 'the other members never saw it')
  //! now the feeder vanishes from the spoke too: failover onto a member that is BEHIND the spoke
  sim.at(800, () => sim.partition(c.uuid, primary))
  sim.run({ until: 4000 })
  const feeder = c.primary === null ? null : [...c.links.values()].find((l) => l.id === c.primary)!.uuid
  assert.ok(feeder !== null && feeder !== primary, `failed over (feeder now ${feeder})`)
  assert.equal(jk(c, JK.resync).length, 1, 'ahead of the new feeder → one resync')
  assert.deepEqual(jk(c, JK.resynced).map((e) => e.a), [1], 'one ghost: the record only the dead feeder had')
  assert.equal(c.state.has(key('only')), false, "the spoke took the cluster's truth — it did not re-teach the record")
  for (const o of others) assert.equal(sim.nodes.get(o)!.state.has(key('only')), false, 'the members still never saw it')
  //! the old feeder returns: the record comes back through the CLUSTER (member AE), and the spoke hears it from its feeder
  sim.at(4000, () => { for (const o of others) sim.heal(primary, o); sim.heal(c.uuid, primary) })
  sim.run({ until: 14000 })
  assert.equal(JSON.stringify(c.state.get(key('only'))), '"mine"', 'back — via the cluster, not the spoke')
  assert.equal(jk(c, JK.resync).length, 1, 'no second resync')
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

//! ── I-23 (2026-09-28): a spoke must never teach a VIEW. Two memory-only members die (kill -9: no leave, no
// WAL) while a client is still up, and come back on their own addresses under fresh uuids one at a time, the
// client's redial landing on the first before its peer does. Before the fix the client node ran view-on-admit
// like a member: the reborn member installed the client's old view (epoch 1 > 0), held a view it was not in
// (`evicted`), could never run genesis again (that needs epoch 0), and taught the same view to its peer on
// admit — `members 2 [dead ids] writable false` on both, forever (rung 30's mutation). RED on the old kernel.
test('reborn memory-only members re-form with a stale spoke connected: the spoke teaches nothing, and its own members row heals to the new cluster', () => {
  const sim = new Sim(76)
  const [n01, n02] = cluster(sim, 2, { heartbeatMs: 50 })
  //! a reboot under fresh uuids is a NEW cluster reusing the epoch numbers — the one-cluster-per-sim
  // safety monitor would call the new epoch 1 split-brain against the dead one; every other monitor stays
  sim.monitors = sim.monitors.filter((m) => m.name !== 'one-view-per-epoch')
  const c = client(sim, 'zc1', [n01, n02], { heartbeatMs: 50 })
  sim.run({ until: 500 })
  assert.deepEqual([n01.epoch, n02.epoch, c.epoch], [1, 1, 1], 'genesis; the spoke learned the view')
  assert.deepEqual(members(c), ['n01', 'n02'])
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['before'], value: 1 }] })
  sim.run({ until: 700 })
  assert.equal(JSON.stringify(c.state.get(key('before'))), '1')
  //! the spoke's number goes ABOVE the reborn cluster's first (I-23 amended, 2026-10-08): n02 leaves by
  // ballot, so the spoke holds epoch 2 {n01} — a bigger number than the epoch 1 the reborn pair will commit
  sim.post('n02', { kind: 'leave' })
  sim.run({ until: 900 })
  assert.equal(sim.left.get('n02'), true)
  assert.deepEqual([n01.epoch, c.epoch, members(c)], [2, 2, ['n01']], 'the spoke followed its feeder to epoch 2')
  sim.partition('zc1', 'n02'); sim.partition('n01', 'n02'); n02.destroy(); sim.nodes.delete('n02')
  //! kill -9 the last member: its port closes (the partition refuses every redial until a new life binds the address)
  sim.partition('zc1', 'n01')
  n01.destroy(); sim.nodes.delete('n01')
  sim.run({ until: 1200 })
  assert.equal(c.primary, null, 'the spoke lost its feeder')
  assert.deepEqual(members(c), ['n01'], 'and still holds the dead view')
  //! the first member comes back on the same address under a fresh uuid; its peer's port is still closed
  sim.partition('n03', 'n02')
  const n03 = sim.add({ uuid: 'n03', listen: 'sim:n01', hosts: ['sim:n02'], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n03', { kind: 'start' })
  sim.run({ until: 2000 })
  assert.deepEqual(n03.admitted(), ['zc1'], "the spoke's redial landed before any peer")
  assert.equal(n03.epoch, 0, 'and taught it nothing: still open genesis, still able to form')
  //! the second member comes back; the pair forms a view of its own
  const n04 = sim.add({ uuid: 'n04', listen: 'sim:n02', hosts: ['sim:n01'], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n04', { kind: 'start' })
  sim.run({ until: 5000 })
  assert.deepEqual([n03.epoch, n04.epoch], [1, 1], 'the reborn pair committed genesis')
  assert.deepEqual(members(n03), ['n03', 'n04'])
  assert.deepEqual(members(n04), ['n03', 'n04'])
  assert.ok(n03.membership.gate(n03).open && n04.membership.gate(n04).open, 'two of two: writable')
  //! the other direction: the spoke held epoch 2 {n01}; the live cluster's epoch 1 {n03, n04} is a LOWER number
  // with other members on its new feeder — it follows the feeder (I-23 amended): the row heals, the number too
  assert.deepEqual(members(c), ['n03', 'n04'], "the spoke's members row shows the live cluster, not the dead ids")
  assert.equal(c.epoch, 1, "and its epoch is its feeder's number, down from 2")
  //! and the data plane: the spoke resyncs DOWN to the new cluster's truth (V4-5) and its writes flow again
  sim.post('zc1', { kind: 'write', recs: [{ type: REC.update, key: ['after'], value: 1 }] }, 0)
  sim.run({ until: 7000 })
  assert.equal(c.writes.pending.size, 0, 'the route completed through the reborn feeder')
  assert.equal(JSON.stringify(n03.state.get(key('after'))), '1')
  assert.equal(converged(sim), null, 'the reborn members and the spoke hold the identical fold')
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
