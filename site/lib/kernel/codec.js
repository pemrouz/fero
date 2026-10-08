//! ── kernel/codec — encode once; the bytes ARE the log entry and the wire ─────
// v3 frame layout (11-byte fixed header, then body):
//
//   MAGIC(1) | flags(1) | verb(1) | bodyLen:u32LE | crc32c:u32LE | body
//
// Deltas from v2's codec, each traceable to an audited failure:
//   - ONE bounds-checked Cursor primitive instead of ~12 hand-inlined varint
//     loops (two of v2's inlined copies shipped silent-truncation bugs).
//   - A crc32c over header [0,7) + body: a flipped epoch/seq/verb/flags byte
//     becomes a FrameError (drop the link) instead of a wedged write-gate or a
//     silent mis-dispatch — the judge panel flagged integrity-free frames as a
//     liveness hole (plan §5), and the adversarial review showed body-only
//     coverage let a verb flip re-dispatch a RECORDS frame as PING.
//   - Streaming per-link Outbox encoder: records are appended into a reusable
//     buffer during a step and the header is back-patched at flush — no per-frame
//     Writer allocation, no double byteLength sizing pass (v2's encoder did both).
//   - The record count is a fixed u32 (not a varint) so it can be back-patched.
//   - Keys are length-prefixed segments — no '\0' joins anywhere, so keys
//     containing '.', '\0', or unicode can never over-match (v2 carried a
//     \0-composite convention into three parallel maps).
//   - The value codec is binary and recursive from day 0 (CBOR-class: nested
//     obj/arr, NaN-preserving f64, Uint8Array) because it becomes the log and
//     WAL format too — v2 deferred this and JSON.parse became ~85% of decode.
//
// The provenance extension is carried over from v2 verbatim (it measured well):
// a PROV frame carries ONE origin's CONTIGUOUS seqs within ONE epoch —
// [origin, baseSeq, epoch] amortised per frame, seq = baseSeq + index. That
// single-origin/contiguous/single-epoch invariant is load-bearing (it is what
// licenses scalar high-water dedup downstream) and encodeRuns() is the one
// shared splitter that enforces it.

import { REC,          } from './env.js'

//! MAGIC 0xF3 = protocol marker + version byte (bump on any wire change). MAX_FRAME bounds one frame's body (anti-OOM, enforced BOTH directions).
export const MAGIC = 0xf3
export const MAX_FRAME = 1 << 28 // 256 MiB
export const HEADER = 11

//! VERB: dense 1-byte frame verbs, append-only. The codec fails closed on unknowns at dispatch, not here.
// DIGEST carries {d: {origin: highestHeldSeq}, r: 0|1} — "here is what I hold; r=1 means please answer with yours".
// Toward a client link it also carries w: 0|1, the sender's write-gate (I-33: the client's cluster.writable).
// M2 membership control plane: JOIN {u,i,l} asks a member to propose the sender in; PROPOSE {e,m,p} /
// VOTE {e,g,ce} are the joint-consensus ballot legs; VIEW {e,m} announces (or answers a PULL {e} with)
// a committed view. LEAVE {} (V4-6) asks for the view WITHOUT the sender — the graceful exit.
// M3 write pipeline: WRITE is a RECORDS-shaped frame (FLAG_PROV + record runs) whose provenance triple is
// REINTERPRETED as the ATTEMPT triple [issuer, baseCid, attemptEpoch] — un-sequenced attempts forwarded to
// the partition owner reuse the whole hot record-encode/decode path. WACK {u,c,n,s,e} answers a committed
// run with its stamp coordinates; WNACK {u,c,n,r,ce} rejects one with a typed reason + the owner's epoch.
export const VERB = {
  HELLO: 1, RECORDS: 2, PING: 3, PONG: 4, DIGEST: 5,
  JOIN: 6, PROPOSE: 7, VOTE: 8, VIEW: 9, PULL: 10,
  WRITE: 11, WACK: 12, WNACK: 13,
  //! M5c method plane (control frames; the kernel routes, the api HOST runs the handlers):
  // CALL {id,m,a} / SUB {id,m,a} / UNSUB {id} travel client→server; RESULT {id,ok,v|e} answers a
  // CALL; SUBREC {id,recs} streams a live subscription's change records. `id` is caller-minted,
  // monotone per client (a SUB's id doubles as the subscription identity, v2's rule kept).
  CALL: 14, RESULT: 15, SUB: 16, UNSUB: 17, SUBREC: 18,
  //! M6 scoped replication (DESIGN-M6 C3/C8 — the churn-priced evidence + handover plane; the DIGEST
  // wire shape is untouched in both modes): HAVEQ {e, q:{p:{o:seq}}} announces possession floors and
  // asks for coverage; HAVEA {e, a:{p:{ok,need,m?,md?}}} attests-or-requests per partition; ACQ is a
  // RECORDS-shaped one-teacher transfer (provenance + attempt identity ride exactly like AE);
  // ACQDONE {p, e, t:{o:cut}, n} closes the atomic fold.
  HAVEQ: 19, HAVEA: 20, ACQ: 21, ACQDONE: 22,
  //! M7 DIAG plane (DESIGN-M7 §1 — the authenticated diagnostics channel, structurally OUTSIDE
  // membership): DIAGQ {id≥1, q, ...} is a client pull (journal/logs cursors, node fold, state);
  // DIAGA answers it (id:0 is the session verdict — the ACCEPT/deny of an r:2 HELLO). Direction-split
  // paired verbs like HAVEQ/HAVEA — no subcommand byte: control frames carry exactly ONE value, so the
  // op rides INSIDE the value (the DIGEST-r idiom) and #dispatch keeps its flat fail-closed switch.
  DIAGQ: 23, DIAGA: 24,
  //! graceful LEAVE (2026-09-07, DECISIONS V4-6): a member that is stopping ON PURPOSE asks the view's
  // proposer for the view without it. The leaver can still vote, so the ballot passes where an eviction
  // of the same node never could (a two-member view). The frame carries no identity on purpose: the
  // leaver IS the link's authenticated uuid. Value {} — a control frame carries exactly one value.
  LEAVE: 25,
}         

//! FLAG_PROV: body opens with [originLen+utf8][baseSeq varint][epoch varint] before the record count.
export const FLAG_PROV = 1
//! FLAG_PP: each record is preceded by ONE varint — its (origin, partition) sub-stream PREDECESSOR
// seq encoded as (pp + 1), wire 0 = UNKNOWN. The M6-review floor law: a receiver may advance its
// possession floor to a record's seq ONLY when its floor already covers the sender-stamped
// predecessor (`pp >= 0 && floor >= pp`) — locally-verifiable sub-stream contiguity, killing the
// mint-family floor forgeries (findings 10/18/25: mid-lane first arrivals, AE re-admit races, and
// multi-source interleave all overclaimed the prefix). UNKNOWN fails CLOSED (fold, never advance —
// the panel's fail-open hole): pre-pp history and epoch-0 rows re-shipped by AE must not forge
// first-ever claims. Set ONLY by ARMED senders (never at epoch 0 — inertness/byte-identity).
export const FLAG_PP = 4
//! FLAG_ATTEMPT: after the provenance triple, [issuerLen+utf8][baseCid varint] — the ATTEMPT IDENTITY of a
// committed forwarded run, riding replication so EVERY node feeds its cid-dedup window from the records
// themselves. This is what makes exactly-once survive an ownership move (adversarial-review critical:
// a retry after a view change hit a new owner with no memory of the cid and re-committed — resurrecting
// a stale value OVER a newer acknowledged write). Requires FLAG_PROV; cids are contiguous per run like seqs.
export const FLAG_ATTEMPT = 2
//! MAX_DEPTH: value-nesting bound BOTH directions — an unbounded recursive decode is a stack overflow a
// hostile frame can trigger, and RangeError is NOT a FrameError: it once escaped the net and crashed the
// node (adversarial-review critical). 64 is far beyond any sane payload and far below any stack limit.
export const MAX_DEPTH = 64

//! FrameError: a WIRE fault (bad magic, bad crc, overrun, oversize) — the peer is dropped. Any other throw in a frame handler is a real bug and must rethrow unmasked (v2's rule, kept).
export class FrameError extends Error {}

//! ── crc32c (Castagnoli, software table) ──────────────────────────────────────
// One table build at module load; ~1 cycle/byte in JS — cheap next to utf8 work.
const CRC_T = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
  CRC_T[i] = c >>> 0
}
const crcUpdate = (state        , b            , start        , end        )         => {
  let c = state
  for (let i = start; i < end; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return c
}
export const crc32c = (b            , start = 0, end = b.length)         =>
  (crcUpdate(0xffffffff, b, start, end) ^ 0xffffffff) >>> 0

//! crcFrame: the frame checksum covers header bytes [0,7) (magic|flags|verb|bodyLen) AND the body [11,end) —
// leaving only the crc field itself out. Body-only coverage left flags/verb unprotected: a single flipped verb
// byte turned a crc-valid RECORDS frame into a PING and every record in it silently vanished (found by the
// adversarial review's corruption fuzz analysis).
export const crcFrame = (b            , end        )         =>
  (crcUpdate(crcUpdate(0xffffffff, b, 0, 7), b, HEADER, end) ^ 0xffffffff) >>> 0

//! ── value codec (VT tag byte) — binary, recursive, NaN-safe ──────────────────
// Scalars null/undefined/false/true are TAG-ONLY (zero value bytes — v2's
// measured nibble win, kept). int is a zigzag varint (int32 range), everything
// else f64 (8 LE bytes — NaN and -0 preserved bit-exactly). Nested values carry
// their own tag byte; a record's TOP-LEVEL vt rides free in the record tag.
export const VT = {
  none: 0, null: 1, undefined: 2, false: 3, true: 4,
  int: 5, f64: 6, str: 7, obj: 8, arr: 9, u8: 10,
}         

const vtOf = (v         )         =>
  v === null ? VT.null
  : v === undefined ? VT.undefined
  : v === false ? VT.false
  : v === true ? VT.true
  : typeof v === 'number'
    ? (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff && !Object.is(v, -0) ? VT.int : VT.f64)
  : typeof v === 'string' ? VT.str
  : v instanceof Uint8Array ? VT.u8
  : Array.isArray(v) ? VT.arr
  : typeof v === 'object' ? VT.obj
  : (() => { throw new FrameError(`unencodable value type: ${typeof v}`) })()

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

//! ── Writer — one growable scratch buffer with back-patching ──────────────────
// Backs both the standalone encodeFrame() and the per-link Outbox. ensure()
// doubles; u32at() patches a reserved slot (bodyLen / crc / count) after the
// records are appended, which is what makes streaming encoding possible.
export class Writer {
  buf = new Uint8Array(4096)
  len = 0
  ensure(n        ) {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    if (cap > MAX_FRAME + HEADER) throw new FrameError('frame exceeds MAX_FRAME')
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  u8(v        ) { this.ensure(1); this.buf[this.len++] = v }
  u32(v        ) { this.ensure(4); this.u32at(this.len, v); this.len += 4 }
  u32at(at        , v        ) {
    this.buf[at] = v & 0xff; this.buf[at + 1] = (v >>> 8) & 0xff
    this.buf[at + 2] = (v >>> 16) & 0xff; this.buf[at + 3] = (v >>> 24) & 0xff
  }
  //! varint: unsigned LEB128 via Math (not bitwise — bitwise truncates at 32 bits; seqs are Lamport counters and outlive 2^32).
  varint(v        ) {
    while (v > 127) { this.u8((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
    this.u8(v)
  }
  zigzag(v        ) { this.varint(v < 0 ? -v * 2 - 1 : v * 2) }
  f64(v        ) {
    this.ensure(8)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v, true)
    this.len += 8
  }
  //! str: varint byteLen + utf8, in ONE pass via encodeInto (v2 computed Buffer.byteLength twice per string — sizing pass then write pass).
  str(s        ) {
    this.ensure(4 + s.length * 3) // worst-case utf8 + up to 3 varint len bytes
    const lenAt = this.len
    // reserve 3 varint bytes for lengths up to 2^21-1; longer strings re-encode via the slow path
    if (s.length * 3 < 1 << 21) {
      this.len += 3
      const { written } = utf8.encodeInto(s, this.buf.subarray(this.len))
      this.buf[lenAt] = (written & 0x7f) | 0x80
      this.buf[lenAt + 1] = ((written >>> 7) & 0x7f) | 0x80
      this.buf[lenAt + 2] = written >>> 14
      this.len += written
    } else {
      const bytes = utf8.encode(s)
      this.varint(bytes.length)
      this.bytes(bytes)
    }
  }
  bytes(b            ) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length }
  //! value: recursive tagged encode — the ONE place values become bytes (log, WAL, and wire all reuse it).
  // Depth-bounded symmetrically with the decoder: what cannot be decoded must not be encodable.
  value(v         , vt = vtOf(v), depth = 0) {
    if (depth > MAX_DEPTH) throw new FrameError('value nesting exceeds MAX_DEPTH')
    switch (vt) {
      case VT.none: case VT.null: case VT.undefined: case VT.false: case VT.true: return
      case VT.int: return this.zigzag(v          )
      case VT.f64: return this.f64(v          )
      case VT.str: return this.str(v          )
      case VT.u8: { const b = v              ; this.varint(b.length); return this.bytes(b) }
      case VT.arr: {
        const a = v             
        this.varint(a.length)
        for (const x of a) { const t = vtOf(x); this.u8(t); this.value(x, t, depth + 1) }
        return
      }
      case VT.obj: {
        const entries = Object.entries(v          )
        this.varint(entries.length)
        for (const [k, x] of entries) { this.str(k); const t = vtOf(x); this.u8(t); this.value(x, t, depth + 1) }
        return
      }
      default: throw new FrameError(`bad vt ${vt}`)
    }
  }
}

//! ── Cursor — THE bounds-checked reader (exactly one; never inline a varint) ──
// Every length/count is checked against `end` BEFORE any allocation or slice —
// v2's rule, kept — but here the check exists once per primitive instead of
// being re-spelled at ~12 call sites (where two copies shipped truncation bugs).
export class Cursor {
  buf            
  pos        
  end        
  constructor(buf            , pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end }
  need(n        ) { if (this.pos + n > this.end) throw new FrameError('frame truncated') }
  u8()         { this.need(1); return this.buf[this.pos++] }
  u32()         {
    this.need(4)
    const b = this.buf, p = this.pos
    this.pos += 4
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000
  }
  varint()         {
    let v = 0, mul = 1
    for (let i = 0; i < 8; i++) {
      const b = this.u8()
      v += (b & 0x7f) * mul
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(v)) throw new FrameError('varint overflow')
        return v
      }
      mul *= 128
    }
    throw new FrameError('varint too long')
  }
  zigzag()         { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2 }
  f64()         {
    this.need(8)
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true)
    this.pos += 8
    return v
  }
  str()         {
    const n = this.varint()
    this.need(n)
    const s = utf8d.decode(this.buf.subarray(this.pos, this.pos + n))
    this.pos += n
    return s
  }
  bytes()             {
    const n = this.varint()
    this.need(n)
    //! decoded bytes are COPIED out (copy-on-retain, plan §7): a subarray view would pin the whole receive chunk.
    const b = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return b
  }
  //! value: recursive tagged decode. Collection counts are sanity-bounded by remaining bytes before any
  // Array/Object allocation, and nesting is DEPTH-BOUNDED: a stack overflow is a RangeError, which is not
  // a FrameError — one deeply-nested hostile frame once rode past the net and crashed the node.
  value(vt        , depth = 0)          {
    if (depth > MAX_DEPTH) throw new FrameError('value nesting exceeds MAX_DEPTH')
    switch (vt) {
      case VT.none: case VT.undefined: return undefined
      case VT.null: return null
      case VT.false: return false
      case VT.true: return true
      case VT.int: return this.zigzag()
      case VT.f64: return this.f64()
      case VT.str: return this.str()
      case VT.u8: return this.bytes()
      case VT.arr: {
        const n = this.varint()
        if (n > this.end - this.pos) throw new FrameError('arr count overruns frame')
        const a = new Array(n)
        for (let i = 0; i < n; i++) a[i] = this.value(this.u8(), depth + 1)
        return a
      }
      case VT.obj: {
        const n = this.varint()
        if (n > this.end - this.pos) throw new FrameError('obj count overruns frame')
        const o                          = {}
        for (let i = 0; i < n; i++) {
          const k = this.str()
          const v = this.value(this.u8(), depth + 1)
          //! defineProperty for the one hostile key: a bracket-assign of '__proto__' is a [[Set]] that hits
          // Object.prototype's accessor — the field silently vanishes (non-object value) or REPLACES the
          // object's prototype (object value), so sender and receiver state diverge on a crc-valid frame.
          if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
          else o[k] = v
        }
        return o
      }
      default: throw new FrameError(`bad vt ${vt}`)
    }
  }
  //! skipValue: advance past a value WITHOUT materialising it — what keeps relay/scan lazy (v2's measured
  // scan<decode win). Depth-bounded like value(): the scan recursion is just as hostile-reachable.
  skipValue(vt        , depth = 0) {
    if (depth > MAX_DEPTH) throw new FrameError('value nesting exceeds MAX_DEPTH')
    switch (vt) {
      case VT.none: case VT.null: case VT.undefined: case VT.false: case VT.true: return
      case VT.int: this.varint(); return
      case VT.f64: this.need(8); this.pos += 8; return
      case VT.str: case VT.u8: { const n = this.varint(); this.need(n); this.pos += n; return }
      case VT.arr: { const n = this.varint(); for (let i = 0; i < n; i++) this.skipValue(this.u8(), depth + 1); return }
      case VT.obj: { const n = this.varint(); for (let i = 0; i < n; i++) { const s = this.varint(); this.need(s); this.pos += s; this.skipValue(this.u8(), depth + 1) } return }
      default: throw new FrameError(`bad vt ${vt}`)
    }
  }
}

//! ── record encoding ──────────────────────────────────────────────────────────
// tag byte: [ vt:5 bits | hasAt:1 | type:2 ]  then key (count + len-prefixed
// segments), then at (if hasAt), then the value payload (vt from the tag).
const HAS_AT = 4

const writeRecord = (w        , r     ) => {
  const vt = r.type === REC.remove ? VT.none : vtOf(r.value)
  w.u8((r.type & 3) | (r.at !== undefined ? HAS_AT : 0) | (vt << 3))
  w.varint(r.key.length)
  for (const seg of r.key) w.str(seg)
  if (r.at !== undefined) w.str(r.at)
  w.value(r.value, vt)
}

//! Prov: the per-frame provenance extension — one origin, contiguous seqs from baseSeq, one epoch.
                                                                        
//! AttemptRun: the per-frame attempt-identity extension (FLAG_ATTEMPT) — one issuer, contiguous cids.
// Rides committed runs that originated as forwarded/relayed attempts, so replication itself feeds
// every node's cid-dedup window (see FLAG_ATTEMPT above for the ownership-move story).
                                                               

//! ── Outbox — the streaming per-link frame encoder ─────────────────────────────
// One Outbox per link, reused forever: begin() stamps the header + provenance,
// add() appends records (count tracked, patched at finish), finish() back-patches
// bodyLen + count + crc and returns a FRESH COPY of the frame bytes. The copy is
// deliberate: both shells and the sim may retain the buffer past return
// (socket.write queues; sim delivers later), so handing out the reusable scratch
// would corrupt in-flight frames — one slice per FRAME per flush (not per record)
// is the M0 cost, revisited with a buffer ring in M8.
export class Outbox {
  w = new Writer()
  count = 0
  countAt = 0
  open = false
  //! per-frame pp mode (FLAG_PP set at begin) — every add() in the frame then carries its varint
  pp = false
  //! run continuity (M6-review, the fan-out filter corollary): a RECORDS frame's seqs/cids decode as
  // baseSeq+i / baseCid+i, so the frame may only hold ONE contiguous run. Under the armed per-link
  // fan-out filter a link's record subset is lawfully GAPPY — add() detects the break and ROTATES
  // (finishes the open frame into `pending`, begins a fresh one), mirroring encodeRuns' split rule.
  // Unscoped fan-out is every-record-to-every-link, so rotation never fires there (byte-identity).
  pending               = []
  #origin = ''
  #nextSeq = 0
  #epoch = 0
  #iss                    
  #nextCid = 0
  begin(verb        , prov       , attempt             , pp = false) {
    const w = this.w
    w.len = 0
    w.u8(MAGIC); w.u8((prov ? FLAG_PROV : 0) | (prov && attempt ? FLAG_ATTEMPT : 0) | (pp ? FLAG_PP : 0)); w.u8(verb)
    w.u32(0) // bodyLen, patched
    w.u32(0) // crc, patched
    if (prov) {
      w.str(prov.origin); w.varint(prov.baseSeq); w.varint(prov.epoch)
      if (attempt) { w.str(attempt.issuer); w.varint(attempt.baseCid) }
      this.#origin = prov.origin; this.#nextSeq = prov.baseSeq; this.#epoch = prov.epoch
      this.#iss = attempt?.issuer; this.#nextCid = attempt?.baseCid ?? 0
    }
    this.countAt = w.len
    w.u32(0) // record count, patched
    this.count = 0
    this.pp = pp
    this.open = true
  }
  //! continues — would (prov, attempt) extend the OPEN frame's run contiguously (same lane/epoch/
  // attempt lane, next seq/cid)? False on a closed outbox — the caller begins fresh either way.
  continues(prov      , attempt             )          {
    return this.open &&
      prov.origin === this.#origin && prov.epoch === this.#epoch && prov.baseSeq === this.#nextSeq &&
      (attempt?.issuer ?? undefined) === this.#iss && (this.#iss === undefined || attempt .baseCid === this.#nextCid)
  }
  //! rotate — finish the open frame into the pending list (shipped at the next flush, order kept).
  rotate() {
    const bytes = this.finish()
    if (bytes) this.pending.push(bytes)
  }
  add(r     , pp         ) {
    if (this.pp) this.w.varint((pp ?? -1) + 1) // wire 0 = unknown predecessor (fails closed)
    writeRecord(this.w, r)
    this.count++
    this.#nextSeq++
    this.#nextCid++
  }
  //! finish(): patch + checksum + hand over an owned copy. Returns null for an empty frame (nothing queued this step).
  finish()                    {
    if (!this.open) return null
    this.open = false
    if (this.count === 0) return null
    const w = this.w
    const bodyLen = w.len - HEADER
    if (bodyLen > MAX_FRAME) throw new FrameError('frame exceeds MAX_FRAME')
    w.u32at(3, bodyLen)
    w.u32at(this.countAt, this.count)
    w.u32at(7, crcFrame(w.buf, w.len))
    return w.buf.slice(0, w.len)
  }
}

//! encodeControl: a control frame (HELLO/PING/...) carrying exactly ONE value as its body — v2's controlFrame shape, kept.
// Encodes into a MODULE-LEVEL scratch Writer (adversarial-review perf finding: a fresh 4KB Writer per
// control frame on the ACK/NACK paths) — safe because the kernel is single-threaded, encode never
// re-enters, and the return is always an owned slice. A rare oversized frame (a huge VIEW) is not
// allowed to pin its grown buffer forever: the scratch resets past 64KB.
const ctrl = new Writer()
export const encodeControl = (verb        , value          )             => {
  const w = ctrl
  w.len = 0
  w.u8(MAGIC); w.u8(0); w.u8(verb)
  w.u32(0); w.u32(0)
  const vt = vtOf(value)
  w.u8(vt)
  w.value(value, vt)
  w.u32at(3, w.len - HEADER)
  w.u32at(7, crcFrame(w.buf, w.len))
  const out = w.buf.slice(0, w.len)
  if (w.buf.length > 1 << 16) w.buf = new Uint8Array(4096)
  return out
}

//! encodeFrame: one-shot RECORDS encode (tests, catch-up). The hot path uses a per-link Outbox instead.
export const encodeFrame = (records       , prov       )             => {
  const o = new Outbox()
  o.begin(VERB.RECORDS, prov)
  for (const r of records) o.add(r)
  return o.finish() ?? encodeEmpty(prov)
}
const encodeEmpty = (prov       )             => {
  // an explicitly-empty RECORDS frame is only ever built by tests
  const w = new Writer()
  w.u8(MAGIC); w.u8(prov ? FLAG_PROV : 0); w.u8(VERB.RECORDS)
  w.u32(0); w.u32(0)
  if (prov) { w.str(prov.origin); w.varint(prov.baseSeq); w.varint(prov.epoch) }
  w.u32(0)
  w.u32at(3, w.len - HEADER)
  w.u32at(7, crcFrame(w.buf, w.len))
  return w.buf.slice(0, w.len)
}

//! encodeRuns: split a mixed batch into the FEWEST frames each satisfying single-origin / contiguous-seq /
// single-epoch — AND single-attempt-lane: records carrying attempt identity (iss/cid) run only with the
// same issuer and contiguous cids, so the FLAG_ATTEMPT extension amortises per frame exactly like prov.
// A run breaks on any discontinuity — the protocol requirement that licenses scalar high-water dedup at
// every receiver. The M3 write pipeline reuses the splitter for WRITE frames (verb param): identical
// shape, the triple read as [issuer, baseCid, attemptEpoch]. Uses a module-level scratch Outbox (finish()
// hands out owned copies; the kernel is single-threaded and encode never re-enters).
const runsScratch = new Outbox()
export const encodeRuns = (
  records                                                                                                     ,
  verb         = VERB.RECORDS,
  //! withPp (M6 floor law): armed senders stamp every record's predecessor varint (FLAG_PP). NEVER a
  // run-split condition — pp is per-record data, so the split shape is identical either way (the
  // snapshot chunker's one-frame assert depends on this).
  withPp = false,
)               => {
  const frames               = []
  const o = runsScratch
  let i = 0
  while (i < records.length) {
    const head = records[i]
    o.begin(verb, { origin: head.origin, baseSeq: head.seq, epoch: head.epoch },
      head.iss !== undefined ? { issuer: head.iss, baseCid: head.cid  } : undefined, withPp)
    o.add(head.rec, head.pp)
    let j = i + 1
    while (
      j < records.length &&
      records[j].origin === head.origin &&
      records[j].epoch === head.epoch &&
      records[j].seq === head.seq + (j - i) &&
      records[j].iss === head.iss &&
      (head.iss === undefined || records[j].cid === head.cid  + (j - i))
    ) { o.add(records[j].rec, records[j].pp); j++ }
    frames.push(o.finish() )
    i = j
  }
  return frames
}

//! ── Frame / RecordView — lazy zero-copy decode (v2's measured win, kept) ─────
//! RecordView: type/prov are immediate; key/at/value decode (and memoise) only when read — a relayed record is never parsed.
export class RecordView {
  #buf            
  #keyAt        
  #vt        
  #hasAt         
  #key           
  #at         
  #value          
  #decoded = false
  #valueAt = 0
  #end        
           type        
  origin        
  seq        
  epoch        
  //! attempt identity (FLAG_ATTEMPT runs): the (issuer, cid) this record committed FROM — '' / 0 when absent
  issuer        
  cid        
  //! pp (FLAG_PP runs): the (origin, partition) sub-stream predecessor seq; -1 = UNKNOWN (flag
  // absent, or wire 0). Every floor-advance site must fail CLOSED on -1 (fold, never advance).
  pp        
  constructor(buf            , tag        , keyAt        , end        , origin        , seq        , epoch        , issuer = '', cid = 0, pp = -1) {
    this.#buf = buf; this.#keyAt = keyAt; this.#end = end
    this.type = tag & 3
    this.#hasAt = (tag & HAS_AT) !== 0
    this.#vt = tag >>> 3
    this.origin = origin; this.seq = seq; this.epoch = epoch
    this.issuer = issuer; this.cid = cid
    this.pp = pp
  }
  #head() {
    if (this.#key) return
    const c = new Cursor(this.#buf, this.#keyAt, this.#end)
    const n = c.varint()
    if (n > this.#end - c.pos) throw new FrameError('key count overruns frame')
    const key = new Array(n)
    for (let i = 0; i < n; i++) key[i] = c.str()
    this.#key = key
    if (this.#hasAt) this.#at = c.str()
    this.#valueAt = c.pos
  }
  get key()           { this.#head(); return this.#key  }
  get at()                     { this.#head(); return this.#at }
  get value()          {
    if (!this.#decoded) {
      this.#head()
      this.#value = new Cursor(this.#buf, this.#valueAt, this.#end).value(this.#vt)
      this.#decoded = true
    }
    return this.#value
  }
  //! rec(): materialise a plain Rec (copies out of the receive chunk — the explicit retain point).
  rec()      {
    const r      = { type: this.type, key: this.key.slice() }
    if (this.#hasAt) r.at = this.at
    if (this.#vt !== VT.none) r.value = this.value
    return r
  }
}

//! Frame: a decoded view over ONE complete checksummed frame. Header getters are free; records() scans boundaries lazily.
export class Frame {
  buf            
  constructor(buf            ) { this.buf = buf }
  get flags()         { return this.buf[1] }
  get verb()         { return this.buf[2] }
  #prov              
  #att                    
  #bodyAt()         { return HEADER }
  prov()              {
    if (this.#prov !== undefined) return this.#prov
    if ((this.flags & FLAG_PROV) === 0) return (this.#prov = null)
    const c = new Cursor(this.buf, this.#bodyAt())
    this.#prov = { origin: c.str(), baseSeq: c.varint(), epoch: c.varint() }
    //! the attempt extension nests INSIDE the prov parse so `end` always points at the record count
    this.#att = (this.flags & FLAG_ATTEMPT) !== 0 ? { issuer: c.str(), baseCid: c.varint() } : null
    ;(this.#prov                          ).end = c.pos
    return this.#prov
  }
  //! attempt(): the run's attempt identity, when FLAG_ATTEMPT rode along (null otherwise).
  attempt()                    {
    if (this.#att === undefined) this.prov()
    return this.#att ?? null
  }
  //! value: the single payload of a control frame.
  get value()          {
    const c = new Cursor(this.buf, this.#bodyAt())
    return c.value(c.u8())
  }
  //! records(): boundary-scan into lazy RecordViews — values are SKIPPED, not decoded (the scan<full-decode contract).
  records()               {
    const p = this.prov()
    const a = this.attempt()
    const c = new Cursor(this.buf, p ? (p                          ).end : this.#bodyAt())
    const count = c.u32()
    //! bound by REMAINING bytes / minimum record size (tag + key count = 2B) — pre-allocation is capped by
    // what the frame could possibly hold, same discipline as every other count check in this file
    if (count > (this.buf.length - c.pos) / 2) throw new FrameError('record count overruns frame')
    const out = new Array            (count)
    const origin = p?.origin ?? ''
    const epoch = p?.epoch ?? 0
    const hasPp = (this.flags & FLAG_PP) !== 0
    for (let i = 0; i < count; i++) {
      //! FLAG_PP: one predecessor varint precedes each record's tag — decoded as (wire - 1), so
      // wire 0 lands at -1 = UNKNOWN (fails closed at every floor-advance site)
      const pp = hasPp ? c.varint() - 1 : -1
      const tag = c.u8()
      const keyAt = c.pos
      const segs = c.varint()
      if (segs > this.buf.length - c.pos) throw new FrameError('key count overruns frame')
      for (let s = 0; s < segs; s++) { const n = c.varint(); c.need(n); c.pos += n }
      if (tag & HAS_AT) { const n = c.varint(); c.need(n); c.pos += n }
      c.skipValue(tag >>> 3)
      out[i] = new RecordView(this.buf, tag, keyAt, c.pos, origin, p ? p.baseSeq + i : 0, epoch,
        a?.issuer ?? '', a ? a.baseCid + i : 0, pp)
    }
    if (c.pos !== this.buf.length) throw new FrameError('trailing bytes after records')
    return out
  }
}

//! ── Framer — one per link; re-slices a TCP byte stream into complete frames ──
// Straddle handling kept from v2 (it measured well): a partial frame is carried
// as a single subarray; Buffer-level concat happens ONLY on a genuine straddle.
// bodyLen is bounds-checked against MAX_FRAME BEFORE the straddle check, so one
// hostile header can never balloon the carry (anti-OOM), and the crc is verified
// BEFORE a Frame is handed to dispatch.
export class Framer {
  #carry                    = null
  push(chunk            )          {
    let buf = this.#carry ? concat(this.#carry, chunk) : chunk
    this.#carry = null
    const out          = []
    let at = 0
    while (buf.length - at >= HEADER) {
      if (buf[at] !== MAGIC) throw new FrameError('bad magic')
      const bodyLen = readU32(buf, at + 3)
      if (bodyLen > MAX_FRAME) throw new FrameError('frame exceeds MAX_FRAME')
      if (buf.length - at < HEADER + bodyLen) break
      const frame = buf.subarray(at, at + HEADER + bodyLen)
      if (crcFrame(frame, frame.length) !== readU32(frame, 7)) throw new FrameError('bad crc')
      out.push(new Frame(frame))
      at += HEADER + bodyLen
    }
    //! the carry is a COPY, not a subarray: retaining a view would pin every prior receive chunk (v2's chunk-pinning trap, closed).
    if (at < buf.length) this.#carry = buf.slice(at)
    return out
  }
}
const readU32 = (b            , p        )         =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000
const concat = (a            , b            )             => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a); out.set(b, a.length)
  return out
}
