// E-08 driver: one configuration, RUNS times. Run it under the timing lock.
//   node bench.mjs impl=node|rust subs=1000|10000 rate=max|half|halfcpu|<records/s> [mode=tcp|ws] [tls=0|1] [runs=3]
//   halfcpu: the relay's cost per delivery rises as load falls (fewer records per write), so half of the max
//   rate can still fill a core; halfcpu sweeps down from half the max rate, halving it (3 s probes, kept in the
//   results as rate_label "sweep"), until the relay uses at most 0.6 of a core, and runs there (for latency)
//                  [warm=2000] [dur=8000] [procs=2] [out=results/runs.jsonl] [tag=]
// Per run: start the relay; start `procs` subscriber processes (Rust, epoll) holding subs/procs links each,
// every link in one of 64 rooms; when all have joined, start the feed (Rust) at `rate` (max = as fast as the
// relay takes it, through backpressure; half = half of the median records/s of this configuration's max runs).
// CPU of every process is read from /proc/<pid>/stat at the window's start and end; the relay's CPU apart.
// Prints and appends one JSON line per run.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const BIN = process.env.E08_BIN || `${SP}/e08/target/release`
const a = { tick: process.env.TICK ?? 'immediate', impl: 'node', subs: '1000', rate: 'max', mode: 'tcp', tls: '0', runs: '3', warm: '2000', dur: '8000', procs: '2', out: path.join(HERE, 'results/runs.jsonl'), tag: '' }
for (const x of process.argv.slice(2)) { const i = x.indexOf('='); a[x.slice(0, i)] = x.slice(i + 1) }
fs.mkdirSync(path.dirname(a.out), { recursive: true })
const tickOf = (r) => (r.impl === 'node' ? (r.tick ?? 'data') : 'read-until-empty')
const key = (r) => [r.impl, r.subs, r.mode, r.tls, r.tag, tickOf(r)].join('|')

const ticks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const x = f.slice(f.lastIndexOf(')') + 2).split(' '); return +x[11] + +x[12] } catch { return null } }
const boxBusy = () => { const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return f.slice(0, 8).reduce((s, v) => s + v, 0) - f[3] - f[4] }

function rateFor() {
  if (a.rate === 'max') return 0
  if (a.rate !== 'half' && a.rate !== 'halfcpu') return +a.rate
  const xs = fs.readFileSync(a.out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.ok && r.rate_label === 'max' && key(r) === key(a)).map((r) => r.recs_in_per_s).sort((p, q) => p - q)
  if (!xs.length) throw new Error('no max run for ' + key(a))
  return Math.round(xs[Math.floor(xs.length / 2)] / 2)
}

const collect = (p) => { const o = { out: '', err: '' }; p.stdout?.on('data', (d) => (o.out += d)); p.stderr?.on('data', (d) => (o.err += d)); return o }
const exit = (p) => new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.on('exit', (c) => r(c))))
const json = (o) => { const l = o.out.split('\n').filter((x) => x.startsWith('{')); return l.length ? JSON.parse(l[l.length - 1]) : null }

async function runOnce(run, rate, label = a.rate, warm = a.warm, dur = a.dur) {
  const base = 21000 + Math.floor(Math.random() * 4000) * 2 // below the ephemeral range (32768+), so no client socket holds it
  const feedPort = base, subPort = base + 1
  const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim()
  const relay = a.impl === 'node'
    ? spawn('node', [path.join(HERE, 'relay.mjs'), String(feedPort), String(subPort), a.mode, String(4 << 20), a.tls], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(`${BIN}/relay`, [String(feedPort), String(subPort), String(4 << 20)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const ro = collect(relay)
  await new Promise((r) => setTimeout(r, 400))
  const n = +a.subs, P = +a.procs, per = Math.ceil(n / P)
  const subs = [], so = []
  const t0 = Date.now()
  for (let i = 0; i < P; i++) {
    const p = spawn(`${BIN}/subs`, [String(subPort), String(Math.min(per, n - i * per)), String(i * per), String(warm), String(dur), a.mode], { stdio: ['pipe', 'pipe', 'pipe'] })
    subs.push(p); so.push(collect(p))
  }
  await new Promise((res, rej) => { const iv = setInterval(() => { if (so.every((o) => /ready/.test(o.err))) { clearInterval(iv); res() } if (Date.now() - t0 > 60000) { clearInterval(iv); rej(new Error('subs not ready: ' + so.map((o) => o.err).join('|'))) } }, 20) })
  const joinMs = Date.now() - t0
  await new Promise((r) => setTimeout(r, 300))
  const start = Date.now() + 500, ws = start + +warm, we = ws + +dur
  for (const p of subs) p.stdin.write(start + '\n')
  const feed = spawn(`${BIN}/feed`, [String(feedPort), String(rate), String(start), String(we)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const fo = collect(feed)
  const pids = { relay: relay.pid, feed: feed.pid, subs: subs.map((p) => p.pid) }
  let c0, c1, b0, b1
  const snap = () => ({ relay: ticks(pids.relay), feed: ticks(pids.feed), subs: pids.subs.map(ticks) })
  setTimeout(() => { c0 = snap(); b0 = boxBusy() }, ws - Date.now())
  setTimeout(() => { c1 = snap(); b1 = boxBusy() }, we - Date.now())
  const kill = setTimeout(() => [relay, feed, ...subs].forEach((p) => p.kill('SIGKILL')), we - Date.now() + 20000)
  const codes = await Promise.all([exit(feed), ...subs.map(exit), exit(relay)])
  clearTimeout(kill)
  const R = json(ro), F = json(fo), S = so.map(json)
  const secs = +dur / 1000
  const base_ = { tag: a.tag, tick: a.impl === 'node' ? (process.env.TICK ?? 'immediate') : 'read-until-empty', impl: a.impl, subs: n, mode: a.mode, tls: a.tls, procs: P, rate, rate_label: label, run, loadavg, join_ms: joinMs }
  if (!R || !F || S.some((x) => !x) || !c0 || !c1) {
    const bad = { ...base_, ok: false, codes, errs: [ro.err, fo.err, ...so.map((o) => o.err)].map((e) => e.slice(0, 300)) }
    fs.appendFileSync(a.out, JSON.stringify(bad) + '\n'); console.log(JSON.stringify(bad)); return null
  }
  const cores = (k) => (c1[k] - c0[k]) / 100 / secs
  const relayCores = cores('relay'), feedCores = cores('feed'), subsCores = c1.subs.map((v, i) => (v - c0.subs[i]) / 100 / secs)
  const deliv = S.reduce((s, x) => s + x.deliveries_win, 0)
  const r = {
    ...base_, ok: true, deliveries_per_s: Math.round(deliv / secs), recs_in_per_s: Math.round(deliv / secs / (n / 64)),
    fanout: n / 64, relay_cores: +relayCores.toFixed(3), per_relay_core: Math.round(deliv / secs / Math.max(relayCores, 0.01)),
    subs_cores: subsCores.map((x) => +x.toFixed(2)), feed_cores: +feedCores.toFixed(2), box_busy_cores: +((b1 - b0) / 100 / secs).toFixed(2),
    lat_us_p50: Math.max(...S.map((x) => x.lat_us.p50)), lat_us_p99: Math.max(...S.map((x) => x.lat_us.p99)), lat_us_p999: Math.max(...S.map((x) => x.lat_us.p999)), lat_us_max: Math.max(...S.map((x) => x.lat_us.max)),
    relay_out: R, feed_out: F, codes,
  }
  fs.appendFileSync(a.out, JSON.stringify(r) + '\n')
  console.log(JSON.stringify(r))
  return r
}

let rate = rateFor()
if (a.rate === 'halfcpu') {
  for (let k = 0; k < 7; k++) {
    const r = await runOnce(0, rate, 'sweep', 1000, 3000)
    if (r && r.relay_cores <= 0.6) break
    rate = Math.max(1000, Math.round(rate / 2))
  }
}
for (let i = 1; i <= +a.runs; i++) await runOnce(i, rate)
