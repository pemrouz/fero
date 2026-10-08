//! Tier-2 overlapping-cells suite (V4-18): a whole-row write and a field write on one row are two
// cells, and before this rule the object a node showed depended on the order the two arrived — the
// same cell map on every node, a different row on each. The rule: the newer stamp wins ACROSS depth
// (kernel/node.ts apply). The oracle here is projected() (sim/monitors.ts), run by converged(): no
// live field cell at or below its row's stamp, and one folded object on every node. The probe is
// the schedule that showed the bug; the sweep is the sweep.test workload (writesPlan already mixes
// both shapes on every key) under the new oracle, with the faults that reorder lanes.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, projected, drained } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { REC, type Rec } from '../kernel/env.ts'

const key = (...k: string[]) => JSON.stringify(k)

test('the probe: a row write newer than a field write, each on its own lane at genesis — every node hides the field, in every arrival order', () => {
  const sim = new Sim(1801)
  const nodes = cluster(sim, 3)
  //! lanes arrive in different orders at different nodes: n02's field write is its first stamp (seq 1);
  // n01's row write is its second (seq 2) — the row is NEWER. n02 folds its own field first, then n01's
  // row; n01 the other way round; n03 whichever the delays deliver first.
  sim.fault('n01', 'n03', { delay: [40, 41] })
  sim.fault('n02', 'n03', { delay: [1, 2] })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['warm'], value: 1 }] }, 1)
  sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: ['g', 'stock'], value: 9 }] }, 2)
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['g'], value: { stock: 3 } }] }, 3)
  sim.run()
  assert.ok(formed(nodes) && sim.quiesced)
  assert.equal(projected(sim), null, 'the object oracle')
  assert.equal(converged(sim), null)
  for (const n of nodes) {
    assert.deepEqual(n.state.get(key('g')), { stock: 3 }, `${n.uuid} holds the row`)
    assert.equal(n.state.has(key('g', 'stock')), false, `${n.uuid} does not hold the older field`)
  }
  //! n02 folded its own field first: the row's arrival SWEPT it (c=1); n01 and n03 refused it on arrival (c=0)
  assert.deepEqual(nodes[1].journal.read().filter((e) => e.kind === JK.subsumed).map((e) => [e.a, e.b, e.c]), [['n02', 1, 1]])
  assert.deepEqual(nodes[0].journal.read().filter((e) => e.kind === JK.subsumed).map((e) => [e.a, e.b, e.c]), [['n02', 1, 0]])
  //! and a field write NEWER than the row shows on top everywhere — the other half of the rule
  sim.post('n03', { kind: 'write', recs: [{ type: REC.update, key: ['g', 'stock'], value: 11 }] }, 1)
  sim.run()
  assert.equal(converged(sim), null)
  for (const n of nodes) {
    assert.deepEqual(n.state.get(key('g')), { stock: 3 })
    assert.equal(n.state.get(key('g', 'stock')), 11, `${n.uuid} shows the newer field on top`)
  }
})

test('the probe with a REMOVE: a field remove newer than a row write — every node shows the row without that field, whichever arrived first', () => {
  const sim = new Sim(1801)
  const nodes = cluster(sim, 3)
  //! n01's row reaches n02 at once and n03 late; n02's remove (stamped after it saw the row: newer) reaches
  // n03 first. So n01 and n02 fold row-then-remove, n03 folds remove-then-row.
  sim.fault('n01', 'n03', { delay: [60, 61] })
  sim.fault('n02', 'n03', { delay: [1, 2] })
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['g'], value: { a: 1, b: 2 } }] }, 1)
  sim.post('n02', { kind: 'write', recs: [{ type: REC.remove, key: ['g', 'a'] }] }, 30)
  sim.run()
  assert.ok(formed(nodes) && sim.quiesced)
  assert.equal(converged(sim), null)
  for (const n of nodes) {
    assert.deepEqual(n.state.get(key('g')), { a: 1, b: 2 }, `${n.uuid} holds the row cell whole`)
    assert.deepEqual(sim.folds.get(n.uuid), { g: { b: 2 } }, `${n.uuid}'s screen shows the row without the removed field`)
  }
})

//! cellsPlan — a workload built for THIS rule: a few rows, written whole, by field and two levels down,
// removed whole, by field and two levels down. (writesPlan's draw order is pinned by the shrinker's
// golden, so the field removes and the depth-3 keys live here, not there.)
const cellsPlan = (rng: () => number, uuids: string[], count: number): { at: number; uuid: string; recs: Rec[] }[] => {
  const out: { at: number; uuid: string; recs: Rec[] }[] = []
  for (let i = 0; i < count; i++) {
    const uuid = uuids[Math.floor(rng() * uuids.length)]
    const row = 'r' + Math.floor(rng() * 3)
    const f = 'f' + Math.floor(rng() * 2)
    const roll = rng()
    const key = roll < 0.4 ? [row] : roll < 0.8 ? [row, f] : [row, f, 'x']
    const rec: Rec = rng() < 0.3 ? { type: REC.remove, key } : { type: REC.update, key, value: key.length === 1 ? { f0: i, f1: { x: i } } : key.length === 2 ? { x: i } : i }
    out.push({ at: 1 + rng() * 300, uuid, recs: [rec] })
  }
  return out
}

test('the sweep with removes and three levels: 100 seeds of row/field/deep writes and removes under delay, duplication and a partition window — one object everywhere, and the screen equals the kernel', () => {
  const failures: string[] = []
  for (let seed = 0; seed < 100; seed++) {
    try {
      const sim = new Sim(2000 + seed)
      const nodes = cluster(sim, 3)
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
      for (const s of cellsPlan(sim.rng, nodes.map((n) => n.uuid), 40)) sim.post(s.uuid, { kind: 'write', recs: s.recs }, s.at)
      if (seed % 2) {
        const a = nodes[Math.floor(sim.rng() * 3)].uuid
        let b = a
        while (b === a) b = nodes[Math.floor(sim.rng() * 3)].uuid
        const cut = 20 + sim.rng() * 150
        sim.at(cut, () => sim.partition(a, b))
        sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
      }
      const violations = sim.run()
      const bad =
        (violations.length && `monitor ${violations[0].monitor}: ${violations[0].detail}`) ||
        (!formed(nodes) && 'never formed') ||
        (!sim.quiesced && 'never quiesced') ||
        converged(sim) ||
        drained(sim)
      if (bad) failures.push(`seed ${2000 + seed}: ${bad}`)
    } catch (e) {
      failures.push(`seed ${2000 + seed}: threw ${e}`)
    }
  }
  assert.deepEqual(failures, [], `${failures.length} seeds failed the object oracle:\n${failures.join('\n')}`)
})

test('the sweep: 120 seeds of mixed row/field/remove writes racing formation under delay, duplication and a partition window — one object everywhere', () => {
  const failures: string[] = []
  for (let seed = 0; seed < 120; seed++) {
    try {
      const sim = new Sim(1000 + seed)
      const nodes = cluster(sim, 3)
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
          sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 1 + sim.rng() * 25], dupP: sim.rng() * 0.25 })
      writes(sim, nodes, 40)
      if (seed % 2) {
        const a = nodes[Math.floor(sim.rng() * 3)].uuid
        let b = a
        while (b === a) b = nodes[Math.floor(sim.rng() * 3)].uuid
        const cut = 20 + sim.rng() * 150
        sim.at(cut, () => sim.partition(a, b))
        sim.at(cut + 30 + sim.rng() * 250, () => sim.heal(a, b))
      }
      const violations = sim.run()
      const bad =
        (violations.length && `monitor ${violations[0].monitor}: ${violations[0].detail}`) ||
        (!formed(nodes) && 'never formed') ||
        (!sim.quiesced && 'never quiesced') ||
        converged(sim) ||
        drained(sim)
      if (bad) failures.push(`seed ${1000 + seed}: ${bad}`)
    } catch (e) {
      failures.push(`seed ${1000 + seed}: threw ${e}`)
    }
  }
  assert.deepEqual(failures, [], `${failures.length} seeds failed the object oracle:\n${failures.join('\n')}`)
})
