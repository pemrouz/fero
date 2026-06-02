// message.ts proves the binary form of the day-0 hypothesis: a batch of `data`
// change records survives encode → frame → (straddled) stream → decode → apply,
// byte-for-byte, with lazy fields parsed only on read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { $, value, view } from '../../data/index.ts'
import { encodeFrame, decodeFrame, Framer, VERB, type ChangeRecord } from './message.ts'

// decode a single-frame buffer to plain records (via RecordView getters)
const recordsOf = (buf: Buffer) => decodeFrame(buf).records().map((r) => r.toJSON())

test('round-trips one record per value type', () => {
  const cases: ChangeRecord[] = [
    { type: 'update', key: [], value: undefined },
    { type: 'update', key: [], value: null },
    { type: 'update', key: ['a'], value: true },
    { type: 'update', key: ['a'], value: false },
    { type: 'update', key: ['n'], value: 0 },
    { type: 'update', key: ['n'], value: 42 },
    { type: 'update', key: ['n'], value: -7 },
    { type: 'update', key: ['n'], value: 2147483647 },
    { type: 'update', key: ['n'], value: -2147483648 },
    { type: 'update', key: ['big'], value: 9_007_199_254_740_991 }, // > int32 → f64
    { type: 'update', key: ['f'], value: 3.14159 },
    { type: 'update', key: ['s'], value: 'hello — über 🚀' }, // multibyte utf8
    { type: 'update', key: ['o'], value: { name: 'P', active: true, nested: { x: [1, 2, 3] } } },
    { type: 'update', key: ['arr'], value: [1, 'two', { three: 3 }] },
    { type: 'update', key: ['deep', 'nested', 'path'], value: 1 },
  ]
  for (const c of cases) {
    const got = recordsOf(encodeFrame([c]))
    // normalize: toJSON always includes value; undefined value round-trips as undefined
    assert.deepEqual(got, [c], JSON.stringify(c))
  }
})

test('round-trips insert with `at` (the BI0 first-write-to-new-key case)', () => {
  // sessions.data.user42 = {…} against an empty root crosses as this exact record
  const record: ChangeRecord = { type: 'insert', key: [], value: { name: 'P' }, at: 'user42' }
  assert.deepEqual(recordsOf(encodeFrame([record])), [record])

  // nested array insert with positional `at`
  const record2: ChangeRecord = { type: 'insert', key: ['events'], value: { id: 1 }, at: '0' }
  assert.deepEqual(recordsOf(encodeFrame([record2])), [record2])
})

test('round-trips remove', () => {
  const record: ChangeRecord = { type: 'remove', key: ['user99'], value: { gone: true } }
  assert.deepEqual(recordsOf(encodeFrame([record])), [record])
})

test('round-trips a batch in one frame', () => {
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['user42'], value: { name: 'P', active: true } },
    { type: 'update', key: ['user42', 'active'], value: false },
    { type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' },
    { type: 'remove', key: ['user99'], value: undefined },
  ]
  assert.deepEqual(recordsOf(encodeFrame(batch)), batch)
})

test('frame carries verb and optional u48 id', () => {
  const plain = decodeFrame(encodeFrame([{ type: 'update', key: ['x'], value: 1 }]))
  assert.equal(plain.verb, VERB.RECORDS)
  assert.equal(plain.id, undefined)

  const withId = decodeFrame(encodeFrame([{ type: 'update', key: ['x'], value: 1 }], { verb: VERB.SYNC, id: 1234567890123 }))
  assert.equal(withId.verb, VERB.SYNC)
  assert.equal(withId.id, 1234567890123) // u48: well beyond 2^32
})

test('provenance: origin + per-record seq round-trip (baseSeq + index)', () => {
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['a'], value: 1 },
    { type: 'insert', key: [], value: { n: 2 }, at: 'b' },
    { type: 'remove', key: ['c'], value: undefined },
  ]
  const frame = decodeFrame(encodeFrame(batch, { origin: 'node-A', seq: 100 }))
  assert.equal(frame.origin, 'node-A')
  assert.equal(frame.baseSeq, 100)
  const records = frame.records()
  assert.deepEqual(records.map((r) => r.seq), [100, 101, 102]) // baseSeq + index
  assert.deepEqual(records.map((r) => r.origin), ['node-A', 'node-A', 'node-A'])
  // toJSON carries provenance back out
  assert.deepEqual(records[1].toJSON(), { type: 'insert', key: [], value: { n: 2 }, at: 'b', origin: 'node-A', seq: 101 })
})

test('provenance is read from records[0] when not passed explicitly', () => {
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['a'], value: 1, origin: 'node-Z', seq: 7 },
    { type: 'update', key: ['a2'], value: 2, origin: 'node-Z', seq: 8 },
  ]
  const frame = decodeFrame(encodeFrame(batch))
  assert.equal(frame.origin, 'node-Z')
  assert.deepEqual(frame.records().map((r) => r.seq), [7, 8])
})

test('a frame with no provenance reports undefined origin (back-compat)', () => {
  const frame = decodeFrame(encodeFrame([{ type: 'update', key: ['x'], value: 1 }]))
  assert.equal(frame.origin, undefined)
  const r = frame.records()[0]
  assert.equal(r.origin, undefined)
  assert.equal(r.seq, undefined)
  assert.deepEqual(r.toJSON(), { type: 'update', key: ['x'], value: 1 }) // no origin/seq keys
})

test('provenance survives id + straddled reassembly', () => {
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['user42'], value: { name: 'P' } },
    { type: 'update', key: ['user42', 'active'], value: false },
  ]
  const buf = encodeFrame(batch, { verb: VERB.SYNC, id: 999, origin: 'n1', seq: 5 })
  for (let cut = 1; cut < buf.length; cut++) {
    const framer = new Framer()
    const frames = [...framer.push(buf.subarray(0, cut)), ...framer.push(buf.subarray(cut))]
    assert.equal(frames.length, 1, `cut at ${cut}`)
    const f = frames[0]
    assert.equal(f.id, 999, `cut at ${cut}`)
    assert.equal(f.origin, 'n1', `cut at ${cut}`)
    assert.deepEqual(f.records().map((r) => r.seq), [5, 6], `cut at ${cut}`)
  }
})

test('Framer reassembles frames split at every byte boundary', () => {
  const a = encodeFrame([{ type: 'update', key: ['a'], value: { x: 1 } }])
  const b = encodeFrame([
    { type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' },
    { type: 'update', key: ['a', 'b'], value: 'two' },
  ])
  const stream = Buffer.concat([a, b])

  for (let cut = 1; cut < stream.length; cut++) {
    const framer = new Framer()
    const frames = [...framer.push(stream.subarray(0, cut)), ...framer.push(stream.subarray(cut))]
    assert.equal(frames.length, 2, `cut at ${cut}`)
    assert.deepEqual(
      frames.flatMap((f) => f.records().map((r) => r.toJSON())),
      [
        { type: 'update', key: ['a'], value: { x: 1 } },
        { type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' },
        { type: 'update', key: ['a', 'b'], value: 'two' },
      ],
      `cut at ${cut}`,
    )
  }
})

test('Framer handles many frames fed in one chunk', () => {
  const frames = Array.from({ length: 50 }, (_, i) => encodeFrame([{ type: 'update', key: ['k' + i], value: i }]))
  const got = new Framer().push(Buffer.concat(frames))
  assert.equal(got.length, 50)
  assert.deepEqual(got[7].records()[0].toJSON(), { type: 'update', key: ['k7'], value: 7 })
})

test('lazy: reading type/key does not require reading value, and memoises', () => {
  const record = decodeFrame(encodeFrame([{ type: 'insert', key: ['users', '42'], value: { a: 1 }, at: 'x' }])).records()[0]
  assert.equal(record.type, 'insert')
  assert.deepEqual(record.key, ['users', '42'])
  assert.equal(record.at, 'x')
  // value parsed only now
  assert.deepEqual(record.value, { a: 1 })
  // memoised: same object identity on re-read
  assert.equal(record.value, record.value)
  assert.equal(record.key, record.key)
})

test('bad magic byte throws (fail-fast resync)', () => {
  const buf = encodeFrame([{ type: 'update', key: ['x'], value: 1 }])
  buf[0] = 0x00
  assert.throws(() => new Framer().push(buf), /bad frame magic/)
})

// The whole point: a decoded record applied via the day-0 res contract
// reconstructs the source state — the same apply() contract the day-0 spike proved.
test('apply contract: decoded records reconstruct source state in $()', () => {
  const a = $({})
  const ca = a.connect([]) // capture A's change records as it mutates
  a.user42 = { name: 'P', active: true }
  a.user42.active = false
  a.events = []
  a.events.insert({ id: 1 })
  a.user7 = { name: 'Z' }
  delete a.user7

  // ship them through the binary codec
  const wire = encodeFrame(ca as ChangeRecord[])
  const b = $({})
  const res = (b as any)[view].res
  for (const record of decodeFrame(wire).records()) {
    if (record.type === 'update') res.update(record.value, record.key)
    else if (record.type === 'insert') res.insert(record.value, record.key, record.at)
    else if (record.type === 'remove') res.remove(record.key)
  }
  assert.deepEqual(b[value], a[value])
  assert.deepEqual(b[value], { user42: { name: 'P', active: false }, events: [{ id: 1 }] })
})
