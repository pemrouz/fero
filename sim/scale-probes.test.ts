//! Stage 0 of DESIGN-SCALE (2026-10-09): the scale monitors' planted violations, the two unscoped probes pinned
// RED TODAY, and the three counted floors recorded from today's kernel.
//
// Planted violations: every monitor M1-M9 of sim/monitors.ts gets a schedule or an injected fault that MUST turn
// it red, and a non-vacuity count (the monitor saw at least N checks in the family it guards). A monitor that
// cannot be turned red proves nothing when it stays green. M4 (the per-partition index oracle) is stage 1's: its
// stub goes red the moment `node.byPart` exists, so stage 1 cannot land the index without filling it in.
//
// Red today: the short-lane resurrection and the zombie lane (DESIGN-SCALE §2; STATUS "After tombstone GC and
// compaction, a removed row can come back from a short lane" and "A write from an evicted member beats a newer
// remove after a heal"). Both are built here WITHOUT the test seams the panel's probes used (no ring.place, no
// link.synced poke): ownership moves by a clean leave, and the zombie's write dies in the kernel buffer as its
// links sever (severOnFrame). Each test asserts today's WRONG outcome and that M1 sees it; the fix (lane
// accounting before a release, its own decision: §14 Q7) makes the first assertion fail, and whoever lands it
// flips the pin to the right outcome.
//
// Counted floors: frames per verb from the sink tally (sim/scoped-sweep.ts frameTally) on the panel's own setup
// (seed 13, n=30, R=3, heartbeat 200 ms, delay [1,1], 300 single-row partitions, then one join). Stage 2 moves the
// first two on purpose; it re-pins them with the WHY.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed } from './harness.ts'
import { armScale, ledgerOf, stampOracle, floorsAgree, boundedLogs, converged, scopedConverged, exactlyR } from './monitors.ts'
import { mesh, join, frameTally, perTick, inject, type MeshOpts } from './scoped-sweep.ts'
import { Ring } from '../kernel/ring.ts'
import { VERB } from '../kernel/codec.ts'
import { JK } from '../kernel/journal.ts'
import { REC } from '../kernel/env.ts'
import { compact } from '../kernel/log.ts'
import type { Node } from '../kernel/node.ts'

//! keyFor — the first key `prefix<i>` whose R-holders under each member list satisfy `want` (the real ring, no pin)
const holdersAt = (ids: string[], p: string, r: number) => { const g = new Ring(); g.build(1, ids.map((u) => [u, 'sim:' + u] as [string, string])); return [...g.holders(p, r)] }
const keyFor = (prefix: string, want: (h: (ids: string[], r: number) => string[]) => boolean): string => {
  for (let i = 0; i < 100_000; i++) { const k = prefix + i; if (want((ids, r) => holdersAt(ids, k, r))) return k }
  throw new Error('no key')
}
const named = (sim: Sim, monitor: string) => sim.violations.filter((v) => v.monitor === monitor)
const count = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length
//! leave — a clean leave; the node is torn down the moment `left` is reported, like the shell
const leave = (sim: Sim, id: string) => {
  sim.post(id, { kind: 'leave' }, 0)
  const until = sim.now + 5000
  for (let t = sim.now; !sim.left.has(id) && t < until; t += 5) sim.run({ until: t })
  assert.ok(sim.left.has(id), `${id} left`)
  for (const u of sim.nodes.keys()) if (u !== id) sim.partition(id, u)
  sim.nodes.get(id)!.destroy(); sim.nodes.delete(id)
}

// ── RED TODAY: the two unscoped holes ───────────────────────────────────────────────────────────

//! shortLane — three unscoped nodes. n02 owns x and writes it (one record: its lane stays short). n02 leaves
// cleanly, x moves to n01, n01 removes it and then writes 100 rows of its own, so n01's lane passes compactAt.
// Tombstone GC releases x's stamp; compaction then drops the remove (no longer a winner). n02's lone write stays
// in its lane everywhere: a fresh fold brings x back.
const shortLane = (durable: boolean) => {
  const x = keyFor('x', (h) => h(['n01', 'n02', 'n03'], 1)[0] === 'n02' && h(['n01', 'n03'], 1)[0] === 'n01')
  const rows: string[] = []
  for (let i = 0; rows.length < 140; i++) if (holdersAt(['n01', 'n03'], 'r' + i, 1)[0] === 'n01') rows.push('r' + i)
  const X = JSON.stringify([x])
  const sim = new Sim(3)
  const o: MeshOpts = { hb: 50, durable, tune: { compactAt: 64, snapshotAt: 32 } }
  const [a, z, w] = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  assert.ok(formed([a, z, w]))
  sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: [x], value: { v: 1 } }] }, 0)
  sim.run({ until: sim.now + 500 })
  leave(sim, 'n02')
  sim.run({ until: sim.now + 1000 })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: [x] }] }, 0)
  rows.slice(0, 100).forEach((k, i) => sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [k], value: i }] }, 10 + i))
  sim.run({ until: sim.now + 4000 })
  assert.deepEqual([a, w].map((n) => count(n, JK.tombstoneGC) > 0 && count(n, JK.compacted) > 0), [true, true], 'both passes ran on both members')
  assert.ok(!a.logs.get('n01')!.some((e) => e.rec.key[0] === x) && a.logs.get('n02')!.some((e) => e.rec.key[0] === x), 'the remove left n01\'s lane; the old write is still n02\'s last entry')
  assert.deepEqual(sim.violations, [], 'nothing has come back yet')
  return { sim, a, w, x: X, rows }
}

test('RED TODAY, short lane (memory): after GC and compaction a fresh joiner folds a removed row back from a short lane — M1 and M3 see it', () => {
  const { sim, a, w, x } = shortLane(false)
  join(sim, 'n04', { hb: 50, tune: { compactAt: 64, snapshotAt: 32 } })
  sim.run({ until: sim.now + 6000 })
  const j = sim.nodes.get('n04')!
  //! TODAY'S WRONG OUTCOME, pinned: the joiner shows x while both members have it absent. The fix flips this.
  assert.deepEqual([a.state.has(x), w.state.has(x), j.state.get(x)], [false, false, { v: 1 }], 'RED TODAY: the joiner resurrected x (when this fails, the short-lane fix landed: flip the pin)')
  assert.match(stampOracle(sim) ?? '', /n04 shows .* which the fold by stamp removes .* resurrected/, 'M1 (horizon) names the resurrection')
  assert.ok(named(sim, 'release-safety').some((v) => v.detail.startsWith('n04 shows')), 'M3 fires at the event the joiner applied the old write')
  assert.match(converged(sim) ?? '', /n01 vs n04/, 'converged() sees this one only because the members disagree with the joiner')
})

test('RED TODAY, short lane (durable): a member restarted from its own disk after the snapshot brings the removed row back — M1 fires at the restart', () => {
  const { sim, w, x, rows } = shortLane(true)
  //! more rows after both passes, so a later snapshot writes the COMPACTED log to disk
  rows.slice(100).forEach((k, i) => sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [k], value: i }] }, 10 + i))
  sim.run({ until: sim.now + 3000 })
  const reborn = sim.restart('n01')
  sim.run({ until: sim.now + 4000 })
  assert.deepEqual([reborn.state.get(x), w.state.has(x)], [{ v: 1 }, false], 'RED TODAY: n01 came back from its disk with x (when this fails, the short-lane fix landed: flip the pin)')
  assert.ok(named(sim, 'stamp-oracle').some((v) => v.detail.startsWith('n01 shows')), 'M1 (per event) fires at the restarted node')
  assert.match(stampOracle(sim) ?? '', /resurrected/)
})

test('RED TODAY, zombie lane: a write stranded on an evicted owner beats a newer remove after the heal — M6 at the release, M1 and M3 at the heal', () => {
  const ids = ['n01', 'n02', 'n03', 'n04']
  const x = keyFor('x', (h) => h(ids, 1)[0] === 'n04')
  const X = JSON.stringify([x])
  const sim = new Sim(7)
  const ns = mesh(sim, 4, { hb: 50 })
  sim.run({ until: 1500 })
  assert.ok(formed(ns))
  sim.post('n04', { kind: 'write', recs: [{ type: REC.update, key: [x], value: { v: 1 } }] }, 0)
  sim.run({ until: sim.now + 500 })
  assert.deepEqual(ns.map((n) => n.state.get(X)), ns.map(() => ({ v: 1 })))
  //! the stranded commit, doctrine-clean: each RECORDS frame carrying it dies in the kernel buffer as its link
  // severs (tail loss), and the owner is cut off before a redial can re-ship it
  for (const o of ['n01', 'n02', 'n03']) sim.severOnFrame('n04', o, VERB.RECORDS)
  sim.post('n04', { kind: 'write', recs: [{ type: REC.update, key: [x], value: { v: 2 } }] }, 0)
  sim.at(2, () => { for (const o of ['n01', 'n02', 'n03']) sim.partition('n04', o) })
  sim.run({ until: sim.now + 6000 })
  assert.deepEqual(ns.map((n) => n.epoch), [2, 2, 2, 1], 'n04 was voted out with v2 in its log only')
  sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: [x] }] }, 0)
  sim.run({ until: sim.now + 2000 })
  assert.ok(ns.slice(0, 3).every((n) => count(n, JK.tombstoneGC) > 0), 'the three released the tombstone')
  //! M6 is red AT THE RELEASE, before anything comes back: the cut-off node holds an older record the releasers lack
  assert.deepEqual(named(sim, 'census-truth').map((v) => v.detail.slice(0, 3)), ['n01', 'n02', 'n03'], 'M6 fires at each release')
  assert.equal(named(sim, 'stamp-oracle').length + named(sim, 'release-safety').length, 0, 'nothing came back yet')
  for (const o of ['n01', 'n02', 'n03']) sim.heal('n04', o)
  sim.run({ until: sim.now + 8000 })
  //! TODAY'S WRONG OUTCOME, pinned
  assert.deepEqual(ns.map((n) => n.state.get(X)), [{ v: 2 }, { v: 2 }, { v: 2 }, undefined], 'RED TODAY: an epoch-1 write beat the epoch-2 remove (when this fails, lane accounting landed: flip the pin)')
  assert.ok(named(sim, 'stamp-oracle').length > 0 && named(sim, 'release-safety').length > 0, 'M1 and M3 fire at the heal')
  assert.match(stampOracle(sim) ?? '', /resurrected/)
  assert.ok(ledgerOf(sim).counts.census >= 3, 'non-vacuity: M6 examined every release')
})

// ── planted violations, one per monitor ─────────────────────────────────────────────────────────

//! a formed, armed n=3 R=2 cluster with the scale monitors on; p is held by n01 (owner) and n02, not n03
const scoped3 = (seed: number, o: MeshOpts = {}) => {
  const ids = ['n01', 'n02', 'n03']
  const p = keyFor('p', (h) => { const x = h(ids, 2); return x[0] === 'n01' && x[1] === 'n02' })
  const sim = new Sim(seed)
  const ns = mesh(sim, 3, { hb: 50, replicas: 2, ...o })
  sim.run({ until: 1500 })
  assert.ok(ns.every((n) => n.armed), 'armed')
  return { sim, ns, p, P: JSON.stringify([p]) }
}

test('M1 stamp-oracle and its non-vacuity: green on a lawful scoped run that checked hundreds of shown cells; red on the two probes above', () => {
  const { sim, ns, p } = scoped3(21)
  for (let i = 0; i < 40; i++) sim.post(ns[i % 3].uuid, { kind: 'write', recs: [i % 4 === 3 ? { type: REC.remove, key: [p] } : { type: REC.update, key: [p, 'f' + (i % 3)], value: i }] }, i * 7)
  sim.run({ until: sim.now + 3000 })
  assert.deepEqual(sim.violations, [])
  assert.equal(stampOracle(sim), null)
  assert.ok(ledgerOf(sim).counts.cells >= 40, `M1 checked ${ledgerOf(sim).counts.cells} shown cells`)
})

test('M2 frontier-sound: compacting below a co-holder\'s real floor, and dropping a winner, both go red (scoped compaction is pinned today, so the plant calls compact() by hand)', () => {
  const { sim, ns: [a, b], p, P } = scoped3(22)
  sim.partition('n01', 'n02')
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 1 }] }, 0)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 2 }] }, 5)
  sim.run({ until: sim.now + 100 })
  assert.ok((b.streams.get('n01')?.parts?.get(p)?.s ?? 0) === 0, 'the co-holder is behind')
  assert.equal(compact(a, 'n01', Infinity), 1, 'the hand-called pass drops the loser')
  sim.run({ until: sim.now + 100 })
  assert.match(named(sim, 'frontier-sound')[0]?.detail ?? '', /compacted \(n01, \d+\) of 'p\d+' while holder n02's real floor for that lane is 0 — below the frontier/)
  assert.ok(ledgerOf(sim).counts.drops >= 1, 'non-vacuity: M2 examined the drop')
  //! the second leg: the winner itself vanishes from the lane
  const v = a.versions.get(P)!
  a.logs.set('n01', a.logs.get('n01')!.filter((e) => e.seq !== v.seq))
  sim.run({ until: sim.now + 100 })
  assert.ok(named(sim, 'frontier-sound').some((x) => /still the WINNER/.test(x.detail)), 'dropping a winner is red')
})

test('M3 release-safety: a tombstone released with its record at every holder, then a join that moves the partition — the learner is taught the old write and M3 fires (M1 too)', () => {
  const ids4 = ['n01', 'n02', 'n03', 'n04']
  const p = keyFor('q', (h) => { const x = h(['n01', 'n02', 'n03'], 2); const y = h(ids4, 2); return x[0] === 'n01' && x[1] === 'n02' && y.includes('n04') })
  const P = JSON.stringify([p])
  const sim = new Sim(23)
  const o: MeshOpts = { hb: 50, replicas: 2 }
  const ns = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 'old' }] }, 0)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: [p] }] }, 20)
  sim.run({ until: sim.now + 500 })
  assert.ok(!ns[0].state.has(P) && ns[0].versions.has(P) && ns[1].versions.has(P), 'both holders keep the tombstone')
  //! the plant: the release step with no census and no lane accounting (the mutation runner's `release-all`)
  const d = inject(sim, () => 0, 'release-all')
  assert.match(d ?? '', /release-all 2 tombstone\(s\): .*@n01 .*@n02/)
  join(sim, 'n04', o)
  sim.run({ until: sim.now + 8000 })
  assert.equal(sim.nodes.get('n04')!.state.get(P), 'old', 'the learner was taught the dead write')
  assert.ok(named(sim, 'release-safety').some((v) => v.detail.startsWith('n04 shows')), 'M3 fires at the learner')
  assert.ok(ledgerOf(sim).counts.releases >= 2, 'non-vacuity: M3 classified both releases')
})

test('M4 index-oracle is a named stub: inert today, red the moment node.byPart exists (stage 1 must fill it in)', () => {
  const { sim, ns } = scoped3(24)
  assert.equal(named(sim, 'index-oracle').length, 0)
  ;(ns[0] as Node & { byPart?: unknown }).byPart = new Map()
  sim.run({ until: sim.now + 100 })
  assert.match(named(sim, 'index-oracle')[0]?.detail ?? '', /stage 1 landed the index/)
})

test('M5 floor-truth: a floor raised past what the node holds goes red at its next step; a lawful run checks every advance', () => {
  const { sim, ns: [a, b], p } = scoped3(25)
  for (let i = 0; i < 6; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p, 'f' + i], value: i }] }, i * 5)
  sim.run({ until: sim.now + 500 })
  assert.deepEqual(sim.violations, [])
  assert.ok(ledgerOf(sim).counts.advances >= 6, `non-vacuity: M5 checked ${ledgerOf(sim).counts.advances} floor advances`)
  //! the plant: n02's floor claims two records n01 never minted... and one it did mint but n02 never got
  sim.partition('n01', 'n02')
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p, 'late'], value: 1 }] }, 0)
  sim.run({ until: sim.now + 50 })
  const pe = b.streams.get('n01')!.parts!.get(p)!
  pe.s = a.streams.get('n01')!.parts!.get(p)!.s
  sim.run({ until: sim.now + 100 })
  assert.match(named(sim, 'floor-truth')[0]?.detail ?? '', /n02 floor for \(n01, 'p\d+'\) is \d+ but it neither holds nor covers .* the floor overclaims/)
})

test('M6 census-truth: a release while a cut-off holder still has an older record goes red at the release (scoped form of the zombie)', () => {
  const { sim, ns, p, P } = scoped3(26)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 1 }] }, 0)
  sim.run({ until: sim.now + 200 })
  //! n01 writes again with n02 unreachable (the record reaches n01's log only), then a remove is stamped and n02 learns it
  sim.partition('n01', 'n02')
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 2 }] }, 0)
  sim.run({ until: sim.now + 50 })
  //! n02 releases a tombstone of p it stamped... it is not the owner, so plant the tombstone directly: copy the remove's
  // effect by a version on n02 above everything (a release must then find n01's unseen record)
  const b = ns[1]
  const v = ns[0].versions.get(P)!
  b.versions.set(P, { epoch: v.epoch, seq: v.seq + 100, origin: 'n01' })
  b.state.delete(P)
  sim.stepped.add('n02')
  sim.run({ until: sim.now + 50 })
  b.versions.delete(P); b.unlink(P); sim.stepped.add('n02')
  sim.run({ until: sim.now + 50 })
  assert.match(named(sim, 'census-truth')[0]?.detail ?? '', /n02 released the tombstone of .* while node n01 holds .* older, which n02 neither holds nor covers/)
  assert.ok(ledgerOf(sim).counts.census >= 1)
})

test('M7 floors-agree: holders with unequal floors at a quiet point are red; equal after a lawful run', () => {
  const { sim, ns: [a, b], p } = scoped3(27)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 1 }] }, 0)
  sim.run({ until: sim.now + 1000 })
  assert.equal(floorsAgree(sim), null)
  assert.ok((b.streams.get('n01')?.parts?.get(p)?.s ?? 0) > 0, 'non-vacuity: a lane with a real floor was compared')
  b.streams.get('n01')!.parts!.get(p)!.s--
  assert.match(floorsAgree(sim) ?? '', /holders of 'p\d+' disagree on the floor for lane n01/)
  void a
})

test('M8 bounded-logs is RED TODAY on any scoped run that removed a cell: the tombstone is neither fenced nor pinned (stage 3 and stage 4 flip it)', () => {
  const { sim, p } = scoped3(28)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 1 }] }, 0)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: [p] }] }, 10)
  sim.run({ until: sim.now + 1000 })
  assert.match(boundedLogs(sim) ?? '', /holds the tombstone of .* neither fenced nor pinned/, 'RED TODAY')
})

test('M9 leave-drain is RED TODAY at R=1: a clean leaver takes the only copy of its rows with it', () => {
  const ids = ['n01', 'n02']
  const p = keyFor('p', (h) => h(ids, 1)[0] === 'n02')
  const sim = new Sim(29)
  mesh(sim, 2, { hb: 50, replicas: 1 })
  sim.run({ until: 1500 })
  sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: [p], value: 1 }] }, 0)
  sim.run({ until: sim.now + 300 })
  sim.post('n02', { kind: 'leave' }, 0)
  for (let t = sim.now; !sim.left.has('n02') && t < sim.now + 5000; t += 5) sim.run({ until: t })
  assert.equal(sim.left.get('n02'), true, 'the leave reported clean')
  assert.match(named(sim, 'leave-drain')[0]?.detail ?? '', /n02 left clean \(R=1\) while it alone held \('p\d+', lane n02\)/, 'RED TODAY')
  assert.equal(ledgerOf(sim).counts.leaves, 1, 'non-vacuity: M9 examined the leave')
})

// ── the counted floors, recorded from today ─────────────────────────────────────────────────────

//! RE-MEASURED 2026-10-09: the record's 2,555 is 2,446 here, for two stated reasons. (1) The panel's probe posted
// its writes with an absolute delay (4,100 + i ms from t ≈ 4 s), so they fired at 8.1-8.4 s: inside the window it
// labelled idle, not the one it labelled writes (re-run with its timing: 0 HAVEQ in the writes window, 1,067 in the
// "idle" one, and its join then costs 2,555). Here the writes fire at 4.1-4.4 s, where the setup says, and the join
// starts from a settled mesh. (2) The joiner's own 30 pairs are at the stated [1,1] too; sim.add pairs a new node at
// the sim's default [1,5]; the re-run of the panel's timing and this test's first version (2,585) both ran with the
// joiner there. 1,067 for the writes and 52,110 DIGEST frames to t = 20 s are the same either way.
test('counted floors of today (DESIGN-SCALE §2, the panel\'s setup): idle scoped = n(n−1) DIGEST per tick; 300 writes = 1,067 HAVEQ; one join at n=30 R=3 P=300 = 2,446 HAVEQ', () => {
  const sim = new Sim(13)
  const t = frameTally(sim)
  const nodes = cluster(sim, 30, { heartbeatMs: 200, fault: { delay: [1, 1] }, replicas: 3 })
  sim.monitors.length = 0 // measurements, not laws
  sim.run({ until: 4000, maxEvents: 5_000_000 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed))
  let m = t.mark()
  for (let i = 0; i < 300; i++) sim.post(nodes[i % 30].uuid, { kind: 'write', recs: [{ type: REC.update, key: [`row${i}`], value: { v: i } }] }, 4100 - sim.now + i)
  sim.run({ until: 8000, maxEvents: 5_000_000 })
  assert.equal(exactlyR(sim), null); assert.equal(scopedConverged(sim), null)
  assert.equal(t.since(m, VERB.HAVEQ), 1067, '300 writes cost 1,067 HAVEQ (the lag round: 3.7 pairs per write)')
  assert.equal(t.since(m, VERB.HAVEA), 1067)
  assert.deepEqual(perTick(sim, t, 200, 4, VERB.DIGEST), [870, 870, 870, 870], 'idle: n(n−1) = 30·29 member DIGEST frames per tick')
  m = t.mark()
  //! the joiner's 30 pairs at the stated [1,1] too (sim.add pairs a new node at the sim's DEFAULT [1,5] otherwise)
  for (const x of nodes) sim.fault('n31', x.uuid, { delay: [1, 1] })
  sim.add({ uuid: 'n31', listen: 'sim:n31', hosts: nodes.map((x) => `sim:${x.uuid}`), heartbeatMs: 200, redialMs: 20, journalCap: 1 << 16, replicas: 3 })
  sim.post('n31', { kind: 'start' }, 0)
  sim.run({ until: 20_000, maxEvents: 8_000_000 })
  assert.equal(exactlyR(sim), null)
  assert.equal(t.since(m, VERB.HAVEQ), 2446, 'one join costs 2,446 HAVEQ (about 2.6 full co-holder rounds)')
  assert.equal(t.since(m, VERB.HAVEA), 2446)
  assert.equal(t.since(m, VERB.DIGEST), 52110, 'and 52,110 DIGEST frames to t=20 s')
  assert.deepEqual(perTick(sim, t, 200, 2, VERB.DIGEST), [930, 930], 'idle after the join: 31·30')
})

// ── the §2 seed probe (A4): a restored floor may not claim what the disk did not keep ───────────

test('seed probe (DESIGN-SCALE §2, A4): a holder whose boot record was written ahead of its WAL rows restarts with floors no higher than its disk restores — M5 stays green', () => {
  //! three durable members, R=3 (every member holds every row). n02's fsync is slow (300 ms) and its lamport lease
  // is 1, so each commit of its own re-writes the boot record (synchronously, with the floor seed) while the rows
  // it just folded from n01 are still queued for the disk. n02 crashes 30 ms later: the torn tail takes the rows,
  // the boot record keeps the floors. Before the fix the restored floor claimed every lost row (M5: "the floor
  // overclaims", once per lost record); the fix caps the restored possession floor at the durable one.
  const ids = ['n01', 'n02', 'n03']
  const sim = new Sim(5)
  const ns = mesh(sim, 3, { hb: 50, durable: true, replicas: 3, tune: { lamportLease: 1 } })
  sim.run({ until: 1500 })
  assert.ok(formed(ns) && ns.every((n) => n.armed))
  sim.storeFault('n02', { delay: [300, 300] })
  const a: string[] = [], b: string[] = []
  for (let i = 0; a.length < 5 || b.length < 2; i++) { const k = 'k' + i; const o = holdersAt(ids, k, 1)[0]; if (o === 'n01' && a.length < 5) a.push(k); if (o === 'n02' && b.length < 2) b.push(k) }
  a.forEach((k, i) => sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [k], value: i }] }, 1))
  b.forEach((k, i) => sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: [k], value: i }] }, 20 + i))
  sim.run({ until: sim.now + 30 })
  const store = sim.stores.get('n02')!
  assert.deepEqual(Object.values(store.boot!.floors!.n01).map((sd) => sd[0] > sd[1]), [true, true, true, true, true], 'the boot record claims possession ahead of durability')
  assert.ok(store.wal.every((r) => !r.resolved), 'and none of the rows behind it reached the disk')
  const reborn = sim.restart('n02')
  sim.run({ until: sim.now + 5 })
  assert.equal(reborn.logs.size, 0, 'the torn tail took every row')
  assert.deepEqual(named(sim, 'floor-truth').map((v) => v.detail), [], 'no restored floor claims a row the disk lost')
  for (const [, d] of reborn.streams) for (const [, pe] of d.parts ?? []) assert.ok(pe.s <= pe.d, 'restored possession never exceeds the durable floor')
  sim.run({ until: sim.now + 3000 })
  assert.deepEqual(sim.violations, [])
  assert.equal(scopedConverged(sim), null, 'the holder heals the lost rows')
  assert.equal(reborn.logs.get('n01')?.length, 5)
})
