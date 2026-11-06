// host — runs one gateway on the E-22 prototype, so a competitor's own tool can drive fero.
//
//   node --experimental-strip-types --no-warnings host.ts <resp|nats|etcd|kafka> [--key value ...]
//
// It makes one world (the prototype is a simulation: one OS process holds every simulated process,
// with virtual time, a seeded network and a seeded fsync delay), starts three servers s1, s2, s3,
// opens the gateway's resources on all three (so each group has 3 voters), and starts the gateway
// in s1 (a fero server process that also speaks the tool's protocol, as Redis or etcd do), or in a
// client process `gw` with --in client (its writes then go through a server: Y `fwd`).
// It prints `ready <kind> <host:port>` on stdout once it listens, a stats line every --every s on
// stderr, and a summary on SIGINT or SIGTERM.
//
// Keys: --listen host:port   --durability persisted|none   --get held|fresh (RESP)   --seed N
//       --groups N (groups per resource, default 2)   --in server|client   --every 5
//
// Every number this host prints is the SIMULATOR's: a fero kernel is not in the loop. The point
// is that the tool drives the API end to end, not how fast (E-45 is not a timing experiment).

import { fero } from '../E22-api-prototype/proto/index.ts'
import { Stats, type GatewayEnv } from './lib/common.ts'

const argv = process.argv.slice(2)
const kind = argv[0]
const opts: Record<string, string> = {}
for (let i = 1; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!['resp', 'nats', 'etcd', 'kafka'].includes(kind)) { console.error('usage: host.ts <resp|nats|etcd|kafka> [--listen h:p] ...'); process.exit(2) }

const mod = await import(`./lib/${kind}.ts`)
const w = fero.world({ seed: Number(opts.seed ?? 1), shuffle: false, groups: Number(opts.groups ?? 2) })
const servers = ['s1', 's2', 's3'].map((id) => w.proc(id))
const t0 = Date.now()

// the gateway's resources, served by all three servers (v5 places a resource on every server by
// default; the prototype needs each server to open it)
const opened = new Set<string>()
const ensure = async (name: string, ropts: Record<string, unknown>): Promise<void> => {
  if (opened.has(name)) return
  opened.add(name)
  for (const s of servers) await s.run(() => s.fero(name, { server: true, ...ropts }))
}
const declared = mod.resources(opts) as [string, Record<string, unknown>][]
for (const [name, ropts] of declared) await ensure(name, ropts)
await w.settle()

const P = opts.in === 'client' ? w.proc('gw') : servers[0]
const stats = new Stats()
const env: GatewayEnv = {
  fero: (name, o) => P.run(() => P.fero(name, o)),
  ensure: async (name, o) => { await ensure(name, o); await w.settle() },
  id: () => P.run(() => fero.id()),
  now: () => P.run(() => fero.now()),
  run: (fn) => P.run(fn),
  opts, stats,
}
const g = await P.run(() => mod.start(env))
const listen = `${(opts.listen ?? '127.0.0.1:0').split(':')[0]}:${g.port}`
process.stdout.write(`ready ${kind} ${listen} (gateway in ${P.id}; seed ${w.seed}; resources ${declared.map(([n, o]) => `${n} ${JSON.stringify(o)}`).join(', ')})\n`)

const line = (): string => `[${((Date.now() - t0) / 1000).toFixed(1)} s real, ${(w.time / 1000).toFixed(3)} s virtual, ${w.events} events, ${w.history.length} verbs] ${stats.line()} cpu=${cpuS()}s rss=${Math.round(process.memoryUsage().rss / 1e6)}MB`
// the whole fero side's CPU (gateway, three servers, the simulator), as PERF-01 counts the gateway's CPU in fero's numbers
function cpuS(): string { const u = process.cpuUsage(); return ((u.user + u.system) / 1e6).toFixed(2) }
const every = Number(opts.every ?? 5) * 1000
const tick = setInterval(() => process.stderr.write(line() + '\n'), every)
tick.unref()
const stop = async (sig: string): Promise<void> => {
  clearInterval(tick)
  process.stderr.write(`summary (${sig}): ${line()}\n`)
  await g.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))
