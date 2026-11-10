// E-29: a small journal in the shape L0 would have, to test power loss and a full disk against.
// It is a test object, not fero's journal: one writer, batches with a checksum and a chained sequence
// number, segment files, group commit by the caller (write, then sync), recovery that cuts a torn tail.
//
// Batch on disk: u32 magic, u32 len (bytes after this header), u32 crc32 (of seq..end), u32 seq lo, u32 seq hi,
// u32 count, u32 kind; then count records of u32 len + bytes. Batches carry seq 1, 2, 3, ... with no gap.
// A segment file is named by the seq of its first batch. Recovery reads segments in order and stops at the
// first batch that is short, has a bad checksum, or does not carry the next seq: everything after is cut.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

export const KIND = { data: 0, remove: 1, term: 2, conf: 3, retain: 4 }
export const KIND_NAME = ['data', 'remove', 'term', 'conf', 'retain']
const MAGIC = 0x4c4e524a, BH = 28
export class DiskFull extends Error { constructor(m) { super(m); this.code = 'disk-full' } }
const segName = (seq) => String(seq).padStart(12, '0') + '.seg'
const fsyncDir = (dir) => { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d) } finally { fs.closeSync(d) } }
export const freeBytes = (dir) => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize) }

export const encodeBatch = (seq, kind, records) => {
  let n = BH; for (const r of records) n += 4 + r.length
  const b = Buffer.allocUnsafe(n)
  b.writeUInt32LE(MAGIC, 0); b.writeUInt32LE(n - BH, 4)
  b.writeUInt32LE(seq >>> 0, 12); b.writeUInt32LE(Math.floor(seq / 4294967296), 16); b.writeUInt32LE(records.length, 20); b.writeUInt32LE(kind, 24)
  let off = BH; for (const r of records) { b.writeUInt32LE(r.length, off); r.copy(b, off + 4); off += 4 + r.length }
  b.writeUInt32LE(zlib.crc32(b.subarray(12)) >>> 0, 8)
  return b
}
// read one batch at `off` of `buf`; null when it is not a whole good batch
const decodeBatch = (buf, off) => {
  if (buf.length - off < BH || buf.readUInt32LE(off) !== MAGIC) return null
  const len = buf.readUInt32LE(off + 4)
  if (len > 64 << 20 || buf.length - off - BH < len) return null
  if ((zlib.crc32(buf.subarray(off + 12, off + BH + len)) >>> 0) !== buf.readUInt32LE(off + 8)) return null
  const seq = buf.readUInt32LE(off + 12) + buf.readUInt32LE(off + 16) * 4294967296, count = buf.readUInt32LE(off + 20), kind = buf.readUInt32LE(off + 24)
  const records = []; let r = off + BH
  for (let i = 0; i < count; i++) { const l = buf.readUInt32LE(r); records.push(buf.subarray(r + 4, r + 4 + l)); r += 4 + l }
  return { seq, kind, records, bytes: BH + len }
}

export class Journal {
  // opts: layout 'grow' (files grow as batches are appended) or 'prealloc' (a segment's blocks are allocated when it
  //   is made); segBytes; reserveBytes (space only the privileged kinds may use); zeroFill (allocate by writing
  //   zeros, where fallocate is not supported); recycle (reuse retired segment files without clearing them);
  //   statDir (where to ask for free space; default the journal's dir);
  //   mutants, for showing that the tests catch a broken journal: noSync (sync() does nothing); noSeqCheck
  //   (recovery takes any batch with a good checksum, whatever its seq); resync (after a bad batch, recovery looks
  //   for the next batch header and carries on, "to save what it can"); eagerCut (recovery takes leftover bytes in
  //   any segment for a torn tail: the bug this journal first had).
  constructor(dir, opts = {}) {
    this.dir = dir; this.o = { layout: 'grow', segBytes: 4 << 20, reserveBytes: 0, ...opts }
    this.seq = 0; this.durable = 0; this.fd = -1; this.pos = 0; this.segs = []; this.spares = []; this.failed = null
    this.statDir = this.o.statDir ?? dir
  }
  // ── recovery: returns the batches found, leaves the journal ready to append after the last good one ──
  recover() {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.seg')).sort()
    const batches = []; let expect = null, cut = null
    this.segs = []; this.spares = fs.readdirSync(this.dir).filter((f) => f.startsWith('spare.')).map((f) => this.dir + '/' + f)
    for (let i = 0; i < files.length; i++) {
      const first = Number(files[i].slice(0, 12)), path = this.dir + '/' + files[i]
      if (cut !== null || (expect !== null && first !== expect && !this.o.noSeqCheck && !this.o.resync)) { if (cut === null) cut = { file: files[i], offset: 0, why: 'segment does not follow' }; fs.unlinkSync(path); continue }
      const buf = fs.readFileSync(path); let off = 0
      if (expect === null) expect = first
      const nextFirst = i + 1 < files.length ? Number(files[i + 1].slice(0, 12)) : -1
      for (;;) {
        let b = decodeBatch(buf, off)
        if (b === null && this.o.resync) { for (let o = off + 1; o + BH <= buf.length; o++) if (buf.readUInt32LE(o) === MAGIC && (b = decodeBatch(buf, o)) !== null) { off = o; break } }
        if (b === null || (b.seq !== expect && !this.o.noSeqCheck && !this.o.resync)) {
          // The run stops here. If the next segment starts with the seq we want, this segment simply ended (what
          // follows is the unused part of a reused file): carry on there. Only when nothing carries on is this the
          // torn tail. (The first version of this journal took any leftover bytes for a torn tail and deleted the
          // later segments, with acknowledged batches in them. The power-loss tier found it: 2 rounds in 1,200.)
          if (nextFirst === expect && !this.o.eagerCut) break
          if (off < buf.length && (b !== null || buf.subarray(off).some((x) => x !== 0))) cut = { file: files[i], offset: off, why: b === null ? 'bad batch' : 'wrong seq ' + b.seq + ', wanted ' + expect }
          break
        }
        batches.push(b); off += b.bytes; expect = b.seq + 1
      }
      this.segs.push({ first, path, end: off })
      if (cut !== null || i === files.length - 1) {
        // the tail: in a growing file, cut the bytes after the last good batch; in a preallocated one, zero the
        // header that follows, so a later scan cannot take old bytes for a batch
        {
          if (this.o.layout === 'grow') { if (buf.length > off) { fs.truncateSync(path, off); const fd = fs.openSync(path, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd) } }
          else if (off + BH <= buf.length && buf.subarray(off, off + BH).some((x) => x !== 0)) { const fd = fs.openSync(path, 'r+'); fs.writeSync(fd, Buffer.alloc(BH), 0, BH, off); fs.fsyncSync(fd); fs.closeSync(fd) }
        }
      }
    }
    this.seq = expect === null ? 0 : expect - 1; this.durable = this.seq
    if (this.segs.length) { const s = this.segs[this.segs.length - 1]; this.fd = fs.openSync(s.path, 'r+'); this.pos = s.end; this.cur = s }
    return { batches, cut, lastSeq: this.seq }
  }
  #alloc(path) {
    if (this.o.recycle && this.spares.length) { fs.renameSync(this.spares.pop(), path); return }
    if (this.o.layout !== 'prealloc') { fs.closeSync(fs.openSync(path, 'w')); return }
    try {
      if (this.o.zeroFill) { const fd = fs.openSync(path, 'w'); const z = Buffer.alloc(1 << 20); for (let o = 0; o < this.o.segBytes; o += z.length) fs.writeSync(fd, z, 0, Math.min(z.length, this.o.segBytes - o), o); fs.fsyncSync(fd); fs.closeSync(fd) }
      else execFileSync('fallocate', ['-l', String(this.o.segBytes), path], { stdio: 'pipe' })
    } catch (e) { try { fs.unlinkSync(path) } catch {} throw new DiskFull('no room for a new segment: ' + String(e.stderr ?? e.message).trim()) }
  }
  #roll(privileged) {
    const first = this.seq + 1, path = this.dir + '/' + segName(first)
    let fromReserve = false
    if (this.o.layout === 'prealloc' && this.o.reserveBytes > 0 && freeBytes(this.statDir) - this.o.segBytes < this.o.reserveBytes) {
      // data may not take a segment that leaves less than the reserve free; a privileged record may, and the
      // segment it opens is marked, so data cannot ride in behind it
      if (!privileged) throw new DiskFull('a new segment would eat the reserve')
      fromReserve = true
    }
    this.#alloc(path)
    if (this.fd >= 0) { fs.fdatasyncSync(this.fd); fs.closeSync(this.fd) }
    this.fd = fs.openSync(path, 'r+'); this.pos = 0; this.cur = { first, path, end: 0, fromReserve }; this.segs.push(this.cur)
    fsyncDir(this.dir)
  }
  // ── write one batch (not yet durable). Throws DiskFull and leaves the file as it was. ──
  write(records, kind = KIND.data) {
    if (this.failed) throw this.failed
    const privileged = kind !== KIND.data
    const b = encodeBatch(this.seq + 1, kind, records)
    if (this.fd < 0 || this.pos + b.length > this.o.segBytes || (!privileged && this.cur.fromReserve)) this.#roll(privileged)
    if (this.o.layout === 'grow' && !privileged && this.o.reserveBytes > 0 && freeBytes(this.statDir) - b.length < this.o.reserveBytes) throw new DiskFull('the write would eat the reserve')
    // write it all; a short count is not an error yet, the next call says why (ENOSPC, or the disk is gone)
    let w = 0, full = false
    while (w < b.length) {
      let n
      try { n = fs.writeSync(this.fd, b, w, b.length - w, this.pos + w) } catch (e) {
        if (e.code === 'ENOSPC') { full = true; break }
        this.failed = e; throw e // any other write error is final: the journal refuses from then on
      }
      if (n === 0) { full = true; break }
      w += n
    }
    if (full) {
      // take back whatever landed, so the file ends at the last whole batch
      if (this.o.layout === 'grow') { try { fs.ftruncateSync(this.fd, this.pos) } catch {} }
      throw new DiskFull('ENOSPC after ' + w + ' of ' + b.length + ' bytes')
    }
    this.pos += b.length; this.cur.end = this.pos; this.seq++
    return this.seq
  }
  // ── make everything written durable. A failed sync is final: the journal refuses from then on. ──
  sync() {
    if (this.failed) throw this.failed
    if (this.o.noSync) { this.durable = this.seq; return this.durable }
    try { fs.fdatasyncSync(this.fd) } catch (e) { this.failed = new Error('fsync failed, journal stopped: ' + e.code); this.failed.code = 'fsync-failed'; throw this.failed }
    this.durable = this.seq
    return this.durable
  }
  // ── drop whole segments whose batches are all below `below` (never the segment in use) ──
  retain(below) {
    let freed = 0
    while (this.segs.length > 1 && this.segs[1].first <= below) {
      const s = this.segs.shift(); freed += fs.statSync(s.path).size
      if (this.o.recycle) { const p = this.dir + '/spare.' + s.first; fs.renameSync(s.path, p); this.spares.push(p) } else fs.unlinkSync(s.path)
    }
    if (freed) fsyncDir(this.dir)
    return freed
  }
  close() { if (this.fd >= 0) { try { fs.closeSync(this.fd) } catch {} this.fd = -1 } }
}
