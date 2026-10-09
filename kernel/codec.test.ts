//! Tier-1 codec suite: round-trips over the full value zoo, adversarial corruption, straddles, run-splitting.
// Carries v2's message.test.ts posture (seeded fuzz + hostile frames) against
// ONE Cursor primitive — every bounds check exists once, so one suite covers
// every read site (v2's ~12 inlined varint copies each needed their own).

import { test } from 'node:test'
import assert from 'node:assert'
import {
  Framer, FrameError, MAGIC, MAX_FRAME, VERB, HEADER, MAX_DEPTH,
  encodeControl, encodeFrame, encodeRuns, crcFrame, Writer,
} from './codec.ts'
import { REC, type Rec } from './env.ts'

const roundTrip = (recs: Rec[], prov = { origin: 'o1', baseSeq: 7, epoch: 2 }) => {
  const frames = new Framer().push(encodeFrame(recs, prov))
  assert.equal(frames.length, 1)
  return frames[0]
}

test('records round-trip: every value type, unicode/hostile keys, at, provenance stamping', () => {
  const values = [
    null, undefined, false, true, 0, -1, 42, 2147483647, -2147483647,
    3.14159, -0, NaN, Infinity, 1e300, 'plain', '', 'é中文🎉', 'a'.repeat(10_000),
    { a: 1, b: { c: [1, 2, { d: 'x' }] } }, [], [1, 'two', null, { x: 1 }],
    new Uint8Array([1, 2, 255, 0]),
  ]
  const recs: Rec[] = values.map((value, i) => ({
    type: REC.update,
    key: [`k${i}`, 'dots.and\0nulls', 'é中'], // keys are length-prefixed — separators can't over-match
    value,
  }))
  recs.push({ type: REC.remove, key: ['gone'] })
  recs.push({ type: REC.insert, key: [], at: 'root-key', value: 'v' })

  const frame = roundTrip(recs)
  const views = frame.records()
  assert.equal(views.length, recs.length)
  views.forEach((v, i) => {
    assert.deepEqual(v.key, recs[i].key)
    assert.equal(v.at, recs[i].at)
    assert.equal(v.type, recs[i].type)
    assert.equal(v.origin, 'o1')
    assert.equal(v.seq, 7 + i) // seq = baseSeq + index — the provenance amortisation contract
    assert.equal(v.epoch, 2)
    const val = v.value
    if (typeof recs[i].value === 'number' && Number.isNaN(recs[i].value as number)) assert.ok(Number.isNaN(val))
    else if (recs[i].type === REC.remove) assert.equal(val, undefined)
    else assert.deepEqual(val, recs[i].value)
  })
})

test('negative zero survives (f64 path) and -0 is not silently zigzagged to +0', () => {
  const v = roundTrip([{ type: REC.update, key: ['z'], value: -0 }]).records()[0].value
  assert.ok(Object.is(v, -0))
})

test('control frames carry one value; HELLO shape round-trips', () => {
  const f = new Framer().push(encodeControl(VERB.HELLO, { u: 'abc', i: 3, l: 'h:1' }))[0]
  assert.equal(f.verb, VERB.HELLO)
  assert.deepEqual(f.value, { u: 'abc', i: 3, l: 'h:1' })
  //! the door's optional keys (DESIGN-DOOR §2): `c` the cluster contract (a string), `m: 1` the
  // methods-only hint — generic object keys, so an old decoder keeps and ignores them
  const full = { u: 'abc', i: 3, l: 'h:1', r: 1, n: 'shop', c: 'v1;heartbeat.ms=500;replicas=0;methods=1;validation=none;ring=fmix32', m: 1 }
  const g = new Framer().push(encodeControl(VERB.HELLO, full))[0]
  assert.deepEqual(g.value, full)
  assert.deepEqual(Object.keys(g.value as object), ['u', 'i', 'l', 'r', 'n', 'c', 'm'], 'key order is the send site\'s insertion order')
})

test('framer reassembles frames split at EVERY byte boundary', () => {
  const recs: Rec[] = [{ type: REC.update, key: ['k'], value: { deep: [1, 'x'] } }]
  const bytes = encodeFrame(recs, { origin: 'o', baseSeq: 1, epoch: 0 })
  for (let cut = 1; cut < bytes.length; cut++) {
    const framer = new Framer()
    const first = framer.push(bytes.subarray(0, cut))
    const second = framer.push(bytes.subarray(cut))
    const frames = [...first, ...second]
    assert.equal(frames.length, 1, `cut at ${cut}`)
    assert.deepEqual(frames[0].records()[0].value, { deep: [1, 'x'] })
  }
})

test('two frames in one chunk + a straddling third all decode', () => {
  const f = (n: number) => encodeFrame([{ type: REC.update, key: [`k${n}`], value: n }], { origin: 'o', baseSeq: n, epoch: 0 })
  const [a, b, c] = [f(1), f(2), f(3)]
  const joined = new Uint8Array(a.length + b.length + c.length)
  joined.set(a); joined.set(b, a.length); joined.set(c, a.length + b.length)
  const framer = new Framer()
  const part1 = framer.push(joined.subarray(0, a.length + b.length + 5))
  const part2 = framer.push(joined.subarray(a.length + b.length + 5))
  assert.equal(part1.length, 2)
  assert.equal(part2.length, 1)
  assert.equal(part2[0].records()[0].value, 3)
})

//! Exhaustive single-byte corruption: EVERY mutated frame must throw FrameError or decode cleanly — never crash, never mis-apply silently.
// The crc makes "decode cleanly with wrong content" nearly impossible; magic/len corruption must fail fast pre-allocation.
test('single-byte corruption fuzz: FrameError or clean decode, never a crash', () => {
  const bytes = encodeFrame(
    [{ type: REC.update, key: ['k', 'sub'], value: { s: 'str', n: [1, 2.5, NaN] } }],
    { origin: 'origin-1', baseSeq: 100, epoch: 3 },
  )
  let rejected = 0
  for (let i = 0; i < bytes.length; i++) {
    for (const flip of [0x01, 0x80, 0xff]) {
      const mutated = bytes.slice()
      mutated[i] ^= flip
      try {
        const frames = new Framer().push(mutated)
        for (const fr of frames) for (const r of fr.records()) { r.key; r.value; r.at }
      } catch (e) {
        assert.ok(e instanceof FrameError, `byte ${i} flip ${flip} threw non-FrameError: ${e}`)
        rejected++
      }
    }
  }
  //! the crc means corruption is overwhelmingly REJECTED (v2 had no integrity check at all — a flipped epoch byte was silently believed)
  assert.ok(rejected > bytes.length * 2.5, `only ${rejected} rejections across ${bytes.length * 3} mutations`)
})

test('header bytes are crc-covered: a flipped verb or flags byte is REJECTED, not re-dispatched', () => {
  // regression (adversarial review): body-only crc coverage let a verb flip turn a
  // crc-valid RECORDS frame into a PING — every record in it silently vanished
  const bytes = encodeFrame([{ type: REC.update, key: ['k'], value: 1 }], { origin: 'o', baseSeq: 1, epoch: 0 })
  for (const at of [1, 2]) // flags, verb
    for (const flip of [0x01, 0x80]) {
      const mutated = bytes.slice()
      mutated[at] ^= flip
      assert.throws(() => new Framer().push(mutated), FrameError, `byte ${at} flip ${flip} was accepted`)
    }
})

test('hostile headers: bad magic and oversized bodyLen fail BEFORE any allocation or carry growth', () => {
  const bad = encodeFrame([{ type: REC.update, key: ['k'], value: 1 }], { origin: 'o', baseSeq: 1, epoch: 0 }).slice()
  bad[0] = 0x00
  assert.throws(() => new Framer().push(bad), FrameError)

  const oversized = new Uint8Array(HEADER)
  oversized[0] = MAGIC
  new DataView(oversized.buffer).setUint32(3, MAX_FRAME + 1, true)
  assert.throws(() => new Framer().push(oversized), FrameError)
})

test('trailing garbage after the record payload is a FrameError, not silently ignored', () => {
  const bytes = encodeFrame([{ type: REC.update, key: ['k'], value: 1 }], { origin: 'o', baseSeq: 1, epoch: 0 })
  const padded = new Uint8Array(bytes.length + 3)
  padded.set(bytes)
  // extend bodyLen to cover the garbage and re-checksum so ONLY the trailing-bytes check can catch it
  new DataView(padded.buffer).setUint32(3, bytes.length - HEADER + 3, true)
  new DataView(padded.buffer).setUint32(7, crcFrame(padded, padded.length), true)
  const frames = new Framer().push(padded)
  assert.throws(() => frames[0].records(), FrameError)
})

//! encodeRuns: the single-origin / contiguous-seq / single-epoch invariant — a run breaks on origin change, seq gap, epoch change.
test('encodeRuns splits exactly on origin change, seq gap, and epoch change', () => {
  const rec = (k: string): Rec => ({ type: REC.update, key: [k], value: k })
  const frames = encodeRuns([
    { rec: rec('a'), origin: 'A', seq: 1, epoch: 0 },
    { rec: rec('b'), origin: 'A', seq: 2, epoch: 0 }, // contiguous — same frame
    { rec: rec('c'), origin: 'A', seq: 4, epoch: 0 }, // gap — split
    { rec: rec('d'), origin: 'B', seq: 5, epoch: 0 }, // origin change — split
    { rec: rec('e'), origin: 'B', seq: 6, epoch: 1 }, // epoch change — split
  ])
  assert.equal(frames.length, 4)
  const framer = new Framer()
  const decoded = frames.flatMap((f) => framer.push(f))
  assert.deepEqual(decoded.map((f) => f.records().length), [2, 1, 1, 1])
  assert.deepEqual(decoded.map((f) => f.prov()!.origin), ['A', 'A', 'B', 'B'])
  assert.deepEqual(decoded[0].records().map((r) => r.seq), [1, 2])
})

test('a deeply-nested hostile value is a FrameError, never a stack-overflow crash (both directions)', () => {
  //! adversarial-review critical: an unbounded recursive decode/encode is a RangeError a hostile frame
  // can trigger, and RangeError is NOT a FrameError — it escaped the net and crashed the node.
  //! encode side: a value nested past MAX_DEPTH is rejected as a FrameError (what can't decode can't encode)
  let deep: unknown = 0
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = [deep]
  assert.throws(() => encodeFrame([{ type: REC.update, key: ['k'], value: deep }]), FrameError)
  //! decode side: hand-craft a frame body that is MAX_DEPTH+ nested arrays and confirm records() throws
  // FrameError (not RangeError). Build via a raw Writer so the encode-side guard doesn't pre-empt it.
  const w = new Writer()
  w.u8(MAGIC); w.u8(1); w.u8(VERB.RECORDS)
  w.u32(0); w.u32(0)
  w.str('o'); w.varint(1); w.varint(0) // prov
  w.u32(1) // one record
  // record: tag (type=update, no at, vt=arr), key ['k'], then the value = deeply nested arrays
  const VT_ARR = 6
  w.u8((0 & 3) | (VT_ARR << 3))
  w.varint(1); w.str('k')
  for (let i = 0; i < MAX_DEPTH + 5; i++) { w.u8(VT_ARR); w.varint(1) } // nested arr, count 1, each level
  w.u8(1) // innermost: VT.null (a leaf)
  const bodyLen = w.len - HEADER
  w.u32at(3, bodyLen); w.u32at(7, crcFrame(w.buf, w.len))
  const frame = new Framer().push(w.buf.slice(0, w.len))[0]
  assert.throws(() => frame.records()[0].value, FrameError, 'nested decode must be a FrameError, not a crash')
})

test('attempt identity (FLAG_ATTEMPT) round-trips on a run and rides contiguous cids', () => {
  //! the M3 exactly-once carrier: a committed forwarded run broadcasts (issuer, cid) so replication
  // feeds every node's dedup window. Verify encode/decode of the extension + per-record cid stepping.
  const recs = [
    { rec: { type: REC.update, key: ['a'], value: 1 } as Rec, origin: 'own', seq: 5, epoch: 2, iss: 'cli~1', cid: 40 },
    { rec: { type: REC.update, key: ['b'], value: 2 } as Rec, origin: 'own', seq: 6, epoch: 2, iss: 'cli~1', cid: 41 },
  ]
  const frames = encodeRuns(recs, VERB.RECORDS)
  assert.equal(frames.length, 1, 'contiguous seq + cid + same issuer = one run')
  const f = new Framer().push(frames[0])[0]
  assert.deepEqual(f.attempt(), { issuer: 'cli~1', baseCid: 40 })
  const rv = f.records()
  assert.deepEqual([rv[0].issuer, rv[0].cid], ['cli~1', 40])
  assert.deepEqual([rv[1].issuer, rv[1].cid], ['cli~1', 41])
  //! a run WITHOUT attempt identity carries none (backward compatible — plain replication)
  const plain = new Framer().push(encodeRuns([{ rec: { type: REC.update, key: ['c'] } as Rec, origin: 'o', seq: 1, epoch: 0 }])[0])[0]
  assert.equal(plain.attempt(), null)
  assert.equal(plain.records()[0].issuer, '')
})

test('a cid gap or issuer change breaks an attempt run (like a seq gap breaks a prov run)', () => {
  const recs = [
    { rec: { type: REC.update, key: ['a'] } as Rec, origin: 'o', seq: 1, epoch: 1, iss: 'x~1', cid: 1 },
    { rec: { type: REC.update, key: ['b'] } as Rec, origin: 'o', seq: 2, epoch: 1, iss: 'x~1', cid: 5 }, // cid gap
  ]
  assert.equal(encodeRuns(recs, VERB.RECORDS).length, 2)
})

test('seeded random-record fuzz round-trips (200 mixed frames)', () => {
  let s = 42
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let n = 0; n < 200; n++) {
    const recs: Rec[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({
      type: rnd() < 0.2 ? REC.remove : REC.update,
      key: [`k${Math.floor(rnd() * 50)}`, ...(rnd() < 0.4 ? [`s${i}`] : [])],
      value: rnd() < 0.3 ? Math.floor(rnd() * 1e6) : rnd() < 0.5 ? `v${n}-${i}` : { a: rnd(), b: [n, i] },
    }))
    const frame = new Framer().push(encodeFrame(recs, { origin: `o${n % 3}`, baseSeq: n * 10, epoch: n % 4 }))[0]
    const views = frame.records()
    views.forEach((v, i) => {
      assert.deepEqual(v.key, recs[i].key)
      if (recs[i].type !== REC.remove) assert.deepEqual(v.value, recs[i].value)
    })
  }
})
