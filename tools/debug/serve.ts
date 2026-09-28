//! ── tools/debug/serve — the debug server: scenario dashboard + debugger, over captures, a live cluster, OR a remote attach ──
//   npm run debug                                     # scenario dashboard at /, debugger at /debug
//   npm run debug -- captures/seed-42.json            # open a saved capture in the debugger
//   npm run debug -- --live                           # spin a real 5-node TCP cluster + traffic, poll it live
//   npm run debug -- --live --nodes 3                 # ...at another size
//   npm run debug -- --live --contend                 # ...with a DELIBERATELY conflicting workload (LWW demo)
//   FERO_DIAG_TOKEN=… npm run debug -- --attach h:p,h:p   # dash a REAL (multi-process) cluster over the DIAG wire
//
// Routes:
//   /                → scenarios.html (dashboard) — or the debugger when a capture file / --live was given
//   /scenarios       → scenarios.html
//   /scenarios.json  → run the registry (cached; ?rerun=1 re-runs) — read-only: baselines are pinned by the CLI only
//   /debug           → viewer.html (the debugger); ?scenario=<id> loads that scenario's capture
//   /model.mjs, /eli5.mjs → the shared model + ELI5 glossary modules (the SAME bytes the tests import)
//   /capture/<id>.json → the named scenario's capture from the cached run
//   /capture.json    → the file capture, or a live snapshot rebuilt ON REQUEST
//
// The live mode is the pull-spine made minimal (v2 DECISIONS O, kept): /capture.json
// rebuilds a truthful snapshot from the running nodes ON REQUEST — no push channel,
// no relay buffer with its own cadence to lie about (v2's 10%-temporal-coverage bug
// class). The viewer polls; what it renders is exactly what the nodes held at poll
// time, journals included. The debugger does not depend on the machinery under test:
// captures are built by direct in-process reads, never routed through the cluster.

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../../shell/runtime.ts'
import { captureLive } from './capture.ts'
import { AttachPool } from './attach.ts'
import { runAll } from './scenarios.ts'
import { ports } from '#utils'
import { REC, type Rec } from '../../kernel/env.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : dflt
}
const captureFile = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const port = opt('port', 4699)

//! --attach (M7): the DIAG-wire consumer — /capture.json is rebuilt by FRESH pulls from a REAL
// (multi-process) cluster per HTTP request (the pull-spine crossing process boundaries). The token
// rides FERO_DIAG_TOKEN, never argv (ps-visible). Mutually exclusive with --live: two node sources
// for one /capture.json would be a lie about what you're looking at.
const attachArg = (() => { const i = args.indexOf('--attach'); return i >= 0 ? (args[i + 1] ?? '') : null })()
if (attachArg !== null && flag('live')) {
  console.error('--live and --attach are two node sources for one /capture.json — pick one')
  process.exit(2)
}
const pool = attachArg !== null ? new AttachPool(attachArg.split(',').filter(Boolean), process.env.FERO_DIAG_TOKEN ?? '') : null

//! --live: N real Runtimes (default 5 — the M7 live-dash) over real TCP on this machine + an
// OWNER-ROUTED traffic generator. Every key is written by exactly ONE node (the M3 owner-routing
// rule, applied at the workload layer) — so the steady state shows ZERO contention, which is the
// design intent: conflicts are not this system's normal weather. The workload's char-sum owner is
// UNCORRELATED with the kernel ring, so most writes enter at a non-ring-owner and the kernel
// owner-forwards them — which is exactly what lights up the cid write-route timeline (issued →
// forwarded → sequenced → applied) in the debugger. `--contend` flips to random-origin writes over
// a shared keyset so LWW elections (and the contested-cells view) can be demonstrated.
const runtimes: Runtime[] = []
let traffic: NodeJS.Timeout | null = null // the live workload's clock — cleared by the clean stop
if (flag('live')) {
  const N = Math.max(2, opt('nodes', 5))
  const ps = await Promise.all(Array.from({ length: N }, () => ports.free()))
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  for (let i = 0; i < N; i++)
    runtimes.push(new Runtime({
      uuid: `n${i + 1}`, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i),
      redialMs: 200, heartbeatMs: 2000, journalCap: 1 << 16,
    }))
  for (const r of runtimes) await r.start()
  const keys = ['sessions', 'users', 'orders', 'metrics', 'flags']
  const ownerOf = (key: string) => // deterministic key→node: the single-writer rule
    runtimes[[...key].reduce((h, c) => h + c.charCodeAt(0), 0) % runtimes.length]
  let n = 0
  traffic = setInterval(() => {
    const key = keys[Math.floor(Math.random() * keys.length)] + Math.floor(Math.random() * 5)
    const r = flag('contend') ? runtimes[Math.floor(Math.random() * runtimes.length)] : ownerOf(key)
    const roll = Math.random()
    const rec: Rec =
      roll < 0.1 ? { type: REC.remove, key: [key] }
      : roll < 0.55 ? { type: REC.update, key: [key], value: { n: ++n, by: r.node.uuid, at: new Date().toISOString() } }
      : { type: REC.update, key: [key, 'score'], value: Math.round(Math.random() * 1000) }
    r.write([rec])
  }, 250)
  console.log(`live cluster: ${addrs.join(' ')} — ${flag('contend') ? 'CONTENDING' : 'owner-routed'} writes every 250ms`)
}

//! the scenario runs are cached per process; ?rerun=1 re-executes the registry (~1.5s, all virtual-time)
let scen: ReturnType<typeof runAll> | null = null
const scenarios = (rerun: boolean) => (scen = rerun || !scen ? runAll() : scen)

const page = (res: http.ServerResponse, file: string, type = 'text/html') => {
  res.writeHead(200, { 'content-type': type })
  res.end(readFileSync(join(HERE, file)))
}
const json = (res: http.ServerResponse, body: string) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const [url, qs] = (req.url ?? '/').split('?')
  try {
    if (url === '/') {
      // a capture file, --live, or --attach means the user came to DEBUG that — land them in the debugger
      if (captureFile || flag('live') || pool) page(res, 'viewer.html')
      else page(res, 'scenarios.html')
    } else if (url === '/scenarios' || url === '/scenarios.html') {
      page(res, 'scenarios.html')
    } else if (url === '/scenarios.json') {
      json(res, JSON.stringify(scenarios(new URLSearchParams(qs).has('rerun')).results))
    } else if (url === '/debug' || url === '/viewer.html') {
      page(res, 'viewer.html')
    } else if (url === '/model.mjs') {
      page(res, 'model.mjs', 'text/javascript')
    } else if (url === '/eli5.mjs') {
      page(res, 'eli5.mjs', 'text/javascript')   // the shared ELI5 glossary + tooltip layer, imported by BOTH pages
    } else if (url.startsWith('/capture/')) {
      const id = url.slice('/capture/'.length).replace(/\.json$/, '')
      const c = scenarios(false).captures.get(id)
      if (!c) { res.writeHead(404); res.end(`no scenario capture: ${id}`); return }
      json(res, JSON.stringify(c))
    } else if (url === '/capture.json') {
      if (flag('live')) json(res, JSON.stringify(captureLive(runtimes.map((r) => r.node))))
      else if (pool) json(res, JSON.stringify(await pool.capture())) // fresh pulls per request; concurrent requests coalesce
      else if (captureFile) {
        //! a file that is not there YET is not a server error: a role may write it a moment after the debugger
        // started (23-live) — a typed 404 tells the viewer to wait and ask again, where a 500 read as "broken"
        try { json(res, readFileSync(captureFile).toString()) }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          res.writeHead(404); res.end(`no capture yet: ${captureFile} is not there — the viewer asks again every 1.5 s`)
        }
      }
      else { res.writeHead(404); res.end('no capture source — open a scenario from /, or pass a file / --live / --attach') }
    } else {
      res.writeHead(404); res.end('not found')
    }
  } catch (e) {
    res.writeHead(500); res.end(String(e))
  }
})
server.listen(port, () => {
  const mode = captureFile ? `capture: ${captureFile}`
    : flag('live') ? `LIVE cluster (${runtimes.length} nodes)`
    : pool ? `ATTACHED via DIAG: ${attachArg}`
    : 'scenario dashboard'
  console.log(`fero v4 → http://localhost:${port}/  (${mode})`)
  console.log(`  dashboard http://localhost:${port}/scenarios · debugger http://localhost:${port}/debug`)
})

//! Ctrl-C / SIGTERM is the clean stop — the rule a fero role follows (V4-8), applied to the debugger: the listener
// closes, the DIAG sessions hang up, the live runtimes leave, and the process exits 0. Without this Node's default
// let the signal kill the process (exit null), and a driver holding the pipes — a check, the site recorder,
// `fero.spawn(...).stop()` — could not stop the debugger the way it stops a role. A stop that stalls (a runtime
// whose leave never settles) still exits 0 after five seconds, like fero.spawn's own SIGKILL rung.
const stop = async () => {
  setTimeout(() => process.exit(0), 5000).unref()
  if (traffic) clearInterval(traffic)
  server.closeAllConnections()
  server.close()
  pool?.close()
  for (const r of runtimes) await r.destroy()
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void stop() })
