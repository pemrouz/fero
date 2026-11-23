// E-63 driver: one run of one cell. Starts three servers (a leader and two followers, each with its own journal)
// and the client, lines up t0, and prints one merged JSON line.
//   node run.mjs <form> <rows> <shape> [quick] [leader node flag ...]
//   form: A | B | Bs | B2 | M1 | M3 | none, or a B form with +rule or +budget (server.mjs says what each is)
//   rows: e.g. 1000000   shape: small | big   env WATCH_MS (M3; default 500), GCSTATS=1 (log every GC pause on
//   each server's two threads), RATE (writes a second; default 50000)
// Every process gets --max-old-space-size=3800, so none goes past 4 GB of heap. Journals go to $JDIR (a folder
// on the real disk), one file per server, removed at the end.
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'

const [form, rows, shape, ...rest] = process.argv.slice(2)
const quick = rest[0] === 'quick'
const leaderFlags = rest.filter((a) => a.startsWith('--'))
const HERE = path.dirname(new URL(import.meta.url).pathname)
const NODE = process.execPath
const BASE = ['--expose-gc', '--experimental-strip-types', '--no-warnings', '--max-old-space-size=3800']
const phases = quick ? { warm: 1000, steady: 3000, stall: 2000, after: 2000 } : { warm: 3000, steady: 10000, stall: 5000, after: 5000 }
const JDIR = process.env.JDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'e63-'))
fs.mkdirSync(JDIR, { recursive: true })

// ports from 20000-29999, below Linux's ephemeral range, so an outgoing connection cannot take one between this
// check and the server's own listen
const freePort = () => new Promise((r) => { const tryOne = () => { const p = 20000 + Math.floor(Math.random() * 10000), s = net.createServer(); s.once('error', tryOne); s.listen(p, '127.0.0.1', () => s.close(() => r(p))) }; tryOne() })
const peerPorts = [await freePort(), await freePort(), await freePort()], clientPorts = [await freePort(), await freePort(), await freePort()]
const kids = []
const start = (args, name) => {
  const c = spawn(NODE, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
  const lines = []; let waiters = []
  readline.createInterface({ input: c.stdout }).on('line', (l) => { lines.push(l); waiters = waiters.filter((w) => !w(l)) })
  const next = (pred) => new Promise((res) => { const w = (l) => { if (pred(l)) { res(JSON.parse(l)); return true } return false }; for (const l of lines) if (w(l)) return; waiters.push(w) })
  c.on('exit', (code) => { if (code) console.error(`${name} exited ${code}`) })
  kids.push(c)
  return { c, next, say: (s) => c.stdin.write(s + '\n') }
}
const kill = () => { for (const k of kids) try { k.kill('SIGKILL') } catch {} }
const deadline = setTimeout(() => { console.error('run timed out'); kill(); process.exit(2) }, 300000)

const servers = [0, 1, 2].map((id) => {
  const cfg = { id, form, rows: +rows, shape, peerPorts, clientPorts, dir: JDIR, hbMs: 100, watchMs: +(process.env.WATCH_MS || 500), stallMs: phases.stall, phases }
  return start([...BASE, ...(id === 0 ? leaderFlags : []), path.join(HERE, 'server.mjs'), JSON.stringify(cfg)], 'server ' + id)
})
await Promise.all(servers.map((s) => s.next((l) => l.startsWith('{"ready"'))))
const t0 = Date.now() + 1500 // absolute ms (performance.timeOrigin + performance.now() in each process)
const RATE = +(process.env.RATE || 50000)
const clientCfg = { ports: clientPorts, rate: RATE, rows: +rows, shape, t0, phases, bar: 5.73 }
const client = start([...BASE, path.join(HERE, 'client.mjs'), JSON.stringify(clientCfg)], 'client')
for (const s of servers) s.say('go ' + t0)
const { stall } = await servers[0].next((l) => l.startsWith('{"stall"'))
const drained = await client.next((l) => l.startsWith('{"client_done"'))
await new Promise((r) => setTimeout(r, 500)) // the followers learn the last commit from a heartbeat (100 ms)
for (const s of [...servers, client]) s.say(`phases ${stall.s0} ${stall.s1}`)
const [leader, f1, f2, cl] = await Promise.all([...servers.map((s) => s.next((l) => l.startsWith('{"exp"'))), client.next((l) => l.startsWith('{"role":"client"'))])
cl.drained_after_end_ms = drained.drained_after_end_ms
clearTimeout(deadline)
const fol = (f) => ({ digest: f.digest, rows_end: f.rows_end, leader_msg_gap: f.leader_msg_gap, eld_main_steady: f.eld_main_steady, eld_worker_steady: f.eld_worker_steady, cores_steady: f.cores_steady, elu_main_steady: f.elu_main_steady, elu_worker_steady: f.elu_worker_steady, gc_main: f.gc_main, gc_worker: f.gc_worker, copy_bytes: f.copy_bytes, folded: f.folded, fold_rejects: f.fold_rejects, mem_after_load: f.mem_after_load, mem_end: f.mem_end, log: f.log, events_ms_after_s0: f.events_ms_after_s0, events: f.events })
console.log(JSON.stringify({ exp: 'E-63', form, rows: +rows, shape, rate: RATE, quick, gcstats: process.env.GCSTATS === '1', leader_flags: leaderFlags, watch_ms: form === 'M3' ? +(process.env.WATCH_MS || 500) : null, phases, leader, followers: [fol(f1), fol(f2)], client: cl }))
kill()
if (!process.env.JDIR) fs.rmSync(JDIR, { recursive: true, force: true })
process.exit(0)
