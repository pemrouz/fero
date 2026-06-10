//! CLI launcher: `npm run observe -- <name> --connect host:port[,…] [--port] [--poll]` → dial the cluster, serve the dashboard, print the localhost URL.
// tools/observe/index.ts — the `npm run observe` entry point.
//
// Starts an observer bridge over a NETWORK source (dials a running cluster as a
// read-only client) and serves the dashboard on localhost. For harness war games
// the in-process source is used directly from a test (see bridge.ts) — this CLI is
// the real/remote path.

import { bridge, networkSource } from './bridge.ts'

//! Parse argv: first bare token is the resource name; --connect is the seed list; --port/--poll/--host tune the bridge.
const args = process.argv.slice(2)
let name = 'fero'
let seeds: string[] = []
let port = 7100
let poll = 1000
let host = '127.0.0.1'
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--connect' || a === '-c') seeds = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  else if (a === '--port' || a === '-p') port = +args[++i]
  else if (a === '--poll') poll = +args[++i]
  else if (a === '--host') host = args[++i]
  else if (!a.startsWith('-')) name = a
}

if (!seeds.length) {
  console.error('usage: npm run observe -- <name> --connect host:port[,host:port] [--port 7100] [--poll 1000]')
  console.error('  the cluster servers must be started with `observe: true`')
  process.exit(1)
}

const b = await bridge({ source: networkSource({ seeds, name, host }), port, host, poll })
console.log(`fero observe — watching ${seeds.join(', ')} (resource "${name}", poll ${poll}ms)`)
console.log(`  open ${b.url}`) // localhost, not 127.0.0.1 — WSL2/VSCode forwarding only resolves under localhost

//! Clean shutdown on Ctrl-C: close the bridge (drops the mesh client + ends SSE) then exit.
const shutdown = () => void b.close().then(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
