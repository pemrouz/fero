// E-35 driver: runs E-12's Node journal (../E12-journal/ts/journal.ts) with classes of records.
// Usage: node bench.mjs block=<a|b|b40|probe> [runs=3]
// Each config runs `runs` times, repeats interleaved; a config with enough lines in
// results/runs.jsonl is skipped (so a block can be resumed). Run it under $SP/bin/timing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const JOURNAL = path.join(HERE, '..', 'E12-journal', 'ts', 'journal.ts');
const OUT = path.join(HERE, 'results', 'runs.jsonl');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 3);
const DATA = path.join(SP, 'e35', 'data');

// The variants. Each is the same load on a different storage policy.
const VARIANTS = {
  base: { mode: 'a' },                                   // one shared journal, FIFO, batches uncapped
  blob: { mode: 'a', blob: 65536 },                       // records >= 64 KiB go to a side file; a pointer enters the journal
  cap: { mode: 'a', cap: 65536 },                         // batches capped at 64 KiB, FIFO (a big record is cut into frames)
  rr: { mode: 'a', cap: 65536, order: 'rr' },             // capped at 64 KiB, round robin across groups/tenants
  own: { mode: 'b' },                                     // one journal per group/tenant (E-12 mode b)
};

const MB = 1 << 20;
// (a) SC-15: one partition writes 1 MiB records 10 times a second beside 16 partitions of 100 B writers at 10,000/s
const victimsA = { name: 'victim', parts: 16, rate: 10000, size: 100 };
const bigA = { name: 'big', parts: 1, rate: 10, size: MB };
// (b) SC-11: 100 tenants on one log-tier process; tenant B writes 100/s, 98 others 10/s each, tenant A at its quota
const B = { name: 'B', parts: 1, rate: 100, size: 100 };
const others = { name: 'others', parts: 98, rate: 980, size: 100 };
const A = (rate, size) => ({ name: 'A', parts: 1, rate, size });

function configs(block) {
  const out = [];
  if (block === 'a') {
    for (const [v, p] of Object.entries(VARIANTS)) {
      out.push({ id: `a/${v}/alone`, spec: [victimsA], ...p, dur: 8000 });
      out.push({ id: `a/${v}/big`, spec: [victimsA, bigA], ...p, dur: 8000 });
    }
  } else if (block === 'b' || block === 'b40') {
    const q = block === 'b' ? 10 : 40;   // tenant A's quota in MiB/s
    for (const [v, p] of Object.entries(VARIANTS)) {
      if (block === 'b') out.push({ id: `b/${v}/alone`, spec: [A(0, 100), B, others], ...p, dur: 20000 });
      out.push({ id: `b${q}/${v}/A-1MiB`, spec: [A(q, MB), B, others], ...p, dur: 20000 });
      out.push({ id: `b${q}/${v}/A-64KiB`, spec: [A(q * 16, 65536), B, others], ...p, dur: 20000 });
    }
  } else if (block === 'bq') {
    // where does the neighbour clause hold? tenant A at lower quotas, in 1 MiB records, on the shared journal and on a journal per tenant
    for (const q of [1, 2.5, 5]) for (const v of ['base', 'own']) out.push({ id: `bq${q}/${v}/A-1MiB`, spec: [A(q, MB), B, others], ...VARIANTS[v], dur: 20000 });
  }
  return out;
}

const diskSectors = () => Number(fs.readFileSync('/proc/diskstats', 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f[2] === 'vda')[9]);
function have(id) {
  if (!fs.existsSync(OUT)) return 0;
  return fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${id}"`)).length;
}

function runProbe() {
  // the critic's head-of-line probe, copied unchanged into probe/hol.mjs: 64 x 100 B per batch, and every 10th batch with one 1 MiB record
  const lines = [];
  for (let r = 0; r < RUNS; r++) for (const mode of ['small', 'mixed']) {
    const load = fs.readFileSync('/proc/loadavg', 'utf8').trim();
    const res = spawnSync('node', [path.join(HERE, 'probe', 'hol.mjs'), mode, String(MB), '1000', path.join(SP, 'e35', 'hol.bin')], { encoding: 'utf8' });
    const d = JSON.parse(res.stdout.trim()); d.loadavg = load; d.run = r + 1; lines.push(JSON.stringify(d)); console.log(JSON.stringify(d));
  }
  fs.appendFileSync(path.join(HERE, 'results', 'probe.jsonl'), lines.join('\n') + '\n');
}

if (args.block === 'probe') { fs.mkdirSync(path.join(SP, 'e35'), { recursive: true }); runProbe(); process.exit(0); }
const list = configs(args.block);
if (!list.length) throw new Error('unknown block ' + args.block);
for (let rep = 0; rep < RUNS; rep++) {
  for (const c of list) {
    if (have(c.id) > rep) continue;
    fs.rmSync(DATA, { recursive: true, force: true });
    const spec = c.spec.filter((s) => s.rate > 0);
    const argv = [JOURNAL, `mode=${c.mode}`, `spec=${JSON.stringify(spec)}`, `dir=${DATA}`, `tag=${c.id}`, 'warm=2000', `dur=${c.dur}`, 'drain=1500',
      `cap=${c.cap || 0}`, `order=${c.order || 'fifo'}`, `blob=${c.blob || 0}`];
    const d0 = diskSectors(), s0 = Date.now();
    const res = spawnSync('node', argv, { encoding: 'utf8', env: { ...process.env, UV_THREADPOOL_SIZE: '4' }, maxBuffer: 1 << 24 });
    if (res.status !== 0) { console.error('FAIL', c.id, res.stderr.slice(-2000)); continue; }
    const dj = JSON.parse(res.stdout.trim());
    dj.disk_mb_s_run = Math.round((diskSectors() - d0) * 512 / 1e6 / ((Date.now() - s0) / 1000) * 100) / 100;   // whole disk, setup included
    const line = JSON.stringify(dj);
    fs.appendFileSync(OUT, line + '\n');
    const d = JSON.parse(line);
    console.log(c.id.padEnd(22), d.classes.map((k) => `${k.name}: ${k.done_s.toFixed(0)}/s p99 ${k.p99?.toFixed(2)} ms`).join(' | '), 'load', d.loadavg.split(' ')[0]);
  }
}
