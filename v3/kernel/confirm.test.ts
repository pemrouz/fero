//! Tier-1 confirm suite (M4c): the guarantee ladder driven with hand-crafted digests against a
// recording sink. Pins: evidence is the WATERMARK LADDER and never `applied` (v2's recvReplProbe
// false positive stays unwritable), the majority thresholds per level, solo semantics at open
// genesis, the view-change recount, digest-fed peer evidence (d = shippable, p = durable), cancel as
// an honest reject, and the bounded registry. sim/durability.test.ts proves the ladder end-to-end
// under heartbeats, disk faults, and restarts.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { CONFIRM, MAX_PROBES } from './confirm.ts'
import { JK } from './journal.ts'
import { VERB, encodeControl } from './codec.ts'
import { REC, TAG, type EffectSink, type Env } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: () => {}, send: () => {}, close: () => {}, cancel: () => {}, apply: () => {},
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    persist: (batch, bytes, prev) => effects.push(['persist', batch, bytes, prev]),
    boot: () => {},
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, durable: true, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  const answers = () => of('confirm').map((e) => ({ id: e[1] as number, ok: e[2] as boolean, count: e[3] as number }))
  return { node, effects, of, tick, admit, answers }
}

//! aa at committed view 1 over {aa, bb, cc}
const formedView1 = () => {
  const h = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.tick()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  assert.equal(h.node.epoch, 1)
  return h
}

test('open genesis is SOLO semantics: replicated resolves on own shippable, persisted only on own durable', () => {
  const h = harness('aa')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  h.node.step({ kind: 'confirm', id: 1, origin: 'aa', seq: 1, level: CONFIRM.replicated })
  assert.deepEqual(h.answers(), [{ id: 1, ok: true, count: 1 }], 'shippable at the stamp site — replicated (solo) immediately')
  h.node.step({ kind: 'confirm', id: 2, origin: 'aa', seq: 1, level: CONFIRM.persisted })
  assert.equal(h.answers().length, 1, 'persisted WAITS: the batch has not resolved')
  const batch = h.of('persist')[0][1] as number
  h.node.step({ kind: 'persisted', batch })
  assert.deepEqual(h.answers()[1], { id: 2, ok: true, count: 1 }, 'the fsync echo is the ONLY persisted evidence')
})

test('replicated needs a MAJORITY of the committed view shippable — self + one digest of three', () => {
  const h = formedView1()
  h.node.writes.ring.place('k', 'aa') // pin: the write must commit HERE for own evidence to exist
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const seq = h.node.seq
  h.node.step({ kind: 'confirm', id: 7, origin: 'aa', seq, level: CONFIRM.replicated })
  assert.equal(h.answers().length, 0, '1 of 3 is not a majority — the probe waits')
  //! bb's digest announces it holds our stream through seq — the second head of the quorum
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: seq }, r: 0 }) })
  assert.deepEqual(h.answers(), [{ id: 7, ok: true, count: 2 }])
})

test('persisted needs a majority DURABLE — shippable digests do not count, and applied is never evidence', () => {
  const h = formedView1()
  h.node.writes.ring.place('k', 'aa') // pin: the write must commit HERE for own evidence to exist
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const seq = h.node.seq
  const batch = h.of('persist')[0][1] as number
  h.node.step({ kind: 'persisted', batch }) // own durable ✓ (1 of 3)
  h.node.step({ kind: 'confirm', id: 9, origin: 'aa', seq, level: CONFIRM.persisted })
  //! bb announces SHIPPABLE possession only (no p map) — must not advance the persisted quorum
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: seq }, r: 0 }) })
  assert.equal(h.answers().length, 0, 'shippable evidence cannot answer a persisted probe')
  //! cc announces DURABLE possession (the p map) — 2 of 3
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: seq }, r: 0, p: { aa: seq } }) })
  assert.deepEqual(h.answers(), [{ id: 9, ok: true, count: 2 }])
})

test('the view-change recount: a shrunk view lowers the bar and resolves a stalled probe', () => {
  const h = formedView1()
  h.node.writes.ring.place('k', 'aa') // pin: the write must commit HERE for own evidence to exist
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const seq = h.node.seq
  h.node.step({ kind: 'confirm', id: 3, origin: 'aa', seq, level: CONFIRM.replicated })
  assert.equal(h.answers().length, 0, '1 of 3 — waiting')
  //! the view shrinks to {aa, bb}: 1 of 2 is still not a majority… then bb's evidence lands: 2 of 2
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.answers().length, 0)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: seq }, r: 0 }) })
  assert.deepEqual(h.answers(), [{ id: 3, ok: true, count: 2 }])
})

test('cancel is an honest reject: false, with the count reached; the registry is bounded drop-oldest', () => {
  const h = formedView1()
  h.node.writes.ring.place('k', 'aa') // pin: the write must commit HERE for own evidence to exist
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  h.node.step({ kind: 'confirm', id: 4, origin: 'aa', seq: h.node.seq, level: CONFIRM.persisted })
  h.node.step({ kind: 'confirmCancel', id: 4 })
  assert.deepEqual(h.answers(), [{ id: 4, ok: false, count: 0 }], 'the embedder deadline fired — reject with evidence count')
  assert.ok(h.node.journal.read().some((e) => e.kind === JK.confirmed && e.b === 0))
  //! overflow: MAX_PROBES+1 unresolvable probes — the oldest answers false (surfaced), never silent growth
  for (let i = 0; i < MAX_PROBES + 1; i++)
    h.node.step({ kind: 'confirm', id: 100 + i, origin: 'zz', seq: 1e9, level: CONFIRM.persisted })
  const rejected = h.answers().filter((a) => !a.ok)
  assert.equal(rejected.length, 2, 'the cancel + exactly one overflow eviction')
  assert.equal(rejected[1].id, 100, 'drop-OLDEST')
})
