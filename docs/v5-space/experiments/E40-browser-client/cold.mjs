// E-40 (c): cold-client time (start, import, connect, TLS, door, first committed write) in Node, in a Chromium
// page and in a Chromium dedicated Web Worker. Run it under the timing lock.
//   node cold.mjs [runs=10] [out=results/cold.jsonl]
// Starts server.mjs (wss + a static http origin), builds the bundle into $SP/e40/static (bundle.mjs), then per
// run: a fresh `node cold-node.mjs` process; a fresh headless Chromium (Playwright) loading cold.html, which
// imports client.mjs and connects; and the same with mode=worker. Each browser run launches its own browser,
// so no TLS session or cache survives from the run before. Prints and appends one JSON line per run.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const CERTS = process.env.CERTS || `${SP}/e40/certs`
const STATIC = `${SP}/e40/static`
const [RUNS = '10', OUT = path.join(HERE, 'results/cold.jsonl')] = process.argv.slice(2)
const { chromium } = createRequire('/opt/node-tools/node_modules/')('playwright')
fs.mkdirSync(STATIC, { recursive: true })
execFileSync('node', [path.join(HERE, 'bundle.mjs'), STATIC], { stdio: ['ignore', 'ignore', 'inherit'] })
for (const f of ['cold.html', 'worker.mjs']) fs.copyFileSync(path.join(HERE, 'static-src', f), path.join(STATIC, f))
const wssPort = 21000 + Math.floor(Math.random() * 4000), httpPort = wssPort + 4000 // below the ephemeral range (32768+)
const srv = spawn('node', ['--experimental-strip-types', '--no-warnings', path.join(HERE, 'server.mjs'), String(wssPort), String(httpPort), STATIC, '100'], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((r) => srv.stdout.on('data', (d) => { if (/ready/.test(d)) r() }))
const wss = `wss://127.0.0.1:${wssPort}/ws`
const write = (o) => { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)) }
const loadavg = () => fs.readFileSync('/proc/loadavg', 'utf8').trim()

for (let run = 1; run <= +RUNS; run++) {
  // Node
  const la = loadavg()
  const out = execFileSync('node', [path.join(HERE, 'cold-node.mjs'), path.join(STATIC, 'client.mjs'), wss], { env: { ...process.env, NODE_EXTRA_CA_CERTS: CERTS + '/cert.pem' } }).toString()
  write({ exp: 'E-40', part: 'cold', run, loadavg: la, ...JSON.parse(out.trim().split('\n').pop()) })
  // Chromium page and worker
  for (const mode of ['page', 'worker']) {
    const la2 = loadavg()
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${httpPort}/cold.html?mode=${mode}&wss=${encodeURIComponent(wss)}`)
    await page.waitForFunction(() => window.__r !== undefined, null, { timeout: 20000 })
    const r = await page.evaluate(() => window.__r)
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { response_end: +n.responseEnd.toFixed(2), dom_interactive: +n.domInteractive.toFixed(2) } : null })
    write({ exp: 'E-40', part: 'cold', run, loadavg: la2, browser: browser.version(), nav, ...r })
    await browser.close()
  }
}
srv.kill()
