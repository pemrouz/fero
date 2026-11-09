// E-26 / E-36 driver: three processes of ./host.ts (E-11's TS host on E-10's port, with groups that are created,
// put to sleep and woken), 16 awake groups (group 0 is `#meta`), quiet mode (ticks 500 ms, election 4 ticks, link
// pings every 500 ms), and S dormant groups already in each process's store (S = 100, 10,000, 100,000).
// One run, per S:
//   20 x (meta, then create): a resource's catalog row in #meta, then its own new group's first write (MIN's create);
//                             meta alone is MIN-P's and LANE's create (the resource joins groups that exist)
//   idle window of 5 s:        frames and Raft messages per second per process with everything quiet
//   20 x wake of one group:    opening a cold resource whose group sleeps (MIN with dormant groups)
//   3 x wake of 20 groups:     a sleeping project of 20 resources woken in a live log tier (N `tier`, `pool`)
//   mem:                       RSS and heap with S dormant groups
//   3 x boot:                  a project's three processes start cold and wake its 20 groups (N `proc`: scale to zero)
// Usage (under $SP/bin/timing): node lifecycle.mjs [runs=3] [scales=100,10000,100000]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 3), SCALES = (args.scales || '100,10000,100000').split(',').map(Number);
const OUT = path.join(HERE, 'results', args.out || 'lifecycle.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length : 0;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function start(S, dir, ports, extra = []) {
  const ps = [], q = [[], [], []], waiters = [[], [], []];
  for (let i = 1; i <= 3; i++) {
    const p = spawn('node', ['--expose-gc', '--max-old-space-size=4096', path.join(HERE, 'host.ts'), `id=${i}`, 'mode=quiet', 'tick=500', 'elect=4', 'ping=500', 'rate=0',
      `dir=${dir}`, 'fsync=1', `ports=${ports}`, `max=${100000 + S + 1000}`, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); }); p.err = () => err;
    readline.createInterface({ input: p.stdout }).on('line', (l) => { const w = waiters[i - 1].shift(); if (w) w(l); else q[i - 1].push(l); });
    ps.push(p);
  }
  // next line from process i (0-based), with a timeout
  const next = (i, ms = 30000) => new Promise((res, rej) => { if (q[i].length) return res(q[i].shift()); const t = setTimeout(() => rej(new Error('timeout from ' + (i + 1) + ': ' + ps[i].err().slice(-2000))), ms); waiters[i].push((l) => { clearTimeout(t); res(l); }); });
  const send = (i, l) => ps[i].stdin.write(l + '\n');
  const ask = async (i, l) => { send(i, l); for (;;) { const r = await next(i); if (r.startsWith('{')) return JSON.parse(r); } };
  return { ps, next, send, ask, kill: () => { for (const p of ps) p.kill('SIGKILL'); } };
}
const until = async (c, i, word) => { for (;;) { const l = await c.next(i, 120000); if (l === word || l.includes(`"ok":"${word}"`)) return l; } };

async function run(S, r) {
  const tag = `S${S}`, dir = path.join(SP, 'e26', 'data');
  fs.rmSync(dir, { recursive: true, force: true });
  const base = 26000 + Math.floor(Math.random() * 1500) * 3, ports = [base, base + 1, base + 2].join(',');
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const rec = { exp: 'E-26/E-36', tag, S, run: r, loadavg: la };
  let c = start(S, dir, ports, ['n=16', `dormant=${S}`]);
  try {
    await Promise.all([0, 1, 2].map((i) => until(c, i, 'ready')));
    await sleep(3000);
    const meta = [], create = [];
    for (let k = 1; k <= 20; k++) { meta.push((await c.ask(0, 'meta')).ms); create.push((await c.ask(0, `create ${100 + k}`)).ms); await sleep(20); }
    rec.meta_ms = { p50: med(meta), max: Math.max(...meta), all: meta };
    rec.create_group_ms = { p50: med(create), max: Math.max(...create), all: create };
    rec.create_min_ms = { p50: med(meta.map((m, k) => m + create[k])), max: Math.max(...meta.map((m, k) => m + create[k])) };
    await sleep(3000);
    for (let i = 0; i < 3; i++) await c.ask(i, 'stats');
    await sleep(5000);
    rec.idle = []; for (let i = 0; i < 3; i++) rec.idle.push(await c.ask(i, 'stats'));
    for (let i = 0; i < 3; i++) rec[`sleep${i + 1}`] = await c.ask(i, 'sleep 101-120');
    const wake1 = [];
    for (let k = 1; k <= 20; k++) { wake1.push((await c.ask(0, `wake ${100 + k}`)).ms); await sleep(20); }
    rec.wake1_ms = { p50: med(wake1), p90: pct(wake1, 0.9), max: Math.max(...wake1), all: wake1 };
    const wake20 = [];
    for (let k = 0; k < 3; k++) {
      await sleep(3000); for (let i = 0; i < 3; i++) await c.ask(i, 'sleep 101-120');
      wake20.push((await c.ask(0, 'wake 101-120')).ms);
    }
    rec.wake20_ms = wake20;
    rec.mem = []; for (let i = 0; i < 3; i++) rec.mem.push(await c.ask(i, 'mem'));
    await sleep(3000); for (let i = 0; i < 3; i++) await c.ask(i, 'sleep 101-120');
    c.kill(); await sleep(500);
    // cold boots of the project's three processes
    rec.boot = [];
    for (let b = 0; b < 3; b++) {
      const t0 = performance.now();
      c = start(S, dir, ports, ['n=0', 'boot=101-120']);
      const l = await until(c, 0, 'boot');
      const j = JSON.parse(l);
      rec.boot.push({ spawn_to_ok_ms: +(performance.now() - t0).toFixed(1), p1_since_start_ms: j.ms });
      await sleep(3000); for (let i = 0; i < 3; i++) await c.ask(i, 'sleep 101-120');
      c.kill(); await sleep(500);
    }
  } catch (e) { console.error('FAIL', tag, e.message); c.kill(); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(tag, 'meta p50', rec.meta_ms.p50, 'create p50', rec.create_group_ms.p50, 'wake1 p50', rec.wake1_ms.p50, 'max', rec.wake1_ms.max, 'wake20', rec.wake20_ms,
    'boot', rec.boot.map((x) => x.spawn_to_ok_ms), 'rss', rec.mem.map((m) => m.rss_kb), 'idle msgs/s', rec.idle.map((x) => x.msgs_s.toFixed(2)), 'load', la.split(' ')[0]);
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
for (let r = 0; r < RUNS; r++) for (const S of SCALES) { if (have(`S${S}`) > r) continue; await run(S, r); }
