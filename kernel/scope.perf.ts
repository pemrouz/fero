//! Perf sibling of kernel/scope.ts — the hand-over cost under scoping (DESIGN-SCALE stage 1, pin R1).
// A teach (the one-teacher transfer of one partition) used to walk every lane of the node and filter
// each entry by partition: O(entries of the node) per partition handed over, so a 200,000-entry node
// paid 200x a 1,000-entry node to ship the same 1,000-entry partition. Through the per-partition index
// (node.byPart) the walk is O(entries of p). The pin is a RATIO in one process (the WSL2 rule: never an
// absolute number): the same partition taught from the big node and from the small one.
//
// Measured 2026-10-09 on this box (tmpfs worktree, low priority): big/small = see the commit body.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { VERB, encodeControl } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { bench } from '#utils'

//! an armed owner at committed view 1 over {aa, bb, cc}, replicas 2, bb and cc admitted — the
// kernel/scoped.test.ts armedView1 shape, with a sink that discards every frame
const armed = (): Node => {
  const sink: Env['sink'] = { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} }
  const node = new Node({ uuid: 'aa', listen: 'sim:aa', heartbeatMs: 50, replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } }, { now: () => 0, rng: () => 0, sink })
  node.step({ kind: 'start' })
  for (const [link, u] of [[1, 'bb'], [2, 'cc']] as const) {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  node.membership.rejoinFloor = 0
  assert.equal(node.armed, true)
  return node
}

//! fill — `parts` partitions of `per` field writes each, owned by aa with cc as the co-holder (every
// commit stays local and lands in aa's own lane: one lane of parts × per entries)
const fill = (node: Node, parts: number, per: number) => {
  const batch = 500
  for (let p = 0; p < parts; p++) {
    node.writes.ring.place('p' + p, 'aa', 'cc')
    for (let i = 0; i < per; i += batch) {
      const recs: Rec[] = []
      for (let j = i; j < Math.min(per, i + batch); j++) recs.push({ type: REC.update, key: ['p' + p, 'f' + j], value: j })
      node.step({ kind: 'write', recs })
    }
  }
}

test('R1 teach cost: shipping a 1,000-entry partition from a 200,000-entry node costs at most 2x the same partition from a 1,000-entry node', () => {
  const big = armed()
  fill(big, 200, 1000)
  assert.equal(big.logs.get('aa')!.length, 200_000)
  const small = armed()
  fill(small, 1, 1000)
  assert.equal(small.logs.get('aa')!.length, 1000)
  //! bb asks to be taught p0 from zero: HAVEA need=1 with empty marks — the teacher ships p0's 1,000 entries.
  // The two nodes are timed INTERLEAVED (big, small, big, small, …, median of five each, one untimed warmup
  // each — bench.time's discipline), so a GC pause or a neighbour's load lands on both alike instead of on
  // whichever ran second (the stage-1 skeptic measured 1.64 with the runs back to back, 0.98 when alone).
  const need = encodeControl(VERB.HAVEA, { e: 1, a: { p0: { ok: 0, need: 1, m: {} } } })
  const teach = (n: Node) => { n.step({ kind: 'bytesIn', link: 1, bytes: need }) }
  const once = (n: Node) => { const t0 = performance.now(); teach(n); return performance.now() - t0 }
  teach(big); teach(small)
  const bigs: number[] = [], smalls: number[] = []
  for (let i = 0; i < 5; i++) { bigs.push(once(big)); smalls.push(once(small)) }
  const tBig = bench.median(bigs), tSmall = bench.median(smalls)
  const r = tBig / Math.max(tSmall, 1e-3)
  console.log(`  R1 teach p0 (1,000 entries): big node ${tBig.toFixed(2)} ms, small node ${tSmall.toFixed(2)} ms, ratio ${r.toFixed(2)}`)
  assert.ok(r <= 2, `teach cost ratio ${r.toFixed(2)} > 2x — the hand-over walks the whole node again`)
})
