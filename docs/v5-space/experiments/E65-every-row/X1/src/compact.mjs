// E-65 X1: compact row storage that keeps rows OFF the V8 heap's object graph, and needs no JS Map (so no
// 16,777,216-key ceiling). Plain JavaScript over ArrayBuffers; data is not used here (data keeps rows as objects).
//   KeyIndex      an open-addressing hash table in typed arrays: row key -> row id. Keys live as bytes in a key
//                 arena. Deletes leave tombstones (rule C1: a probe walks past a tombstone, never stops at it).
//   ArenaStore    each row as JSON bytes in 64 MB chunks; an id's address points at its newest bytes. A write to
//                 a field decodes the row, patches it and appends it again. Dead bytes are reclaimed by compact().
//                 With { file } the chunks live in a file instead (keys and addresses in memory, values on disk).
//   ColumnStore   fixed columns for the row shape (numbers in Float64Array, low-cardinality strings by dictionary,
//                 the title in a byte arena), a presence bit per field, and an overflow Map for rows that do not
//                 fit the columns. With { shared: true } the columns are SharedArrayBuffers another thread can read.
//   SortedCol     a chunked sorted list of numbers: insert, remove and the k-th value, for a live median.
// Planted bugs (mutate): 'tombstop' (a probe stops at a tombstone), 'compactaddr' (compaction forgets to move
// an address), 'presence' (deleting a field leaves its presence bit set), 'nooverflow' (a row that does not fit
// the columns is forced in: a non-number becomes NaN).
import { hash32 } from './lib.mjs'
import { openSync, writeSync, readSync, closeSync, unlinkSync } from 'node:fs'

const enc = new TextEncoder(), dec = new TextDecoder()
// bytes to text: a JS loop for short ASCII (TextDecoder's call costs more than the loop), TextDecoder otherwise
function utf8(b, o, n) {
  if (n > 64) return dec.decode(b.subarray(o, o + n))
  let s = ''
  for (let i = o; i < o + n; i++) { const c = b[i]; if (c > 127) return dec.decode(b.subarray(o, o + n)); s += String.fromCharCode(c) }
  return s
}
const isAscii = (s) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false; return true }

// ── growable typed arrays ─────────────────────────────────────────────────────────────────────────
function grow(arr, n, shared = false) {
  if (arr.length >= n) return arr
  let cap = Math.max(1024, arr.length)
  while (cap < n) cap *= 2
  const C = arr.constructor
  const out = shared ? new C(new SharedArrayBuffer(cap * C.BYTES_PER_ELEMENT)) : new C(cap)
  out.set(arr)
  return out
}

export class KeyIndex {
  constructor({ mutate = '', shared = false, cap = 0 } = {}) { // cap: rows to size for at the start (no doubling while loading)
    this.mutate = mutate; this.shared = shared
    let c = 1 << 12; while (c < cap * 2.2) c *= 2
    this.cap = c; this.tab = new Int32Array(this.cap) // 0 empty, -1 tombstone, id+1 live
    this.used = 0; this.tomb = 0
    this.kbytes = new Uint8Array(Math.max(1 << 16, cap * 10)); this.kfill = 0
    const n = Math.max(1024, cap)
    this.koff = new Float64Array(n); this.klen = new Uint16Array(n); this.khash = new Uint32Array(n)
    this.free = []; this.next = 0; this.live = 0
  }
  _eq(id, key) {
    const n = this.klen[id], o = this.koff[id], b = this.kbytes
    if (isAscii(key)) {
      if (n !== key.length) return false
      for (let i = 0; i < n; i++) if (b[o + i] !== key.charCodeAt(i)) return false
      return true
    }
    return utf8(b, o, n) === key
  }
  _slot(key, h) { // the table slot holding key, or -1
    const m = this.cap - 1
    for (let i = h & m, probes = 0; probes < this.cap; i = (i + 1) & m, probes++) {
      const t = this.tab[i]
      if (t === 0) return -1
      if (t === -1) { if (this.mutate === 'tombstop') return -1; continue }
      const id = t - 1
      if (this.khash[id] === h && this._eq(id, key)) return i
    }
    return -1
  }
  find(key) { const h = hash32(key), s = this._slot(key, h); return s < 0 ? -1 : this.tab[s] - 1 }
  add(key) { // key must be absent; returns its new id
    if ((this.used + this.tomb + 1) * 2 > this.cap) this._rehash(this.live * 4 > this.cap ? this.cap * 2 : this.cap)
    const h = hash32(key)
    const id = this.free.length ? this.free.pop() : this.next++
    if (id >= this.koff.length) { const n = id + 1; this.koff = grow(this.koff, n); this.klen = grow(this.klen, n); this.khash = grow(this.khash, n) }
    const kb = isAscii(key) ? null : enc.encode(key)
    const len = kb ? kb.length : key.length
    if (this.kfill + len > this.kbytes.length) this._kcompactOrGrow(len)
    if (kb) this.kbytes.set(kb, this.kfill); else for (let i = 0; i < len; i++) this.kbytes[this.kfill + i] = key.charCodeAt(i)
    this.koff[id] = this.kfill; this.klen[id] = len; this.khash[id] = h; this.kfill += len
    const m = this.cap - 1
    let i = h & m
    while (this.tab[i] > 0) i = (i + 1) & m
    if (this.tab[i] === -1) this.tomb--
    this.tab[i] = id + 1; this.used++; this.live++
    return id
  }
  del(key) {
    const h = hash32(key), s = this._slot(key, h)
    if (s < 0) return -1
    const id = this.tab[s] - 1
    this.tab[s] = -1; this.used--; this.tomb++; this.live--
    this.klen[id] = 0; this.free.push(id)
    return id
  }
  keyOf(id) { return utf8(this.kbytes, this.koff[id], this.klen[id]) }
  each(fn) { for (let i = 0; i < this.cap; i++) { const t = this.tab[i]; if (t > 0) fn(t - 1) } }
  _rehash(cap) {
    const old = this.tab
    this.cap = cap; this.tab = new Int32Array(cap); this.tomb = 0
    const m = cap - 1
    for (let i = 0; i < old.length; i++) { const t = old[i]; if (t > 0) { let j = this.khash[t - 1] & m; while (this.tab[j] !== 0) j = (j + 1) & m; this.tab[j] = t } }
  }
  _kcompactOrGrow(len) { // rewrite live keys only; grow if still short
    let liveBytes = 0
    this.each((id) => { liveBytes += this.klen[id] })
    let cap = this.kbytes.length
    while (liveBytes + len > cap / 2) cap *= 2
    const nb = new Uint8Array(cap)
    let f = 0
    this.each((id) => { const o = this.koff[id], n = this.klen[id]; nb.set(this.kbytes.subarray(o, o + n), f); this.koff[id] = f; f += n })
    this.kbytes = nb; this.kfill = f
  }
  bytes() { return this.tab.byteLength + this.kbytes.byteLength + this.koff.byteLength + this.klen.byteLength + this.khash.byteLength + this.free.length * 8 }
}

// ── rows as JSON bytes ───────────────────────────────────────────────────────────────────────────────
let CHUNK = 1 << 26 // 64 MB; the seeded run sets a smaller one so that compaction runs
export const setChunk = (n) => { CHUNK = n }
export class ArenaStore {
  constructor({ mutate = '', file = null } = {}) {
    this.mutate = mutate
    this.ix = new KeyIndex({ mutate })
    this.addr = new Float64Array(1024); this.len = new Uint32Array(1024)
    this.file = file; this.fd = file ? openSync(file, 'w+') : -1
    this.chunks = []; this.cur = null; this.fill = 0; this.pos = 0 // pos: bytes written in all
    this.wbuf = file ? new Uint8Array(1 << 20) : null; this.wfill = 0; this.wbase = 0 // file mode: a write buffer
    this.dead = 0; this.liveBytes = 0
    this.scratch = new Uint8Array(1 << 16)
    this._newChunk()
  }
  _newChunk() { if (this.file) return; this.cur = new Uint8Array(CHUNK); this.chunks.push(this.cur); this.fill = 0 }
  _put(id, row) {
    const s = JSON.stringify(row)
    if (s.length * 3 > this.scratch.length) this.scratch = new Uint8Array(s.length * 3)
    const n = enc.encodeInto(s, this.scratch).written
    if (id >= this.addr.length) { this.addr = grow(this.addr, id + 1); this.len = grow(this.len, id + 1) }
    if (this.len[id]) this.dead += this.len[id], this.liveBytes -= this.len[id]
    if (this.file) {
      if (this.wfill + n > this.wbuf.length) this._flush()
      this.wbuf.set(this.scratch.subarray(0, n), this.wfill)
      this.addr[id] = this.wbase + this.wfill; this.wfill += n
    } else {
      if (this.fill + n > CHUNK) this._newChunk()
      this.cur.set(this.scratch.subarray(0, n), this.fill)
      this.addr[id] = (this.chunks.length - 1) * CHUNK + this.fill; this.fill += n
    }
    this.len[id] = n; this.liveBytes += n
  }
  _flush() { if (this.wfill) { writeSync(this.fd, this.wbuf, 0, this.wfill, this.wbase); this.wbase += this.wfill; this.wfill = 0 } }
  _bytes(id) {
    const a = this.addr[id], n = this.len[id]
    if (this.file) {
      if (a >= this.wbase) return this.wbuf.subarray(a - this.wbase, a - this.wbase + n)
      if (n > this.scratch.length) this.scratch = new Uint8Array(n * 2)
      readSync(this.fd, this.scratch, 0, n, a)
      return this.scratch.subarray(0, n)
    }
    const c = Math.floor(a / CHUNK), o = a - c * CHUNK
    return this.chunks[c].subarray(o, o + n)
  }
  _row(id) { return JSON.parse(dec.decode(this._bytes(id))) }
  get(k) { const id = this.ix.find(k); return id < 0 ? undefined : this._row(id) }
  apply(recs) {
    for (const r of recs) {
      if (r.type === 1) { const k = r.at; let id = this.ix.find(k); if (id < 0) id = this.ix.add(k); this._put(id, r.value); continue }
      const k = r.key[0]
      if (r.key.length === 1) {
        if (r.type === 0) { let id = this.ix.find(k); if (id < 0) id = this.ix.add(k); this._put(id, r.value) }
        else { const id = this.ix.del(k); if (id >= 0) { this.dead += this.len[id]; this.liveBytes -= this.len[id]; this.len[id] = 0 } }
        continue
      }
      const id = this.ix.find(k)
      if (id < 0) continue // a field write on a missing row: data refuses it; here it is dropped
      const row = this._row(id), f = r.key[1]
      if (r.type === 0) row[f] = r.value; else delete row[f]
      this._put(id, row)
    }
    if (!this.file && this.dead > this.liveBytes && this.dead > CHUNK) this.compact()
  }
  compact() { // copy live rows into fresh chunks, in id order
    const old = this.chunks, oldAddr = this.addr
    this.chunks = []; this._newChunk(); this.dead = 0
    const n = this.ix.next
    for (let id = 0; id < n; id++) {
      const len = this.len[id]
      if (!len) continue
      const a = oldAddr[id], c = Math.floor(a / CHUNK), o = a - c * CHUNK
      if (this.fill + len > CHUNK) this._newChunk()
      this.cur.set(old[c].subarray(o, o + len), this.fill)
      if (this.mutate === 'compactaddr' && (id % 97) === 13) { this.fill += len; continue }
      this.addr[id] = (this.chunks.length - 1) * CHUNK + this.fill; this.fill += len
    }
    this.compactions = (this.compactions ?? 0) + 1
  }
  count() { return this.ix.live }
  each(fn) { this.ix.each((id) => fn(this.ix.keyOf(id), this._row(id))) }
  field(f, fn) { this.ix.each((id) => { const v = this._row(id)[f]; fn(v) }) }
  offHeapBytes() { return this.ix.bytes() + this.addr.byteLength + this.len.byteLength + (this.file ? this.wbuf.byteLength : this.chunks.length * CHUNK) }
  usedBytes() { return this.ix.bytes() + this.addr.byteLength + this.len.byteLength + this.liveBytes + this.dead }
  close() { if (this.file) { closeSync(this.fd); try { unlinkSync(this.file) } catch {} } }
}

// ── rows as columns ──────────────────────────────────────────────────────────────────────────────────
// The shape the columns take. Each field: 'num' (Float64Array), 'dict' (Int32Array ids into one dictionary),
// 'bool' (Uint8Array), 'text' (bytes in an arena). A value of another type, or a field not listed, sends the
// whole row to the overflow Map (kept as a plain object), where every read finds it first.
export const SHAPE = { user: 'dict', cents: 'num', score: 'num', paid: 'bool', sku: 'dict', title: 'text', at: 'num', qty: 'num' }
const fits = (t, v) => t === 'num' ? typeof v === 'number' : t === 'bool' ? typeof v === 'boolean' : typeof v === 'string'
export class ColumnStore {
  constructor({ mutate = '', shared = false, shape = SHAPE, onChange = null, cap = 0 } = {}) {
    this.mutate = mutate; this.shared = shared; this.shape = shape; this.onChange = onChange
    this.names = Object.keys(shape); this.bit = {}; this.names.forEach((f, i) => { this.bit[f] = 1 << i })
    this.ix = new KeyIndex({ mutate, cap })
    this.cols = {}; this.n = Math.max(1024, cap)
    for (const f of this.names) { const t = shape[f]; this.cols[f] = t === 'num' ? this._arr(Float64Array) : t === 'bool' ? this._arr(Uint8Array) : t === 'dict' ? this._arr(Int32Array) : null }
    this.toff = this._arr(Float64Array); this.tlen = this._arr(Uint32Array)
    this.pres = this._arr(Uint16Array) // presence bits; 0 = a free id or an overflow row
    this.tbytes = new Uint8Array(Math.max(1 << 20, cap * 28)); this.tfill = 0; this.tdead = 0
    this.dict = new Map(); this.dstr = [] // one dictionary for every 'dict' column
    this.over = new Map() // overflow rows: key -> plain row
  }
  _arr(C) { return this.shared ? new C(new SharedArrayBuffer(this.n * C.BYTES_PER_ELEMENT)) : new C(this.n) }
  _ensure(id) {
    if (id < this.n) return
    let n = this.n; while (n <= id) n *= 2
    const g = (a) => grow(a, n, this.shared)
    for (const f of this.names) if (this.cols[f]) this.cols[f] = g(this.cols[f])
    this.toff = g(this.toff); this.tlen = g(this.tlen); this.pres = g(this.pres); this.n = n
  }
  _dictId(s) { let d = this.dict.get(s); if (d === undefined) { d = this.dstr.length; this.dstr.push(s); this.dict.set(s, d) } return d }
  _text(id, s) {
    const max = s.length * 3
    if (this.tfill + max > this.tbytes.length) this._tcompact(max)
    if (this.tlen[id]) this.tdead += this.tlen[id]
    const n = enc.encodeInto(s, this.tbytes.subarray(this.tfill)).written
    this.toff[id] = this.tfill; this.tlen[id] = n; this.tfill += n
  }
  _tcompact(need) {
    let liveB = 0
    this.ix.each((id) => { if (this.pres[id] & this.bit.title) liveB += this.tlen[id] })
    let cap = this.tbytes.length
    while (liveB + need > cap / 2) cap *= 2
    const nb = new Uint8Array(cap); let f = 0
    this.ix.each((id) => { if (this.pres[id] & this.bit.title) { const o = this.toff[id], n = this.tlen[id]; nb.set(this.tbytes.subarray(o, o + n), f); this.toff[id] = f; f += n } else this.tlen[id] = 0 })
    this.tbytes = nb; this.tfill = f; this.tdead = 0
  }
  _rowFits(row) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
    for (const f in row) { const t = this.shape[f]; if (!t || !fits(t, row[f])) return this.mutate === 'nooverflow' && t ? true : false }
    return true
  }
  _setField(id, f, v) {
    const t = this.shape[f], c = this.cols[f]
    if (t === 'num') c[id] = typeof v === 'number' ? v : NaN
    else if (t === 'bool') c[id] = v ? 1 : 0
    else if (t === 'dict') c[id] = this._dictId(String(v))
    else this._text(id, String(v))
    this.pres[id] |= this.bit[f]
  }
  _readField(id, f) {
    const t = this.shape[f], c = this.cols[f]
    if (t === 'num') return c[id]
    if (t === 'bool') return c[id] === 1
    if (t === 'dict') return this.dstr[c[id]]
    return utf8(this.tbytes, this.toff[id], this.tlen[id])
  }
  _rowOf(id) { const row = {}; const p = this.pres[id]; for (const f of this.names) if (p & this.bit[f]) row[f] = this._readField(id, f); return row }
  get(k) { const o = this.over.get(k); if (o !== undefined) return o; const id = this.ix.find(k); return id < 0 ? undefined : this._rowOf(id) }
  _put(k, row) { // a whole row
    const prev = this.onChange ? this.get(k) : undefined
    let id = this.ix.find(k)
    if (!this._rowFits(row)) {
      if (id >= 0) this._drop(id, k)
      this.over.set(k, row)
    } else {
      this.over.delete(k)
      if (id < 0) { id = this.ix.add(k); this._ensure(id) }
      if (this.tlen[id] && (this.pres[id] & this.bit.title)) { this.tdead += this.tlen[id]; this.tlen[id] = 0 }
      this.pres[id] = 0
      for (const f in row) this._setField(id, f, row[f])
      this.pres[id] |= 0x8000 // "a row lives here", so an empty row {} is still a row
    }
    if (this.onChange) this.onChange(k, prev, row)
  }
  _drop(id, k) { if (this.pres[id] & this.bit.title) this.tdead += this.tlen[id]; this.tlen[id] = 0; this.pres[id] = 0; this.ix.del(k) }
  apply(recs) {
    for (const r of recs) {
      if (r.type === 1) { this._put(r.at, r.value); continue }
      const k = r.key[0]
      if (r.key.length === 1) {
        if (r.type === 0) this._put(k, r.value)
        else {
          const prev = this.onChange ? this.get(k) : undefined
          if (this.over.has(k)) this.over.delete(k)
          else { const id = this.ix.find(k); if (id >= 0) this._drop(id, k) }
          if (this.onChange && prev !== undefined) this.onChange(k, prev, undefined)
        }
        continue
      }
      const f = r.key[1]
      const o = this.over.get(k)
      if (o !== undefined) { const row = { ...o }; if (r.type === 0) row[f] = r.value; else delete row[f]; this._put(k, row); continue }
      const id = this.ix.find(k)
      if (id < 0) continue // a field write on a missing row: dropped
      const t = this.shape[f]
      if (r.type === 0 && (!t || !fits(t, r.value)) && this.mutate !== 'nooverflow') { const row = this._rowOf(id); row[f] = r.value; this._put(k, row); continue }
      const prev = this.onChange ? this._rowOf(id) : undefined
      if (r.type === 0) this._setField(id, f, r.value)
      else if (t) { if (this.mutate !== 'presence') this.pres[id] &= ~this.bit[f]; if (t === 'text') { this.tdead += this.tlen[id]; this.tlen[id] = 0 } }
      if (this.onChange) this.onChange(k, prev, this._rowOf(id))
    }
  }
  count() { return this.ix.live + this.over.size }
  // scans walk row ids in order (sequential memory), not the hash table (random memory): a live row's
  // presence word has bit 15 set, a free id's is 0
  each(fn) { const p = this.pres, n = this.ix.next; for (let id = 0; id < n; id++) if (p[id]) fn(this.ix.keyOf(id), this._rowOf(id)); for (const [k, row] of this.over) fn(k, row) }
  // a column scan: fn(value) for every row that has the field, the overflow rows too
  field(f, fn) {
    const t = this.shape[f], c = this.cols[f], b = this.bit[f], p = this.pres, n = this.ix.next
    if (t === 'num') { for (let id = 0; id < n; id++) if (p[id] & b) fn(c[id]) }
    else for (let id = 0; id < n; id++) if (p[id] & b) fn(this._readField(id, f))
    for (const row of this.over.values()) if (f in row) fn(row[f])
  }
  // the fastest scan: a sum over a numeric column (no callback)
  sumNum(f) {
    const c = this.cols[f], b = this.bit[f], p = this.pres, n = this.ix.next
    let s = 0
    for (let id = 0; id < n; id++) if (p[id] & b) s += c[id]
    for (const row of this.over.values()) if (typeof row[f] === 'number') s += row[f]
    return s
  }
  offHeapBytes() { let s = this.ix.bytes() + this.toff.byteLength + this.tlen.byteLength + this.pres.byteLength + this.tbytes.byteLength; for (const f of this.names) if (this.cols[f]) s += this.cols[f].byteLength; return s }
}

// ── a chunked sorted list of numbers: insert, remove, k-th; O(log n + B) a change ──────────────────────
export class SortedCol {
  constructor(B = 512) { this.B = B; this.chunks = [new Float64Array(2 * B)]; this.lens = [0]; this.maxs = [Infinity]; this.n = 0 }
  _find(x) { // the first chunk whose max is >= x
    const m = this.maxs; let lo = 0, hi = m.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid] < x) lo = mid + 1; else hi = mid }
    return lo
  }
  insert(x) {
    if (x !== x) return
    const c = this._find(x), a = this.chunks[c], n = this.lens[c]
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid }
    a.copyWithin(lo + 1, lo, n); a[lo] = x; this.lens[c] = n + 1; this.n++
    if (c < this.maxs.length - 1 && x > this.maxs[c]) this.maxs[c] = x
    if (n + 1 === 2 * this.B) { // split in two
      const b = new Float64Array(2 * this.B); b.set(a.subarray(this.B, 2 * this.B))
      this.chunks.splice(c + 1, 0, b); this.lens.splice(c + 1, 0, this.B); this.lens[c] = this.B
      this.maxs.splice(c, 0, a[this.B - 1])
    }
  }
  remove(x) {
    if (x !== x) return false
    let c = this._find(x), a, n, lo
    for (;;) { // a value equal to a chunk's bound may sit in the next chunk
      a = this.chunks[c]; n = this.lens[c]; lo = 0; let hi = n
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid }
      if (lo < n && a[lo] === x) break
      if (c + 1 < this.chunks.length && (lo === n || a[lo] > x) && this.maxs[c] <= x) { c++; continue }
      return false
    }
    a.copyWithin(lo, lo + 1, n); this.lens[c] = n - 1; this.n--
    if (n - 1 === 0 && this.chunks.length > 1) { this.chunks.splice(c, 1); this.lens.splice(c, 1); this.maxs.splice(c === this.maxs.length - 1 ? c - 1 : c, 1) }
    return true
  }
  kth(i) { let c = 0; while (i >= this.lens[c]) { i -= this.lens[c]; c++ } return this.chunks[c][i] }
  median() { // type-7, as data's median: interpolate between the two middle values
    if (this.n === 0) return undefined
    const h = (this.n - 1) * 0.5, lo = Math.floor(h), a = this.kth(lo)
    return h === lo ? a : a + (h - lo) * (this.kth(lo + 1) - a)
  }
}
