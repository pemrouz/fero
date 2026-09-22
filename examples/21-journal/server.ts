import { fero } from '../../api/index.ts'
import { diag, JK } from '../../internals.ts'

// run this file in two terminals: each copy writes one row, then tails its own kernel's diary
const f = await fero('diary', { server: true })
const NAME = Object.fromEntries(Object.entries(JK).map(([k, v]) => [v, k]))
const QUIET = new Set([JK.ping, JK.digestOut, JK.digestIn])
let from = 0

console.log('pid', process.pid)
f.data[process.pid] = 1

// every 250 ms: the events since the cursor, one line each, the heartbeat's own three kinds left out
setInterval(() => {
    const j = diag(f)!.journal(from)
    for (const e of j.events) if (!QUIET.has(e.kind)) console.log(String(e.t).padStart(5), NAME[e.kind], ...[e.a, e.b].filter((x) => x !== undefined))
    if (j.n - j.events.length > from) console.log(`(${j.n - j.events.length - from} events fell off the ring before this pull — raise journal.cap)`)
    from = j.n
}, 250)
