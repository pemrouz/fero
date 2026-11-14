// E-53 write load: one client process with a link to each member's client port (host-patch.mjs patch 8).
// Open loop: each loaded group gets `rate` writes a second at fixed times (phases spread evenly), whatever came
// back, so a slow answer never holds the next write. Each write goes to the member the client thinks leads its
// group (at first the preferred one, g % 3 + 1), and a `moved` answer sends it again to the leader the member
// named (or to the next member, 2 ms later, if it named none). A write not answered in `timeout` ms goes to the
// next member (counted). Latency = the committed answer's arrival - the write's planned time, so a write that
// waited, moved or went again carries all of it.
// stdin: `start` (begin), `mark` (prints the wall time), `stop` (stop writing, wait up to 3 s for answers, save
// the records to out= as Float64 [planned wall ms, latency ms, group, tries, waited] and print a JSON summary).
// waited (added after the skeptic's check) is 1 when a member said the write waited at its leader for a transfer
// (host patch 16: 0x100 in the reply's last field; the leader's id stays in the low byte).
// Usage: node client.mjs cports=a,b,c groups=1,5,9 rate=10 out=/path/records.f64 [timeout=3000]
import net from 'node:net';
import fs from 'node:fs';
import readline from 'node:readline';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const CPORTS = String(args.cports).split(',').map(Number), NP = CPORTS.length;
const GROUPS = String(args.groups).split(',').map(Number), L = GROUPS.length;
const RATE = Number(args.rate || 10), PERIOD = 1000 / RATE, TIMEOUT = Number(args.timeout || 3000), OUT = args.out;
const wall = () => performance.timeOrigin + performance.now();

const lg = new Map(GROUPS.map((g) => [g, g % NP]));   // leader guess: member index
const infl = new Map();   // seq -> [g, planned, tries, lastSend, member, waited]
let seq = 0, recs = new Float64Array(1 << 20), nrec = 0, moved = 0, movedNoHint = 0, timeouts = 0, sent = 0;
const W = 5;   // fields per record
function record(planned, lat, g, tries, waited) {
  if (nrec * W + W > recs.length) { const n = new Float64Array(recs.length * 2); n.set(recs); recs = n; }
  recs[nrec * W] = planned; recs[nrec * W + 1] = lat; recs[nrec * W + 2] = g; recs[nrec * W + 3] = tries; recs[nrec * W + 4] = waited; nrec++;
}
const socks = [];
const msg = Buffer.alloc(13);
function send(s, m) { const r = infl.get(s); r[3] = wall(); r[4] = m; msg[0] = 1; msg.writeUInt32LE(r[0], 1); msg.writeUInt32LE(s, 5); msg.writeUInt32LE(0, 9); socks[m].write(Buffer.from(msg)); sent++; }
function onReply(type, g, s, x, from) {
  const r = infl.get(s); if (!r) return;
  if (x & 0x100) r[5] = 1; x &= 0xff;   // host patch 16
  if (type === 2) { infl.delete(s); record(r[1], wall() - r[1], g, r[2], r[5]); return; }
  // moved: x is the leader the member knows (1..3), or 0
  moved++; r[2]++;
  if (x >= 1 && x <= NP && x - 1 !== from) { lg.set(g, x - 1); send(s, x - 1); }
  else { movedNoHint++; const m = (from + 1) % NP; lg.set(g, m); setTimeout(() => { if (infl.has(s)) send(s, lg.get(g)); }, 2); }
}
async function connect(i) {
  return new Promise((res) => {
    const go = () => { const c = net.connect(CPORTS[i], '127.0.0.1'); c.once('connect', () => { c.setNoDelay(true); res(c); }); c.once('error', () => setTimeout(go, 50)); };
    go();
  }).then((c) => {
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    c.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; let off = 0;
      while (buf.length - off >= 13) { onReply(buf[off], buf.readUInt32LE(off + 1), buf.readUInt32LE(off + 5), buf.readUInt32LE(off + 9), i); off += 13; }
      buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off);
    });
    socks[i] = c;
  });
}
await Promise.all(CPORTS.map((_, i) => connect(i)));

let next = null, gen = null, stopping = false;
function tick() {
  const now = wall();
  for (const c of socks) c.cork();
  for (let i = 0; i < L; i++) while (next[i] <= now) { const g = GROUPS[i]; seq = (seq + 1) >>> 0; infl.set(seq, [g, next[i], 1, 0, 0, 0]); send(seq, lg.get(g)); next[i] += PERIOD; }
  for (const c of socks) c.uncork();
}
setInterval(() => {   // resend writes not answered in TIMEOUT ms, to the next member
  const now = wall();
  for (const [s, r] of infl) if (now - r[3] > TIMEOUT) { timeouts++; r[2]++; const m = (r[4] + 1) % NP; lg.set(r[0], m); send(s, m); }
}, 100);
console.log(JSON.stringify({ ok: 'client-ready', groups: L, rate: RATE }));
readline.createInterface({ input: process.stdin }).on('line', async (l) => {
  const cmd = l.trim();
  if (cmd === 'start') {
    const t0 = wall() + 5; next = GROUPS.map((_, i) => t0 + (i / L) * PERIOD);
    gen = setInterval(tick, 1);
    console.log(JSON.stringify({ ok: 'started', t0 }));
  } else if (cmd === 'mark') console.log(JSON.stringify({ ok: 'mark', t: wall() }));
  else if (cmd === 'stop' && !stopping) {
    stopping = true; clearInterval(gen); const ts = wall();
    while (infl.size && wall() - ts < 3000) await new Promise((r) => setTimeout(r, 20));
    if (OUT) fs.writeFileSync(OUT, Buffer.from(recs.buffer, 0, nrec * W * 8));
    console.log(JSON.stringify({ ok: 'client', n: nrec, sent, left: infl.size, moved, moved_no_hint: movedNoHint, timeouts, stopped_at: ts }));
    setTimeout(() => process.exit(0), 100);
  }
});
