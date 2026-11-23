// E-63 shared helpers: fero's seam and codec from the scratch tree (tree.sh), E-07's row shapes, the judge,
// the wire framing, a journal with group commit (E-02's), and small stats helpers.
// Every thread that imports this file gets its own copy of data and the codec.
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { performance, PerformanceObserver } from 'node:perf_hooks'

export const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the scratch tree built by tree.sh')
export const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href)
export const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
export const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
export const UPDATE = 0, INSERT = 1, REMOVE = 2

export const now = () => performance.timeOrigin + performance.now() // absolute ms, comparable across threads and processes

// E-07's rows. small: E-05's ~100 B row. big: the same plus a 1,890-character text field, about 2 KB.
const BODY = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(25).slice(0, 1890)
export const row = (shape, i, s) => {
  const r = { name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] }
  if (shape === 'big') r.body = BODY + String(s % 1e9).padStart(10, '0')
  return r
}
export const key = (i) => 'k' + i
export const decodeFrame = (u8) => { const rv = new C.Frame(u8).records(); const r = new Array(rv.length); for (let i = 0; i < rv.length; i++) r[i] = rv[i].rec(); return r }

// The rows a replica starts with, as insert records in fero frames of 256 (E-07's load), so every string is a
// decoded string owned by its row. fn(recs) gets each decoded batch.
export const loadRows = (n, shape, fn) => {
  for (let i = 0; i < n; i += 256) {
    const recs = []
    for (let j = i; j < Math.min(n, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(shape, j, 0) })
    fn(decodeFrame(C.encodeFrame(recs)))
  }
}

// The slot a key hashes to (FNV-1a 32 over the key's code units, 4,096 slots).
export const slotOf = (k) => { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) & 4095 }

// ── the judge ────────────────────────────────────────────────────────────────────────────────────────
// One write, judged against the log end: the committed rows (readRow) plus the overlay of judged writes not yet
// folded (ov: key → { row, pend }, row null = removed at the log end). Writes (from the client, as JSON):
//   { q, o: 'f', k, f, v }    a field write: row[f] = v. Refused absent-row, bad-shape.
//   { q, o: 'i', k, v }       an op: incr(n, v). Refused absent-row, conflict (n not a number).
//   { q, o: 'c', k, eq, v }   a conditional whole-row set, if: { equals } on the row's region. Refused absent-row, conflict.
//   { q, o: 's', k, v }       a plain whole-row set (no if, no once, no from): cannot be refused on the row's state.
//   { q, o: 'r', k }          a plain remove: a remove that finds nothing commits nothing and answers as done.
// A key '__proto__' is refused bad-key (the shape rule's one check that needs no row).
// Out: pushes the record to out.recs, its attempt seq to out.aseq, its slot to out.slot; the answer to out.ans.
export const OK = 0, ABSENT_ROW = 1, CONFLICT = 2, BAD_SHAPE = 3, BAD_KEY = 4, DUP = 5, RULE_TIMEOUT = 6
export const PLAIN = (w) => w.o === 's' || w.o === 'r'
const REMOVED = null
export const judge = (w, readRow, ov, out) => {
  const k = w.k
  if (k === '__proto__') { out.ans.push(w.q, BAD_KEY); return }
  const o = ov.get(k)
  const cur = o !== undefined ? (o.row === REMOVED ? undefined : o.row) : readRow(k)
  let rec, next
  switch (w.o) {
    case 'f':
      if (cur === undefined) { out.ans.push(w.q, ABSENT_ROW); return }
      if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) { out.ans.push(w.q, BAD_SHAPE); return }
      rec = { type: UPDATE, key: [k, w.f], value: w.v }; next = { ...cur, [w.f]: w.v }; break
    case 'i': {
      if (cur === undefined) { out.ans.push(w.q, ABSENT_ROW); return }
      const n = cur.n
      if (typeof n !== 'number') { out.ans.push(w.q, CONFLICT); return }
      rec = { type: UPDATE, key: [k, 'n'], value: n + w.v }; next = { ...cur, n: n + w.v }; break
    }
    case 'c':
      if (cur === undefined) { out.ans.push(w.q, ABSENT_ROW); return }
      if (cur.region !== w.eq) { out.ans.push(w.q, CONFLICT); return }
      rec = { type: UPDATE, key: [k], value: w.v }; next = w.v; break
    case 's':
      rec = { type: UPDATE, key: [k], value: w.v }; next = w.v; break
    case 'r':
      if (cur === undefined) { out.ans.push(w.q, OK); return }
      rec = { type: REMOVE, key: [k] }; next = REMOVED; break
    default: throw new Error('unknown write ' + w.o)
  }
  if (o !== undefined) { o.row = next; o.pend++ } else ov.set(k, { row: next, pend: 1 })
  out.recs.push(rec); out.aseq.push(w.q); out.slot.push(slotOf(k)); out.ans.push(w.q, OK)
}
// A plain write as a record, with no row read (the worker's direct path in form M1, and the control `none`).
export const plainRec = (w) => w.o === 'r' ? { type: REMOVE, key: [w.k] } : w.o === 's' ? { type: UPDATE, key: [w.k], value: w.v }
  : w.o === 'f' ? { type: UPDATE, key: [w.k, w.f], value: w.v } : w.o === 'i' ? { type: UPDATE, key: [w.k, 'n'], value: w.v } : { type: UPDATE, key: [w.k], value: w.v }

// The session table (E-20's `sess`): per session, the outcomes at or above the floor. One session here; the
// client's sequences rise, so every attempt is fresh; the table still does its Map work per write.
export class Sessions {
  constructor(window = 1024) { this.m = new Map(); this.hi = 0; this.window = window }
  fresh(q) {
    if (q <= this.hi - this.window || this.m.has(q)) return false
    this.m.set(q, 1); if (q > this.hi) this.hi = q
    if (this.m.size > 2 * this.window) { const floor = this.hi - this.window; for (const s of this.m.keys()) { if (s > floor) break; this.m.delete(s) } }
    return true
  }
}

// ── wire ─────────────────────────────────────────────────────────────────────────────────────────────
// Every message: u32 len (bytes after it), u8 type, body.
export const T_ASK = 1, T_ANS = 2, T_APPEND = 3, T_HB = 4, T_ACK = 5
export const framer = (onMsg) => {
  let rest = null
  return (chunk) => {
    const b = rest ? Buffer.concat([rest, chunk]) : chunk
    let off = 0
    while (b.length - off >= 5) {
      const len = b.readUInt32LE(off)
      if (b.length - off - 4 < len) break
      onMsg(b[off + 4], b.subarray(off + 5, off + 4 + len))
      off += 4 + len
    }
    rest = off < b.length ? b.subarray(off) : null
  }
}
export const msg = (type, body) => { const h = Buffer.allocUnsafe(5); h.writeUInt32LE(body.length + 1, 0); h[4] = type; return [h, body] }

// A log entry (one batch): u32 term, u32 idx, u32 n, u32 crc32 (of what follows), n × u32 attempt seq,
// n × u32 slot sequence, then the records as one fero codec frame. The same bytes are the APPEND's body, the
// journal row, and what crosses to main for the fold.
export const ENTRY_HDR = 16
export const makeEntry = (term, idx, aseq, sseq, frame) => {
  const n = aseq.length, e = Buffer.allocUnsafe(ENTRY_HDR + 8 * n + frame.length)
  e.writeUInt32LE(term, 0); e.writeUInt32LE(idx, 4); e.writeUInt32LE(n, 8)
  for (let i = 0; i < n; i++) { e.writeUInt32LE(aseq[i] >>> 0, ENTRY_HDR + 4 * i); e.writeUInt32LE(sseq[i] >>> 0, ENTRY_HDR + 4 * n + 4 * i) }
  e.set(frame, ENTRY_HDR + 8 * n)
  e.writeUInt32LE(zlib.crc32(e.subarray(ENTRY_HDR)) >>> 0, 12)
  return e
}
export const checkEntry = (e) => (zlib.crc32(e.subarray(ENTRY_HDR)) >>> 0) === e.readUInt32LE(12)

// ── journal: group commit (E-02's): whatever is queued goes out in one writev, then one fdatasync ──────
export class Journal {
  constructor(path, onDurable) { this.fd = fs.openSync(path, 'w'); this.q = []; this.qIdx = 0; this.busy = false; this.flushes = 0; this.onDurable = onDurable; this.path = path }
  push(buf, idx) { this.q.push(buf); this.qIdx = idx; if (!this.busy) this.flush() }
  flush() {
    if (this.q.length === 0) return
    const bufs = this.q, idx = this.qIdx; this.q = []
    for (let i = 0; i < bufs.length; i += 1024) fs.writevSync(this.fd, bufs.length <= 1024 ? bufs : bufs.slice(i, i + 1024))
    this.flushes++; this.busy = true
    fs.fdatasync(this.fd, (err) => { if (err) throw err; this.busy = false; this.onDurable(idx); this.flush() })
  }
  close() { try { fs.closeSync(this.fd); fs.unlinkSync(this.path) } catch {} }
}

// An order-free digest of a set of rows (F-21's kind): the sum over rows of FNV-1a of key + JSON of the row.
export const digest = (each) => { let sum = 0, n = 0; each((k, r) => { const t = k + '\u0000' + JSON.stringify(r); let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) } sum = (sum + (h >>> 0)) % 4294967296; n++ }); return n + ':' + sum.toString(16) }

// ── stats ────────────────────────────────────────────────────────────────────────────────────────────
export const q = (s, f) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null)
export const st = (xs) => {
  if (!xs.length) return { n: 0 }
  const s = Float64Array.from(xs).sort()
  const r = (v) => (v === null ? null : +v.toFixed(3))
  return { n: s.length, p50: r(q(s, 0.5)), p99: r(q(s, 0.99)), p999: r(q(s, 0.999)), max: r(s[s.length - 1]) }
}
export const eldSummary = (h) => ({ p50: +(h.percentile(50) / 1e6).toFixed(2), p99: +(h.percentile(99) / 1e6).toFixed(2), p999: +(h.percentile(99.9) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) })
export const mb = (b) => Math.round(b / 2 ** 20)

// ── Bs: B's copy cut into 256 Maps by the key's slot (added after review) ─────────────────────────────
// V8 rebuilds a Map's table in one go when its entries (live and removed) fill it; a Map of a million keys
// then stops its thread for about 0.1 s. 256 Maps of about 4,000 keys each rebuild one at a time, each about
// 1/256 of that. Same calls as a Map for what the server uses.
export class ShardedMap {
  constructor(shards = 256) { this.s = Array.from({ length: shards }, () => new Map()); this.mask = shards - 1 }
  #m(k) { return this.s[slotOf(k) & this.mask] }
  get(k) { return this.#m(k).get(k) }
  set(k, v) { this.#m(k).set(k, v); return this }
  delete(k) { return this.#m(k).delete(k) }
  get size() { let n = 0; for (const m of this.s) n += m.size; return n }
  forEach(fn) { for (const m of this.s) m.forEach(fn) }
}

// ── B2: rows off the V8 heap ─────────────────────────────────────────────────────────────────────────
// A row store with no JavaScript object per row, so a thread that holds a million rows keeps a small heap and
// short collections: an arena of bytes (one record per row: u16 key length, the key, u32 room, u32 length, the
// row as JSON, then slack) and an open-addressing index in typed arrays (a hash, an offset and a version per
// slot; load ≤ 0.5). get() parses the row's JSON (a short-lived object); set() rewrites the record in place when
// it fits its room, else appends a new one. Removed rows and moved records leave garbage in the arena (counted,
// not reclaimed: the runs are short). Keys are compared byte by byte.
const EMPTY = 0, GONE = 0xffffffff
export class CompactRows {
  constructor(rows, arenaBytes) {
    this.cap = 1 << Math.ceil(Math.log2(Math.max(16, rows * 2)))
    this.mask = this.cap - 1
    this.hs = new Uint32Array(this.cap); this.offs = new Uint32Array(this.cap); this.vers = new Uint32Array(this.cap)
    this.buf = Buffer.allocUnsafeSlow(arenaBytes); this.end = 8; this.n = 0; this.used = 0; this.dead = 0
  }
  #find(k) { // → slot index of k, or ~(first free slot) when absent
    let h = 0x811c9dc5, ascii = true
    for (let i = 0; i < k.length; i++) { const c = k.charCodeAt(i); if (c > 127) ascii = false; h ^= c; h = Math.imul(h, 16777619) }
    h = (h | 1) >>> 0
    const kb = ascii ? null : Buffer.from(k)
    let i = h & this.mask, free = -1
    for (;;) {
      const o = this.offs[i]
      if (o === EMPTY) return ~(free >= 0 ? free : i)
      if (o === GONE) { if (free < 0) free = i }
      else if (this.hs[i] === h && this.#keyIs(o, k, kb)) return i
      i = (i + 1) & this.mask
    }
  }
  #keyIs(o, k, kb) {
    const b = this.buf, n = b.readUInt16LE(o)
    if (kb) { if (n !== kb.length) return false; for (let j = 0; j < n; j++) if (b[o + 2 + j] !== kb[j]) return false; return true }
    if (n !== k.length) return false
    for (let j = 0; j < n; j++) if (b[o + 2 + j] !== k.charCodeAt(j)) return false
    return true
  }
  #hash(k) { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) } return (h | 1) >>> 0 }
  get size() { return this.n }
  get(k) {
    const i = this.#find(k); if (i < 0) return undefined
    const o = this.offs[i], b = this.buf, v = o + 2 + b.readUInt16LE(o) + 8
    return JSON.parse(b.toString('utf8', v, v + b.readUInt32LE(v - 4)))
  }
  set(k, row, ver = 0) {
    const json = JSON.stringify(row), len = Buffer.byteLength(json)
    let i = this.#find(k)
    if (i >= 0) { // in place when it fits
      const o = this.offs[i], b = this.buf, v = o + 2 + b.readUInt16LE(o) + 8
      if (len <= b.readUInt32LE(v - 8)) { b.write(json, v, 'utf8'); b.writeUInt32LE(len, v - 4); this.vers[i] = ver; return }
      this.dead += b.readUInt32LE(v - 8)
    } else { i = ~i; this.n++ }
    const kb = Buffer.byteLength(k), room = len + 16 + (len >> 3), need = 2 + kb + 8 + room
    if (this.end + need > this.buf.length) this.#grow(need)
    const b = this.buf, o = this.end
    b.writeUInt16LE(kb, o); b.write(k, o + 2, 'utf8'); b.writeUInt32LE(room, o + 2 + kb); b.writeUInt32LE(len, o + 6 + kb); b.write(json, o + 10 + kb, 'utf8')
    this.end += need; this.used += need
    this.hs[i] = this.#hash(k); this.offs[i] = o; this.vers[i] = ver
  }
  delete(k) { const i = this.#find(k); if (i < 0) return; const o = this.offs[i]; this.dead += 2 + this.buf.readUInt16LE(o) + 8 + this.buf.readUInt32LE(o + 2 + this.buf.readUInt16LE(o)); this.offs[i] = GONE; this.n-- }
  #grow(need) { const nb = Buffer.allocUnsafeSlow(Math.max(this.buf.length * 2, this.end + need)); this.buf.copy(nb, 0, 0, this.end); this.buf = nb; this.grows = (this.grows ?? 0) + 1 }
  forEach(fn) { for (let i = 0; i < this.cap; i++) { const o = this.offs[i]; if (o === EMPTY || o === GONE) continue; const b = this.buf, kl = b.readUInt16LE(o), v = o + 2 + kl + 8; fn(JSON.parse(b.toString('utf8', v, v + b.readUInt32LE(v - 4))), b.toString('utf8', o + 2, o + 2 + kl)) } }
  bytes() { return { arena_mb: mb(this.buf.length), written_mb: mb(this.end), dead_mb: mb(this.dead), index_mb: mb(this.cap * 12), grows: this.grows ?? 0 } }
  // The upkeep the full runs never reach (added after review; only the side probe calls these, to time each as
  // one block): rehash() moves the index into one of twice the slots (what the store must do once rows pass half
  // its slots); compact() copies the live records into a fresh arena and drops the dead space.
  rehash() {
    const cap = this.cap * 2, mask = cap - 1, hs = new Uint32Array(cap), offs = new Uint32Array(cap), vers = new Uint32Array(cap)
    for (let i = 0; i < this.cap; i++) {
      const o = this.offs[i]; if (o === EMPTY || o === GONE) continue
      let j = this.hs[i] & mask; while (offs[j] !== EMPTY) j = (j + 1) & mask
      hs[j] = this.hs[i]; offs[j] = o; vers[j] = this.vers[i]
    }
    this.cap = cap; this.mask = mask; this.hs = hs; this.offs = offs; this.vers = vers
  }
  compact() {
    const nb = Buffer.allocUnsafeSlow(this.buf.length), b = this.buf; let end = 8
    for (let i = 0; i < this.cap; i++) {
      const o = this.offs[i]; if (o === EMPTY || o === GONE) continue
      const kl = b.readUInt16LE(o), n = 2 + kl + 8 + b.readUInt32LE(o + 2 + kl)
      b.copy(nb, end, o, o + n); this.offs[i] = end; end += n
    }
    this.buf = nb; this.end = end; this.used = end; this.dead = 0
  }
}

// GC pauses on this thread, as perf_hooks reports them (E-07's watcher), kept with their absolute start time
export const gcLog = () => {
  const KIND = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb' } // perf_hooks.constants NODE_PERFORMANCE_GC_*
  const list = []
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) list.push([performance.timeOrigin + e.startTime, e.duration, KIND[e.detail?.kind] ?? String(e.detail?.kind)]) })
  obs.observe({ entryTypes: ['gc'] })
  return { list, summary: (from, to) => { const xs = list.filter((x) => x[0] >= from && x[0] < to); const ms = xs.map((x) => x[1]); const s = st(ms); return { n: xs.length, sum_ms: +ms.reduce((a, b) => a + b, 0).toFixed(1), max_ms: s.max ?? 0, p99_ms: s.p99 ?? 0, over_50ms: ms.filter((m) => m > 50).length, major_n: xs.filter((x) => x[2] === 'major').length, major_max_ms: +Math.max(0, ...xs.filter((x) => x[2] === 'major').map((x) => x[1])).toFixed(1), top: [...xs].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => [+x[1].toFixed(1), x[2]]) } } }
}
