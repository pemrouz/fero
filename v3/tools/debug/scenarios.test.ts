//! Scenario-registry suite: the dashboard's data source runs green, its captures replay-verify, and the
// /scenarios.json contract holds. One runAll() shared by the suite — every scenario is virtual-time, so
// the whole registry (sweep included) costs ~2s and stays deterministic.

import { test } from 'node:test'
import assert from 'node:assert'
import { runAll, SCENARIOS } from './scenarios.ts'
import { verifyReplay, contested } from './model.mjs'

const { results, captures } = runAll()

test('every scenario in the registry passes', () => {
  for (const s of results.scenarios) assert.ok(s.pass, `${s.id}: ${s.notes}`)
  assert.equal(results.pass, results.total)
  assert.equal(results.total, SCENARIOS.length)
})

test('the /scenarios.json contract holds (the dashboard renders EXACTLY these shapes)', () => {
  assert.ok(typeof results.rev === 'string' && results.when && results.wallMs >= 0)
  assert.ok(results.baseline === null || (results.baseline.rev && results.baseline.when))
  for (const s of results.scenarios) {
    assert.ok(s.id && s.title && s.desc, s.id)
    assert.ok(['happy', 'unhappy', 'meta'].includes(s.kind), `${s.id}: kind ${s.kind}`)
    assert.ok(Array.isArray(s.diagram.nodes) && s.diagram.nodes.length >= 2, `${s.id}: diagram nodes`)
    assert.ok(s.diagram.phases.length >= 3, `${s.id}: diagram phases`)
    for (const m of s.metrics) {
      assert.ok(['count', 'ms', 'text'].includes(m.kind), `${s.id}/${m.k}: kind ${m.kind}`)
      if (m.kind === 'count') assert.equal(typeof m.v, 'number', `${s.id}/${m.k}: count must be numeric`)
    }
    assert.ok(s.metrics.some((m) => m.k === 'wall ms'), `${s.id}: wall ms appended`)
    assert.ok(s.base === null || typeof s.base === 'object', `${s.id}: base`)
  }
})

test('every scenario capture is click-through-able AND replay-verifies (the debugger opens truth)', () => {
  for (const s of results.scenarios) {
    const cap = captures.get(s.id)
    assert.ok(cap, `${s.id}: no capture for the dashboard click-through`)
    for (const r of verifyReplay(cap)) assert.ok(r.ok, `${s.id}/${r.uuid}: ${r.reason}`)
  }
})

test('conflict semantics on the dashboard are honest: single-writer path 0 contested, deliberate race exactly 4', () => {
  assert.equal(contested(captures.get('replication')).length, 0, 'owner-routed workload must show zero contention')
  assert.equal(contested(captures.get('conflict')).length, 4, 'the conflict scenario contests exactly its 4 keys')
})
