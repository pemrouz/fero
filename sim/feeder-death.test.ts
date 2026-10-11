//! A spoke's write when its feeder dies between the WACK and the tap (DESIGN-SCALE stage 1's one residual of
// the `acked` effect, V4-33; STATUS until wave 5e). n=3 R=2, a scoped mesh, a spoke s1 fed by P. The spoke writes a
// row owned by T and held by {T, P} — not by O, where the failover lands. P relays the attempt to T; T commits and
// fans the record out to P; at P the record clears the relayed attempt ("replication is an ACK") and P sends the
// spoke its WACK at once, then taps the record behind it on the same link. The link dies with that tap frame in the
// buffer (severOnFrame: pure tail loss, the way a real socket dies). The spoke has its WACK: the attempt left its
// queue, nothing is re-sent. It fails over to O, which does not hold the row, so the value can never reach it.
// Before the fix the write never settled: no apply carried its identity and no `acked` came. Now the WACK carries
// the lane under `l` (the feeder will tap it), the spoke keeps the coordinates while the record is unseen, and the
// failover's resync end settles every such attempt from them: committed on the owner's lane, never re-sent.
import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { formed } from './harness.ts'
import { mesh } from './scoped-sweep.ts'
import { LS } from '../kernel/link.ts'
import { Ring } from '../kernel/ring.ts'
import { VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { REC, type Applied } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'

const holdersAt = (ids: string[], p: string, r: number) => { const g = new Ring(); g.build(1, ids.map((u) => [u, 'sim:' + u] as [string, string])); return [...g.holders(p, r)] }

//! the spoke, with its settlements recorded: every apply that carries one of its own attempt identities (the join)
// and every `acked` (the sim's sink has no `acked` of its own; the api is what reads it in a real process)
const spoke = (sim: Sim, hosts: string[]) => {
  const s1 = sim.add({ uuid: 's1', listen: 'sim:s1', hosts: hosts.map((x) => 'sim:' + x), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
  const settled: { how: 'join' | 'acked'; cid: number; origin: string; seq: number; at: number }[] = []
  const sink = s1.env.sink
  const apply = sink.apply.bind(sink)
  sink.apply = (a: Applied) => { if (a.iss === 's1~1') settled.push({ how: 'join', cid: a.cid!, origin: a.origin, seq: a.seq, at: sim.now }); apply(a) }
  sink.acked = (iss, cid, origin, seq) => { if (iss === 's1~1') settled.push({ how: 'acked', cid, origin, seq, at: sim.now }) }
  sim.post('s1', { kind: 'start' }, 0)
  sim.run({ until: sim.now + 300 })
  assert.notEqual(s1.primary, null, 'the spoke has a feeder')
  const P = s1.links.get(s1.primary!)!.uuid
  const O = [...s1.links.values()].find((l) => l.uuid !== P && l.state === LS.admitted)!.uuid
  return { s1, P, O, settled }
}

//! commitsOf — every log entry, on every node and every lane, that carries this attempt identity, counted once per
// (origin, seq): the number of times the write was COMMITTED. Two would be a re-commit under a fresh stamp.
const commitsOf = (nodes: Node[], iss: string, cid: number): string[] => {
  const out = new Set<string>()
  for (const n of nodes) for (const [origin, lane] of n.logs) for (const e of lane) if (e.iss === iss && e.cid === cid) out.add(origin + '@' + e.seq)
  return [...out]
}

const scenario = (seed: number, opts: { holdsAtO: boolean; dedupKeep?: number; two?: boolean; n?: number; replicas?: number; lagO?: boolean }) => {
  const n = opts.n ?? 3, r = opts.replicas ?? 2
  const ids = Array.from({ length: n }, (_, i) => 'n0' + (i + 1))
  const sim = new Sim(seed)
  const ns = mesh(sim, n, { hb: 50, replicas: r, fault: { delay: [1, 5] }, ...(opts.dedupKeep ? { tune: { dedupKeep: opts.dedupKeep } } : {}) })
  sim.run({ until: 1500 })
  assert.ok(formed(ns) && ns.every((n) => n.armed), `seed ${seed}: formed and armed`)
  const { s1, P, O, settled } = spoke(sim, ids.slice(0, 2))
  //! the row: held by P, owned by someone other than P (so P RELAYS it — the residual's shape); at O or not
  //! (with lagO the owner must not be O either: the T-O frame is what lags)
  let k = ''
  for (let i = 0; i < 100_000 && !k; i++) {
    const h = holdersAt(ids, 'k' + i, r)
    if (h[0] !== P && (!opts.lagO || h[0] !== O) && h.includes(P) && h.includes(O) === opts.holdsAtO) k = 'k' + i
  }
  const T = holdersAt(ids, k, r)[0]
  //! a second row with the same owner and holders (the dedup leg writes both in one batch)
  let k2 = ''
  for (let i = 0; i < 100_000 && !k2; i++) {
    const h = holdersAt(ids, 'j' + i, r)
    if (h[0] === T && h.includes(P) && h.includes(O) === opts.holdsAtO) k2 = 'j' + i
  }
  //! the tap frame dies in P's buffer as the link to the spoke severs. The pair's delay is pinned to 1 ms so the
  // WACK, sent first, lands before the linkDown the sever posts (a sever's linkDown takes the pair's minimum delay)
  sim.fault(P, 's1', { delay: [1, 1] })
  sim.severOnFrame(P, 's1', VERB.RECORDS, 1)
  //! lagO: the owner's first record frame to O dies with their link too, so O holds the row but has not got the
  // record when the spoke's resync onto it ships; O learns it only from the digest after the T-O redial
  if (opts.lagO) sim.severOnFrame(T, O, VERB.RECORDS, 1)
  sim.post('s1', { kind: 'write', recs: [{ type: REC.update, key: [k], value: 'v' }, ...(opts.two ? [{ type: REC.update, key: [k2], value: 'w' }] : [])] }, 0)
  for (let t = sim.now + 1; t <= sim.now + 400 && s1.primary !== null && s1.links.get(s1.primary)?.uuid === P; t += 1) sim.run({ until: t })
  sim.partition(P, 's1')
  const wackedBeforeDeath = s1.journal.read().some((e) => e.kind === JK.writeAck && e.a === 's1~1' && e.b === 1)
  return { sim, ns, s1, P, O, T, k, k2, settled, wackedBeforeDeath }
}

test('a spoke\'s write settles when its feeder dies between the WACK and the tap and the next feeder does NOT hold the row: committed on the owner\'s lane at the failover\'s resync end, committed exactly once — on four seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { sim, ns, s1, O, T, k, settled, wackedBeforeDeath } = scenario(seed, { holdsAtO: false })
    assert.ok(wackedBeforeDeath, `seed ${seed}: the spoke had its WACK before the link died (the attempt left its queue)`)
    sim.run({ until: sim.now + 1500 })
    assert.equal(s1.links.get(s1.primary!)!.uuid, O, `seed ${seed}: fed by O now`)
    assert.ok(!s1.state.has(JSON.stringify([k])), `seed ${seed}: the value never reached the spoke (O does not hold the row)`)
    assert.equal(settled.length, 1, `seed ${seed}: the write settled once (it waited for ever before): ${JSON.stringify(settled)}`)
    assert.equal(settled[0].how, 'acked', `seed ${seed}: from the WACK's coordinates`)
    const Tn = ns.find((n) => n.uuid === T)!
    const entry = Tn.logs.get(Tn.origin)!.find((e) => e.iss === 's1~1' && e.cid === 1)!
    assert.deepEqual([settled[0].origin, settled[0].seq], [Tn.origin, entry.seq], `seed ${seed}: committed on the owner's lane, at its stamp`)
    assert.equal(commitsOf(ns, 's1~1', 1).length, 1, `seed ${seed}: committed exactly once`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: no monitor fired`)
  }
})

//! the CONTROL (V4-7 kept): the same death, but the next feeder O HOLDS the row — the resync's ship brings the record
// with its identity, the value shows, and the join settles the write; `acked` never fires.
test('the same feeder death when the next feeder DOES hold the row: the resync brings the value and the join settles it (value first, V4-7), never `acked` — on four seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { sim, ns, s1, O, k, settled, wackedBeforeDeath } = scenario(seed, { holdsAtO: true })
    assert.ok(wackedBeforeDeath, `seed ${seed}: the spoke had its WACK before the link died`)
    sim.run({ until: sim.now + 1500 })
    assert.equal(s1.links.get(s1.primary!)!.uuid, O, `seed ${seed}: fed by O now`)
    assert.equal(s1.state.get(JSON.stringify([k])), 'v', `seed ${seed}: the value reached the spoke through O`)
    assert.deepEqual(settled.map((x) => x.how), ['join'], `seed ${seed}: settled once, through the join`)
    assert.equal(commitsOf(ns, 's1~1', 1).length, 1, `seed ${seed}: committed exactly once`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: no monitor fired`)
  }
})

//! the owner's dedup window no longer knows the write (dedupKeep 1 on every member: the second write of the same
// batch pushed cid 1 out at the owner and at every holder). The settlement does not ask the window — the spoke holds
// the WACK's coordinates — and nothing is re-sent, so neither write can be committed a second time under a fresh
// stamp (a re-stamped copy could overwrite a newer write from another issuer: the A3 seed 6 class).
test('a stranded write whose dedup entry aged out at the owner (dedupKeep 1) still settles committed from the spoke\'s own coordinates, and is never committed twice — on four seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { sim, ns, s1, T, settled, wackedBeforeDeath } = scenario(seed, { holdsAtO: false, dedupKeep: 1, two: true })
    assert.ok(wackedBeforeDeath, `seed ${seed}: the spoke had its WACK before the link died`)
    const Tn = ns.find((n) => n.uuid === T)!
    assert.equal(Tn.writes.committed('s1~1', 1), undefined, `seed ${seed}: the owner's window has forgotten cid 1`)
    sim.run({ until: sim.now + 1500 })
    assert.deepEqual(settled.map((x) => [x.how, x.cid]).sort(), [['acked', 1], ['acked', 2]], `seed ${seed}: both settle, once each`)
    assert.ok(settled.every((x) => x.origin === Tn.origin), `seed ${seed}: on the owner's lane`)
    assert.equal(commitsOf(ns, 's1~1', 1).length, 1, `seed ${seed}: cid 1 committed exactly once`)
    assert.equal(commitsOf(ns, 's1~1', 2).length, 1, `seed ${seed}: cid 2 committed exactly once`)
    assert.equal(s1.writes.pending.size, 0, `seed ${seed}: nothing left to re-send`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: no monitor fired`)
  }
})

//! A KNOWN COST of the fix (wave 5e's review; STATUS): the next feeder O HOLDS the row but has NOT YET received the
// record when the spoke's resync onto it ships (n=4 R=3, holders {T, P, O}; the owner's first record frame to O dies
// with the T-O link, so O learns it only from the digest after the redial). The resync ends without the record, so
// the write settles through `acked` at the resync's end, and its value shows a moment later, when O's copy arrives
// and O taps it. Before wave 5e this schedule kept V4-7's order (the join alone, as the value showed); now `acked`
// comes first. It is still committed exactly once, and the value does show. This test PINS the cost so a change that
// fixes it (flip the order assertion) or worsens it (the value never shows, a second commit) is seen.
test('known cost: the next feeder holds the row but lags the record at the resync — `acked` settles first and the value shows after (V4-7\'s order lost here), committed once — on four seeds', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { sim, ns, s1, O, k, settled, wackedBeforeDeath } = scenario(seed, { holdsAtO: true, n: 4, replicas: 3, lagO: true })
    assert.ok(wackedBeforeDeath, `seed ${seed}: the spoke had its WACK before the link died`)
    let shown = -1
    for (let t = sim.now + 1, end = sim.now + 2000; t <= end; t += 1) { sim.run({ until: t }); if (shown < 0 && s1.state.get(JSON.stringify([k])) === 'v') shown = sim.now }
    assert.equal(s1.links.get(s1.primary!)!.uuid, O, `seed ${seed}: fed by O now`)
    assert.ok(shown > 0, `seed ${seed}: the value reached the spoke through O in the end`)
    assert.equal(settled[0]?.how, 'acked', `seed ${seed}: settled first through \`acked\` at the resync's end: ${JSON.stringify(settled)}`)
    assert.ok(settled[0].at < shown, `seed ${seed}: \`acked\` (${settled[0].at}) came before the value showed (${shown}) — the cost`)
    assert.equal(commitsOf(ns, 's1~1', 1).length, 1, `seed ${seed}: committed exactly once`)
    assert.deepEqual(sim.violations, [], `seed ${seed}: no monitor fired`)
  }
})
