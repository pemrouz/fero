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

import { REC, type Rec } from './env.ts'

//! MAGIC 0xF3 = protocol marker + version byte (bump on any wire change). MAX_FRAME bounds one frame's body (anti-OOM, enforced BOTH directions).
export const MAGIC = 0xf3
export const MAX_FRAME = 1 << 28 // 256 MiB
export const HEADER = 11
//! roomOf — the most bytes ONE record may take, counted as the writer reserves them (encodable's count: a string
// 4 + 3 a character), and still fit ALONE in a frame of `cap` body bytes beside its envelope (provenance, attempt
// identity, the count, a pp varint). MAX_FRAME less 1 MiB at the production cap (api/data.ts WRITE's number); at a
// test cap (a node's tune row `frame`) a sixteenth less, never less than 256 bytes — what an envelope with two
// uuid-sized names takes. The relay asks it before a client's record is stamped (kernel/write.ts onWrite).
export const roomOf = (cap: number): number => cap - Math.min(1 << 20, Math.max(256, cap >> 4))
//! sizeOf — a byte count as people say it: MiB, KiB under one MiB, bytes under one KiB (every size a refusal names)
export const sizeOf = (n: number): string =>
  n >= 1 << 20 ? `${+(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KiB` : `${n} bytes`

//! VERB: dense 1-byte frame verbs, append-only. The codec fails closed on unknowns at dispatch, not here.
// DIGEST carries {d: {origin: highestHeldSeq}, r: 0|1} — "here is what I hold; r=1 means please answer with yours".
// Toward a client link it also carries w: 0|1, the sender's write-gate (I-33: the client's cluster.writable), and
// at a drain h: 1 (this link dropped frames while paused). A client's r=1 carries q (a correlation id) and the
// server's r=0 that answers it echoes q (DESIGN-SCALE stage 2: the spoke's resync ends on the reply to its own ask).
// M2 membership control plane: JOIN {u,i,l} asks a member to propose the sender in; PROPOSE {e,m,p} /
// VOTE {e,g,ce} are the joint-consensus ballot legs; VIEW {e,m} announces (or answers a PULL {e} with)
// a committed view. LEAVE {} (V4-6) asks for the view WITHOUT the sender — the graceful exit.
// M3 write pipeline: WRITE is a RECORDS-shaped frame (FLAG_PROV + record runs) whose provenance triple is
// REINTERPRETED as the ATTEMPT triple [issuer, baseCid, attemptEpoch] — un-sequenced attempts forwarded to
// the partition owner reuse the whole hot record-encode/decode path. WACK {u,c,n,s,e} answers a committed
// run with its stamp coordinates — plus `o`, the lane it was stamped on, from an ARMED owner only (DESIGN-SCALE
// stage 1: the issuer may never see the record; unscoped WACKs stay the v4.0 bytes) — or, on an armed relay's hop
// to its spoke for a record that relay expects to tap, `l`, the same lane to keep while waiting for the tap (wave 5e:
// a feeder that dies before its tap must not strand the write); WNACK {u,c,n,r,ce} rejects
// one with a typed reason + the owner's epoch (`m`, the reason text, rides an `invalid`).
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
  // ACQDONE {p, e, t:{o:cut}, n} closes the atomic fold. DESIGN-SCALE stage 2 (no MAGIC bump, V4-14):
  // HAVEQ gains three optional top-level keys — d:{p:{o:durable floor}} from durable nodes, g:[p…] the
  // partitions the sender is gapless for, x:[p…] the partitions it has just released — and a HAVEA
  // partition gains g:1 (gapless) and x:1 ("none": neither held nor assigned, where it used to be silent).
  // On a scoped cluster HAVEQ/HAVEA are the anti-entropy: the member heartbeat DIGEST does not run there.
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
  //! the door (2026-10-09, DESIGN-DOOR §2-§3): DOOR {p} carries a proof — a 43-character HMAC over both
  // nonces, both uuids, the prover's side and every HELLO key it sent; the DIALER proves first, the
  // acceptor proves back only to a verified dialer. DOOR {e: 'denied' | 'uuid-taken'} is a best-effort
  // refusal notice sent just before a close (the shell's socket.destroy can lose it; the journal row is
  // the contract). Sent only by nodes with a door; an open node never ships it and drops it on arrival.
  DOOR: 26,
} as const

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
const crcUpdate = (state: number, b: Uint8Array, start: number, end: number): number => {
  let c = state
  for (let i = start; i < end; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return c
}
export const crc32c = (b: Uint8Array, start = 0, end = b.length): number =>
  (crcUpdate(0xffffffff, b, start, end) ^ 0xffffffff) >>> 0

//! crcFrame: the frame checksum covers header bytes [0,7) (magic|flags|verb|bodyLen) AND the body [11,end) —
// leaving only the crc field itself out. Body-only coverage left flags/verb unprotected: a single flipped verb
// byte turned a crc-valid RECORDS frame into a PING and every record in it silently vanished (found by the
// adversarial review's corruption fuzz analysis).
export const crcFrame = (b: Uint8Array, end: number): number =>
  (crcUpdate(crcUpdate(0xffffffff, b, 0, 7), b, HEADER, end) ^ 0xffffffff) >>> 0

//! ── value codec (VT tag byte) — binary, recursive, NaN-safe ──────────────────
// Scalars null/undefined/false/true are TAG-ONLY (zero value bytes — v2's
// measured nibble win, kept). int is a zigzag varint (int32 range), everything
// else f64 (8 LE bytes — NaN and -0 preserved bit-exactly). Nested values carry
// their own tag byte; a record's TOP-LEVEL vt rides free in the record tag.
export const VT = {
  none: 0, null: 1, undefined: 2, false: 3, true: 4,
  int: 5, f64: 6, str: 7, obj: 8, arr: 9, u8: 10,
} as const

const vtOf = (v: unknown): number =>
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
//! ignoreBOM — a leading U+FEFF is text, never a byte order mark: the default decoder dropped one from every string,
// value or key, so a string that began with it lost one on every hop (the V4-52 build and review). The bytes are the same.
const utf8d = new TextDecoder('utf-8', { ignoreBOM: true })

//! FrameFull — a frame reached its cap while it was written (Writer.ensure). It is a FrameError, so every net that
// takes one still takes it (diag's too-large gate, the bytesIn net), and it is thrown as the ONE instance FULL,
// compared by identity where a caller cuts (Outbox.put) or refuses (api/methods.ts): no user code runs to tell it.
export class FrameFull extends FrameError {}
export const FULL = new FrameFull('frame exceeds MAX_FRAME')

//! ── Writer — one growable scratch buffer with back-patching ──────────────────
// Backs both the standalone encodeFrame() and the per-link Outbox. ensure()
// doubles; u32at() patches a reserved slot (bodyLen / crc / count) after the
// records are appended, which is what makes streaming encoding possible.
//! The limit is EXACT (V4-51, the frame cuts): ensure() throws FULL when the bytes NEEDED pass it, and growth stops at
// it. It used to compare the DOUBLED buffer with MAX_FRAME + HEADER, so the real bound was a 2^28-byte buffer and no
// caller could ask a smaller one. A frame's writer holds its cap + HEADER (MAX_FRAME, or a node's tune row `frame`);
// the shell's WAL rows and snapshot file are not frames and use an Infinity limit.
export class Writer {
  buf = new Uint8Array(4096)
  len = 0
  //! limit — the most bytes this writer may hold; end — min(buf.length, limit): the fast path's one compare
  limit: number
  end: number
  constructor(limit = MAX_FRAME + HEADER) { this.limit = limit; this.end = Math.min(4096, limit) }
  setLimit(limit: number) { this.limit = limit; this.end = Math.min(this.buf.length, limit) }
  ensure(n: number) {
    if (this.len + n <= this.end) return
    const need = this.len + n
    if (need > this.limit) throw FULL
    let cap = this.buf.length * 2
    while (cap < need) cap *= 2
    if (cap > this.limit) cap = this.limit
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
    this.end = cap
  }
  //! shrink — drop a buffer a big frame grew past `past` bytes (a writer reused for ever must not keep 256 MiB for good
  // after one big frame). Only between frames: the bytes written so far go with the buffer.
  shrink(past: number) {
    if (this.buf.length <= past) return
    this.buf = new Uint8Array(4096)
    this.end = Math.min(4096, this.limit)
  }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v }
  u32(v: number) { this.ensure(4); this.u32at(this.len, v); this.len += 4 }
  u32at(at: number, v: number) {
    this.buf[at] = v & 0xff; this.buf[at + 1] = (v >>> 8) & 0xff
    this.buf[at + 2] = (v >>> 16) & 0xff; this.buf[at + 3] = (v >>> 24) & 0xff
  }
  //! varint: unsigned LEB128 via Math (not bitwise — bitwise truncates at 32 bits; seqs are Lamport counters and outlive 2^32).
  varint(v: number) {
    while (v > 127) { this.u8((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
    this.u8(v)
  }
  zigzag(v: number) { this.varint(v < 0 ? -v * 2 - 1 : v * 2) }
  f64(v: number) {
    this.ensure(8)
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v, true)
    this.len += 8
  }
  //! str: varint byteLen + utf8, in ONE pass via encodeInto (v2 computed Buffer.byteLength twice per string — sizing pass then write pass).
  //! The worst case (3 bytes a character) is reserved only when it fits the limit; a long string, or one near the
  // limit, is encoded first and takes only its real bytes, so a frame holds what really fits — a 3 KB string was
  // refused a frame of 8 KiB (the V4-51/52 review). A frame that never nears its limit is byte-identical.
  str(s: string) {
    const lenAt = this.len
    // reserve 3 varint bytes for lengths up to 2^21-1; longer strings re-encode via the slow path
    if (s.length * 3 < 1 << 21 && this.len + 4 + s.length * 3 <= this.limit) {
      this.ensure(4 + s.length * 3) // worst-case utf8 + up to 3 varint len bytes
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
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length }
  //! value: recursive tagged encode — the ONE place values become bytes (log, WAL, and wire all reuse it).
  // Depth-bounded symmetrically with the decoder: what cannot be decoded must not be encodable.
  value(v: unknown, vt = vtOf(v), depth = 0) {
    if (depth > MAX_DEPTH) throw new FrameError('value nesting exceeds MAX_DEPTH')
    switch (vt) {
      case VT.none: case VT.null: case VT.undefined: case VT.false: case VT.true: return
      case VT.int: return this.zigzag(v as number)
      case VT.f64: return this.f64(v as number)
      case VT.str: return this.str(v as string)
      case VT.u8: { const b = v as Uint8Array; this.varint(b.length); return this.bytes(b) }
      //! by index over the length written, read once: the count on the wire and the elements after it are one
      // reading of the array. An array whose own iterator disagrees with its length (a subclass, an own
      // Symbol.iterator) wrote a count and then other elements — a frame that failed to decode, or a value
      // encodable's walk never saw (V4-48 review). Plain arrays encode to the same bytes as before.
      case VT.arr: {
        const a = v as unknown[]
        const len = a.length
        this.varint(len)
        for (let i = 0; i < len; i++) { const x = a[i]; const t = vtOf(x); this.u8(t); this.value(x, t, depth + 1) }
        return
      }
      case VT.obj: {
        const entries = Object.entries(v as object)
        this.varint(entries.length)
        for (const [k, x] of entries) { this.str(k); const t = vtOf(x); this.u8(t); this.value(x, t, depth + 1) }
        return
      }
      default: throw new FrameError(`bad vt ${vt}`)
    }
  }
}

//! Limit — how deep and how big a value encodable() and copyOf() let through. The codec's own bounds are
// { depth: MAX_DEPTH, bytes: MAX_FRAME }; the api asks tighter ones (api/data.ts WRITE, ARG and RESULT), leaving
// room for the envelopes its replies and calls wrap around a value. `part` is the api's rule for an array or an
// object the codec would carry but change (a Date sends its own fields, and it has none): asked once for each,
// never for a Uint8Array, it answers why not, or null. It comes in from the api because the kernel stays pure
// (no node:util — site/strip.mjs ships this file to the browser).
export interface Limit { depth: number; bytes: number; part?: (o: object, array: boolean) => string | null }

//! encodable — can this value become bytes within `limit`? null when it can, else what stops it, in a few
// words. A local write asks it BEFORE the kernel stamps the record (api/data.ts, V4-48): stamped first, a
// value the codec refuses failed in every frame that carried it afterwards — the WAL append, each link's
// ship, each digest answer — so replication stopped for good (a getter that throws ended the server from
// its socket handler). It walks the value as Writer.value would and writes nothing. `from` is the depth the
// value starts at, `spent` the bytes already counted (a record's key).
export const encodable = (v: unknown, limit: Limit, from = 0, spent = 0): string | null => refusal(v, limit, from, spent)?.message ?? null
//! refusal — encodable's answer as an Unsendable (its message the reason, `over` when only the size stopped it), or
// null: a caller that must tell a size refusal from the others (api/data.ts copyBounded) asks this
export const refusal = (v: unknown, limit: Limit, from = 0, spent = 0): Unsendable | null => {
  if (at.length !== 0) at.length = 0 // a store to an empty array's length is a slow path, about 80 ns a call
  //! `text` is saved and restored like copyOf's `copied`: a getter that runs a walk or a copy of its own reset it,
  // and the outer reason lost its note about characters
  const outerText = text
  text = false
  try {
    walk(v, from, spent, limit)
    return null
  } catch (e) {
    const over = e === REFUSED && refusedWhy === OVER
    const u = new Unsendable(reasonOf(e, limit))
    u.over = over
    return u
  } finally {
    text = outerText
  }
}
//! roundTrip — v as a client decodes it from a frame: its real bytes, written from `depth` (a RESULT carries its value
// one level down) within `bytes`, read back. A server's own reply past the walk's worst-case charge is this
// (api/data.ts replyCopy): its size is the encoder's, its value the decoder's, and each getter runs once. Throws FULL
// past `bytes`, a FrameError for what the codec cannot carry, or what a getter throws.
export const roundTrip = (v: unknown, bytes: number, depth = 0): unknown => {
  const w = new Writer(bytes)
  const vt = vtOf(v)
  w.value(v, vt, depth)
  return new Cursor(w.buf, 0, w.len).value(vt, depth)
}
//! reasonOf — what stopped a walk or a copy, said plainly; encodable and copyOf share it, so both give one text
const reasonOf = (e: unknown, limit: Limit): string => {
  //! the path first, before any user code runs below (formatting what a getter threw can call back in here)
  const where = place(at)
  at.length = 0
  if (e === REFUSED) {
    //! no path for depth (it is the path) or for size (the sum of every part)
    if (refusedWhy === DEEP) return `deeper than ${limit.depth} levels`
    if (refusedWhy === OVER) return `bigger than ${sizeOf(limit.bytes)}${text ? ' (a string counts 3 bytes a character)' : ''}`
    return refusedWhy + where
  }
  let m: string
  try { m = e instanceof Error ? `${e.name}: ${e.message}` : String(e) } catch { m = 'an unreadable error' }
  return `reading it threw (${m.length > 120 ? m.slice(0, 120) + '…' : m})${where}`
}
//! REFUSED — what the walk throws to refuse, compared by IDENTITY: a test such as `e instanceof Refused` runs
// user code on whatever a getter threw (a revoked Proxy's getPrototypeOf trap), and threw out of encodable itself
// (V4-48 review). The reason rides beside it; `at` collects the path as the throw unwinds (innermost first), and
// `text` says whether a string was charged, for the size reason.
const REFUSED = {}
const DEEP = 'deep', OVER = 'over'
let refusedWhy = ''
let text = false
const at: (string | number)[] = []
const refuse = (why: string): never => { refusedWhy = why; throw REFUSED }
//! place — ' at toys[2].n' for the walk's path, the first six parts; '' for the value itself
const place = (path: (string | number)[]): string => {
  if (path.length === 0) return ''
  let out = ''
  for (let i = path.length - 1, k = 0; i >= 0 && k < 6; i--, k++) {
    const p = path[i]
    out += typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? (out === '' ? p : `.${p}`) : `[${JSON.stringify(p)}]`
  }
  return ` at ${path.length > 6 ? out + '…' : out}`
}
//! walk — Writer.value's classes, told by typeof (the walk needs no exact tag: a number is charged 8, the most
// either number tag takes), arrays by index over their length read once (as Writer.value reads them), objects
// by their own enumerable keys, each getter run once (and one that throws is the answer). Object.keys, not
// Object.entries: no pair array per field, which was a third of the walk on a small object. Bytes are charged as
// Writer.ensure reserves them (a string 4 + 3 per character, each element its tag byte), and an array's or an
// object's length before its parts are visited, so the walk is bounded by the budget: a sparse array a billion
// long is refused at once, and a value built of shared parts costs no more than encoding it would. The limit's
// `part` rule is asked of each array and object before its parts are visited (never of a Uint8Array).
const walk = (v: unknown, depth: number, n: number, limit: Limit): number => {
  if (depth > limit.depth) refuse(DEEP)
  switch (typeof v) {
    case 'number': n += 8; break
    case 'string': n += 4 + v.length * 3; text = true; break
    case 'boolean': case 'undefined': break
    case 'object': {
      if (v === null) break
      if (v instanceof Uint8Array) { n += 5 + v.length; break }
      const array = Array.isArray(v)
      if (limit.part !== undefined) { const why = limit.part(v, array); if (why !== null) refuse(why) }
      if (array) {
        const a = v as unknown[]
        const len = a.length
        if ((n += 5 + len) > limit.bytes) refuse(OVER)
        for (let i = 0; i < len; i++) {
          try { n = walk(a[i], depth + 1, n, limit) } catch (e) { at.push(i); throw e }
        }
        break
      }
      const o = v as Record<string, unknown>
      const ks = Object.keys(o)
      if ((n += 5 + ks.length) > limit.bytes) refuse(OVER)
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i]
        try { n = walk(o[k], depth + 1, n + 4 + k.length * 3, limit) } catch (e) { at.push(k); throw e }
      }
      break
    }
    default: refuse(`a ${typeof v}`) // a bigint, a function, a symbol: vtOf's FrameError, said plainly
  }
  if (n > limit.bytes) refuse(OVER)
  return n
}

//! Unsendable — what copyOf throws for a value it cannot copy; the message is encodable's reason, word for word
//! `over` — refused for its size alone: a server's own read too big for a reply answers the typed 'too-large' a
// remote one gets (api/methods.ts answer, api/fold.ts answer)
export class Unsendable extends Error { over = false }

//! copyOf — the value Cursor.value would build from Writer.value's bytes, built directly, with no bytes: the copy
// a server's own read hands out, so it equals a client's read, and the copy a local write takes, so a change the
// program makes to its object afterwards reaches no copy at all (V4-52). It walks as encodable does — the same
// classes, order, limits, `part` rule and charges — and throws Unsendable with encodable's text for what
// encodable refuses. It builds what the decoder builds: a number as it is, a string as UTF-8 gives it back
// (textOf), a Uint8Array (a Buffer too) as a plain Uint8Array of its own bytes, an array by index over its
// length (a hole becomes undefined, other fields stay behind), an object as a plain object of its own
// enumerable fields in Object.keys order, a '__proto__' field defined as Cursor.value defines it. Each getter
// runs once. decode(encode(v)) would answer the same at 3.6-3.9x the cost of structuredClone on small rows (a
// TextEncoder and a TextDecoder per string, a DataView per number); this costs 0.4-0.7x of it (the pin in
// kernel/codec.perf.ts). The parity test in kernel/codec.test.ts holds it to the codec: a type the codec
// learns, copyOf must learn too.
//! `copied` — the bytes charged so far: a module slot, saved and restored per call, since a getter can copy too
let copied = 0
export const copyOf = (v: unknown, limit: Limit, from = 0, spent = 0): unknown => {
  const outer = copied, outerText = text
  if (at.length !== 0) at.length = 0
  text = false
  copied = spent
  try {
    return copy(v, from, limit)
  } catch (e) {
    const over = e === REFUSED && refusedWhy === OVER
    const u = new Unsendable(reasonOf(e, limit))
    u.over = over
    throw u
  } finally {
    copied = outer
    text = outerText
  }
}
const copy = (v: unknown, depth: number, limit: Limit): unknown => {
  if (depth > limit.depth) refuse(DEEP)
  let out: unknown = v
  switch (typeof v) {
    case 'number': copied += 8; break
    case 'string':
      //! charged before textOf reads it, so a string over the budget is refused unread
      copied += 4 + v.length * 3
      text = true
      if (copied > limit.bytes) refuse(OVER)
      out = textOf(v)
      break
    case 'boolean': case 'undefined': break
    case 'object': {
      if (v === null) break
      if (v instanceof Uint8Array) { if ((copied += 5 + v.length) > limit.bytes) refuse(OVER); out = new Uint8Array(v); break }
      const array = Array.isArray(v)
      if (limit.part !== undefined) { const why = limit.part(v, array); if (why !== null) refuse(why) }
      if (array) {
        const a = v as unknown[]
        const len = a.length
        if ((copied += 5 + len) > limit.bytes) refuse(OVER)
        const c = new Array(len)
        for (let i = 0; i < len; i++) {
          try { c[i] = copy(a[i], depth + 1, limit) } catch (e) { at.push(i); throw e }
        }
        out = c
        break
      }
      const o = v as Record<string, unknown>
      const ks = Object.keys(o)
      if ((copied += 5 + ks.length) > limit.bytes) refuse(OVER)
      const c: Record<string, unknown> = {}
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i]
        copied += 4 + k.length * 3
        let x: unknown
        try { x = copy(o[k], depth + 1, limit) } catch (e) { at.push(k); throw e }
        //! the key as the decoder reads it back (two keys that differ only in a lone surrogate become one, the
        // later value in the earlier place, as there), then defined like Cursor.value defines '__proto__'
        const t = textOf(k)
        if (t === '__proto__') Object.defineProperty(c, t, { value: x, enumerable: true, writable: true, configurable: true })
        else c[t] = x
      }
      out = c
      break
    }
    default: refuse(`a ${typeof v}`)
  }
  if (copied > limit.bytes) refuse(OVER)
  return out
}
//! textOf — a string as it comes back from UTF-8: a lone surrogate (half of a pair) has no UTF-8 spelling, so the
// encoder writes U+FFFD for it. Every other copy holds this text (the decoder keeps a leading U+FEFF since V4-52).
const textOf = (s: string): string => wellFormed(s) ? s : s.toWellFormed()
//! wellFormed — no half of a surrogate pair in it. Most strings in a row are short keys and words: those are scanned
// here, since only a code unit from U+D800 to U+DFFF can be one, and the scan costs less than a builtin call.
export const wellFormed = (s: string): boolean => {
  const n = s.length
  if (n > 32) return s.isWellFormed()
  for (let i = 0; i < n; i++) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdfff) return s.isWellFormed() }
  return true
}

//! ── Cursor — THE bounds-checked reader (exactly one; never inline a varint) ──
// Every length/count is checked against `end` BEFORE any allocation or slice —
// v2's rule, kept — but here the check exists once per primitive instead of
// being re-spelled at ~12 call sites (where two copies shipped truncation bugs).
export class Cursor {
  buf: Uint8Array
  pos: number
  end: number
  constructor(buf: Uint8Array, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end }
  need(n: number) { if (this.pos + n > this.end) throw new FrameError('frame truncated') }
  u8(): number { this.need(1); return this.buf[this.pos++] }
  u32(): number {
    this.need(4)
    const b = this.buf, p = this.pos
    this.pos += 4
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000
  }
  varint(): number {
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
  zigzag(): number { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2 }
  f64(): number {
    this.need(8)
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true)
    this.pos += 8
    return v
  }
  str(): string {
    const n = this.varint()
    this.need(n)
    const s = utf8d.decode(this.buf.subarray(this.pos, this.pos + n))
    this.pos += n
    return s
  }
  bytes(): Uint8Array {
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
  value(vt: number, depth = 0): unknown {
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
        const o: Record<string, unknown> = {}
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
  skipValue(vt: number, depth = 0) {
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

const writeRecord = (w: Writer, r: Rec) => {
  const vt = r.type === REC.remove ? VT.none : vtOf(r.value)
  w.u8((r.type & 3) | (r.at !== undefined ? HAS_AT : 0) | (vt << 3))
  w.varint(r.key.length)
  for (const seg of r.key) w.str(seg)
  if (r.at !== undefined) w.str(r.at)
  w.value(r.value, vt)
}

//! Prov: the per-frame provenance extension — one origin, contiguous seqs from baseSeq, one epoch.
export interface Prov { origin: string; baseSeq: number; epoch: number }
//! AttemptRun: the per-frame attempt-identity extension (FLAG_ATTEMPT) — one issuer, contiguous cids.
// Rides committed runs that originated as forwarded/relayed attempts, so replication itself feeds
// every node's cid-dedup window (see FLAG_ATTEMPT above for the ownership-move story).
export interface AttemptRun { issuer: string; baseCid: number }

//! ── Outbox — the streaming per-link frame encoder ─────────────────────────────
// One Outbox per link, reused forever: begin() stamps the header + provenance,
// add() appends records (count tracked, patched at finish), finish() back-patches
// bodyLen + count + crc and returns a FRESH COPY of the frame bytes. The copy is
// deliberate: both shells and the sim may retain the buffer past return
// (socket.write queues; sim delivers later), so handing out the reusable scratch
// would corrupt in-flight frames — one slice per FRAME per flush (not per record)
// is the M0 cost, revisited with a buffer ring in M8.
//! CUT BY SIZE (V4-51): a frame holds at most `cap` body bytes. add() appends a record if it fits; when it would pass
// the cap, the open frame goes to `pending` and the record opens the next frame of the SAME run (cut). The writer
// rolls back a record that did not fit, so a frame only ever holds whole records — an overflow used to throw after
// the record's tag and key were written, and the next flush shipped a frame the receiver refused ('frame truncated').
export class Outbox {
  w: Writer
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
  // A run longer than the cap also leaves in several frames (cut), each a valid run of its own.
  pending: Uint8Array[] = []
  //! the open frame's verb and whether it carries provenance: what cut() needs to begin the next frame of the run
  #verb = 0
  #prov = false
  #origin = ''
  #nextSeq = 0
  #epoch = 0
  #iss: string | undefined
  #nextCid = 0
  //! cap — the most body bytes one frame of this outbox may hold: MAX_FRAME, or a node's tune row `frame` (the test
  // seam). The writer is built here, once: its identity never changes (kernel/alloc.perf.ts R0b).
  constructor(cap = MAX_FRAME) { this.w = new Writer(cap + HEADER) }
  begin(verb: number, prov?: Prov, attempt?: AttemptRun, pp = false) {
    const w = this.w
    w.len = 0
    w.u8(MAGIC); w.u8((prov ? FLAG_PROV : 0) | (prov && attempt ? FLAG_ATTEMPT : 0) | (pp ? FLAG_PP : 0)); w.u8(verb)
    w.u32(0) // bodyLen, patched
    w.u32(0) // crc, patched
    this.#verb = verb
    this.#prov = !!prov
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
  continues(prov: Prov, attempt?: AttemptRun): boolean {
    return this.open &&
      prov.origin === this.#origin && prov.epoch === this.#epoch && prov.baseSeq === this.#nextSeq &&
      (attempt?.issuer ?? undefined) === this.#iss && (this.#iss === undefined || attempt!.baseCid === this.#nextCid)
  }
  //! rotate — finish the open frame into the pending list (shipped at the next flush, order kept).
  rotate() {
    const bytes = this.finish()
    if (bytes) this.pending.push(bytes)
  }
  //! add — append one record; when it would pass the cap, cut: the open frame goes to `pending` and the record opens
  // the next frame of the same run
  add(r: Rec, pp?: number) {
    if (!this.put(r, pp)) { this.cut(); this.put(r, pp) }
  }
  //! put — append one record if it fits under the cap: true. False when the frame is full, and then NOTHING of the
  // record is left in it (any throw rolls the writer back to the record's start). A record that does not fit even an
  // EMPTY frame throws: nobody could ever send it, so it must never have been stamped (V4-48 asks a local write, the
  // relay a client's — kernel/write.ts onWrite).
  put(r: Rec, pp?: number): boolean {
    const w = this.w, at = w.len
    try {
      if (this.pp) w.varint((pp ?? -1) + 1) // wire 0 = unknown predecessor (fails closed)
      writeRecord(w, r)
    } catch (e) {
      w.len = at
      if (e !== FULL) throw e
      if (this.count === 0) throw tooBig(w.limit - HEADER)
      return false
    }
    this.count++
    this.#nextSeq++
    this.#nextCid++
    return true
  }
  //! cut — finish the open frame into `pending` and begin the next frame of the same run where it stopped: the same
  // verb, origin, epoch, issuer and pp mode, its baseSeq and baseCid the next record's own
  cut() {
    const verb = this.#verb, prov = this.#prov, pp = this.pp
    const origin = this.#origin, seq = this.#nextSeq, epoch = this.#epoch, iss = this.#iss, cid = this.#nextCid
    this.pending.push(this.finish()!)
    this.begin(verb, prov ? { origin, baseSeq: seq, epoch } : undefined, prov && iss !== undefined ? { issuer: iss, baseCid: cid } : undefined, pp)
  }
  //! finish(): patch + checksum + hand over an owned copy. Returns null for an empty frame (nothing queued this step).
  finish(): Uint8Array | null {
    if (!this.open) return null
    this.open = false
    if (this.count === 0) return null
    const w = this.w
    const bodyLen = w.len - HEADER
    if (bodyLen > MAX_FRAME) throw new FrameError('frame exceeds MAX_FRAME')
    w.u32at(3, bodyLen)
    w.u32at(this.countAt, this.count)
    w.u32at(7, crcFrame(w.buf, w.len))
    const out = w.buf.slice(0, w.len)
    w.shrink(SHRINK)
    return out
  }
}
//! SHRINK — past this a writer's buffer goes back to 4 KiB once its frame is out: a per-link outbox is reused for the
// link's life, and one 200 MiB catch-up must not pin 256 MiB for good. A fitting steady cycle keeps its buffer (R0b).
const SHRINK = 1 << 24
//! tooBig — a record bigger than an empty frame reached the encoder: fero's own bug (a check before the stamp missed
// it), never a peer's fault — so a plain Error, loud, never a FrameError that would only drop a link
const tooBig = (cap: number): Error =>
  new Error(`a record bigger than one frame (${cap} bytes) reached the encoder — it can never be sent, so it must never be stamped`)

//! encodeControl: a control frame (HELLO/PING/...) carrying exactly ONE value as its body — v2's controlFrame shape, kept.
// Encodes into a MODULE-LEVEL scratch Writer (adversarial-review perf finding: a fresh 4KB Writer per
// control frame on the ACK/NACK paths) — safe because the kernel is single-threaded, encode never
// re-enters, and the return is always an owned slice. A rare oversized frame (a huge VIEW) is not
// allowed to pin its grown buffer forever: the scratch resets past 64KB — after a refused or failed
// encode too (one refused 256 MiB reply would otherwise keep the buffer). The failure leg is a catch
// that rethrows, not a finally: a finally on this path measured ~8% on small control frames, a catch 0%.
//! cap (V4-51): a control frame carries ONE value and cannot be cut. Past `cap` body bytes it throws FULL to the
// caller: RESULT and SUBREC ask the node's tune row `frame` (node.ts 'reply' / 'subOut'), and the api turns FULL into
// a typed refusal (api/methods.ts, reason 'too-large'); every other control frame asks MAX_FRAME.
const ctrl = new Writer()
export const encodeControl = (verb: number, value?: unknown, cap = MAX_FRAME): Uint8Array => {
  const w = ctrl
  if (w.limit !== cap + HEADER) w.setLimit(cap + HEADER)
  w.len = 0
  try {
    w.u8(MAGIC); w.u8(0); w.u8(verb)
    w.u32(0); w.u32(0)
    const vt = vtOf(value)
    w.u8(vt)
    w.value(value, vt)
  } catch (e) {
    w.shrink(1 << 16)
    throw e
  }
  w.u32at(3, w.len - HEADER)
  w.u32at(7, crcFrame(w.buf, w.len))
  const out = w.buf.slice(0, w.len)
  w.shrink(1 << 16)
  return out
}

//! encodeFrame: one-shot RECORDS encode (tests, catch-up). The hot path uses a per-link Outbox instead. ONE frame:
// a batch that does not fit one throws FULL (a FrameError, as before), never a quietly shorter frame.
export const encodeFrame = (records: Rec[], prov?: Prov): Uint8Array => {
  const o = new Outbox()
  o.begin(VERB.RECORDS, prov)
  for (const r of records) if (!o.put(r)) throw FULL
  return o.finish() ?? encodeEmpty(prov)
}
const encodeEmpty = (prov?: Prov): Uint8Array => {
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
type RunRec = { rec: Rec; origin: string; seq: number; epoch: number; iss?: string; cid?: number; pp?: number }
//! continuesRun: the ONE run rule — does `r` extend the run that starts at `head` and is `k` records long? Same
// origin, same epoch, the next seq, the same issuer, and (with attempt identity) the next cid. encodeRuns splits by
// it; node.ts #answer collects one frame's run at a time by it, so a ship can stop at a frame boundary without
// encoding the rest of the lane (the resume-cost fix of 2026-10-11).
export const continuesRun = (head: RunRec, k: number, r: RunRec): boolean =>
  r.origin === head.origin &&
  r.epoch === head.epoch &&
  r.seq === head.seq + k &&
  r.iss === head.iss &&
  (head.iss === undefined || r.cid === head.cid! + k)
//! Cut — one frame of a run and how many of the run's records it took (encodeRun's answer)
export interface Cut { bytes: Uint8Array; n: number }
//! CUT — encodeRun's one reused answer, like runsScratch: read it before the next call (the kernel is single-threaded)
const CUT: Cut = { bytes: new Uint8Array(0), n: 0 }
//! encodeRun (V4-51) — ONE frame from records[from..]: the run that starts there (continuesRun), as many of its
// records as fit `cap` body bytes, at least one. A frame ends inside a run only at the cap. encodeRuns is this in a
// loop; node.ts #answer, the commit's WAL rows and the snapshot call it frame by frame, so a ship that must stop has
// encoded nothing past where it stops (V4-42's rule: only the frames shipped this round are encoded).
export const encodeRun = (records: RunRec[], from: number, verb: number = VERB.RECORDS, withPp = false, cap = MAX_FRAME): Cut => {
  const o = runsScratch
  o.w.setLimit(cap + HEADER)
  const head = records[from]
  o.begin(verb, { origin: head.origin, baseSeq: head.seq, epoch: head.epoch },
    head.iss !== undefined ? { issuer: head.iss, baseCid: head.cid! } : undefined, withPp)
  o.put(head.rec, head.pp) // an empty frame takes the first record, or put throws: it could never be sent
  let j = from + 1
  while (j < records.length && continuesRun(head, j - from, records[j]) && o.put(records[j].rec, records[j].pp)) j++
  CUT.bytes = o.finish()!
  CUT.n = j - from
  return CUT
}
export const encodeRuns = (
  records: RunRec[],
  verb: number = VERB.RECORDS,
  //! withPp (M6 floor law): armed senders stamp every record's predecessor varint (FLAG_PP). NEVER a
  // run-split condition — pp is per-record data, so the split shape is identical either way.
  withPp = false,
  //! cap (V4-51): the most body bytes one frame may hold — MAX_FRAME, or a node's tune row `frame`. Under it the
  // frames are exactly the runs; a run bigger than it leaves in several frames, each cut where the next record
  // would not fit.
  cap = MAX_FRAME,
): Uint8Array[] => {
  const frames: Uint8Array[] = []
  for (let i = 0; i < records.length;) {
    const c = encodeRun(records, i, verb, withPp, cap)
    frames.push(c.bytes)
    i += c.n
  }
  return frames
}

//! ── Frame / RecordView — lazy zero-copy decode (v2's measured win, kept) ─────
//! RecordView: type/prov are immediate; key/at/value decode (and memoise) only when read — a relayed record is never parsed.
export class RecordView {
  #buf: Uint8Array
  #keyAt: number
  #vt: number
  #hasAt: boolean
  #key?: string[]
  #at?: string
  #value?: unknown
  #decoded = false
  #valueAt = 0
  #end: number
  readonly type: number
  origin: string
  seq: number
  epoch: number
  //! attempt identity (FLAG_ATTEMPT runs): the (issuer, cid) this record committed FROM — '' / 0 when absent
  issuer: string
  cid: number
  //! pp (FLAG_PP runs): the (origin, partition) sub-stream predecessor seq; -1 = UNKNOWN (flag
  // absent, or wire 0). Every floor-advance site must fail CLOSED on -1 (fold, never advance).
  pp: number
  constructor(buf: Uint8Array, tag: number, keyAt: number, end: number, origin: string, seq: number, epoch: number, issuer = '', cid = 0, pp = -1) {
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
  //! span — the record's own bytes on the wire, its tag through its value (no pp varint): the relay's size gate
  // reads it (kernel/write.ts onWrite) — no decode, two fields
  get span(): number { return this.#end - this.#keyAt + 1 }
  get key(): string[] { this.#head(); return this.#key! }
  get at(): string | undefined { this.#head(); return this.#at }
  get value(): unknown {
    if (!this.#decoded) {
      this.#head()
      this.#value = new Cursor(this.#buf, this.#valueAt, this.#end).value(this.#vt)
      this.#decoded = true
    }
    return this.#value
  }
  //! rec(): materialise a plain Rec (copies out of the receive chunk — the explicit retain point).
  rec(): Rec {
    const r: Rec = { type: this.type, key: this.key.slice() }
    if (this.#hasAt) r.at = this.at
    if (this.#vt !== VT.none) r.value = this.value
    return r
  }
}

//! Frame: a decoded view over ONE complete checksummed frame. Header getters are free; records() scans boundaries lazily.
export class Frame {
  buf: Uint8Array
  constructor(buf: Uint8Array) { this.buf = buf }
  get flags(): number { return this.buf[1] }
  get verb(): number { return this.buf[2] }
  #prov?: Prov | null
  #att?: AttemptRun | null
  #bodyAt(): number { return HEADER }
  prov(): Prov | null {
    if (this.#prov !== undefined) return this.#prov
    if ((this.flags & FLAG_PROV) === 0) return (this.#prov = null)
    const c = new Cursor(this.buf, this.#bodyAt())
    this.#prov = { origin: c.str(), baseSeq: c.varint(), epoch: c.varint() }
    //! the attempt extension nests INSIDE the prov parse so `end` always points at the record count
    this.#att = (this.flags & FLAG_ATTEMPT) !== 0 ? { issuer: c.str(), baseCid: c.varint() } : null
    ;(this.#prov as Prov & { end: number }).end = c.pos
    return this.#prov
  }
  //! attempt(): the run's attempt identity, when FLAG_ATTEMPT rode along (null otherwise).
  attempt(): AttemptRun | null {
    if (this.#att === undefined) this.prov()
    return this.#att ?? null
  }
  //! value: the single payload of a control frame.
  get value(): unknown {
    const c = new Cursor(this.buf, this.#bodyAt())
    return c.value(c.u8())
  }
  //! records(): boundary-scan into lazy RecordViews — values are SKIPPED, not decoded (the scan<full-decode contract).
  records(): RecordView[] {
    const p = this.prov()
    const a = this.attempt()
    const c = new Cursor(this.buf, p ? (p as Prov & { end: number }).end : this.#bodyAt())
    const count = c.u32()
    //! bound by REMAINING bytes / minimum record size (tag + key count = 2B) — pre-allocation is capped by
    // what the frame could possibly hold, same discipline as every other count check in this file
    if (count > (this.buf.length - c.pos) / 2) throw new FrameError('record count overruns frame')
    const out = new Array<RecordView>(count)
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
// A frame wholly inside one chunk is handed out as a VIEW of that chunk (no copy — v2's measured win, kept). A frame
// that straddles chunks is built in a buffer of its OWN as its bytes arrive (V4-51): the buffer starts at what is in
// hand (at least FIRST) and doubles, never past the frame's length, so arrival is LINEAR in the frame's size — every
// straddled byte is copied in once, plus once per doubling. The old carry was re-copied whole with every chunk, so a
// 16 MiB frame in 64 KiB chunks cost 62-82x a 2 MiB one (quadratic), where the cut frames of V4-51 made such frames
// common. The anti-OOM rules stand: magic and bodyLen are checked the moment the 11 header bytes are in hand, BEFORE
// any allocation they size, and a header alone never buys more than FIRST bytes — memory follows the bytes the peer
// has actually sent (at most max(FIRST, 2 × received)), where allocating the whole frame at its header would let
// one 11-byte header make this node hold up to 256 MiB. The crc is verified BEFORE a Frame is handed to dispatch, and
// no chunk is ever retained: a split header and a split frame are both copies (v2's chunk-pinning trap, closed).
const FIRST = 4096
export class Framer {
  //! a header split across chunks: its first #headN bytes (owned, reused)
  #head = new Uint8Array(HEADER)
  #headN = 0
  //! a frame split across chunks: an owned buffer holding its first #have of its #need bytes; null when none
  #part: Uint8Array | null = null
  #have = 0
  #need = 0
  //! held — the bytes this framer holds between pushes (the test seam for the anti-OOM bound)
  get held(): number { return this.#part !== null ? this.#part.length : this.#headN > 0 ? HEADER : 0 }
  push(chunk: Uint8Array): Frame[] {
    const out: Frame[] = []
    let at = 0
    //! 1. a header the last chunk began: complete it from this one, then judge it like any header
    if (this.#headN > 0) {
      const take = Math.min(HEADER - this.#headN, chunk.length)
      this.#head.set(chunk.subarray(0, take), this.#headN)
      this.#headN += take
      at = take
      if (this.#headN < HEADER) return out
      this.#headN = 0
      this.#start(this.#head, 0, HEADER, chunk.length - at, judge(this.#head, 0))
    }
    //! 2. a frame the last chunks began: copy in only the bytes it still needs
    if (this.#part !== null) {
      const take = Math.min(this.#need - this.#have, chunk.length - at)
      this.#fill(chunk, at, take)
      at += take
      if (this.#have < this.#need) return out
      const frame = this.#part // exactly the frame's length: its growth stops there
      this.#part = null
      this.#have = this.#need = 0
      if (crcFrame(frame, frame.length) !== readU32(frame, 7)) throw new FrameError('bad crc')
      out.push(new Frame(frame))
    }
    //! 3. every frame wholly inside the chunk: a view, no copy
    while (chunk.length - at >= HEADER) {
      const need = judge(chunk, at)
      if (chunk.length - at < need) { this.#start(chunk, at, chunk.length - at, 0, need); return out }
      const frame = chunk.subarray(at, at + need)
      if (crcFrame(frame, frame.length) !== readU32(frame, 7)) throw new FrameError('bad crc')
      out.push(new Frame(frame))
      at += need
    }
    //! 4. a header split at the chunk's end: copied into the owned head, never viewed
    if (at < chunk.length) { this.#head.set(chunk.subarray(at), 0); this.#headN = chunk.length - at }
    return out
  }
  //! #start — open a split frame from its first n bytes at src[at..], with `more` bytes of this chunk still to come:
  // the first buffer is the whole frame when that is small or already in hand, else what is in hand (at least FIRST)
  #start(src: Uint8Array, at: number, n: number, more: number, need: number) {
    const part = new Uint8Array(Math.min(need, Math.max(FIRST, n + more)))
    part.set(src.subarray(at, at + n), 0)
    this.#part = part
    this.#have = n
    this.#need = need
  }
  //! #fill — append n bytes of chunk[at..] to the split frame, doubling its buffer (never past the frame's length)
  // when they do not fit
  #fill(chunk: Uint8Array, at: number, n: number) {
    let part = this.#part!
    if (this.#have + n > part.length) {
      let cap = part.length * 2
      while (cap < this.#have + n) cap *= 2
      if (cap > this.#need) cap = this.#need
      const next = new Uint8Array(cap)
      next.set(part.subarray(0, this.#have), 0)
      part = this.#part = next
    }
    part.set(chunk.subarray(at, at + n), this.#have)
    this.#have += n
  }
}
//! judge — a header's two checks, magic then size, before anything is allocated by its length: HEADER + bodyLen
const judge = (b: Uint8Array, at: number): number => {
  if (b[at] !== MAGIC) throw new FrameError('bad magic')
  const bodyLen = readU32(b, at + 3)
  if (bodyLen > MAX_FRAME) throw new FrameError('frame exceeds MAX_FRAME')
  return HEADER + bodyLen
}
const readU32 = (b: Uint8Array, p: number): number =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000
