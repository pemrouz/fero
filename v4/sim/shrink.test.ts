//! ── sim/shrink.test — the shrinker: golden identity, the oracle, 1-minimality, the acceptance loop ──
// T1 pins the plan/post refactor against the FROZEN pre-M7 harness code (byte-identical trajectories);
// T4 is the M7 acceptance line end-to-end: a deliberately-broken build (the V1d mutation-test precedent)
// fails under chaos → shrink → the capture opens AT the violation with time-travel intact.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster } from './harness.ts'
import { REC, type Rec } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'
import {
  shrink, sweepBuild, replayShrunk, minimize, normalize, classify, decodeSteps,
  type Build, type Built, type Step, type FailClass,
} from './shrink.ts'
import { captureSim } from '../tools/debug/capture.ts'
import { stateAt, verifyReplay, summarize } from '../tools/debug/model.mjs'

//! the FROZEN pre-M7 sweep scenario — run.ts's inline block + writes()/valueOf() bodies as they were
// BEFORE the writesPlan split. This golden is the refactor's pin: if sweepBuild ever draws differently,
// T1 fails here even though the sweep (which now runs THROUGH sweepBuild) can no longer notice.
const goldenValueOf = (sim: Sim, i: number): unknown => {
  switch (Math.floor(sim.rng() * 8)) {
    case 0: return i
    case 1: return sim.rng() < 0.5 ? null : undefined
    case 2: return sim.rng() < 0.5
    case 3: return `v${i}-é中文`
    case 4: return sim.rng() < 0.3 ? NaN : sim.rng() * 1e9
    case 5: return { n: i, s: `s${i}`, deep: { ok: true, list: [1, 'two', null] } }
    case 6: return [i, `x${i}`, { y: i }]
    default: return new Uint8Array([i & 0xff, (i >> 8) & 0xff])
  }
}
const goldenBuild = (seed: number, nNodes = 3, nWrites = 40) => {
  const sim = new Sim(seed)
  const nodes = cluster(sim, nNodes)
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsi']
  for (let i = 0; i < nWrites; i++) {
    const node = nodes[Math.floor(sim.rng() * nodes.length)]
    const key = keys[Math.floor(sim.rng() * keys.length)] + Math.floor(sim.rng() * 4)
    const roll = sim.rng()
    const rec: Rec =
      roll < 0.15
        ? { type: REC.remove, key: [key] }
        : roll < 0.5
          ? { type: REC.update, key: [key], value: goldenValueOf(sim, i) }
          : roll < 0.75
            ? { type: REC.update, key: [key, 'nested'], value: goldenValueOf(sim, i) }
            : { type: REC.insert, key: [], at: key, value: goldenValueOf(sim, i) }
    sim.post(node.uuid, { kind: 'write', recs: [rec] }, 1 + sim.rng() * 300)
  }
  if (seed % 2) {
    const a = nodes[Math.floor(sim.rng() * nodes.length)].uuid
    let b = a
    while (b === a) b = nodes[Math.floor(sim.rng() * nodes.length)].uuid
    const cut = 20 + sim.rng() * 150
    sim.at(cut, () => sim.partition(a, b))
    sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
  }
  return { sim, nodes }
}

test('T1 golden: sweepBuild is byte-identical to the frozen pre-split scenario across 200 seeds', () => {
  for (let seed = 0; seed < 200; seed++) {
    const g = goldenBuild(seed)
    g.sim.run()
    const b = sweepBuild(seed)(null)
    b.sim.run()
    assert.equal(b.sim.events, g.sim.events, `seed ${seed}: event count drift`)
    assert.deepEqual(b.sim.violations, g.sim.violations, `seed ${seed}: violation drift`)
    for (let i = 0; i < g.nodes.length; i++) {
      assert.equal(b.nodes[i].stateHash, g.nodes[i].stateHash, `seed ${seed}: ${g.nodes[i].uuid} state drift`)
      assert.equal(b.nodes[i].journal.n, g.nodes[i].journal.n, `seed ${seed}: ${g.nodes[i].uuid} journal drift`)
    }
  }
})

//! the mutation knob (DESIGN-M6/V1d precedent): a FENCE-BLIND log re-append on one node — a chaos
// duplicate that should be absorbed by the applied high-water re-enters the log instead. Trips the
// per-event log-monotone monitor; touches neither journal nor state (verifyReplay stays green and the
// non-ascending pair rides the artifact as the physical witness). Returns flavor 0 (absorbed) so the
// dispatch path takes no fresh-record side effects.
const mutate = (b: Built): Built => {
  const w = b.nodes[1].writes
  const real = w.inbound.bind(w)
  w.inbound = (node: Node, origin: string, seq: number, epoch: number, rv: { rec(): Rec; issuer: string; cid: number; pp?: number }): number => {
    const d = node.streams.for(origin)
    if (seq <= d.applied) { node.logFor(origin).push({ rec: rv.rec(), seq, epoch }); return 0 }
    return real(node, origin, seq, epoch, rv)
  }
  return b
}
const mutantBuild = (seed: number): Build => (subset) => mutate(sweepBuild(seed)(subset))

//! find the first sweep seed the mutant breaks (cached — T2/T4/T7 share it)
let found: number | null = null
const mutantSeed = (): number => {
  if (found !== null) return found
  for (let seed = 0; seed < 60; seed++) {
    const b = mutantBuild(seed)(null)
    try { b.sim.run() } catch { continue }
    if (b.sim.violations.length && b.sim.violations[0].monitor === 'log-monotone') return (found = seed)
  }
  assert.fail('no seed in 0..59 tripped log-monotone under the mutant — chaos dupP should make this common')
}

test('T2 stopOnViolation freezes the trajectory AT the violating event', () => {
  const b = mutantBuild(mutantSeed())(null)
  b.sim.run({ stopOnViolation: true })
  assert.ok(b.sim.violations.length >= 1, 'violation expected')
  assert.equal(b.sim.events, b.sim.violations[0].event, 'sim.events must equal the first violation index')
})

test('T3 minimize is 1-minimal on a pure stub predicate, with bounded runs', () => {
  let runs = 0
  const holds = (s: number[]) => { runs++; return s.includes(3) && s.includes(7) }
  const out = minimize([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], holds)
  assert.deepEqual([...out].sort((a, b) => a - b), [3, 7])
  assert.ok(runs <= 60, `greedy fixpoint should need few runs, took ${runs}`)
})

test('T4 the acceptance line: chaos failure → shrink → capture opens AT the violation, time-travel intact', () => {
  const seed = mutantSeed()
  //! the same steps on the UN-mutated build are green — the failure is the mutant's, not the schedule's
  const clean = sweepBuild(seed)(null)
  clean.sim.run()
  assert.equal(classify(clean), null, 'un-mutated build must be green on the same seed')

  const s = shrink(mutantBuild(seed))
  assert.ok(s, 'shrink must reproduce and minimize')
  assert.ok('monitor' in s.cls && s.cls.monitor === 'log-monotone', `class preserved, got ${JSON.stringify(s.cls)}`)
  assert.ok(s.steps.length < s.from.steps, `must remove steps (${s.from.steps} → ${s.steps.length})`)
  assert.ok(s.atViolation, 'final run must be frozen at the violation')

  //! 1-minimality spot-check: removing any single surviving step must break the reproduction
  const picks = [...new Set([0, s.steps.length >> 1, s.steps.length - 1])]
  for (const i of picks) {
    const cand = s.steps.slice(0, i).concat(s.steps.slice(i + 1))
    const r = mutantBuild(seed)(cand)
    let cls: FailClass | null
    try { r.sim.run({ maxEvents: Math.max(4 * s.from.events, 50_000) }); cls = classify(r) } catch (e) { cls = { threw: normalize(e) } }
    assert.ok(!(cls && JSON.stringify(cls) === JSON.stringify(s.cls)), `dropping surviving step ${i} still reproduces — not 1-minimal`)
  }

  //! the artifact: shrunk block present, capture ends AT the violation, folds all work, witness present
  const cap = JSON.parse(JSON.stringify(captureSim(s.sim, s)))
  assert.ok(cap.shrunk, 'capture carries the shrunk block')
  assert.equal(cap.shrunk.atViolation, true)
  assert.equal(cap.events, cap.violations[0].event, 'capture frozen at the violating event')
  assert.ok(cap.shrunk.from.fail.includes('log-monotone'), 'original failure line rides the artifact')
  for (const r of verifyReplay(cap)) assert.ok(r.ok, `replay-refold must stay green (${r.uuid}: ${r.reason ?? ''}) — the mutant poisons only the log`)
  const st = stateAt(cap, cap.nodes[1].uuid, Infinity)
  assert.ok(st instanceof Map, 'time-travel to the violation instant works')
  assert.ok(summarize(cap).shrunk, 'summarize passes the shrunk facts through')
  const poisoned = cap.nodes.some((n: { logs: Record<string, { seq: number }[]> }) =>
    Object.values(n.logs).some((entries) => entries.some((e, i) => i > 0 && e.seq <= entries[i - 1].seq)))
  assert.ok(poisoned, 'the non-ascending pair is the physical witness in the artifact')
})

test('T5 the oracle: detail is witness not identity; classes cross-reject; throw messages normalize', () => {
  assert.equal(normalize(new Error('seq 41 != 40 at index 7')), 'seq # != # at index #')
  const fake = (violations: { event: number; monitor: string; detail: string }[]) =>
    ({ sim: { violations }, nodes: [] }) as unknown as Built
  //! same monitor, different detail → same class (JSON-equal on {monitor})
  const a = classify(fake([{ event: 1, monitor: 'log-monotone', detail: 'n02 log[x] at 3: 5 after 6' }]))
  const b = classify(fake([{ event: 9, monitor: 'log-monotone', detail: 'n01 log[y] at 8: 2 after 4' }]))
  assert.deepEqual(a, b)
  //! different monitor first → different class
  const c = classify(fake([{ event: 1, monitor: 'single-writer', detail: 'x' }]))
  assert.notDeepEqual(a, c)
  //! end-classes carry their NAME (never a bare boolean) and cross-reject
  assert.notDeepEqual({ end: 'diverged' }, { end: 'undrained' })
})

test('T6 no-repro honesty: a green build shrinks to null, no artifact', () => {
  assert.equal(shrink(sweepBuild(0)), null) // seed 0 is green (the 1000-seed sweep pins it)
})

test('T7 repro round-trip: the shrunk artifact replays bit-for-bit from DATA through JSON', () => {
  const seed = mutantSeed()
  const s = shrink(mutantBuild(seed))
  assert.ok(s)
  const cap = JSON.parse(JSON.stringify(captureSim(s.sim, s)))
  //! rebuild from the JSON repro block alone (values decoded: NaN/undefined/bytes must survive), re-apply
  // the mutant (the repro reproduces the SCHEDULE; the broken build is the test's to supply), re-run frozen
  const b = mutate(replayShrunk({ ...cap.shrunk.repro, steps: decodeSteps(cap.shrunk.repro.steps) }))
  b.sim.run({ stopOnViolation: true })
  assert.equal(b.sim.events, s.sim.events, 'replay must land on the same violating event index')
  assert.deepEqual(b.sim.violations[0].monitor, 'log-monotone')
  for (let i = 0; i < b.nodes.length; i++)
    assert.equal(b.nodes[i].stateHash, s.nodes[i].stateHash, `${b.nodes[i].uuid} state must match the shrink's final run`)
})
