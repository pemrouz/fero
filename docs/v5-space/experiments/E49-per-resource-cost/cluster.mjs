// E-49 cluster runs: three processes of E-26's host (../E26-dormant-groups/host.ts, unchanged: E-11's TS host on
// E-10's Raft port, with quiet groups, link pings every 500 ms, one journal with one fdatasync per round, and
// create/sleep/wake commands), each holding one copy of R home groups: R small resources, 3 machines, 3 copies.
// One run, per R:
//   boot      the three processes start cold with R groups and every group elects at once (process g % 3 + 1
//             campaigns for group g): spawn to "every group on every process has a leader" (a whole-project
//             restart with R awake groups). Note: that start campaign is a preferred-leader boot rule the base does
//             not have; the base's boot (Raft's random timers) is measured by boot.mjs
//   journal   bytes each process's journal holds once the boot settled (the founding of R groups)
//   create    20 x found a new resource's home group: the group made on three processes, process 1 campaigns
//             and writes one entry (E-26's `create`); bytes added to each journal per create
//   idle      a 5 s window with everything quiet: frames and Raft messages per second per process
//   mem       RSS, and heap after a forced GC, per process
//   long=N    (optional) N slices of 10 s: CPU per process from /proc, and the garbage collector's work (--trace-gc)
//   window    10 s later, E-11's measuring window (4 s warm-up, 6 s): CPU per process as a share of one core, and
//             leaders per process (how evenly the boot's elections spread the leaders)
// Usage (under $SP/bin/timing): node cluster.mjs [runs=3] [scales=1,10,100,1000,10000,100000]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, '..', 'E26-dormant-groups', 'host.ts');
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 1), SCALES = (args.scales || '1,10,100,1000,10000,100000').split(',').map(Number);
const OUT = path.join(HERE, 'results', args.out || 'cluster.jsonl');
const LONG = Number(args.long || 0);   // long=N: after the memory reading, N slices of 10 s of CPU per process (from /proc) and GC lines (--trace-gc)
const ticks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };   // utime + stime, clock ticks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length : 0;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const jsize = (dir) => [1, 2, 3].map((i) => { try { return fs.statSync(path.join(dir, `journal-${i}`)).size; } catch { return 0; } });

function start(R, dir, ports, traceGc = false) {
  const ps = [], q = [[], [], []], waiters = [[], [], []], gcs = [[], [], []];
  for (let i = 1; i <= 3; i++) {
    const p = spawn('node', ['--expose-gc', '--max-old-space-size=6144', ...(traceGc ? ['--trace-gc'] : []), HOST, `id=${i}`, `n=${R}`, 'mode=quiet', 'tick=500', 'elect=4', 'ping=500', 'rate=0',
      'warm=4000', 'dur=6000', `dir=${dir}`, 'fsync=1', `ports=${ports}`, `max=${R + 1000}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); }); p.err = () => err;
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      // a --trace-gc line: "[pid:addr]  N ms: Mark-Compact 300.1 (320.0) -> 299.9 (310.0) MB, pooled: 0 MB, 410.2 / 0.0 ms ..."
      if (l.startsWith('[') && l.includes(' ms: ')) { const m = /ms: (\S+(?: \(\S+\))?) .*?MB, (?:pooled: \S+ MB, )?([\d.]+) \/ [\d.]+ ms/.exec(l); gcs[i - 1].push({ t: Date.now(), kind: m ? m[1] : '?', ms: m ? Number(m[2]) : 0 }); return; }
      const w = waiters[i - 1].shift(); if (w) w(l); else q[i - 1].push(l);
    });
    ps.push(p);
  }
  const next = (i, ms = 60000) => new Promise((res, rej) => { if (q[i].length) return res(q[i].shift()); const t = setTimeout(() => rej(new Error('timeout from ' + (i + 1) + ': ' + ps[i].err().slice(-2000))), ms); waiters[i].push((l) => { clearTimeout(t); res(l); }); });
  const send = (i, l) => ps[i].stdin.write(l + '\n');
  const ask = async (i, l) => { send(i, l); for (;;) { const r = await next(i); if (r.startsWith('{')) return JSON.parse(r); } };
  const exited = ps.map((p) => new Promise((res) => p.on('exit', res)));
  return { ps, gcs, next, send, ask, exited, kill: () => { for (const p of ps) p.kill('SIGKILL'); } };
}
const until = async (c, i, word, ms) => { for (;;) { const l = await c.next(i, ms); if (l === word || l.includes(`"ok":"${word}"`)) return l; } };

async function run(R, r) {
  const tag = `R${R}${LONG ? '-long' : ''}`, dir = path.join(SP, 'e49', 'cluster');
  fs.rmSync(dir, { recursive: true, force: true });
  const base = 27600 + Math.floor(Math.random() * 1500) * 3, ports = [base, base + 1, base + 2].join(',');
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const rec = { exp: 'E-49', tag, R, run: r, loadavg: la };
  const t0 = performance.now();
  const c = start(R, dir, ports, LONG > 0);
  try {
    await Promise.all([0, 1, 2].map((i) => until(c, i, 'ready', 600000)));
    rec.boot_all_led_ms = +(performance.now() - t0).toFixed(0);
    await sleep(3000);   // every group goes quiet two ticks after its last write
    rec.journal_after_boot_B = jsize(dir);
    const before = jsize(dir), create = [];
    for (let k = 1; k <= 20; k++) { create.push((await c.ask(0, `create ${R + k}`)).ms); await sleep(20); }
    const after = jsize(dir);
    rec.create_ms = { p50: med(create), max: Math.max(...create), all: create };
    rec.journal_per_create_B = after.map((a, i) => +((a - before[i]) / 20).toFixed(1));
    await sleep(3000);
    for (let i = 0; i < 3; i++) await c.ask(i, 'stats');
    await sleep(5000);
    rec.idle = []; for (let i = 0; i < 3; i++) rec.idle.push(await c.ask(i, 'stats'));
    rec.mem = []; for (let i = 0; i < 3; i++) rec.mem.push(await c.ask(i, 'mem'));
    if (LONG) {
      rec.slices = [];
      for (let k = 0; k < LONG; k++) {
        const t0s = c.ps.map((p) => ticks(p.pid)), w0 = Date.now(); await sleep(10000); const sec = (Date.now() - w0) / 1000;
        rec.slices.push({ end_s: Math.round((performance.now() - t0) / 1000), cores: c.ps.map((p, i) => +((ticks(p.pid) - t0s[i]) / 100 / sec).toFixed(4)),
          gc: c.gcs.map((g) => { const x = g.filter((e) => e.t >= w0); return { n: x.length, mark_compact: x.filter((e) => e.kind.startsWith('Mark')).length, ms: +x.reduce((a, e) => a + e.ms, 0).toFixed(1) }; }) });
      }
    }
    await sleep(10000);   // let the boot's garbage be collected before the CPU window (a smoke run at R = 100,000 caught a heap shrink in it)
    for (let i = 0; i < 3; i++) c.send(i, 'go');
    rec.window = []; for (let i = 0; i < 3; i++) { for (;;) { const l = await c.next(i, 60000); if (l.startsWith('{"impl"')) { rec.window.push(JSON.parse(l)); break; } } }
    await Promise.race([Promise.all(c.exited), sleep(5000)]);
  } catch (e) { console.error('FAIL', tag, e.message); c.kill(); return; }
  c.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  const w = rec.window;
  console.log(tag, 'boot', rec.boot_all_led_ms, 'ms; journal', rec.journal_after_boot_B, 'create p50', rec.create_ms.p50, 'max', rec.create_ms.max, 'per-create B', rec.journal_per_create_B,
    'idle msgs/s', rec.idle.map((x) => x.msgs_s.toFixed(2)), 'frames/s', rec.idle.map((x) => x.frames_s.toFixed(2)), 'rss MB', rec.mem.map((m) => (m.rss_kb / 1024).toFixed(0)),
    'heap MB', w.map((x) => (x.heap_kb / 1024).toFixed(1)), 'cores', w.map((x) => x.cores.toFixed(4)), 'load', la.split(' ')[0]);
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
for (let r = 0; r < RUNS; r++) for (const R of SCALES) { if (have(`R${R}${LONG ? '-long' : ''}`) > r) continue; await run(R, r); }
