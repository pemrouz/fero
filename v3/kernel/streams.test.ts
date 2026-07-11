//! Streams suite: the descriptor's ladder semantics as driven by the REAL kernel paths — the own-origin
// advance at the stamp site, the inbound advance sites (applied at dedup, shippable at log append), the
// dup/skip behaviour the applied watermark encodes, and durable's pre-M4b zero. The ordering contract
// itself (applied ≥ shippable ≥ durable) is a per-event sim monitor (watermark-ordering); these are the
// unit pins for the advance sites feeding it.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { Streams } from './streams.ts'
import { VERB, encodeControl, encodeFrame } from './codec.ts'
import { REC, type EffectSink, type Env } from './env.ts'

const formed = () => {
  const sink: EffectSink = { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {} }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  return node
}

test('get-or-create: one descriptor per origin, zeroed at birth', () => {
  const s = new Streams()
  const d = s.for('o1')
  assert.deepEqual([d.applied, d.shippable, d.durable], [0, 0, 0])
  assert.equal(s.for('o1'), d, 'same object back — fields, not copies')
  assert.equal(s.get('o2'), undefined)
  assert.equal(s.size, 1)
})

test('the stamp site advances the OWN stream: applied and shippable together, durable untouched (pre-M4b)', () => {
  const node = formed()
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }] })
  const d = node.streams.get('aa')!
  assert.equal(d.applied, node.seq, 'own applied = the Lamport tail')
  assert.equal(d.shippable, node.seq, 'own shippable = logged through the same stamp')
  assert.equal(d.durable, 0, 'durable waits for the M4b storage batch')
})

test('inbound advances applied at the dedup decision and shippable at the log append; dups advance nothing', () => {
  const node = formed()
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame(
    [{ type: REC.update, key: ['x'], value: 1 }, { type: REC.update, key: ['y'], value: 2 }],
    { origin: 'bb', baseSeq: 4, epoch: 0 }) })
  const d = node.streams.get('bb')!
  assert.deepEqual([d.applied, d.shippable], [5, 5])
  //! a duplicate delivery (≤ applied) moves neither watermark and logs nothing
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 1 }], { origin: 'bb', baseSeq: 4, epoch: 0 }) })
  assert.deepEqual([d.applied, d.shippable], [5, 5])
  assert.equal(node.logs.get('bb')!.length, 2)
  //! a gapped arrival (Lamport skip) advances both to the new seq — gap-tolerance is the applied contract
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['z'], value: 3 }], { origin: 'bb', baseSeq: 9, epoch: 0 }) })
  assert.deepEqual([d.applied, d.shippable], [9, 9])
})

test('an LWW loser still advances the ladder (losing an election is not loss — B1, kept through M4a)', () => {
  const node = formed()
  //! aa commits the cell at seq 2, then bb's seq-1 record arrives: (0,1,bb) < (0,2,aa) — a strict LWW loser
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 'mine' }] }) // seq 1
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 'newer' }] }) // seq 2
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['k'], value: 'stale' }], { origin: 'bb', baseSeq: 1, epoch: 0 }) })
  const d = node.streams.get('bb')!
  assert.deepEqual([d.applied, d.shippable], [1, 1], 'the loser advanced the ladder')
  assert.equal(node.state.get(JSON.stringify(['k'])), 'newer', 'and did not win the cell')
  assert.equal(node.logs.get('bb')!.length, 1, 'and IS logged — it may be the only copy a lagging peer is offered')
})
