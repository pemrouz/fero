//! Tier-1 codec suite: round-trips over the full value zoo, adversarial corruption, straddles, run-splitting.
// Carries v2's message.test.ts posture (seeded fuzz + hostile frames) against
// ONE Cursor primitive — every bounds check exists once, so one suite covers
// every read site (v2's ~12 inlined varint copies each needed their own).

import { test } from 'node:test'
import assert from 'node:assert'
import {
  Framer, FrameError, MAGIC, MAX_FRAME, VERB, HEADER, MAX_DEPTH,
  encodeControl, encodeFrame, encodeRuns, crcFrame, Writer, Cursor, VT, encodable,
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
  const full = { u: 'abc', i: 3, l: 'h:1', r: 1, n: 'shop', c: 'v1;heartbeat.ms=500;replicas=0;methods=1;validation=none;ring=fmix32', m: 1, k: 'Zm9vYmFyYmF6cXV4cXV1eA' }
  const g = new Framer().push(encodeControl(VERB.HELLO, full))[0]
  assert.deepEqual(g.value, full)
  assert.deepEqual(Object.keys(g.value as object), ['u', 'i', 'l', 'r', 'n', 'c', 'm', 'k'], 'key order is the send site\'s insertion order')
})

test('DOOR (26) round-trips its two shapes: {p} the proof and {e} the refusal notice', () => {
  assert.equal(VERB.DOOR, 26, 'appended after LEAVE: 25, never renumbered')
  const p = 'A'.repeat(43)
  const proof = new Framer().push(encodeControl(VERB.DOOR, { p }))[0]
  assert.equal(proof.verb, VERB.DOOR)
  assert.deepEqual(proof.value, { p })
  for (const e of ['denied', 'uuid-taken']) {
    const notice = new Framer().push(encodeControl(VERB.DOOR, { e }))[0]
    assert.deepEqual(notice.value, { e })
  }
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

//! arrays whose own iterator disagrees with their indices: a subclass, an own Symbol.iterator — one yields a value
// the length never covered, one more elements than the length, one fewer
const oddArrays = (): unknown[][] => {
  class Odd extends Array { *[Symbol.iterator]() { yield 'x' } }
  return [
    Odd.from([1, 2]),
    Object.assign([1, 2], { *[Symbol.iterator]() { yield 10n } }),
    Object.assign([1, 2], { *[Symbol.iterator]() { yield 1; yield 2; yield 3 } }),
  ]
}

//! Writer.value writes an array's length and then its elements: with for-of, an array whose iterator disagreed wrote
// a count and other elements — a frame that would not decode ('frame truncated', trailing bytes), or one that met a
// value the length never covered (a bigint, thrown from inside the step). By index over the length it writes, the
// count and the elements are one reading (the V4-48 review); plain arrays encode to the same bytes.
test('Writer.value writes an array by index over the length it writes — whatever its own iterator yields — and it decodes whole', () => {
  for (const a of oddArrays()) {
    const w = new Writer()
    w.value(a, VT.arr)
    const c = new Cursor(w.buf, 0, w.len)
    assert.deepEqual(c.value(VT.arr), [1, 2], 'the elements by index, whatever the iterator says')
    assert.equal(c.pos, w.len, 'and nothing after them')
  }
})

//! encodable (V4-48) is asked before a local write is stamped: within the codec's own bounds it must say yes
// exactly when Writer.value can encode, or a value it lets through is the stamped-then-unshippable write it exists
// to stop (and one it refuses is a write lost for nothing). Parity over the codec's edges, plus the reason it gives
// for each refusal. The api asks tighter bounds (api/data.ts WRITE, ARG); those are pinned where they are asked.
test('encodable agrees with Writer.value on every edge within the codec\'s bounds, and names what stops a refused value', () => {
  const CODEC = { depth: MAX_DEPTH, bytes: MAX_FRAME }
  let d64: unknown = 1, d65: unknown = 1
  for (let i = 0; i < 64; i++) d64 = [d64]
  for (let i = 0; i < 65; i++) d65 = [d65]
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const [odd, ownBig, ownLong] = oddArrays()
  const values: unknown[] = [
    null, undefined, true, false, 0, -0, 1.5, NaN, Infinity, 2 ** 31, '', 'ünïcode', new Uint8Array([1]), [], {}, [1, [2, [3]]],
    { a: { b: [1, 'x', null] } }, new Date(0), new Map([[1, 2]]), Object.create(null), [, 1], d64, d65, cyclic, odd, ownBig, ownLong,
    10n, () => 1, Symbol('s'), { n: 10n }, [Symbol('t')], { get g() { throw new Error('g') } }, { get ok() { return 1 } },
  ]
  for (const v of values) {
    let encodes = true
    try { new Writer().value(v) } catch { encodes = false }
    assert.equal(encodable(v, CODEC) === null, encodes, `parity for ${String(typeof v)} ${(() => { try { return JSON.stringify(v) } catch { return '(unprintable)' } })()}`)
  }
  assert.equal(encodable(10n, CODEC), 'a bigint')
  assert.equal(encodable({ f: () => 1 }, CODEC), 'a function at f')
  assert.equal(encodable([Symbol('s')], CODEC), 'a symbol at [0]')
  assert.equal(encodable({ toys: ['ball', { 'two words': 10n }] }, CODEC), 'a bigint at toys[1]["two words"]')
  assert.equal(encodable({ a: { b: { c: { d: { e: { f: { g: 10n } } } } } } }, CODEC), 'a bigint at a.b.c.d.e.f…', 'the first six parts of a long path')
  assert.equal(encodable(d65, CODEC), 'deeper than 64 levels', 'no path for depth: it is the path')
  assert.equal(encodable(cyclic, CODEC), 'deeper than 64 levels')
  assert.equal(encodable({ get g() { throw new Error('g') } }, CODEC), 'reading it threw (Error: g) at g')
  assert.equal(encodable(d64, CODEC, 1), 'deeper than 64 levels', 'a value that starts one level down has one level less')
  //! what a getter throws is never tested in a way that runs its code: a revoked Proxy, or a Proxy whose trap throws,
  // answered with a throw out of encodable itself (an `instanceof` on it), and a data: seed escaped fero() bare
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  const trap = new Proxy({}, { getPrototypeOf() { throw new Error('trap') } })
  assert.equal(encodable({ get x() { throw revoked } }, CODEC), 'reading it threw (an unreadable error) at x')
  assert.equal(encodable({ get x() { throw trap } }, CODEC), 'reading it threw (an unreadable error) at x')
})

//! the byte budget: charged as Writer.ensure reserves (a string 4 + 3 per character), so a value it lets through
// never meets the frame cap alone; and charged BEFORE the walk visits what it pays for, so the walk is bounded by the
// budget, never by the value — a hostile shape costs what encoding it would, at most.
test('encodable charges bytes as the writer reserves them and stops when the budget runs out: a sparse array a billion long and a value of shared parts are refused at once', () => {
  const small = { depth: MAX_DEPTH, bytes: 300 }
  assert.equal(encodable('x'.repeat(98), small), null, '4 + 3 × 98 = 298 bytes fit in 300')
  assert.equal(encodable('x'.repeat(99), small), 'bigger than 0 MiB (a string counts 3 bytes a character)')
  assert.equal(encodable('x'.repeat(98), small, 0, 2), null)
  assert.match(encodable('x'.repeat(98), small, 0, 3)!, /^bigger than/, 'what the key already spent counts')
  const t0 = performance.now()
  assert.equal(encodable(new Array(1e9), { depth: MAX_DEPTH, bytes: MAX_FRAME }), 'bigger than 256 MiB', 'no note about characters when no string was counted')
  let shared: unknown = 1
  for (let i = 0; i < 64; i++) shared = [shared, shared] // 65 arrays, 2^64 paths through them
  assert.equal(encodable(shared, { depth: MAX_DEPTH, bytes: 1 << 20 }), 'bigger than 1 MiB')
  assert.ok(performance.now() - t0 < 1000, `both refusals stop at the budget (${Math.round(performance.now() - t0)} ms)`)
})
