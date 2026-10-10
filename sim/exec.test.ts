//! Tier-2 executive suite: determinism canary, fault tolerance, partition/heal — all virtual-time, zero sleeps.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, drained } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { Ring } from '../kernel/ring.ts'
import type { Node } from '../kernel/node.ts'
import { sweepBuild } from './shrink.ts'
import { toyDoor } from './door.ts'

//! the determinism canary (plan §3.1): the same seed twice must produce byte-identical trajectories.
// This catches unrecorded nondeterminism (Map-iteration dependence, ambient time,
// stray Math.random) THE DAY it lands — v2 had no equivalent, so scheduling
// sensitivity was only discovered as flake, months later, on a loaded box.
test('same seed ⇒ identical trajectory (event count + per-event state-hash trace)', () => {
  const runOnce = () => {
    const sim = new Sim(1234)
    const nodes = cluster(sim, 3)
    sim.fault('n01', 'n02', { delay: [1, 20], dupP: 0.3 })
    writes(sim, nodes, 25)
    sim.run()
    return { events: sim.events, trace: sim.trace.join(',') }
  }
  const a = runOnce()
  const b = runOnce()
  assert.equal(a.events, b.events)
  assert.equal(a.trace, b.trace)
})

//! the frozen golden (the tune table, 2026-10-08): 20 sweep seeds pinned by event count and a hash of
// the per-event state-hash trace, recorded on the tree BEFORE the kernel read its bounds from node.tune.
// Re-recorded the same day for V4-18 (overlapping cells): every event count stayed, every trace hash
// moved, because the state hash over a mixed history now follows the across-depth election.
// The canary above proves a run equals itself; this proves a run equals the kernel of that day. A
// deliberate trajectory change (a wire law, a new default) re-records these rows with a DECISIONS line.
// Re-recorded 2026-10-09 for the one-chain-per-target rule (#redial skips a target with a timer already
// pending): seeds 11 (270 → 252 events) and 17 (224 → 219) moved, the two of the twenty whose cut
// landed on a crossing pair and armed a second timer line; the other eighteen are byte-identical.
test('golden: 20 sweep seeds match the recorded event counts and trace hashes', () => {
  const fnv = (xs: number[]): string => {
    let h = 0x811c9dc5
    for (const x of xs) {
      h ^= x >>> 0
      h = Math.imul(h, 0x01000193) >>> 0
      h ^= x >>> 16
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  const golden: [seed: number, events: number, trace: string][] = [
    [0, 185, '41066e03'], [1, 213, '8f707e3c'], [2, 222, '7d73d321'], [3, 215, '11309116'], [4, 178, 'dceb35f8'],
    [5, 220, 'ced4fcaf'], [6, 162, '2406f5c8'], [7, 219, 'f9b53da4'], [8, 202, 'fbbd3c54'], [9, 237, 'bfbfdbb0'],
    [10, 247, '101df47e'], [11, 252, 'c4277d30'], [12, 182, '73d7603e'], [13, 187, 'f46dd08c'], [14, 168, '5cd4dfa4'],
    [15, 241, '183d893a'], [16, 193, 'f20c4cec'], [17, 219, '72387971'], [18, 204, 'e2aa438b'], [19, 197, 'db4d38a3'],
  ]
  const got = golden.map(([seed]) => {
    const b = sweepBuild(seed)(null)
    b.sim.run()
    return [seed, b.sim.events, fnv(b.sim.trace)]
  })
  assert.deepEqual(got, golden)
})

test('different seeds explore different trajectories', () => {
  const traceFor = (seed: number) => {
    const sim = new Sim(seed)
    writes(sim, cluster(sim, 3), 25)
    sim.run()
    return sim.trace.join(',')
  }
  assert.notEqual(traceFor(1), traceFor(2))
})

test('duplication + uneven delays: mesh forms, cluster converges, nothing left parked', () => {
  const sim = new Sim(42)
  const nodes = cluster(sim, 4)
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 30], dupP: 0.4 })
  writes(sim, nodes, 60)
  const violations = sim.run()
  assert.deepEqual(violations, [])
  assert.ok(sim.quiesced)
  assert.ok(formed(nodes), 'mesh formed')
  assert.equal(converged(sim), null)
  assert.equal(drained(sim), null)
  //! exactly one logical link per pair survived the full dial mesh (4 nodes → 3 links each)
  for (const n of nodes) assert.equal(n.admitted().length, 3)
})

test('partition severs links; heal + redial re-forms the mesh — asserted at quiescence, not after a sleep', () => {
  const sim = new Sim(7)
  const nodes = cluster(sim, 2)
  sim.run({ until: 50 })
  assert.ok(formed(nodes), 'formed before partition')

  sim.partition('n01', 'n02')
  sim.run({ until: 100 })
  assert.ok(!formed(nodes), 'links severed')

  sim.heal('n01', 'n02')
  sim.run() // to quiescence: pending redial timers fire, reconnect, HELLO, admit
  assert.ok(formed(nodes), 'mesh re-formed after heal')

  //! and the re-formed mesh still replicates
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['after-heal'], value: 1 }] })
  sim.run()
  assert.equal(converged(sim), null)
})

test('writes RACING mesh formation converge: replay-on-admit heals the dial-race loss window', () => {
  // The adversarial review proved the original kernel lost writes here: a write
  // issued while the eventual dup-race LOSER was the sole admitted link shipped
  // only on that link and died with it — silent permanent divergence (repro:
  // seed 0, write at t=8, 2 nodes). The fix is the own-log replay on every
  // admit; this test drives writes INTO the formation window (span 1-40ms
  // overlapping dial/HELLO/dup-close) across many seeds to keep the race hot.
  for (let seed = 0; seed < 40; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, 3)
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.3 })
    writes(sim, nodes, 25, 40) // deliberately concurrent with formation
    const violations = sim.run()
    assert.deepEqual(violations, [], `seed ${seed}`)
    assert.ok(formed(nodes), `seed ${seed}: formed`)
    assert.equal(converged(sim), null, `seed ${seed}`)
    assert.equal(drained(sim), null, `seed ${seed}`)
  }
})

test('partition installed while a dial is IN FLIGHT: no zombie link; heal re-forms the mesh', () => {
  // regression (adversarial review): linkDown delivered before linkUp minted a
  // Link that never died and never redialed — permanent silent unreachability
  const sim = new Sim(11)
  const nodes = cluster(sim, 2)
  sim.partition('n01', 'n02') // dials from 'start' are still in flight
  sim.run({ until: 300 })
  assert.ok(!formed(nodes), 'partitioned during dial — must not form')
  for (const n of nodes) assert.equal(n.links.size, 0, 'no zombie links may survive a refused dial')

  sim.heal('n01', 'n02')
  sim.run()
  assert.ok(formed(nodes), 'backoff redial reconnects after heal')
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['after'], value: 1 }] })
  sim.run()
  assert.equal(converged(sim), null)
})

test('tail loss heals: writes lost to a partition (in-flight and during) converge after heal via digest AE', () => {
  // The M1 slice's headline: real loss is TAIL loss at link death (TCP never
  // drops mid-stream on a live connection). Writes issued right at partition
  // time die in flight; writes during the partition never ship; the heal-time
  // re-admit exchanges digests and ships exactly the missing suffixes.
  const sim = new Sim(5)
  const nodes = cluster(sim, 2)
  sim.run()
  assert.ok(formed(nodes))

  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['at-cut'], value: 1 }] }, 1)
  sim.at(1, () => sim.partition('n01', 'n02')) // the write's frame is in flight when the cable dies
  sim.at(40, () => sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['during'], value: 2 }] }, 0))
  sim.at(40, () => sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['other-side'], value: 3 }] }, 0))
  sim.at(120, () => sim.heal('n01', 'n02'))
  const violations = sim.run()
  assert.deepEqual(violations, [])
  assert.ok(formed(nodes), 're-formed after heal')
  assert.equal(converged(sim), null, 'digest AE must re-ship every lost suffix, both directions')
  assert.equal(nodes[1].state.size, 3)
})

test('give-up is a cool-down: with heartbeats on, the revival re-dials a given-up target after a LONG partition heals', () => {
  // Without heartbeats a target that exhausts MAX_REDIALS is parked until restart (the documented M0
  // hole). With heartbeats on, each tick revives any configured host we hold no link to (JK.revive).
  const sim = new Sim(13)
  const nodes = cluster(sim, 2, { heartbeatMs: 100 })
  sim.partition('n01', 'n02') // dials from 'start' are refused; the backoff chain exhausts mid-partition
  sim.run({ until: 8000 })    // heartbeats never quiesce — every phase runs to a virtual-time bound
  assert.ok(!formed(nodes), 'still partitioned')
  assert.ok(
    nodes.some((n) => n.journal.read().some((e) => e.kind === JK.giveUp)),
    'the redial chain must exhaust and give up during the long partition',
  )
  sim.heal('n01', 'n02')
  //! worst case at heal: a revival mid-partition just started a FRESH backoff chain, so the pending
  // redial can sit at the 640ms cap — reconnect latency is bounded by one chain step + a heartbeat
  sim.run({ until: 9500 })
  assert.ok(formed(nodes), 'heartbeat revival must re-form the mesh after heal')
  assert.ok(nodes.some((n) => n.journal.read().some((e) => e.kind === JK.revive)), 'revival is journal-visible')
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['revived'], value: 1 }] })
  sim.run({ until: 9700 })
  assert.equal(converged(sim), null, 'the revived mesh replicates')
  assert.deepEqual(sim.violations, [])
})

test('the periodic AE floor heals loss that NO event announces (digest exchange rides every heartbeat)', () => {
  // Every real TCP loss mode already has a trigger (admit, drain). The floor exists for loss the event
  // system cannot see — a transport bug eating a delivered frame, a future non-TCP shell. Emulating that
  // means excising a record from the receiver as if it never arrived, which deliberately violates the
  // watermark-monotone invariant mid-run — so this cluster is built WITHOUT the perEvent monitors (the
  // monitor would rightly flag the very corruption being injected; that is its job, not a test bug).
  const sim = new Sim(21)
  const ids = ['n01', 'n02']
  const addrs = ids.map((id) => `sim:${id}`)
  const nodes = ids.map((id, i) =>
    sim.add({ uuid: id, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), heartbeatMs: 100, redialMs: 20, journalCap: 1 << 16 }),
  )
  for (const id of ids) sim.post(id, { kind: 'start' })
  sim.run({ until: 500 })
  assert.ok(formed(nodes))
  //! a key n01 OWNS, read off the ring the write pipeline routes by: n01 stamps it, so the record lives on
  // n02 as n01's stream (any other key is stamped by n02 and there would be no n01 stream to forget)
  const v = nodes[0].membership.view
  const ring = new Ring(); ring.build(v.epoch, v.members)
  let x = 'x'
  for (let i = 0; ring.ownerOf(x) !== 'n01'; i++) x = `x${i}`
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: [x], value: 42 }] })
  sim.run({ until: 700 })
  assert.equal(converged(sim), null, 'replicated before the injected loss')
  //! the injected transport bug: n02 forgets the record ever arrived — state, stamp, watermark, log copy
  const b = nodes[1]
  const k = JSON.stringify([x])
  b.state.delete(k)
  b.versions.delete(k)
  const w = b.streams.get('n01')!
  w.applied = w.shippable = w.durable = 0 // the whole ladder forgets — total silent loss of the stream
  b.logs.delete('n01')
  assert.notEqual(converged(sim), null, 'diverged, with no reconnect/drain signal to trigger healing')
  sim.run({ until: 1000 }) // ≥1 heartbeat: the floor digests announce, n01 re-ships the missing suffix
  assert.equal(converged(sim), null, 'the heartbeat digest floor must heal with no other trigger')
})

test('the floor is QUIET when converged: idle heartbeat ticks ship nothing and dup-drop nothing', () => {
  //! mutation-killer (adversarial-review gap): a floor whose digests did NOT carry the real log tails
  // (e.g. hard-coded d:{}) would re-ship the entire history every tick and drown the receiver in
  // dupDrops — while converging identically. Pinning zero AE traffic across idle ticks kills it.
  const sim = new Sim(33)
  const nodes = cluster(sim, 2, { heartbeatMs: 50 })
  sim.run({ until: 300 })
  assert.ok(formed(nodes))
  for (let i = 0; i < 20; i++) sim.post('n01', { kind: 'write', recs: [{ type: 0, key: [`k${i}`], value: i }] }, 1 + i * 5)
  sim.run({ until: 600 })
  assert.equal(converged(sim), null)
  const traffic = () => {
    let ae = 0, dups = 0
    for (const n of sim.nodes.values())
      for (const e of n.journal.read()) { if (e.kind === JK.aeShip) ae++; else if (e.kind === JK.dupDrop) dups++ }
    return { ae, dups }
  }
  const before = traffic()
  sim.run({ until: 1600 }) // ~20 idle ticks
  assert.equal(converged(sim), null)
  assert.deepEqual(traffic(), before, 'an idle floor must ship nothing — digests carry REAL tails')
})

test('40-seed mini-sweep WITH heartbeats: the floor + revival machinery under dup/delay faults, racing writes, partition/heal', () => {
  //! the review's coverage gap: the main sweeps run heartbeatMs 0 (quiescence), so no seed ever
  // exercised the floor digests or revival interleavings. This sweep runs them under the same chaos
  // vocabulary, bounded by virtual time instead of quiescence.
  for (let seed = 100; seed < 140; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, 3, { heartbeatMs: 40 })
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.3 })
    writes(sim, nodes, 25, 200)
    if (seed % 2) {
      const a = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      let b = a
      while (b === a) b = nodes[Math.floor(sim.rng() * nodes.length)].uuid
      const cut = 20 + sim.rng() * 100
      sim.at(cut, () => sim.partition(a, b))
      sim.at(cut + 30 + sim.rng() * 150, () => sim.heal(a, b))
    }
    sim.run({ until: 2500 })
    assert.deepEqual(sim.violations, [], `seed ${seed}`)
    assert.ok(formed(nodes), `seed ${seed}: formed`)
    assert.equal(converged(sim), null, `seed ${seed}`)
  }
})

//! one redial chain per target, replayed from the journal (the double-arm, STATUS 2026-10-09): a
// JK.redial row arms a timer toward b=to; the chain's fire writes JK.dial (a=to) just before it dials.
// Every other dial site skips a target whose chain is still dialing (start runs before any chain;
// discover and a view install test `dialing`; the heartbeat revival moves only on a give-up), so while
// a timer is pending the only dial row toward its target is that timer's own fire — and a second
// redial row before it is a second timer line on the same entry. Holds for runs without `discover`
// (a forgotten target cancels its timer with no row).
const pendingRedials = (node: Node): string | null => {
  const pending = new Map<string, number>()
  for (const e of node.journal.read()) {
    if (e.kind === JK.redial) {
      const n = (pending.get(e.b as string) ?? 0) + 1
      if (n > 1) return `${node.uuid}: ${n} redial timers pending toward ${e.b}`
      pending.set(e.b as string, n)
    } else if (e.kind === JK.dial) {
      const n = pending.get(e.a as string) ?? 0
      if (n > 0) pending.set(e.a as string, n - 1)
    }
  }
  return null
}

test('one redial chain per target: pairs and triples cut while forming and cut again later, open and secured, 80 seeds each — the journal replay never shows two timers pending toward one target', () => {
  //! a cut while both crossing dials are up gives one node TWO linkDowns naming one address: the dialed
  // link's `to` and the accepted link's gossiped listen. Before the guard about a quarter of the pair
  // schedules armed a second chain there; it shared the first one's tries and gave up early.
  for (const secured of [false, true]) {
    const failures: string[] = []
    for (let seed = 0; seed < 80; seed++) {
      const sim = new Sim(seed)
      const n = 2 + (seed % 2)
      const door = secured ? toyDoor('one-chain-secret-0001', sim.rng) : undefined
      const nodes = cluster(sim, n, { heartbeatMs: 50, ...(door ? { door } : {}) })
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 20], dupP: sim.rng() * 0.3 })
      writes(sim, nodes, 10, 300)
      //! the first cut lands inside the formation window, the second one much later; both heal
      const a = nodes[0].uuid, b = nodes[n - 1].uuid
      const cut1 = 2 + sim.rng() * 40
      sim.at(cut1, () => sim.partition(a, b))
      sim.at(cut1 + 30 + sim.rng() * 300, () => sim.heal(a, b))
      const cut2 = 1200 + sim.rng() * 400
      sim.at(cut2, () => sim.partition(a, b))
      sim.at(cut2 + 30 + sim.rng() * 300, () => sim.heal(a, b))
      sim.run({ until: 4000 })
      const problems: string[] = []
      if (sim.violations.length) problems.push(`monitor ${sim.violations[0].monitor}: ${sim.violations[0].detail}`)
      if (!formed(nodes)) problems.push('never re-formed')
      const c = converged(sim); if (c) problems.push(`not converged: ${c}`)
      for (const nd of nodes) { const p = pendingRedials(nd); if (p) problems.push(p) }
      if (problems.length) failures.push(`seed ${seed} (n=${n}${secured ? ', secured' : ''}): ${problems.join('; ')}`)
    }
    assert.deepEqual(failures, [], secured ? 'secured' : 'open')
  }
})

//! the restart's WAL echoes (the review of 802b3fe, 2026-10-09): a reborn node numbers its WAL batches from
// 1 again, so the first life's `persisted` and `persistFail` echoes, still queued behind a slow fsync, named
// the new life's batches. A stale `persisted` told the new life a batch was durable before its own fsync
// landed; a stale `persistFail` would kill the new life's WAL. The exec drops an earlier life's echoes at
// the queue (sim/exec.ts #life). Here the victim's old life has a slow, failing disk; the new life's disk
// is slow but sound, so a `persistFail` that reaches it can only be stale.
test('a restart with batches still in flight on a slow, failing disk: no echo of the old life reaches the new one — every `persisted` the new life sees names a row of its own that has landed, and no `persistFail` kills its WAL', () => {
  const failures: string[] = []
  let checked = 0, torn = 0
  for (let seed = 0; seed < 30; seed++) {
    const sim = new Sim(seed)
    const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
    const victim = nodes[Math.floor(sim.rng() * 3)].uuid
    sim.storeFault(victim, { delay: [300, 400], failP: 0.3 })
    writes(sim, nodes, 120, 1500)
    let early = 0, stale = 0, reborn: Node | undefined
    sim.at(700 + sim.rng() * 100, () => {
      const store = sim.stores.get(victim)!
      torn += store.wal.filter((r) => !r.resolved).length // batches in flight: their echoes are still queued
      sim.storeFault(victim, { delay: [300, 400] }) // the new life's disk is slow but sound
      //! the new life's rows, by batch, registered the moment they are appended or swapped in: a snapshot
      // swap replaces store.wal, so a row may be gone from it when its own echo lands. The old rows are the
      // ones the harvest keeps (restart()'s rule); store.wal is watched across the swaps.
      type Row = (typeof store.wal)[number]
      const seen = new Set<Row>(store.wal.filter((r) => r.resolved && !r.lied))
      const mine = new Map<number, Row[]>()
      const note = (r: Row) => { if (!seen.has(r)) { seen.add(r); mine.set(r.batch, [...(mine.get(r.batch) ?? []), r]) } }
      const watch = (a: Row[]): Row[] => {
        const push = a.push
        a.push = (...rs: Row[]) => { rs.forEach(note); return push.apply(a, rs) }
        a.forEach(note)
        return a
      }
      let wal = store.wal // the old life's array: restart() replaces it with the harvest, through the setter
      Object.defineProperty(store, 'wal', { get: () => wal, set: (a: Row[]) => { wal = watch(a) }, configurable: true })
      reborn = sim.restart(victim)
      const life = reborn
      //! a snapshot swap lands resolved when it is issued (the store contract is synchronous-durable), and it
      // may hold no rows at all: the old life's failed batches leave holes, so the new life condemns its disk
      // at replay and swaps in an EMPTY snapshot. Its echo is honest once the new life has issued it.
      const swapped = (b: number) => life.journal.read().some((e) => e.kind === JK.snapshot && e.a === b)
      const step = life.step.bind(life)
      life.step = (ev) => {
        if (ev.kind === 'persisted') {
          const rows = mine.get(ev.batch)
          if (rows === undefined ? !swapped(ev.batch) : rows.some((r) => !r.resolved)) early++
          else checked++
        }
        if (ev.kind === 'persistFail') stale++
        step(ev)
      }
    })
    sim.run({ until: 4000 })
    const problems: string[] = []
    if (early) problems.push(`${early} \`persisted\` resolved a new-life batch before its own fsync`)
    if (stale) problems.push(`${stale} \`persistFail\` reached the new life`)
    if (reborn && reborn.journal.read().some((e) => e.kind === JK.persistFail)) problems.push('the new life journaled a persistFail')
    if (sim.violations.length) problems.push(`monitor ${sim.violations[0].monitor}: ${sim.violations[0].detail}`)
    const c = converged(sim); if (c) problems.push(`not converged: ${c}`)
    if (problems.length) failures.push(`seed ${seed} (${victim}): ${problems.join('; ')}`)
  }
  assert.deepEqual(failures, [])
  assert.ok(torn > 30, `the schedule really restarts with batches in flight (${torn} torn rows)`)
  assert.ok(checked > 300, `the new lives really persisted (${checked} echoes checked)`)
})

//! the snapshot site's two echo guards (the second review, 2026-10-09): the test above reaches only the
// persist() site, so the snapshot swap's `persisted` and `persistFail` guards could be removed with every
// test green. Here the victim's first snapshot swap after 300 ms is the last thing its old life does: the
// node restarts 1 ms after the swap is issued, with the swap's echo (80-160 ms away) still queued, and in
// the `fail` round the swap itself fails. The new life's disk answers no sooner than 400 ms, so ANY
// `persisted` or `persistFail` the new life steps in its first 400 ms is the old life's.
// (The boot site's persistFail guard cannot be reached: restart() refuses a condemned store, and a failed
// boot record is what condemns it.)
test('a restart while a snapshot swap\'s echo is in flight: neither its `persisted` nor its `persistFail` reaches the new life', () => {
  for (const fail of [false, true]) {
    let restarts = 0, stale = 0
    const failures: string[] = []
    for (let seed = 0; seed < 12; seed++) {
      const sim = new Sim(seed)
      const ids = ['n01', 'n02', 'n03']
      const nodes = ids.map((id, i) => sim.add({ uuid: id, listen: `sim:${id}`, hosts: ids.filter((_, j) => j !== i).map((x) => `sim:${x}`), heartbeatMs: 40, durable: true, tune: { snapshotAt: 6 } }))
      for (const id of ids) sim.post(id, { kind: 'start' })
      const victim = ids[seed % 3]
      sim.storeFault(victim, { delay: [80, 160] })
      writes(sim, nodes, 150, 1500)
      const sink = sim.nodes.get(victim)!.env.sink
      const snapshot = sink.snapshot.bind(sink)
      let armed = true
      sink.snapshot = (batch, rows) => {
        if (!armed || sim.now < 300) return snapshot(batch, rows)
        armed = false
        if (fail) sim.storeFault(victim, { delay: [80, 160], failP: 1 }) // this one swap fails
        snapshot(batch, rows)
        sim.storeFault(victim, { delay: [400, 500] }) // the new life's disk: slow and sound
        const at = sim.now + 1
        sim.at(1, () => { // a delay: Sim.at schedules relative to now
          const life = sim.restart(victim)
          restarts++
          const step = life.step.bind(life)
          life.step = (ev) => {
            if ((ev.kind === 'persisted' || ev.kind === 'persistFail') && sim.now < at + 400) stale++
            step(ev)
          }
        })
      }
      sim.run({ until: 4000 })
      if (sim.violations.length) failures.push(`seed ${seed}: monitor ${sim.violations[0].monitor}: ${sim.violations[0].detail}`)
      const c = converged(sim); if (c) failures.push(`seed ${seed}: not converged: ${c}`)
    }
    assert.equal(stale, 0, `${fail ? 'a failed' : 'a sound'} swap: no old-life echo reaches the new life`)
    assert.deepEqual(failures, [])
    assert.equal(restarts, 12, 'every seed restarted with a swap echo in flight')
  }
})

test('checkEvery: 1 (and default) are byte-identical — the throttle at K=1 IS the per-event contract', () => {
  const runWith = (opts?: { checkEvery?: number }) => {
    const sim = new Sim(1234)
    const nodes = cluster(sim, 3)
    sim.fault('n01', 'n02', { delay: [1, 20], dupP: 0.3 })
    writes(sim, nodes, 25)
    const violations = sim.run(opts ?? {})
    return { events: sim.events, trace: sim.trace.join(','), violations }
  }
  const dflt = runWith()
  const k1 = runWith({ checkEvery: 1 })
  assert.equal(k1.events, dflt.events)
  assert.equal(k1.trace, dflt.trace)
  assert.deepEqual(k1.violations, dflt.violations)
})

test('checkEvery: K detects a planted violation within K events of its per-event index', () => {
  //! the monitor mechanism is what is under test, not any one invariant — a planted monitor that
  // trips at a known event index measures exactly how far detection may lag under sampling.
  const detectionAt = (checkEvery: number): number => {
    const sim = new Sim(77)
    const nodes = cluster(sim, 3)
    writes(sim, nodes, 25)
    sim.monitors.push({ name: 'planted', check: (s: Sim) => (s.events >= 100 ? 'planted' : null) })
    const violations = sim.run({ stopOnViolation: true, checkEvery })
    const hit = violations.find((v) => v.monitor === 'planted')!
    assert.ok(hit, 'the planted violation must be detected')
    return hit.event
  }
  const perEvent = detectionAt(1)
  assert.equal(perEvent, 100, 'per-event detection lands ON the violating event')
  const sampled = detectionAt(30)
  assert.ok(sampled >= 100 && sampled <= 100 + 30, `detection at ${sampled} must lag <= checkEvery past event 100`)
})

test('checkEvery: a violation in the final sub-K tail is caught by the exit check at the final state', () => {
  const sim = new Sim(77)
  const nodes = cluster(sim, 3)
  writes(sim, nodes, 25)
  sim.monitors.push({ name: 'planted', check: (s: Sim) => (s.events >= 100 ? 'planted' : null) })
  //! checkEvery far beyond the trajectory: no periodic pass ever fires — only the exit check stands
  // between a tail violation and a silent pass
  const violations = sim.run({ checkEvery: 1 << 30 })
  const hit = violations.find((v) => v.monitor === 'planted')!
  assert.ok(hit, 'the exit check must catch what no periodic pass saw')
  assert.equal(hit.event, sim.events, 'detection is stamped at the final event')
  assert.ok(sim.quiesced, 'the trajectory ran to quiescence despite the pending violation')
})

test('pause: every event held for a paused node is replayed as its OWN event at the wake, in order — the monitors run between them, as after every other event (a wake that stepped the whole batch in one task gave them one pass, so a view installed and replaced inside the batch was never sampled: the wave 5c review)', () => {
  const sim = new Sim(5)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 800 })
  assert.ok(nodes.every((x) => x.epoch === 1), 'formed')
  //! 311 ms: not a multiple of the heartbeat, so no tick of another node lands on the wake instant by alignment
  const wake = sim.now + 311
  sim.pause('n02', 311)
  sim.run({ until: wake - 1 })
  //! a planted monitor that counts the passes AT the wake instant; the trace grows by one per step, so the steps at that
  // instant are the replayed events (nothing else of n02's runs then: it was asleep until this very moment)
  const trace0 = sim.trace.length
  let passes = 0
  sim.monitors.push({ name: 'passes-at-the-wake', check: (s: Sim) => { if (s.now === wake) passes++; return null } })
  sim.run({ until: wake })
  const steps = sim.trace.length - trace0
  assert.ok(steps >= 2, `events piled up for the sleeper: ${steps} steps replayed at the wake`)
  assert.ok(passes >= steps, `one monitor pass per replayed event: ${passes} passes for ${steps} steps (one pass for the whole batch hides what happened inside it)`)
  assert.equal(sim.violations.length, 0, 'the replay itself trips nothing')
})

test('backpressure overflow heals: the queue clears to a tail hole, the drain-time digest exchange re-ships it all', () => {
  const sim = new Sim(9)
  const nodes = cluster(sim, 2)
  sim.run()
  assert.ok(formed(nodes))
  //! pause n01's link to n02, write past MAX_QUEUED so the overflow clears the queue and de-syncs, then drain
  const link = [...nodes[0].links.values()].find((l) => l.uuid === 'n02')!
  sim.post('n01', { kind: 'pause', link: link.id })
  sim.run()
  for (let i = 0; i < 300; i++) sim.post('n01', { kind: 'write', recs: [{ type: 0, key: [`k${i}`], value: i }] }, i * 0.1)
  sim.run()
  assert.equal(link.queued.length, 0, 'overflow clears the WHOLE queue — pure tail loss')
  assert.equal(link.synced, false, 'overflow de-syncs the link until the heal completes')
  assert.ok(nodes[0].journal.read().some((e) => e.kind === 11 /* dropOldest */), 'loss is journal-visible')
  sim.post('n01', { kind: 'drain', link: link.id })
  sim.run()
  assert.equal(converged(sim), null, 'the post-drain digest exchange must re-ship the shed tail')
  assert.equal(nodes[1].state.size, 300)
  assert.equal(link.synced, true)
})
