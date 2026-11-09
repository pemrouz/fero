// E-42: E-02's minimal replication pipeline (../E02-pipeline/ts/pipeline.ts, unchanged in its protocol, journal
// and batching) with a recorder of every kernel input, and a replay that checks the effects byte for byte.
// Main-thread mode only (workers=0). What is recorded, per process, into <dir>/rec.<id> (no fsync: the page cache):
//   leader:   submit (a batch of client writes: its count; with rec=full also its record bytes), ack (the raw bytes of
//             each chunk read from a follower), durable (the journal's fdatasync completed up to batch seq)
//   follower: frame data (each chunk read from the leader: with rec=full its bytes; with rec=ref only its length,
//             since the journal already holds the same bytes in the same order), durable (seq)
// Every event also carries the µs since the previous one (a varint), so a dump is a timeline.
// verify=1 keeps a running CRC32 of every effect (leader: each frame after its header is filled, each commit;
// follower: each journal append, each ack); role=replay-leader|replay-follower feeds the recording back into the
// same kernel classes with no sockets and no disk and prints the same digest.
//
// What follows is E-02's file, with the recorder hooks marked "E-42".
//
// One leader and two followers, each its own OS process with its own journal file.
// The leader cuts a batch every 1 ms tick (the window), sends the same bytes to both
// followers at once, and writes them to its own journal. Each journal writes whatever is
// queued with one writev and one fdatasync (group commit). Followers ack the highest batch
// they have durable. A batch commits when a majority (2 of 3) has it.
//
// workers=0: everything on the main thread (M `loop`).
// workers=N: the kernel runs on N worker threads, groups pinned by group % N, one journal and
//            one link per worker (M `kw` for N=1, `kwN` above). The main thread generates the
//            writes and receives commits (leader), or receives the durable bytes and walks them,
//            standing in for the fold (followers).
//
// Frame (leader -> follower, and the journal format): u32 len (bytes after it), u32 crc32
// (of the bytes after it), u32 seq, u32 commit, u32 count, then count records of
// u32 group, u32 index, u32 len, payload. Ack (follower -> leader): u32 seq.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const HDR = 20, RH = 12;

type Opts = {
  role: string; id: number; port: number; peers: number[]; dir: string; mode: string; size: number;
  groups: number; rate: number; start: number; warm: number; dur: number; drain: number; seg: number;
  emu: string; addon: string; workers: number; capBytes: number; rec: string; verify: number; recfile: string; journal: string; swap: number;
};

function parseArgs(argv: string[]): Opts {
  const o: any = { id: 0, port: 0, peers: '', dir: '.', mode: 'persisted', size: 100, groups: 1, rate: 0,
    start: Date.now() + 1000, warm: 2000, dur: 8000, drain: 1000, seg: 0, emu: '', addon: '', workers: 0, capBytes: 32 << 20, rec: 'off', verify: 0, recfile: '', journal: '', swap: 0 };
  for (const a of argv) { const i = a.indexOf('='); o[a.slice(0, i)] = a.slice(i + 1); }
  for (const k of ['id', 'port', 'size', 'groups', 'rate', 'start', 'warm', 'dur', 'drain', 'seg', 'workers', 'capBytes', 'verify', 'swap']) o[k] = Number(o[k]);
  o.peers = o.peers ? String(o.peers).split(',').map(Number) : [];
  return o as Opts;
}

// performance.now() differs per thread; convert the shared epoch-ms window into this thread's clock.
function windowOf(o: Opts) {
  const off = Date.now() - performance.now();
  const start = o.start - off, ws = start + o.warm, we = ws + o.dur;
  return { start, ws, we, end: we + o.drain };
}

function sampler(path: string): (() => number) | null {
  if (!path) return null;
  const t = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l && l[0] !== '#').map(Number);
  let s = (0x9e3779b9 ^ Math.imul(process.pid, 2654435761)) | 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return Math.round(t[Math.floor(((s >>> 0) / 4294967296) * t.length)]); };
}

// ---------------------------------------------------------------- E-42: the recorder
const EV_SUBMIT = 1, EV_ACK = 2, EV_DURABLE = 3, EV_DATA = 4;
class Recorder {
  fd: number; buf = Buffer.allocUnsafe(1 << 20); p = 0; bytes = 0; events = 0; last = performance.now(); full: boolean;
  constructor(path: string, full: boolean) { this.fd = fs.openSync(path, 'w'); this.full = full; }
  vu(v: number) { const b = this.buf; while (v >= 128) { b[this.p++] = (v & 127) | 128; v = Math.floor(v / 128); } b[this.p++] = v; }
  head(kind: number, room: number) {
    if (this.p + room + 32 > this.buf.length) this.flush();
    if (room + 32 > this.buf.length) this.buf = Buffer.allocUnsafe(room + 64);
    const t = performance.now(); this.buf[this.p++] = kind; this.vu(Math.max(0, Math.round((t - this.last) * 1000))); this.last = t; this.events++;
  }
  ev(kind: number, a: number) { this.head(kind, 0); this.vu(a); }
  raw(kind: number, a: number, bytes: Buffer) { this.head(kind, bytes.length); this.vu(a); this.vu(bytes.length); bytes.copy(this.buf, this.p); this.p += bytes.length; }
  flush() { if (this.p) { fs.writeSync(this.fd, this.buf, 0, this.p); this.bytes += this.p; this.p = 0; } }
}
let REC: Recorder | null = null;
let DIG: number | null = null;   // running CRC32 of the effects (verify=1 and replays)
const digest = (b: Buffer) => { if (DIG !== null) DIG = zlib.crc32(b, DIG); };
const digestU32 = (v: number) => { if (DIG !== null) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0, 0); DIG = zlib.crc32(b, DIG); } };

// ---------------------------------------------------------------- journal
class Journal {
  fd: number; pos = 0; q: Buffer[] = []; qSeq = 0; busy = false; flushes = 0;
  sample: (() => number) | null; emu: any = null; o: Opts; onDurable: (seq: number, bufs: Buffer[]) => void;
  constructor(path: string, o: Opts, onDurable: (seq: number, bufs: Buffer[]) => void) {
    this.o = o; this.onDurable = onDurable;
    this.fd = fs.openSync(path, o.seg > 0 ? 'r+' : 'w');
    this.sample = sampler(o.emu);
    if (this.sample) this.emu = createRequire(import.meta.url)(o.addon);
  }
  push(buf: Buffer, seq: number) { this.q.push(buf); this.qSeq = seq; if (!this.busy) this.flush(); }
  write(bufs: Buffer[]) {
    let n = 0; for (const b of bufs) n += b.length;
    if (this.o.seg > 0 && this.pos + n > this.o.seg) this.pos = 0;
    for (let i = 0; i < bufs.length; i += 1024) {
      const part = i === 0 && bufs.length <= 1024 ? bufs : bufs.slice(i, i + 1024);
      let want = 0; for (const b of part) want += b.length;
      const w = this.o.seg > 0 ? fs.writevSync(this.fd, part, this.pos) : fs.writevSync(this.fd, part);
      if (w !== want) throw new Error(`short write ${w} of ${want}`);
      this.pos += w;
    }
  }
  flush() {
    if (this.q.length === 0) return;
    const bufs = this.q, seq = this.qSeq; this.q = [];
    this.write(bufs); this.flushes++;
    if (this.o.mode === 'memory') { this.onDurable(seq, bufs); return; }   // no fsync on this rung
    this.busy = true;
    const done = (err: any) => {
      if (err) throw err instanceof Error ? err : new Error('fdatasync errno ' + err);
      this.busy = false; this.onDurable(seq, bufs); this.flush();
    };
    if (this.sample) this.emu.fsyncDelay(this.fd, this.sample(), (e: number) => done(e || null));
    else fs.fdatasync(this.fd, done);
  }
}

// ---------------------------------------------------------------- leader kernel (one per thread that runs one)
class LeaderCore {
  last: Uint32Array; cidx: Uint32Array; seq = 0; committed = 0; durable = 0; acked = [0, 0];
  batches: Buffer[] = []; bhead = 0; socks: net.Socket[] = []; journal: Journal | null = null;
  o: Opts; w: number; onCommit: (seq: number) => void;
  constructor(o: Opts, w: number, onCommit: (seq: number) => void) {
    this.o = o; this.w = w; this.onCommit = onCommit;
    this.last = new Uint32Array(o.groups); this.cidx = new Uint32Array(o.groups);
    if (o.mode !== 'none') this.journal = new Journal(`${o.dir}/j.${o.id}.${w}`, o, (s) => { if (REC) REC.ev(EV_DURABLE, s); this.durable = s; this.advance(); });
  }
  async connect() {
    if (this.o.mode === 'none' || this.o.mode === 'ldr') return;
    const ports = this.o.peers.map((p) => p + this.w);
    for (let i = 0; i < ports.length; i++) this.socks.push(await dial(ports[i]));
    this.socks.forEach((s, i) => {
      let rest: Buffer | null = null;
      s.on('data', (chunk: Buffer) => {
        if (REC) REC.raw(EV_ACK, i, chunk);   // E-42
        const b = rest ? Buffer.concat([rest, chunk]) : chunk;
        const n = b.length - (b.length % 4);
        if (n > 0) { const a = b.readUInt32LE(n - 4); if (a > this.acked[i]) this.acked[i] = a; }
        rest = n < b.length ? b.subarray(n) : null;
        this.advance();
      });
    });
  }
  // buf: a full frame with records written; indexes are filled here unless `filled`.
  submit(buf: Buffer, count: number, filled: boolean) {
    if (REC) { if (REC.full) REC.raw(EV_SUBMIT, count, buf.subarray(HDR)); else REC.ev(EV_SUBMIT, count); }   // E-42
    const seq = ++this.seq;
    if (!filled) {
      let off = HDR; const last = this.last;
      for (let r = 0; r < count; r++) {
        const g = buf.readUInt32LE(off); buf.writeUInt32LE(++last[g], off + 4);
        off += RH + buf.readUInt32LE(off + 8);
      }
    }
    buf.writeUInt32LE(buf.length - 4, 0); buf.writeUInt32LE(seq, 8); buf.writeUInt32LE(this.committed, 12); buf.writeUInt32LE(count, 16);
    buf.writeUInt32LE(zlib.crc32(buf.subarray(8)) >>> 0, 4);
    digest(buf);   // E-42
    this.batches.push(buf);
    for (const s of this.socks) s.write(buf);
    if (this.o.mode === 'none') { this.durable = seq; this.advance(); return; }
    this.journal!.push(buf, seq);
    if (this.o.mode === 'memory') { this.durable = seq; this.advance(); }
  }
  advance() {
    const d = this.durable, a = this.acked[0], b = this.acked[1], m = this.o.mode;
    const c = m === 'none' || m === 'ldr' ? d : Math.max(Math.min(d, a), Math.min(Math.max(d, a), b));   // median of 3
    if (c <= this.committed) return;
    const cidx = this.cidx;
    for (let s = this.committed + 1; s <= c; s++) {
      const buf = this.batches[this.bhead++];
      const count = buf.readUInt32LE(16); let off = HDR;
      for (let r = 0; r < count; r++) { cidx[buf.readUInt32LE(off)] = buf.readUInt32LE(off + 4); off += RH + buf.readUInt32LE(off + 8); }
    }
    if (this.bhead > 4096) { this.batches = this.batches.slice(this.bhead); this.bhead = 0; }
    this.committed = c;
    digestU32(c);   // E-42
    this.onCommit(c);
  }
}

function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.setNoDelay(true); s.removeAllListeners('error'); s.on('error', () => {}); resolve(s); });
      s.once('error', () => setTimeout(tryOnce, 20));
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------- follower kernel
class FollowerCore {
  last: Uint32Array; journal: Journal; sock: net.Socket | null = null; ack = Buffer.alloc(4);
  received = 0; win: { ws: number; we: number };
  o: Opts; w: number; onApplied: ((bufs: Buffer[]) => void) | null;
  constructor(o: Opts, w: number, onApplied: ((bufs: Buffer[]) => void) | null) {
    this.o = o; this.w = w; this.onApplied = onApplied;
    this.last = new Uint32Array(o.groups); this.win = windowOf(o);
    this.journal = new Journal(`${o.dir}/j.${o.id}.${w}`, o, (seq, bufs) => {
      if (REC) REC.ev(EV_DURABLE, seq);   // E-42
      digestU32(seq);
      this.ack.writeUInt32LE(seq, 0); this.sock!.write(Buffer.from(this.ack));
      if (this.onApplied) this.onApplied(bufs);
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => {
      const srv = net.createServer((s) => {
        s.setNoDelay(true); this.sock = s; s.on('error', () => {});
        s.on('data', (chunk: Buffer) => this.onData(chunk));
      });
      srv.listen(this.o.port + this.w, '127.0.0.1', () => resolve());
    });
  }
  parts: Buffer[] = []; have = 0; need = 4;
  onData(chunk: Buffer) {
          if (REC) { if (REC.full) REC.raw(EV_DATA, 0, chunk); else REC.ev(EV_DATA, chunk.length); }   // E-42
          let parts = this.parts, have = this.have, need = this.need;
          parts.push(chunk); have += chunk.length;
          if (have < need) { this.parts = parts; this.have = have; return; }
          const b = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
          let off = 0, seq = 0, recs = 0; const last = this.last;
          while (b.length - off >= 4) {
            const len = b.readUInt32LE(off);
            if (b.length - off - 4 < len) break;
            seq = b.readUInt32LE(off + 8); const count = b.readUInt32LE(off + 16); let r = off + HDR;
            for (let k = 0; k < count; k++) {
              const g = b.readUInt32LE(r), idx = b.readUInt32LE(r + 4);
              if (idx !== last[g] + 1) throw new Error(`gap in group ${g}: ${idx} after ${last[g]}`);
              last[g] = idx; r += RH + b.readUInt32LE(r + 8);
            }
            recs += count; off += 4 + len;
          }
          const t = performance.now(); if (t >= this.win.ws && t < this.win.we) this.received += recs;
          if (off > 0) { const pushed = off === b.length ? b : b.subarray(0, off); digest(pushed); this.journal.push(pushed, seq); }
          parts = off < b.length ? [b.subarray(off)] : []; have = b.length - off;
          need = have >= 4 ? 4 + parts[0].readUInt32LE(0) : 4;
          this.parts = parts; this.have = have; this.need = need;
  }
}

// ---------------------------------------------------------------- worker thread entry
if (!isMainThread) {
  const { o, w } = workerData as { o: Opts; w: number };
  const port = parentPort!;
  if (o.role === 'leader') {
    const core = new LeaderCore(o, w, (seq) => port.postMessage(seq));
    core.connect().then(() => port.postMessage('ready'));
    port.on('message', (m: any) => {
      if (m === 'stats') port.postMessage({ flushes: core.journal ? core.journal.flushes : 0 });
      else core.submit(Buffer.from(m.ab), m.count, false);
    });
  } else {
    // the durable bytes cross to the main thread, which walks them (standing in for the fold)
    const core = new FollowerCore(o, w, (bufs) => {
      let n = 0; for (const b of bufs) n += b.length;
      const ab = new ArrayBuffer(n), u = new Uint8Array(ab); let off = 0;
      for (const b of bufs) { u.set(b, off); off += b.length; }
      port.postMessage(ab, [ab]);
    });
    core.listen().then(() => port.postMessage('ready'));
    port.on('message', (m: any) => { if (m === 'stats') port.postMessage({ flushes: core.journal.flushes, received: core.received }); });
  }
}

// ---------------------------------------------------------------- main thread
// E-42: recorder and journal bytes over the whole run (flushes the recorder first), and the effects digest
function recReport(o: Opts, j: Journal | null) {
  if (REC) REC.flush();
  return { rec: o.rec, rec_bytes: REC ? REC.bytes : 0, rec_events: REC ? REC.events : 0, journal_bytes: j ? j.pos : 0, digest: DIG };
}
function cpuNow() { const u = process.cpuUsage(); return u.user + u.system; }

function pct(lat: number[], cnt: number[], ps: number[]) {
  const idx = lat.map((_, i) => i).sort((a, b) => lat[a] - lat[b]);
  let tot = 0; for (const c of cnt) tot += c;
  const out: number[] = []; let acc = 0, j = 0;
  for (const p of ps) {
    const target = p * tot;
    while (j < idx.length && acc + cnt[idx[j]] < target) { acc += cnt[idx[j]]; j++; }
    out.push(idx.length ? lat[idx[Math.min(j, idx.length - 1)]] : NaN);
  }
  return out;
}

async function leaderMain(o: Opts) {
  const win = windowOf(o);
  if (o.rec !== 'off') REC = new Recorder(`${o.dir}/rec.${o.id}`, o.rec === 'full');   // E-42
  if (o.verify) DIG = 0;
  const N = Math.max(1, o.workers);
  const payload = Buffer.alloc(o.size, 0x5a);
  const recBytes = RH + o.size;
  const capRecs = Math.floor(o.capBytes / recBytes);
  const chunk = Math.max(1, Math.floor(capRecs / 16));
  // per core: submissions in flight, as parallel arrays (gen time, count, in-window)
  const subT: number[][] = [], subC: number[][] = [], subW: boolean[][] = [], head: number[] = [], doneSeq: number[] = [];
  for (let c = 0; c < N; c++) { subT.push([]); subC.push([]); subW.push([]); head.push(0); doneSeq.push(0); }
  let generated = 0, committedRecs = 0, committedWin = 0, genWin = 0, lateMax = 0, late5 = 0, ticks = 0;
  const lat: number[] = [], latC: number[] = [];
  let cpu0 = 0, cpu1 = 0;

  const onCommit = (c: number, seq: number) => {
    const t = performance.now();
    const T = subT[c], C = subC[c], W = subW[c];
    for (let s = doneSeq[c] + 1; s <= seq; s++) {
      const k = head[c]++;
      committedRecs += C[k];
      if (t >= win.ws && t < win.we) committedWin += C[k];
      if (W[k]) { lat.push(t - T[k]); latC.push(C[k]); }
    }
    doneSeq[c] = seq;
    if (head[c] > 4096) { T.splice(0, head[c]); C.splice(0, head[c]); W.splice(0, head[c]); head[c] = 0; }
  };

  let cores: LeaderCore[] = [], workers: Worker[] = [];
  if (o.workers === 0) {
    const core = new LeaderCore(o, 0, (seq) => onCommit(0, seq));
    await core.connect(); cores.push(core);
  } else {
    const ready: Promise<void>[] = [];
    for (let w = 0; w < N; w++) {
      const wk = new Worker(new URL(import.meta.url), { workerData: { o, w } });
      ready.push(new Promise((res) => wk.once('message', () => res())));
      workers.push(wk);
    }
    await Promise.all(ready);
    workers.forEach((wk, w) => wk.on('message', (m: any) => { if (typeof m === 'number') onCommit(w, m); }));
  }
  if (performance.now() > win.start) console.error('leader: not connected before start');

  // build one frame per core for this tick; records go round robin over groups, group g to core g % N
  const build = (n: number, t: number) => {
    const per = new Array(N).fill(0);
    if (N === 1) per[0] = n; else for (let i = 0; i < n; i++) per[((generated + i) % o.groups) % N]++;
    const bufs: Buffer[] = [], offs: number[] = [];
    for (let c = 0; c < N; c++) { bufs.push(per[c] ? Buffer.allocUnsafeSlow(HDR + per[c] * recBytes) : (null as any)); offs.push(HDR); }
    const inWin = t >= win.ws && t < win.we;
    const main = o.workers === 0 ? cores[0] : null;
    for (let i = 0; i < n; i++) {
      const g = (generated + i) % o.groups, c = N === 1 ? 0 : g % N, b = bufs[c]; let off = offs[c];
      b.writeUInt32LE(g, off); b.writeUInt32LE(main ? ++main.last[g] : 0, off + 4); b.writeUInt32LE(o.size, off + 8);
      b.set(payload, off + RH); offs[c] = off + recBytes;
    }
    generated += n; if (inWin) genWin += n;
    for (let c = 0; c < N; c++) {
      if (!per[c]) continue;
      subT[c].push(t); subC[c].push(per[c]); subW[c].push(inWin);
      if (main) main.submit(bufs[c], per[c], true);
      else { const ab = bufs[c].buffer; workers[c].postMessage({ ab, count: per[c] }, [ab as ArrayBuffer]); }
    }
  };

  let prev = 0;
  const tick = () => {
    const t = performance.now();
    if (prev) { const l = t - prev - 1; if (l > lateMax) lateMax = l; if (l > 5) late5++; }
    prev = t; ticks++;
    if (t < win.we) {
      let n: number;
      if (o.rate > 0) n = Math.floor(((t - win.start) * o.rate) / 1000) - generated;
      else n = Math.min(capRecs - (generated - committedRecs), chunk);   // max: keep about 16 batches in flight
      if (n > 0) build(n, t);
    }
    if (t < win.end) setTimeout(tick, 1);
  };
  setTimeout(tick, Math.max(0, win.start - performance.now()));
  setTimeout(() => { cpu0 = cpuNow(); }, Math.max(0, win.ws - performance.now()));
  setTimeout(() => { cpu1 = cpuNow(); }, Math.max(0, win.we - performance.now()));
  await new Promise((r) => setTimeout(r, Math.max(0, win.end - performance.now())));
  let flushes = 0;
  if (o.workers === 0) flushes = cores[0].journal ? cores[0].journal.flushes : 0;
  else {
    const st = await Promise.all(workers.map((wk) => new Promise<any>((res) => {
      const h = (m: any) => { if (typeof m === 'object') { wk.off('message', h); res(m); } };
      wk.on('message', h); wk.postMessage('stats');
    })));
    for (const s of st) flushes += s.flushes;
  }
  const [p50, p90, p99, p999, pmax] = pct(lat, latC, [0.5, 0.9, 0.99, 0.999, 1]);
  const cpu = cpu1 - cpu0, secs = o.dur / 1000;
  let latN = 0; for (const c of latC) latN += c;
  console.log(JSON.stringify({ role: 'leader', impl: o.workers ? `ts-w${o.workers}` : 'ts', node: process.version, mode: o.mode,
    size: o.size, groups: o.groups, rate: o.rate, gen_win: genWin, committed_win: committedWin, tput: Math.round(committedWin / secs),
    cpu_ms: Math.round(cpu / 1000), cpu_us_per_append: committedWin ? +(cpu / committedWin).toFixed(3) : null,
    cores_used: +(cpu / 1e6 / secs).toFixed(3),
    lat_ms: { p50: +p50.toFixed(3), p90: +p90.toFixed(3), p99: +p99.toFixed(3), p999: +p999.toFixed(3), max: +pmax.toFixed(3) },
    lat_n: latN, missing: genWin - latN, flushes, recs_per_flush: flushes ? +(generated / flushes).toFixed(1) : null,
    ticks, tick_late_max_ms: +lateMax.toFixed(2), ticks_late_over_5ms: late5, ...recReport(o, cores[0]?.journal ?? null) }));
  process.exit(0);
}

async function followerMain(o: Opts) {
  const win = windowOf(o);
  if (o.rec !== 'off') REC = new Recorder(`${o.dir}/rec.${o.id}`, o.rec === 'full');   // E-42
  if (o.verify) DIG = 0;
  const N = Math.max(1, o.workers);
  let cpu0 = 0, cpu1 = 0, walked = 0, received = 0, flushes = 0;
  let cores: FollowerCore[] = [], workers: Worker[] = [];
  if (o.workers === 0) {
    const core = new FollowerCore(o, 0, null); await core.listen(); cores.push(core);
  } else {
    const ready: Promise<void>[] = [];
    for (let w = 0; w < N; w++) {
      const wk = new Worker(new URL(import.meta.url), { workerData: { o, w } });
      ready.push(new Promise((res) => wk.once('message', () => res())));
      workers.push(wk);
    }
    await Promise.all(ready);
    // the main thread walks every durable record once (the stand-in for data's fold)
    for (const wk of workers) wk.on('message', (m: any) => {
      if (!(m instanceof ArrayBuffer)) return;
      const b = Buffer.from(m); let off = 0;
      while (off < b.length) {
        const len = b.readUInt32LE(off), count = b.readUInt32LE(off + 16); let r = off + HDR;
        for (let k = 0; k < count; k++) r += RH + b.readUInt32LE(r + 8);
        walked += count; off += 4 + len;
      }
    });
  }
  console.error(`follower ${o.id} ready`);
  setTimeout(() => { cpu0 = cpuNow(); }, Math.max(0, win.ws - performance.now()));
  setTimeout(() => { cpu1 = cpuNow(); }, Math.max(0, win.we - performance.now()));
  await new Promise((r) => setTimeout(r, Math.max(0, win.end + 300 - performance.now())));
  if (o.workers === 0) { received = cores[0].received; flushes = cores[0].journal.flushes; }
  else {
    const st = await Promise.all(workers.map((wk) => new Promise<any>((res) => {
      const h = (m: any) => { if (m && typeof m === 'object' && !(m instanceof ArrayBuffer)) { wk.off('message', h); res(m); } };
      wk.on('message', h); wk.postMessage('stats');
    })));
    for (const s of st) { received += s.received; flushes += s.flushes; }
  }
  const cpu = cpu1 - cpu0, secs = o.dur / 1000;
  console.log(JSON.stringify({ role: 'follower', id: o.id, impl: o.workers ? `ts-w${o.workers}` : 'ts', received_win: received,
    cpu_ms: Math.round(cpu / 1000), cpu_us_per_append: received ? +(cpu / received).toFixed(3) : null,
    cores_used: +(cpu / 1e6 / secs).toFixed(3), flushes, walked, ...recReport(o, cores[0]?.journal ?? null) }));
  process.exit(0);
}

// ---------------------------------------------------------------- E-42: replay
function* events(path: string) {
  const b = fs.readFileSync(path); let q = 0;
  const rv = () => { let v = 0, mul = 1, x; do { x = b[q++]; v += (x & 127) * mul; mul *= 128; } while (x & 128); return v; };
  while (q < b.length) {
    const kind = b[q++]; const dt = rv(); const a = rv(); let bytes: Buffer | null = null;
    if (kind === EV_ACK || ((kind === EV_SUBMIT || kind === EV_DATA) && fullRec)) { const n = rv(); bytes = b.subarray(q, q + n); q += n; }
    yield { kind, dt, a, bytes };
  }
}
let fullRec = false;
// swap=k: a planted fault, the k-th event that is not a submit or data event is delivered one event later
function* swapped(it: Generator<any>, k: number) {
  let held: any = null, c = 0;
  for (const e of it) {
    if (held) { yield e; yield held; held = null; continue; }
    if (k && (e.kind === EV_ACK || e.kind === EV_DURABLE) && ++c === k) { held = e; continue; }
    yield e;
  }
  if (held) yield held;
}
function replay(o: Opts) {
  fullRec = o.rec === 'full'; DIG = 0;
  const t0 = performance.now(); let n = 0;
  const jb = o.rec === 'full' ? null : fs.readFileSync(o.journal); let jq = 0;   // the process's own journal (rec=ref)
  const ro = { ...o, mode: 'persisted', seg: 0, emu: '', dir: fs.mkdtempSync(`${o.dir}/replay-`) };
  if (o.role === 'replay-leader') {
    const core = new LeaderCore(ro, 0, () => {});
    core.journal!.push = () => {};          // no disk: durability comes from the recording
    const rest: (Buffer | null)[] = [null, null];
    for (const e of swapped(events(o.recfile), o.swap)) {
      n++;
      if (e.kind === EV_SUBMIT) {
        let buf: Buffer;
        if (e.bytes) { buf = Buffer.alloc(HDR + e.bytes.length); e.bytes.copy(buf, HDR); }
        else { const len = jb!.readUInt32LE(jq); buf = Buffer.from(jb!.subarray(jq, jq + 4 + len)); jq += 4 + len; buf.fill(0, 0, HDR); }
        core.submit(buf, e.a, true);
      } else if (e.kind === EV_ACK) {        // the same steps as the live ack handler
        const i = e.a, chunk = e.bytes!; const b = rest[i] ? Buffer.concat([rest[i]!, chunk]) : chunk;
        const k = b.length - (b.length % 4);
        if (k > 0) { const v = b.readUInt32LE(k - 4); if (v > core.acked[i]) core.acked[i] = v; }
        rest[i] = k < b.length ? b.subarray(k) : null;
        core.advance();
      } else if (e.kind === EV_DURABLE) { core.durable = e.a; core.advance(); }
    }
  } else {
    const core = new FollowerCore(ro, 0, null);
    core.sock = { write: () => true } as any;
    core.journal.push = () => {};
    for (const e of swapped(events(o.recfile), o.swap)) {
      n++;
      if (e.kind === EV_DATA) { const chunk = e.bytes ? Buffer.from(e.bytes) : Buffer.from(jb!.subarray(jq, jq + e.a)); jq += e.a; core.onData(chunk); }
      else if (e.kind === EV_DURABLE) core.journal.onDurable(e.a, []);
    }
  }
  fs.rmSync(ro.dir, { recursive: true, force: true });
  console.log(JSON.stringify({ role: o.role, rec: o.rec, events: n, digest: DIG, replay_ms: +(performance.now() - t0).toFixed(1) }));
}

if (isMainThread) {
  const o = parseArgs(process.argv.slice(2));
  if (o.role.startsWith('replay')) replay(o);
  else (o.role === 'leader' ? leaderMain(o) : followerMain(o)).catch((e) => { console.error(e); process.exit(1); });
}
