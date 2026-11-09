// E-39 (b): a reconnect storm. E-27's edge server holds 10,000 subscribers; it is killed and a new server
// process starts on the same port; every client reconnects and resubscribes from its cursor.
//   node storm.mjs <tcp|tls> <fixed|jitter> [resume=0|1] [links=10000] [out] [run=1]
//   fixed   a client redials 20 ms after each failure (no backoff, no jitter)
//   jitter  full-jitter exponential backoff: random in [0, min(3 s, 50 ms * 2^attempt)]
//   resume  TLS only: both servers share session-ticket keys and clients offer their last ticket, so most
//           reconnects resume (no full handshake); without it every reconnect is a full TLS 1.3 handshake
// Load: 1,000 rooms of 10 subscribers; each room publishes 1 message a second (10,000 deliveries a second).
// Each room's seq is a function of time from a shared epoch, and the new server starts holding the last 64
// messages of each room (as if recovered from the log), so a client catches up from its cursor.
// Phases: steady 10 s (latency, server CPU) -> SIGKILL -> new server at once -> storm: until every link has
// resubscribed (at most 60 s) -> 10 s after. Reports: time from the kill to 50%, 99% and 100% resubscribed,
// the new server's CPU and bytes in the first 10 s, client delivery latency in steady, storm (first 10 s after
// the kill) and after, catch-up messages replayed, shortfalls, full handshakes and resumptions.
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const E27 = path.resolve(HERE, '../../E27-idle-links')
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const CERTS = process.env.CERTS || `${SP}/e27/certs`
const [MODE = 'tcp', POLICY = 'jitter', RESUME = '0', LINKS = '10000', OUT = path.join(HERE, '../results/storm.jsonl'), RUN = '1'] = process.argv.slice(2)
const links = +LINKS, half = links / 2
const port = 21000 + Math.floor(Math.random() * 8000) // below the ephemeral range (32768+): the new server must rebind it while 10,000 client sockets exist
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ask = (p, msg, key) => new Promise((r) => { const h = (m) => { if (m[key] !== undefined) { p.off('message', h); r(m[key]) } }; p.on('message', h); p.send(msg) })
const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim()
const EPOCH = Date.now()
const env = { ...process.env, EPOCH: String(EPOCH), HIST: '64', PUBLISH: '1000,1', ...(RESUME === '1' ? { TICKET_KEYS: crypto.randomBytes(48).toString('hex') } : {}) }
const startServer = async () => {
  const s = fork(path.join(E27, 'server.mjs'), [String(port), MODE, CERTS], { env, execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  await new Promise((r) => s.once('message', r))
  return s
}
let server = await startServer()
const clients = [0, 1].map((i) => fork(path.join(E27, 'client.mjs'), [String(port), MODE, String(half), String(i * half), '1000', POLICY, '200'], { env: { ...process.env, RESUME }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }))
const cstats = (withTimes) => Promise.all(clients.map((c) => ask(c, { cmd: 'stats', withTimes }, 'stats')))
const reset = () => Promise.all(clients.map((c) => ask(c, { cmd: 'reset' }, 'reset')))
const t0 = Date.now()
for (;;) { await sleep(200); const cs = await cstats(false); if (cs.reduce((s, c) => s + c.subscribed, 0) >= links) break; if (Date.now() - t0 > 120000) { console.error('join timeout'); process.exit(1) } }
const joinS = (Date.now() - t0) / 1000
await sleep(3000)
// steady
await reset()
const s0 = await ask(server, { cmd: 'stats' }, 'stats'); const st0 = Date.now()
await sleep(10000)
const s1 = await ask(server, { cmd: 'stats' }, 'stats'); const st1 = Date.now()
const steady = await cstats(false)
// the kill and the new server
await reset()
const before = await cstats(false)
const tKill = performance.timeOrigin + performance.now()
server.kill('SIGKILL')
await new Promise((r) => server.once('exit', r))
server = await startServer()
const tUp = performance.timeOrigin + performance.now()
const n0 = await ask(server, { cmd: 'stats' }, 'stats'); const nt0 = Date.now()
let all = null
for (;;) {
  await sleep(100)
  const cs = await cstats(false)
  const resubs = cs.reduce((s, c) => s + c.sub_at, 0) // hello acks since the kill (sub_at is a count here)
  if (resubs >= links && all === null) all = performance.timeOrigin + performance.now()
  if (Date.now() - nt0 >= 10000 && (all !== null || Date.now() - nt0 > 60000)) break
}
const n1 = await ask(server, { cmd: 'stats' }, 'stats'); const nt1 = Date.now()
const storm = await cstats(true)
await reset()
const a0 = await ask(server, { cmd: 'stats' }, 'stats'); const at0 = Date.now()
await sleep(10000)
const a1 = await ask(server, { cmd: 'stats' }, 'stats'); const at1 = Date.now()
const after = await cstats(false)

const times = storm.flatMap((c) => c.sub_at.map(([t]) => t - tKill)).sort((x, y) => x - y)
const q = (f) => (times.length ? +(times[Math.min(times.length - 1, Math.ceil(f * links) - 1)] / 1000).toFixed(2) : null)
const lat = (cs) => ({ n: cs.reduce((s, c) => s + c.lat_us.n, 0), p50: Math.max(...cs.map((c) => c.lat_us.p50 ?? 0)), p99: Math.max(...cs.map((c) => c.lat_us.p99 ?? 0)), p999: Math.max(...cs.map((c) => c.lat_us.p999 ?? 0)), max: Math.max(...cs.map((c) => c.lat_us.max)) })
const cpu = (x0, x1, ms) => +(((x1.cpu_ticks - x0.cpu_ticks) / 100) / (ms / 1000)).toFixed(3)
const sum = (cs, k) => cs.reduce((s, c) => s + c[k], 0)
const r = {
  exp: 'E-39', part: 'storm', mode: MODE, policy: POLICY, resume: RESUME === '1', links, run: +RUN, loadavg, node: process.version, join_s: +joinS.toFixed(2),
  restart_ms: +(tUp - tKill).toFixed(0),
  resub_s: { p50: q(0.5), p99: q(0.99), all: times.length >= links ? q(1) : null, count: times.length },
  steady: { lat_us: lat(steady), server_cores: cpu(s0, s1, st1 - st0) },
  storm: { lat_us: lat(storm), server_cores_first_10s: cpu(n0, n1, nt1 - nt0), bytes_out: n1.bytes_out - n0.bytes_out, replayed_msgs: n1.replayed - n0.replayed, hellos: n1.hellos - n0.hellos, shortfalls: n1.shortfalls - n0.shortfalls, handshake_errors: n1.handshake_errors,
    client_dial_errors: sum(storm, 'dial_errors') - sum(before, 'dial_errors'), full_handshakes: sum(storm, 'full_handshakes') - sum(before, 'full_handshakes'), resumed: sum(storm, 'resumed') - sum(before, 'resumed'), peak_rss_mb: +(n1.vmhwm_kb / 1024).toFixed(0) },
  after: { lat_us: lat(after), server_cores: cpu(a0, a1, at1 - at0) },
}
r.p99_ratio_storm_to_steady = r.steady.lat_us.p99 ? +(r.storm.lat_us.p99 / r.steady.lat_us.p99).toFixed(2) : null
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.appendFileSync(OUT, JSON.stringify(r) + '\n')
console.log(JSON.stringify(r))
for (const c of clients) c.kill('SIGKILL')
server.kill('SIGKILL')
process.exit(0)
