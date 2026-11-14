// E-53: the hand-back's pace, measured on three processes of the patched host (host-patch.mjs: E-26's host on
// E-10's TypeScript Raft port, with E-49's patches and the hand-back's). One run, per R:
//   scenario=restart  boot with every group led by its preferred member (E-26's start campaign, used here only to
//                     reach a balanced start quickly); kill -9 member 2; the survivors elect for its groups
//                     (failover, timed); start member 2 again from its journal (restore=1) until every group it
//                     holds knows its leader; then the hand-back gives back what member 2 should lead (about R/3)
//   scenario=cold     a whole-project cold boot by Raft's random timers (E-49's start=random); then every member
//                     takes back its own (about 2R/3 in all)
// Then, after settle= seconds (the design's settle.ms is 30 s; the harness waits less, see README), every member
// is told `handback` with the pace: pace=rate:10 (DESIGN-V5's ten a second), pace=cap:K (V5-7: K in flight), or
// pace=none (no hand-back: the control). order=random|busy (busiest first by recent writes). load=L runs
// client.mjs on L random groups at wrate= writes a second each, from the settle's start to post= seconds after
// the hand-back ends. max=S stops the hand-back after S seconds (for ten a second at large R) and the time to even
// out is then computed from the rate it held.
// Measured: time until every group is led by its preferred member and until 99% are (from each member's own
// completion times), each transfer's time, failed transfers and retries, elections (Raft's own steps, counted),
// CPU per process (/proc), and with load the commit latency of the writes, split into before, during, after, and
// writes that met their own group's move.
// Usage (under $SP/bin/timing): node handback.mjs scenario=restart|cold scales=1000,10000 pace=cap:32 [order=random]
//                                [load=0 wrate=10] [settle=10] [max=0] [runs=1] [tag=...] [out=handback.jsonl]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { patchHost } from './host-patch.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const SCEN = args.scenario || 'restart', RUNS = Number(args.runs || 1), SCALES = (args.scales || '1000,10000').split(',').map(Number);
const PACE = args.pace || 'cap:32', ORDER = args.order || 'random', LOAD = Number(args.load || 0), WRATE = Number(args.wrate || 10);
const SETTLE = Number(args.settle ?? 10), MAXS = Number(args.max || 0), POST = Number(args.post ?? (LOAD ? 6 : 1)), WINDOW = Number(args.window || 10);
const KILL = Number(args.kill || 0), TOUT = Number(args.timeout || 3000), WAITS = Number(args.wait || 40);   // the liveness check (kill=, timeout=, wait=)
// added after the skeptic's check: probe=S reads each survivor's transfers still set (host patch 17) S seconds after
// the kill, then lets a write reach each such group and reads again 3 s later; xferawake=1 runs the hosts with patch
// 18 (a group with a transfer in flight does not go quiet)
const PROBE = Number(args.probe || 0), XAWAKE = args.xferawake === '1';
const TICK = 100, ELECT = 20, JITTER = 5;   // DESIGN-V5: 100 ms ticks, election.ms 2 s, election.jitter 500 ms
const TAG = args.tag || `${SCEN}-${PACE.replace(':', '')}-${ORDER}${LOAD ? `-L${LOAD}w${WRATE}` : ''}${SETTLE !== 10 ? `-s${SETTLE}` : ''}${MAXS ? `-max${MAXS}` : ''}${KILL ? `-kill${KILL}-t${TOUT}` : ''}${XAWAKE ? '-xawake' : ''}`;
const OUT = path.resolve(HERE, 'results', args.out || 'handback.jsonl');
const HOST = path.join(SP, 'e53', 'host', 'host.ts');
const [PKIND, PVAL] = PACE.split(':');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wall = () => performance.timeOrigin + performance.now();
const ticks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); } catch { return NaN; } };
const have = (tag) => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l.includes(`"tag":"${tag}"`) && !l.includes('"failed":')).length : 0;   // a failed run is kept, and run again
const pct = (xs, p) => { if (!xs.length) return null; const s = Float64Array.from(xs).sort(); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2); };
const stats = (xs) => xs.length ? { n: xs.length, p50: pct(xs, 0.5), p99: pct(xs, 0.99), max: +Math.max(...xs).toFixed(2) } : { n: 0 };

// ---------------------------------------------------------------- a process with JSON lines out
function proc(cmd, argv) {
  const p = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { p, got: new Map(), waiters: new Map(), err: '', exited: new Promise((r) => p.on('exit', r)) };
  p.stderr.on('data', (d) => { h.err += d; if (h.err.length > 8000) h.err = h.err.slice(-8000); });
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    let m; if (l === 'ready') m = { ok: 'ready', t: wall() }; else if (l.startsWith('{')) { try { m = JSON.parse(l); } catch { return; } } else return;
    const k = m.ok ?? m.impl; const w = h.waiters.get(k);
    if (w && w.length) w.shift()(m); else { if (!h.got.has(k)) h.got.set(k, []); h.got.get(k).push(m); }
  });
  return h;
}
const want = (h, k, ms = 60000) => new Promise((res, rej) => {
  const q = h.got.get(k); if (q && q.length) return res(q.shift());
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${k}: ${h.err.slice(-1500)}`)), ms);
  if (!h.waiters.has(k)) h.waiters.set(k, []); h.waiters.get(k).push((m) => { clearTimeout(t); res(m); });
});
const ask = (h, line, k, ms) => { h.p.stdin.write(line + '\n'); return want(h, k, ms); };
const host = (id, R, dir, ports, cport, start, extra = []) => proc('node', ['--expose-gc', '--max-old-space-size=6144', HOST, `id=${id}`, `n=${R}`, 'mode=quiet', `tick=${TICK}`,
  `elect=${ELECT}`, `jitter=${JITTER}`, `start=${start}`, 'ping=500', 'rate=0', `dir=${dir}`, 'fsync=1', `ports=${ports}`, `max=${R + 10}`, `cport=${cport}`, ...(XAWAKE ? ['xferawake=1'] : []), ...extra]);
const statAll = (H) => Promise.all(H.map((h) => ask(h, 'hbstat', 'hbstat', 120000)));
const sumCtr = (ss) => ss.reduce((a, s) => { for (const k in s.ctr) a[k] = (a[k] ?? 0) + s.ctr[k]; return a; }, {});
const diffCtr = (b, a) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));
function pick(R, n, seed) {   // n distinct random groups, the same for a given seed
  let x = (seed * 2654435761) >>> 0 || 1; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const s = new Set(); while (s.size < Math.min(n, R)) s.add(Math.floor(rnd() * R)); return [...s];
}

async function run(R, r) {
  const tag = `${TAG}-R${R}`, dir = path.join(SP, 'e53', 'run');
  fs.rmSync(dir, { recursive: true, force: true });
  const base = 31000 + Math.floor(Math.random() * 800) * 8, ports = [base, base + 1, base + 2].join(','), cports = [base + 4, base + 5, base + 6];
  const la = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  const rec = { exp: 'E-53', tag, R, run: r, scenario: SCEN, pace: PACE, order: ORDER, load: LOAD, wrate: LOAD ? WRATE : 0, settle_s: SETTLE, max_s: MAXS,
    tick_ms: TICK, election_ms: [ELECT * TICK, (ELECT + JITTER) * TICK], loadavg: la };
  const t0 = performance.now();
  const H = [1, 2, 3].map((i) => host(i, R, dir, ports, cports[i - 1], SCEN === 'restart' ? 'preferred' : 'random'));
  let C = null;
  const killAll = () => { for (const h of H) h.p.kill('SIGKILL'); if (C) C.p.kill('SIGKILL'); };
  try {
    await Promise.all(H.map((h) => want(h, 'ready', 600000)));
    rec.boot_ms = +(performance.now() - t0).toFixed(0);
    await sleep(3000);
    if (SCEN === 'restart') {
      let s0 = await statAll(H);
      if (s0.reduce((a, s) => a + s.pref_led, 0) < R) {   // a boot whose start campaigns collided: balance it first (setup, not measured)
        for (const h of H) h.p.stdin.write('handback cap=128 order=random\n');
        const sl = await Promise.all(H.map((h) => want(h, 'handback', 600000)));
        rec.setup_balance = { off: R - s0.reduce((a, s) => a + s.pref_led, 0), ms: Math.max(...sl.map((x) => x.ms)) };
        await sleep(3000); s0 = await statAll(H);
      }
      rec.before = s0.map((s) => ({ led: s.led, pref_led: s.pref_led, awake: s.awake }));
      const v = 1;   // member 2
      const tk = performance.now(); H[v].p.kill('SIGKILL'); await H[v].exited;
      const surv = [0, 2]; let ss;
      for (;;) { ss = await Promise.all(surv.map((i) => ask(H[i], 'hbstat', 'hbstat', 120000))); if (ss[0].led + ss[1].led === R) break; if (performance.now() - tk > 300000) throw new Error('failover did not finish'); await sleep(100); }
      rec.failover_ms = +(performance.now() - tk).toFixed(0);
      rec.failover_elections = diffCtr(sumCtr(ss), sumCtr([s0[0], s0[2]]));
      const tr = performance.now();
      H[v] = host(2, R, dir, ports, cports[v], 'random', ['restore=1']);
      await want(H[v], 'ready', 600000);
      rec.restart_ready_ms = +(performance.now() - tr).toFixed(0);
      await sleep(3000);
    }
    let loaded = [];
    if (LOAD) {
      loaded = pick(R, LOAD, 1000 + r);
      const recFile = path.join(SP, 'e53', `client-${process.pid}.f64`);
      C = proc('node', [path.join(HERE, 'client.mjs'), `cports=${cports.join(',')}`, `groups=${loaded.join(',')}`, `rate=${WRATE}`, `out=${recFile}`]);
      C.file = recFile;
      await want(C, 'client-ready', 30000);
      C.p.stdin.write('start\n'); rec.load_t0 = (await want(C, 'started')).t0;
    }
    await sleep(SETTLE * 1000);
    const st0 = await statAll(H);
    rec.at_start = st0.map((s) => ({ led: s.led, pref_led: s.pref_led, awake: s.awake, nolead: s.nolead }));
    const prefLed0 = st0.reduce((a, s) => a + s.pref_led, 0);
    rec.off_pref = R - prefLed0;
    const cpu0 = H.map((h) => ticks(h.p.pid)), slices = [];
    const tHb = wall(), tHbm = performance.now();
    let lines = [];
    if (KILL) {   // the liveness check: member 3 is killed KILL ms into the hand-back; do members 1 and 2 still take back all of theirs?
      for (const h of H) h.p.stdin.write(`handback ${PKIND}=${PVAL} order=${ORDER} timeout=${TOUT}\n`);
      await sleep(KILL); H[2].p.kill('SIGKILL'); const tKill = performance.now();
      const got = await Promise.all([0, 1].map((i) => want(H[i], 'handback', WAITS * 1000).then((m) => m, () => null)));
      const ss = await Promise.all([0, 1].map((i) => ask(H[i], 'hbstat', 'hbstat', 60000)));
      rec.kill_ms = KILL; rec.timeout_ms = TOUT; rec.wait_s = WAITS; rec.cap = PKIND === 'cap' ? Number(PVAL) : 0; rec.xferawake = XAWAKE;
      if (PROBE) {   // the givers' side: transfers to the dead member still set, and whether a write clears them
        const left = PROBE * 1000 - (performance.now() - tKill); if (left > 0) await sleep(left);
        const x1 = await Promise.all([0, 1].map((i) => ask(H[i], 'xferstat', 'xferstat', 60000)));
        rec.probe_s = +((performance.now() - tKill) / 1000).toFixed(1);
        const wk = await Promise.all([0, 1].map((i) => ask(H[i], 'wakexfer', 'wakexfer', 60000)));
        await sleep(3000);
        const x2 = await Promise.all([0, 1].map((i) => ask(H[i], 'xferstat', 'xferstat', 60000)));
        rec.xfer = x1.map((x, i) => ({ id: x.id, set: x.xfer, quiet: x.quiet, to: x.to, woken: wk[i].n, set_3s_after_a_write: x2[i].xfer, quiet_3s_after: x2[i].quiet }));
      }
      rec.live = ss.map((x, i) => ({ id: x.id, pref: x.pref, pref_led: x.pref_led, finished: !!got[i], ms: got[i] ? got[i].ms : null, fails: got[i] ? got[i].fails : x.hb_fails, in_flight_left: x.hb_inflight }));
      killAll(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true });
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log(tag, 'run', r, 'off', rec.off_pref, 'live', JSON.stringify(rec.live), rec.xfer ? 'xfer ' + JSON.stringify(rec.xfer) : '');
      return;
    }
    if (PKIND !== 'none') {
      const cmd = `handback ${PKIND}=${PVAL} order=${ORDER}${MAXS ? ` max=${MAXS}` : ''}`;
      for (const h of H) h.p.stdin.write(cmd + '\n');
      const done = Promise.all(H.map((h) => want(h, 'handback', (MAXS ? MAXS + 120 : 7200) * 1000)));
      let fin = false; done.then(() => { fin = true; }, () => { fin = true; });
      let prev = cpu0, pt = performance.now();   // 250 ms slices of CPU-seconds per process
      while (!fin) { await sleep(250); const c = H.map((h) => ticks(h.p.pid)), now = performance.now(); slices.push(c.map((x, i) => +((x - prev[i]) / 100).toFixed(2))); prev = c; pt = now; }
      lines = await done;
    } else await sleep(WINDOW * 1000);
    const cpu1 = H.map((h) => ticks(h.p.pid)), tWin = (performance.now() - tHbm) / 1000;
    const peak1s = (i) => { let best = 0; for (let k = 0; k < slices.length; k++) { let s = 0; for (let j = k; j < Math.min(slices.length, k + 4); j++) s += slices[j][i]; best = Math.max(best, s); } return +best.toFixed(2); };   // most CPU in any 1 s (4 slices)
    rec.cpu = H.map((h, i) => ({ cpu_s: +((cpu1[i] - cpu0[i]) / 100).toFixed(2), mean_cores: +((cpu1[i] - cpu0[i]) / 100 / tWin).toFixed(3), peak_1s: slices.length ? peak1s(i) : null }));
    rec.window_s = +tWin.toFixed(2);

    // ---- the hand-back's own record: completions on one clock (wall ms), from tHb
    let tEnd = tHb + WINDOW * 1000;
    const moves = new Map();   // group -> [start, end] of its successful transfer, wall ms
    if (lines.length) {
      const ends = [], durs = [];
      for (const ln of lines) for (let k = 0; k < ln.ev.length; k += 4) {
        const g = ln.ev[k], s = ln.w0 + ln.ev[k + 1], e = ln.w0 + ln.ev[k + 2]; ends.push(e - tHb); if (!ln.ev[k + 3]) durs.push(e - s); moves.set(g, [s, e]);
      }
      ends.sort((x, y) => x - y);
      const need99 = Math.ceil(0.99 * R) - prefLed0;
      rec.hb = lines.map((ln) => ({ id: ln.id, pref: ln.pref, have0: ln.have0, cand: ln.cand, busy: ln.busy, started: ln.started, ok: ln.n_ok, ok_late: ln.ok_late, fails: ln.fails, no_lead: ln.no_lead, stopped: ln.stopped, pref_led_end: ln.pref_led_end, ms: ln.ms }));
      const moved = ends.length, stopped = lines.some((ln) => ln.stopped);
      rec.moved = moved; rec.stopped = stopped;
      rec.fails = lines.reduce((a, ln) => a + ln.fails, 0); rec.ok_late = lines.reduce((a, ln) => a + ln.ok_late, 0); rec.no_lead = lines.reduce((a, ln) => a + ln.no_lead, 0);
      rec.pref_led_end = lines.reduce((a, ln) => a + ln.pref_led_end, 0);
      rec.xfer_ms = stats(durs);
      rec.even_ms = !stopped && rec.pref_led_end === R ? +(moved ? ends[moved - 1] : 0).toFixed(1) : null;
      rec.t99_ms = need99 <= 0 ? 0 : (moved >= need99 ? +ends[need99 - 1].toFixed(1) : null);
      rec.per_s = moved ? +(moved / ((moved ? ends[moved - 1] : 1) / 1000)).toFixed(1) : 0;
      if (stopped) {   // computed: the slowest member's remaining groups at the rate it held
        rec.even_est_ms = Math.round(Math.max(...lines.map((ln) => { const got = ln.n_ok + ln.ok_late, left = ln.cand - got; return left <= 0 ? ln.ms : ln.ms + left / (got / ln.ms); })));
      }
      tEnd = tHb + (moved ? ends[moved - 1] : 0);
    }
    const st1 = await statAll(H);
    rec.at_end = st1.map((s) => ({ led: s.led, pref_led: s.pref_led, awake: s.awake }));
    rec.elections = diffCtr(sumCtr(st1), sumCtr(st0));   // pre: timer elections begun; cand - xfer: timer elections that ran; xfer: transfer campaigns
    rec.timer_elections = rec.elections.cand - rec.elections.xfer;
    rec.term_bumps = st1.reduce((a, s) => a + s.terms, 0) - st0.reduce((a, s) => a + s.terms, 0);
    rec.client_moved = st1.reduce((a, s) => a + s.cmoved, 0) - st0.reduce((a, s) => a + s.cmoved, 0);
    rec.client_waited = st1.reduce((a, s) => a + s.cwaited, 0) - st0.reduce((a, s) => a + s.cwaited, 0);

    // ---- the writes
    if (C) {
      await sleep(POST * 1000);
      C.p.stdin.write('stop\n'); const cs = await want(C, 'client', 30000);
      rec.client = cs;
      const b = fs.readFileSync(C.file); const f = new Float64Array(b.buffer, b.byteOffset, b.length / 8); fs.rmSync(C.file, { force: true });
      const cls = { before: [], during: [], after: [], caught: [], during_other: [], met: [], caught_nomet: [] }, tries = { before: 0, during: 0, after: 0, caught: 0 };
      let metWaited = 0;
      const b0 = tHb - Math.max(2, SETTLE - 2) * 1000, a0 = tEnd + 1000, a1 = tEnd + POST * 1000;
      const loadedSet = new Set(loaded); let loadedMoved = 0, loadedEven = 0;
      for (const [g, [, e]] of moves) if (loadedSet.has(g)) { loadedMoved++; loadedEven = Math.max(loadedEven, e - tHb); }
      const series = new Map();
      const RW = 5;   // client.mjs record: planned, latency, group, tries, waited
      for (let k = 0; k < f.length; k += RW) {
        const tp = f[k], lat = f[k + 1], g = f[k + 2], tr = f[k + 3], wt = f[k + 4];
        const sec = Math.floor((tp - tHb) / 1000); if (!series.has(sec)) series.set(sec, []); series.get(sec).push(lat);
        const mv = moves.get(g), caught = mv && tp >= mv[0] - 50 && tp <= mv[1] + 200;
        // met (added after the skeptic's check): a write that met a transfer, i.e. was answered `moved` or waited at
        // its leader, planned from 50 ms before the hand-back began to 200 ms after it ended
        const met = (tr > 1 || wt > 0) && tp >= tHb - 50 && tp <= tEnd + 200;
        if (met) { cls.met.push(lat); if (wt > 0) metWaited++; }
        if (caught) { cls.caught.push(lat); if (tr > 1) tries.caught++; if (!met) cls.caught_nomet.push(lat); }
        if (tp >= b0 && tp < tHb) { cls.before.push(lat); if (tr > 1) tries.before++; }
        else if (tp >= tHb && tp <= tEnd) { cls.during.push(lat); if (tr > 1) tries.during++; if (!caught) cls.during_other.push(lat); }
        else if (tp >= a0 && tp < a1) { cls.after.push(lat); if (tr > 1) tries.after++; }
      }
      rec.lat = Object.fromEntries(Object.entries(cls).map(([k, xs]) => [k, stats(xs)]));
      rec.lat_retried = tries; rec.met_waited = metWaited;
      // a like-for-like control (added after the skeptic's check): the loaded groups' own caught windows, shifted back
      // into the steady state before the hand-back, so the same groups, the same number of writes and the same
      // packing, with no transfer. Several shifts when the windows fit; each shift's p50 / p99 / max
      const wins = []; for (const g of loaded) { const mv = moves.get(g); if (mv) wins.push([g, mv[0] - 50, mv[1] + 200]); }
      if (wins.length) {
        const w0 = Math.min(...wins.map((w) => w[1])), w1 = Math.max(...wins.map((w) => w[2])), span = w1 - w0;
        const byG = new Map(); for (const [g, s, e] of wins) byG.set(g, [s, e]);
        const shifts = []; for (let D = (w1 - tHb) + 100; w0 - D >= b0 && shifts.length < 8; D += span + 100) shifts.push(D);
        const pl = shifts.map(() => []);
        for (let k = 0; k < f.length; k += RW) { const w = byG.get(f[k + 2]); if (!w) continue; const tp = f[k];
          for (let j = 0; j < shifts.length; j++) if (tp >= w[0] - shifts[j] && tp <= w[1] - shifts[j]) pl[j].push(f[k + 1]); }
        rec.placebo = { span_ms: +span.toFixed(0), shifts_ms: shifts.map((x) => Math.round(x)), lat: pl.map(stats) };
      }
      rec.loaded_moved = loadedMoved; rec.loaded_even_ms = +loadedEven.toFixed(1);
      rec.series = [...series.entries()].sort((x, y) => x[0] - y[0]).map(([s, xs]) => [s, pct(xs, 0.5), pct(xs, 0.99), +Math.max(...xs).toFixed(1), xs.length]);
    }
    rec.slices = slices;
  } catch (e) {
    console.error('FAIL', tag, e.message.slice(0, 600)); killAll(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true });
    rec.failed = e.message.slice(0, 600); fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); return;
  }
  killAll(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true });
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  console.log(tag, 'run', r, 'boot', rec.boot_ms, 'failover', rec.failover_ms ?? '-', 'restart', rec.restart_ready_ms ?? '-', 'off', rec.off_pref, 'moved', rec.moved ?? '-',
    'even', rec.even_ms ?? rec.even_est_ms ?? '-', 't99', rec.t99_ms ?? '-', 'xfer', JSON.stringify(rec.xfer_ms ?? {}), 'fails', rec.fails ?? '-', 'timer elections', rec.timer_elections,
    'cpu', JSON.stringify(rec.cpu), rec.lat ? 'lat ' + JSON.stringify(rec.lat) : '', 'load', la.split(' ')[0]);
}

patchHost(HOST);
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
for (let r = 0; r < RUNS; r++) for (const R of SCALES) { if (have(`${TAG}-R${R}`) > r) continue; await run(R, r); }
