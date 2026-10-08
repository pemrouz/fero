//! The tune table (kernel/tune.ts): the defaults are the old constants by name, a node's table is
// frozen, an override lands only on its row, and a bad override fails closed in the constructor.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node, MAX_REDIALS, MEMBER_REDIALS, LAMPORT_LEASE, SNAPSHOT_AT } from './node.ts'
import { TUNE, tuneOf, type Tune } from './tune.ts'
import { SUSPECT_TICKS, MAX_PULLS, PROPOSAL_AGE, REJOIN_TICKS, LEAVE_TICKS } from './membership.ts'
import { MAX_PENDING, RETRY_TICKS, DEDUP_KEEP, MAX_ISSUERS } from './write.ts'
import { MAX_PROBES } from './confirm.ts'
import { MAX_QUEUED } from './link.ts'
import { COMPACT_AT } from './log.ts'
import { SHED_TICKS, STAGE_TICKS, ACQ_LIVE_MAX, STALL_AT } from './scope.ts'
import type { EffectSink, Env } from './env.ts'

const env = (): Env => {
  const sink = {
    connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {},
    confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {},
  } as unknown as EffectSink
  return { now: () => 0, rng: () => 0, sink }
}

test('TUNE is the old constants by name, and a node with no tune reads exactly them', () => {
  assert.deepEqual(TUNE, {
    redials: MAX_REDIALS, memberRedials: MEMBER_REDIALS, redialGrowth: 2, redialCap: 32,
    suspectTicks: SUSPECT_TICKS, leaveTicks: LEAVE_TICKS, pulls: MAX_PULLS, proposalAge: PROPOSAL_AGE, rejoinTicks: REJOIN_TICKS,
    retryTicks: RETRY_TICKS, pending: MAX_PENDING, dedupKeep: DEDUP_KEEP, issuers: MAX_ISSUERS,
    probes: MAX_PROBES, queued: MAX_QUEUED, compactAt: COMPACT_AT, snapshotAt: SNAPSHOT_AT, lamportLease: LAMPORT_LEASE,
    shedTicks: SHED_TICKS, stageTicks: STAGE_TICKS, acqLiveMax: ACQ_LIVE_MAX, stallAt: STALL_AT,
  })
  //! the values the plan's table lists — a changed default is a DECISIONS line, not a drift
  assert.deepEqual(
    [TUNE.redials, TUNE.memberRedials, TUNE.suspectTicks, TUNE.leaveTicks, TUNE.pulls, TUNE.proposalAge, TUNE.rejoinTicks, TUNE.retryTicks, TUNE.pending, TUNE.dedupKeep, TUNE.issuers, TUNE.probes, TUNE.queued, TUNE.compactAt, TUNE.snapshotAt, TUNE.lamportLease, TUNE.shedTicks, TUNE.stageTicks, TUNE.acqLiveMax, TUNE.stallAt],
    [10, 5, 3, 4, 5, 10, 10, 2, 1024, 1024, 1024, 1024, 256, 4096, 4096, 4096, 2, 8, 8192, 8],
  )
  const node = new Node({ uuid: 'aa' }, env())
  assert.strictEqual(node.tune, TUNE, 'no overrides ⇒ the shared frozen table itself, nothing allocated')
  assert.ok(Object.isFrozen(node.tune))
  assert.ok(Object.isFrozen(TUNE))
})

test('an override lands on its row only; the table is frozen; TUNE is untouched', () => {
  const node = new Node({ uuid: 'aa', tune: { redials: 2, pending: 8 } }, env())
  assert.equal(node.tune.redials, 2)
  assert.equal(node.tune.pending, 8)
  assert.equal(node.tune.suspectTicks, SUSPECT_TICKS)
  assert.ok(Object.isFrozen(node.tune))
  assert.throws(() => { (node.tune as { redials: number }).redials = 99 }, TypeError)
  assert.equal(TUNE.redials, MAX_REDIALS, 'the defaults never move')
  assert.notStrictEqual(node.tune, TUNE)
})

test('a bad override fails closed in the constructor: unknown row, a fraction, a negative, a string, a non-object', () => {
  assert.throws(() => new Node({ uuid: 'aa', tune: { redialz: 3 } as never }, env()), /unknown row 'redialz'/)
  assert.throws(() => new Node({ uuid: 'aa', tune: { redials: 1.5 } }, env()), /redials must be an integer ≥ 0, got 1.5/)
  assert.throws(() => new Node({ uuid: 'aa', tune: { pending: -1 } }, env()), /pending must be an integer ≥ 1/)
  assert.throws(() => new Node({ uuid: 'aa', tune: { pending: '8' as never } }, env()), /pending must be an integer ≥ 1, got 8/)
  assert.throws(() => new Node({ uuid: 'aa', tune: [] as never }, env()), /tune must be an object/)
  assert.throws(() => tuneOf({ constructor: 1 } as never), /unknown row 'constructor'/)
  //! an explicit undefined is "not given", like an absent key
  assert.strictEqual(tuneOf({ redials: undefined }).redials, MAX_REDIALS)
})

test('zero: allowed for the two redial counts (no redial at all), refused for every other row — a 0 there would switch a guarantee off, not tune it', () => {
  assert.equal(tuneOf({ redials: 0 }).redials, 0)
  assert.equal(tuneOf({ memberRedials: 0 }).memberRedials, 0)
  for (const k of Object.keys(TUNE) as (keyof Tune)[]) {
    if (k === 'redials' || k === 'memberRedials') continue
    assert.throws(() => tuneOf({ [k]: 0 }), new RegExp(`${k} must be an integer ≥ 1, got 0`), k)
    assert.equal(tuneOf({ [k]: 1 })[k], 1, `${k}: 1 is the floor`)
  }
})
