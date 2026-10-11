//! ── The scoped monitor walk reports exactly what the full walk reports (wave 5e) ─────────────────────────
// A monitor pass used to read every node; since wave 5e it reads the nodes a step changed (sim/monitors.ts, the
// table above `Due`). That is only worth having if it is the SAME monitor. This suite runs the same seeded
// trajectory both ways, the scoped walk and the old full walk (FERO_SIM_MONITOR_FULL=1, the switch a Sim reads when
// it is built), and compares what the monitors said: the whole violation list (every row, repeats included,
// event index and text), the event count, and the trace of node hashes (the monitors read, never move, a
// trajectory).
//
// Equality of two EMPTY lists proves nothing, so most runs here carry a violation, planted in three ways:
//   - a patched node.step corrupts its own state inside a step, one plant per original monitor, a second
//     violator at an earlier node that heals again (the full walk goes back to the first: the debt `Due` keeps),
//     at checkEvery 1 and 7;
//   - the scoped-sweep mutation runner's injected drops, which the scale monitors (M1-M11) must catch;
//   - a real violation of today's kernel (A2 seed 9, attempt-exactly-once, KNOWN_UNSAFE in the sweep test).
// Each plant asserts its own monitor fired in the full run, so a plant that did not bite fails loudly.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim, type Violation } from './exec.ts'
import { cluster, writes } from './harness.ts'
import { armScale, ledgerOf } from './monitors.ts'
import { runFamily, familyByName, type Mutation } from './scoped-sweep.ts'
import { SCOPE } from '../kernel/scope.ts'
import type { Node } from '../kernel/node.ts'

const KNOB = 'FERO_SIM_MONITOR_FULL'
//! walk — run `f` with the knob set (the full walk) or unset (the scoped walk): a Sim reads it when it is built
const walk = <T>(full: boolean, f: () => T): T => {
  const prev = process.env[KNOB]
  if (full) process.env[KNOB] = '1'; else delete process.env[KNOB]
  try { return f() } finally { if (prev === undefined) delete process.env[KNOB]; else process.env[KNOB] = prev }
}
const rows = (vs: Violation[]) => vs.map((v) => `${v.event} ${v.monitor}: ${v.detail}`)
const sameTrajectory = (a: Sim, b: Sim, what: string) => {
  assert.equal(a.events, b.events, `${what}: the same number of events`)
  assert.deepEqual(a.trace, b.trace, `${what}: the same trace of node hashes — the walk moved nothing`)
}

// ── part 1: one plant per original monitor ───────────────────────────────────────────────────────

//! stepsOf — patch a node so `f(n, k)` runs after its k-th step, inside the step (the walk sees it as a step's own change)
const stepsOf = (n: Node, f: (n: Node, k: number) => void) => {
  const step = n.step.bind(n)
  let k = 0
  ;(n as unknown as { step: (ev: unknown) => void }).step = (ev) => { step(ev as never); f(n, ++k) }
}
//! once — run `try_` from step `from` on until it applies (it returns true), exactly once
const once = (from: number, try_: (n: Node) => boolean) => { let done = false; return (n: Node, k: number) => { if (!done && k >= from && try_(n)) done = true } }

interface Plant {
  name: string
  monitor: string
  scoped?: boolean
  //! install the plant: `late` is a node that sorts after the persistent one's neighbour (n5), `early` one that sorts before it (n2)
  install(nodes: Node[], late: Node, early: Node): void
}

const fakeEntry = (n: Node): { rec: unknown; seq: number; epoch: number } | null => {
  for (const [, lane] of n.logs) for (const e of lane) if (e.epoch > 0) return e
  return null
}

const PLANTS: Plant[] = [
  {
    name: 'a queued frame on a flowing link', monitor: 'queued-implies-paused',
    install: (_, late, early) => {
      stepsOf(late, once(25, (n) => { const l = [...n.links.values()].find((x) => !x.paused); if (!l) return false; l.queued.push(new Uint8Array(1)); return true }))
      //! the early node's plant heals itself 15 steps later: the full walk reports n5 again after it
      let link: { queued: Uint8Array[] } | null = null, healed = false
      stepsOf(early, (n, k) => {
        if (healed) return
        if (link === null && k >= 40) { const l = [...n.links.values()].find((x) => !x.paused); if (l) { l.queued.push(new Uint8Array(1)); link = l } }
        else if (link !== null && k >= 55) { link.queued.length = 0; healed = true }
      })
    },
  },
  {
    name: 'shippable above applied', monitor: 'watermark-ordering',
    install: (_, late, early) => {
      stepsOf(late, once(25, (n) => { for (const [, s] of n.streams) { s.shippable = s.applied + 3; return true } return false }))
      let was: { s: { shippable: number }; v: number } | null = null, healed = false
      stepsOf(early, (n, k) => {
        if (healed) return
        if (was === null && k >= 40) { for (const [, s] of n.streams) { was = { s, v: s.shippable }; s.shippable = s.applied + 2; break } }
        else if (was !== null && k >= 55) { was.s.shippable = was.v; healed = true }
      })
    },
  },
  {
    name: 'an applied mark that went backwards', monitor: 'watermark-monotone',
    install: (_, late) => {
      //! from step 60: the stream must have been SEEN by a pass (a plant in the step that creates it leaves the monitor nothing to compare)
      stepsOf(late, once(60, (n) => { for (const [, s] of n.streams) if (s.applied > 1) { s.applied -= 1; return true } return false }))
    },
  },
  {
    name: 'a lane that is not seq-ascending', monitor: 'log-monotone',
    install: (_, late, early) => {
      const plant = (from: number) => once(from, (n) => { for (const [, lane] of n.logs) if (lane.length >= 3) { lane.push({ ...lane[lane.length - 1], seq: lane[0].seq }); return true } return false })
      stepsOf(late, plant(35))
      stepsOf(early, plant(50))
    },
  },
  {
    name: 'two writers in one (partition, epoch)', monitor: 'single-writer',
    install: (_, late) => {
      stepsOf(late, once(40, (n) => { const e = fakeEntry(n); if (!e) return false; n.logs.set('zw', [{ ...e, seq: 1 } as never]); return true }))
    },
  },
  {
    name: 'one attempt committed twice', monitor: 'attempt-exactly-once',
    install: (_, late) => {
      stepsOf(late, once(40, (n) => {
        const e = fakeEntry(n)
        if (!e) return false
        n.logs.set('za', [{ ...e, seq: 1, iss: 'q', cid: 7 } as never])
        n.logs.set('zb', [{ ...e, seq: 2, iss: 'q', cid: 7 } as never])
        return true
      }))
    },
  },
  {
    name: 'a different view for a committed epoch', monitor: 'one-view-per-epoch',
    install: (_, late, early) => {
      stepsOf(late, once(40, (n) => { const v = n.membership.view; if (v.epoch === 0 || v.members.length < 2) return false; n.membership.view = { epoch: v.epoch, members: v.members.slice(1) }; return true }))
      let saved: { epoch: number; members: unknown[] } | null = null, healed = false
      stepsOf(early, (n, k) => {
        if (healed) return
        const v = n.membership.view
        if (saved === null && k >= 45 && v.epoch > 0 && v.members.length > 2) { saved = v as never; n.membership.view = { epoch: v.epoch, members: v.members.slice(2) } }
        else if (saved !== null && k >= 60) { n.membership.view = saved as never; healed = true }
      })
    },
  },
  {
    name: 'an epoch that went backwards', monitor: 'epoch-monotone',
    install: (_, late) => {
      //! from step 110: the node held epoch 1 through a pass or two first
      stepsOf(late, once(110, (n) => { if (n.epoch < 1) return false; n.epoch -= 1; return true }))
    },
  },
  {
    name: 'a held partition the ring assigns elsewhere', monitor: 'scoped-lawful-holding', scoped: true,
    install: (_, late, early) => {
      const plant = (from: number) => once(from, (n) => {
        if (!n.scope || !n.armed) return false
        const ring = n.writes.ring
        if (ring.epoch !== n.epoch) ring.build(n.epoch, n.membership.view.members)
        for (let i = 0; i < 500; i++) if (!ring.holdsAny(n.uuid, 'zz' + i, n.replicas)) { n.scope.entries.set('zz' + i, { state: SCOPE.held, marks: new Map(), marksD: new Map(), gl: new Set() } as never); return true }
        return false
      })
      stepsOf(late, plant(60))
      stepsOf(early, plant(70))
    },
  },
  {
    name: 'an orphan floor that advanced', monitor: 'orphan-frozen', scoped: true,
    install: (_, late, early) => {
      //! every step from `from` on, an orphan entry for 'zq' exists and its floor on every lane is one higher than at the step before;
      //! after `to` the entry is taken away again (the early node heals: its snapshot goes, the full walk reports the late node alone)
      const plant = (from: number, to: number) => (n: Node, k: number) => {
        if (!n.scope || !n.armed || k < from) return
        if (k > to) { if (n.scope.entries.delete('zq')) for (const [, d] of n.streams) d.parts?.delete('zq'); return }
        if (!n.scope.entries.has('zq')) n.scope.entries.set('zq', { state: SCOPE.orphan, marks: new Map(), marksD: new Map(), gl: new Set() } as never)
        for (const [, d] of n.streams) { d.parts ??= new Map(); d.parts.set('zq', { s: k - from + 1, d: 0 } as never) }
      }
      stepsOf(late, plant(90, Infinity))
      stepsOf(early, plant(100, 110))
    },
  },
]

const runPlant = (p: Plant, K: number, full: boolean) => walk(full, () => {
  const sim = new Sim(11)
  const nodes = cluster(sim, 6, { heartbeatMs: 100, fault: { delay: [1, 6], dupP: 0.05 }, ...(p.scoped ? { replicas: 2 } : {}) })
  armScale(sim) // the scale monitors ride along: the comparison covers all of them, not the original nine alone
  writes(sim, nodes, 60, 300)
  p.install(nodes, nodes[4], nodes[1])
  sim.run({ until: 3000, checkEvery: K, maxEvents: 2_000_000 })
  return sim
})

for (const p of PLANTS)
  for (const K of [1, 7])
    test(`scoped walk = full walk, planted: ${p.name} (${p.monitor}), checkEvery ${K} — the whole violation list is identical`, () => {
      const a = runPlant(p, K, true)
      const b = runPlant(p, K, false)
      assert.ok(a.full && !b.full, 'the knob picked the walk')
      assert.ok(a.violations.some((v) => v.monitor === p.monitor), `the plant bit: the full walk saw ${p.monitor} (it saw ${[...new Set(a.violations.map((v) => v.monitor))].join(', ') || 'nothing'})`)
      assert.deepEqual(rows(b.violations), rows(a.violations))
      sameTrajectory(a, b, p.name)
    })

// ── part 2: the scoped sweep's families, mutated and not ──────────────────────────────────────────

//! the pinned mutation catches of sim/scoped-sweep.test.ts, a clean run of each, and A2 seed 9 (a real attempt-exactly-once
// violation of today's kernel)
const FAMILY_RUNS: [string, number, Mutation][] = [
  ['A6-flip-mid-latch', 3, 'drop-one'],
  ['A7-down-to-one', 4, 'drop-one'],
  ['A1-zombie', 8, 'drop-one'],
  ['A11-spoke', 7, 'version-only'],
  ['A2-slow-owner-join', 9, 'none'],
  ['A5-view-severed', 1, 'none'],
  ['A11-spoke', 2, 'none'],
  ['A4-restarts', 1, 'none'], // sim.restart(): a node replaced inside an at() task
  ['A10-linger', 1, 'none'], // a node destroyed and dropped from sim.nodes
]

test('scoped walk = full walk on the scoped-sweep families: mutated, clean and a real violation — the same violation rows, the same engagement counts, the same trajectory', () => {
  let withViolations = 0
  const monitors = new Set<string>()
  for (const [name, seed, mut] of FAMILY_RUNS) {
    const fam = familyByName(name)
    const a = walk(true, () => runFamily(fam, seed, mut))
    const b = walk(false, () => runFamily(fam, seed, mut))
    assert.ok(a.sim.full && !b.sim.full, 'the knob picked the walk')
    assert.deepEqual(rows(b.sim.violations), rows(a.sim.violations), `${a.shape}: the violation rows`)
    assert.deepEqual(b.eng, a.eng, `${a.shape}: the engagement counts (the ledger saw the same cells, floors, releases and leaves)`)
    assert.deepEqual([...b.red].sort(), [...a.red].sort(), `${a.shape}: the monitors that went red`)
    sameTrajectory(a.sim, b.sim, a.shape)
    if (a.sim.violations.length) withViolations++
    for (const v of a.sim.violations) monitors.add(v.monitor)
  }
  assert.ok(withViolations >= 4, `the comparison is not vacuous: ${withViolations} of ${FAMILY_RUNS.length} runs carried violations`)
  assert.ok(monitors.has('stamp-oracle') || monitors.has('release-safety') || monitors.has('census-truth'), `a scale monitor fired (${[...monitors].join(', ')})`)
  assert.ok(monitors.has('attempt-exactly-once'), `an original monitor fired on a real violation (${[...monitors].join(', ')})`)
})

// ── part 3: n=100, the scale tier's own shape ─────────────────────────────────────────────────────

test('scoped walk = full walk at n=100 (the scale tier\'s converge shape, sampled every 500 events, a queued frame planted at one node): the same violation rows, the same trajectory', () => {
  const go = (full: boolean) => walk(full, () => {
    const sim = new Sim(0)
    const nodes = cluster(sim, 100, { fault: { delay: [1, 15], dupP: 0.1 } })
    armScale(sim)
    writes(sim, nodes, 120, 300)
    stepsOf(nodes[63], once(300, (n) => { const l = [...n.links.values()].find((x) => !x.paused); if (!l) return false; l.queued.push(new Uint8Array(1)); return true }))
    sim.run({ checkEvery: 500, maxEvents: 3_000_000 })
    return sim
  })
  const a = go(true)
  const b = go(false)
  assert.ok(a.violations.some((v) => v.monitor === 'queued-implies-paused'), 'the plant bit at n=100')
  assert.deepEqual(rows(b.violations), rows(a.violations))
  sameTrajectory(a, b, 'n=100')
})

// ── part 4: the walk itself ───────────────────────────────────────────────────────────────────────

test('a pass after run() entry or an at() task reads every node: a state edit made outside any step is seen by the next pass, as the full walk would', () => {
  const go = (full: boolean) => walk(full, () => {
    const sim = new Sim(3)
    const nodes = cluster(sim, 4, { heartbeatMs: 100 })
    sim.run({ until: 600 })
    //! outside any step, between two runs: n3 gets a queued frame on a flowing link, and n3 never steps again before the pass
    const l = [...nodes[2].links.values()].find((x) => !x.paused)!
    l.queued.push(new Uint8Array(1))
    sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['x'], value: 1 }] }, 1) // an event for a pass to follow, at another node
    sim.run({ until: 605 })
    l.queued.length = 0
    //! the same from inside an at() task
    sim.at(5, () => { const l2 = [...nodes[1].links.values()].find((x) => !x.paused)!; l2.queued.push(new Uint8Array(1)) })
    sim.run({ until: 700 })
    return sim
  })
  const a = go(true)
  const b = go(false)
  assert.ok(a.violations.some((v) => v.detail.includes('n03')) && a.violations.some((v) => v.detail.includes('n02')), 'both edits were seen by the full walk')
  assert.deepEqual(rows(b.violations), rows(a.violations))
})

test('the ledger\'s scan reads every node on the first pass after run() entry: a log entry appended outside any step is gathered at once, as the full walk gathers it', () => {
  //! the ledger scan reads only the stepped nodes when its last scan was the pass before; a pass after run() entry must
  // read them all. Without that, an entry appended by hand at a node that has not stepped since is missed until it does.
  const go = (full: boolean) => walk(full, () => {
    const sim = new Sim(3)
    const nodes = cluster(sim, 4, { heartbeatMs: 100 })
    const L = armScale(sim)
    sim.run({ until: 600 })
    //! outside any step: n03 gets a new lane with one epoch-0 entry (exempt from single-writer, no attempt identity)
    nodes[2].logs.set('zz', [{ seq: 1, epoch: 0, rec: { type: 0, key: ['zz'], value: 1 } } as never])
    sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['x'], value: 1 }] }, 1) // the one event before the pass, at another node
    sim.run({ until: 601 })
    return { sim, seen: L.recs.has('zz|1'), keys: [...L.recs.keys()] }
  })
  const a = go(true)
  const b = go(false)
  assert.ok(a.seen, 'the full walk gathered the hand-appended entry')
  assert.ok(!b.sim.stepped.has('n03') && b.sim.passes > 0, 'n03 did not step before the pass: only the run() entry rule reads it')
  assert.ok(b.seen, 'the scoped walk gathered it at the same pass')
  assert.deepEqual(b.keys, a.keys, 'the ledger holds the same records in the same order')
  assert.deepEqual(rows(b.sim.violations), rows(a.sim.violations))
})

test('the ledger\'s scan between two passes reads every node: a horizon read (stampOracle) after one unscanned pass gathers what the full walk gathers', () => {
  //! the pass clears sim.stepped at its end, so a scan made between passes cannot trust it. A sim whose passes never
  // scan (no scale monitors) and a horizon read before and after exactly one pass is the shape that went blind.
  const go = (full: boolean) => walk(full, () => {
    const sim = new Sim(3)
    cluster(sim, 4, { heartbeatMs: 0 })
    sim.run()
    const L = ledgerOf(sim)
    L.scan(sim) // a horizon read, as stampOracle makes
    const before = L.recs.size
    for (let i = 0; i < 5; i++) sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['k' + i], value: i }] }, i)
    const p0 = sim.passes
    sim.run({ checkEvery: 1 << 30 }) // one pass: the exit check
    L.scan(sim) // the second horizon read
    return { added: L.recs.size - before, keys: [...L.recs.keys()], passes: sim.passes - p0 }
  })
  const a = go(true)
  const b = go(false)
  assert.equal(a.passes, 1, 'exactly one pass ran between the two reads')
  assert.equal(a.added, 5, 'the full walk gathered the five new writes')
  assert.equal(b.added, a.added, 'the scoped walk gathered them too')
  assert.deepEqual(b.keys, a.keys, 'the same records in the same order')
})
