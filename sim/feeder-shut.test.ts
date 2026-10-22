//! A client whose feeder's write-gate SHUTS while another linked server's gate is open (wave 6b, DECISIONS V4-58).
// Before: a client moved only when its feeder's link died. Fed by a member the others had refused (the r2 platform
// spike, 2026-10-11), it timed out 80 of 80 calls over 20 s while two members took writes, and all 80 landed later —
// the relay parks a write behind its closed gate, and nothing on the link said "go elsewhere". Now the client keeps
// every linked server's last gate word (`w` on a digest or a PONG toward a client link, kernel/link.ts gateOpen) and
// closes its feeder link on purpose when the feeder says shut and another says open (kernel/node.ts #refeed); the
// linkDown that follows is the ordinary failover, with the election preferring an open gate.
// Two shapes, several seeds each: a cut that leaves the feeder in the MINORITY (its links to the other members die; the
// client's link to it stays up) on an unscoped cluster and on a scoped mesh (replicas 2). Pinned: the client is fed by
// an open member within FOUR heartbeats of the feeder's gate closing; a write issued while it still sat on the shut
// feeder (parked there) and one issued after the move both land — once — and show at the client (the receipt, V4-7:
// the value shows, then the write settles); on the scoped mesh the move is a resync and M12 (the spoke mirrors its
// feeder's held subset) holds at the quiet point; what the old feeder parked left its queue at the client's linkDown
// (write.ts dropVia), so after the heal nothing is forwarded twice: every key committed exactly once.
// Each shape runs two client ids: one that sorts ABOVE every member ('zc1', 's1': the servers digest it, so the gate word
// rides their digests) and one that sorts BELOW them ('a1': the client PINGs, no digest flows to it, and the word rides
// the servers' PONGs — the wire path a bare PONG would silence).
import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, client, formed } from './harness.ts'
import { converged, spokeMirror } from './monitors.ts'
import { mesh } from './scoped-sweep.ts'
import { JK } from '../kernel/journal.ts'
import { REC } from '../kernel/env.ts'
import { LS } from '../kernel/link.ts'
import type { Node } from '../kernel/node.ts'

const HB = 50
const key = (k: string) => JSON.stringify([k])
const jk = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind)
const fed = (c: Node): string | null => (c.primary === null ? null : c.links.get(c.primary)!.uuid)
//! commits — how many times a key was committed across every member lane, counted once per (origin, seq)
const commits = (members: Node[], k: string): number => {
  const seen = new Set<string>()
  for (const m of members) for (const [origin, lane] of m.logs) for (const e of lane) if (JSON.stringify(e.rec.key) === key(k)) seen.add(origin + '@' + e.seq)
  return seen.size
}
//! closedAt — step in 5 ms slices until the feeder's own gate has closed (its links to the others die at the cut; the
// gate re-reads at the linkDown): the moment the clock of the pin starts. Fine slices: a client whose word rides PONGs
// can move within one heartbeat of the close, and the pin wants the instant the client was still on the shut feeder
const closeOf = (sim: Sim, feeder: Node, horizon: number): number => {
  for (let t = sim.now + 5; t <= horizon; t += 5) {
    sim.run({ until: t })
    if (!feeder.membership.gate(feeder).open) return sim.now
  }
  return -1
}

test('wave 6b — unscoped: the feeder is cut into the minority, the client is fed by an open member within four heartbeats, a write parked at the shut feeder and one after the move both land once and show at the client; healed, the old feeder is a spare', () => {
  for (const [cid, seed] of [['zc1', 1], ['zc1', 2], ['zc1', 3], ['zc1', 4], ['zc1', 5], ['zc1', 6], ['a1', 1], ['a1', 2], ['a1', 3], ['a1', 4], ['a1', 5], ['a1', 6]] as const) {
    const tag = `client ${cid}, seed ${seed}`
    const sim = new Sim(seed)
    const members = cluster(sim, 3, { heartbeatMs: HB, fault: { delay: [1, 5] } })
    const c = client(sim, cid, members, { heartbeatMs: HB })
    sim.run({ until: 1500 })
    //! formed() counts strictly and a spoke ADDS admitted links: check the member mesh explicitly
    assert.ok(members.every((m) => members.every((o) => o === m || m.admitted().includes(o.uuid))) && c.primary !== null, `${tag}: formed, the client has a feeder`)
    const P = fed(c)!
    const feeder = members.find((m) => m.uuid === P)!
    const others = members.filter((m) => m.uuid !== P)
    sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['before'], value: seed }] }, 0)
    sim.run({ until: sim.now + 200 })
    assert.equal(JSON.stringify(c.state.get(key('before'))), String(seed), `${tag}: a write before the cut shows at the client`)
    //! the cut: the feeder loses the other two; the client keeps its link to it
    for (const o of others) sim.partition(P, o.uuid)
    const closedAt = closeOf(sim, feeder, sim.now + 2000)
    assert.ok(closedAt > 0, `${tag}: the cut-off feeder's gate closed`)
    //! a write issued now goes to the shut feeder, which parks it behind its gate — or, when the word beat this look
    // (a PONG in flight as the gate closed: the client can be on the open member within a few ms), to the open one
    sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['parked'], value: 'p' + seed }] }, 1)
    sim.run({ until: closedAt + 4 * HB })
    const now = fed(c)
    assert.ok(now !== null && now !== P, `${tag}: fed by another member within four heartbeats of the gate closing (fed by ${now})`)
    assert.equal(c.feederOpen, true, `${tag}: and that member's gate is open`)
    assert.equal(jk(c, JK.refeed).length, 1, `${tag}: one deliberate close`)
    //! a write after the move. Both land at the majority — a key the cut-off feeder OWNS waits for its eviction (the
    // new relay parks it: owner unreachable), about eight heartbeats of suspicion plus the ballot; the bound covers it
    sim.post(c.uuid, { kind: 'write', recs: [{ type: REC.update, key: ['after'], value: 'a' + seed }] }, 1)
    const landed = () => ['parked', 'after'].every((k) => others.every((o) => o.state.has(key(k))) && c.state.has(key(k)))
    for (let t = sim.now + HB; t <= closedAt + 24 * HB && !landed(); t += HB) sim.run({ until: t })
    assert.ok(landed(), `${tag}: both writes landed at the majority and show at the client within 24 heartbeats of the gate closing (parked owner ${others[0].writes.ring.ownerOf('parked')}, after owner ${others[0].writes.ring.ownerOf('after')})`)
    assert.equal(c.writes.pending.size, 0, `${tag}: nothing in flight`)
    //! the heal: the old feeder rejoins with nothing parked for this client (dropVia at the close); nothing commits twice
    for (const o of others) sim.heal(P, o.uuid)
    sim.run({ until: sim.now + 6000 })
    assert.ok(feeder.membership.gate(feeder).open, `${tag}: the healed feeder is writable again`)
    assert.equal(fed(c), now, `${tag}: the client stays on the member it moved to`)
    assert.equal(jk(c, JK.refeed).length, 1, `${tag}: no second move`)
    const spare = [...c.links.values()].find((l) => l.uuid === P)
    assert.ok(spare !== undefined && spare.state === LS.admitted && spare.gateOpen === true, `${tag}: the old feeder is a linked spare, its open gate heard`)
    for (const k of ['before', 'parked', 'after']) assert.equal(commits(members, k), 1, `${tag}: '${k}' committed exactly once`)
    assert.equal(converged(sim), null, `${tag}: converged`)
    assert.deepEqual(sim.violations, [], `${tag}: no monitor fired`)
  }
})

test('wave 6b — scoped (replicas 2): the same cut, the move is a resync onto an open holder, the writes land once and show at the spoke, M12 holds at the quiet point', () => {
  for (const [cid, seed] of [['s1', 1], ['s1', 2], ['s1', 3], ['s1', 4], ['a1', 1], ['a1', 2], ['a1', 3], ['a1', 4]] as const) {
    const tag = `spoke ${cid}, seed ${seed}`
    const sim = new Sim(seed)
    const ns = mesh(sim, 3, { hb: HB, replicas: 2, fault: { delay: [1, 5] } })
    sim.run({ until: 1500 })
    assert.ok(formed(ns) && ns.every((n) => n.armed), `${tag}: formed and armed`)
    const s1 = sim.add({ uuid: cid, listen: 'sim:' + cid, hosts: ns.map((x) => 'sim:' + x.uuid), heartbeatMs: HB, client: true, redialMs: 20, journalCap: 1 << 16 })
    sim.post(cid, { kind: 'start' }, 0)
    sim.run({ until: sim.now + 400 })
    assert.notEqual(s1.primary, null, `${tag}: the spoke has a feeder`)
    const P = fed(s1)!
    const feeder = ns.find((n) => n.uuid === P)!
    const others = ns.filter((n) => n.uuid !== P)
    for (let i = 0; i < 6; i++) sim.post(others[0].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['r' + i], value: i }] }, i * 3)
    sim.run({ until: sim.now + 300 })
    for (const o of others) sim.partition(P, o.uuid)
    const closedAt = closeOf(sim, feeder, sim.now + 2000)
    assert.ok(closedAt > 0, `${tag}: the cut-off feeder's gate closed`)
    sim.post(cid, { kind: 'write', recs: [{ type: REC.update, key: ['parked'], value: 'p' }] }, 1) // parked at the shut feeder, or at the open one when the word beat this look
    sim.run({ until: closedAt + 4 * HB })
    const now = fed(s1)
    assert.ok(now !== null && now !== P, `${tag}: fed by another holder within four heartbeats (fed by ${now})`)
    assert.equal(jk(s1, JK.refeed).length, 1, `${tag}: one deliberate close`)
    assert.ok(jk(s1, JK.resync).length >= 1, `${tag}: a scoped move is a resync`)
    sim.post(cid, { kind: 'write', recs: [{ type: REC.update, key: ['after'], value: 'a' }] }, 1)
    sim.run({ until: closedAt + 16 * HB })
    assert.equal(s1.resync, null, `${tag}: the resync ended`)
    assert.equal(s1.writes.pending.size, 0, `${tag}: nothing in flight`)
    for (const o of others) sim.heal(P, o.uuid)
    sim.run({ until: sim.now + 6000 })
    assert.equal(fed(s1), now, `${tag}: the spoke stays on the holder it moved to`)
    assert.equal(jk(s1, JK.refeed).length, 1, `${tag}: no second move`)
    for (const k of ['parked', 'after']) assert.equal(commits(ns, k), 1, `${tag}: '${k}' committed exactly once`)
    //! the receipt on a scoped spoke: a key its feeder holds shows there; one it does not settled from its WACK (V4-43)
    const F = ns.find((n) => n.uuid === now)!
    for (const k of ['parked', 'after']) if (F.state.has(key(k))) assert.ok(s1.state.has(key(k)), `${tag}: '${k}' shows at the spoke, its feeder holds it`)
    assert.equal(spokeMirror(sim, cid), null, `${tag}: M12 — the spoke mirrors its feeder's held subset`)
    assert.deepEqual(sim.violations, [], `${tag}: no monitor fired`)
  }
})
