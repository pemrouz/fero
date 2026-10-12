//! Perf sibling of kernel/log.ts — the cost of a compaction pass on a SCOPED node (DESIGN-SCALE stage 3, §8
// "compact.perf"). The unscoped pass walks a lane once with one JSON.stringify and one versions lookup per entry.
// The armed pass (compactScoped) adds one partitionOf per entry, one Map.get for the partition's memoized frontier,
// and one scopedFrontier per (lane, partition) per pass — a ring walk over R holders and R mark lookups. So the
// per-entry cost is the unscoped pass plus a few field reads: the pin is a RATIO in one process (the WSL2 rule:
// never an absolute number), on the storage critique's shape — a 100,000-winner lane whose pass drops nothing, the
// walk the memo exists to avoid repeating (kernel/log.ts maybeCompact).
//
// Measured 2026-10-12 on this box (tmpfs worktree, low priority): see the commit body.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { compact, compactScoped, frontier, scopedFrontier } from './log.ts'
import { VERB, encodeControl } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { ratio } from '#utils'

const PARTS = 500, PER = 200 // 100,000 distinct cells on one lane: every entry its cell's winner

//! formed — aa at committed view 1 over {aa, bb, cc}, bb and cc admitted; scoped (replicas 2) or not
const formed = (replicas?: number): Node => {
  const sink: Env['sink'] = { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} }
  const members: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  const node = new Node({ uuid: 'aa', listen: 'sim:aa', heartbeatMs: 50, ...(replicas ? { replicas, tune: { aeFan: 0 } } : {}), boot: { epoch: 1, members } }, { now: () => 0, rng: () => 0, sink })
  node.step({ kind: 'start' })
  for (const [link, u] of [[1, 'bb'], [2, 'cc']] as const) {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: members }) })
  node.membership.rejoinFloor = 0
  assert.equal(node.epoch, 1)
  return node
}

//! fill — PARTS partitions of PER field writes each, owned by aa with bb as the co-holder; then bb attests every
// partition at the lane's tail (armed: HAVEQ marks; unscoped: a digest), so the frontier is the tail everywhere
const fill = (node: Node) => {
  for (let p = 0; p < PARTS; p++) {
    node.writes.ring.place('p' + p, 'aa', 'bb') // both nodes route by owner at epoch 1: pin every partition on aa
    const recs: Rec[] = []
    for (let j = 0; j < PER; j++) recs.push({ type: REC.update, key: ['p' + p, 'f' + j], value: j })
    node.step({ kind: 'write', recs })
  }
  const tail = node.logs.get('aa')!.at(-1)!.seq
  if (node.armed) {
    //! bb attests each partition at ITS last record on lane aa (p0's is PER, the last of its 200; the last partition's
    // is the lane tail): a mark above the owner's own floor for a partition would read as "aa is behind" and open a
    // latch, which pins that partition (C1). So every entry of every partition sits at or under its frontier and each
    // one is winner-checked — the walk the pin times.
    const q: Record<string, Record<string, number>> = {}
    for (let p = 0; p < PARTS; p++) q['p' + p] = { aa: (p + 1) * PER }
    node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q }) })
    assert.equal(scopedFrontier(node, 'aa', 'p0'), PER, 'the frontier for p0 is its last record')
    assert.equal(scopedFrontier(node, 'aa', 'p' + (PARTS - 1)), tail, 'and for the last partition the lane tail')
  } else {
    node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: tail }, r: 0 }) })
    node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: tail }, r: 0 }) })
    assert.equal(frontier(node, 'aa'), tail)
  }
  assert.equal(node.logs.get('aa')!.length, PARTS * PER)
}

test('compact.perf — a scoped pass over a 100,000-winner lane that drops nothing costs at most 2x the unscoped pass over the same lane (interleaved, median of 7), and under 5 µs per entry here', () => {
  const armed = formed(2)
  fill(armed)
  const plain = formed()
  fill(plain)
  const f = frontier(plain, 'aa')
  let dropped = 0
  const r = ratio.interleaved(() => { dropped += compact(plain, 'aa', f) }, () => { dropped += compactScoped(armed, 'aa') })
  assert.equal(dropped, 0, 'every entry is its cell\'s winner: both passes walk everything and drop nothing')
  const t0 = performance.now(); compactScoped(armed, 'aa'); const us = (performance.now() - t0) * 1000 / (PARTS * PER)
  console.log(`  compact.perf: armed/unscoped pass ratio ${r.toFixed(2)} over ${PARTS * PER} winners (${us.toFixed(2)} µs per entry armed, one pass)`)
  assert.ok(r <= 2, `the scoped pass costs ${r.toFixed(2)}x the unscoped pass — more than the few field reads it adds`)
  assert.ok(us < 5, `${us.toFixed(2)} µs per entry: the pass re-walks a winner-heavy lane far too slowly`)
})
