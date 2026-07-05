//! ── tools/debug/serve — the debug server: scenario dashboard + debugger, over captures OR a live cluster ──
//   npm run debug                                     # scenario dashboard at /, debugger at /debug
//   npm run debug -- captures/seed-42.json            # open a saved capture in the debugger
//   npm run debug -- --live                           # spin a real 3-node TCP cluster + traffic, poll it live
//   npm run debug -- --live --contend                 # ...with a DELIBERATELY conflicting workload (LWW demo)
//
// Routes:
//   /                → scenarios.html (dashboard) — or the debugger when a capture file / --live was given
//   /scenarios       → scenarios.html
//   /scenarios.json  → run the registry (cached; ?rerun=1 re-runs) — read-only: baselines are pinned by the CLI only
//   /debug           → viewer.html (the debugger); ?scenario=<id> loads that scenario's capture
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

//! --live: three real Runtimes over real TCP on this machine + an OWNER-ROUTED traffic generator.
// Every key is written by exactly ONE node (the M3 owner-routing rule, applied at the workload
// layer) — so the steady state shows ZERO contention, which is the design intent: conflicts are
// not this system's normal weather. `--contend` flips to random-origin writes over a shared
// keyset so LWW elections (and the debugger's contested-cells view) can be demonstrated.
const runtimes: Runtime[] = []
if (flag('live')) {
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  for (let i = 0; i < 3; i++)
    runtimes.push(new Runtime({
      uuid: `n${i + 1}`, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i),
      redialMs: 200, heartbeatMs: 2000, journalCap: 1 << 16,
    }))
  for (const r of runtimes) await r.start()
  const keys = ['sessions', 'users', 'orders', 'metrics', 'flags']
  const ownerOf = (key: string) => // deterministic key→node: the single-writer rule
    runtimes[[...key].reduce((h, c) => h + c.charCodeAt(0), 0) % runtimes.length]
  let n = 0
  setInterval(() => {
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

const server = http.createServer((req, res) => {
  const [url, qs] = (req.url ?? '/').split('?')
  try {
    if (url === '/') {
      // a capture file or --live means the user came to DEBUG that — land them in the debugger
      if (captureFile || flag('live')) page(res, 'viewer.html')
      else page(res, 'scenarios.html')
    } else if (url === '/scenarios' || url === '/scenarios.html') {
      page(res, 'scenarios.html')
    } else if (url === '/scenarios.json') {
      json(res, JSON.stringify(scenarios(new URLSearchParams(qs).has('rerun')).results))
    } else if (url === '/debug' || url === '/viewer.html') {
      page(res, 'viewer.html')
    } else if (url === '/model.mjs') {
      page(res, 'model.mjs', 'text/javascript')
    } else if (url.startsWith('/capture/')) {
      const id = url.slice('/capture/'.length).replace(/\.json$/, '')
      const c = scenarios(false).captures.get(id)
      if (!c) { res.writeHead(404); res.end(`no scenario capture: ${id}`); return }
      json(res, JSON.stringify(c))
    } else if (url === '/capture.json') {
      if (flag('live')) json(res, JSON.stringify(captureLive(runtimes.map((r) => r.node))))
      else if (captureFile) json(res, readFileSync(captureFile).toString())
      else { res.writeHead(404); res.end('no capture source — open a scenario from /, or pass a file / --live') }
    } else {
      res.writeHead(404); res.end('not found')
    }
  } catch (e) {
    res.writeHead(500); res.end(String(e))
  }
})
server.listen(port, () => {
  const mode = captureFile ? `capture: ${captureFile}` : flag('live') ? 'LIVE cluster' : 'scenario dashboard'
  console.log(`fero v3 → http://localhost:${port}/  (${mode})`)
  console.log(`  dashboard http://localhost:${port}/scenarios · debugger http://localhost:${port}/debug`)
})
