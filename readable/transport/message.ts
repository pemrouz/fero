// L0 wire codec + framer — encode a batch of change records to a length-prefixed frame; decode to lazy RecordViews.

const MAGIC = 0xfe // protocol marker + version. v1 = 0xFE; bumped on wire change.

// ── frame flags (byte 1) ──
const FLAG_HAS_ID = 1 << 0
const FLAG_COL = 1 << 1
const FLAG_UNIFORM = 1 << 2
const FLAG_PROV = 1 << 3 // provenance: body opens with [origin str][baseSeq varint]

// frame verbs (byte 2) — dense enum → flat dispatch, not this[command]
export const VERB = {
  RECORDS: 1,
  ACK: 2,
  INIT: 3,
  SYNC: 4,
  DONE: 5,
  RESOLVE: 6,
  REJECT: 7,
  DIGEST: 8,
  CALL: 9,
  SUBSCRIBE: 10,
  UNSUBSCRIBE: 11,
  WRITE: 12,
  PING: 13,
  PONG: 14,
  VIEW_PREPARE: 15,
  VIEW_ACK: 16,
  VIEW_COMMIT: 17,
  JOIN_REQUEST: 18,
  REPL_PROBE: 19,
  REPL_ACK: 20,
} as const

// record tag (byte 0 of each record): bits 0-1 type, bit2 hasAt, bit3 keyDelta (RESERVED), bits 4-7 vtype.
const TYPE = { update: 0, insert: 1, remove: 2, move: 3 } as const
const TYPE_NAME = ['update', 'insert', 'remove', 'move'] as const
const HAS_AT = 1 << 2

// value-type nibble (tag bits 4-7). Scalars 0-3 carry zero value bytes.
const VT = {
  null: 0,
  undefined: 1,
  false: 2,
  true: 3,
  int: 4,
  f64: 5,
  str: 6,
  obj: 8,
} as const

const HEADER = 7
const ID_LEN = 6
const EMPTY = Buffer.allocUnsafe(0)

// hard ceiling on a frame body — bound it so one bad header can't grow `carry` to OOM (overridable per-Framer).
const MAX_FRAME = 256 * 1024 * 1024

// wire-fault error — distinct type so the peer drops the connection without swallowing real handler/apply bugs.
export class FrameError extends Error {
  constructor(message: string) {
    super(`fero: ${message}`)
    this.name = 'FrameError'
  }
}

// a `data` change record + optional provenance (origin/seq/epoch) — the in-memory shape the wire mirrors.
export type ChangeRecord = {
  type: 'update' | 'insert' | 'remove' | 'move'
  key: string[]
  value?: unknown
  at?: string
  origin?: string
  seq?: number
  epoch?: number
}

// partition of a record — top-level key, or `at` for a root insert (BI0); used to route + segment the log.
export const partitionOf = (record: { key: string[]; at?: string }): string =>
  record.key.length ? record.key[0] : (record.at ?? '')

// ─────────────────────────────────────────── varint (LEB128, unsigned ≤ 2^32)

// byte count for a varint (precompute recLen so decode is an O(1) slice).
const varintSize = (v: number) => {
  let n = 1
  while (v > 0x7f) {
    v >>>= 7
    n++
  }
  return n
}

// ─────────────────────────────────────────── Writer (growable encode buffer)

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

// pick a value's VT nibble — null/undef/bool/int/f64/str inline; everything else → obj (JSON seam).
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

// zigzag map signed int ↔ unsigned varint so small negatives stay 1 byte.
const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0
const unzigzag = (z: number) => (z >>> 1) ^ -(z & 1)

// ─────────────────────────────────────────── record sizing + write

// encoded byte count of a key (segment count + per-segment len-prefixed utf8).
const keySize = (key: string[]) => {
  let n = varintSize(key.length)
  for (let i = 0; i < key.length; i++) {
    const bl = Buffer.byteLength(key[i])
    n += varintSize(bl) + bl
  }
  return n
}

// ─────────────────────────────────────────── encode a frame

// encode a batch into one frame — optional u48 id + provenance ext (origin/baseSeq/epoch), seq = base+index.
export function encodeFrame(
  records: ChangeRecord[],
  { verb = VERB.RECORDS, id, origin, seq, epoch }: { verb?: number; id?: number; origin?: string; seq?: number; epoch?: number } = {},
): Buffer {
  const provOrigin = origin ?? records[0]?.origin
  const baseSeq = seq ?? records[0]?.seq ?? 0
  const provEpoch = epoch ?? records[0]?.epoch ?? 0
  const hasProv = provOrigin !== undefined
  const hasId = id !== undefined
  const headerLen = HEADER + (hasId ? ID_LEN : 0)
  const w = new Writer(headerLen + 16 + records.length * 24)
  w.off = headerLen // reserve the header; backfilled once bodyLen is known
  if (hasProv) {
    w.str(provOrigin!, Buffer.byteLength(provOrigin!))
    w.varint(baseSeq)
    w.varint(provEpoch)
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

    // size the record up front (tag + key + [at] + value) so recLen is written before the body — O(1) decode slice.
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

    w.varint(record.key.length)
    for (let i = 0; i < record.key.length; i++) w.str(record.key[i], Buffer.byteLength(record.key[i]))

    if (hasAt) w.str(at, atBl)

    if (vtype === VT.int) w.varint(zigzag(value as number))
    else if (vtype === VT.f64) w.f64(value as number)
    else if (vtype === VT.str) w.str(value as string, Buffer.byteLength(value as string))
    else if (vtype === VT.obj) w.str(json!, Buffer.byteLength(json!))
  }

  const bodyLen = w.off - headerLen
  // encoder-side mirror of the framer's MAX_FRAME bound: fail HERE with a clear error, not on the receiver as a peer-drop.
  if (bodyLen > MAX_FRAME) throw new Error(`fero: encoded frame body ${bodyLen} exceeds MAX_FRAME ${MAX_FRAME} — split the batch or shrink the value`)
  const b = w.buf
  b[0] = MAGIC
  b[1] = (hasId ? FLAG_HAS_ID : 0) | (hasProv ? FLAG_PROV : 0)
  b[2] = verb
  b.writeUInt32LE(bodyLen, 3)
  if (hasId) b.writeUIntLE(id!, HEADER, ID_LEN)
  return b.subarray(0, w.off)
}

// a CONTROL frame = one record whose value IS the payload — the shape every non-data verb uses (decode via Frame.value).
export const controlFrame = (verb: number, value: unknown, id?: number): Buffer =>
  encodeFrame([{ type: 'update', key: [], value }], { verb, id })

// split a mixed-origin batch into the fewest frames each holding one origin's contiguous-seq, one-epoch run.
// cap a run's record count so one catch-up of a huge log can't build a frame past the receiver's MAX_FRAME bound.
const MAX_RUN = 8192

export function encodeFrames(records: ChangeRecord[]): Buffer[] {
  const frames: Buffer[] = []
  let i = 0
  while (i < records.length) {
    const origin = records[i].origin
    const epoch = records[i].epoch
    const cap = i + MAX_RUN
    let j = i + 1
    if (origin === undefined) while (j < cap && j < records.length && records[j].origin === undefined) j++
    // extend the run while same origin + seq == prev+1 + same epoch — break on any of the three (or the size cap).
    else while (j < cap && j < records.length && records[j].origin === origin && records[j].seq === (records[j - 1].seq ?? 0) + 1 && records[j].epoch === epoch) j++
    const opts = origin !== undefined ? { origin, seq: records[i].seq, epoch } : {}
    try {
      frames.push(encodeFrame(records.slice(i, j), opts))
    } catch (e) {
      // a poisonous record (BigInt/Symbol value JSON.stringify rejects, or one giant value) must not crash the flush microtask or sink the whole batch.
      for (let k = i; k < j; k++) {
        try {
          frames.push(encodeFrame([records[k]], records[k].origin !== undefined ? { origin: records[k].origin, seq: records[k].seq, epoch: records[k].epoch } : {}))
        } catch (err) {
          console.error(`fero/transport: dropping unserializable record (key=${JSON.stringify(records[k].key)}): ${(err as Error)?.message ?? err}`)
        }
      }
    }
    i = j
  }
  return frames
}

// ─────────────────────────────────────────── Framer (receive, straddle-safe)

// one per peer — push(chunk) returns complete frames; a split frame is held as `carry` (concat only on straddle).
export class Framer {
  private carry: Buffer = EMPTY
  private maxFrame: number
  constructor(opts: { maxFrame?: number } = {}) {
    this.maxFrame = opts.maxFrame ?? MAX_FRAME
  }
  push(chunk: Buffer): Frame[] {
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const frames: Frame[] = []
    let off = 0
    while (buf.length - off >= HEADER) {
      if (buf[off] !== MAGIC) throw new FrameError(`bad frame magic 0x${buf[off].toString(16)}`)
      const flags = buf[off + 1]
      const bodyLen = buf.readUInt32LE(off + 3) // ONE load, not four shift-adds
      // bound the body BEFORE the straddle check — else a huge-body header grows `carry` unbounded.
      if (bodyLen > this.maxFrame) throw new FrameError(`frame body ${bodyLen} exceeds max ${this.maxFrame}`)
      const idLen = flags & FLAG_HAS_ID ? ID_LEN : 0
      const need = HEADER + idLen + bodyLen
      if (buf.length - off < need) break
      frames.push(new Frame(buf.subarray(off, off + need)))
      off += need
    }
    this.carry = off < buf.length ? buf.subarray(off) : EMPTY
    return frames
  }
}

// decode exactly one complete frame (test/handshake convenience); throws on more or fewer than one.
export function decodeFrame(buf: Buffer): Frame {
  const f = new Framer().push(buf)
  if (f.length !== 1) throw new Error(`fero: expected exactly one frame, got ${f.length}`)
  return f[0]
}

// a zero-copy view over one frame's bytes — flags/verb/id/provenance read directly; records() parses lazily.
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
  // parse + memoise the provenance ext (origin/baseSeq/epoch) and where the record count begins; none → off = afterId.
  #prov?: { origin?: string; baseSeq: number; epoch: number; off: number }
  private prov(): { origin?: string; baseSeq: number; epoch: number; off: number } {
    if (this.#prov) return this.#prov
    const buf = this.buf
    let off = this.afterId
    if (!(buf[1] & FLAG_PROV)) return (this.#prov = { baseSeq: 0, epoch: 0, off })
    let len = 0
    let shift = 0
    let b: number
    do {
      b = buf[off++]
      len |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    len >>>= 0
    if (len > buf.length - off) throw new FrameError(`provenance origin length ${len} overruns frame`)
    const origin = buf.toString('utf8', off, off + len)
    off += len
    let baseSeq = 0
    shift = 0
    do {
      b = buf[off++]
      baseSeq |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    let epoch = 0
    shift = 0
    do {
      b = buf[off++]
      epoch |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    // a truncated varint reads past the body (undefined → 0 exits the loop silently) — one O(1) post-check makes it loud.
    if (off > buf.length) throw new FrameError('truncated provenance varint')
    return (this.#prov = { origin, baseSeq: baseSeq >>> 0, epoch: epoch >>> 0, off })
  }

  get origin(): string | undefined {
    return this.prov().origin
  }
  get baseSeq(): number {
    return this.prov().baseSeq
  }
  get epoch(): number {
    return this.prov().epoch
  }

  // the single payload of a CONTROL frame: records()[0].value — inverse of controlFrame(); undefined when empty.
  get value(): unknown {
    return this.records()[0]?.value
  }

  // lazily slice one RecordView per record (no key/value parse), stamping provenance origin + baseSeq+index.
  records(): RecordView[] {
    const buf = this.buf
    const { origin, baseSeq, epoch, off: start } = this.prov()
    let off = start
    let count = 0
    let shift = 0
    let b: number
    do {
      b = buf[off++]
      count |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    count >>>= 0
    // reject a count exceeding remaining bytes BEFORE `new Array(count)` — a hostile 2^28 count would allocate billions.
    if (count > buf.length - off) throw new FrameError(`record count ${count} exceeds ${buf.length - off} body bytes`)
    const out: RecordView[] = new Array(count)
    for (let i = 0; i < count; i++) {
      let len = 0
      shift = 0
      do {
        b = buf[off++]
        len |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      len >>>= 0
      if (len > buf.length - off) throw new FrameError(`record ${i} length ${len} overruns ${buf.length - off} remaining body bytes`)
      const record = new RecordView(buf.subarray(off, off + len))
      if (origin !== undefined) {
        record.origin = origin
        record.seq = baseSeq + i
        record.epoch = epoch
      }
      out[i] = record
      off += len
    }
    return out
  }
}

// ─────────────────────────────────────────── RecordView (lazy decoded record)

// mirrors a change record but parses on access — type is 1 byte; key/at/value decoded + memoised only when read.
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

  // provenance, stamped by Frame.records() when the frame carries it (else undefined).
  origin?: string
  seq?: number
  epoch?: number

  constructor(buf: Buffer) {
    this.#buf = buf
  }

  get type(): ChangeRecord['type'] {
    return (this.#type ??= TYPE_NAME[this.#buf[0] & 3])
  }

  // locate at/value field boundaries once (no utf8 decode, no value parse) so the getters know where to slice.
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
    nseg >>>= 0
    if (nseg > buf.length - off) throw new FrameError(`key has ${nseg} segments, exceeds record`)
    for (let i = 0; i < nseg; i++) {
      let l = 0
      shift = 0
      do {
        b = buf[off++]
        l |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      l >>>= 0
      if (l > buf.length - off) throw new FrameError(`key segment ${i} length ${l} overruns record`)
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
      l >>>= 0
      if (l > buf.length - off) throw new FrameError(`at length ${l} overruns record`)
      this.#atStart = off
      off += l
      this.#atEnd = off
    }
    this.#valStart = off
    this.#scanned = true
  }

  // decode + memoise the key segments (varint count, then len-prefixed utf8 per segment).
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
    nseg >>>= 0
    if (nseg > buf.length - off) throw new FrameError(`key has ${nseg} segments, exceeds record`)
    const key: string[] = new Array(nseg)
    for (let i = 0; i < nseg; i++) {
      let l = 0
      shift = 0
      do {
        b = buf[off++]
        l |= (b & 0x7f) << shift
        shift += 7
      } while (b & 0x80)
      l >>>= 0
      if (l > buf.length - off) throw new FrameError(`key segment ${i} length ${l} overruns record`)
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

  // decode + memoise the value by VT nibble — scalars are tag-only; int unzigzags, obj JSON-parses (bounds-checked).
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
        // the one value decode with no following bounds use — post-check so a truncated int is a FrameError like str/obj, not a silent wrong value.
        if (off > buf.length) throw new FrameError('int value overruns record')
        v = unzigzag(z >>> 0)
        break
      }
      case VT.f64:
        if (off + 8 > buf.length) throw new FrameError('f64 value overruns record')
        v = buf.readDoubleLE(off)
        break
      case VT.str: {
        let l = 0
        do {
          b = buf[off++]
          l |= (b & 0x7f) << shift
          shift += 7
        } while (b & 0x80)
        l >>>= 0
        if (l > buf.length - off) throw new FrameError(`str value length ${l} overruns record`)
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
        l >>>= 0
        if (l > buf.length - off) throw new FrameError(`obj value length ${l} overruns record`)
        try {
          v = JSON.parse(buf.toString('utf8', off, off + l))
        } catch {
          throw new FrameError('invalid JSON object value') // corrupt body → drop peer, don't crash
        }
        break
      }
      default:
        // vtype 7 and 9-15 are reserved/unused — a malformed or hostile frame.
        throw new FrameError(`reserved value type ${vtype}`)
    }
    this.#valueParsed = true
    return (this.#value = v)
  }

  // plain-object snapshot — the inverse of a `data` change record.
  toJSON(): ChangeRecord {
    const out: ChangeRecord = { type: this.type, key: this.key, value: this.value }
    if (this.at !== undefined) out.at = this.at
    if (this.origin !== undefined) {
      out.origin = this.origin
      out.seq = this.seq
      if (this.epoch) out.epoch = this.epoch // omit the 0/unset default (pre-view records)
    }
    return out
  }
}
