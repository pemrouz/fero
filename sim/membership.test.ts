//! Tier-2 membership suite: views, ballots, and the write-gate END-TO-END under real partitions —
// the M2 build-order exit criteria (eviction through the REAL propose path under simulated partition;
// the V1d divergence class reproduced against a deliberately-broken build, then green). Heartbeats
// drive membership, so nothing here quiesces: every phase runs to a virtual-time bound, and the
// per-event monitors (one-view-per-epoch, epoch-monotone) run throughout.

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from './exec.ts'
import { cluster, formed, writes } from './harness.ts'
import { converged, perEvent } from './monitors.ts'
import { JK } from '../kernel/journal.ts'
import { LS } from '../kernel/link.ts'
import { VERB } from '../kernel/codec.ts'
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

test('M4-REVIEW PIN — a burned epoch cannot wedge membership: survivors ESCALATE past spent votes (Raft-term style)', () => {
  //! the permanent-wedge shape (repro'd during the M4 review, made permanent by M4b's durable
  // votedFor): n01 proposes evicting the vanished n03 at epoch 2, n02 durably GRANTS, the VOTE frame
  // dies with the link and n01 vanishes forever — epoch 2 is burned (a majority of view 1 spent
  // there). Pre-fix, every future proposal targeted view.epoch+1 = 2 and was refused by the vote-once
  // rule: a LIVE MAJORITY could never change membership again. The fix: proposals escalate past every
  // known burn (own spent vote + the `ve` a refusal carries), and voters grant any epoch above their
  // committed view — safety still rests on vote-once-per-epoch (the burned majority is exactly what
  // keeps epoch 2 uncommittable by anyone else).
  const sim = new Sim(7)
  const nodes = cluster(sim, 3, { heartbeatMs: 50, durable: true })
  sim.run({ until: 400 })
  assert.deepEqual(epochs(nodes), [1, 1, 1])
  sim.partition('n03', 'n01')
  sim.partition('n03', 'n02')
  sim.severOnFrame('n02', 'n01', 8 /* VERB.VOTE — the grant dies on the wire */)
  let t = 400
  while (sim.nodes.get('n02')!.membership.votedFor.e < 2 && t < 60000) { t += 200; sim.run({ until: t }) }
  assert.equal(sim.nodes.get('n02')!.membership.votedFor.e, 2, 'the vote is durably spent on n01')
  sim.partition('n01', 'n02') // n01 is gone forever, its ballot uncommitted
  sim.heal('n03', 'n02')      // {n02, n03} is a live majority of view 1
  sim.run({ until: t + 25000 })
  const [n02, n03] = [sim.nodes.get('n02')!, sim.nodes.get('n03')!]
  assert.ok(n02.epoch >= 3 && n02.epoch === n03.epoch, `the survivors escalated past the burn (epochs ${n02.epoch}/${n03.epoch})`)
  assert.ok(!members(n02).includes('n01'), 'the vanished proposer was evicted after all')
  assert.ok(n02.membership.gate(n02).open && n03.membership.gate(n03).open, 'writable — never wedged read-only')
  assert.deepEqual(sim.violations, [], 'one-view-per-epoch + epoch-monotone held through the escalation')
})

//! ── I-22 (2026-09-28): a one-sided static pair — `{ listen }` and `{ listen, hosts: [it] }` — must form
// whichever side's uuid sorts lowest. The hostless listener used to need `hosts.length > 0` to propose, so
// when IT was the lowest nobody ever did: epoch 0 forever, no single writer, `confirm: 'replicated'`
// resolving alone. Uuids are random, so half of all such pairs never formed. RED on the old kernel for
// the first order below; the second order is the one that always worked.
test('a one-sided static pair forms in EITHER uuid order: the hostless listener proposes over the members that dialed it', () => {
  for (const [listener, dialer] of [['n01', 'n02'], ['n02', 'n01']] as const) {
    const sim = new Sim(63)
    sim.monitors.push(...perEvent())
    const a = sim.add({ uuid: listener, listen: `sim:${listener}`, heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
    const b = sim.add({ uuid: dialer, listen: `sim:${dialer}`, hosts: [`sim:${listener}`], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
    sim.post(listener, { kind: 'start' })
    sim.post(dialer, { kind: 'start' })
    sim.run({ until: 1000 })
    assert.ok(formed([a, b]), `${listener} listens, ${dialer} dials: linked`)
    assert.deepEqual(epochs([a, b]), [1, 1], `${listener} listens, ${dialer} dials: view 1 committed on both`)
    assert.deepEqual(members(a), ['n01', 'n02'])
    assert.deepEqual(members(b), ['n01', 'n02'])
    assert.ok(a.membership.gate(a).open && b.membership.gate(b).open, 'two of two: writable')
    sim.post(dialer, { kind: 'write', recs: [{ type: 0, key: ['paired'], value: 1 }] })
    sim.run({ until: 1400 })
    assert.equal(converged(sim), null)
    assert.deepEqual(sim.violations, [])
  }
})

test('a hostless listener with no member link still never proposes: a solo `{ listen }` and a server with only clients stay at open genesis', () => {
  const sim = new Sim(63)
  sim.monitors.push(...perEvent())
  const solo = sim.add({ uuid: 'n01', listen: 'sim:n01', heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n01', { kind: 'start' })
  const c = sim.add({ uuid: 'zc1', listen: 'sim:zc1', hosts: ['sim:n01'], heartbeatMs: 50, client: true, redialMs: 20, journalCap: 1 << 16 })
  sim.post('zc1', { kind: 'start' })
  sim.run({ until: 1000 })
  assert.deepEqual(solo.admitted(), ['zc1'], 'the spoke is linked')
  assert.deepEqual(epochs([solo, c]), [0, 0], 'a spoke is not a formation set — epoch 0, the open mode')
  assert.equal(solo.journal.read().filter((e) => e.kind === JK.propose).length, 0)
  assert.deepEqual(sim.violations, [])
})

//! ── the graceful leave (V4-6, 2026-09-07) end-to-end: the two-member story that used to wedge ──

test('graceful leave (V4-6), n=2: the leaver knocks, the survivor proposes the view without it and stays WRITABLE alone; the leaver goes clean; a newcomer then joins the survivor', () => {
  const sim = new Sim(61)
  const nodes = cluster(sim, 2, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  assert.deepEqual(epochs(nodes), [1, 1])
  const [n01, n02] = nodes
  sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['from-the-leaver'], value: 1 }] })
  sim.post('n02', { kind: 'leave' }, 50)
  sim.run({ until: 800 })
  assert.equal(sim.left.get('n02'), true, 'the leaver heard a survivor echo the view without it')
  assert.equal(n01.epoch, 2)
  assert.deepEqual(members(n01), ['n01'])
  assert.ok(n01.membership.gate(n01).open, 'one of one: writable — no wedge')
  assert.ok(n02.journal.read().some((e) => e.kind === JK.left && e.b === 1))
  assert.ok(n01.journal.read().some((e) => e.kind === JK.evict && e.a === 'n02'))
  //! the leaver is torn down (what the shell does on `left`); the survivor keeps committing on its own
  n02.destroy()
  sim.nodes.delete('n02')
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['alone'], value: 1 }] })
  sim.run({ until: 1000 })
  assert.ok(n01.state.has(JSON.stringify(['alone'])), 'a write commits on the one-member view')
  assert.ok(n01.state.has(JSON.stringify(['from-the-leaver'])), 'and what the leaver wrote before going is kept')
  //! a NEW identity joins: view-on-admit → JOIN → the survivor's ballot (old {n01}: itself; new {n01,n03}: both)
  const n03 = sim.add({ uuid: 'n03', listen: 'sim:n03', hosts: ['sim:n01'], heartbeatMs: 50, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n03', { kind: 'start' })
  sim.run({ until: 2500 })
  assert.deepEqual(members(n01), ['n01', 'n03'], 'the newcomer was admitted by ballot')
  assert.equal(n03.epoch, n01.epoch)
  assert.ok(n03.state.has(JSON.stringify(['alone'])) && n03.state.has(JSON.stringify(['from-the-leaver'])), 'and caught up')
  assert.equal(converged(sim), null)
  assert.deepEqual(sim.violations, [], 'one-view-per-epoch + epoch-monotone held throughout')
})

test('graceful leave (V4-6), n=3 under writes: one member leaves mid-stream; the two survivors commit the shrunk view and keep converging; the monitors stay quiet', () => {
  const sim = new Sim(62)
  const nodes = cluster(sim, 3, { heartbeatMs: 50 })
  sim.run({ until: 400 })
  assert.deepEqual(epochs(nodes), [1, 1, 1])
  writes(sim, nodes, 30, 300)
  sim.at(120, () => sim.post('n03', { kind: 'leave' }))
  sim.run({ until: 1500 })
  assert.equal(sim.left.get('n03'), true)
  assert.deepEqual(epochs(nodes).slice(0, 2), [2, 2], 'the survivors committed the shrunk view')
  assert.deepEqual(members(nodes[0]), ['n01', 'n02'])
  assert.ok(nodes[0].membership.gate(nodes[0]).open && nodes[1].membership.gate(nodes[1]).open, 'two of two: writable')
  nodes[2].destroy()
  sim.nodes.delete('n03')
  writes(sim, nodes.slice(0, 2), 20, 200)
  sim.run({ until: 2500 })
  assert.equal(converged(sim), null, 'the survivors agree on everything, including what the leaver wrote before going')
  assert.deepEqual(sim.violations, [])
})

//! ── the V4-6 wedge (2026-09-14): a graceful stop must never leave a two-member survivor holding a member
// that is gone. Before the fix, leave() answered "nothing to leave" at once whenever the leaver held no
// view yet (view.epoch === 0) — but the leaver may already have GRANTED the genesis ballot, and the
// survivor may already have installed the two-member view (its VIEW frame in flight, unread under CPU
// load, or dropped from a paused outbox). The shell tore the node down, exit 0, no LEAVE sent, nothing
// journaled — and the survivor sat at `members 2 writable false` forever: joint consensus needs the old
// majority (both) to shrink the view. Three shapes, all inside that window. RED on the old kernel.
//! the shell's half of a stop: the kernel answers `left`, the shell tears the node down.
const teardownOnLeft = (sim: Sim, n: Node, until: number) => {
  for (let u = sim.now; u <= until; u += 2) {
    sim.run({ until: u })
    if (sim.left.has(n.uuid)) { sim.partition('n01', 'n02'); n.destroy(); sim.nodes.delete(n.uuid); return sim.now }
  }
  return -1
}

test('the leaver has not installed the view yet (the survivor has): the survivor still ends up writable alone', () => {
  const sim = new Sim(61)
  const [n01, n02] = cluster(sim, 2, { heartbeatMs: 50 })
  let t = 0
  while (t < 2000 && !(n01.epoch === 1 && n02.epoch === 0)) { t += 1; sim.run({ until: t }) }
  assert.equal(n01.epoch, 1); assert.equal(n02.epoch, 0)
  sim.post('n02', { kind: 'leave' })
  const torn = teardownOnLeft(sim, n02, sim.now + 5000)
  assert.ok(torn > 0, 'the leave was answered')
  sim.run({ until: sim.now + 5000 })
  assert.deepEqual(members(n01), ['n01'], 'the survivor committed the view without the leaver')
  assert.ok(n01.membership.gate(n01).open, 'and is writable alone')
})

test('the leaver never installed any view (one dropped VIEW frame): same guarantee, 30 seconds later', () => {
  const sim = new Sim(61)
  const [n01, n02] = cluster(sim, 2, { heartbeatMs: 50 })
  const sink = (n01 as unknown as { env: { sink: { send: (l: number, b: Uint8Array) => void } } }).env.sink
  const send = sink.send.bind(sink)
  let dropped = 0
  sink.send = (link: number, bytes: Uint8Array) => { if (bytes[2] === VERB.VIEW && dropped++ === 0) return; send(link, bytes) }
  sim.run({ until: 30000 })
  assert.equal(n01.epoch, 1); assert.equal(n02.epoch, 0, 'the leaver never heard of the view')
  sim.post('n02', { kind: 'leave' })
  const torn = teardownOnLeft(sim, n02, sim.now + 5000)
  assert.ok(torn > 0, 'the leave was answered')
  sim.run({ until: sim.now + 5000 })
  assert.deepEqual(members(n01), ['n01'])
  assert.ok(n01.membership.gate(n01).open)
})

test('a stop BEFORE anything formed never gets voted back in: no view may commit holding the node that left', () => {
  const sim = new Sim(61)
  const [n01, n02] = cluster(sim, 2, { heartbeatMs: 50 })
  sim.post('n02', { kind: 'leave' }, 0)
  sim.run({ until: 20 })
  assert.equal(sim.left.get('n02'), true, 'no links, nothing can hold it: answered at once')
  sim.run({ until: 2000 }) // the teardown hop: the node still steps for a moment
  assert.ok(!members(n01).includes('n02'), 'the survivor never committed a view holding the node that left')
  assert.ok(!members(n02).includes('n02'), 'and the leaver never joined one either')
  sim.partition('n01', 'n02'); n02.destroy(); sim.nodes.delete('n02')
  sim.run({ until: sim.now + 20000 })
  assert.ok(n01.membership.gate(n01).open, 'the survivor is writable, not wedged')
})
