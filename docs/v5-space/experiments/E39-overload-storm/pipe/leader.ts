// E-39 (a): E-02's TypeScript pipeline leader with a client front and admission control.
// The replication part is E-02's (ts/pipeline.ts): one leader, two followers (E-02's own follower processes),
// a 1 ms batch window, one writev + fdatasync per journal flush (group commit), commit at a majority. What is new:
// writes come from clients over TCP instead of being generated in-process, and the leader answers each one.
//
//   node --experimental-strip-types leader.ts port=<client port> peers=<p1,p2> dir=<dir> seg=<bytes>
//        policy=unbounded|bounded limit=<records> [capBytes=33554432] [secs=30]
//   unbounded  every request is admitted; at most capBytes ride in flight (E-02's max mode), the rest wait in
//              an unbounded queue
//   bounded    a request is refused at once with a retry-after when admitting it would put more than `limit`
//              records between admission and commit; retry-after = the time the backlog needs to drain to half
//              the limit at the commit rate of the last 100 ms
//   bounded-prio  bounded, and the commit path comes first: once the client links have handed over more than
//              limit / 4 requests since the last batch was cut (limit is 5 ms of the maximum rate, so this is
//              1.25 ms of capacity per 1 ms tick), they are paused (TCP backpressure: the requests wait in the
//              socket buffers) until the next tick, so acks, fsync completions and the batch timer are never
//              starved by incoming requests
// Client wire: client -> leader frames [u32 bodyLen][u32 count] then count x ([u32 reqId][u16 size][size B]);
//              leader -> client frames [u32 bodyLen][u8 type][u32 count][u32 retryAfterUs] then count x u32 reqId
//              (type 1 = committed, 2 = refused).
// Every second it records committed, refused and queued counts and its CPU; at exit (secs) one JSON line.
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';

const HDR = 20, RH = 12;
const o: any = { port: 0, peers: '', dir: '.', seg: 0, policy: 'bounded', limit: 50000, capBytes: 32 << 20, secs: 30 };
for (const a of process.argv.slice(2)) { const i = a.indexOf('='); o[a.slice(0, i)] = a.slice(i + 1); }
for (const k of ['port', 'seg', 'limit', 'capBytes', 'secs']) o[k] = Number(o[k]);
const peers: number[] = String(o.peers).split(',').filter(Boolean).map(Number);

// ---------------------------------------------------------------- journal (E-02's, preallocated segment)
class Journal {
  fd: number; pos = 0; q: Buffer[] = []; qSeq = 0; busy = false; flushes = 0; onDurable: (seq: number) => void;
  constructor(path: string, onDurable: (seq: number) => void) { this.onDurable = onDurable; this.fd = fs.openSync(path, o.seg > 0 ? 'r+' : 'w'); }
  push(buf: Buffer, seq: number) { this.q.push(buf); this.qSeq = seq; if (!this.busy) this.flush(); }
  flush() {
    if (this.q.length === 0) return;
    const bufs = this.q, seq = this.qSeq; this.q = [];
    let n = 0; for (const b of bufs) n += b.length;
    if (o.seg > 0 && this.pos + n > o.seg) this.pos = 0;
    for (let i = 0; i < bufs.length; i += 1024) {
      const part = bufs.length <= 1024 ? bufs : bufs.slice(i, i + 1024);
      const w = o.seg > 0 ? fs.writevSync(this.fd, part, this.pos) : fs.writevSync(this.fd, part);
      this.pos += w;
      if (bufs.length <= 1024) break;
    }
    this.flushes++;
    this.busy = true;
    fs.fdatasync(this.fd, (err) => { if (err) throw err; this.busy = false; this.onDurable(seq); this.flush(); });
  }
}

// ---------------------------------------------------------------- the leader
type Link = { s: net.Socket; acks: number[] };
const links: Link[] = [];
// requests admitted and waiting for the next batch: parallel arrays (payload slices, link, reqId)
let qPay: Buffer[] = [], qLink: Link[] = [], qId: number[] = [], qHead = 0;
// batches in flight: frame + who to answer
const inflight: { seq: number; links: Link[]; ids: number[]; bytes: number }[] = [];
let inflightBytes = 0, inflightRecs = 0;
let seq = 0, committed = 0, durable = 0; const acked = [0, 0];
let last = 0;
let stCommitted = 0, stRefused = 0, stAdmitted = 0, maxQueued = 0;
const rateWin: number[] = []; // commits in each of the last ten 10 ms slots
let slotCommits = 0;
const socks: net.Socket[] = [];
const journal = new Journal(`${o.dir}/j.0.0`, (s) => { durable = s; advance(); });
const queued = () => qPay.length - qHead;

function reply(L: Link, type: number, ids: number[], retryUs: number) {
  const b = Buffer.allocUnsafe(4 + 9 + 4 * ids.length);
  b.writeUInt32LE(9 + 4 * ids.length, 0); b[4] = type; b.writeUInt32LE(ids.length, 5); b.writeUInt32LE(retryUs, 9);
  let off = 13; for (const id of ids) { b.writeUInt32LE(id, off); off += 4; }
  L.s.write(b);
}

function advance() {
  const d = durable, a = acked[0], b = acked[1];
  const c = Math.max(Math.min(d, a), Math.min(Math.max(d, a), b)); // median of three: a majority has it
  if (c <= committed) return;
  const touched = new Set<Link>();
  while (inflight.length && inflight[0].seq <= c) {
    const B = inflight.shift()!;
    inflightBytes -= B.bytes; inflightRecs -= B.ids.length;
    for (let i = 0; i < B.ids.length; i++) { B.links[i].acks.push(B.ids[i]); touched.add(B.links[i]); }
    stCommitted += B.ids.length; slotCommits += B.ids.length;
  }
  for (const L of touched) { reply(L, 1, L.acks, 0); L.acks = []; }
  committed = c;
}

// cut a batch from the queue (at most capBytes in flight, E-02's max mode)
// bounded-prio: requests taken from the client links since the last cut, and the links paused for budget
let takenSinceCut = 0, paused = false;
function cut() {
  takenSinceCut = 0;
  if (paused) { paused = false; for (const L of links) L.s.resume(); }
  let n = queued();
  if (n === 0) return;
  const room = Math.floor((o.capBytes - inflightBytes) / (RH + 100));
  if (room <= 0) return;
  n = Math.min(n, room);
  let bytes = HDR; for (let i = 0; i < n; i++) bytes += RH + qPay[qHead + i].length;
  const buf = Buffer.allocUnsafeSlow(bytes);
  let off = HDR; const ls: Link[] = new Array(n), ids: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = qPay[qHead + i];
    buf.writeUInt32LE(0, off); buf.writeUInt32LE(++last, off + 4); buf.writeUInt32LE(p.length, off + 8); p.copy(buf, off + RH);
    off += RH + p.length; ls[i] = qLink[qHead + i]; ids[i] = qId[qHead + i];
  }
  qHead += n;
  if (qHead > 65536) { qPay = qPay.slice(qHead); qLink = qLink.slice(qHead); qId = qId.slice(qHead); qHead = 0; }
  const s = ++seq;
  buf.writeUInt32LE(bytes - 4, 0); buf.writeUInt32LE(s, 8); buf.writeUInt32LE(committed, 12); buf.writeUInt32LE(n, 16);
  buf.writeUInt32LE(zlib.crc32(buf.subarray(8)) >>> 0, 4);
  inflight.push({ seq: s, links: ls, ids, bytes }); inflightBytes += bytes; inflightRecs += n;
  for (const so of socks) so.write(buf);
  journal.push(buf, s);
}

const commitRate = () => { let s = 0; for (const x of rateWin) s += x; return rateWin.length ? s / (rateWin.length * 0.01) : 0; }

function onClient(s: net.Socket) {
  s.setNoDelay(true);
  const L: Link = { s, acks: [] };
  links.push(L);
  let parts: Buffer[] = [], have = 0;
  s.on('data', (chunk: Buffer) => {
    parts.push(chunk); have += chunk.length;
    if (have < 8) return;
    const b = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
    let off = 0;
    while (b.length - off >= 8) {
      const len = b.readUInt32LE(off);
      if (b.length - off - 4 < len) break;
      const count = b.readUInt32LE(off + 4);
      let r = off + 8;
      const refused: number[] = [];
      for (let k = 0; k < count; k++) {
        const id = b.readUInt32LE(r), size = b.readUInt16LE(r + 4);
        if (o.policy !== 'unbounded' && inflightRecs + queued() >= o.limit) refused.push(id);
        else { qPay.push(b.subarray(r + 6, r + 6 + size)); qLink.push(L); qId.push(id); stAdmitted++; }
        r += 6 + size;
      }
      takenSinceCut += count;
      if (refused.length) {
        const rate = Math.max(commitRate(), 1000);
        const backlog = inflightRecs + queued() - o.limit / 2;
        reply(L, 2, refused, Math.max(1000, Math.round((backlog / rate) * 1e6)));
        stRefused += refused.length;
      }
      off += 4 + len;
    }
    const q = queued(); if (q > maxQueued) maxQueued = q;
    if (o.policy === 'bounded-prio' && takenSinceCut > o.limit / 4 && !paused) { paused = true; for (const x of links) x.s.pause(); }
    parts = off < b.length ? [b.subarray(off)] : []; have = b.length - off;
  });
  s.on('error', () => {});
}

function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const tryOnce = () => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.setNoDelay(true); resolve(s); }); s.once('error', () => setTimeout(tryOnce, 20)); };
    tryOnce();
  });
}

const cpuNow = () => { const u = process.cpuUsage(); return u.user + u.system; };
async function main() {
  for (let i = 0; i < peers.length; i++) {
    const s = await dial(peers[i]);
    let rest: Buffer | null = null;
    s.on('data', (chunk: Buffer) => {
      const b = rest ? Buffer.concat([rest, chunk]) : chunk;
      const n = b.length - (b.length % 4);
      if (n > 0) { const a = b.readUInt32LE(n - 4); if (a > acked[i]) acked[i] = a; }
      rest = n < b.length ? b.subarray(n) : null;
      advance();
    });
    socks.push(s);
  }
  const srv = net.createServer(onClient);
  await new Promise<void>((r) => srv.listen(o.port, '127.0.0.1', () => r()));
  console.error('leader ready');
  setInterval(cut, 1);
  setInterval(() => { rateWin.push(slotCommits); slotCommits = 0; if (rateWin.length > 10) rateWin.shift(); }, 10);
  const series: any[] = [];
  let c0 = cpuNow(), t0 = performance.now(), sc = 0, sr = 0, sa = 0;
  setInterval(() => {
    const c = cpuNow(), t = performance.now();
    series.push({ t: +((t / 1000)).toFixed(2), committed: stCommitted - sc, refused: stRefused - sr, admitted: stAdmitted - sa, queued: queued(), inflight: inflightRecs, max_queued: maxQueued, cores: +((c - c0) / 1e3 / (t - t0)).toFixed(3) });
    sc = stCommitted; sr = stRefused; sa = stAdmitted; c0 = c; t0 = t; maxQueued = queued();
  }, 1000);
  setTimeout(() => { process.stdout.write(JSON.stringify({ role: 'leader', impl: 'ts', policy: o.policy, limit: o.limit, flushes: journal.flushes, series }) + '\n', () => process.exit(0)); }, o.secs * 1000);
}
main();
