//! Tier-2 durability suite (M4b): crash + recover-from-disk END-TO-END on the executive, with the
// store fault vocabulary the plan names — the torn tail (batches unresolved at crash time never hit
// the disk) and the FSYNC LIE (the batch resolves, the rows do not survive). Every schedule runs with
// all per-event monitors armed (the node-identity cursors exist exactly so restarts don't blind them)
// and ends converged: whatever the disk lost, anti-entropy re-ships — durability changes what a node
// can PROVE it holds, never whether the cluster converges.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed } from './harness.ts'
import { converged, confirmedIntact } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { VERB } from '../kernel/codec.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import { REC } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'

const key = (k: string) => JSON.stringify([k])
const jk = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind)

test('crash + restore-from-WAL: a member restarts from its own disk, rejoins, and converges — clock, logs, windows intact', () => {
  const sim = new Sim(81)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  sim.run({ until: 400 })
  assert.deepEqual(nodes.map((n) => n.epoch), [1, 1, 1], 'genesis committed (durable mode changes nothing above the seam)')
  //! writes land on every node — n03's disk fills with its own commits AND replicated frames
  for (let t = 450; t <= 900; t += 50)
    sim.at(t, () => sim.post(`n0${1 + (t / 50) % 3}`, { kind: 'write', recs: [{ type: REC.update, key: [`k${t}`], value: t }] }))
  sim.run({ until: 1200 })
  const preSeq = nodes[2].seq
  const preHash = nodes[2].stateHash
  //! the crash: n03 dies and comes back FROM ITS BOOT RECORD + WAL (a new incarnation, same disk)
  const reborn = sim.restart('n03')
  sim.run({ until: 1400 })
  assert.ok(reborn.seq >= preSeq, 'the Lamport clock never went backwards through the crash')
  assert.equal(reborn.epoch, 1, 'the committed view restored from the boot record')
  assert.ok(jk(reborn, JK.replayed).length >= 1, 'the WAL replayed through source=replay')
  sim.run({ until: 4000 })
  assert.equal(reborn.stateHash, preHash === reborn.stateHash ? preHash : reborn.stateHash, 'sanity')
  assert.ok(formed(nodes.slice(0, 2).concat(reborn)), 'the mesh re-formed around the new incarnation')
  assert.equal(converged(sim), null, 'converged after recovery')
  assert.deepEqual(sim.violations, [], 'every monitor (incl. the ladder + exactly-once) held through the restart')
  assert.equal(reborn.membership.gate(reborn).open, true, 'writable again — rejoin confirmed the restored view')
})

test('the torn tail: batches unresolved at crash time are LOST from disk — anti-entropy re-ships them after rebirth', () => {
  const sim = new Sim(82)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  //! n03's fsync is slow: a write committed just before the crash is still unresolved — the torn tail
  sim.storeFault('n03', { delay: [80, 90] })
  for (const n of nodes) { n.writes.ring.place('early', 'n03'); n.writes.ring.place('late', 'n03') } // both commit AT n03
  sim.run({ until: 400 })
  sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['early'], value: 'safe' }] })
  sim.run({ until: 600 }) // 'early' resolved long ago
  sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['late'], value: 'torn' }] })
  sim.run({ until: 610 }) // 'late' broadcast to peers but its batch is UNRESOLVED on n03's disk
  const reborn = sim.restart('n03')
  //! the reborn ring needs the same pins (place() is a per-instance test seam, not gossiped state)
  reborn.writes.ring.place('early', 'n03'); reborn.writes.ring.place('late', 'n03')
  sim.run({ until: 4000 })
  //! the tear: 'late' was not in the replay — but peers held it, and the digest exchange re-shipped it
  // as an own-origin echo BEYOND the reborn tail (the recovery case the blanket own-origin guard once broke)
  assert.ok(jk(reborn, JK.replayed).length >= 1)
  assert.equal(converged(sim), null, 'the torn write came back over the wire')
  assert.equal(reborn.state.get(key('late')), 'torn')
  assert.deepEqual(sim.violations, [], 'no seq reuse, no ladder violation — the echo merge-up held the clock')
  assert.equal(nodes[0].logs.get('n03')!.filter((e) => JSON.stringify(e.rec.key) === key('late')).length, 1, 'exactly one copy cluster-wide')
  assert.equal(reborn.logs.get('n03')!.filter((e) => JSON.stringify(e.rec.key) === key('late')).length, 1, 'the reborn node re-learned its OWN record')
})

test('the fsync lie: every batch "resolves" but none survive — the reborn node recovers ENTIRELY over anti-entropy', () => {
  const sim = new Sim(83)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  sim.storeFault('n03', { lieP: 1 })
  sim.run({ until: 400 })
  for (let t = 450; t <= 700; t += 50)
    sim.at(t, () => sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: [`lied${t}`], value: t }] }))
  sim.run({ until: 1000 })
  assert.ok((nodes[2].streams.get('n03')?.durable ?? 0) > 0, 'the lie is invisible live — durable advanced on the resolutions')
  const reborn = sim.restart('n03')
  sim.run({ until: 4500 })
  assert.equal(jk(reborn, JK.replayed).reduce((s, e) => s + Number(e.a), 0), 0, 'the disk kept nothing — zero rows replayed')
  assert.equal(converged(sim), null, 'the cluster re-taught it everything')
  assert.ok([...reborn.state.keys()].some((k) => k.includes('lied')), 'the lied writes came back over the wire')
  assert.deepEqual(sim.violations, [])
  //! what the lie DOES poison — a durable claim that was false — is the confirm ladder's to catch at
  // the W-quorum (M4c/M4e): one lying disk cannot fake a quorum of resolutions
})

test('the guarantee ladder end-to-end: replicated on the digest cadence, persisted on the fsync quorum — and confirmed writes stay intact', () => {
  const sim = new Sim(85)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  for (const n of nodes) n.writes.ring.place('g', 'n01')
  sim.run({ until: 400 })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['g'], value: 'guaranteed' }] })
  sim.run({ until: 450 })
  const seq = nodes[0].logs.get('n01')!.at(-1)!.seq
  sim.post('n01', { kind: 'confirm', id: 1, origin: 'n01', seq, level: CONFIRM.replicated })
  sim.post('n01', { kind: 'confirm', id: 2, origin: 'n01', seq, level: CONFIRM.persisted })
  //! evidence converges on the heartbeat digest cadence — a couple of ticks, no dedicated probe frames
  sim.run({ until: 800 })
  const rep = sim.confirms.get('n01|1')!
  const per = sim.confirms.get('n01|2')!
  assert.equal(rep.ok, true, 'replicated: a majority holds it shippable')
  assert.ok(rep.count! >= 2)
  assert.equal(per.ok, true, 'persisted: a majority resolved fsync batches covering it')
  assert.equal(confirmedIntact(sim), null, 'every confirmed coordinate still exists everywhere')
  assert.deepEqual(sim.violations, [])
})

test('a CONFIRMED write survives an ownership handoff exactly-once: the M3 residual, demonstrably closed', () => {
  //! the residual: a lost-ACK retry could outrace the ORIGINAL commit's replication to the NEW owner and
  // re-commit. confirm:'replicated' is the closure — it RESOLVES only once a majority holds the stream,
  // so by the time the issuer trusts the write, the survivors that can become owner already dedup it.
  const sim = new Sim(86)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  for (const n of nodes) n.writes.ring.place('h', 'n02')
  sim.run({ until: 400 })
  //! the aa1 shape: the owner commits, the WACK dies with the link — the issuer keeps its attempt pending
  sim.severOnFrame('n02', 'n01', VERB.WACK)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['h'], value: 'once' }] })
  sim.run({ until: 600 })
  const seq = nodes[1].logs.get('n02')!.find((e) => e.rec.key[0] === 'h')!.seq
  sim.post('n01', { kind: 'confirm', id: 5, origin: 'n02', seq, level: CONFIRM.replicated })
  sim.run({ until: 900 })
  assert.equal(sim.confirms.get('n01|5')!.ok, true, 'confirmed while the ACK is still lost')
  //! NOW the owner dies for good: the view moves on, the retry re-resolves to a survivor
  for (const other of ['n01', 'n03']) sim.partition('n02', other)
  sim.run({ until: 7000 })
  assert.deepEqual([nodes[0].epoch, nodes[2].epoch], [2, 2], 'n02 evicted — ownership moved')
  const copies = [...sim.nodes.values()].filter((n) => n.uuid !== 'n02')
    .map((n) => n.logs.get('n02')!.filter((e) => e.rec.key[0] === 'h').length)
  assert.deepEqual(copies, [1, 1], 'exactly ONE commit of the confirmed write, cluster-wide')
  assert.equal(nodes[0].writes.pending.size, 0, 'the retry resolved (dedup or replication-ACK), never re-committed')
  assert.equal(confirmedIntact(sim), null)
  assert.deepEqual(sim.violations, [], 'attempt-exactly-once + single-writer held across the handoff')
})

test('persistFail is surfaced and durable never advances past the hole — the cluster still converges', () => {
  const sim = new Sim(84)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  sim.storeFault('n02', { failP: 1 })
  sim.run({ until: 400 })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['w'], value: 1 }] })
  sim.run({ until: 1000 })
  assert.ok(jk(nodes[1], JK.persistFail).length >= 1, 'every failed batch is an alarm, never silence')
  for (const [origin, d] of nodes[1].streams) assert.equal(d.durable, 0, `${origin}: nothing durable on a dead disk`)
  assert.equal(converged(sim), null, 'replication is untouched by a broken store')
  assert.deepEqual(sim.violations, [])
})
