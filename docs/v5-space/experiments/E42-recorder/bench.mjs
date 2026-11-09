// E-42 driver: E-02's TS pipeline (./pipeline.ts) with the recorder off, `ref` or `full`, three processes on
// loopback, 50,000 appends/s of 100 B, one group, `persisted` rung, growing journal files (E-02's `grow`),
// 2 s warm-up, 8 s window, 1 s drain. Usage (under $SP/bin/timing):
//   node bench.mjs part=cost [runs=3]      CPU and bytes, verify off, modes off/ref/full interleaved
//   node bench.mjs part=verify [runs=1]    verify=1 (a CRC of every effect), then replay each process's recording
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 3), RATE = Number(args.rate || 50000);
const OUT = path.join(HERE, 'results', args.out || (args.part === 'verify' ? 'verify.jsonl' : 'runs.jsonl'));
const PIPE = path.join(HERE, 'pipeline.ts');
const node = (argv) => spawn('node', ['--no-warnings', PIPE, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
const collect = (p) => new Promise((res) => { let out = '', err = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => err += d); p.on('exit', () => res({ out, err })); });
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length : 0;
function diskSectors() { return Number(fs.readFileSync('/proc/diskstats', 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((f) => f[2] === 'vda')[9]); }

async function runOnce(rec, verify, keep) {
  const dir = path.join(SP, 'e42', 'data'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const start = Date.now() + 1500, base = 27600 + Math.floor(Math.random() * 30) * 20;
  const common = [`dir=${dir}`, 'mode=persisted', 'size=100', 'groups=1', `rate=${RATE}`, `start=${start}`, 'warm=2000', 'dur=8000', 'drain=1000', 'seg=0', 'workers=0', `rec=${rec}`, `verify=${verify}`];
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim(); const d0 = diskSectors();
  const ps = [node(['role=follower', 'id=1', `port=${base}`, ...common]), node(['role=follower', 'id=2', `port=${base + 10}`, ...common])];
  ps.push(node(['role=leader', 'id=0', `peers=${base},${base + 10}`, ...common]));
  const outs = await Promise.all(ps.map(collect));
  const res = outs.map((o) => { try { return JSON.parse(o.out.trim().split('\n').pop()); } catch { console.error(o.err.slice(-2000)); return null; } });
  const disk_mb = (diskSectors() - d0) * 512 / 1e6;
  return { dir, la, res, disk_mb };
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
if (args.part === 'cost') {
  for (let r = 0; r < RUNS; r++) for (const rec of ['off', 'ref', 'full']) {
    const tag = `cost/${rec}/r${RATE}`; if (have(tag) > r) continue;
    const { la, res, disk_mb } = await runOnce(rec, 0);
    if (res.some((x) => !x)) { console.error('FAIL', tag); continue; }
    const [f1, f2, L] = res;
    const row = { exp: 'E-42', tag, rec, rate: RATE, loadavg: la, tput: L.tput, p50: L.lat_ms.p50, p99: L.lat_ms.p99,
      cpu_us_per_append: { leader: L.cpu_us_per_append, f1: f1.cpu_us_per_append, f2: f2.cpu_us_per_append },
      cores: { leader: L.cores_used, f1: f1.cores_used, f2: f2.cores_used },
      rec_bytes: { leader: L.rec_bytes, f1: f1.rec_bytes, f2: f2.rec_bytes }, rec_events: { leader: L.rec_events, f1: f1.rec_events, f2: f2.rec_events },
      journal_bytes: { leader: L.journal_bytes, f1: f1.journal_bytes, f2: f2.journal_bytes }, run_s: 11, disk_mb_whole_box: +disk_mb.toFixed(1) };
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log(tag, 'tput', L.tput, 'p99', L.lat_ms.p99, 'cpu us/append', JSON.stringify(row.cpu_us_per_append), 'rec/journal', JSON.stringify(row.rec_bytes), JSON.stringify(row.journal_bytes), 'load', la.split(' ')[0]);
  }
}
if (args.part === 'verify') {
  for (let r = 0; r < RUNS; r++) for (const rec of ['ref', 'full']) {
    const tag = `verify/${rec}`; if (have(tag) > r) continue;
    const { dir, la, res } = await runOnce(rec, 1);
    if (res.some((x) => !x)) { console.error('FAIL', tag); continue; }
    const live = { 0: res[2].digest, 1: res[0].digest, 2: res[1].digest };
    const rep = {};
    for (const id of [0, 1, 2]) {
      const p = spawn('node', ['--no-warnings', '--max-old-space-size=8192', PIPE, `role=${id === 0 ? 'replay-leader' : 'replay-follower'}`, `id=${id}`, `rec=${rec}`, `recfile=${dir}/rec.${id}`,
        `journal=${dir}/j.${id}.0`, `dir=${dir}`, 'groups=1', 'size=100', 'mode=persisted'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const o = await collect(p); try { rep[id] = JSON.parse(o.out.trim().split('\n').pop()); } catch { console.error(o.err.slice(-2000)); rep[id] = null; }
    }
    // planted faults: replay each recording 10 times, each time with one ack or durable event delivered one event
    // late (positions 1,000 to 10,000); count how many change the effects digest
    const planted = {};
    for (const id of [0, 1, 2]) {
      planted[id] = 0;
      for (let k = 1; k <= 10; k++) {
        const p = spawn('node', ['--no-warnings', '--max-old-space-size=8192', PIPE, `role=${id === 0 ? 'replay-leader' : 'replay-follower'}`, `id=${id}`, `rec=${rec}`, `recfile=${dir}/rec.${id}`,
          `journal=${dir}/j.${id}.0`, `dir=${dir}`, 'groups=1', 'size=100', 'mode=persisted', `swap=${k * 1000}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        const o = await collect(p); try { if (JSON.parse(o.out.trim().split('\n').pop()).digest !== live[id]) planted[id]++; } catch { }
      }
    }
    const row = { exp: 'E-42', tag, rec, loadavg: la, live_digest: live, replay: rep, planted_faults_changed_effects_of_10: planted, identical: [0, 1, 2].every((id) => rep[id] && rep[id].digest === live[id]),
      events: [0, 1, 2].map((id) => rep[id]?.events), journal_bytes: [res[2].journal_bytes, res[0].journal_bytes, res[1].journal_bytes] };
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log(tag, 'identical', row.identical, 'planted caught', JSON.stringify(planted), JSON.stringify(live), JSON.stringify([0, 1, 2].map((id) => rep[id]?.digest)), 'replay ms', [0, 1, 2].map((id) => rep[id]?.replay_ms));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
