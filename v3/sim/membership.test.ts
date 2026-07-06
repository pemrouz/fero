//! Tier-2 membership suite: views, ballots, and the write-gate END-TO-END under real partitions —
// the M2 build-order exit criteria (eviction through the REAL propose path under simulated partition;
// the V1d divergence class reproduced against a deliberately-broken build, then green). Heartbeats
// drive membership, so nothing here quiesces: every phase runs to a virtual-time bound, and the
// per-event monitors (one-view-per-epoch, epoch-monotone) run throughout.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed } from './harness.ts'
import { converged } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { LS } from '../kernel/link.ts'
import type { Node } from '../kernel/node.ts'
import type { Rec } from '../kernel/env.ts'

const epochs = (nodes: Node[]) => nodes.map((n) => n.epoch)
const members = (n: Node) => n.membership.view.members.map((m) => m[0])

test('genesis: a formed open mesh commits view 1 by ballot everywhere; writes flow; monitors quiet', () => {
  const sim = new Sim(51)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  assert.ok(formed(nodes))
  assert.deepEqual(epochs(nodes), [1, 1, 1], 'every node installed the genesis view')
  for (const n of nodes) assert.deepEqual(members(n), ['n01', 'n02', 'n03'])
  sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['hello'], value: 'm2' }] })
  sim.run({ until: 600 })
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [])
})

test('eviction through the REAL propose path under partition; CP minority buffers; heal → rejoin → flush → converge', () => {
  const sim = new Sim(52)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  assert.deepEqual(epochs(nodes), [1, 1, 1])

  //! cut n03 off completely: n01+n02 keep majority; suspicion fires in 3 ticks, but eviction WAITS for
  // the dial chain to exhaust (the dialing-hold) — "gone" means every redial failed, not "one tick late"
  sim.partition('n01', 'n03')
  sim.partition('n02', 'n03')
  sim.run({ until: 1000 })
  assert.deepEqual(epochs(nodes), [1, 1, 1], 'suspect but still dialing — no eviction ballot yet')
  assert.ok(nodes[0].journal.read().some((e) => e.kind === JK.suspect && e.a === 'n03'))
  sim.run({ until: 5500 }) // the backoff chain gives up (~4s) → the give-up tick proposes → n02 votes → commit
  assert.deepEqual(epochs(nodes).slice(0, 2), [2, 2], 'majority side committed the eviction view after give-up')
  assert.deepEqual(members(nodes[0]), ['n01', 'n02'])
  assert.ok(nodes[0].journal.read().some((e) => e.kind === JK.evict && e.a === 'n03'))
  assert.equal(nodes[2].epoch, 1, 'the cut node still holds the old view — and is gated')

  //! CP: the majority side commits; the minority side BUFFERS (bounded, journal-visible)
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['majority-write'], value: 1 }] })
  sim.post('n03', { kind: 'write', recs: [{ type: 0, key: ['minority-write'], value: 2 }] })
  sim.run({ until: 5700 })
  assert.ok(nodes[0].state.has(JSON.stringify(['majority-write'])))
  assert.ok(!nodes[2].state.has(JSON.stringify(['minority-write'])), 'gated: a minority write must not commit')
  assert.equal(nodes[2].writes.pending.size, 1)
  assert.deepEqual(nodes[2].membership.gate(nodes[2]), { open: false, reason: 'minority' })

  //! heal: view-on-admit tells n03 it was evicted → JOIN → view 3 re-admits it → pending flushes → all converge
  sim.heal('n01', 'n03')
  sim.heal('n02', 'n03')
  sim.run({ until: 9000 })
  assert.deepEqual(epochs(nodes), [3, 3, 3], 'the join ballot committed the re-grown view everywhere')
  for (const n of nodes) assert.deepEqual(members(n), ['n01', 'n02', 'n03'])
  assert.equal(nodes[2].writes.pending.size, 0, 'the parked write flushed (owner-routed) on rejoin')
  assert.equal(converged(sim), null, 'both writes present everywhere')
  assert.ok(nodes[0].state.has(JSON.stringify(['minority-write'])))
  assert.deepEqual(sim.violations, [], 'one-view-per-epoch + epoch-monotone held throughout')
})

test('split-brain is impossible: a 2-2 partition commits NOTHING; both sides buffer; heal flushes both, one view survives', () => {
  const sim = new Sim(53)
  const nodes = cluster(sim, 4, { heartbeatMs: 50 })
  sim.run({ until: 500 })
  assert.deepEqual(epochs(nodes), [1, 1, 1, 1])

  for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.partition(a, b)
  sim.run({ until: 1500 })
  //! neither side reaches a joint majority of the 4-member view: no eviction can commit — ballots make
  // the split SAFE (each side suspects the other, proposes, and stalls at 2 of 4 votes forever)
  assert.deepEqual(epochs(nodes), [1, 1, 1, 1], 'no view committed on either side of the split')
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['left'], value: 'L' }] })
  sim.post('n03', { kind: 'write', recs: [{ type: 0, key: ['right'], value: 'R' }] })
  sim.run({ until: 1700 })
  assert.equal(nodes[0].writes.pending.size, 1, 'left side is a minority — parked')
  assert.equal(nodes[2].writes.pending.size, 1, 'right side is a minority — parked')
  assert.ok(!nodes[0].state.has(JSON.stringify(['left'])))

  for (const a of ['n01', 'n02']) for (const b of ['n03', 'n04']) sim.heal(a, b)
  sim.run({ until: 3500 })
  assert.deepEqual(epochs(nodes), [1, 1, 1, 1], 'suspects returned — every eviction ballot was abandoned, view 1 survives')
  assert.equal(converged(sim), null, 'both buffered writes flushed and replicated')
  assert.ok(nodes[3].state.has(JSON.stringify(['left'])) && nodes[1].state.has(JSON.stringify(['right'])))
  assert.deepEqual(sim.violations, [])
})

test('V1d-class divergence (self-fencing flush) is CAUGHT by the harness; the real kernel does not exhibit it', () => {
  //! v2's V1d shipped a node that fenced its OWN buffered write while peers committed it — a silent
  // permanent state split. The build-order demands this class be reproduced against a deliberately
  // broken build (proving the harness would catch it) and then shown green on the real kernel.
  const run = (mutate: boolean) => {
    const sim = new Sim(54)
    const nodes = cluster(sim, 3, { heartbeatMs: 50 })
    sim.run({ until: 400 })
    //! pin the key's ownership to n03 on EVERY node (identically — the ring determinism contract), so
    // the flush self-commits at n03 instead of forwarding — the mutant's commit path must actually run
    for (const n of nodes) n.writes.ring.place('fenced?', 'n03')
    if (mutate) {
      const n = nodes[2]
      //! the mutant: commit() stamps + logs + broadcasts the record but NEVER applies it locally —
      // v2's V1d self-fencing flush, reproduced at M3's one stamp site
      n.commit = function (this: Node, recs: Rec[]): number {
        const s0 = this.seq + 1
        for (const rec of recs) {
          const seq = ++this.seq
          this.logFor(this.uuid).push({ rec, seq, epoch: this.epoch })
          for (const link of this.links.values())
            if (link.state === LS.admitted && link.synced)
              link.add(rec, { origin: this.uuid, baseSeq: seq, epoch: this.epoch })
        }
        for (const link of this.links.values()) link.flush(this.env.sink, this.journal)
        return s0
      }
    }
    //! force a park-then-flush cycle: cut n03 into a minority, write on it, heal before eviction settles
    sim.partition('n01', 'n03')
    sim.partition('n02', 'n03')
    sim.run({ until: 550 })
    sim.post('n03', { kind: 'write', recs: [{ type: 0, key: ['fenced?'], value: 42 }] })
    sim.run({ until: 600 })
    assert.equal(nodes[2].writes.pending.size, 1, 'gated + parked')
    sim.heal('n01', 'n03')
    sim.heal('n02', 'n03')
    sim.run({ until: 3000 })
    return sim
  }
  const broken = run(true)
  assert.notEqual(converged(broken), null, 'the deliberately-broken build DIVERGES — and the harness sees it')
  const real = run(false)
  assert.equal(converged(real), null, 'the real kernel: same trajectory, no divergence')
  assert.deepEqual(real.violations, [])
})
