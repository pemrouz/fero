// E-12 (and E-35): one shared journal against one log file per group, in Node 22.
// Storage only: one process, no replication, no network. A record is durable when the
// fdatasync that covers it returns. Latency = durable time - the record's ideal arrival time
// (open loop: a late generator counts against the run, never in its favour).
//
// Modes (E-12):
//   a  one journal for every group; one writev + one fdatasync per batch (group commit:
//      when the journal is idle it takes everything queued).
//   b  one file per group; each group commits on its own (when that group's file is idle it
//      takes that group's queue, writes it, fdatasyncs it). fdatasyncs run on libuv's pool
//      (UV_THREADPOOL_SIZE, default 4), so at most that many are in flight.
//   c  one file per group; all synced together per window: when idle, take every group's
//      queue, write each dirty file, fdatasync all of them at once, and ack when all return.
//
// Extras for E-35 (mode a only): classes of records with their own size and rate
// (spec=JSON), a batch cap in bytes (cap=65536; a record bigger than the cap is cut into
// cap-sized frames that ride in consecutive batches), order=fifo|rr (round robin across
// groups when cutting a batch), blob=<bytes> (a record at least that big is written to a side
// file and fdatasynced there; only a 24-byte pointer enters the journal, after the side file
// is durable).
//
// Journal format: batch = u32 len, u32 crc32 (of the bytes after it), u32 seq, u32 count,
// then count records of u32 group, u32 seq-in-group, u32 len, payload.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

type Cls = { name: string; parts: number; rate: number; size: number; base: number };
const o: any = { mode: 'a', groups: 1, rate: 10000, size: 100, warm: 2000, dur: 8000, drain: 1500,
  inflight: 32 << 20, dir: '', prealloc: 0, cap: 0, order: 'fifo', blob: 0, spec: '', tag: '' };
for (const a of process.argv.slice(2)) { const i = a.indexOf('='); o[a.slice(0, i)] = a.slice(i + 1); }
for (const k of ['groups', 'rate', 'size', 'warm', 'dur', 'drain', 'inflight', 'prealloc', 'cap', 'blob']) o[k] = Number(o[k]);
if (!o.dir) throw new Error('dir= is required');

// ------------------------------------------------------------ classes of load
const classes: Cls[] = [];
if (o.spec) {
  let base = 0;
  for (const c of JSON.parse(o.spec)) { classes.push({ name: c.name, parts: c.parts, rate: c.rate, size: c.size, base }); base += c.parts; }
} else classes.push({ name: 'all', parts: o.groups, rate: o.rate, size: o.size, base: 0 });
const NG = classes.reduce((s, c) => s + c.parts, 0);
const maxSize = Math.max(...classes.map((c) => c.size));
const payload = Buffer.alloc(Math.max(maxSize, 1), 0x5a);

// ------------------------------------------------------------ histogram (log-linear, µs)
const HB = 3200;
function hidx(us: number) { const v = Math.max(0, Math.floor(us)); if (v < 256) return v; const e = 31 - Math.clz32(v); const sh = e - 7; return 256 + (e - 8) * 128 + ((v >>> sh) - 128); }
function hval(i: number) { if (i < 256) return i + 0.5; const e = Math.floor((i - 256) / 128) + 8; const m = ((i - 256) % 128) + 128; const sh = e - 7; return (m << sh) + (1 << sh) / 2; }
function pct(h: Float64Array, n: number, p: number) { if (n === 0) return null; const want = Math.ceil(p * n); let c = 0; for (let i = 0; i < HB; i++) { c += h[i]; if (c >= want) return hval(i) / 1000; } return null; }

// ------------------------------------------------------------ records and queues
type Rec = { g: number; cls: number; t: number; size: number; left: number; seq: number; ptr: boolean };
class Q { a: Rec[] = []; h = 0; push(r: Rec) { this.a.push(r); } get n() { return this.a.length - this.h; } peek() { return this.a[this.h]; }
  shift() { const r = this.a[this.h++]; if (this.h > 4096 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; } return r; } }
const gq: Q[] = Array.from({ length: NG }, () => new Q());   // per group (modes b, c, and rr)
const fifo = new Q();                                           // mode a, order fifo
const gseq = new Int32Array(NG);

// ------------------------------------------------------------ files
fs.mkdirSync(o.dir, { recursive: true });
type F = { fd: number; pos: number; seg: number; busy: boolean };
function openFile(name: string, seg: number): F {
  const p = path.join(o.dir, name);
  if (seg > 0) {
    // A preallocated segment filled with zeros, so every write overwrites blocks already on disk.
    const fd = fs.openSync(p, 'w+'); const z = Buffer.alloc(Math.min(seg, 1 << 20));
    for (let off = 0; off < seg; off += z.length) fs.writeSync(fd, z, 0, Math.min(z.length, seg - off), off);
    fs.fdatasyncSync(fd); return { fd, pos: 0, seg, busy: false };
  }
  return { fd: fs.openSync(p, 'w'), pos: 0, seg: 0, busy: false };
}
const nfiles = o.mode === 'a' ? 1 : NG;
const segBytes = o.prealloc ? Math.max(256 << 10, Math.floor((256 << 20) / nfiles / 4096) * 4096) : 0;
const files: F[] = [];
for (let i = 0; i < nfiles; i++) files.push(openFile(o.mode === 'a' ? 'journal' : `g${i}`, segBytes));
const blobF = o.blob > 0 ? openFile('blobs', 0) : null;

function writeOut(f: F, bufs: Buffer[], n: number) {
  if (f.seg > 0 && f.pos + n > f.seg) f.pos = 0;
  for (let i = 0; i < bufs.length; i += 1024) {
    const part = bufs.length <= 1024 ? bufs : bufs.slice(i, i + 1024);
    let want = 0; for (const b of part) want += b.length;
    const w = f.seg > 0 ? fs.writevSync(f.fd, part, f.pos) : fs.writevSync(f.fd, part);
    if (w !== want) throw new Error(`short write ${w} of ${want}`);
    f.pos += w;
    if (bufs.length <= 1024) break;
  }
}

// ------------------------------------------------------------ measurement
const H = classes.map(() => new Float64Array(HB));
const HN = new Float64Array(classes.length), DONE = new Float64Array(classes.length);
let fsyncs = 0, bytesW = 0, batches = 0, batchRecs = 0, inflightBytes = 0;
let t0 = 0, ws = 0, we = 0, measuring = false;
const now = () => performance.now();

function encodeBatch(take: { r: Rec; bytes: number; last: boolean }[], seq: number): { bufs: Buffer[]; n: number } {
  // small records are copied into one buffer; a record (or frame) of 4 KiB or more rides as its own iovec
  let small = 16; for (const x of take) small += 12 + (x.bytes < 4096 ? x.bytes : 0);
  const head = Buffer.allocUnsafe(small); const bufs: Buffer[] = [head]; let off = 16, total = 16;
  for (const x of take) {
    head.writeUInt32LE(x.r.g, off); head.writeUInt32LE(x.r.seq, off + 4); head.writeUInt32LE(x.bytes, off + 8); off += 12; total += 12;
    if (x.bytes < 4096) { payload.copy(head, off, 0, x.bytes); off += x.bytes; } else bufs.push(payload.subarray(0, x.bytes));
    total += x.bytes;
  }
  head.writeUInt32LE(total - 4, 0); head.writeUInt32LE(seq >>> 0, 8); head.writeUInt32LE(take.length, 12);
  let crc = zlib.crc32(head.subarray(8)); for (let i = 1; i < bufs.length; i++) crc = zlib.crc32(bufs[i], crc);
  head.writeUInt32LE(crc >>> 0, 4);
  return { bufs, n: total };
}

function done(take: { r: Rec; last: boolean }[], tEnd: number) {
  for (const x of take) {
    if (!x.last) continue;
    const r = x.r; inflightBytes -= r.size;
    if (r.t >= ws && r.t < we) { H[r.cls][hidx((tEnd - r.t) * 1000)]++; HN[r.cls]++; }
    if (tEnd >= ws && tEnd < we) DONE[r.cls]++;
  }
}
const inWin = (t: number) => t >= ws && t < we;

// take up to cap bytes from a queue (cap 0 = everything); a record bigger than what is left
// of the cap is cut, and its remainder stays at the head for the next batch
function takeFrom(q: Q, out: { r: Rec; bytes: number; last: boolean }[], budget: number): number {
  while (q.n > 0) {
    const r = q.peek(); const want = r.ptr ? 24 : r.left;
    if (o.cap > 0 && want > budget) {
      if (budget < Math.min(4096, o.cap) && out.length > 0) break;
      const b = Math.max(1, budget); r.left -= b; out.push({ r, bytes: b, last: false }); return 0;
    }
    q.shift(); out.push({ r, bytes: want, last: true }); budget -= want;
  }
  return budget;
}

let jseq = 0, rrPtr = 0;
const active: number[] = []; const isActive = new Uint8Array(NG);   // groups with queued records (rr, b, c)

function cutA() {
  const f = files[0]; if (f.busy) return;
  const take: { r: Rec; bytes: number; last: boolean }[] = [];
  const cap = o.cap > 0 ? o.cap : Infinity;
  if (o.order === 'rr') {
    // round robin: one record (or frame) from each group with queued records, until the cap
    let budget = cap, progress = true;
    while (budget > 0 && active.length > 0 && progress) {
      progress = false;
      for (let k = 0; k < active.length && budget > 0; k++) {
        const i = (rrPtr + k) % active.length; const g = active[i]; const q = gq[g];
        if (q.n === 0) continue;
        const r = q.peek(); const want = r.ptr ? 24 : r.left;
        if (want <= budget || o.cap === 0) { q.shift(); take.push({ r, bytes: want, last: true }); budget -= want; progress = true; }
        else if (budget >= Math.min(4096, o.cap) || take.length === 0) { const b = budget; r.left -= b; take.push({ r, bytes: b, last: false }); budget = 0; progress = true; }
      }
      rrPtr++;
    }
    for (let i = active.length - 1; i >= 0; i--) if (gq[active[i]].n === 0) { isActive[active[i]] = 0; active.splice(i, 1); }
  } else takeFrom(fifo, take, cap === Infinity ? 0 : cap);
  if (take.length === 0) return;
  flushOne(f, take, cutA);
}

function flushOne(f: F, take: { r: Rec; bytes: number; last: boolean }[], again: () => void) {
  const { bufs, n } = encodeBatch(take, jseq++);
  writeOut(f, bufs, n); f.busy = true;
  fs.fdatasync(f.fd, (err) => {
    if (err) throw err;
    const t = now(); f.busy = false;
    if (inWin(t)) { fsyncs++; bytesW += n; batches++; batchRecs += take.length; }
    done(take, t); again();
  });
}

function cutB(g: number) {
  const f = files[g]; if (f.busy) return;
  const take: { r: Rec; bytes: number; last: boolean }[] = [];
  takeFrom(gq[g], take, 0);
  if (take.length === 0) return;
  flushOne(f, take, () => cutB(g));
}

let cBusy = false;
function cutC() {
  if (cBusy || active.length === 0) return;
  const groups = active.splice(0); for (const g of groups) isActive[g] = 0;
  const all: { r: Rec; bytes: number; last: boolean }[] = []; let pending = 0, nb = 0;
  const fds: number[] = [];
  for (const g of groups) {
    const take: { r: Rec; bytes: number; last: boolean }[] = [];
    takeFrom(gq[g], take, 0); if (take.length === 0) continue;
    const { bufs, n } = encodeBatch(take, jseq++); writeOut(files[g], bufs, n); nb += n;
    for (const x of take) all.push(x); fds.push(files[g].fd);
  }
  if (fds.length === 0) return;
  cBusy = true; pending = fds.length;
  for (const fd of fds) fs.fdatasync(fd, (err) => {
    if (err) throw err;
    if (inWin(now())) fsyncs++;
    if (--pending === 0) {
      const t = now(); cBusy = false;
      if (inWin(t)) { bytesW += nb; batches++; batchRecs += all.length; }
      done(all, t); cutC();
    }
  });
}

// side file for big records (E-35 variant): payload to the blob file, fdatasync, then a pointer enters the journal
function toBlob(r: Rec) {
  const f = blobF!; writeOut(f, [payload.subarray(0, r.size)], r.size);
  fs.fdatasync(f.fd, (err) => { if (err) throw err; r.ptr = true; enqueue(r); kick(); });
}

let dirtyB: number[] = [];
function enqueue(r: Rec) {
  if (o.mode === 'a' && o.order !== 'rr') { fifo.push(r); return; }
  gq[r.g].push(r);
  if (o.mode === 'b') { if (gq[r.g].n === 1) dirtyB.push(r.g); }
  else if (!isActive[r.g]) { isActive[r.g] = 1; active.push(r.g); }
}
function kick() {
  if (o.mode === 'a') cutA();
  else if (o.mode === 'c') cutC();
  else { const d = dirtyB; dirtyB = []; for (const g of d) { if (!files[g].busy) cutB(g); } }
}

// ------------------------------------------------------------ the load (open loop, ideal arrival times)
let rng = 0x9e3779b9 | 0;
const rnd = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
const made = new Float64Array(classes.length);
function make(ci: number, t: number) {
  const c = classes[ci]; const g = c.base + (c.parts === 1 ? 0 : Math.floor(rnd() * c.parts));
  const r: Rec = { g, cls: ci, t, size: c.size, left: c.size, seq: gseq[g]++, ptr: false };
  inflightBytes += c.size;
  if (o.blob > 0 && c.size >= o.blob) { toBlob(r); return; }
  enqueue(r);
}
let stopGen = false;
function tick() {
  const t = now();
  if (t >= we) stopGen = true;
  if (!stopGen) {
    for (let ci = 0; ci < classes.length; ci++) {
      const c = classes[ci];
      if (c.rate > 0) {
        // records whose ideal arrival time (t0 + k/rate) is not later than now: k = 0 .. floor((t - t0) * rate) inclusive
        const due = Math.floor((t - t0) * c.rate / 1000) + 1;
        for (let k = made[ci]; k < due; k++) make(ci, t0 + (k * 1000) / c.rate);
        if (due > made[ci]) made[ci] = due;
      } else {
        // max: keep up to `inflight` bytes made but not yet durable; add at most 1/16 of it per tick
        let room = Math.min(o.inflight - inflightBytes, o.inflight / 16);
        while (room >= c.size) { make(ci, t); room -= c.size; }
      }
    }
    kick();
  }
  if (t < we + o.drain) setTimeout(tick, 1); else finish();
}

function procStat() { const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { busy: l[0] + l[1] + l[2] + l[5] + l[6] + l[7], total: l.reduce((s, x) => s + x, 0) }; }
let cpu0: NodeJS.CpuUsage, st0: { busy: number; total: number }, cpuW: NodeJS.CpuUsage, stW: { busy: number; total: number };
function finish() {
  const winS = (we - ws) / 1000; const res: any = {
    exp: 'E-12', impl: 'ts', tag: o.tag, mode: o.mode, groups: NG, rate: o.rate, size: o.size, prealloc: o.prealloc, cap: o.cap, order: o.order, blob: o.blob,
    pool: Number(process.env.UV_THREADPOOL_SIZE || 4), loadavg: o.loadavg,
    appends_s: DONE.reduce((s, x) => s + x, 0) / winS, fsyncs_s: fsyncs / winS, mb_s: bytesW / winS / 1e6,
    recs_per_batch: batches ? batchRecs / batches : 0,
    cpu_us_per_append: (cpuW.user + cpuW.system) / Math.max(1, DONE.reduce((s, x) => s + x, 0)), cores: (cpuW.user + cpuW.system) / 1e6 / winS,
    other_cores: Math.max(0, ((stW.busy) / (stW.total) * os.cpus().length) - (cpuW.user + cpuW.system) / 1e6 / winS),
    classes: classes.map((c, i) => ({ name: c.name, parts: c.parts, rate: c.rate, size: c.size, done_s: DONE[i] / winS, n: HN[i],
      p50: pct(H[i], HN[i], 0.5), p99: pct(H[i], HN[i], 0.99), p999: pct(H[i], HN[i], 0.999), max: pct(H[i], HN[i], 1) })),
  };
  if (classes.length === 1) { const c = res.classes[0]; Object.assign(res, { p50: c.p50, p99: c.p99, p999: c.p999, max: c.max }); }
  console.log(JSON.stringify(res));
  for (const f of files) fs.closeSync(f.fd); if (blobF) fs.closeSync(blobF.fd);
  fs.rmSync(o.dir, { recursive: true, force: true });
  process.exit(0);
}

o.loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
t0 = now(); ws = t0 + o.warm; we = ws + o.dur;
setTimeout(() => { cpu0 = process.cpuUsage(); st0 = procStat(); }, Math.max(0, o.warm - 1));
setTimeout(() => { cpuW = process.cpuUsage(cpu0); const s = procStat(); stW = { busy: s.busy - st0.busy, total: s.total - st0.total }; }, o.warm + o.dur);
tick();
