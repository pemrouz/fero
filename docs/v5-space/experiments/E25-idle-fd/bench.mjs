// E-25 driver. Part (b): one hub (Node or Rust) with 99 links pinged every 500 ms by a Node farm, with 0 or
// 2,000 quiet groups. Part (c): 100 Node members on this box, full mesh with pings (or bare), total idle CPU
// sampled from /proc over a 30 s window. Usage (under $SP/bin/timing): node bench.mjs part=b|c [runs=3]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 3), OUT = path.join(HERE, 'results', args.out || 'runs.jsonl');
const MEMBER = path.join(HERE, 'node', 'member.mjs'), RHUB = path.join(SP, 'e11', 'target', 'release', 'e25hub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (p, on) => readline.createInterface({ input: p.stdout }).on('line', on);
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length : 0;
const save = (rec) => { fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec).slice(0, 400)); };

async function partB(impl, groups) {
  const tag = `b/${impl}/g${groups}`, port = 18500 + Math.floor(Math.random() * 400);
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const hub = impl === 'rust' ? spawn(RHUB, [`port=${port}`, 'links=99', 'ping=500', `groups=${groups}`, 'warm=5000', 'dur=30000'])
    : spawn('node', ['--expose-gc', MEMBER, 'mode=hub', `port=${port}`, 'links=99', 'ping=500', `groups=${groups}`, 'warm=5000', 'dur=30000']);
  let res = null; const listening = new Promise((r) => lines(hub, (l) => { if (l === 'listening') r(); if (l.startsWith('{')) res = JSON.parse(l); }));
  await listening;
  const farm = spawn('node', [MEMBER, 'mode=farm', `port=${port}`, 'links=99', 'ping=500']);
  await new Promise((r) => hub.on('exit', r));
  farm.kill();
  if (!res) { console.error('FAIL', tag); return; }
  save({ exp: 'E-25', part: 'b', tag, loadavg_before: la, ...res });
}

function procCpu(pid) { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; } catch { return NaN; } }
function procRss(pid) { try { return Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4; } catch { return NaN; } }

async function partC(mode, n) {
  const tag = `c/${mode}/n${n}`, base = 21000 + Math.floor(Math.random() * 50) * 200;
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const ps = []; const ready = [];
  for (let i = 1; i <= n; i++) {
    const p = spawn('node', [MEMBER, `mode=${mode}`, `id=${i}`, `n=${n}`, `base=${base}`, 'ping=500', 'warm=3600000', 'dur=1']);
    ps.push(p); ready.push(new Promise((r) => lines(p, (l) => { if (l === 'ready') r(); })));
    p.stderr.on('data', () => {});
  }
  const t = Date.now(); await Promise.all(ready); const readyS = (Date.now() - t) / 1000;
  await sleep(5000);
  const c0 = ps.map((p) => procCpu(p.pid)), w0 = performance.now();
  await sleep(30000);
  const c1 = ps.map((p) => procCpu(p.pid)), sec = (performance.now() - w0) / 1000;
  const rss = ps.map((p) => procRss(p.pid));
  const cores = c1.map((c, i) => (c - c0[i]) / sec);
  for (const p of ps) p.kill('SIGKILL');
  await sleep(1000);
  const sorted = [...cores].sort((x, y) => x - y);
  save({ exp: 'E-25', part: 'c', tag, mode, n, loadavg_before: la, loadavg_end: fs.readFileSync('/proc/loadavg', 'utf8').trim(), ready_s: readyS, window_s: +sec.toFixed(2),
    cores_total: cores.reduce((s, x) => s + x, 0), cores_per_process_median: sorted[n >> 1], cores_per_process_max: sorted[n - 1],
    rss_total_mb: rss.reduce((s, x) => s + x, 0) / 1024, rss_per_process_mb: rss.reduce((s, x) => s + x, 0) / 1024 / n, frames_s_total_expected: mode === 'mesh' ? n * (n - 1) * 2 : 0 });
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
for (let r = 0; r < RUNS; r++) {
  if (args.part === 'b') for (const impl of ['node', 'rust']) for (const g of [0, 2000]) { if (have(`b/${impl}/g${g}`) > r) continue; await partB(impl, g); }
  if (args.part === 'c') for (const mode of ['bare', 'mesh']) { if (have(`c/${mode}/n100`) > r) continue; await partC(mode, 100); }
}
