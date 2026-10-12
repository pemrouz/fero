//! Tier-1 codec suite: round-trips over the full value zoo, adversarial corruption, straddles, run-splitting.
// Carries v2's message.test.ts posture (seeded fuzz + hostile frames) against
// ONE Cursor primitive — every bounds check exists once, so one suite covers
// every read site (v2's ~12 inlined varint copies each needed their own).

import { test } from 'node:test'
import assert from 'node:assert'
import {
  Framer, FrameError, FrameFull, FULL, MAGIC, MAX_FRAME, VERB, HEADER, MAX_DEPTH, Outbox,
  encodeControl, encodeFrame, encodeRuns, encodeRun, continuesRun, crcFrame, Writer, Cursor, VT, encodable, roomOf, copyOf, Unsendable,
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
  assert.equal(encodable('x'.repeat(99), small), 'bigger than 300 bytes (a string counts 3 bytes a character)', 'a size under one KiB in bytes, never "0 MiB"')
  assert.equal(encodable('x'.repeat(98), small, 0, 2), null)
  assert.match(encodable('x'.repeat(98), small, 0, 3)!, /^bigger than/, 'what the key already spent counts')
  const t0 = performance.now()
  assert.equal(encodable(new Array(1e9), { depth: MAX_DEPTH, bytes: MAX_FRAME }), 'bigger than 256 MiB', 'no note about characters when no string was counted')
  let shared: unknown = 1
  for (let i = 0; i < 64; i++) shared = [shared, shared] // 65 arrays, 2^64 paths through them
  assert.equal(encodable(shared, { depth: MAX_DEPTH, bytes: 1 << 20 }), 'bigger than 1 MiB')
  assert.ok(performance.now() - t0 < 1000, `both refusals stop at the budget (${Math.round(performance.now() - t0)} ms)`)
})

//! ── V4-51: frames cut by size ─────────────────────────────────────────────────
// A frame holds at most `cap` body bytes (MAX_FRAME, or a node's tune row `frame`): a run bigger than that leaves in
// several frames, each a valid run of its own, cut where the next record would not fit. These pin the codec's half:
// the cut, the roll-back that keeps a frame whole, the refusal of a record no frame can hold, and the control cap.

type RR = { rec: Rec; origin: string; seq: number; epoch: number; iss?: string; cid?: number; pp?: number }
//! a seeded batch: runs of contiguous seqs broken by gaps, epoch bumps, origin switches and attempt-lane changes; values
// from a few bytes to 1.5 KB, so a 4 KiB cap cuts inside runs
const batchOf = (seed: number, n: number): RR[] => {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const value = (): unknown => {
    const r = rnd()
    if (r < 0.25) return Math.floor(rnd() * 1e6)
    if (r < 0.5) return 'v'.repeat(Math.floor(rnd() * 400))
    if (r < 0.75) return new Uint8Array(Math.floor(rnd() * 1500))
    return { a: rnd(), b: ['x'.repeat(Math.floor(rnd() * 100)), 2, { c: null }] }
  }
  const out: RR[] = []
  let origin = 'aa', seq = 1, epoch = 1, iss: string | undefined, cid = 0
  for (let i = 0; i < n; i++) {
    const r = rnd()
    if (r < 0.04) origin = origin === 'aa' ? 'bb~2' : 'aa'
    else if (r < 0.08) seq += 2
    else if (r < 0.1) epoch++
    else if (r < 0.16) { iss = rnd() < 0.5 ? undefined : 'cl~1'; cid = Math.floor(rnd() * 100) }
    const rec: Rec = rnd() < 0.1 ? { type: REC.remove, key: ['k' + i] } : { type: REC.update, key: ['k' + i, 'f'], value: value() }
    out.push({ rec, origin, seq: seq++, epoch, ...(iss !== undefined ? { iss, cid: cid++ } : {}), pp: Math.floor(rnd() * 50) - 1 })
  }
  return out
}
const bytesOf = (v: unknown) => JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? [...x] : x))

test('a run bigger than the cap leaves in cuts: every frame within the cap, every record back once with its own seq, epoch, issuer, cid and pp; under the cap the frames are the runs', () => {
  const CAP = 4096
  let inside = 0
  for (let t = 0; t < 40; t++) {
    const b = batchOf(1000 + t, 30 + (t % 30))
    for (const withPp of [false, true]) {
      const frames = encodeRuns(b, VERB.RECORDS, withPp, CAP)
      let k = 0
      for (const bytes of frames) {
        assert.ok(bytes.length - HEADER <= CAP, `a body of ${bytes.length - HEADER} bytes passed the cap`)
        const [f] = new Framer().push(bytes.slice())
        const views = f.records()
        assert.ok(views.length >= 1)
        for (const rv of views) {
          const want = b[k++]
          assert.deepEqual([rv.origin, rv.seq, rv.epoch], [want.origin, want.seq, want.epoch], `provenance of record ${k}`)
          assert.deepEqual([rv.issuer || undefined, want.iss === undefined ? undefined : rv.cid], [want.iss, want.cid], `attempt identity of record ${k}`)
          assert.equal(rv.pp, withPp ? want.pp : -1, `pp of record ${k}`)
          assert.equal(bytesOf(rv.rec()), bytesOf(want.rec), `record ${k}`)
        }
      }
      assert.equal(k, b.length, 'every record once, in order')
      //! a frame ends inside a run ONLY where the next record does not fit: the same writer, refilled with the frame's
      // records, refuses the next one
      for (let i = 0; i < b.length;) {
        const n = encodeRun(b, i, VERB.RECORDS, withPp, CAP).n
        const next = i + n
        if (next < b.length && continuesRun(b[i], n, b[next])) {
          inside++
          const o = new Outbox(CAP)
          o.begin(VERB.RECORDS, { origin: b[i].origin, baseSeq: b[i].seq, epoch: b[i].epoch }, b[i].iss !== undefined ? { issuer: b[i].iss!, baseCid: b[i].cid! } : undefined, withPp)
          for (let x = i; x < next; x++) assert.equal(o.put(b[x].rec, b[x].pp), true)
          assert.equal(o.put(b[next].rec, b[next].pp), false, `the frame at ${i} stopped inside its run with room for the next record`)
        }
        i = next
      }
    }
    //! at the default cap the frames are exactly the runs (one per run), as before the cut existed
    let runs = 0
    for (let i = 0; i < b.length; runs++) { let j = i + 1; while (j < b.length && continuesRun(b[i], j - i, b[j])) j++; i = j }
    assert.equal(encodeRuns(b).length, runs)
  }
  assert.ok(inside > 20, `the batches cut inside runs (${inside} times)`)
})

test('the per-link Outbox cuts as it streams and keeps only whole records: ten 1.5 KB records at a 4 KiB cap leave in five frames of the same run', () => {
  const recs: Rec[] = Array.from({ length: 10 }, (_, i) => ({ type: REC.update, key: [`r${i + 1}`], value: new Uint8Array(1500).fill(i + 1) }))
  for (const attempt of [undefined, { issuer: 'cl~1', baseCid: 41 }]) {
    const o = new Outbox(4096)
    o.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 3 }, attempt)
    for (const r of recs) o.add(r)
    const frames = [...o.pending, o.finish()!]
    o.pending.length = 0
    assert.equal(frames.length, 5)
    const decoded = frames.map((b) => new Framer().push(b)[0])
    assert.deepEqual(decoded.map((f) => f.prov()!.baseSeq), [1, 3, 5, 7, 9], 'each cut begins at its first record\'s own seq')
    assert.deepEqual(decoded.map((f) => f.prov()!.epoch), [3, 3, 3, 3, 3])
    if (attempt) assert.deepEqual(decoded.map((f) => f.attempt()!.baseCid), [41, 43, 45, 47, 49], 'and its own cid')
    else assert.ok(decoded.every((f) => f.attempt() === null))
    assert.deepEqual(decoded.flatMap((f) => f.records().map((rv) => rv.key[0])), recs.map((r) => r.key[0]), 'every record once, no trailing bytes')
  }
})

test('a record bigger than an empty frame is refused loudly, and a record that stops part-way leaves nothing behind: the frame keeps only whole records', () => {
  const o = new Outbox(1024)
  o.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 1 })
  o.add({ type: REC.update, key: ['a'], value: 1 })
  assert.equal(o.put({ type: REC.update, key: ['b'], value: new Uint8Array(5000) }), false, 'put: the frame is full, nothing written')
  assert.throws(() => o.add({ type: REC.update, key: ['b'], value: new Uint8Array(5000) }), /^Error: a record bigger than one frame \(1024 bytes\) reached the encoder/)
  const frames = [...o.pending, o.finish()].filter((b): b is Uint8Array => b !== null)
  assert.equal(frames.length, 1)
  assert.deepEqual(new Framer().push(frames[0])[0].records().map((rv) => [rv.key[0], rv.value]), [['a', 1]], 'the frame holds the small record and decodes')
  //! any throw rolls back, not only a full frame: a value the codec cannot carry, found part-way through a record (its
  // tag, key and first field already written), used to leave those bytes in the open frame — the next flush shipped a
  // frame its receiver refused
  const p = new Outbox()
  p.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 1 })
  p.add({ type: REC.update, key: ['a'], value: 1 })
  assert.throws(() => p.add({ type: REC.update, key: ['b'], value: { x: 'fine', y: 10n } }), FrameError)
  p.add({ type: REC.update, key: ['c'], value: 3 })
  const [f] = new Framer().push(p.finish()!)
  assert.deepEqual(f.records().map((rv) => [rv.key[0], rv.seq, rv.value]), [['a', 1, 1], ['c', 2, 3]], 'whole records only; the next record takes the next seq')
})

test('encodeControl past its cap throws FULL, a FrameError, and the next control frame encodes', () => {
  let e: unknown
  try { encodeControl(VERB.RESULT, { id: 1, ok: 1, v: 'x'.repeat(30_000) }, 4096) } catch (x) { e = x }
  assert.equal(e, FULL)
  assert.ok(e instanceof FrameFull && e instanceof FrameError, 'a FrameError: every net that takes one still does')
  const [ok] = new Framer().push(encodeControl(VERB.RESULT, { id: 2, ok: 1, v: 'y'.repeat(1000) }, 4096))
  assert.deepEqual(ok.value, { id: 2, ok: 1, v: 'y'.repeat(1000) })
  //! the default cap is MAX_FRAME: a big value encodes, and a small frame after it is unchanged
  const big = encodeControl(VERB.RESULT, { id: 3, ok: 1, v: 'z'.repeat(200_000) })
  assert.equal(new Framer().push(big)[0].verb, VERB.RESULT)
  assert.deepEqual(new Framer().push(encodeControl(VERB.PING))[0].value, undefined)
})

test('roomOf: the most one record may take and still go alone in a frame — MAX_FRAME less a MiB in production, and at a test cap it fits beside an envelope with uuid-sized names', () => {
  assert.equal(roomOf(MAX_FRAME), MAX_FRAME - (1 << 20), 'the same number as api/data.ts WRITE.bytes')
  assert.deepEqual([roomOf(1024), roomOf(4096), roomOf(65536)], [768, 3840, 61440])
  const uuid = '0123abcd-4567-89ef-0123-456789abcdef~12'
  for (const cap of [1024, 2048, 4096, 65536]) {
    const room = roomOf(cap)
    //! a record charged exactly `room` by encodable's count (a Uint8Array value: 5 + its length; the key 4 + 3 a character)
    const kb = 4 + 3
    const value = new Uint8Array(room - kb - 5)
    assert.equal(encodable(value, { depth: MAX_DEPTH, bytes: room }, 0, kb), null)
    assert.notEqual(encodable(new Uint8Array(room - kb - 4), { depth: MAX_DEPTH, bytes: room }, 0, kb), null)
    const o = new Outbox(cap)
    o.begin(VERB.RECORDS, { origin: uuid, baseSeq: 2 ** 40, epoch: 9 }, { issuer: uuid, baseCid: 2 ** 40 }, true)
    assert.equal(o.put({ type: REC.update, key: ['k'], value }, 2 ** 40), true, `cap ${cap}: the record fits alone`)
    assert.ok(o.finish()!.length - HEADER <= cap)
  }
})

test('RecordView.span is the record\'s own bytes, its tag through its value', () => {
  const recs: Rec[] = [{ type: REC.update, key: ['k', 'é'], value: { a: [1, 'two'] } }, { type: REC.remove, key: ['gone'] }, { type: REC.insert, key: [], at: 'x', value: 'v' }]
  for (const r of recs) {
    const bytes = encodeFrame([r]) // no provenance: the body is the u32 count and the record
    assert.equal(new Framer().push(bytes)[0].records()[0].span, bytes.length - HEADER - 4)
  }
})

test('encodeFrame is ONE frame: a batch that does not fit throws FULL, never a quietly shorter frame', () => {
  const recs: Rec[] = Array.from({ length: 3 }, (_, i) => ({ type: REC.update, key: [`k${i}`], value: new Uint8Array(100 << 20) }))
  assert.throws(() => encodeFrame(recs, { origin: 'o', baseSeq: 1, epoch: 0 }), (e) => e === FULL)
})

//! ── the Framer builds each split frame once (V4-51) ──────────────────────────────
// A frame inside one chunk is a view of it; a frame across chunks is built in a buffer of its own that grows with the
// bytes that arrive — never with what a header claims — so arrival is linear and a hostile header buys 4 KiB at most.
test('the Framer assembles a split frame in a buffer of its own and holds no more than twice what arrived; a whole frame stays a view', () => {
  const big = encodeFrame([{ type: REC.update, key: ['big'], value: new Uint8Array(1 << 20).fill(7) }], { origin: 'o', baseSeq: 1, epoch: 0 })
  const framer = new Framer()
  const got: ReturnType<Framer['push']> = []
  let received = 0
  for (let at = 0; at < big.length; at += 997) {
    const chunk = big.slice(at, Math.min(big.length, at + 997))
    got.push(...framer.push(chunk))
    received += chunk.length
    chunk.fill(0) // the framer copied what it kept: a chunk is never retained
    if (got.length === 0) assert.ok(framer.held <= Math.max(4096, 2 * received), `held ${framer.held} after ${received} bytes`)
  }
  assert.equal(got.length, 1)
  assert.equal(framer.held, 0, 'nothing held once the frame is out')
  assert.equal(got[0].buf.length, big.length, 'the assembled frame is exactly its length')
  assert.equal(got[0].buf.byteOffset, 0)
  assert.equal(got[0].buf.buffer.byteLength, big.length, 'it owns exactly the frame')
  assert.deepEqual((got[0].records()[0].value as Uint8Array).subarray(0, 4), new Uint8Array([7, 7, 7, 7]))
  //! a whole frame inside one chunk is a VIEW of it (no copy), as before
  const small = encodeFrame([{ type: REC.update, key: ['s'], value: 1 }], { origin: 'o', baseSeq: 1, epoch: 0 })
  const [view] = new Framer().push(small)
  assert.equal(view.buf.buffer, small.buffer)
  //! a header claiming MAX_FRAME and 100 body bytes: the framer holds what came, not what the header claims
  const hostile = new Uint8Array(HEADER + 100)
  hostile[0] = MAGIC
  new DataView(hostile.buffer).setUint32(3, MAX_FRAME, true)
  const h = new Framer()
  assert.deepEqual(h.push(hostile), [])
  assert.ok(h.held <= 4096, `a hostile header bought ${h.held} bytes`)
})

test('hostile headers split at every byte still fail at the header; a bad crc in a split frame fails', () => {
  const badMagic = encodeFrame([{ type: REC.update, key: ['k'], value: 1 }], { origin: 'o', baseSeq: 1, epoch: 0 }).slice()
  badMagic[0] = 0x00
  const oversized = new Uint8Array(HEADER + 8)
  oversized[0] = MAGIC
  new DataView(oversized.buffer).setUint32(3, MAX_FRAME + 1, true)
  for (let cut = 0; cut <= HEADER; cut++) {
    for (const [bytes, why] of [[badMagic, 'bad magic'], [oversized, 'frame exceeds MAX_FRAME']] as const) {
      const f = new Framer()
      assert.throws(() => { f.push(bytes.subarray(0, cut)); f.push(bytes.subarray(cut)) }, (e) => e instanceof FrameError && e.message === why, `${why} split at ${cut}`)
    }
  }
  const frame = encodeFrame([{ type: REC.update, key: ['k'], value: new Uint8Array(100_000).fill(3) }], { origin: 'o', baseSeq: 1, epoch: 0 }).slice()
  frame[frame.length - 50] ^= 0x10
  for (const cut of [5, 11, 12, 70_000, frame.length - 1]) {
    const f = new Framer()
    assert.throws(() => { f.push(frame.subarray(0, cut)); f.push(frame.subarray(cut)) }, (e) => e instanceof FrameError && e.message === 'bad crc', `bad crc split at ${cut}`)
  }
})

test('a stream of frames split at random points decodes to exactly the frames sent, in order: empty chunks, split headers, frames of HEADER bytes, frames ending at a chunk\'s end', () => {
  let s = 9
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  //! a bodyLen-0 frame: legal on the wire (the framer must take it whole, split or not)
  const empty = new Uint8Array(HEADER)
  empty[0] = MAGIC; empty[2] = VERB.PING
  new DataView(empty.buffer).setUint32(7, crcFrame(empty, HEADER), true)
  for (let t = 0; t < 120; t++) {
    const frames: Uint8Array[] = []
    for (let i = 0, n = 1 + Math.floor(rnd() * 8); i < n; i++)
      frames.push(rnd() < 0.15 ? empty : encodeFrame([{ type: REC.update, key: [`k${i}`], value: new Uint8Array(Math.floor(rnd() * (rnd() < 0.2 ? 20_000 : 300))) }], { origin: 'o', baseSeq: i + 1, epoch: 0 }))
    const stream = new Uint8Array(frames.reduce((a, f) => a + f.length, 0))
    let off = 0
    for (const f of frames) { stream.set(f, off); off += f.length }
    const framer = new Framer()
    const out: Uint8Array[] = []
    for (let at = 0; at < stream.length;) {
      const n = rnd() < 0.1 ? 0 : 1 + Math.floor(rnd() * (rnd() < 0.5 ? 12 : 3000))
      for (const f of framer.push(stream.slice(at, at + n))) out.push(f.buf.slice())
      at += n
    }
    assert.equal(out.length, frames.length, `stream ${t}`)
    out.forEach((b, i) => assert.deepEqual(b, frames[i], `stream ${t} frame ${i}`))
    assert.equal(framer.held, 0)
  }
})

//! the limit's `part` rule (V4-52) is the api's say over an array or an object the codec would carry but change (a
// Date sends its own fields, and it has none). Both walks ask it once for each array and object, before its parts are
// visited, never for a Uint8Array (the codec's own bytes), and a refusal reads like any other: the reason, then where.
test("encodable and copyOf ask the limit's part rule once for each array and object, never a Uint8Array, before its parts, and refuse at its path with one text", () => {
  const value = { toys: ['a'], at: { x: 1 }, b: new Uint8Array(1) }
  const seen: [object, boolean][] = []
  const watch = { depth: MAX_DEPTH, bytes: MAX_FRAME, part: (o: object, array: boolean) => { seen.push([o, array]); return null } }
  const asked = (): void => {
    assert.equal(seen.length, 3, 'the value, toys and at — never the bytes')
    assert.ok(seen[0][0] === value && !seen[0][1] && seen[1][0] === value.toys && seen[1][1] && seen[2][0] === value.at && !seen[2][1])
    seen.length = 0
  }
  assert.equal(encodable(value, watch), null)
  asked()
  assert.deepEqual(copyOf(value, watch), value)
  asked()
  let ran = false
  const stop = { depth: MAX_DEPTH, bytes: MAX_FRAME, part: (o: object) => ((o as { kind?: string }).kind === 'when' ? 'no' : null) }
  const inside = { x: { when: { kind: 'when', get late() { ran = true; return 1 } } } }
  assert.equal(encodable(inside, stop), 'no at x.when')
  assert.throws(() => copyOf(inside, stop), (e: Error) => e instanceof Unsendable && e.message === 'no at x.when')
  assert.equal(ran, false, 'a refused part is never read')
  assert.equal(encodable({ kind: 'when' }, stop), 'no', 'no path for the value itself')
  assert.equal(encodable({ a: 1 }, { depth: MAX_DEPTH, bytes: MAX_FRAME, part: () => 'never' }), 'never')
})

//! copyOf (V4-52) is the copy a local read hands out and a local write keeps: it must build exactly what a remote copy
// decodes, or the copies disagree again. Over the codec's edges — numbers, text UTF-8 changes (a lone surrogate, a
// leading byte order mark, two keys that meet once well formed), bytes, holes, extra fields, getters, prototypes, a
// Proxy — it deep-equals decode(encode(v)) with the same prototypes and key order, and what it cannot copy it refuses
// with encodable's own text.
test('copyOf builds what decode(encode(v)) builds for every value the codec carries, and refuses what encodable refuses, with its text', () => {
  const CODEC = { depth: MAX_DEPTH, bytes: MAX_FRAME }
  const decoded = (v: unknown): unknown => new Framer().push(encodeControl(VERB.RESULT, v))[0].value
  //! the same: structure, prototypes, own key order, -0 and NaN, undefined-valued keys, a plain Uint8Array's bytes
  const same = (a: unknown, b: unknown): boolean => {
    if (typeof a !== typeof b) return false
    if (a === null || typeof a !== 'object') return Object.is(a, b)
    if (b === null || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    if (a instanceof Uint8Array) return a.length === (b as Uint8Array).length && a.every((x, i) => x === (b as Uint8Array)[i])
    const ka = Reflect.ownKeys(a), kb = Reflect.ownKeys(b as object)
    return ka.length === kb.length && ka.every((k, i) => k === kb[i]) &&
      ka.every((k) => same((a as Record<string | symbol, unknown>)[k], (b as Record<string | symbol, unknown>)[k]))
  }
  class Point { x = 1; y = 2 }
  class List extends Array {}
  const shared = { s: [1] }
  const corpus: unknown[] = [
    null, undefined, true, false, 0, -0, 1.5, NaN, Infinity, -Infinity, 2 ** 31, -(2 ** 31), 2 ** 53, '', 'ünïcode 😺', 'x'.repeat(1000),
    'lone \uD800 high', '\uDC00 lone low', '\uFEFFbom', '\uFEFF\uFEFFtwo boms', 'mid\uFEFFbom', { '\uFEFFkey': 1 }, { 'a\uD800': 1, x: 0, 'a\uDC00': 2 },
    'y'.repeat(40) + '\uD800', '\uFEFF' + 'z'.repeat(40), { ['k'.repeat(40) + '\uDC00']: 1 },
    { '\uFEFF__proto__': { x: 1 } }, new Uint8Array([1, 2, 3]), Buffer.from([4, 5]), new Uint8Array(new ArrayBuffer(8), 2, 3), [], {},
    [1, [2, [3, [4]]]], [1, , 3], Object.assign([1, 2], { extra: 1 }), List.from([1, 2]), { a: undefined, b: null }, { a: { b: [1, 'x', null, { c: -0 }] } },
    Object.create(null), { ['__proto__']: 1 }, JSON.parse('{"__proto__": {"x": 1}}'), { 2: 'two', 1: 'one', b: 'b', a: 'a' }, new Point(),
    { get g() { return 7 } }, { a: shared, b: shared }, new Date(0), new Map([[1, 2]]), new Float64Array([1.5]), new Proxy({ a: 1 }, {}),
  ]
  for (const v of corpus) {
    const c = copyOf(v, CODEC)
    assert.ok(same(c, decoded(v)), `parity for ${(() => { try { return JSON.stringify(v) } catch { return String(v) } })()}: copy ${JSON.stringify(c)}`)
    if (v !== null && typeof v === 'object') assert.notEqual(c, v, 'a copy, never the value itself')
  }
  //! what copyOf cannot copy, it refuses as encodable does, word for word, inside the same budget
  let d65: unknown = 1, d64: unknown = 1
  for (let i = 0; i < 65; i++) d65 = [d65]
  for (let i = 0; i < 64; i++) d64 = [d64]
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const small = { depth: MAX_DEPTH, bytes: 300 }
  const refused: [unknown, { depth: number; bytes: number }, number][] = [
    [10n, CODEC, 0], [() => 1, CODEC, 0], [Symbol('s'), CODEC, 0], [{ n: 10n }, CODEC, 0], [{ toys: ['ball', { 'two words': 10n }] }, CODEC, 0],
    [d65, CODEC, 0], [d64, CODEC, 1], [cyclic, CODEC, 0], [{ get g() { throw new Error('g') } }, CODEC, 0], ['x'.repeat(99), small, 0],
    [{ k: true }, { depth: MAX_DEPTH, bytes: 12 }, 0], [new Array(1e9), CODEC, 0],
  ]
  for (const [v, limit, from] of refused) {
    const why = encodable(v, limit, from)
    assert.notEqual(why, null)
    assert.throws(() => copyOf(v, limit, from), (e: Error) => e instanceof Unsendable && e.message === why, String(why))
  }
  assert.throws(() => copyOf('x'.repeat(98), small, 0, 3), /^Error: bigger than 300 bytes \(a string counts 3 bytes a character\)$/, 'what the key already spent counts')
  //! a getter may copy too: the inner copy's bytes are its own, never the outer's
  const nested = { a: 'x'.repeat(20), get g() { copyOf('y'.repeat(1000), CODEC); return 1 } }
  assert.equal(encodable(nested, { depth: MAX_DEPTH, bytes: 100 }), null)
  assert.deepEqual(copyOf(nested, { depth: MAX_DEPTH, bytes: 100 }), { a: 'x'.repeat(20), g: 1 })
})

//! the V4-51/52 review: the decoder (a default TextDecoder) dropped one leading U+FEFF from every string it read, value
// or key, as if it were a byte order mark, and copyOf dropped one too to match — so a string that began with two lost
// one more on every hop, and the writer's copy and every other differed. It is text: the decoder keeps it now
// (ignoreBOM; the bytes do not change), and so does the copy.
test('a string that begins with U+FEFF arrives as it was written — one or two of them, in a value and in a key — and the copy keeps them too', () => {
  const CODEC = { depth: MAX_DEPTH, bytes: MAX_FRAME }
  for (const v of ['﻿ab', '﻿﻿ab', { '﻿key': '﻿﻿v' }, ['﻿' + 'z'.repeat(40)]]) {
    const w = new Writer()
    const vt = typeof v === 'string' ? VT.str : Array.isArray(v) ? VT.arr : VT.obj
    w.value(v, vt)
    assert.deepStrictEqual(new Cursor(w.buf, 0, w.len).value(vt), v, 'decoded as written')
    assert.deepStrictEqual(copyOf(v, CODEC), v, 'copied as written')
  }
})

//! the V4-51/52 review: the size reason's note ('a string counts 3 bytes a character') sat in a module flag that a
// getter running a walk or a copy of its own reset, so the outer refusal lost it
test('the size reason keeps its note about characters when a getter ran a walk of its own', () => {
  const small = { depth: MAX_DEPTH, bytes: 100 }
  const v = { s: 'x'.repeat(20), get n() { encodable({ inner: 1 }, small); return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }
  assert.equal(encodable(v, small), 'bigger than 100 bytes (a string counts 3 bytes a character)')
  assert.throws(() => copyOf(v, small), /^Error: bigger than 100 bytes \(a string counts 3 bytes a character\)$/)
})
