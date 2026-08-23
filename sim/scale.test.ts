//! ── Tier-2 SCALE suite: the 100-node headline tier ────────────────────────────
// The laws here are the small-suite laws; the claim under test is that they hold
// at two orders of magnitude more nodes than any other suite exercises (n=100 vs
// the 2-5 everywhere else). Monitors run SAMPLED via run({checkEvery}) — the
// per-event pass is O(nodes × lanes) and would cost more than the trajectories —
// so detection may lag ≤ checkEvery events; the log-cursor monitors (log-monotone,
// single-writer, attempt-exactly-once) keep FULL fidelity under sampling, and
// state-snapshot laws are re-asserted at phase boundaries (quiesced instants),
// where the check is exact. Fixed seeds; every run bounds maxEvents explicitly
// (big-n trajectories exceed the 1M default legitimately).

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { perEvent, converged, drained, confirmedIntact, scopedConverged, exactlyR } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { CONFIRM } from '../kernel/confirm.ts'
import type { Node } from '../kernel/node.ts'

const epochs = (nodes: Node[]) => nodes.map((n) => n.epoch)
const jcount = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length

test('SCALE converge-at-100: 200 writes race a 9,900-dial mesh under dup/delay faults — every law from n=3 holds at n=100', () => {
  const sim = new Sim(0)
  const nodes = cluster(sim, 100, { fault: { delay: [1, 15], dupP: 0.1 } })
  writes(sim, nodes, 200, 300)
  const violations = sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes), 'the full 100-node mesh formed (4,950 links out of 9,900 dials)')
  assert.ok(sim.quiesced, 'quiesced — heartbeats off, so silence is reachable and total')
  assert.equal(converged(sim), null, 'all 100 nodes hold identical state')
  assert.equal(drained(sim), null, 'no paused-link queue holds frames at quiescence')

  //! confirms answered at quiescence must name records every node still holds-or-covers —
  // confirmedIntact is vacuous without them, so the scale smoke plants its own
  let id = 0
  for (const n of nodes) {
    const tail = n.logs.get(n.uuid)?.at(-1)
    if (!tail) continue
    sim.post(n.uuid, { kind: 'confirm', id: ++id, origin: n.uuid, seq: tail.seq, level: CONFIRM.replicated })
    if (id >= 10) break
  }
  assert.ok(id >= 10, 'at least 10 origins wrote — the confirm probes are real')
  sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  for (const c of sim.confirms.values()) assert.equal(c.ok, true, `confirm (${c.origin}, ${c.seq}) answered ok`)
  assert.equal(confirmedIntact(sim), null, 'nothing OK-confirmed is missing anywhere')
})

test('SCALE genesis-at-100: the mesh forms AT the lowest uuid, ONE ballot commits a 100-member view, ONE node ever proposes', () => {
  const sim = new Sim(1)
  const nodes = cluster(sim, 100, { heartbeatMs: 100 })
  const violations = sim.run({ until: 1000, checkEvery: 2000, maxEvents: 3_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes))
  assert.deepEqual(epochs(nodes), Array(100).fill(1), 'every node installed the genesis view')
  for (const n of nodes) {
    assert.equal(n.membership.view.members.length, 100, `${n.uuid}: the committed view carries all 100 members`)
    assert.equal(jcount(n, JK.viewInstall), 1, `${n.uuid}: exactly one install — no competing or re-installed views`)
  }
  //! the single-proposer law at width: genesis needs links ≥ hosts at the LOWEST uuid, and every
  // other node sorts n001 first in its own admitted set — so 99 nodes must never have proposed
  for (const n of nodes)
    if (n.uuid === 'n001') assert.ok(jcount(n, JK.propose) >= 1, 'n001 proposed the genesis ballot')
    else assert.equal(jcount(n, JK.propose), 0, `${n.uuid} must never propose — n001 is the one proposer`)
})

test('SCALE queue-overflow-at-fanout-99: 50 paused links each shed their WHOLE queue exactly once; 50 simultaneous drains re-teach it all', () => {
  const sim = new Sim(2)
  const nodes = cluster(sim, 100)
  sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  assert.ok(formed(nodes))

  const paused = [...nodes[0].links.values()].sort((a, b) => (a.uuid < b.uuid ? -1 : 1)).slice(0, 50)
  for (const l of paused) sim.post('n001', { kind: 'pause', link: l.id })
  sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  //! 500 writes > MAX_QUEUED=256: each paused link overflows ONCE — the drop clears the whole queue
  // and de-syncs, and a de-synced link is WITHHELD from fan-out, so a second overflow is impossible
  for (let i = 0; i < 500; i++) sim.post('n001', { kind: 'write', recs: [{ type: 0, key: [`k${i}`], value: i }] }, i * 0.1)
  sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  assert.equal(jcount(nodes[0], JK.dropOldest), 50, 'exactly one whole-queue drop per paused link — never a second')
  for (const l of paused) {
    assert.equal(l.queued.length, 0, `${l.uuid}: overflow clears the WHOLE queue — pure tail loss`)
    assert.equal(l.synced, false, `${l.uuid}: de-synced until the drain-time digest heals it`)
  }

  for (const l of paused) sim.post('n001', { kind: 'drain', link: l.id }, 0)
  const violations = sim.run({ checkEvery: 2000, maxEvents: 3_000_000 })
  assert.deepEqual(violations, [])
  assert.equal(converged(sim), null, '50 concurrent drain-time digest exchanges re-ship every shed tail')
  assert.equal(drained(sim), null)
  for (const l of paused) assert.equal(l.synced, true, `${l.uuid}: re-synced after the heal`)
  assert.equal(nodes[99].state.size, 500, 'a fully-paused-then-drained peer holds every record')
})

test('SCALE genesis-stalls-while-the-lowest-is-cut: nobody else may propose; epoch-0 writes flow on the open mesh; heal → one ballot', () => {
  const sim = new Sim(3)
  const nodes = cluster(sim, 50, { heartbeatMs: 100 })
  //! cut n01 from 30 of its 49 peers BEFORE any dial lands: n01 can never satisfy links ≥ hosts,
  // and every OTHER node either lacks its n01 link (links < hosts) or sorts n01 first — the
  // hosts-count gate at the lowest uuid is the ONLY thing standing between a staggered mesh and a
  // premature partial-view genesis, so pin it loudly
  for (let i = 21; i <= 50; i++) sim.partition('n01', `n${String(i).padStart(2, '0')}`)
  sim.post('n05', { kind: 'write', recs: [{ type: 0, key: ['during-stall'], value: 1 }] }, 300)
  sim.post('n35', { kind: 'write', recs: [{ type: 0, key: ['cut-side'], value: 2 }] }, 300)
  sim.run({ until: 1799, checkEvery: 1000, maxEvents: 3_000_000 })
  assert.deepEqual(epochs(nodes), Array(50).fill(0), 'genesis is STALLED — epoch 0 everywhere')
  for (const n of nodes) assert.equal(jcount(n, JK.propose), 0, `${n.uuid}: no node may propose while the lowest lacks its mesh`)
  //! the stall is not an outage: epoch 0 is the OPEN mode — writes commit and replicate meanwhile
  assert.ok(nodes[4].state.has(JSON.stringify(['during-stall'])), 'epoch-0 writes flow during the stall')

  for (let i = 21; i <= 50; i++) sim.heal('n01', `n${String(i).padStart(2, '0')}`)
  const violations = sim.run({ until: 4000, checkEvery: 1000, maxEvents: 3_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes), 'the healed mesh completes at n01')
  assert.deepEqual(epochs(nodes), Array(50).fill(1), 'ONE ballot commits view 1 after the heal')
  assert.equal(converged(sim), null, 'stall-era writes reached everyone, n01 included')
})

test('SCALE n01-starts-last: staggered starts cannot commit a premature view — genesis waits for the last (lowest) arrival', () => {
  const sim = new Sim(4)
  const n = 50
  const ids = Array.from({ length: n }, (_, i) => `n${String(i + 1).padStart(2, '0')}`)
  const addrs = ids.map((id) => `sim:${id}`)
  const nodes: Node[] = []
  //! honest staggering: a node is ADDED (listener registered) only at its start time, so early
  // dials to absentees are refused and ride the backoff chain — the model of "process not up yet"
  const boot = (i: number) => {
    const node = sim.add({
      uuid: ids[i], listen: addrs[i], hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: 100, redialMs: 50, journalCap: 1 << 16,
    })
    nodes[i] = node
    sim.post(ids[i], { kind: 'start' })
  }
  sim.monitors.push(...perEvent())
  for (let i = 1; i < n; i++) sim.at((i - 1) * 8, () => boot(i)) // n02..n50 over [0, 384)
  sim.at(800, () => boot(0)) // the lowest uuid arrives LAST
  for (const [t, uuid] of [[200, 'n07'], [400, 'n30'], [600, 'n44']] as const)
    sim.at(t, () => sim.post(uuid, { kind: 'write', recs: [{ type: 0, key: [`early-${uuid}`], value: t }] }))

  sim.run({ until: 799, checkEvery: 1000, maxEvents: 3_000_000 })
  for (const node of nodes.slice(1)) assert.equal(node.epoch, 0, `${node.uuid}: no view before the lowest uuid exists`)
  for (const node of nodes.slice(1)) assert.equal(jcount(node, JK.propose), 0, `${node.uuid}: links < hosts or n01 sorts first — either way, silent`)

  const violations = sim.run({ until: 4500, checkEvery: 1000, maxEvents: 3_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes), 'the mesh completes once n01 is up')
  assert.deepEqual(epochs(nodes), Array(n).fill(1), 'exactly one view commits, after the last arrival')
  assert.equal(converged(sim), null, 'pre-genesis writes reached the late starter via digest-on-admit')
  assert.ok(nodes[0].state.has(JSON.stringify(['early-n07'])), 'n01 holds a write issued before it existed')
})

test('SCALE exactly-R-of-50: the epoch-0 inheritance wave orphans ~everything at the arming install, then DRAINS — pure shed, no stall', () => {
  const sim = new Sim(5)
  const nodes = cluster(sim, 50, { heartbeatMs: 200, replicas: 3 })
  //! writes race formation so epoch-0 fast-path data lands EVERYWHERE before the arming install —
  // every node then holds ~every partition the ring assigns elsewhere: the mass-orphan shape.
  // Since everyone already holds everything, the wave is pure SHED — acquisition owes nothing.
  writes(sim, nodes, 150, 300)
  const violations = sim.run({ until: 6000, checkEvery: 1000, maxEvents: 5_000_000 })
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes))
  assert.deepEqual(epochs(nodes), Array(50).fill(1))
  assert.equal(exactlyR(sim), null, 'every partition is held by exactly its ring R-set, both directions')
  assert.equal(scopedConverged(sim), null, 'holders agree cell-for-cell on every partition')
  let sheds = 0
  for (const n of nodes) {
    const t = n.scope.tallies()
    assert.equal(t.orphaned, 0, `${n.uuid}: every inherited orphan shed — the wave drained`)
    assert.equal(t.acquiring, 0, `${n.uuid}: no acquisition left open`)
    assert.equal(jcount(n, JK.shedStall), 0, `${n.uuid}: no shed ever stalled — every holder answered`)
    sheds += jcount(n, JK.shed)
  }
  assert.ok(sheds > 0, 'the inheritance wave actually happened — sheds are journal-visible')
})
