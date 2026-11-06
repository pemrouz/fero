// E-02 driver: runs one configuration RUNS times (3 OS processes per run, or 1 for `none`/`ldr`),
// and appends the raw process lines to results/raw.jsonl and one line per run to results/runs.jsonl.
// Run it under the timing lock:  $SP/bin/timing node bench.mjs impl=ts mode=persisted size=100 ...
//   impl   ts | ts-w1 | ts-w2 | ts-w4 | rust | go
//   mode   persisted | memory | ldr | none
//   store  grow (append to a new file on the real disk) | falloc (fallocate first) | zero (zero-filled
//          first: pure overwrite) | emu (tmpfs, each fdatasync followed by a delay sampled from E-01)
//   rate   max | half (half of this configuration's median max) | <records per second>
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const BIN = `${SP}/e01e02`;
const a = { impl: 'ts', mode: 'persisted', size: '100', groups: '1', rate: 'max', store: 'grow', runs: '3', warm: '2000', dur: '8000', tag: '' };
for (const x of process.argv.slice(2)) { const i = x.indexOf('='); a[x.slice(0, i)] = x.slice(i + 1); }
const RES = process.env.RESULTS || path.join(HERE, 'results');
fs.mkdirSync(RES, { recursive: true });
const CDF = path.resolve(HERE, '../E01-floors/results/fdatasync-1w-cdf.txt');
const workers = a.impl.startsWith('ts-w') ? Number(a.impl.slice(4)) : 0;
const N = Math.max(1, workers);
const cfgKey = (r) => [r.impl, r.mode, r.size, r.groups, r.store].join('|');

function cmd(impl) {
  if (impl.startsWith('ts')) return ['node', ['--experimental-strip-types', '--no-warnings', path.join(HERE, 'ts/pipeline.ts')]];
  if (impl === 'rust') return [`${BIN}/target-pipe/release/pipeline`, []];
  if (impl === 'go') return [`${BIN}/e02-go`, []];
  throw new Error('impl ' + impl);
}

function medianMax() {
  const key = cfgKey({ ...a, size: Number(a.size), groups: Number(a.groups) });
  let xs = [];
  try {
    xs = fs.readFileSync(path.join(RES, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.ok && r.rate === 0 && cfgKey(r) === key).map((r) => r.tput).sort((p, q) => p - q);
  } catch {}
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
}
function rateFor() {
  if (a.rate === 'max') return 0;
  const m = medianMax();
  if (a.rate === 'half') { if (!m) throw new Error('no max run for this configuration'); return Math.round(m / 2); }
  const r = Number(a.rate);
  // a fixed rate above 90% of the measured maximum only measures overload: skip it and say so
  if (m && r > 0.9 * m) { console.log(JSON.stringify({ skipped: true, impl: a.impl, mode: a.mode, size: a.size, groups: a.groups, store: a.store, rate: r, max: m })); process.exit(0); }
  return r;
}

function cpuStat() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + f[4];
  return { busy: f.slice(0, 8).reduce((s, x) => s + x, 0) - idle, steal: f[7] };   // clock ticks (USER_HZ = 100)
}

function prepare(dir, store) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ids = a.mode === 'none' || a.mode === 'ldr' ? [0] : [0, 1, 2];
  const seg = store === 'emu' ? 128 << 20 : store === 'grow' ? 0 : 512 << 20;
  for (const id of ids) for (let w = 0; w < N; w++) {
    const f = `${dir}/j.${id}.${w}`;
    if (store === 'falloc' || store === 'emu') execFileSync('fallocate', ['-l', String(seg), f]);
    if (store === 'zero') execFileSync('dd', ['if=/dev/zero', `of=${f}`, 'bs=1M', `count=${seg >> 20}`, 'conv=fsync', 'status=none']);
  }
  return seg;
}

function runOnce(run, rate) {
  const dir = a.store === 'emu' ? '/dev/shm/e02' : `${SP}/e01e02/e02/j`;
  const seg = prepare(dir, a.store);
  const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const [bin, pre] = cmd(a.impl);
  const startDelay = a.impl.startsWith('ts') ? 2500 : 1200;
  const start = Date.now() + startDelay;
  const common = [`dir=${dir}`, `mode=${a.mode}`, `size=${a.size}`, `groups=${a.groups}`, `rate=${rate}`, `start=${start}`,
    `warm=${a.warm}`, `dur=${a.dur}`, 'drain=1000', `seg=${seg}`, `workers=${workers}`];
  if (a.store === 'emu') common.push(`emu=${CDF}`, `addon=${BIN}/emu.node`);
  const procs = [];
  const peers = [27510, 27520];
  const withF = a.mode === 'persisted' || a.mode === 'memory';
  if (withF) peers.forEach((p, i) => procs.push(spawn(bin, [...pre, 'role=follower', `id=${i + 1}`, `port=${p}`, ...common], { stdio: ['ignore', 'pipe', 'pipe'] })));
  procs.push(spawn(bin, [...pre, 'role=leader', 'id=0', `peers=${withF ? peers.join(',') : ''}`, ...common], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const outs = procs.map((p) => { const o = { out: '', err: '' }; p.stdout.on('data', (d) => (o.out += d)); p.stderr.on('data', (d) => (o.err += d)); return o; });
  const ws = start + Number(a.warm), we = ws + Number(a.dur);
  let s0, s1;
  setTimeout(() => (s0 = cpuStat()), ws - Date.now());
  setTimeout(() => (s1 = cpuStat()), we - Date.now());
  const exits = procs.map((p) => new Promise((res) => p.on('exit', (code) => res(code))));
  const kill = setTimeout(() => procs.forEach((p) => p.kill('SIGKILL')), we - Date.now() + 15000);
  return Promise.all(exits).then((codes) => {
    clearTimeout(kill);
    fs.rmSync(dir, { recursive: true, force: true });
    const lines = outs.map((o) => o.out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0] || null);
    const errs = outs.map((o) => o.err.split('\n').filter((l) => l && !/ready$/.test(l)).join(' | ')).filter(Boolean);
    const base = { tag: a.tag, impl: a.impl, mode: a.mode, size: Number(a.size), groups: Number(a.groups), rate, rate_label: a.rate, store: a.store, run };
    for (const l of lines) fs.appendFileSync(path.join(RES, 'raw.jsonl'), JSON.stringify({ ...base, ...l }) + '\n');
    const L = lines[lines.length - 1];
    const F = lines.slice(0, -1);
    if (!L || F.some((f) => !f) || codes.some((c) => c !== 0)) {
      const bad = { ...base, ok: false, codes, errs, loadavg };
      fs.appendFileSync(path.join(RES, 'runs.jsonl'), JSON.stringify(bad) + '\n');
      console.log(JSON.stringify(bad));
      return;
    }
    const ourCores = lines.reduce((s, l) => s + l.cores_used, 0);
    const boxCores = s0 && s1 ? (s1.busy - s0.busy) / 100 / (Number(a.dur) / 1000) : null;
    const r = { ...base, ok: true, loadavg, tput: L.tput, lat_ms: L.lat_ms, missing: L.missing,
      cpu_us_per_append: { leader: L.cpu_us_per_append, f1: F[0] ? F[0].cpu_us_per_append : null, f2: F[1] ? F[1].cpu_us_per_append : null },
      cores_used: { leader: L.cores_used, f1: F[0] ? F[0].cores_used : null, f2: F[1] ? F[1].cores_used : null },
      box_busy_cores: boxCores === null ? null : +boxCores.toFixed(2),
      steal_cores: s0 && s1 ? +((s1.steal - s0.steal) / 100 / (Number(a.dur) / 1000)).toFixed(2) : null, other_cores: boxCores === null ? null : +(boxCores - ourCores).toFixed(2),
      recs_per_flush: L.recs_per_flush, tick_late_max_ms: L.tick_late_max_ms, ticks_late_over_5ms: L.ticks_late_over_5ms, errs };
    fs.appendFileSync(path.join(RES, 'runs.jsonl'), JSON.stringify(r) + '\n');
    console.log(JSON.stringify(r));
  });
}

// resume: a configuration that already has RUNS good runs is not run again
const done = (() => { try { return fs.readFileSync(path.join(RES, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.ok && cfgKey(r) === cfgKey({ ...a }) && String(r.rate_label) === a.rate).length; } catch { return 0; } })();
if (done >= Number(a.runs)) { console.log(JSON.stringify({ already: done, impl: a.impl, mode: a.mode, size: a.size, groups: a.groups, store: a.store, rate: a.rate })); process.exit(0); }
const rate = rateFor();
for (let i = 1; i <= Number(a.runs); i++) await runOnce(i, rate);
