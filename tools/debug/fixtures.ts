//! ── tools/debug/fixtures — real-producer captures the model and viewer suites share (wave 5e) ──
// Every capture here is a seeded sim run of real kernel Nodes — never a hand-edited capture (the honesty
// rules: a fixture authored to match the fold proves nothing). Each builder asserts it is what it claims.

import assert from 'node:assert'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes, client } from '../../sim/harness.ts'
import { captureSim } from './capture.ts'
import { REC } from '../../kernel/env.ts'

//! scopedCut — 4 members at replicas 3, one row written twice by its owner; the second write lands while the owner
// is cut from one of the row's other holders, and the capture is taken 10 ms later (before the co-holders' next
// round can carry it): two holders say 2, the cut one still says 1. Healed and run on, all three agree.
// At replicas 2 the row has two holders, so the cut leaves them one against one: an even split.
export const scopedCut = (replicas = 3) => {
  const sim = new Sim(3)
  const nodes = cluster(sim, 4, { heartbeatMs: 50, replicas })
  sim.run({ until: 1500 })
  assert.ok(nodes.every((n) => n.armed), 'the view armed scoping')
  const hs = nodes[0].writes.ring.holders('row', replicas)
  const owner = hs[0], lagging = hs[replicas - 1]
  sim.post(owner, { kind: 'write', recs: [{ type: REC.update, key: ['row'], value: 1 }] })
  sim.run({ until: 1800 })
  sim.partition(owner, lagging)
  sim.post(owner, { kind: 'write', recs: [{ type: REC.update, key: ['row'], value: 2 }] })
  sim.run({ until: 1810 })
  const cut = captureSim(sim)
  const v = (u: string) => cut.nodes.find((n) => n.uuid === u)!.state.find(([k]) => k === '["row"]')?.[1]
  assert.equal(v(owner), 2); assert.equal(v(lagging), 1, 'the cut holder lags — the fixture is what it claims')
  sim.heal(owner, lagging)
  sim.run({ until: 4000 })
  const healed = captureSim(sim)
  return { cut, healed, owner, lagging, row: 'row' }
}

//! scopedTenure — 5 members at replicas 2 and a client: writes; then a row n04 co-holds is written once, n04 is cut
// from that row's owner and the row is written again (n04 misses it, a real miss while it was in); then n04 leaves and
// n05 is cut from everyone (voted out: its own view still names it), then more writes by the three that stay. The
// client's feeder holds some rows only, the leaver held some rows while it was in, the voted-out member keeps a stale
// view. Returns the capture and the one write n04 was meant to get and never did.
export const scopedTenure = () => {
  const sim = new Sim(11)
  const nodes = cluster(sim, 5, { heartbeatMs: 50, replicas: 2 })
  writes(sim, nodes, 6, 100) // before the view arms: every node gets every row, and the rows it is not assigned freeze into orphans at arming
  sim.run({ until: 1500 })
  client(sim, 'zc1', nodes.slice(0, 3), { heartbeatMs: 50 })
  sim.run({ until: 2500 })
  writes(sim, nodes, 10, 200)
  sim.run({ until: 4000 })
  const ring = nodes[0].writes.ring
  let key = ''
  for (let i = 0; i < 200 && !key; i++) { const hs = ring.holders('miss' + i, 2); if (hs[1] === 'n04' && hs[0] !== 'n05') key = 'miss' + i }
  assert.ok(key, 'a row n04 co-holds under another owner')
  const owner = ring.holders(key, 2)[0]
  sim.post(owner, { kind: 'write', recs: [{ type: REC.update, key: [key], value: 'seen' }] })
  sim.run({ until: 4100 })
  sim.partition(owner, 'n04')
  sim.post(owner, { kind: 'write', recs: [{ type: REC.update, key: [key], value: 'missed' }] })
  sim.run({ until: 4110 })
  sim.post('n04', { kind: 'leave' })
  for (const n of nodes) if (n.uuid !== 'n05') sim.partition('n05', n.uuid)
  sim.partition('n05', 'zc1')
  sim.run({ until: 12000 })
  sim.heal(owner, 'n04')
  writes(sim, nodes.slice(0, 3), 8, 200)
  sim.run({ until: 16000 })
  const cap = captureSim(sim)
  const by = (u: string) => cap.nodes.find((n) => n.uuid === u)!
  assert.ok(!by('n04').view.members.includes('n04') && by('n04').journal.some((e) => e.kind === cap.vocab.left), 'n04 left (its exit row)')
  assert.ok(by('n05').view.members.includes('n05') && !by('n01').view.members.includes('n05'), 'n05 was voted out and never heard')
  assert.ok(by('zc1').client && by('zc1').feeder, 'the client names its feeder')
  const missed = by(owner).logs[owner].find((x) => x.k[0] === key && x.v === 'missed')!
  assert.ok(missed, 'the owner stamped the second write')
  assert.ok(!by('n04').journal.some((e) => e.kind === cap.vocab.applyInbound && e.a === owner && e.b === missed.seq), 'n04 never applied it')
  return { cap, missed: `${owner}#${missed.seq}` }
}

//! unscopedLeaver — 4 unscoped members: writes, then n01 writes `zeta` and `gone` once (every node gets them), n04
// leaves cleanly and is cut from the rest, and n01 writes `zeta` three more times and removes `gone`. n04 keeps its old
// copy by design: the writes after its leave were never meant for it, so `gone` is a cell only the leaver still holds.
// Returns the capture, the write stamped while n04 was in, and the three after.
export const unscopedLeaver = () => {
  const sim = new Sim(7)
  const nodes = cluster(sim, 4, { heartbeatMs: 50 })
  writes(sim, nodes, 6, 100)
  sim.run({ until: 1500 })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['zeta'], value: 'before' }] })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['gone'], value: 'kept' }] })
  sim.run({ until: 2000 })
  sim.post('n04', { kind: 'leave' })
  sim.run({ until: 6000 })
  for (const n of nodes) if (n.uuid !== 'n04') sim.partition('n04', n.uuid)
  for (let i = 0; i < 3; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['zeta'], value: 'after' + i }] }, i * 5)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: ['gone'] }] }, 20)
  sim.run({ until: 9000 })
  const cap = captureSim(sim)
  const by = (u: string) => cap.nodes.find((n) => n.uuid === u)!
  const zeta = (u: string) => by(u).state.find(([k]) => k === '["zeta"]')?.[1]
  assert.ok(by('n04').journal.some((e) => e.kind === cap.vocab.left) && !by('n01').view.members.includes('n04'), 'n04 left (its exit row, and the stayers\' view)')
  assert.equal(by('n01').held, undefined, 'unscoped: no node carries `held`')
  assert.ok(['n01', 'n02', 'n03'].every((u) => JSON.stringify(zeta(u)) === JSON.stringify(zeta('n01'))) && JSON.stringify(zeta('n04')) !== JSON.stringify(zeta('n01')),
    'the stayers agree on zeta and n04 keeps its old copy — the fixture is what it claims')
  assert.ok(['n01', 'n02', 'n03'].every((u) => !by(u).state.some(([k]) => k === '["gone"]')) && by('n04').state.some(([k, v]) => k === '["gone"]' && v === 'kept'),
    'only the leaver still holds `gone`')
  const log = by('n01').logs.n01.filter((x) => x.k[0] === 'zeta')
  assert.equal(log.length, 4)
  return { cap, before: `n01#${log[0].seq}`, after: log.slice(1).map((x) => `n01#${x.seq}`) }
}

//! mixed — two resources in one sim, the way a server sits beside the #directory it hosts: `shop` on two members,
// `#directory` on one; each writes its own rows. The HELLO refuses a different name, so they never link.
export const mixed = () => {
  const sim = new Sim(5)
  const add = (uuid: string, name: string, peers: string[]) =>
    sim.add({ uuid, name, listen: `sim:${uuid}`, hosts: peers.map((p) => `sim:${p}`), redialMs: 20, journalCap: 1 << 16 })
  const shop = [add('s1', 'shop', ['s2']), add('s2', 'shop', ['s1'])]
  const dir = add('d1', '#directory', [])
  for (const n of [...shop, dir]) sim.post(n.uuid, { kind: 'start' })
  sim.run()
  writes(sim, shop, 4, 20)
  sim.post('d1', { kind: 'write', recs: [{ type: REC.update, key: ['shop'], value: { at: 'sim:s1' } }] })
  sim.run()
  const cap = captureSim(sim)
  assert.ok(cap.quiesced, 'the run went still')
  const h = (u: string) => cap.nodes.find((n) => n.uuid === u)!.stateHash
  assert.ok(h('s1') === h('s2') && h('s1') !== h('d1'), 'the two shop members agree; the directory holds other data')
  return cap
}
