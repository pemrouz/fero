// E-26 and E-36: group lifecycle on E-10's TypeScript port of etcd raft. This is E-11's TS host
// (../E11-many-groups/ts/host.ts: the same Raft loop, journal with one fdatasync per round, frames, quiet
// groups and link pings), with groups that come and go:
//   create  a new group on all three processes (followers make it when its first message arrives), process 1
//           campaigns at once and writes one entry; "ok" when that entry is applied on process 1.
//   meta    one ~200 B row committed in group 0 (the `#meta` group), as creating a resource writes its catalog row.
//   sleep   a quiet group (fully committed, matched) is written to this process's dormant store (one 24-byte
//           record: group, term, vote, commit, last index, last term; one append and one fdatasync per command)
//           and dropped from memory. A dormant group costs one Map entry.
//   wake    process 1 loads the group from its store and campaigns at once; a follower loads it when the first
//           message for it arrives. "ok" when one new entry in each woken group is applied on process 1.
//   dormant=N at start: N dormant records written to the store (groups that slept earlier), for the scale runs.
//   boot=a-b at start: once links are up, process 1 wakes groups a..b from the store (a project of b-a+1
//           resources woken by a cold start of its three processes).
// Commands come on stdin (process 1 for create, meta, wake; all three for sleep, mem, stats).
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { Config, RawNode, MemoryStorage, IsEmptyHardState, StateLeader, discardLogger, pb } from '../E10-raft-port/port/src/index.ts';

const a: any = { dormant: 0, boot: '', max: 200000, id: 1, n: 10, mode: 'tick', tick: 100, elect: 10, ping: 500, rate: 0, hot: 1, size: 100, warm: 3000, dur: 10000, dir: '/tmp', fsync: 1, ports: '17001,17002,17003' };
for (const s of process.argv.slice(2)) { const i = s.indexOf('='); a[s.slice(0, i)] = s.slice(i + 1); }
for (const k of ['dormant', 'max', 'id', 'n', 'tick', 'elect', 'ping', 'rate', 'hot', 'size', 'warm', 'dur', 'fsync']) a[k] = Number(a[k]);
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
const groups: (G | null)[] = new Array(a.max).fill(null);
let active: number[] = [];
let dirty: number[] = [];
let awakeCount = 0;
// a group from (index, term, hard state); a fresh group starts from the same snapshot at index 1 everywhere, as in E-11
function makeGroup(g: number, idx = 1, term = 1, hs: { Term: number; Vote: number; Commit: number } | null = null) {
  const st = new MemoryStorage();
  st.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: idx, Term: term, ConfState: new pb.ConfState({ Voters: voters }) }) }));
  if (hs) st.SetHardState(new pb.HardState(hs));
  const rn = new RawNode(new Config({ ID, ElectionTick: a.elect, HeartbeatTick: 1, Storage: st, Applied: idx, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger }));
  groups[g] = { rn, st, quiet: false, active: true, idle: 0, proposed: false, dirty: false };
  active.push(g); awakeCount++;
  return groups[g]!;
}
for (let g = 0; g < N; g++) makeGroup(g);

// ---------------------------------------------------------------- the dormant store: one append-only file per process
const dormant = new Map<number, number>();   // group -> record offset
fs.mkdirSync(a.dir, { recursive: true });
const dpath = `${a.dir}/dormant-${ID}`;
const keepStore = !!a.boot;
const dfd = fs.openSync(dpath, keepStore ? 'r+' : 'w+');
let dEnd = keepStore ? fs.fstatSync(dfd).size : 0;
const REC = 24;
if (keepStore) { const b = Buffer.alloc(dEnd); fs.readSync(dfd, b, 0, dEnd, 0); for (let o = 0; o + REC <= dEnd; o += REC) dormant.set(b.readUInt32LE(o), o); }
if (a.dormant > 0) {   // N groups that slept earlier: ids from 100000 up
  const b = Buffer.alloc(a.dormant * REC);
  for (let i = 0; i < a.dormant; i++) { const o = i * REC; b.writeUInt32LE(100000 + i, o); b.writeUInt32LE(2, o + 4); b.writeUInt32LE(1, o + 8); b.writeUInt32LE(3, o + 12); b.writeUInt32LE(3, o + 16); b.writeUInt32LE(2, o + 20); dormant.set(100000 + i, dEnd + o); }
  fs.writeSync(dfd, b, 0, b.length, dEnd); fs.fdatasyncSync(dfd); dEnd += b.length;
}
function sleepGroups(list: number[]) {
  const b = Buffer.alloc(list.length * REC); let n = 0; const done: number[] = [];
  for (const g of list) {
    const gr = groups[g]; if (!gr) continue;
    const log = gr.rn.raft.raftLog; const last = log.lastIndex(); const [lt] = log.term(last);
    if (log.committed !== last) continue;   // not fully committed: cannot sleep yet
    const o = n * REC; b.writeUInt32LE(g, o); b.writeUInt32LE(gr.rn.raft.Term, o + 4); b.writeUInt32LE(gr.rn.raft.Vote, o + 8); b.writeUInt32LE(log.committed, o + 12); b.writeUInt32LE(last, o + 16); b.writeUInt32LE(lt, o + 20);
    dormant.set(g, dEnd + o); n++; done.push(g);
  }
  if (n) { fs.writeSync(dfd, b, 0, n * REC, dEnd); fs.fdatasyncSync(dfd); dEnd += n * REC; }
  for (const g of done) { groups[g] = null; awakeCount--; }
  active = active.filter((g) => groups[g] !== null);
  dirty = dirty.filter((g) => groups[g] !== null);
  return done.length;
}
const rbuf = Buffer.alloc(REC);
function wakeFromStore(g: number): G | null {
  const o = dormant.get(g); if (o === undefined) return null;
  fs.readSync(dfd, rbuf, 0, REC, o);
  dormant.delete(g);
  return makeGroup(g, rbuf.readUInt32LE(16), rbuf.readUInt32LE(20), { Term: rbuf.readUInt32LE(4), Vote: rbuf.readUInt32LE(8), Commit: rbuf.readUInt32LE(12) });
}
// a message for a group this process does not hold: wake it from the store, or create it fresh
function ensure(g: number): G { return groups[g] ?? wakeFromStore(g) ?? makeGroup(g); }
const mark = (g: number) => { const gr = groups[g]; if (!gr) return; if (!gr.dirty) { gr.dirty = true; dirty.push(g); } schedule(); };
function wake(g: number) { const gr = groups[g]; if (!gr) return; if (gr.quiet) { gr.quiet = false; gr.idle = 0; if (!gr.active) { gr.active = true; active.push(g); } } }

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
  sFrames++; sMsgs += outCount[p];
  lastSent[p] = performance.now(); out[p] = []; outCount[p] = 0;
}
function onFrame(body: Buffer) {
  const cnt = body.readUInt32LE(0); let off = 4;
  for (let i = 0; i < cnt; i++) {
    const gw = body.readUInt32LE(off), l = body.readUInt32LE(off + 4); const d = body.subarray(off + 8, off + 8 + l); off += 8 + l;
    if (gw & QUIET) {
      const g = (gw & ~QUIET) >>> 0; const c = Number(d.readBigUInt64LE(0));
      const gq = groups[g]; if (!gq) continue;
      if (gq.rn.raft.raftLog.committed >= c) gq.quiet = true;
      else { const lead = gq.rn.raft.lead; if (lead) queue(lead - 1, (g | WAKE) >>> 0, new Uint8Array(0)); schedule(); }
      continue;
    }
    if (gw & WAKE) { const g = (gw & ~WAKE) >>> 0; wake(g); mark(g); continue; }
    const g = gw; const m = decodeMsg(d); const t = m.Type;
    if (t !== pb.MsgHeartbeatResp && t !== pb.MsgAppResp) wake(g);
    ensure(g).rn.Step(m); mark(g);
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

// ---------------------------------------------------------------- lifecycle operations (process 1)
let op: { name: string; t0: number; waiting: Set<number>; first: Set<number>; extra: any } | null = null;
function startOp(name: string, list: number[], extra: any = {}) { op = { name, t0: performance.now(), waiting: new Set(list), first: new Set(list), extra }; }
function finishOp() { if (!op) return; console.log(JSON.stringify({ ok: op.name, n: op.extra.n ?? op.first.size, ms: +(performance.now() - op.t0).toFixed(3), ...op.extra.report })); op = null; }
// each group of the op: once process 1 leads it, write one 8-byte marker entry
function firstWrites() {
  if (!op || ID !== 1) return;
  for (const g of [...op.first]) {
    const gr = groups[g]; if (!gr || gr.rn.raft.state !== StateLeader) continue;
    const d = Buffer.alloc(8); d[0] = 0xe0; d.writeUInt32LE(g, 4);
    gr.proposed = true; gr.rn.Propose(new Uint8Array(d.buffer, d.byteOffset, 8)); mark(g); op.first.delete(g);
  }
}
function onMarker(g: number) { if (op && op.waiting.delete(g) && op.waiting.size === 0) finishOp(); }
function command(l: string) {
  const [cmd, arg] = l.trim().split(/\s+/);
  const list = arg ? arg.split(',').flatMap((x) => { const [lo, hi] = x.split('-').map(Number); return hi ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo]; }) : [];
  if (cmd === 'create' || cmd === 'wake') {
    startOp(cmd, list);
    for (const g of list) { const gr = cmd === 'create' ? makeGroup(g) : (wakeFromStore(g) ?? groups[g]); if (!gr) { console.log(JSON.stringify({ error: 'no group ' + g })); continue; } gr.rn.Campaign(); mark(g); }
  } else if (cmd === 'meta') {
    // one catalog row in group 0, led by process 1: the "ok" comes when it is applied here
    startOp('meta', [0]); const gr = groups[0]!; const d = Buffer.alloc(8); d[0] = 0xe0; d.writeUInt32LE(0, 4);
    const row = Buffer.concat([d, Buffer.alloc(192, 0x6d)]);   // 200 B: a marker plus a catalog row's worth of bytes
    wake(0); gr.proposed = true; gr.rn.Propose(new Uint8Array(row.buffer, row.byteOffset, row.length)); mark(0); op!.first.delete(0);
  } else if (cmd === 'sleep') {
    const t = performance.now(); const n = sleepGroups(list); console.log(JSON.stringify({ ok: 'sleep', id: ID, n, ms: +(performance.now() - t).toFixed(3) }));
  } else if (cmd === 'mem') {
    const rss = process.memoryUsage().rss; (globalThis as any).gc?.();
    console.log(JSON.stringify({ ok: 'mem', id: ID, awake: awakeCount, dormant: dormant.size, rss_kb: Math.round(rss / 1024), heap_kb: Math.round(process.memoryUsage().heapUsed / 1024), store_bytes: dEnd }));
  } else if (cmd === 'stats') {
    const now = performance.now(); const sec = (now - statT) / 1000; let awakeNotQuiet = 0; for (const gr of groups) if (gr && !gr.quiet) awakeNotQuiet++;
    console.log(JSON.stringify({ ok: 'stats', id: ID, sec: +sec.toFixed(2), frames_s: sFrames / sec, msgs_s: sMsgs / sec, awake_not_quiet: awakeNotQuiet, loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim() }));
    statT = now; sFrames = 0; sMsgs = 0;
  }
}
let statT = performance.now(), sFrames = 0, sMsgs = 0;

// ---------------------------------------------------------------- the loop
let scheduled = false;
function schedule() { if (!scheduled) { scheduled = true; setImmediate(processReady); } }
function apply(ents: pb.Entry[]) {
  const now = wall();
  for (const e of ents) {
    const d = e.Data;
    if ((e.Type ?? 0) === pb.EntryNormal && d && d.length >= 8 && d[0] === 0xe0 && ID === 1) { onMarker(Buffer.from(d.buffer, d.byteOffset, d.length).readUInt32LE(4)); continue; }
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
      const gr = groups[g]; if (!gr) continue; gr.dirty = false;
      if (!gr.rn.HasReady()) continue;
      const rd = gr.rn.Ready(); rds.push([g, rd]);
      if (!IsEmptyHardState(rd.HardState)) { gr.st.SetHardState(rd.HardState!); vu(g); vu(rd.HardState!.Term ?? 0); vu(rd.HardState!.Vote ?? 0); vu(rd.HardState!.Commit ?? 0); }
      if (rd.Entries.length) { gr.st.Append(rd.Entries); for (const e of rd.Entries) { vu(g); vu(e.Term ?? 0); vu(e.Index ?? 0); bytes(e.Data ?? new Uint8Array(0)); } }
    }
    if (wp > 0) { fs.writeSync(jfd, wb, 0, wp); if (a.fsync) { fs.fdatasyncSync(jfd); if (measuring) fsyncs++; } }
    for (const [g, rd] of rds) for (const m of rd.Messages) { wp = 0; encodeMsg(m); queue(m.To - 1, g, Buffer.from(wb.subarray(0, wp))); }
    for (let p = 0; p < NP; p++) if (outCount[p] > 0) flush(p, false);
    for (const [g, rd] of rds) { apply(rd.CommittedEntries); const gr = groups[g]!; gr.rn.Advance(rd); if (gr.rn.HasReady()) { if (!gr.dirty) { gr.dirty = true; dirty.push(g); } } }
    firstWrites();
  }
  // frames queued outside the Ready loop (quiet notices from tick, wake requests from onFrame) go out even when no group was dirty
  for (let p = 0; p < NP; p++) if (outCount[p] > 0) flush(p, false);
  if (dirty.length) schedule();
}
function tick() {
  const list = active; active = []; const keep: number[] = [];
  for (const g of list) {
    const gr = groups[g]; if (!gr) continue;
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
  const myRate = a.rate * ledHot.length / hotN; const due = Math.floor((now - genStart) * myRate / 1000) + 1; // writes whose ideal arrival is not later than now
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
    let leaders = 0, awake = 0; for (const gr of groups) { if (!gr) continue; if (gr.rn.raft.state === StateLeader) leaders++; if (!gr.quiet) awake++; }
    const rss = process.memoryUsage().rss; (globalThis as any).gc?.(); const heap = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({ impl: 'ts', id: ID, n: N, mode: a.mode, tick: a.tick, elect: a.elect, rate: a.rate, hot: a.hot, leaders, awake_end: awake, ready_ms: readyMs,
      cores: (c.user + c.system) / 1e6 / win, frames_s: frames / win, msgs_s: msgs / win, bytes_s: bytesOut / win, fsyncs_s: fsyncs / win, proposals_s: proposals / win, commits_s: histN / win,
      p50: pct(0.5), p99: pct(0.99), p999: pct(0.999), max: pct(1), rss_kb: Math.round(rss / 1024), heap_kb: Math.round(heap / 1024), loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim() }));
    setTimeout(() => process.exit(0), 1500);
  }
}
let readyMs = 0, ready = false;
function readyCheck() { if (!ready && groups.every((gr) => !gr || gr.rn.raft.lead !== 0)) { ready = true; readyMs = performance.now() - tStart; console.log('ready'); } }

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
  const tBoot = performance.now();
  if (a.boot && ID === 1) {   // cold start of a project: wake its groups from the store and write once in each
    const [lo, hi] = String(a.boot).split('-').map(Number); const list = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    startOp('boot', list, { report: { since_process_start_ms: 0 } });
    op!.t0 = 0;   // performance.now() counts from process start
    for (const g of list) { const gr = wakeFromStore(g); if (gr) { gr.rn.Campaign(); mark(g); } }
  }
  for (let g = 0; g < N; g++) if (g % NP === ID - 1 && !a.boot) { groups[g]!.rn.Campaign(); mark(g); }
  setInterval(tick, a.tick);
  if (a.rate > 0) setInterval(gen, 1);
  const rc = setInterval(() => { readyCheck(); if (ready) clearInterval(rc); }, 200);
  readline.createInterface({ input: process.stdin }).on('line', (l) => {
    if (!l.startsWith('go')) { command(l); return; }
    if (l.startsWith('go')) {
      started = true; t0 = performance.now(); ws = t0 + a.warm; we = ws + a.dur; wsWall = wall() + a.warm;
      genStart = performance.now(); genStartWall = wall(); made = 0;
      ledHot = []; for (let g = 0; g < Math.min(hotN, N); g++) if (groups[g].rn.raft.state === StateLeader) ledHot.push(g);
      setTimeout(windowCheck, a.warm); setTimeout(windowCheck, a.warm + a.dur);
    }
  });
}
main();
