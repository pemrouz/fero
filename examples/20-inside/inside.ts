import { writeFileSync } from 'node:fs'
import { fero } from '../../api/index.ts'
import { diag, JK } from '../../internals.ts'

// two servers in one process: a server that never met a peer has no view, so no frontier, and never compacts
const b = await fero('probe', { uuid: 'b', listen: '127.0.0.1:0', rendezvous: false })
const a = await fero('probe', { uuid: 'a', listen: '127.0.0.1:0', hosts: [b.cluster.me.snapshot().listen], rendezvous: false })
await new Promise<void>((ok) => b.cluster.tap(() => b.cluster.snapshot().epoch && ok()))

// five cells, each rewritten twelve times: fifty-five entries nobody needs once b holds the last one
for (let i = 0; i < 60; i++) a.data[`k${i % 5}`] = { i }
await new Promise<void>((ok) => b.data.tap(() => b.snapshot.k4?.i === 59 && ok()))

// the diagnostics handle is off the typed surface: internals is the door
const d = diag(a)!
const { n, dropped } = d.journal()
console.log(`journal ${n} (${dropped} dropped) · log ${d.logSize()} · confirms`, d.confirms(), '· served', d.served())

// compact until the pass collapses the prefix: the frontier is what b has provably applied, and b says so on a heartbeat
let gone = 0
while (!(gone += d.compact())) await new Promise((r) => setTimeout(r, 100))
console.log(`compacted ${gone} entries; log now ${d.logSize()}`)

// a capture is the debugger's file: one slice per node and the event vocabulary
writeFileSync('inside.capture.json', JSON.stringify({ v: 1, kind: 'live', vocab: JK, seed: null, nodes: [d.capture(), diag(b)!.capture()] }))
console.log('open it:  npm run debug -- examples/20-inside/inside.capture.json')

for (const f of [a, b]) await f.destroy()
