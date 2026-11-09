// E-27 orchestrator: one run of "10,000 idle links in one Node server, then 1,000 active subscribers".
//   node e27.mjs <tcp|tls> [links=10000] [idleSec=60] [activeSec=30] [out=results/runs.jsonl] [run=1]
// 1. fork the server (server.mjs, --expose-gc); GC; read its memory (the baseline).
// 2. fork two client processes with links/2 links each (at most 200 dialing at a time per process). Links with
//    id < 1,000 join rooms 0..99 (ten per room); the others join rooms of their own that never get traffic.
// 3. when every link has joined: wait 5 s, GC, read the server's memory again. Per link = the difference / links.
// 4. idle: read the server's CPU ticks, wait idleSec with only the heartbeat (one ping per link per 30 s, and
//    its pong), read them again: the idle CPU as a share of one core.
// 5. active: the server publishes 10 messages a second to each of rooms 0..99, so each of the 1,000 active
//    subscribers gets 10 a second (10,000 deliveries a second), while the other links stay idle. After 5 s of
//    warm-up the clients' latency histograms are cleared; then activeSec of measurement: server CPU, delivery
//    latency (the worse of the two client processes), and memory.
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const CERTS = process.env.CERTS || `${SP}/e27/certs`
const [MODE = 'tcp', LINKS = '10000', IDLE = '60', ACTIVE = '30', OUT = path.join(HERE, 'results/runs.jsonl'), RUN = '1'] = process.argv.slice(2)
const links = +LINKS
const port = 21000 + Math.floor(Math.random() * 8000) // below the ephemeral range (32768+), so no client socket holds it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ask = (p, msg, key) => new Promise((r) => { const h = (m) => { if (m[key] !== undefined) { p.off('message', h); r(m[key]) } }; p.on('message', h); p.send(msg) })
const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim()

const server = fork(path.join(HERE, 'server.mjs'), [String(port), MODE, CERTS], { execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
await new Promise((r) => server.once('message', r))
await sleep(500)
await ask(server, { cmd: 'gc' }, 'gc')
const base = await ask(server, { cmd: 'stats' }, 'stats')

const t0 = Date.now()
const half = links / 2
const clients = [0, 1].map((i) => fork(path.join(HERE, 'client.mjs'), [String(port), MODE, String(half), String(i * half), '100', 'none', '200', '1000'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }))
let cs
for (;;) {
  await sleep(200)
  cs = await Promise.all(clients.map((c) => ask(c, { cmd: 'stats' }, 'stats')))
  if (cs.reduce((s, c) => s + c.subscribed, 0) >= links) break
  if (Date.now() - t0 > 180000) { console.error('not all links joined', cs); process.exit(1) }
}
const joinMs = Date.now() - t0
const peak = await ask(server, { cmd: 'stats' }, 'stats')
await sleep(5000)
await ask(server, { cmd: 'gc' }, 'gc')
const held = await ask(server, { cmd: 'stats' }, 'stats')

// idle CPU with the heartbeat running
const i0 = await ask(server, { cmd: 'stats' }, 'stats'); const it0 = Date.now()
await sleep(+IDLE * 1000)
const i1 = await ask(server, { cmd: 'stats' }, 'stats'); const it1 = Date.now()

// active phase
await ask(server, { cmd: 'publish', rooms: 100, perSec: 10 }, 'publishing')
await sleep(5000)
await Promise.all(clients.map((c) => ask(c, { cmd: 'reset' }, 'reset')))
const a0 = await ask(server, { cmd: 'stats' }, 'stats'); const at0 = Date.now()
await sleep(+ACTIVE * 1000)
const a1 = await ask(server, { cmd: 'stats' }, 'stats'); const at1 = Date.now()
const ca = await Promise.all(clients.map((c) => ask(c, { cmd: 'stats' }, 'stats')))
await ask(server, { cmd: 'gc' }, 'gc')
const after = await ask(server, { cmd: 'stats' }, 'stats')

const MB = (b) => +(b / 2 ** 20).toFixed(1)
const r = {
  exp: 'E-27', mode: MODE, links, run: +RUN, loadavg, node: process.version, join_s: +(joinMs / 1000).toFixed(2),
  base_rss_mb: MB(base.vmrss_kb * 1024), held_rss_mb: MB(held.vmrss_kb * 1024), peak_hwm_mb: MB(peak.vmhwm_kb * 1024),
  per_link_kb: +((held.vmrss_kb - base.vmrss_kb) / links).toFixed(2),
  per_link_heap_kb: +((held.heap_used - base.heap_used) / 1024 / links).toFixed(2),
  per_link_external_kb: +((held.external - base.external) / 1024 / links).toFixed(2),
  links_held: held.links, resumed: cs.reduce((s, c) => s + c.resumed, 0), full_handshakes: cs.reduce((s, c) => s + c.full_handshakes, 0),
  idle_cpu_pct_core: +(((i1.cpu_ticks - i0.cpu_ticks) / 100) / ((it1 - it0) / 1000) * 100).toFixed(2),
  idle_seconds: +((it1 - it0) / 1000).toFixed(1),
  active_cpu_pct_core: +(((a1.cpu_ticks - a0.cpu_ticks) / 100) / ((at1 - at0) / 1000) * 100).toFixed(2),
  active_deliveries_per_s: Math.round(ca.reduce((s, c) => s + c.lat_us.n, 0) / ((at1 - at0) / 1000)),
  active_lat_us: { p50: Math.max(...ca.map((c) => c.lat_us.p50)), p99: Math.max(...ca.map((c) => c.lat_us.p99)), p999: Math.max(...ca.map((c) => c.lat_us.p999)), max: Math.max(...ca.map((c) => c.lat_us.max)) },
  after_active_rss_mb: MB(after.vmrss_kb * 1024),
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.appendFileSync(OUT, JSON.stringify(r) + '\n')
console.log(JSON.stringify(r))
for (const c of clients) c.kill('SIGKILL')
server.kill('SIGKILL')
process.exit(0)
