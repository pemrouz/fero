// E-25 (Node): the idle cost of a failure detector built on link pings.
// A member keeps one TCP link per peer, sends an 8-byte ping on each link every `ping` ms (E-11's frame:
// u32 length 4, u32 count 0), and every 100 ms checks that each link heard something in the last `suspect` ms.
// With `groups=N` it also holds N quiet Raft groups of E-10's TypeScript port (built, campaigned never, never
// ticked: what a quiet group costs in memory; E-11 measured that quiet groups add no CPU).
//
// Modes:
//   hub   listen on `port`; take whatever links arrive (a farm opens them); report after `warm` + `dur` ms
//   farm  open `links` links to `port` and ping on each (it stands in for 99 other members; not measured)
//   bare  one of `n` members with a listening socket and nothing else (Node's idle floor)
//   mesh  one of `n` members on ports base..base+n-1: dial every higher id, accept the lower ones (full mesh);
//         report like the hub. Run n of these for part (c).
// Output: one JSON line: CPU (user+system) as a share of one core over the window, RSS, heap, links, frames.
import net from 'node:net';
import fs from 'node:fs';

const a = { mode: 'hub', port: 18500, base: 18600, n: 100, id: 1, links: 99, ping: 500, suspect: 2000, groups: 0, warm: 5000, dur: 30000 };
for (const s of process.argv.slice(2)) { const i = s.indexOf('='); const k = s.slice(0, i), v = s.slice(i + 1); a[k] = k === 'mode' ? v : Number(v); }

const links = [];   // { sock, last, sent }
let framesOut = 0, framesIn = 0, suspects = 0, measuring = false;
const PING = Buffer.from([4, 0, 0, 0, 0, 0, 0, 0]);

function attach(sock) {
  sock.setNoDelay(true);
  const L = { sock, last: performance.now() };
  links.push(L);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    L.last = performance.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= 4) { const n = buf.readUInt32LE(off); if (buf.length - off - 4 < n) break; off += 4 + n; if (measuring) framesIn++; }
    buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off);
  });
  sock.on('error', () => {});
}

// one timer for all links: every ping/4 ms, send a ping on each link that has sent nothing for `ping` ms
// (spreads the pings out, as a real member would, instead of 99 writes in one burst)
let lastSent = new Map();
function pinger() {
  const now = performance.now();
  for (const L of links) {
    const t = lastSent.get(L) ?? 0;
    if (now - t >= a.ping) { L.sock.write(PING); lastSent.set(L, now); if (measuring) framesOut++; }
  }
}
function detector() {
  const now = performance.now();
  for (const L of links) if (now - L.last > a.suspect) { if (measuring) suspects++; L.last = now; }
}

async function groups(n) {
  if (!n) return [];
  const { Config, RawNode, MemoryStorage, discardLogger, pb } = await import('../../E10-raft-port/port/src/index.ts');
  const gs = [];
  for (let g = 0; g < n; g++) {
    const st = new MemoryStorage();
    st.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: new pb.ConfState({ Voters: [1, 2, 3] }) }) }));
    gs.push(new RawNode(new Config({ ID: 1, ElectionTick: 4, HeartbeatTick: 1, Storage: st, Applied: 1, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger })));
  }
  return gs;
}

function report(extra) {
  const rss0 = process.memoryUsage().rss;
  globalThis.gc?.();
  console.log(JSON.stringify({ impl: 'node', node: process.version, ...extra, rss_kb: Math.round(rss0 / 1024), heap_kb: Math.round(process.memoryUsage().heapUsed / 1024) }));
}

async function main() {
  const held = await groups(a.groups);
  if (a.mode === 'farm') {
    for (let i = 0; i < a.links; i++) {
      const s = await new Promise((res) => { const go = () => { const c = net.connect(a.port, '127.0.0.1'); c.once('connect', () => res(c)); c.once('error', () => setTimeout(go, 20)); }; go(); });
      attach(s);
    }
    setInterval(pinger, a.ping / 4);
    console.log('ready');
    return;
  }
  if (a.mode === 'bare') {   // a member with no links and no timers: Node's own idle floor
    net.createServer({ noDelay: true }, attach).listen(a.base + a.id - 1, '127.0.0.1', () => console.log('ready'));
    return;
  }
  if (a.mode === 'hub') {
    net.createServer({ noDelay: true }, attach).listen(a.port, '127.0.0.1', () => console.log('listening'));
    while (links.length < a.links) await new Promise((r) => setTimeout(r, 20));
  } else {   // mesh
    net.createServer({ noDelay: true }, attach).listen(a.base + a.id - 1, '127.0.0.1');
    for (let p = a.id + 1; p <= a.n; p++) {
      const s = await new Promise((res) => { const go = () => { const c = net.connect(a.base + p - 1, '127.0.0.1'); c.once('connect', () => res(c)); c.once('error', () => setTimeout(go, 50)); }; go(); });
      attach(s);
    }
    while (links.length < a.n - 1) await new Promise((r) => setTimeout(r, 50));
  }
  setInterval(pinger, a.ping / 4);
  setInterval(detector, 100);
  console.log('ready');
  await new Promise((r) => setTimeout(r, a.warm));
  measuring = true; const c0 = process.cpuUsage(), t0 = performance.now();
  await new Promise((r) => setTimeout(r, a.dur));
  measuring = false; const c = process.cpuUsage(c0), sec = (performance.now() - t0) / 1000;
  report({ mode: a.mode, id: a.id, links: links.length, groups: held.length, ping_ms: a.ping, window_s: +sec.toFixed(2), cores: (c.user + c.system) / 1e6 / sec,
    frames_out_s: framesOut / sec, frames_in_s: framesIn / sec, suspects, loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim() });
  if (a.mode === 'hub') process.exit(0);
  // mesh members stay up until killed, so the others keep their links during their own windows
}
main();
