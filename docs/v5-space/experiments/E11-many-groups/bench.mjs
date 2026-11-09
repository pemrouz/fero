// E-11 driver: three processes of one build (go, rs, ts) on loopback, each hosting one replica of
// each of N groups. Usage (under $SP/bin/timing): node bench.mjs block=<name> [runs=3] [impls=go,rs,ts]
// A config with `runs` results in results/runs.jsonl is skipped; repeats are interleaved.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
// smoke runs (not measurements) go to their own file
const OUT = path.join(HERE, 'results', args.block === 'smoke' ? 'smoke.jsonl' : 'runs.jsonl');
const RUNS = Number(args.runs || 3);
const IMPLS = (args.impls || 'go,rs,ts').split(',');

const BIN = {
  go: [path.join(SP, 'e11', 'e11-go')],
  rs: [path.join(SP, 'e11', 'target', 'release', 'e11host')],
  ts: ['node', '--expose-gc', '--max-old-space-size=6144', path.join(HERE, 'ts', 'host.ts')],
};
const MODES = {
  tick100: { mode: 'tick', tick: 100, elect: 10 },   // etcd's defaults: heartbeat 100 ms, election 1 s
  tick500: { mode: 'tick', tick: 500, elect: 4 },    // the draft's ping.ms (500 ms) as the heartbeat, election.ms 2 s
  quiet500: { mode: 'quiet', tick: 500, elect: 4 },  // the draft's quiet shards with link pings every 500 ms
};

function configs(block) {
  const c = [];
  const idleNs = [10, 100, 1000, 2000, 10000];
  if (block === 'idle') for (const m of Object.keys(MODES)) for (const n of idleNs) c.push({ m, n, rate: 0, hot: 1 });
  if (block === 'idle-small') for (const m of Object.keys(MODES)) for (const n of [10, 100, 1000, 2000]) c.push({ m, n, rate: 0, hot: 1 });
  if (block === 'idle-10k') for (const m of Object.keys(MODES)) c.push({ m, n: 10000, rate: 0, hot: 1 });
  if (block === 'idle-quiet') for (const n of idleNs) c.push({ m: 'quiet500', n, rate: 0, hot: 1 });
  if (block === 'busy') {
    for (const n of [1, 10, 16, 100, 1000, 2000, 10000]) c.push({ m: 'quiet500', n, rate: 10000, hot: 1 });
    for (const n of [100, 1000, 2000, 10000]) c.push({ m: 'quiet500', n, rate: 10000, hot: 0.01 });
  }
  if (block === 'busy-tick') for (const n of [1, 16, 2000]) c.push({ m: 'tick100', n, rate: 10000, hot: 1 });
  if (block === 'smoke') c.push({ m: args.m || 'quiet500', n: Number(args.n || 100), rate: Number(args.rate || 0), hot: Number(args.hot || 1) });
  return c;
}
const tagOf = (impl, c) => `${impl}/${c.m}/n${c.n}/r${c.rate}/h${c.hot}`;
const diskSectors = () => Number(fs.readFileSync('/proc/diskstats', 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f[2] === 'vda')[9]);
function have(tag) { if (!fs.existsSync(OUT)) return 0; return fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length; }

async function runOne(impl, c) {
  const tag = tagOf(impl, c);
  const base = 20000 + Math.floor(Math.random() * 3000) * 3;
  const ports = [base, base + 1, base + 2].join(',');
  const dir = path.join(SP, 'e11', 'data');
  fs.rmSync(dir, { recursive: true, force: true });
  const md = MODES[c.m];
  const warm = c.m.startsWith('quiet') ? 4000 : 3000;
  const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const procs = [], lines = [[], [], []], readyP = [];
  const t0 = Date.now();
  for (let i = 1; i <= 3; i++) {
    const [cmd, ...pre] = BIN[impl];
    const argv = [...pre, `id=${i}`, `n=${c.n}`, `mode=${md.mode}`, `tick=${md.tick}`, `elect=${md.elect}`, 'ping=500', `rate=${c.rate}`, `hot=${c.hot}`,
      'size=100', `warm=${warm}`, 'dur=6000', `dir=${dir}`, 'fsync=1', `ports=${ports}`];
    const p = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.errText = () => err;
    procs.push(p);
    readyP.push(new Promise((res) => {
      readline.createInterface({ input: p.stdout }).on('line', (l) => { if (l === 'ready') res(); else lines[i - 1].push(l); });
    }));
  }
  const exited = procs.map((p) => new Promise((res) => p.on('exit', (code) => res(code))));
  const timeout = (ms) => new Promise((res) => setTimeout(() => res('timeout'), ms));
  const r = await Promise.race([Promise.all(readyP), timeout(240000), ...exited.map((e) => e.then(() => 'exit'))]);
  if (r === 'timeout' || r === 'exit') {
    for (const p of procs) p.kill('SIGKILL');
    console.error('FAIL', tag, r, procs.map((p) => p.errText().slice(-1500)).join('\n---\n'));
    return null;
  }
  const readyAll = Date.now() - t0;
  for (const p of procs) p.stdin.write('go\n');
  const d0 = diskSectors(), s0 = Date.now();
  const done = await Promise.race([Promise.all(exited), timeout(60000)]);
  if (done === 'timeout') { for (const p of procs) p.kill('SIGKILL'); console.error('FAIL', tag, 'no exit'); return null; }
  const nodes = lines.map((l) => { const j = l.find((x) => x.startsWith('{')); return j ? JSON.parse(j) : null; });
  if (nodes.some((x) => !x)) { console.error('FAIL', tag, 'no result', procs.map((p) => p.errText().slice(-1500)).join('\n---\n')); return null; }
  fs.rmSync(dir, { recursive: true, force: true });
  const sum = (k) => nodes.reduce((s, x) => s + x[k], 0);
  const commits = sum('commits_s');
  const diskMB = Math.round((diskSectors() - d0) * 512 / 1e6 / ((Date.now() - s0) / 1000) * 100) / 100;   // whole disk, from "go" to exit
  const rec = { exp: 'E-11', tag, impl, mode: c.m, n: c.n, rate: c.rate, hot: c.hot, loadavg, ready_all_ms: readyAll, disk_mb_s_run: diskMB,
    cores_mean: sum('cores') / 3, cores_max: Math.max(...nodes.map((x) => x.cores)), frames_s_mean: sum('frames_s') / 3, msgs_s_mean: sum('msgs_s') / 3,
    rss_kb_mean: sum('rss_kb') / 3, commits_s: commits, proposals_s: sum('proposals_s'), fsyncs_s_mean: sum('fsyncs_s') / 3,
    p99_max: Math.max(...nodes.filter((x) => x.commits_s > 0).map((x) => x.p99), -1),
    p50_wmean: commits ? nodes.reduce((s, x) => s + (x.p50 > 0 ? x.p50 * x.commits_s : 0), 0) / commits : -1,
    leaders: nodes.map((x) => x.leaders), awake_end: nodes.map((x) => x.awake_end), nodes };
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(`${tag.padEnd(34)} ready ${(readyAll / 1000).toFixed(1)}s cores ${rec.cores_mean.toFixed(4)} frames/s ${rec.frames_s_mean.toFixed(0)} rss ${(rec.rss_kb_mean / 1024).toFixed(1)} MB commits/s ${commits.toFixed(0)} p99 ${rec.p99_max.toFixed(2)} awake ${rec.awake_end} load ${loadavg.split(' ')[0]}`);
  return rec;
}

const list = configs(args.block);
if (!list.length) throw new Error('unknown block ' + args.block);
for (let rep = 0; rep < RUNS; rep++) for (const c of list) for (const impl of IMPLS) {
  if (have(tagOf(impl, c)) > rep) continue;
  await runOne(impl, c);
}
