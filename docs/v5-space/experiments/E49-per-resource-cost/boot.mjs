// E-49 boot runs (added after the skeptic's check): a cold start of three processes with R groups each, and who
// ends up leading. cluster.mjs runs E-26's host as it is, where each group's preferred process (g % 3 + 1)
// campaigns at once at start: a preferred-leader boot campaign, which the base does not have. The base keeps
// Raft's random timers and spreads leaders afterwards by the hand-back (DESIGN-V5 4.2, decision 21a). So this
// harness runs a copy of E-26's host with four marked patches (E-26's file is not changed):
//   1. the import of E-10's port is made absolute (the copy lives in $SP/e49/host/), and imports globalRand too
//   2. jitter=J (ticks): Raft's random part is 0..J ticks (DESIGN-V5: election.ms plus up to election.jitter),
//      in place of etcd's 0..elect-1 ticks; without jitter=, etcd's range stays (as E-11 and E-26 ran it)
//   3. start=random: no campaign at start, so every group elects by its random timer (the base's boot);
//      start=preferred (the default) keeps E-26's start campaign
//   4. a `leaders` command: groups this process leads, how many of them it is the preferred leader of, and the
//      terms they were won at (a group starts at term 0, so term 1 = won at the first election; 2 or more = the
//      election had to be run again, after a split vote or a timeout)
// One run, per R: spawn to "every group on every process has a leader"; 3 s later `leaders` on each; 8 s later
// `mem` (RSS before a forced collection, then the heap after it); then either slices=N slices of 10 s (CPU per
// process from /proc and the collector's work from --trace-gc, trace=1) or wait=S seconds; then `mem` again
// (RSS that long after the forced collection); then the processes are killed. mem=0 skips both readings.
// Usage (under $SP/bin/timing): node boot.mjs runs=1 scales=1000,10000 start=random|preferred [tick=500 elect=4]
//                                [jitter=J] [mem=1] [wait=20] [slices=0] [trace=0] out=<file in results/> tag=<label>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const RUNS = Number(args.runs || 1), SCALES = (args.scales || '1000,10000,100000').split(',').map(Number);
const START = args.start || 'random', TICK = Number(args.tick || 500), ELECT = Number(args.elect || 4);
const JITTER = args.jitter !== undefined ? Number(args.jitter) : null;
const WAIT = Number(args.wait ?? 20), SLICES = Number(args.slices || 0), TRACE = args.trace === '1', MEM = args.mem !== '0';
const TAG = args.tag || `${START}-t${TICK}e${ELECT}${JITTER !== null ? 'j' + JITTER : ''}`;
const OUT = path.resolve(HERE, 'results', args.out || 'boot.jsonl');   // a bare name lands in results/

// ---------------------------------------------------------------- the patched copy of E-26's host
const SRC = path.join(HERE, '..', 'E26-dormant-groups', 'host.ts');
const PORT = path.join(HERE, '..', 'E10-raft-port', 'port', 'src', 'index.ts');
const HOST = path.join(SP, 'e49', 'host', 'host.ts');
function patchHost() {
  let s = fs.readFileSync(SRC, 'utf8');
  const once = (from, to, what) => { const n = s.split(from).length - 1; if (n !== 1) throw new Error(`patch ${what}: ${n} matches`); s = s.replace(from, to); };
  once("discardLogger, pb } from '../E10-raft-port/port/src/index.ts';", `discardLogger, pb, globalRand } from '${PORT}';   // E-49 patch 1`, 'import');
  once("const ID: number = a.id,", "if (a.jitter !== undefined) { const J = Number(a.jitter); globalRand.Intn = () => Math.floor(Math.random() * (J + 1)); }   // E-49 patch 2\nconst ID: number = a.id,", 'jitter');
  once("  for (let g = 0; g < N; g++) if (g % NP === ID - 1 && !a.boot) {", "  if (a.start !== 'random') for (let g = 0; g < N; g++) if (g % NP === ID - 1 && !a.boot) {   // E-49 patch 3\n", 'start');
  once("  } else if (cmd === 'mem') {", `  } else if (cmd === 'leaders') {   // E-49 patch 4
    let led = 0, pref = 0, prefLed = 0; const terms: Record<number, number> = {};
    for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr) continue; const mine = g % NP === ID - 1; if (mine) pref++;
      if (gr.rn.raft.state === StateLeader) { led++; if (mine) prefLed++; const t = gr.rn.raft.Term; terms[t] = (terms[t] ?? 0) + 1; } }
    console.log(JSON.stringify({ ok: 'leaders', id: ID, led, pref, pref_led: prefLed, terms, ready_ms: +readyMs.toFixed(0) }));
  } else if (cmd === 'mem') {`, 'leaders');
  fs.mkdirSync(path.dirname(HOST), { recursive: true });
  fs.writeFileSync(HOST, s);
}

// ---------------------------------------------------------------- three processes
const ticks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`)).length : 0;
function start(R, dir, ports) {
  const ps = [], q = [[], [], []], waiters = [[], [], []], gcs = [[], [], []];
  for (let i = 1; i <= 3; i++) {
    const p = spawn('node', ['--expose-gc', '--max-old-space-size=6144', ...(TRACE ? ['--trace-gc'] : []), HOST, `id=${i}`, `n=${R}`, 'mode=quiet', `tick=${TICK}`, `elect=${ELECT}`,
      ...(JITTER !== null ? [`jitter=${JITTER}`] : []), `start=${START}`, 'ping=500', 'rate=0', 'warm=4000', 'dur=6000', `dir=${dir}`, 'fsync=1', `ports=${ports}`, `max=${R + 10}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); }); p.err = () => err;
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      if (l.startsWith('[') && l.includes(' ms: ')) {   // a --trace-gc line; 'testing' marks a forced collection (gc())
        const m = /ms: (\S+(?: \(\S+\))?) ([\d.]+) \(.*?MB, (?:pooled: \S+ MB, )?([\d.]+) \/ [\d.]+ ms/.exec(l);
        gcs[i - 1].push({ t: Date.now(), kind: m ? m[1] : '?', before_MB: m ? Number(m[2]) : 0, ms: m ? Number(m[3]) : 0, forced: l.includes('testing') }); return;
      }
      const w = waiters[i - 1].shift(); if (w) w(l); else q[i - 1].push(l);
    });
    ps.push(p);
  }
  const next = (i, ms = 60000) => new Promise((res, rej) => { if (q[i].length) return res(q[i].shift()); const t = setTimeout(() => rej(new Error('timeout from ' + (i + 1) + ': ' + ps[i].err().slice(-2000))), ms); waiters[i].push((l) => { clearTimeout(t); res(l); }); });
  const ask = async (i, l) => { ps[i].stdin.write(l + '\n'); for (;;) { const r = await next(i); if (r.startsWith('{')) return JSON.parse(r); } };
  return { ps, gcs, next, ask, kill: () => { for (const p of ps) p.kill('SIGKILL'); } };
}
const until = async (c, i, word, ms) => { for (;;) { const l = await c.next(i, ms); if (l === word) return l; } };
const majors = (g, from, to = Infinity) => g.filter((e) => e.kind.startsWith('Mark') && e.t >= from && e.t < to);

async function run(R, r) {
  const tag = `${TAG}-R${R}`, dir = path.join(SP, 'e49', 'boot');
  fs.rmSync(dir, { recursive: true, force: true });
  const base = 24600 + Math.floor(Math.random() * 900) * 3, ports = [base, base + 1, base + 2].join(',');
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const rec = { exp: 'E-49', part: 'boot', tag, R, run: r, start: START, tick_ms: TICK, elect_ticks: ELECT, jitter_ticks: JITTER, traced: TRACE, loadavg: la };
  // etcd's range when no jitter= is given: a timeout of elect..2*elect-1 ticks; with jitter=J: elect..elect+J ticks
  rec.timeout_ms = JITTER === null ? [ELECT * TICK, (2 * ELECT - 1) * TICK] : [ELECT * TICK, (ELECT + JITTER) * TICK];
  const t0 = performance.now();
  const c = start(R, dir, ports);
  try {
    await Promise.all([0, 1, 2].map((i) => until(c, i, 'ready', 300000)));
    rec.boot_all_led_ms = +(performance.now() - t0).toFixed(0);
    await sleep(3000);
    rec.leaders = []; for (let i = 0; i < 3; i++) rec.leaders.push(await c.ask(i, 'leaders'));
    if (MEM) {   // memory: 8 s on, RSS then a forced collection; then slices or a wait; then RSS again
      await sleep(8000);
      const tm = Date.now();
      rec.mem = []; for (let i = 0; i < 3; i++) rec.mem.push(await c.ask(i, 'mem'));
      if (SLICES) {
        rec.slices = [];
        for (let k = 0; k < SLICES; k++) {
          const t0s = c.ps.map((p) => ticks(p.pid)), w0 = Date.now(); await sleep(10000); const sec = (Date.now() - w0) / 1000;
          rec.slices.push({ end_s: Math.round((performance.now() - t0) / 1000), cores: c.ps.map((p, i) => +((ticks(p.pid) - t0s[i]) / 100 / sec).toFixed(4)),
            majors: c.gcs.map((g) => majors(g, w0, w0 + sec * 1000).map((e) => e.ms)) });
        }
      } else await sleep(WAIT * 1000);
      rec.mem2_after_s = SLICES ? SLICES * 10 : WAIT;   // seconds from the forced collection to this reading (added after the re-check)
      rec.mem2 = []; for (let i = 0; i < 3; i++) rec.mem2.push(await c.ask(i, 'mem'));
      if (TRACE) rec.gc = c.gcs.map((g) => ({ boot_majors: majors(g, 0, tm).filter((e) => !e.forced).map((e) => [e.before_MB, e.ms]),
        forced: majors(g, tm).filter((e) => e.forced).map((e) => [e.before_MB, e.ms]), after_majors: majors(g, tm).filter((e) => !e.forced).map((e) => [e.before_MB, e.ms]),
        minors: g.filter((e) => !e.kind.startsWith('Mark')).length }));
    }
  } catch (e) {   // recorded too: a boot that does not finish is a result
    console.error('FAIL', tag, e.message.slice(0, 300)); c.kill(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true });
    rec.failed = e.message.slice(0, 300); rec.failed_after_ms = +(performance.now() - t0).toFixed(0); fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); return;
  }
  c.kill();
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(tag, 'run', r, 'boot', rec.boot_all_led_ms, 'ms; leaders', rec.leaders.map((x) => x.led), 'preferred led', rec.leaders.map((x) => x.pref_led),
    'terms', rec.leaders.map((x) => JSON.stringify(x.terms)), 'rss MB', (rec.mem ?? []).map((m) => (m.rss_kb / 1024).toFixed(0)), '->', (rec.mem2 ?? []).map((m) => (m.rss_kb / 1024).toFixed(0)), 'load', la.split(' ')[0]);
}

patchHost();
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
for (let r = 0; r < RUNS; r++) for (const R of SCALES) { if (have(`${TAG}-R${R}`) > r) continue; await run(R, r); }
