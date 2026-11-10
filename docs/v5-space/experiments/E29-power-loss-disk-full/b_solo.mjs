// E-29(b): a solo journal writer on a small filesystem, filled to the brim.
//   node b_solo.mjs <dir on the small filesystem> <label> <part>
// Parts:
//   naive     no reserve, files that grow: fill to ENOSPC; which call fails; what still works with zero bytes free
//   cost      how much free space each kind of operation needs (one operation per sync, until the disk refuses)
//   policy    the proposed rule: preallocated segments, a fixed reserve for the small privileged records, and
//             headroom for one snapshot. Fill; refuse cleanly; remove, vote and change members while full;
//             snapshot; drop old segments; writes resume by themselves
//   nohead    the same without the snapshot headroom: shows the deadlock the headroom prevents
import fs from 'node:fs'
import { Journal, KIND, DiskFull, freeBytes } from './journal.mjs'

const [DIR, LABEL, PART] = process.argv.slice(2)
const out = (o) => console.log(JSON.stringify({ fs: LABEL, part: PART, ...o }))
const MB = (n) => +(n / 1048576).toFixed(2)
const clean = () => { for (const f of fs.readdirSync(DIR)) if (f !== 'lost+found') fs.rmSync(DIR + '/' + f, { recursive: true, force: true }) }
const total = () => { const s = fs.statfsSync(DIR); return Number(s.blocks) * Number(s.bsize) }
const blocksFree = () => Number(fs.statfsSync(DIR).bfree)
const J = DIR + '/j'
const rowBytes = 1000
const val = (i) => Buffer.alloc(rowBytes, 65 + (i % 26))
const keyOf = (i) => Buffer.from('k' + String(i).padStart(7, '0'))
const fsyncDir = (d) => { const f = fs.openSync(d, 'r'); fs.fsyncSync(f); fs.closeSync(f) }
// what one privileged operation writes: a small record of its own kind
const OPS = {
  remove: { kind: KIND.remove, rec: () => [Buffer.from('k0000001'.padEnd(24, 'x'))] },                     // a row key
  term: { kind: KIND.term, rec: () => [Buffer.alloc(24, 1)] },                                             // term, vote, commit: three u64
  conf: { kind: KIND.conf, rec: () => [Buffer.alloc(64, 2)] },                                             // a member list
  retain: { kind: KIND.retain, rec: () => [Buffer.alloc(16, 3)] },                                         // "the log now starts at seq s"
}
const tryOp = (j, name) => { try { j.write(OPS[name].rec(), OPS[name].kind); j.sync(); return 'ok' } catch (e) { return e.code ?? e.message } }

// the state a solo node holds: rows in memory, the journal on disk, and a snapshot file
class Node {
  constructor(opts) { this.j = new Journal(J, opts); this.rows = new Map(); this.stateBytes = 0; this.snapSeq = 0; this.opts = opts; this.warned = false; this.lines = [] }
  open() { fs.mkdirSync(J, { recursive: true }); const r = this.j.recover(); for (const b of r.batches) this.fold(b); return r }
  fold(b) { for (const rec of b.records) { const k = rec.subarray(0, 8).toString(); if (b.kind === KIND.data) { if (!this.rows.has(k)) this.stateBytes += 12 + rec.length; this.rows.set(k, rec) } else if (b.kind === KIND.remove) { if (this.rows.delete(k)) this.stateBytes -= 12 + rowBytes + 8 } } }
  // a data write: refused when it would leave less free space than the reserve plus room for one snapshot
  put(i, sync = true) {                                                    // fills pass sync=false and sync every 32 writes (group commit)
    const rec = Buffer.concat([keyOf(i), val(i)])
    const free = freeBytes(DIR)
    // the warning is against the space data may use: the disk less the reserve and the snapshot headroom
    const keep = this.opts.reserveBytes + (this.opts.headroom ? this.headroom() : 0), usable = total() - keep
    if (!this.warned && free - keep < 0.2 * usable) { this.warned = true; this.lines.push('disk 80% full: ' + MB(free - keep) + ' MB left for writes of ' + MB(usable) + ' MB; a retention pass or a bigger volume fixes it') }
    if (this.opts.headroom && free - rec.length - 64 < this.opts.reserveBytes + this.headroom()) throw new DiskFull('hard limit: free space is kept for one snapshot and the reserve')
    const seq = this.j.write([rec], KIND.data); if (sync || seq % 32 === 0) this.j.sync()
    this.fold({ kind: KIND.data, records: [rec] })
    return seq
  }
  headroom() { return Math.ceil((this.stateBytes + rowBytes + 20) * 1.05) + 65536 }
  remove(i) { const rec = keyOf(i); this.j.write([rec], KIND.remove); this.j.sync(); this.fold({ kind: KIND.remove, records: [rec] }) }
  // snapshot: the rows to a temporary file, synced, renamed over the old one; then whole segments below it can go
  snapshot() {
    const tmp = DIR + '/snap.tmp', fd = fs.openSync(tmp, 'w'); let n = 0
    try {
      const chunks = []; let size = 0
      const head = Buffer.alloc(8); head.writeUInt32LE(this.j.seq >>> 0, 0); head.writeUInt32LE(this.rows.size, 4); chunks.push(head)
      for (const [, v] of this.rows) { const l = Buffer.alloc(4); l.writeUInt32LE(v.length, 0); chunks.push(l, v); size += 4 + v.length; if (size > 1 << 20) { const b = Buffer.concat(chunks); n += fs.writeSync(fd, b); chunks.length = 0; size = 0 } }
      const b = Buffer.concat(chunks); let w = 0; while (w < b.length) { const x = fs.writeSync(fd, b, w, b.length - w); if (x === 0) throw Object.assign(new Error('short'), { code: 'ENOSPC' }); w += x } n += w
      fs.fsyncSync(fd)
    } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(tmp) } catch {} if (e.code === 'ENOSPC') throw new DiskFull('no room for the snapshot (' + MB(this.stateBytes) + ' MB of rows)'); throw e }
    fs.closeSync(fd); fs.renameSync(tmp, DIR + '/snap'); fsyncDir(DIR)
    this.snapSeq = this.j.seq
    return n
  }
  retention() { return this.j.retain(this.snapSeq) }
}

clean()
if (PART === 'naive') {
  const n = new Node({ layout: 'grow', segBytes: 4 << 20 }); n.open()
  let i = 0, failedAt = null, where = null
  const t0 = Date.now()
  try { for (;; i++) n.put(i % 8000, false) } catch (e) { failedAt = e.message; where = e.code }
  try { n.j.sync() } catch (e) { failedAt += '; then sync: ' + e.message }
  const free = freeBytes(DIR)
  const r1 = { wrote: i, MBwritten: MB(i * (rowBytes + 8 + 32)), ms: Date.now() - t0, refusal: where, message: failedAt, freeBytesAfter: free }
  // with nothing free: which operations still work?
  const works = {}
  for (const name of Object.keys(OPS)) works[name] = tryOp(n.j, name)
  try { n.snapshot(); works.snapshot = 'ok' } catch (e) { works.snapshot = e.code }
  works['read a row'] = n.rows.get('k0000001') ? 'ok' : 'missing'
  // the journal after the refusals: is it whole? (a restart must find every acknowledged batch and no torn tail)
  n.j.close(); const n2 = new Node({ layout: 'grow', segBytes: 4 << 20 }); const rec = n2.open()
  works['restart after the refusals'] = rec.cut === null && rec.lastSeq === n.j.durable ? 'ok, no torn tail, last seq ' + rec.lastSeq : 'cut ' + JSON.stringify(rec.cut) + ' last ' + rec.lastSeq + ' durable ' + n.j.durable
  // dropping a segment needs no new bytes? (there is no snapshot, so this only shows the unlink itself)
  const before = freeBytes(DIR); let unlinked = 'ok'
  try { const s = n2.j.segs[0]; fs.unlinkSync(s.path); n2.j.segs.shift(); fsyncDir(J) } catch (e) { unlinked = e.code }
  works['unlink one old segment'] = unlinked + ', freed ' + MB(freeBytes(DIR) - before) + ' MB'
  works['a vote after freeing'] = tryOp(n2.j, 'term')
  out({ ...r1, withZeroFree: works })
} else if (PART === 'cost') {
  // leave exactly K free blocks (a ballast file takes the rest), then do one kind of operation, one per sync, until
  // the disk refuses. Count them, and the batch bytes each takes.
  for (const layout of ['grow', 'prealloc']) for (const name of Object.keys(OPS)) {
    clean(); fs.mkdirSync(J)
    const j = new Journal(J, { layout, segBytes: 1 << 20 }); j.recover()
    j.write([Buffer.alloc(100)], KIND.data); j.sync()                    // the segment exists (preallocated: 1 MiB of it)
    const K = Number(process.env.FREE_BLOCKS ?? 64)
    const fd = fs.openSync(DIR + '/ballast', 'w'); const z = Buffer.alloc(1 << 20)
    try { for (;;) fs.writeSync(fd, z) } catch (e) { if (e.code !== 'ENOSPC') throw e }
    try { for (;;) { if (fs.writeSync(fd, z, 0, 4096) === 0) break } } catch (e) { if (e.code !== 'ENOSPC') throw e }
    fs.fsyncSync(fd)
    const size = fs.fstatSync(fd).size; fs.ftruncateSync(fd, size - K * 4096); fs.fsyncSync(fd); fs.closeSync(fd)   // free exactly K blocks
    const free0 = blocksFree(), pos0 = j.pos
    let ops = 0, err = null
    const batch = 28 + 4 + OPS[name].rec()[0].length
    const cap = Number(process.env.OPS_CAP ?? 1e9)                          // a slow disk: stop early, the count per block is what matters
    const limit = Math.min(cap, layout === 'prealloc' ? Math.floor(((1 << 20) - pos0) / batch) : 1e9)   // stay inside the segment that is already allocated
    try { while (ops < limit) { j.write(OPS[name].rec(), OPS[name].kind); j.sync(); ops++ } } catch (e) { err = e.code }
    out({ layout, op: name, batchBytes: batch, freeBlocksBefore: free0, freeBlocksAfter: blocksFree(), opsDone: ops, stoppedBy: err ?? (ops === cap ? 'the cap of ' + cap + ' operations' : 'end of the allocated segment'), bytesPerOp: ops ? +(((free0 - blocksFree()) * 4096) / ops).toFixed(1) : null, opsPer4KBlock: +(4096 / batch).toFixed(1) })
    j.close()
  }
  // a snapshot's cost: the rows' bytes, once more, beside the old snapshot until the rename
  clean(); const n = new Node({ layout: 'grow', segBytes: 4 << 20 }); n.open()
  for (let i = 0; i < 4000; i++) n.put(i, false)
  n.j.sync()
  const f0 = freeBytes(DIR); const bytes = n.snapshot(); const f1 = freeBytes(DIR); n.snapshot(); const f2 = freeBytes(DIR)
  out({ op: 'snapshot', rows: n.rows.size, snapshotBytes: bytes, freeUsedByFirst: f0 - f1, freeUsedBySecondAfterRename: f1 - f2, note: 'while the second is written, both exist: the peak is one more snapshot' })
} else if (PART === 'policy' || PART === 'nohead') {
  const opts = { layout: 'prealloc', segBytes: 2 << 20, reserveBytes: 2 << 20, headroom: PART === 'policy' }
  const n = new Node(opts); n.open()
  const KEYS = 12000                                                         // 12 MB of rows when all exist
  const t = []
  const phase = (name, o) => { t.push({ phase: name, freeMB: MB(freeBytes(DIR)), rows: n.rows.size, stateMB: MB(n.stateBytes), segments: n.j.segs.length, ...o }) }
  let i = 0, refused = null
  try { for (;; i++) n.put(i % KEYS, false) } catch (e) { refused = e }
  n.j.sync()
  phase('filled until refused', { writes: i, refusal: refused.code, why: refused.message, warned: n.lines[0] ?? null })
  // while full: everything but new data
  const during = {}
  during['read a row'] = n.rows.get('k0000005') ? 'ok' : 'missing'
  try { n.put(1); during['another data write'] = 'ok (wrong)' } catch (e) { during['another data write'] = 'refused ' + e.code }
  let removed = 0; try { for (let k = 0; k < 500; k++) { n.remove(k); removed++ } } catch (e) { during.removeError = e.code }
  during['remove 500 rows'] = removed + ' done'
  let votes = 0; try { for (let k = 0; k < 200; k++) { n.j.write(OPS.term.rec(), KIND.term); n.j.sync(); votes++ } } catch (e) { during.voteError = e.code }
  during['200 term changes'] = votes + ' done'
  during['a member change'] = tryOp(n.j, 'conf')
  phase('while full', during)
  // free space with no operator: snapshot, then drop the segments below it
  let snap = null, freed = 0
  try { const b = n.snapshot(); snap = 'ok, ' + MB(b) + ' MB'; n.j.write(OPS.retain.rec(), KIND.retain); n.j.sync(); freed = n.retention() } catch (e) { snap = 'failed: ' + e.code + ' ' + e.message }
  phase('snapshot and retention pass', { snapshot: snap, freedMB: MB(freed) })
  let more = 0, err2 = null
  try { for (; more < 3000; more++) n.put((i + more) % KEYS, false) } catch (e) { err2 = e.code + ': ' + e.message }
  n.j.sync()
  phase('writes after the pass', { accepted: more, stoppedBy: err2 })
  // without headroom the node is stuck; show that only deleting rows AND a snapshot could help, and the snapshot cannot run
  if (PART === 'nohead' && more === 0) {
    let removed2 = 0; try { for (let k = 500; k < KEYS; k++) { n.remove(k); removed2++ } } catch (e) {}
    let snap2; try { const b = n.snapshot(); snap2 = 'ok, ' + MB(b) + ' MB'; freed = n.retention() } catch (e) { snap2 = 'failed: ' + e.code }
    let more2 = 0; try { for (; more2 < 3000; more2++) n.put(more2 % KEYS, false) } catch (e) {} n.j.sync()
    phase('after removing ' + removed2 + ' more rows by hand', { snapshot: snap2, freedMB: MB(freed), writesAccepted: more2 })
  }
  // a restart finds everything acknowledged
  n.j.close(); const n2 = new Node(opts); const rec = n2.open()
  phase('restart', { lastSeq: rec.lastSeq, cut: rec.cut, sameAsBefore: rec.lastSeq === n.j.durable })
  for (const p of t) out(p)
}
