// L0 wire codec + framer — the hottest file in the repo.
//
// fero's foundational hypothesis (proven by the day-0 spike): a `data` change record
// — { type, key:string[], value, at? } — IS the wire format. message.ts makes
// that binary: it encodes a *batch* of change records into one length-prefixed
// frame, and decodes an inbound frame into lazy `RecordView`s that parse only the
// fields actually read. A record relayed onward (router/replica) is re-sliced
// and re-sent untouched — zero key/value parse on the relay path.
//
// Design (see plan.md §9 + the L0 design): rethink, not reskin of fero-old's
// message.js. Kept: length-prefix framing, a 1-byte verb, lazy getter-backed
// deserialise, microtask-batched writes. Fixed: no JSON on keys, no 255-byte
// key cap, scalars encoded inline (not stringified), little-endian (single
// native load on x64/arm64), frame-at-a-time receive (one readUInt32LE, not a
// byte loop). Object *values* still use JSON in v1 — behind the encodeValue/
// decodeValue seam, swappable for CBOR/a data-owned binary form once
// message.perf.ts says it matters. Key prefix-delta + a columnar body are
// reserved behind flag bits; NOT built in this first cut.
//
// All multi-byte integers are little-endian. Record interior uses LEB128
// varint (1 byte for the < 128 common case). Frame `bodyLen` is a fixed u32 so
// the framer never loops to find a frame boundary.

const MAGIC = 0xfe // protocol marker + version. v1 = 0xFE; bumped on wire change.

// frame flags (byte 1)
const FLAG_HAS_ID = 1 << 0 // a u48 stream/ack id follows the header
const FLAG_COL = 1 << 1 // RESERVED — columnar body (not emitted in v1)
const FLAG_UNIFORM = 1 << 2 // RESERVED — fixed-width batch (not emitted in v1)
const FLAG_PROV = 1 << 3 // provenance: body opens with [origin str][baseSeq varint]
// before the record count. Records in a prov frame are ONE origin's consecutive
// writes (seq = baseSeq + index) — see peer.ts flush() (one tick, own writes
// only, no relay). L1/L2 use this for dedup, anti-entropy catch-up, and LWW.

// frame verbs (byte 2) — dense enum → flat dispatch, not this[command]
export const VERB = {
  RECORDS: 1,
  ACK: 2,
  INIT: 3,
  SYNC: 4,
  DONE: 5,
  RESOLVE: 6, // RPC reply: { value } for the call with this frame's id
  REJECT: 7, // RPC reply: { error } for the call with this frame's id
  DIGEST: 8, // anti-entropy: a peer's per-origin high-water vector (catch-up)
  CALL: 9, // RPC request: { method, arg }; frame id correlates the reply
  SUBSCRIBE: 10, // live subscription open: { method, arg }; frame id is the sub id
  UNSUBSCRIBE: 11, // close the subscription with this frame id
  WRITE: 12, // forward a write-request to the partition owner; owner commits it locally (origin=owner) and replicates
  PING: 13, // liveness probe (empty body); the peer answers PONG. Failure detector — see peer.ts
  PONG: 14, // liveness reply to a PING (empty body)
  // a RECORDS frame WITH a frame id is a subscription delta for that sub id (vs a
  // plain replication RECORDS frame, which carries no id)
} as const

// record tag (byte 0 of each record): bits 0-1 type, bit2 hasAt, bit3 keyDelta
// (RESERVED), bits 4-7 vtype.
const TYPE = { update: 0, insert: 1, remove: 2, move: 3 } as const
const TYPE_NAME = ['update', 'insert', 'remove', 'move'] as const
const HAS_AT = 1 << 2
// const KEY_DELTA = 1 << 3  // RESERVED for prefix-delta keys (deferred)

// value-type nibble (tag bits 4-7). Scalars 0-3 carry zero value bytes.
const VT = {
  null: 0,
  undefined: 1,
  false: 2,
  true: 3,
  int: 4, // zigzag varint (int32 range)
  f64: 5, // 8 bytes LE (all other numbers, incl. NaN/Infinity/>2^31)
  str: 6, // varint len + utf8
  obj: 8, // varint len + JSON utf8 (the encodeValue seam)
} as const

const HEADER = 7 // MAGIC + flags + verb + bodyLen:u32
const ID_LEN = 6 // u48 stream/ack id (plain Number; no BigInt on the ack path)
const EMPTY = Buffer.allocUnsafe(0)

export type ChangeRecord = {
  type: 'update' | 'insert' | 'remove' | 'move'
  key: string[]
  value?: unknown
  at?: string
  origin?: string // provenance: the uuid of the node that originated the write
  seq?: number // provenance: that origin's per-node monotonic sequence number
}

// The partition a change record belongs to — its top-level key, or `at` for a
// root insert (the BI0 first-write case, where the logical key lives in `at`).
// Used by L0 to route to an owner and by L1 to segment the log.
export const partitionOf = (record: { key: string[]; at?: string }): string =>
  record.key.length ? record.key[0] : (record.at ?? '')

// ─────────────────────────────────────────── varint (LEB128, unsigned ≤ 2^32)

const varintSize = (v: number) => {
  let n = 1
  while (v > 0x7f) {
    v >>>= 7
    n++
  }
  return n
}

// ─────────────────────────────────────────── Writer (growable encode buffer)

// A growable scratch buffer. The per-peer outbox path (peer.ts) will serialize
// straight into a preallocated buffer with no growth; this Writer backs the
// standalone encodeFrame() used by tests, handshake, and the slow-start path.
class Writer {
  buf: Buffer
  off = 0
  constructor(cap = 256) {
    this.buf = Buffer.allocUnsafe(cap)
  }
  private ensure(n: number) {
    if (this.off + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.off + n) cap *= 2
    const next = Buffer.allocUnsafe(cap)
    this.buf.copy(next, 0, 0, this.off)
    this.buf = next
  }
  u8(v: number) {
    this.ensure(1)
    this.buf[this.off++] = v
  }
  varint(v: number) {
    this.ensure(5)
    const b = this.buf
    let o = this.off
    while (v > 0x7f) {
      b[o++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    b[o++] = v
    this.off = o
  }
  f64(v: number) {
    this.ensure(8)
    this.buf.writeDoubleLE(v, this.off)
    this.off += 8
  }
  // varint length-prefixed utf8. byteLen passed in to avoid recomputing it.
  str(s: string, byteLen: number) {
    this.varint(byteLen)
    this.ensure(byteLen)
    this.buf.write(s, this.off, 'utf8')
    this.off += byteLen
  }
}

// ─────────────────────────────────────────── value codec (the swappable seam)

const classify = (v: unknown): number => {
  if (v === null) return VT.null
  if (v === undefined) return VT.undefined
  switch (typeof v) {
    case 'boolean':
      return v ? VT.true : VT.false
    case 'number':
      return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? VT.int : VT.f64
    case 'string':
      return VT.str
    default:
      return VT.obj
  }
}

const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0
const unzigzag = (z: number) => (z >>> 1) ^ -(z & 1)

// ─────────────────────────────────────────── record sizing + write

const keySize = (key: string[]) => {
  let n = varintSize(key.length)
  for (let i = 0; i < key.length; i++) {
    const bl = Buffer.byteLength(key[i])
    n += varintSize(bl) + bl
  }
  return n
}

// ─────────────────────────────────────────── encode a frame

// Encode change records into one RECORDS frame (one logical socket.write batch).
// `id` (optional) writes a u48 stream/ack id into the header. Provenance
// (`origin`+`seq`) is written when given explicitly OR carried on records[0];
// the body then opens with [origin str][baseSeq varint] and every record's seq
// is baseSeq + its index (records must be that origin's consecutive writes).
export function encodeFrame(
  records: ChangeRecord[],
  { verb = VERB.RECORDS, id, origin, seq }: { verb?: number; id?: number; origin?: string; seq?: number } = {},
): Buffer {
  const provOrigin = origin ?? records[0]?.origin
  const baseSeq = seq ?? records[0]?.seq ?? 0
  const hasProv = provOrigin !== undefined
  const hasId = id !== undefined
  const headerLen = HEADER + (hasId ? ID_LEN : 0)
  const w = new Writer(headerLen + 16 + records.length * 24)
  w.off = headerLen // reserve the header; backfilled once bodyLen is known
  if (hasProv) {
    w.str(provOrigin!, Buffer.byteLength(provOrigin!))
    w.varint(baseSeq)
  }
  w.varint(records.length)

  for (let r = 0; r < records.length; r++) {
    const record = records[r]
    const value = record.value
    const vtype = classify(value)
    const json = vtype === VT.obj ? JSON.stringify(value) : undefined
    const hasAt = record.at !== undefined
    const at = hasAt ? '' + record.at : ''
    const atBl = hasAt ? Buffer.byteLength(at) : 0

    // size: tag + key + [at] + value — so we can write recLen up front (O(1)
    // lazy slice on decode).
    let size = 1 + keySize(record.key)
    if (hasAt) size += varintSize(atBl) + atBl
    if (vtype === VT.int) size += varintSize(zigzag(value as number))
    else if (vtype === VT.f64) size += 8
    else if (vtype === VT.str) {
      const bl = Buffer.byteLength(value as string)
      size += varintSize(bl) + bl
    } else if (vtype === VT.obj) {
      const bl = Buffer.byteLength(json!)
      size += varintSize(bl) + bl
    }

    w.varint(size)
    w.u8((TYPE[record.type] ?? TYPE.update) | (hasAt ? HAS_AT : 0) | (vtype << 4))

    // key
    w.varint(record.key.length)
    for (let i = 0; i < record.key.length; i++) w.str(record.key[i], Buffer.byteLength(record.key[i]))

    if (hasAt) w.str(at, atBl)

    // value (scalars 0-3 are tag-only)
    if (vtype === VT.int) w.varint(zigzag(value as number))
    else if (vtype === VT.f64) w.f64(value as number)
    else if (vtype === VT.str) w.str(value as string, Buffer.byteLength(value as string))
    else if (vtype === VT.obj) w.str(json!, Buffer.byteLength(json!))
  }

  const bodyLen = w.off - headerLen
  const b = w.buf
  b[0] = MAGIC
  b[1] = (hasId ? FLAG_HAS_ID : 0) | (hasProv ? FLAG_PROV : 0)
  b[2] = verb
  b.writeUInt32LE(bodyLen, 3)
  if (hasId) b.writeUIntLE(id!, HEADER, ID_LEN)
  return b.subarray(0, w.off)
}

// Encode a batch that may mix origins — splitting it into the fewest frames each
// of which satisfies the single-origin, contiguous-seq invariant base+index
// relies on. A run breaks when the origin changes or the seq isn't the previous
// + 1 (Lamport gaps split). Provenance-less records (origin undefined) group
// into one frame. Used by the per-peer outbox (own writes batch into ONE frame;
// relayed records from other origins split cleanly) and by catch-up shipping.
export function encodeFrames(records: ChangeRecord[]): Buffer[] {
  const frames: Buffer[] = []
  let i = 0
  while (i < records.length) {
    const origin = records[i].origin
    let j = i + 1
    if (origin === undefined) while (j < records.length && records[j].origin === undefined) j++
    else while (j < records.length && records[j].origin === origin && records[j].seq === (records[j - 1].seq ?? 0) + 1) j++
    frames.push(encodeFrame(records.slice(i, j), origin !== undefined ? { origin, seq: records[i].seq } : {}))
    i = j
  }
  return frames
}

// ─────────────────────────────────────────── Framer (receive, straddle-safe)

// One per peer. push(chunk) returns the complete frames in the stream so far;
// a frame split across chunks is retained as `carry` (one subarray, no per-byte
// copy) until the rest arrives. Concat happens only when a frame straddles.
export class Framer {
  private carry: Buffer = EMPTY
  push(chunk: Buffer): Frame[] {
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const frames: Frame[] = []
    let off = 0
    while (buf.length - off >= HEADER) {
      if (buf[off] !== MAGIC) throw new Error(`fero: bad frame magic 0x${buf[off].toString(16)}`)
      const flags = buf[off + 1]
      const bodyLen = buf.readUInt32LE(off + 3) // ONE load, not four shift-adds
      const idLen = flags & FLAG_HAS_ID ? ID_LEN : 0
      const need = HEADER + idLen + bodyLen
      if (buf.length - off < need) break // straddle → stash the tail below
      frames.push(new Frame(buf.subarray(off, off + need))) // zero-copy view
      off += need
    }
    this.carry = off < buf.length ? buf.subarray(off) : EMPTY
    return frames
  }
}

// Decode a single complete frame (test/handshake convenience). Throws if `buf`
// holds more or less than exactly one frame.
export function decodeFrame(buf: Buffer): Frame {
  const f = new Framer().push(buf)
  if (f.length !== 1) throw new Error(`fero: expected exactly one frame, got ${f.length}`)
  return f[0]
}

export class Frame {
  buf: Buffer
  constructor(buf: Buffer) {
    this.buf = buf
  }
  get flags() {
    return this.buf[1]
  }
  get verb() {
    return this.buf[2]
  }
  get id(): number | undefined {
    return this.buf[1] & FLAG_HAS_ID ? this.buf.readUIntLE(HEADER, ID_LEN) : undefined
  }
  private get afterId() {
    return HEADER + (this.buf[1] & FLAG_HAS_ID ? ID_LEN : 0)
  }
  // Parse the provenance ext ([origin str][baseSeq varint]) if FLAG_PROV is set.
  // Returns the origin, the base sequence, and the offset where the record count
  // begins. When there's no provenance, origin is undefined and off = afterId.
  #prov?: { origin?: string; baseSeq: number; off: number }
  private prov(): { origin?: string; baseSeq: number; off: number } {
    if (this.#prov) return this.#prov
    const buf = this.buf
    let off = this.afterId
    if (!(buf[1] & FLAG_PROV)) return (this.#prov = { baseSeq: 0, off })
    let len = 0
    let shift = 0
    let b: number
    do {
      b = buf[off++]
      len |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    const origin = buf.toString('utf8', off, off + len)
    off += len
    let baseSeq = 0
    shift = 0
    do {
      b = buf[off++]
      baseSeq |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return (this.#prov = { origin, baseSeq: baseSeq >>> 0, off })
  }

  get origin(): string | undefined {
    return this.prov().origin
  }
  get baseSeq(): number {
    return this.prov().baseSeq
  }

  // Lazy: walk `count` recLen varints and slice a RecordView per record. No key
  // or value parse — that happens only when a RecordView field is read. When the frame
  // carries provenance, each RecordView is stamped with origin + (baseSeq + index).
  records(): RecordView[] {
    const buf = this.buf
    const { origin, baseSeq, off: start } = this.prov()
    let off = start
    let count = 0
    let shift = 0
    let b: number
    do {
      b = buf[off++]
      count |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    const out: RecordView[] = new Array(count >>> 0)
    for (let i = 0; i < out.length; i++) {
      let len = 0
      shift = 0
      do {
        b = buf[off++]
        len |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      const record = new RecordView(buf.subarray(off, off + len))
      if (origin !== undefined) {
        record.origin = origin
        record.seq = baseSeq + i
      }
      out[i] = record
      off += len
    }
    return out
  }
}

// ─────────────────────────────────────────── RecordView (lazy decoded record)

// Mirrors a `data` change record but parses on access. `type` is one byte;
// `key`/`at`/`value` are decoded (and memoised) only when read. The terminal
// res.update/insert/remove(value, key, at) call (replicate.ts) is the only
// place that forces a full parse, and only of the fields it reads.
export class RecordView {
  #buf: Buffer
  #type?: ChangeRecord['type']
  #key?: string[]
  #at?: string
  #value?: unknown
  #valueParsed = false
  #scanned = false
  #hasAt = false
  #atStart = 0
  #atEnd = 0
  #valStart = 0

  // Provenance, stamped by Frame.records() when the frame carries it (else undefined).
  origin?: string
  seq?: number

  constructor(buf: Buffer) {
    this.#buf = buf
  }

  get type(): ChangeRecord['type'] {
    return (this.#type ??= TYPE_NAME[this.#buf[0] & 3])
  }

  // Locate field boundaries once (no utf8 decode, no value parse) so at/value
  // getters know where to slice.
  #scan() {
    if (this.#scanned) return
    const buf = this.#buf
    let off = 1
    let shift = 0
    let b: number
    let nseg = 0
    do {
      b = buf[off++]
      nseg |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    for (let i = 0; i < nseg; i++) {
      let l = 0
      shift = 0
      do {
        b = buf[off++]
        l |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      off += l
    }
    this.#hasAt = (buf[0] & HAS_AT) !== 0
    if (this.#hasAt) {
      let l = 0
      shift = 0
      do {
        b = buf[off++]
        l |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      this.#atStart = off
      off += l
      this.#atEnd = off
    }
    this.#valStart = off
    this.#scanned = true
  }

  get key(): string[] {
    if (this.#key) return this.#key
    const buf = this.#buf
    let off = 1
    let shift = 0
    let b: number
    let nseg = 0
    do {
      b = buf[off++]
      nseg |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    const key: string[] = new Array(nseg)
    for (let i = 0; i < nseg; i++) {
      let l = 0
      shift = 0
      do {
        b = buf[off++]
        l |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      key[i] = buf.toString('utf8', off, off + l)
      off += l
    }
    return (this.#key = key)
  }

  get at(): string | undefined {
    this.#scan()
    if (!this.#hasAt) return undefined
    return (this.#at ??= this.#buf.toString('utf8', this.#atStart, this.#atEnd))
  }

  get value(): unknown {
    if (this.#valueParsed) return this.#value
    this.#scan()
    const buf = this.#buf
    const vtype = buf[0] >> 4
    let off = this.#valStart
    let v: unknown
    let shift = 0
    let b: number
    switch (vtype) {
      case VT.null:
        v = null
        break
      case VT.undefined:
        v = undefined
        break
      case VT.false:
        v = false
        break
      case VT.true:
        v = true
        break
      case VT.int: {
        let z = 0
        do {
          b = buf[off++]
          z |= (b & 0x7f) << shift
          shift += 7
        } while (b & 0x80)
        v = unzigzag(z >>> 0)
        break
      }
      case VT.f64:
        v = buf.readDoubleLE(off)
        break
      case VT.str: {
        let l = 0
        do {
          b = buf[off++]
          l |= (b & 0x7f) << shift
          shift += 7
        } while (b & 0x80)
        v = buf.toString('utf8', off, off + l)
        break
      }
      case VT.obj: {
        let l = 0
        do {
          b = buf[off++]
          l |= (b & 0x7f) << shift
          shift += 7
        } while (b & 0x80)
        v = JSON.parse(buf.toString('utf8', off, off + l))
        break
      }
    }
    this.#valueParsed = true
    return (this.#value = v)
  }

  // Plain-object snapshot — the inverse of a `data` change record.
  toJSON(): ChangeRecord {
    const out: ChangeRecord = { type: this.type, key: this.key, value: this.value }
    if (this.at !== undefined) out.at = this.at
    if (this.origin !== undefined) {
      out.origin = this.origin
      out.seq = this.seq
    }
    return out
  }
}
