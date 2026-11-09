// E-13 slot-move window driver: three processes of ./host.ts (E-11's TS host on E-10's port, plus the move chain)
// on loopback, 16 groups, quiet mode (ticks 500 ms, election 4 ticks), background load over all 16 groups,
// and one slot move every 50 ms driven from process 1. Usage (under $SP/bin/timing):
//   node move.mjs [runs=3] [block=main|smoke]
// A config that already has `runs` rows in results/move.jsonl is skipped; repeats are interleaved.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const OUT = path.join(HERE, '..', 'results', args.block === 'smoke' ? 'move-smoke.jsonl' : 'move.jsonl');
const RUNS = Number(args.runs || 3);
const configs = args.block === 'smoke' ? [{ stages: 3, rate: 2000 }]
  : [0, 2000, 10000].flatMap((rate) => [1, 2, 3].map((stages) => ({ stages, rate })));
const tagOf = (c) => `ts/s${c.stages}/r${c.rate}`;
function have(tag) { if (!fs.existsSync(OUT)) return 0; return fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length; }

async function runOne(c) {
  const tag = tagOf(c);
  const base = 24000 + Math.floor(Math.random() * 2000) * 3;
  const ports = [base, base + 1, base + 2].join(',');
  const dir = path.join(SP, 'e13', 'movedata');
  fs.rmSync(dir, { recursive: true, force: true });
  const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const procs = [], lines = [[], [], []], readyP = [];
  for (let i = 1; i <= 3; i++) {
    const argv = ['--expose-gc', path.join(HERE, 'host.ts'), `id=${i}`, 'n=16', 'mode=quiet', 'tick=500', 'elect=4', 'ping=500', `rate=${c.rate}`, 'hot=1',
      'size=100', 'warm=4000', 'dur=10000', `dir=${dir}`, 'fsync=1', `ports=${ports}`, `stages=${c.stages}`, 'every=50'];
    const p = spawn('node', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.errText = () => err; procs.push(p);
    readyP.push(new Promise((res) => readline.createInterface({ input: p.stdout }).on('line', (l) => { if (l === 'ready') res(); else lines[i - 1].push(l); })));
  }
  const exited = procs.map((p) => new Promise((res) => p.on('exit', (code) => res(code))));
  const timeout = (ms) => new Promise((res) => setTimeout(() => res('timeout'), ms));
  const r = await Promise.race([Promise.all(readyP), timeout(60000), ...exited.map((e) => e.then(() => 'exit'))]);
  if (r === 'timeout' || r === 'exit') { for (const p of procs) p.kill('SIGKILL'); console.error('FAIL', tag, r, procs.map((p) => p.errText().slice(-1500)).join('\n---\n')); return; }
  await new Promise((res) => setTimeout(res, 1000));
  for (const p of procs) p.stdin.write('go\n');
  const done = await Promise.race([Promise.all(exited), timeout(60000)]);
  if (done === 'timeout') { for (const p of procs) p.kill('SIGKILL'); console.error('FAIL', tag, 'no exit'); return; }
  const nodes = lines.map((l) => { const j = l.find((x) => x.startsWith('{')); return j ? JSON.parse(j) : null; });
  if (nodes.some((x) => !x)) { console.error('FAIL', tag, 'no result', procs.map((p) => p.errText().slice(-1500)).join('\n---\n')); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  const p1 = nodes[0];
  const rec = { exp: 'E-13', part: 'slot-move', tag, impl: 'ts', stages: c.stages, rate: c.rate, loadavg, moves_started: p1.moves_started, moves_done: p1.moves_done,
    moves_skipped: p1.moves_skipped, move_p50: p1.move_p50, move_p90: p1.move_p90, move_p99: p1.move_p99, move_max: p1.move_max,
    write_p50: nodes.map((x) => x.p50), write_p99: nodes.map((x) => x.p99), cores: nodes.map((x) => +x.cores.toFixed(3)), commits_s: nodes.reduce((s, x) => s + x.commits_s, 0) };
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(`${tag.padEnd(14)} moves ${rec.moves_done}/${rec.moves_started} window p50 ${rec.move_p50} p99 ${rec.move_p99} max ${rec.move_max} ms; write p99 ${rec.write_p99.map((x) => x.toFixed(2))} load ${loadavg.split(' ')[0]}`);
}

for (let rep = 0; rep < RUNS; rep++) for (const c of configs) { if (have(tagOf(c)) > rep) continue; await runOne(c); }
