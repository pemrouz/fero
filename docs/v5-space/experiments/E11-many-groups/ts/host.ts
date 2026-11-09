// E-11 host in TypeScript on E-10's port of etcd raft (../../E10-raft-port/port). Same design,
// protocol and measurements as ../go/main.go (read its header). One difference: the port has no
// binary codec for messages (etcd's Go code uses protobuf), so this file carries a small one
// (varints, below). Persist with fdatasyncSync, as the Go and Rust loops block on their fsync.
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { Config, RawNode, MemoryStorage, IsEmptyHardState, StateLeader, discardLogger, pb } from '../../E10-raft-port/port/src/index.ts';

const a: any = { id: 1, n: 10, mode: 'tick', tick: 100, elect: 10, ping: 500, rate: 0, hot: 1, size: 100, warm: 3000, dur: 10000, dir: '/tmp', fsync: 1, ports: '17001,17002,17003' };
for (const s of process.argv.slice(2)) { const i = s.indexOf('='); a[s.slice(0, i)] = s.slice(i + 1); }
for (const k of ['id', 'n', 'tick', 'elect', 'ping', 'rate', 'hot', 'size', 'warm', 'dur', 'fsync']) a[k] = Number(a[k]);
const ID: number = a.id, N: number = a.n, PORTS: number[] = String(a.ports).split(',').map(Number), NP = PORTS.length;
const QUIET = 0x80000000, WAKE = 0x40000000;
const wall = () => performance.timeOrigin + performance.now();
const tStart = performance.now();

// ---------------------------------------------------------------- message codec (varints)
let wb = Buffer.allocUnsafe(1 << 16), wp = 0;
function need(n: number) { if (wp + n > wb.length) { const nb = Buffer.allocUnsafe(Math.max(wb.length * 2, wp + n)); wb.copy(nb, 0, 0, wp); wb = nb; } }
function vu(v: number) { need(10); while (v >= 128) { wb[wp++] = (v % 128) | 128; v = Math.floor(v / 128); } wb[wp++] = v; }
function bytes(b: Uint8Array) { vu(b.length); need(b.length); wb.set(b, wp); wp += b.length; }
function encodeMsg(m: pb.Message) {
  if (m.Snapshot && m.Snapshot.Metadata && (m.Snapshot.Metadata.Index ?? 0) > 0) throw new Error('snapshots are not sent in E-11');
  need(2); wb[wp++] = m.Type ?? 0; wb[wp++] = (m.Reject ? 1 : 0) | (m.Context ? 2 : 0);
  vu(m.To ?? 0); vu(m.From ?? 0); vu(m.Term ?? 0); vu(m.LogTerm ?? 0); vu(m.Index ?? 0); vu(m.Commit ?? 0); vu(m.Vote ?? 0); vu(m.RejectHint ?? 0);
  vu(m.Entries.length);
  for (const e of m.Entries) { vu(e.Term ?? 0); vu(e.Index ?? 0); vu(e.Type ?? 0); bytes(e.Data ?? new Uint8Array(0)); }
  if (m.Context) bytes(m.Context);
}
let rb: Buffer, rp = 0;
function ru() { let v = 0, mul = 1, b; do { b = rb[rp++]; v += (b & 127) * mul; mul *= 128; } while (b & 128); return v; }
function rbytes() { const n = ru(); const s = rb.subarray(rp, rp + n); rp += n; return s; }
function decodeMsg(b: Buffer): pb.Message {
  rb = b; rp = 0; const type = rb[rp++], fl = rb[rp++];
  const m = new pb.Message({ Type: type, Reject: (fl & 1) !== 0, To: ru(), From: ru(), Term: ru(), LogTerm: ru(), Index: ru(), Commit: ru(), Vote: ru(), RejectHint: ru() });
  const ne = ru(); for (let i = 0; i < ne; i++) { const Term = ru(), Index = ru(), Type = ru(); const d = rbytes(); m.Entries.push(new pb.Entry({ Term, Index, Type, Data: d.length ? new Uint8Array(d) : undefined })); }
  if (fl & 2) m.Context = new Uint8Array(rbytes());
  return m;
}

// ---------------------------------------------------------------- histogram
const HB = 3200, hist = new Float64Array(HB); let histN = 0;
function hidx(us: number) { const v = Math.max(0, Math.floor(us)); if (v < 256) return v; const e = 31 - Math.clz32(v); const sh = e - 7; return 256 + (e - 8) * 128 + ((v >>> sh) - 128); }
function hval(i: number) { if (i < 256) return i + 0.5; const e = Math.floor((i - 256) / 128) + 8; const m = ((i - 256) % 128) + 128; const sh = e - 7; return (m << sh) + (1 << sh) / 2; }
function pct(p: number) { if (!histN) return -1; const want = Math.ceil(p * histN); let c = 0; for (let i = 0; i < HB; i++) { c += hist[i]; if (c >= want) return hval(i) / 1000; } return -1; }

// ---------------------------------------------------------------- groups
type G = { rn: RawNode; st: MemoryStorage; quiet: boolean; active: boolean; idle: number; proposed: boolean; dirty: boolean };
const voters = Array.from({ length: NP }, (_, i) => i + 1);
const groups: G[] = [];
for (let g = 0; g < N; g++) {
  const st = new MemoryStorage();
  st.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: new pb.ConfState({ Voters: voters }) }) }));
  const rn = new RawNode(new Config({ ID, ElectionTick: a.elect, HeartbeatTick: 1, Storage: st, Applied: 1, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger }));
  groups.push({ rn, st, quiet: false, active: true, idle: 0, proposed: false, dirty: false });
}
let active: number[] = groups.map((_, i) => i);
let dirty: number[] = [];
const mark = (g: number) => { const gr = groups[g]; if (!gr.dirty) { gr.dirty = true; dirty.push(g); } schedule(); };
function wake(g: number) { const gr = groups[g]; if (gr.quiet) { gr.quiet = false; gr.idle = 0; if (!gr.active) { gr.active = true; active.push(g); } } }

// ---------------------------------------------------------------- journal and links
fs.mkdirSync(a.dir, { recursive: true });
const jfd = fs.openSync(`${a.dir}/journal-${ID}`, 'w');
const peers: (net.Socket | null)[] = Array(NP).fill(null);
const out: Buffer[][] = Array.from({ length: NP }, () => []);
const outCount = new Int32Array(NP); const lastSent = new Float64Array(NP);
let measuring = false, wsWall = 0;
let frames = 0, msgs = 0, bytesOut = 0, fsyncs = 0, proposals = 0;

function queue(p: number, g: number, data: Uint8Array) {
  const h = Buffer.allocUnsafe(8); h.writeUInt32LE(g >>> 0, 0); h.writeUInt32LE(data.length, 4);
  out[p].push(h); if (data.length) out[p].push(Buffer.from(data.buffer, data.byteOffset, data.length)); outCount[p]++;
}
function flush(p: number, ping: boolean) {
  let n = 4; for (const b of out[p]) n += b.length;
  const hdr = Buffer.allocUnsafe(8); hdr.writeUInt32LE(ping ? 4 : n, 0); hdr.writeUInt32LE(ping ? 0 : outCount[p], 4);
  const frame = ping ? hdr : Buffer.concat([hdr, ...out[p]]);
  peers[p]!.write(frame);
  if (measuring) { frames++; msgs += outCount[p]; bytesOut += frame.length; }
  lastSent[p] = performance.now(); out[p] = []; outCount[p] = 0;
}
function onFrame(body: Buffer) {
  const cnt = body.readUInt32LE(0); let off = 4;
  for (let i = 0; i < cnt; i++) {
    const gw = body.readUInt32LE(off), l = body.readUInt32LE(off + 4); const d = body.subarray(off + 8, off + 8 + l); off += 8 + l;
    if (gw & QUIET) {
      const g = (gw & ~QUIET) >>> 0; const c = Number(d.readBigUInt64LE(0));
      if (groups[g].rn.raft.raftLog.committed >= c) groups[g].quiet = true;
      else { const lead = groups[g].rn.raft.lead; if (lead) queue(lead - 1, (g | WAKE) >>> 0, new Uint8Array(0)); schedule(); }
      continue;
    }
    if (gw & WAKE) { const g = (gw & ~WAKE) >>> 0; wake(g); mark(g); continue; }
    const g = gw; const m = decodeMsg(d); const t = m.Type;
    if (t !== pb.MsgHeartbeatResp && t !== pb.MsgAppResp) wake(g);
    groups[g].rn.Step(m); mark(g);
  }
}
function reader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= 4) { const n = buf.readUInt32LE(off); if (buf.length - off - 4 < n) break; onFrame(buf.subarray(off + 4, off + 4 + n)); off += 4 + n; }
    buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off);
  });
}

// ---------------------------------------------------------------- the loop
let scheduled = false;
function schedule() { if (!scheduled) { scheduled = true; setImmediate(processReady); } }
function apply(ents: pb.Entry[]) {
  const now = wall();
  for (const e of ents) {
    const d = e.Data;
    if ((e.Type ?? 0) === pb.EntryNormal && d && d.length >= 9 && d[0] === ID) {
      const at = Buffer.from(d.buffer, d.byteOffset, d.length).readDoubleLE(1);
      if (measuring && at >= wsWall) { hist[hidx((now - at) * 1000)]++; histN++; }
    }
  }
}
function processReady() {
  scheduled = false;
  for (let pass = 0; pass < 4 && dirty.length; pass++) {
    const list = dirty; dirty = [];
    const rds: [number, any][] = []; wp = 0;
    for (const g of list) {
      const gr = groups[g]; gr.dirty = false;
      if (!gr.rn.HasReady()) continue;
      const rd = gr.rn.Ready(); rds.push([g, rd]);
      if (!IsEmptyHardState(rd.HardState)) { gr.st.SetHardState(rd.HardState!); vu(g); vu(rd.HardState!.Term ?? 0); vu(rd.HardState!.Vote ?? 0); vu(rd.HardState!.Commit ?? 0); }
      if (rd.Entries.length) { gr.st.Append(rd.Entries); for (const e of rd.Entries) { vu(g); vu(e.Term ?? 0); vu(e.Index ?? 0); bytes(e.Data ?? new Uint8Array(0)); } }
    }
    if (wp > 0) { fs.writeSync(jfd, wb, 0, wp); if (a.fsync) { fs.fdatasyncSync(jfd); if (measuring) fsyncs++; } }
    for (const [g, rd] of rds) for (const m of rd.Messages) { wp = 0; encodeMsg(m); queue(m.To - 1, g, Buffer.from(wb.subarray(0, wp))); }
    for (let p = 0; p < NP; p++) if (outCount[p] > 0) flush(p, false);
    for (const [g, rd] of rds) { apply(rd.CommittedEntries); groups[g].rn.Advance(rd); if (groups[g].rn.HasReady()) { const gr = groups[g]; if (!gr.dirty) { gr.dirty = true; dirty.push(g); } } }
  }
  if (dirty.length) schedule();
}
function tick() {
  const list = active; active = []; const keep: number[] = [];
  for (const g of list) {
    const gr = groups[g];
    if (gr.quiet) { gr.active = false; continue; }
    if (a.mode === 'quiet' && gr.rn.raft.state === StateLeader) {
      const commit = gr.rn.raft.raftLog.committed; let matched = true;
      for (const pr of gr.rn.raft.trk.Progress.values()) if (pr.Match !== commit) { matched = false; break; }
      if (matched && !gr.proposed) gr.idle++; else gr.idle = 0;
      gr.proposed = false;
      if (gr.idle >= 2) {
        gr.quiet = true; gr.active = false;
        const cb = Buffer.allocUnsafe(8); cb.writeBigUInt64LE(BigInt(commit));
        for (let p = 1; p <= NP; p++) if (p !== ID) queue(p - 1, (g | QUIET) >>> 0, cb);
        continue;
      }
    }
    gr.rn.Tick(); mark(g); keep.push(g);
  }
  for (const g of active) keep.push(g); active = keep;
  const now = performance.now();
  for (let p = 0; p < NP; p++) if (p !== ID - 1 && outCount[p] === 0 && now - lastSent[p] >= a.ping) flush(p, true);
  schedule();
}

// ---------------------------------------------------------------- start
let started = false, t0 = 0, ws = 0, we = 0, made = 0, genStart = 0, genStartWall = 0, ledHot: number[] = [];
const hotN = Math.max(1, Math.ceil(N * a.hot));
let rng = 0x9e3779b9 | 0;
function gen() {
  if (!started || !ledHot.length) return;
  const now = performance.now(); if (now >= we) return;
  const myRate = a.rate * ledHot.length / hotN; const due = Math.floor((now - genStart) * myRate / 1000);
  while (made < due) {
    rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
    const g = ledHot[Math.floor(((rng >>> 0) / 4294967296) * ledHot.length)];
    const data = Buffer.alloc(a.size); data[0] = ID; data.writeDoubleLE(genStartWall + made * 1000 / myRate, 1);
    wake(g); groups[g].proposed = true;
    if (groups[g].rn.Propose(new Uint8Array(data.buffer, data.byteOffset, data.length)) === null && measuring) proposals++;
    mark(g); made++;
  }
}
let cpu0: NodeJS.CpuUsage;
function windowCheck() {
  if (!started) return;
  const now = performance.now();
  if (!measuring && !cpu0) { measuring = true; cpu0 = process.cpuUsage(); return; }
  if (measuring && now >= we - 5) {
    measuring = false; const c = process.cpuUsage(cpu0); const win = a.dur / 1000;
    let leaders = 0, awake = 0; for (const gr of groups) { if (gr.rn.raft.state === StateLeader) leaders++; if (!gr.quiet) awake++; }
    const rss = process.memoryUsage().rss; (globalThis as any).gc?.(); const heap = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({ impl: 'ts', id: ID, n: N, mode: a.mode, tick: a.tick, elect: a.elect, rate: a.rate, hot: a.hot, leaders, awake_end: awake, ready_ms: readyMs,
      cores: (c.user + c.system) / 1e6 / win, frames_s: frames / win, msgs_s: msgs / win, bytes_s: bytesOut / win, fsyncs_s: fsyncs / win, proposals_s: proposals / win, commits_s: histN / win,
      p50: pct(0.5), p99: pct(0.99), p999: pct(0.999), max: pct(1), rss_kb: Math.round(rss / 1024), heap_kb: Math.round(heap / 1024), loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim() }));
    setTimeout(() => process.exit(0), 1500);
  }
}
let readyMs = 0, ready = false;
function readyCheck() { if (!ready && groups.every((gr) => gr.rn.raft.lead !== 0)) { ready = true; readyMs = performance.now() - tStart; console.log('ready'); } }

async function main() {
  const server = net.createServer({ noDelay: true }, (s) => {
    s.setNoDelay(true);
    s.once('readable', function first() {
      const h = s.read(4); if (!h) { s.once('readable', first); return; }
      const p = h.readUInt32LE(0) - 1; peers[p] = s; lastSent[p] = performance.now(); reader(s); s.resume();
    });
  });
  await new Promise<void>((r) => server.listen(PORTS[ID - 1], '127.0.0.1', () => r()));
  for (let p = ID + 1; p <= NP; p++) {
    const s: net.Socket = await new Promise((res) => { const go = () => { const c = net.connect(PORTS[p - 1], '127.0.0.1'); c.once('connect', () => res(c)); c.once('error', () => setTimeout(go, 20)); }; go(); });
    s.setNoDelay(true); const h = Buffer.allocUnsafe(4); h.writeUInt32LE(ID); s.write(h); peers[p - 1] = s; lastSent[p - 1] = performance.now(); reader(s);
  }
  while (peers.filter((x, i) => x || i === ID - 1).length < NP) await new Promise((r) => setTimeout(r, 10));
  for (let g = 0; g < N; g++) if (g % NP === ID - 1) { groups[g].rn.Campaign(); mark(g); }
  setInterval(tick, a.tick);
  if (a.rate > 0) setInterval(gen, 1);
  const rc = setInterval(() => { readyCheck(); if (ready) clearInterval(rc); }, 200);
  readline.createInterface({ input: process.stdin }).on('line', (l) => {
    if (l.startsWith('go')) {
      started = true; t0 = performance.now(); ws = t0 + a.warm; we = ws + a.dur; wsWall = wall() + a.warm;
      genStart = performance.now(); genStartWall = wall(); made = 0;
      ledHot = []; for (let g = 0; g < Math.min(hotN, N); g++) if (groups[g].rn.raft.state === StateLeader) ledHot.push(g);
      setTimeout(windowCheck, a.warm); setTimeout(windowCheck, a.warm + a.dur);
    }
  });
}
main();
