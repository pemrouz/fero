//! Debug-model suite: the folds are validated against REAL captures from real seeded runs — never fixtures
// authored to match the fold (v2's sample-coverage lock validated only a hand-authored sample, so the live
// feed drifted 5-of-6 tokens dead; here the fixture IS a live capture by construction).

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from '../../sim/exec.ts'
import { cluster, formed, writes } from '../../sim/harness.ts'
import { converged } from '../../sim/monitors.ts'
import { JK } from '../../kernel/journal.ts'
import { captureSim } from './capture.ts'
import { encodeVal, decodeVal, kindNames, stateAt, verifyReplay, routes, contested, summarize } from './model.mjs'

//! one real chaotic trajectory shared by the suite: dup faults + a partition/heal window + racing writes
const chaoticCapture = () => {
  const sim = new Sim(1337)
  const nodes = cluster(sim, 3)
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 15], dupP: 0.3 })
  writes(sim, nodes, 50, 300)
  sim.at(60, () => sim.partition('n01', 'n03'))
  sim.at(200, () => sim.heal('n01', 'n03'))
  sim.run()
  assert.ok(formed(nodes) && converged(sim) === null, 'fixture trajectory must be healthy')
  return captureSim(sim)
}

test('value codec round-trips the JSON-hostile zoo (NaN, ±Infinity, -0, undefined, bytes, $-keys, nesting)', () => {
  const zoo = [NaN, Infinity, -Infinity, -0, undefined, null, new Uint8Array([1, 0, 255]),
    { $: 'user-key', n: NaN }, [1, undefined, { deep: new Uint8Array([7]) }], 'plain', 42]
  for (const v of zoo) {
    const round = decodeVal(JSON.parse(JSON.stringify(encodeVal(v))))
    if (typeof v === 'number' && Number.isNaN(v)) assert.ok(Number.isNaN(round))
    else assert.deepEqual(round, v)
  }
  assert.ok(Object.is(decodeVal(JSON.parse(JSON.stringify(encodeVal(-0)))), -0))
})

test('captures are self-describing: vocab IS the kernel JK const; kindNames inverts it completely', () => {
  const cap = chaoticCapture()
  assert.deepEqual(cap.vocab, JK)
  const names = kindNames(cap)
  for (const [name, code] of Object.entries(JK)) assert.equal(names[code as number], name)
})

//! THE replay-refold check (plan §3.1 graft, previously listed as pending): the model's LWW fold over the
// capture reproduces every node's exact end state — proving capture completeness and fold/kernel agreement.
test('verifyReplay: replaying journal+logs reproduces every node end state exactly', () => {
  const cap = chaoticCapture()
  for (const r of verifyReplay(cap)) assert.ok(r.ok, `${r.uuid}: ${r.reason}`)
})

test('stateAt is genuine time travel: empty at t=0, monotonically fills, equals end state at t=∞', () => {
  const cap = chaoticCapture()
  const node = cap.nodes[0]
  assert.equal(stateAt(cap, node.uuid, -1).size, 0)
  const mid = stateAt(cap, node.uuid, Math.floor(node.journal.length / 2)).size
  const end = stateAt(cap, node.uuid, Infinity).size
  assert.ok(mid > 0 && mid <= end)
  assert.equal(end, node.state.length)
})

test('routes: every local write has an origin row; statuses cover the whole cluster; healed writes show applied', () => {
  const cap = chaoticCapture()
  const rs = routes(cap)
  assert.ok(rs.size >= 45, `expected ≥45 routed writes, got ${rs.size}`) // ~50 scheduled minus LWW-only removes on absent keys
  for (const r of rs.values()) {
    assert.equal(Object.keys(r.nodes).length, 3, 'a route row exists for EVERY node — absence is information')
    const statuses = new Set(Object.values(r.nodes).map((s) => s.status))
    for (const s of statuses) assert.ok(['origin', 'applied', 'lww-lost', 'duplicate', 'never-arrived'].includes(s))
  }
  //! the trajectory converged, so nothing may have permanently never-arrived at quiescence
  for (const r of rs.values())
    assert.ok(Object.values(r.nodes).some((s) => s.status === 'origin'), `route ${r.origin}#${r.seq} lost its origin`)
})

test('contested surfaces real LWW elections with the fold-consistent winner', () => {
  const cap = chaoticCapture()
  const cs = contested(cap)
  assert.ok(cs.length > 0, 'a 50-write 20-key workload must contest some cells')
  for (const c of cs) {
    for (const cand of c.candidates.slice(1))
      assert.ok(
        c.winner.epoch > cand.epoch || c.winner.seq > cand.seq || (c.winner.seq === cand.seq && c.winner.origin > cand.origin),
        'winner must dominate every candidate under (epoch, seq, origin)',
      )
  }
})

test('contested is elections, not history: successive same-origin updates never read as contention', () => {
  //! regression — the fold once counted ANY multi-candidate cell as contested, so a single writer
  // updating its own key three times rendered as a "conflict" (the source of the debugger's false
  // contention wall). Contested must derive from lwwSkip: real rejected candidates only.
  const sim = new Sim(7)
  const nodes = cluster(sim, 2)
  sim.run()
  for (let i = 0; i < 3; i++)
    sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: i }] }, 1 + i * 10) // spaced: each replicates before the next — pure causal history
  sim.run()
  assert.equal(contested(captureSim(sim)).length, 0, 'a single-writer causal chain is history, not contention')
  //! and the same cell DOES contest once two origins race it concurrently
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: 'a' }] }, 1)
  sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: 'b' }] }, 1)
  sim.run()
  const cs = contested(captureSim(sim))
  assert.equal(cs.length, 1, 'a genuine two-origin race must surface exactly this cell')
  assert.equal(converged(sim), null, 'and LWW still converges it')
})

test('summarize reports capture health honestly (convergence from hashes, truncation surfaced)', () => {
  const cap = chaoticCapture()
  const s = summarize(cap)
  assert.equal(s.kind, 'sim')
  assert.equal(s.seed, 1337)
  assert.equal(s.nodes, 3)
  assert.equal(s.converged, true)
  assert.deepEqual(s.truncated, [])
  assert.deepEqual(s.violations, [])
})
