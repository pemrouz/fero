// B11: what E-10's real TypeScript Raft port costs per write, as a stand-in for 2.9's "replication pipeline" line.
// E-02's pipeline (the line PATHS.md 2.9 first used) runs no Raft: no terms, no Raft messages per group, no Ready
// loop. E-11 ran E-10's port (a line-by-line port of etcd's raft) in three processes on loopback, but only up to
// 10,000 writes a second. This driver runs E-11's own TS host, unchanged and read from its folder
// (../../../E11-many-groups/ts/host.ts), at the rates PATHS.md's busy budget uses. The host: one replica of each of
// N groups per process, one TCP link per peer, quiet groups on (ticks of 500 ms), one Raft entry per write of
// 100 B, all Ready entries of a loop round in one journal write and one fdatasync, then the messages, one frame
// per peer (etcd's persist-then-send order). Writes go to the groups each process leads (leaders spread g % 3).
// What it reports, as E-11's bench.mjs does: CPU of each process (getrusage, every thread) over a 6 s window after
// a 4 s warm-up, commits a second, and commit p50/p99 on the proposing leader; per write = cluster CPU / commits.
// Usage: node raftport.mjs <groups> <writes a second>     prints one JSON line. Data files go in $WORK/raft.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, '..', '..', '..', 'E11-many-groups', 'ts', 'host.ts')
const n = Number(process.argv[2] ?? 1), rate = Number(process.argv[3] ?? 50000)
const dir = path.join(process.env.WORK || path.join(HERE, 'tmp'), 'raft')
fs.rmSync(dir, { recursive: true, force: true })
const base = 24000 + Math.floor(Math.random() * 3000) * 3
const ports = [base, base + 1, base + 2].join(',')
const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim()
const procs = [], lines = [[], [], []], ready = []
const t0 = Date.now()
for (let i = 1; i <= 3; i++) {
  const p = spawn('node', ['--expose-gc', '--max-old-space-size=6144', '--experimental-strip-types', '--no-warnings', HOST, `id=${i}`, `n=${n}`,
    'mode=quiet', 'tick=500', 'elect=4', 'ping=500', `rate=${rate}`, 'hot=1', 'size=100', 'warm=4000', 'dur=6000', `dir=${dir}`, 'fsync=1', `ports=${ports}`],
  { stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-4000) }); p.errText = () => err
  procs.push(p)
  ready.push(new Promise((res) => readline.createInterface({ input: p.stdout }).on('line', (l) => { if (l === 'ready') res(); else lines[i - 1].push(l) })))
}
const exited = procs.map((p) => new Promise((res) => p.on('exit', res)))
const timeout = (ms) => new Promise((res) => setTimeout(() => res('timeout'), ms))
const r = await Promise.race([Promise.all(ready), timeout(60000), ...exited.map((e) => e.then(() => 'exit'))])
if (r === 'timeout' || r === 'exit') { for (const p of procs) p.kill('SIGKILL'); console.error(procs.map((p) => p.errText()).join('\n---\n')); throw new Error('cluster did not start: ' + r) }
const readyMs = Date.now() - t0
for (const p of procs) p.stdin.write('go\n')
const done = await Promise.race([Promise.all(exited), timeout(60000)])
if (done === 'timeout') { for (const p of procs) p.kill('SIGKILL'); throw new Error('no exit') }
const nodes = lines.map((l) => { const j = l.find((x) => x.startsWith('{')); return j ? JSON.parse(j) : null })
if (nodes.some((x) => !x)) { console.error(procs.map((p) => p.errText()).join('\n---\n')); throw new Error('no result') }
fs.rmSync(dir, { recursive: true, force: true })
const sum = (k) => nodes.reduce((s, x) => s + x[k], 0)
const commits = sum('commits_s'), cores = sum('cores')
console.log(JSON.stringify({ bench: 'raftport', groups: n, rate, loadavg, ready_ms: readyMs, commits_s: Math.round(commits),
  cluster_cores: +cores.toFixed(3), us_per_write: +(cores * 1e6 / commits).toFixed(1), busiest_cores: +Math.max(...nodes.map((x) => x.cores)).toFixed(3),
  per_process_us: nodes.map((x) => +(x.cores * 1e6 / commits).toFixed(1)), fsyncs_s: nodes.map((x) => Math.round(x.fsyncs_s)), frames_s: nodes.map((x) => Math.round(x.frames_s)),
  p50_ms: +Math.max(...nodes.filter((x) => x.commits_s > 0).map((x) => x.p50)).toFixed(2), p99_ms: +Math.max(...nodes.filter((x) => x.commits_s > 0).map((x) => x.p99)).toFixed(2),
  leaders: nodes.map((x) => x.leaders), node: process.version }))
process.exit(0)
