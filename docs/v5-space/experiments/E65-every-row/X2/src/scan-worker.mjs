// E-65 X2 timing: one asking thread of several. It scans its share of the groups with its own connections and
// hands back its count and sum; the main thread adds the shares up (the "combine" step).
import { parentPort, workerData } from 'node:worker_threads'
import { Conn, Scan } from './client.mjs'
const { ports, groupsOf, mine, opts, id } = workerData
const conns = ports.map((p) => new Conn(p))
await Promise.all(conns.map((c) => c.ready))
const connOf = new Map(); groupsOf.forEach((gs, w) => gs.forEach((g) => connOf.set(g, conns[w])))
const sc = new Scan(conns.filter((c, w) => groupsOf[w].some((g) => mine.includes(g))), connOf, mine, { ...opts, id })
let count = 0, sum = 0
for await (const [, page] of sc.pages()) for (const [, r] of page) { count++; sum += r.n }
for (const c of conns) c.close()
parentPort.postMessage({ count, sum, looked: sc.looked })
