// E-65 X2 timing: scan every row of a resource held by W server processes (G groups), from one asking process,
// over TCP on one box, page by page, with credit (backpressure). Nothing here holds every row.
//
//   node --expose-gc src/bench-scan.mjs --rows=10000000 --G=16 --W=4 --set=main|writes|sweep|quick --run=1 [--out=...]
//
// Sets of scans (each one measured on its own, after a forced collection):
//   main    base (whole rows as JSON, pages of 1,000, credit 2, every group at once), proj (one field and the
//           key), col (one field as raw float64, no keys), filter10 (a filter pushed to the servers, 10 % kept),
//           seq (one group at a time), rowiter (`for await` per row), median (one field kept here, 8 B a row,
//           then sorted: an exact median), workers2 and workers4 (the scan split over 2 or 4 asking threads,
//           each with its own share of the groups, then their sums added up)
//   writes  writes on every group while the scan runs: none+w reads live rows; cut+w pins every group and
//           each group's sum must equal its sum at the pin
//   sweep   page size 100, 1,000, 10,000; credit 1 and 8; one group at a time with credit 8; a slow loop
// The check: every scan with no writes must see exactly the rows the servers hold, with their sum (and the
// servers' own count above 899, and the median from their counts per value).
import { fork } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { args, out } from './lib.mjs'
import { Conn, Scan } from './client.mjs'

const o = args(process.argv.slice(2), { rows: 1e6, G: 16, W: 4, set: 'quick', run: 0, out: '', heap: 3000, only: '' })
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('./scan-worker.mjs', import.meta.url))
const load0 = os.loadavg()[0]

// ── servers: groups g with g % W == w live on server w ──
const servers = []
for (let w = 0; w < o.W; w++) {
  const gs = []; for (let g = 0; g < o.G; g++) if (g % o.W === w) gs.push(g)
  const child = fork(SERVER, [`--groups=${gs.join(',')}`, `--G=${o.G}`, `--rows=${o.rows}`, `--seed=${w + 1}`], { execArgv: [`--max-old-space-size=${o.heap}`] })
  servers.push({ child, gs, ready: new Promise((res) => child.once('message', res)) })
}
const tb = performance.now()
const info = await Promise.all(servers.map((s) => s.ready))
const buildS = (performance.now() - tb) / 1000
const conns = info.map((i) => new Conn(i.port))
await Promise.all(conns.map((c) => c.ready))
const connOf = new Map(); servers.forEach((s, w) => s.gs.forEach((g) => connOf.set(g, conns[w])))
const allGroups = [...Array(o.G).keys()]

// ── the truth, counted by the servers ──
const tr = await Promise.all(conns.map((c) => c.ask({ t: 'truth' })))
const truth = { count: 0, sum: 0, over: 0, hist: new Array(1000).fill(0) }
for (const t of tr) { truth.count += t.count; truth.sum += t.sum; truth.over += t.over; t.hist.forEach((x, i) => (truth.hist[i] += x)) }
{ let acc = 0; const want = (truth.count - 1) >> 1; for (let v = 0; v < 1000; v++) { acc += truth.hist[v]; if (acc > want) { truth.median = v; break } } }
out(o.out, { kind: 'setup', run: o.run, rows: o.rows, G: o.G, W: o.W, buildS: +buildS.toFixed(1), held: truth.count, serverBuildMs: info.map((i) => Math.round(i.buildMs)), load0, node: process.version })

// ── one measured scan ──
async function stats(reset) { return Promise.all(conns.map((c) => c.ask({ t: 'stats', reset }))) }
async function measure(name, scanOpts, work, extra = {}) {
  global.gc?.()
  const sc = new Scan(conns, connOf, allGroups, scanOpts)
  const s0 = await stats(true)
  const bytes0 = conns.reduce((a, c) => a + c.bytes, 0)
  const mem0 = process.memoryUsage()
  let peakRss = mem0.rss, peakHeap = mem0.heapUsed
  const timer = setInterval(() => { const m = process.memoryUsage(); if (m.rss > peakRss) peakRss = m.rss; if (m.heapUsed > peakHeap) peakHeap = m.heapUsed }, 20)
  const c0 = process.cpuUsage(), t0 = performance.now()
  const res = await work(sc)
  const ms = performance.now() - t0, cpu = process.cpuUsage(c0)
  clearInterval(timer)
  const m1 = process.memoryUsage(); if (m1.rss > peakRss) peakRss = m1.rss; if (m1.heapUsed > peakHeap) peakHeap = m1.heapUsed
  const s1 = await stats(false)
  const srvMs = s1.reduce((a, s, i) => a + (s.cpu.user + s.cpu.system) - (s0[i].cpu.user + s0[i].cpu.system), 0) / 1000
  const looked = res.looked ?? sc.looked
  const line = {
    kind: 'scan', run: o.run, name, rows: o.rows, G: o.G, W: o.W, ...scanOpts, ...extra,
    sec: +(ms / 1000).toFixed(3), rowsPerSec: Math.round(looked / (ms / 1000)), looked, got: res.count,
    askerCpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(3), askerNsPerRow: Math.round(((cpu.user + cpu.system) * 1000) / looked),
    serverCpuSec: +(srvMs / 1000).toFixed(3), serverNsPerRow: Math.round((srvMs * 1e6) / looked),
    baseRssMB: +(mem0.rss / 1048576).toFixed(1), peakRssMB: +(peakRss / 1048576).toFixed(1), baseHeapMB: +(mem0.heapUsed / 1048576).toFixed(1), peakHeapMB: +(peakHeap / 1048576).toFixed(1),
    MBrecv: +((conns.reduce((a, c) => a + c.bytes, 0) - bytes0) / 1048576).toFixed(1),
    ok: res.ok, note: res.note ?? '', serverPeakImages: s1.reduce((a, s) => a + s.peakImages, 0), serverWrote: s1.reduce((a, s) => a + s.wrote, 0),
    serverRssMB: s1.map((s) => Math.round(s.rss / 1048576)), load0, loadEnd: os.loadavg()[0],
  }
  out(o.out, line)
  return line
}

const work = {
  sum: async (sc) => { let count = 0, sum = 0; for await (const [, page] of sc.pages()) for (const [, r] of page) { count++; sum += r.n } return { count, ok: count === truth.count && sum === truth.sum } },
  proj: async (sc) => { let count = 0, sum = 0; for await (const [, page] of sc.pages()) for (const [, v] of page) { count++; sum += v } return { count, ok: count === truth.count && sum === truth.sum } },
  col: async (sc) => { let count = 0, sum = 0; for await (const [, page] of sc.pages()) for (let i = 0; i < page.length; i++) { count++; sum += page[i] } return { count, ok: count === truth.count && sum === truth.sum } },
  filter: async (sc) => { let count = 0; for await (const [, page] of sc.pages()) for (const [, r] of page) if (r.n > 899) count++; return { count, ok: count === truth.over } },
  rowiter: async (sc) => { let count = 0, sum = 0; for await (const [, r] of sc.rows()) { count++; sum += r.n } return { count, ok: count === truth.count && sum === truth.sum } },
  median: async (sc) => {
    const a = new Float64Array(truth.count); let n = 0
    for await (const [, page] of sc.pages()) for (let i = 0; i < page.length; i++) a[n++] = page[i]
    const t = performance.now(); a.sort(); const med = a[(n - 1) >> 1]
    return { count: n, ok: n === truth.count && med === truth.median, note: `sort ${Math.round(performance.now() - t)} ms, median ${med}` }
  },
  slow: async (sc) => { // about 2 µs of the loop's own work a row: the servers are faster than the loop
    let count = 0, x = 0
    for await (const [, page] of sc.pages()) for (const [, r] of page) { count++; for (let i = 0; i < 300; i++) x = (x + r.n * i) | 0 }
    return { count, ok: count === truth.count, note: String(x & 1) }
  },
  workers: (k) => async (sc) => { // k asking threads, each with its own share of the groups; the shares are added up
    const ports = info.map((i) => i.port), groupsOf = servers.map((s) => s.gs)
    const res = await Promise.all([...Array(k).keys()].map((i) => new Promise((resolve, reject) => {
      const mine = allGroups.filter((g) => g % k === i)
      const w = new Worker(WORKER, { workerData: { ports, groupsOf, mine, opts: { limit: sc.limit, credit: sc.credit }, id: sc.id * 100 + i } })
      w.once('message', resolve); w.once('error', reject)
    })))
    const count = res.reduce((a, r) => a + r.count, 0), sum = res.reduce((a, r) => a + r.sum, 0)
    return { count, looked: res.reduce((a, r) => a + r.looked, 0), ok: count === truth.count && sum === truth.sum, note: `${k} threads` }
  },
}

const sets = {
  quick: [['base', { limit: 1000, credit: 2 }, 'sum'], ['col', { enc: 'col', limit: 4000, credit: 2 }, 'col'], ['workers2', { limit: 1000, credit: 2 }, 'workers2']],
  main: [
    ['base', { limit: 1000, credit: 2 }, 'sum'],
    ['proj', { enc: 'proj', limit: 1000, credit: 2 }, 'proj'],
    ['col', { enc: 'col', limit: 4000, credit: 2 }, 'col'],
    ['filter10', { limit: 1000, credit: 2, gt: 899 }, 'filter'],
    ['seq', { limit: 1000, credit: 2, sequential: true }, 'sum'],
    ['rowiter', { limit: 1000, credit: 2 }, 'rowiter'],
    ['median', { enc: 'col', limit: 4000, credit: 2 }, 'median'],
    ['workers2', { limit: 1000, credit: 2 }, 'workers2'],
    ['workers4', { limit: 1000, credit: 2 }, 'workers4'],
  ],
  sweep: [
    ['p100', { limit: 100, credit: 2 }, 'sum'], ['p1000', { limit: 1000, credit: 2 }, 'sum'], ['p10000', { limit: 10000, credit: 2 }, 'sum'],
    ['c1', { limit: 1000, credit: 1 }, 'sum'], ['c8', { limit: 1000, credit: 8 }, 'sum'],
    ['seq-c8', { limit: 1000, credit: 8, sequential: true }, 'sum'], ['col-seq', { enc: 'col', limit: 4000, credit: 2, sequential: true }, 'col'],
    ['slow', { limit: 1000, credit: 2 }, 'slow'],
  ],
  writes: [['none+w', { limit: 1000, credit: 2 }, 'cut', 5000], ['cut+w', { limit: 1000, credit: 2, cut: true }, 'cut', 5000]],
}
for (const [name, opts, wk, perSec] of sets[o.set] ?? []) {
  if (o.only && !o.only.split(',').includes(name)) continue
  if (!perSec) { await measure(name, opts, wk.startsWith('workers') ? work.workers(Number(wk.slice(7))) : work[wk]); continue }
  // writes on every group while the scan runs: 'cut+w' pins and keeps images; 'none+w' reads live rows
  await Promise.all(conns.map((c) => c.ask({ t: 'writes', perSec })))
  await measure(name, { ...opts, check: !!opts.cut }, async (sc) => {
    const by = new Float64Array(o.G), cnt = new Int32Array(o.G)
    for await (const [g, page] of sc.pages()) for (const [, r] of page) { by[g] += r.n; cnt[g]++ }
    await Promise.all(conns.map((c) => c.ask({ t: 'writes', perSec: 0 })))
    const count = cnt.reduce((a, b) => a + b, 0)
    let ok = count === truth.count, note = ''
    if (opts.cut) { // each group's sum must be its sum at the pin, though writes went on all through the scan
      const ps = Object.assign({}, ...(await Promise.all(conns.map((c) => c.ask({ t: 'pinsums', scan: sc.id })))).map((a) => a.r))
      let bad = 0; for (let g = 0; g < o.G; g++) if (ps[g][0] !== by[g] || ps[g][1] !== cnt[g]) bad++
      ok = ok && bad === 0; note = `groups whose sum differs from the pin's: ${bad} of ${o.G}`
    }
    return { count, ok, note }
  }, { writesPerSecPerGroup: perSec })
}
for (const c of conns) c.send({ t: 'quit' })
setTimeout(() => process.exit(0), 300)
