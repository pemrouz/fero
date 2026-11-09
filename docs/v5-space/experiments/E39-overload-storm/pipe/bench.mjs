// E-39 (a) driver: E-02's pipeline (leader with a client front: leader.ts or rs leader; E-02's own followers)
// under open-loop clients that retry. Run it under the timing lock.
//   node bench.mjs impl=ts|rust mult=max|0.5|1|1.5|2 [policy=bounded|unbounded] [client=naive|jitter] [runs=3]
//                  [procs=1] (load processes; links, rates and window are split evenly) [p1=15] [p2=10] (phase seconds)
//   client  naive (retry at once) | jitter (retry-after + full-jitter backoff) | credit (jitter, plus a client-side
//           window of `limit` outstanding writes, split over the load processes: writes beyond it wait in the client)
//   max   closed loop: the load keeps `window` writes outstanding for 15 s, no retries; its goodput is the maximum
//   mult  open loop: phase 1 offers mult x max (median of this impl's max runs) for 15 s, phase 2 drops to
//         0.5 x max for 10 s (does the tail recover?). The first 3 s of phase 1 are warm-up.
// The bounded leader admits at most limit = max x 5 ms records between admission and commit.
// Journals are preallocated 512 MiB segments on the real disk ($SP/e39/j), reused in a ring.
// Prints and appends one JSON line per run to results/pipe.jsonl.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const E02 = path.resolve(HERE, '../../E02-pipeline')
const BIN = `${SP}/e39/target/release`
const E02BIN = `${SP}/e01e02/target-pipe/release/pipeline`
const a = { procs: '1', p1: '15', p2: '10', impl: 'ts', mult: 'max', policy: 'bounded', client: 'jitter', runs: '3', window: '20000', links: '4', timeout: '200', deadline: '2000', out: path.join(HERE, '../results/pipe.jsonl') }
for (const x of process.argv.slice(2)) { const i = x.indexOf('='); a[x.slice(0, i)] = x.slice(i + 1) }
const SEG = 512 << 20
const ticks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const x = f.slice(f.lastIndexOf(')') + 2).split(' '); return +x[11] + +x[12] } catch { return null } }

function maxOf() {
  const xs = fs.readFileSync(a.out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok && r.impl === a.impl && r.mult === 'max').map((r) => r.goodput).sort((p, q) => p - q)
  if (!xs.length) throw new Error('no max run for ' + a.impl)
  return xs[Math.floor(xs.length / 2)]
}

async function runOnce(run) {
  const dir = `${SP}/e39/j`
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  for (const f of ['j.0.0', 'j.1.0', 'j.2.0']) execFileSync('fallocate', ['-l', String(SEG), `${dir}/${f}`])
  const max = a.mult === 'max' ? null : maxOf()
  const limit = max ? Math.max(1000, Math.round(max * 0.005)) : 1e9
  const phases = a.mult === 'max' ? `0:${a.p1}` : `${Math.round(+a.mult * max)}:${a.p1},${Math.round(0.5 * max)}:${a.p2}`
  const secs = +a.p1 + (a.mult === 'max' ? 0 : +a.p2) + 4
  const base = 21000 + Math.floor(Math.random() * 2600) * 3 // below the ephemeral range (32768+)
  const fport = [base + 1, base + 2], cport = base
  const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim()
  const start = Date.now() + 1500
  const fargs = (id) => ['role=follower', `id=${id}`, `port=${fport[id - 1]}`, `dir=${dir}`, 'mode=persisted', 'size=100', 'groups=1', 'rate=0', `start=${start}`, 'warm=0', `dur=${(secs + 6) * 1000}`, 'drain=0', `seg=${SEG}`, 'workers=0']
  const fol = [1, 2].map((id) => a.impl === 'ts'
    ? spawn('node', ['--experimental-strip-types', '--no-warnings', path.join(E02, 'ts/pipeline.ts'), ...fargs(id)], { stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn(E02BIN, fargs(id), { stdio: ['ignore', 'ignore', 'pipe'] }))
  const largs = [`port=${cport}`, `peers=${fport.join(',')}`, `dir=${dir}`, `seg=${SEG}`, `policy=${a.mult === 'max' ? 'unbounded' : a.policy}`, `limit=${limit}`, `secs=${secs}`]
  const leader = a.impl === 'ts'
    ? spawn('node', ['--max-old-space-size=3072', '--experimental-strip-types', '--no-warnings', path.join(HERE, 'leader.ts'), ...largs], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(`${BIN}/leader`, largs, { stdio: ['ignore', 'pipe', 'pipe'] })
  let lout = '', lerr = ''; leader.stdout.on('data', (d) => (lout += d)); leader.stderr.on('data', (d) => (lerr += d))
  await new Promise((r, j) => { const iv = setInterval(() => { if (/leader ready/.test(lerr)) { clearInterval(iv); r() } }, 20); setTimeout(() => j(new Error('leader not ready: ' + lerr)), 20000) })
  // `procs` load processes share the links, the rates and the window evenly
  const N = +a.procs
  const ph = phases.split(',').map((x) => { const [r, t] = x.split(':'); return `${Math.round(+r / N)}:${t}` }).join(',')
  const loads = Array.from({ length: N }, () => spawn(`${BIN}/load`, [String(cport), String(Math.max(1, Math.round(+a.links / N))), ph, a.client === 'naive' ? 'naive' : 'jitter', a.timeout, a.deadline, String(a.mult === 'max' ? Math.round(+a.window / N) : 0), String(a.client === 'credit' ? Math.max(1, Math.round(limit / N)) : 0)], { stdio: ['ignore', 'pipe', 'pipe'] }))
  const oouts = loads.map(() => ''), oerrs = loads.map(() => '')
  loads.forEach((l, i) => { l.stdout.on('data', (d) => (oouts[i] += d)); l.stderr.on('data', (d) => (oerrs[i] += d)) })
  const pids = () => [leader.pid, ...fol.map((f) => f.pid), ...loads.map((l) => l.pid)]
  let c0, c1
  setTimeout(() => (c0 = pids().map(ticks)), 4000)
  setTimeout(() => (c1 = pids().map(ticks)), (+a.p1) * 1000)
  const codes = await Promise.all([leader, ...loads].map((p) => new Promise((r) => p.on('exit', r))))
  for (const f of fol) f.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
  let L = null, Os = null
  try { L = JSON.parse(lout.trim().split('\n').pop()); Os = oouts.map((o) => JSON.parse(o.trim().split('\n').pop())) } catch {}
  const base_ = { exp: 'E-39', part: 'pipe', impl: a.impl, mult: a.mult, policy: a.mult === 'max' ? 'unbounded' : a.policy, client: a.client, procs: N, run, loadavg, max, limit, timeout_ms: +a.timeout, deadline_ms: +a.deadline }
  if (!L || !Os) { const bad = { ...base_, ok: false, codes, err: (lerr + oerrs.join('')).slice(0, 500) }; fs.appendFileSync(a.out, JSON.stringify(bad) + '\n'); console.log(JSON.stringify(bad)); return }
  const cores = c0 && c1 ? c1.map((v, i) => +(((v - c0[i]) / 100) / (+a.p1 - 4)).toFixed(2)) : null
  // merge the load processes: counts add; latency percentiles take the worst process (conservative)
  const P = Os[0].phases.map((_, k) => {
    const xs = Os.map((o) => o.phases[k]); const m = { ...xs[0] }
    for (const x of xs) x.client_dropped_per_s ??= 0
    for (const f of ['offered_per_s', 'goodput_per_s', 'wasted_per_s', 'refused_per_s', 'retries_per_s', 'timeouts_per_s', 'giveups_per_s', 'client_dropped_per_s']) m[f] = xs.reduce((t, x) => t + x[f], 0)
    m.rate = xs.reduce((t, x) => t + x.rate, 0)
    m.adm_ms = { p50: Math.max(...xs.map((x) => x.adm_ms.p50)), p99: Math.max(...xs.map((x) => x.adm_ms.p99)), p999: Math.max(...xs.map((x) => x.adm_ms.p999)) }
    m.e2e_ms = { p50: Math.max(...xs.map((x) => x.e2e_ms.p50)), p99: Math.max(...xs.map((x) => x.e2e_ms.p99)) }
    return m
  })
  const O = { max_attempts_pending: Os.reduce((t, o) => t + o.max_attempts_pending, 0), series: Os[0].series.map((b, i) => {
    const xs = Os.map((o) => o.series[i]); const m = { ...b }
    for (const f of ['new', 'good', 'refused', 'retries', 'timeouts', 'wasted']) m[f] = xs.reduce((t, x) => t + x[f], 0)
    m.adm_p99 = Math.max(...xs.map((x) => x.adm_p99)); return m }) }
  const r = { ...base_, ok: true, goodput: Math.round(P[0].goodput_per_s), phase1: P[0], phase2: P[1] ?? null,
    cores_phase1: cores ? { leader: cores[0], f1: cores[1], f2: cores[2], load: +cores.slice(3).reduce((t, x) => t + x, 0).toFixed(2) } : null, max_attempts_pending: O.max_attempts_pending,
    series: O.series.map((b) => [b.t, b.new, b.good, b.refused, b.retries, b.timeouts, b.wasted, b.adm_p99]), leader_series: L.series.map((s) => [s.t, s.committed, s.refused, s.queued, s.inflight, s.cores]) }
  fs.appendFileSync(a.out, JSON.stringify(r) + '\n')
  const { series, leader_series, ...short } = r
  console.log(JSON.stringify(short))
}
for (let i = 1; i <= +a.runs; i++) await runOnce(i)
