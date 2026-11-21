// E-62: a log in E-19's slot layout, in memory, for items 2 and 6 (counting back on a real log).
// E-19's record batch (node/header.mjs, form `slot`): a batch header (term varint, base offset varint, writer time as
// 8 bytes, count varint), then per record: issuer varint, call id varint, slot varint, the slot's sequence varint,
// payload length varint, payload. PATHS PA-12 puts the slot and a length in each header so a reader can skip a payload
// unread; this layout has both. With `prev: true` each record also carries, after its sequence, the gap back to its
// partition's previous record in the same slot (CONNECT 3.4's "cheap bound": 0 for a partition's first record).
// The payload: the key count (varint), each key as a length and its bytes, then the value as JSON text.
// With `prev: true` the log also counts, without writing it, what a BYTE gap would take instead: the distance in bytes
// back to the partition's previous record, as a varint (counted on this layout's offsets; written, it would lengthen
// each record by those bytes, and so the gaps by a few per cent).
// Batches hold 256 records. A slot index keeps, per slot, every record's byte offset and record number in log order
// (an index by slot, built from headers; PA-12 routes and indexes by slot). A record's sequence in its slot is its
// place in that slot's list plus one, so a version finds its record in O(1).
export const SLOTS = 4096, BATCH = 256
const vlenB = (v) => { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++ } return n }

export class Log {
  constructor({ cap = 256 << 20, prev = false } = {}) {
    this.buf = Buffer.allocUnsafe(cap); this.p = 0; this.prev = prev
    this.n = 0 // records
    this.batchOff = [] // byte offset of each batch header
    this.seq = new Float64Array(SLOTS)
    this.sOff = Array.from({ length: SLOTS }, () => []) // per slot: record byte offsets
    this.sRec = Array.from({ length: SLOTS }, () => []) // per slot: record numbers (batch = rec >> 8)
    this.last = new Map() // partition key → its last sequence in its slot (for prev gaps; a leader keeps one)
    this.cntPos = 0; this.inBatch = 0
    this.prevBytes = 0
    this.lastOff = prev ? new Map() : null // partition key → its last record's byte offset (for the byte gap's count)
    this.bgapBytes = 0
  }
  v(x) { const b = this.buf; let p = this.p; while (x >= 128) { b[p++] = (x & 127) | 128; x = Math.floor(x / 128) } b[p++] = x; this.p = p }
  // keys: [partitionKey, ...path] as strings; value: JSON text (or undefined for a remove); slot: the partition's slot
  append(slot, keys, valueText, issuer = 7, call = 1000) {
    if (this.inBatch === 0) {
      this.batchOff.push(this.p)
      this.v(3); this.v(this.n); this.buf.writeDoubleLE(1.7e12 + this.n, this.p); this.p += 8
      this.cntPos = this.p; this.buf[this.p++] = 0x80 | (BATCH & 127); this.buf[this.p++] = BATCH >> 7 // count: 2 bytes, fixed
    }
    const s = ++this.seq[slot]
    if (this.prev) { const lo = this.lastOff.get(keys[0]); this.bgapBytes += lo === undefined ? 1 : vlenB(this.p - lo); this.lastOff.set(keys[0], this.p) }
    this.sOff[slot].push(this.p); this.sRec[slot].push(this.n)
    this.v(issuer); this.v(call); this.v(slot); this.v(s)
    if (this.prev) {
      const pk = keys[0], l = this.last.get(pk)
      const gap = l === undefined ? 0 : s - l
      const p0 = this.p; this.v(gap); this.prevBytes += this.p - p0
      this.last.set(pk, s)
    } else this.last.set(keys[0], s)
    // payload, written after a 3-byte length hole
    const lenPos = this.p; this.p += 3
    const p0 = this.p
    this.v(keys.length)
    for (const k of keys) { const w = this.buf.write(k, this.p + 1, 'latin1'); this.buf[this.p] = w; this.p += 1 + w }
    if (valueText !== undefined) this.p += this.buf.write(valueText, this.p, 'latin1')
    const len = this.p - p0
    this.buf[lenPos] = (len & 127) | 128; this.buf[lenPos + 1] = ((len >> 7) & 127) | 128; this.buf[lenPos + 2] = len >> 14
    this.n++
    if (++this.inBatch === BATCH) this.inBatch = 0
    return s
  }
  // close a part-filled last batch (its count says how many records it holds)
  seal() {
    if (this.inBatch === 0) return
    const c = this.inBatch; this.buf[this.cntPos] = 0x80 | (c & 127); this.buf[this.cntPos + 1] = c >> 7
    this.inBatch = 0
  }
  bytesPerRecord() { return this.p / this.n }
}

// ── readers over the buffer ──
let q = 0
export function rv(b) { let v = 0, m = 1, x; do { x = b[q++]; v += (x & 127) * m; m *= 128 } while (x & 128); return v }
export function at(x) { q = x }
export function pos() { return q }
// read one record header at offset `off`: returns the payload start; sets H fields
export const H = { slot: 0, seq: 0, gap: 0, len: 0, payload: 0, end: 0 }
export function header(b, off, prev) {
  q = off; rv(b); rv(b); H.slot = rv(b); H.seq = rv(b); H.gap = prev ? rv(b) : 0; H.len = rv(b); H.payload = q; H.end = q + H.len
  return H
}
// compare the payload's key i (0: the partition key) with `kb` (a Buffer) without decoding it; returns 1 equal,
// 0 different, -1 no such key. Leaves q after that key.
export function keyIs(b, payload, i, kb) {
  q = payload; const nk = rv(b); if (i >= nk) return -1
  for (let j = 0; j < i; j++) { const l = b[q]; q += 1 + l }
  const l = b[q]; q++
  if (l !== kb.length) { q += l; return 0 }
  for (let j = 0; j < l; j++) if (b[q + j] !== kb[j]) { q += l; return 0 }
  q += l; return 1
}
// the payload's key i decoded to a string (what a reader that decodes keys pays)
export function keyStr(b, payload, i) {
  q = payload; const nk = rv(b); if (i >= nk) return undefined
  for (let j = 0; j < i; j++) { const l = b[q]; q += 1 + l }
  const l = b[q]; q++
  const s = b.latin1Slice(q, q + l); q += l
  return s
}
export function keyCount(b, payload) { q = payload; return rv(b) }
// the value's JSON text after the keys, parsed
export function value(b, payload, end) {
  q = payload; const nk = rv(b); for (let j = 0; j < nk; j++) { const l = b[q]; q += 1 + l }
  return JSON.parse(b.latin1Slice(q, end))
}
