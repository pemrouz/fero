// message.ts proves the binary form of the day-0 hypothesis: a batch of `data`
// change records survives encode → frame → (straddled) stream → decode → apply,
// byte-for-byte, with lazy fields parsed only on read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { $, value, view } from '../../data/index.ts'
import { encodeFrame, encodeFrames, decodeFrame, Framer, FrameError, VERB, type ChangeRecord } from './message.ts'

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

test('provenance: view-epoch round-trips in prov frames (Milestone V)', () => {
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['a'], value: 1 },
    { type: 'update', key: ['b'], value: 2 },
  ]
  const frame = decodeFrame(encodeFrame(batch, { origin: 'node-A', seq: 10, epoch: 5 }))
  assert.equal(frame.epoch, 5)
  const records = frame.records()
  assert.deepEqual(
    records.map((r) => r.epoch),
    [5, 5], // one epoch per frame (writes don't straddle a view)
  )
  assert.deepEqual(
    records.map((r) => r.seq),
    [10, 11],
  )
  // toJSON carries the epoch back out alongside origin/seq
  assert.deepEqual(records[0].toJSON(), { type: 'update', key: ['a'], value: 1, origin: 'node-A', seq: 10, epoch: 5 })
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
  assert.throws(() => new Framer().push(buf), FrameError)
  assert.throws(() => new Framer().push(buf), /bad frame magic/)
})

// ─────────────────────────────────────────── defensive decode (hostile frames)
// `records()` and the lazy getters trust wire-supplied counts/lengths; an
// attacker (or corruption) can make them overrun the buffer or trigger a giant
// allocation. Every malformed frame must throw a typed FrameError (→ peer.ts
// drops the connection) and NEVER crash, hang, or over-read. See ../IDEAS.md.

const MAGIC = 0xfe
const HEADER = 7
// Wrap an arbitrary body in a valid (magic + bodyLen) frame header, so decode
// faults come purely from the body, not the framer.
const framed = (body: Buffer, verb = VERB.RECORDS, flags = 0): Buffer => {
  const buf = Buffer.allocUnsafe(HEADER + body.length)
  buf[0] = MAGIC
  buf[1] = flags
  buf[2] = verb
  buf.writeUInt32LE(body.length, 3)
  body.copy(buf, HEADER)
  return buf
}
// LEB128 unsigned varint as bytes (mirrors the encoder, for hand-built bodies).
const varint = (v: number): number[] => {
  const out: number[] = []
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

test('record count exceeding the body throws (no giant allocation)', () => {
  // body = a single varint claiming 2^28 records, then nothing. The old code did
  // `new Array(2^28)` and looped — OOM/hang. Must reject in O(1) instead.
  const body = Buffer.from(varint(1 << 28))
  assert.throws(() => decodeFrame(framed(body)).records(), FrameError)
  assert.throws(() => decodeFrame(framed(body)).records(), /record count .* exceeds/)
})

test('record length overrunning the body throws', () => {
  // count = 1, recLen = 1000, but only a couple of body bytes remain.
  const body = Buffer.from([...varint(1), ...varint(1000), 0x00, 0x00])
  assert.throws(() => decodeFrame(framed(body)).records(), FrameError)
  assert.throws(() => decodeFrame(framed(body)).records(), /overruns/)
})

test('oversized bodyLen header is rejected immediately (no unbounded buffering)', () => {
  // A 7-byte header alone, claiming a ~4 GiB body. The framer must reject on the
  // header — not stash it as `carry` and wait for 4 GiB that never comes.
  const header = Buffer.allocUnsafe(HEADER)
  header[0] = MAGIC
  header[1] = 0
  header[2] = VERB.RECORDS
  header.writeUInt32LE(0xffffffff, 3)
  assert.throws(() => new Framer().push(header), FrameError)
  assert.throws(() => new Framer().push(header), /exceeds max/)
})

test('per-Framer maxFrame caps even an in-range body', () => {
  const big = encodeFrame([{ type: 'update', key: ['x'], value: 'a'.repeat(100) }])
  assert.ok(big.length - HEADER > 16)
  assert.throws(() => new Framer({ maxFrame: 16 }).push(big), FrameError)
  // the default framer accepts the same frame
  assert.equal(new Framer().push(big).length, 1)
})

test('reserved value-type nibble throws on value read', () => {
  for (const vt of [7, 9, 15]) {
    // one record: tag = update | (vt << 4); empty key (nseg=0); no value bytes.
    const rec = [vt << 4, 0x00]
    const body = Buffer.from([...varint(1), ...varint(rec.length), ...rec])
    const r = decodeFrame(framed(body)).records()[0]
    assert.equal(r.type, 'update') // type/key still readable
    assert.throws(() => r.value, FrameError, `vtype ${vt}`)
    assert.throws(() => r.value, /reserved value type/, `vtype ${vt}`)
  }
})

test('key segment count exceeding the record throws on key read', () => {
  // tag = update/null; nseg = 1000; record ends → no segment-length bytes.
  const rec = [0x00, ...varint(1000)]
  const body = Buffer.from([...varint(1), ...varint(rec.length), ...rec])
  const r = decodeFrame(framed(body)).records()[0]
  assert.throws(() => r.key, FrameError)
})

test('truncated f64 value throws FrameError, not a raw RangeError', () => {
  // tag = update | (f64 << 4) = 0x50; empty key; zero value bytes (needs 8).
  const rec = [0x50, 0x00]
  const body = Buffer.from([...varint(1), ...varint(rec.length), ...rec])
  const r = decodeFrame(framed(body)).records()[0]
  assert.throws(() => r.value, FrameError)
})

test('invalid JSON in an object value throws FrameError, not SyntaxError', () => {
  // tag = update | (obj << 4) = 0x80; empty key; obj value = len 3, bytes "{[}".
  const bad = Buffer.from('{[}')
  const rec = [0x80, 0x00, ...varint(bad.length), ...bad]
  const body = Buffer.from([...varint(1), ...varint(rec.length), ...rec])
  const r = decodeFrame(framed(body)).records()[0]
  assert.throws(() => r.value, FrameError)
})

test('a header-only chunk yields no frames and does not throw (graceful wait)', () => {
  const buf = encodeFrame([{ type: 'update', key: ['x'], value: 1 }])
  const framer = new Framer()
  assert.deepEqual(framer.push(buf.subarray(0, 4)), []) // partial header → wait
  const frames = framer.push(buf.subarray(4)) // rest arrives
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].records()[0].toJSON(), { type: 'update', key: ['x'], value: 1 })
})

// Seeded LCG so the fuzz is reproducible (no Math.random nondeterminism).
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

test('fuzz: thousands of random valid records round-trip (bounds never false-positive)', () => {
  const rand = rng(0xc0ffee)
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const types = ['update', 'insert', 'remove'] as const
  const randValue = (): unknown => {
    switch (Math.floor(rand() * 9)) {
      case 0: return null
      case 1: return undefined
      case 2: return rand() < 0.5
      case 3: return Math.floor((rand() - 0.5) * 4_000_000_000) // int32-ish
      case 4: return (rand() - 0.5) * 1e9 // f64
      case 5: return 'str ' + 'üé🚀'.repeat(Math.floor(rand() * 6))
      case 6: return { name: 'u' + Math.floor(rand() * 1000), active: rand() < 0.5, score: Math.floor(rand() * 1e6) }
      case 7: return [1, 'two', { three: rand() }]
      default: return Math.floor(rand() * 1e6)
    }
  }
  for (let n = 0; n < 3000; n++) {
    const rec: ChangeRecord = { type: pick(types), key: Array.from({ length: Math.floor(rand() * 4) }, (_, i) => 'k' + i), value: randValue() }
    if (rand() < 0.3) rec.at = 'at' + Math.floor(rand() * 100)
    assert.deepEqual(recordsOf(encodeFrame([rec])), [rec], JSON.stringify(rec))
  }
})

test('fuzz: single-byte corruption of valid frames never crashes (FrameError or clean decode)', () => {
  const rand = rng(0x1234abcd)
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['users', '42'], value: { name: 'P', active: true, score: 7 } },
    { type: 'insert', key: [], value: { id: 1 }, at: 'user99' },
    { type: 'remove', key: ['gone'], value: undefined },
    { type: 'update', key: ['n'], value: 3.14159 },
  ]
  const clean = encodeFrame(batch, { origin: 'node-A', seq: 5, epoch: 2 })
  for (let trial = 0; trial < 4000; trial++) {
    const buf = Buffer.from(clean) // copy
    const pos = Math.floor(rand() * buf.length)
    buf[pos] = (buf[pos] + 1 + Math.floor(rand() * 255)) & 0xff // flip a byte
    try {
      // force a FULL parse of every field — the only way corruption surfaces
      for (const f of new Framer().push(buf)) for (const r of f.records()) void r.toJSON()
    } catch (e) {
      // The contract: any decode fault is a typed FrameError (→ peer dropped),
      // never a raw RangeError/SyntaxError/TypeError that would crash the process.
      assert.ok(e instanceof FrameError, `corruption at ${pos} threw ${(e as Error).constructor.name}: ${(e as Error).message}`)
    }
  }
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

// ── review hardening: truncated-varint loudness, unserializable values, frame-size bounds ──

test('a truncated provenance varint throws FrameError, never silently decodes garbage seq/epoch', () => {
  // baseSeq/epoch had no following bounds use, so a frame cut mid-varint silently produced a
  // wrong seq (dedup corruption). Build a prov frame, then truncate THROUGH the epoch varint:
  // bodyLen must stay consistent so the framer yields the frame and the prov scan does the cut.
  const buf = encodeFrame([{ type: 'update', key: ['k'], value: 1 }], { origin: 'O', seq: 300, epoch: 70000 })
  // find how many bytes the prov ext occupies: origin(1len+1) + baseSeq(2) + epoch(3) — cut inside it
  for (let cut = 1; cut <= 3; cut++) {
    const short = Buffer.from(buf.subarray(0, buf.length - (buf.length - 7 - 2 - 2 - cut))) // keep header+origin+partial varints
    short.writeUInt32LE(short.length - 7, 3) // re-stamp bodyLen so the framer accepts the truncated body
    short[short.length - 1] |= 0x80 // force a continuation bit on the LAST byte → varint runs off the end
    const f = decodeFrame(short)
    assert.throws(() => f.origin, FrameError, `cut ${cut}: truncated provenance must be loud`)
  }
})

test('a truncated VT.int value throws FrameError like str/obj, never a silent wrong value', () => {
  const buf = encodeFrame([{ type: 'update', key: ['k'], value: 1000000 }]) // multi-byte int varint
  const records = decodeFrame(buf).records()
  const whole = records[0].toJSON()
  assert.equal(whole.value, 1000000) // sanity: intact decodes fine
  // rebuild the frame with the record's LAST value byte chopped + recLen shrunk accordingly:
  // simplest robust approach — flip the continuation bit on the final byte so the varint
  // claims more bytes than the record holds
  const corrupt = Buffer.from(buf)
  corrupt[corrupt.length - 1] |= 0x80
  const r = decodeFrame(corrupt).records()[0]
  assert.throws(() => r.value, FrameError, 'truncated int value must be loud')
})

test('encodeFrames skips an unserializable record LOUDLY; the rest of the batch still ships', () => {
  const big = { huge: 1n } as any // JSON.stringify throws on BigInt
  const batch: ChangeRecord[] = [
    { type: 'update', key: ['a'], value: 1, origin: 'O', seq: 1, epoch: 1 },
    { type: 'update', key: ['poison'], value: big, origin: 'O', seq: 2, epoch: 1 },
    { type: 'update', key: ['c'], value: 3, origin: 'O', seq: 3, epoch: 1 },
  ]
  const errors: string[] = []
  const orig = console.error
  console.error = (msg: string) => errors.push(String(msg))
  let frames: Buffer[]
  try {
    frames = encodeFrames(batch)
  } finally {
    console.error = orig
  }
  // the two healthy records shipped (as single-record frames after the fallback), in order
  const out = frames!.flatMap((b) => decodeFrame(b).records().map((r) => r.toJSON()))
  assert.deepEqual(out.map((r) => r.key[0]), ['a', 'c'], 'healthy records still ship in order')
  assert.deepEqual(out.map((r) => r.seq), [1, 3], 'each kept its own provenance (single-record frames)')
  assert.equal(errors.length, 1, 'the poison was reported exactly once')
  assert.ok(errors[0].includes('poison'), 'the report names the key')
})

test('encodeFrames caps a contiguous run at MAX_RUN records (no giant single frame)', () => {
  const n = 10000 // > the 8192 run cap
  const batch: ChangeRecord[] = Array.from({ length: n }, (_, i) => ({ type: 'update' as const, key: ['k' + i], value: i, origin: 'O', seq: i + 1, epoch: 1 }))
  const frames = encodeFrames(batch)
  assert.equal(frames.length, 2, 'one contiguous run splits at the cap')
  const all = frames.flatMap((b) => decodeFrame(b).records().map((r) => r.toJSON()))
  assert.equal(all.length, n, 'every record shipped')
  assert.equal(all[0].seq, 1)
  assert.equal(all[n - 1].seq, n, 'base+index provenance holds across the split')
})

test('encodeFrame fails loudly on a >MAX_FRAME body (encoder-side mirror of the receiver bound)', () => {
  // one record whose value alone exceeds 256MiB would be rejected by every receiver and loop
  // a reconnect; the encoder now throws a clear local error instead. Use a sparse giant string.
  const giant = 'x'.repeat(257 * 1024 * 1024)
  assert.throws(
    () => encodeFrame([{ type: 'update', key: ['k'], value: giant }]),
    /exceeds MAX_FRAME/,
    'a clear encoder-side error, not a receiver-side peer drop',
  )
})
