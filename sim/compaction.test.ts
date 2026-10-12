//! DESIGN-SCALE stage 3 (2026-10-12): compaction on scoped nodes, under the executive — the §7 row's sim tests and
// its counted pin P4. The kernel rule (C1-C4, the frontier over the holders' crash-stable attested marks) is pinned
// by hand-driven events in kernel/scoped.test.ts; here the same bytes run on seeded schedules with the scale
// monitors armed (M2 frontier-sound judges every replaced lane; M5 floor-truth every floor advance and a restored
// node's whole seed), so what this file proves is the rule's EFFECT: a durable holder restored from a compacted
// disk, a spoke fed across a pass, and the memory bound the record is for.
//
//   restore   a durable holder restarted after its lanes compacted and its WAL swapped comes back with the floors
//             it had (the boot record's seed, written when the compaction-armed swap is issued, sits above every gap
//             the pass opened), re-latches nothing, and M5 is green on the whole seed. Red without that boot write:
//             the seed is stale, replay chains from it, stalls at the first compacted gap, the reborn announces
//             floors below its content and latches a holder for rows it holds. Mutation check, by hand
//             (2026-10-12): no boot write at a compacting swap at all — red at 'the floor restored from the seed'
//             (n01|c1 restored 2, was 158), read at the restore instant, and with that line off at 'no re-latch' (5).
//   window    the same holder crashed BETWEEN the swap and its echo (its fsync slowed): the seed was written at the
//             issue, so the restore is the same — floors chained to the content, no re-latch, and nothing a peer
//             counted as this node's crash-stable mark is above what its disk restored. Red when the seed is written
//             at the echo instead (the stage-3 review's window): the compacted file sits under the old seed.
//   spoke     a client of a scoped server across its feeder's passes: zero resyncs (C4 keeps the lane's last entry,
//             so the feeder's digest tail never regresses), the spoke mirrors its feeder (M12), screen = kernel.
//   slow disk a durable co-holder whose fsync lags by seconds: its possession floors run seconds ahead of its
//             durable ones under writes, the frontier for its partitions pins at its DURABLE floor while the other
//             partitions compact, and M2 judges every pass against the holders' real crash-stable floors (a durable
//             holder at pe.d). This is the §6 mutation "volatile instead of durable floors (A4)" given a schedule the
//             sweep lacks: A4's writes land in its first 600 ms under a 40-80 ms fsync delay, so every pass there
//             runs after the lagging disk caught up and the mutation goes unseen.
// The counted pin P4 (50,000 updates over 500 cells at n=8 R=3) lives in sim/scale.perf.ts with the other
// expensive counted pins: it takes about a minute here.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { formed } from './harness.ts'
import { mesh, type MeshOpts } from './scoped-sweep.ts'
import { scopedConverged, exactlyR, floorsAgree, spokeMirror, screenMatches, boundedLanes } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { REC, partitionOf } from '../kernel/env.ts'
import { SCOPE } from '../kernel/scope.ts'
import type { Node } from '../kernel/node.ts'

const count = (n: Node, kind: number) => n.journal.read().filter((e) => e.kind === kind).length
//! floorsOf — a node's possession floors for the partitions it holds, as 'lane|partition' → s
const floorsOf = (n: Node): Map<string, number> => {
  const out = new Map<string, number>()
  for (const [o, d] of n.streams) for (const [p, pe] of d.parts ?? []) if (n.scope!.entries.get(p)?.state === SCOPE.held && pe.s > 0) out.set(o + '|' + p, pe.s)
  return out
}
//! hot — `count` writes over `cells` row cells, round-robin over the members, one every `gap` ms: lanes pass compactAt
export const hot = (sim: Sim, nodes: Node[], cells: number, count: number, gap: number) => {
  for (let i = 0; i < count; i++) sim.post(nodes[i % nodes.length].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['c' + (i % cells)], value: i }] }, i * gap)
}

test('a durable holder restarted after compaction restores its floors from the seed and does not re-latch: the boot record written when the compaction-armed swap is issued covers the gaps the pass opened; M2 and M5 green throughout', () => {
  const sim = new Sim(31)
  const o: MeshOpts = { replicas: 2, durable: true, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 1] } }
  const nodes = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 3000 })
  assert.deepEqual(sim.violations, [], 'lawful so far')
  for (const n of nodes) {
    assert.ok(count(n, JK.compacted) > 0, `${n.uuid} compacted (${count(n, JK.compacted)} rows)`)
    assert.ok(count(n, JK.snapshot) > 0, `${n.uuid} swapped its WAL`)
  }
  const victim = nodes[1]
  const before = floorsOf(victim)
  assert.ok(before.size >= 2, `n02 holds floors for ${before.size} (lane, partition) pairs`)
  //! every lane of n02 compacted below its floor: a restore that chained from a stale seed would stall under it
  const gaps = [...victim.logs].filter(([o, lane]) => { const f = Math.max(...[...before].filter(([k]) => k.startsWith(o + '|')).map(([, s]) => s), 0); return lane.length > 0 && lane[0].seq < f && lane.length < f }).length
  assert.ok(gaps >= 1, `${gaps} lane(s) of n02 hold fewer entries than their floor spans: the pass opened gaps the seed must cover`)
  const reborn = sim.restart('n02')
  //! the restore instant: replay and start done, nothing on the wire yet — read what the DISK restored here, before
  // any peer's digest or a re-latch can repair it (read 3 s later, a wrong seed is already healed and the line is mute)
  sim.run({ until: sim.now })
  const restored = floorsOf(reborn)
  for (const [k, s] of before) assert.equal(restored.get(k), s, `${k}: the floor restored from the seed equals the pre-crash floor`)
  sim.run({ until: sim.now + 3000 })
  assert.equal(reborn.armed, true)
  assert.equal(count(reborn, JK.acquireStart), 0, 'no re-latch: the reborn announced the floors it holds, nobody found it behind')
  assert.equal(count(reborn, JK.walHole), 0)
  assert.deepEqual(sim.violations, [], 'M5 (the whole seed at start), M2 and every per-event monitor green')
  assert.equal(scopedConverged(sim), null)
  assert.equal(exactlyR(sim), null)
  assert.equal(floorsAgree(sim), null)
})

//! The crash window (the stage-3 review's finding, 2026-10-12). The seed on disk is refreshed only by a compaction-armed
// swap, so the gaps the window's pass opens must sit ABOVE that seed for the window to matter: six FRESH cells are
// written after the quiet (winners, no loser for a pass to drop, so the seed stays put), then a burst rewrites them
// with the holder's fsync slowed — the pass drops the six, arms the swap, and the swap's echo is the window.
// Mutation check, by hand (2026-10-12, a scratch copy): the boot write moved back to the swap's echo (a5dc99c's
// node.ts hunk reversed) — this test red at 'the seed on disk covers the gap' first, and each restore check red ON
// ITS OWN with the other three switched off: 'the floor restored equals the pre-crash floor' (n01|c1 restored 158,
// was 211), 'n01 held n02's crash-stable mark at 162 ... its disk restored 158', and 'no re-latch' (5). The two
// floor checks read the reborn at the restore instant (`run({ until: sim.now })` after `restart`): read 3 s later,
// as they first were, both stay green under the mutation (peers' digests and the re-latch have healed the floors).
// The restore test (a crash after the echo) stays green under it, which is why the window needs its own schedule.
test('a durable holder crashed between a compaction-armed swap and its echo (its fsync slowed): the boot record written at the swap\'s issue covers the gaps, the reborn restores the floors it had, re-latches nothing, and no mark a peer held as its crash-stable floor is above what its disk restored', () => {
  const sim = new Sim(35)
  //! compactAt 2: every lane is walked, so the quiet leaves nothing a later pass could drop (at 16 a lane under the
  // trigger keeps its losers, and the first write that tips it over drops them — a swap, and the seed moves)
  const o: MeshOpts = { replicas: 2, durable: true, hb: 50, tune: { compactAt: 2, snapshotAt: 16 }, fault: { delay: [1, 1] } }
  const nodes = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 3000 })
  const victim = nodes[1]
  assert.ok(count(victim, JK.compacted) > 0 && count(victim, JK.snapshot) > 0, 'n02 compacted and swapped under the writes')
  //! six FRESH cells, one field in each row (the partition is the row key, so a fresh ROW would be a fresh partition,
  // whose seal at a durable holder writes the boot record): winners above every seed on disk, and no loser for a pass
  // to drop (a pass would move the seed)
  for (let i = 0; i < 6; i++) sim.post(nodes[i % 3].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['c' + i, 'w'], value: 0 }] }, i * 3)
  sim.run({ until: sim.now + 1000 })
  const fresh = [...victim.logs].flatMap(([o, lane]) => lane.filter((e) => e.rec.key.length === 2).map((e) => ({ o, seq: e.seq, p: partitionOf(e.rec) })))
  const store = sim.stores.get(victim.uuid)!
  const seedBefore = store.boot!.floors!
  const above = fresh.filter((f) => f.seq > (seedBefore[f.o]?.[f.p]?.[1] ?? 0))
  assert.ok(above.length >= 1, `${above.length} of n02's ${fresh.length} fresh winners sit above the seed on its disk`)
  //! n02's disk answers 0.4-0.5 s late from here. The burst rewrites the fresh cells: their winners become losers at or
  // under n02's durable floor, the next pass drops them (gaps ABOVE the seed on disk), arms the swap, and the echo of
  // that swap is the window. Posted two ms after a tick, in one instant: every row is in n02's memory and in the swap
  // before the tick that compacts and swaps, so the crash tears no row.
  sim.storeFault(victim.uuid, { delay: [400, 500] })
  sim.run({ until: Math.ceil(sim.now / 50) * 50 + 2 })
  for (let i = 0; i < 96; i++) sim.post(nodes[i % 3].uuid, { kind: 'write', recs: [{ type: REC.update, key: ['c' + (i % 6), 'w'], value: i + 1 }] }, 0)
  const inWindow = (): boolean => {
    let snap = -1, echoed = true, armed = false, passed = false
    for (const e of victim.journal.read()) {
      if (e.kind === JK.compacted) passed = true
      else if (e.kind === JK.snapshot) { snap = e.a as number; echoed = false; armed = passed; passed = false }
      else if (e.kind === JK.persisted && e.a === snap) echoed = true
    }
    return snap >= 0 && armed && !echoed
  }
  //! one virtual ms at a time (a local clock: sim.now is the LAST EVENT's time and stands still through an empty ms)
  for (let t = sim.now, deadline = t + 1000; !inWindow() && t < deadline; t += 1) sim.run({ until: t })
  assert.ok(inWindow(), 'n02 issued a compaction-armed swap and its echo has not landed: the window')
  assert.ok(store.wal.every((r) => r.resolved), 'no row appended after the swap: the crash tears nothing')
  const gone = above.filter((f) => !victim.logs.get(f.o)!.some((e) => e.seq === f.seq))
  assert.ok(gone.length >= 1, `${gone.length} fresh winner(s) dropped by the pass: gaps above the seed the disk held before it`)
  for (const g of gone) assert.ok((store.boot!.floors![g.o]?.[g.p]?.[1] ?? 0) >= g.seq, `the seed on disk covers the gap at (${g.o}, ${g.seq}) for ${g.p}: written when the swap was issued`)
  const before = floorsOf(victim)
  //! what the peers hold as n02's crash-stable marks at this instant: nothing here may exceed what its disk restores
  const held: [string, string, string, number][] = []
  for (const n of nodes) if (n !== victim) for (const [p, e] of n.scope!.entries) for (const [o, d] of e.marksD.get(victim.uuid) ?? []) held.push([n.uuid, p, o, d])
  assert.ok(held.length >= 1, `${held.length} (peer, partition, lane) marks held for n02`)
  const reborn = sim.restart(victim.uuid)
  //! the restore instant: replay and start done, nothing on the wire yet — both checks read what the DISK restored,
  // before a peer's digest or a re-latch repairs it (3 s later both pass with the seed written at the echo)
  sim.run({ until: sim.now })
  const restored = floorsOf(reborn)
  for (const [k, s] of before) assert.equal(restored.get(k), s, `${k}: the floor restored equals the pre-crash floor`)
  for (const [peer, p, o, d] of held) {
    const got = reborn.streams.get(o)?.parts?.get(p)?.d ?? 0
    assert.ok(got >= d, `${peer} held n02's crash-stable mark at ${d} for (${o}, ${p}); its disk restored ${got}`)
  }
  sim.run({ until: sim.now + 3000 })
  assert.equal(reborn.armed, true)
  assert.equal(count(reborn, JK.acquireStart), 0, 'no re-latch: the seed chained over the gaps to the content')
  assert.equal(count(reborn, JK.walHole), 0)
  assert.deepEqual(sim.violations, [], 'M5 (the whole seed at start), M2 and every per-event monitor green')
  assert.equal(scopedConverged(sim), null)
  assert.equal(exactlyR(sim), null)
  assert.equal(floorsAgree(sim), null)
})

test('a client on a scoped server across a compaction pass: zero resyncs (the lane\'s last entry stays, so the feeder\'s digest tail never regresses), the spoke mirrors its feeder, screen = kernel', () => {
  const sim = new Sim(32)
  const nodes = mesh(sim, 3, { replicas: 2, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 1] } })
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  const spoke = sim.add({ uuid: 's1', listen: 'sim:s1', hosts: nodes.map((n) => `sim:${n.uuid}`), heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
  sim.post('s1', { kind: 'start' }, 0)
  sim.run({ until: sim.now + 500 })
  assert.notEqual(spoke.primary, null, 'the spoke has a feeder')
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 3000 })
  const feeder = sim.nodes.get(spoke.links.get(spoke.primary!)!.uuid)!
  assert.ok(count(feeder, JK.compacted) > 0, `the feeder ${feeder.uuid} compacted (${count(feeder, JK.compacted)} rows)`)
  assert.equal(count(spoke, JK.resync), 0, 'zero resyncs across the passes')
  assert.equal(spokeMirror(sim, 's1'), null, 'M12: the spoke holds exactly its feeder\'s held subset')
  assert.equal(screenMatches(sim, 's1'), null)
  assert.deepEqual(sim.violations, [])
})

//! The slow-disk schedule (the §6 "volatile instead of durable floors" mutation, A4's class). Mutation check, once, by
// hand (2026-10-12): kernel/scope.ts stableMarks returning e.marks.get(uuid) for every peer — this test red at
// 'M2 ...' ("n01 compacted (n01, N) of 'cM' while holder n03's real floor for that lane is F — below the frontier"),
// sim/scoped-sweep.test.ts A4 green at both its seeds (the schedule gap named in the banner).
test('a durable co-holder whose fsync lags by seconds: the frontier for its partitions pins at its DURABLE floor while the others compact, M2 judges every pass at the holders\' crash-stable floors, and the pinned partitions compact once the disk catches up', () => {
  const sim = new Sim(34)
  const o: MeshOpts = { replicas: 2, durable: true, hb: 50, tune: { compactAt: 16, snapshotAt: 16 }, fault: { delay: [1, 1] } }
  const nodes = mesh(sim, 3, o)
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'armed')
  const slow = nodes[2]
  sim.storeFault(slow.uuid, { delay: [1500, 2000] }) // every fsync at n03 answers 1.5-2 s late from here on
  //! non-vacuity: passes that dropped entries somewhere while n03's durable floors were behind its possession floors
  const compactions = () => nodes.reduce((a, n) => a + count(n, JK.compacted), 0)
  const behind = () => [...slow.streams].some(([, d]) => [...(d.parts ?? [])].some(([, pe]) => pe.d < pe.s))
  let lagged = 0, rows = 0
  sim.monitors.push({ name: 'lag-at-pass', check: () => { const c = compactions(); if (c > rows) { rows = c; if (behind()) lagged++ } return null } })
  hot(sim, nodes, 6, 240, 3)
  sim.run({ until: sim.now + 1200 }) // the writes (720 ms) and the passes they arm, all inside n03's fsync lag
  assert.ok(lagged > 0, `${lagged} passes dropped entries while ${slow.uuid}'s durable floors were behind its possession floors`)
  assert.ok(behind(), 'n03 is still behind its own possession floors: its disk has not answered yet')
  assert.deepEqual(sim.violations, [], 'M2: every drop at or under every holder\'s crash-stable floor (n03 at its durable one)')
  sim.run({ until: sim.now + 4000 }) // the disk answers: n03's durable floors reach its possession floors
  assert.equal(behind(), false, 'n03 caught up')
  assert.ok(count(slow, JK.compacted) > 0, `n03 compacted on its own durable floor (${count(slow, JK.compacted)} rows)`)
  assert.equal(boundedLanes(sim), null, 'every lane at every node within winners + compactAt')
  assert.deepEqual(sim.violations, [])
  assert.equal(scopedConverged(sim), null)
  assert.equal(exactlyR(sim), null)
  assert.equal(floorsAgree(sim), null)
})
