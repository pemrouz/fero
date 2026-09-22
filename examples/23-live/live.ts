import { renameSync, writeFileSync } from 'node:fs'
import { fero } from '../../api/index.ts'
import { JK, diag } from '../../internals.ts'

// three servers in one process: they find each other by name, like three terminals would
const opts = { server: true, journal: { cap: 65536 } }
const nodes = [await fero('live', opts), await fero('live', opts), await fero('live', opts)]
let tick = 0, n = 0

console.log('pid', process.pid)

// a small workload: every 300 ms the next node rewrites one of six rows, each row by one node only
setInterval(() => {
    const f = nodes[tick % 3]
    f.data[`s${tick % 6}`] = { tick, by: f.cluster.me.snapshot().uuid }
    tick++
}, 300)

// the capture, once a second: written whole to a temp file and renamed in, so the viewer never reads a torn one
setInterval(() => {
    const cap = { v: 1, kind: 'live', vocab: JK, seed: null, nodes: nodes.map((f) => diag(f)!.capture()) }
    writeFileSync('live.capture.json.tmp', JSON.stringify(cap))
    renameSync('live.capture.json.tmp', 'live.capture.json')
    console.log(`capture ${++n} — journal ${cap.nodes.reduce((s, x) => s + x.journal.length, 0)} — ${Object.keys(nodes[0].snapshot).length} rows`)
}, 1000)
