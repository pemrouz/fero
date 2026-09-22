import { fero } from '../../api/index.ts'

// a fixed address and a disk, from the port you pass: run this file on 4801, 4802 and 4803
const port = process.argv[2]
// defaults are 500 ms; we hurry
const f = await fero('vault', { listen: `127.0.0.1:${port}`, dir: `./vault-${port}`, heartbeat: { ms: 100 }, redial: { ms: 30 } })
let n = 0

// the screen: who I am, the view, the object
const draw = () => {
    const { epoch, members, peers, writable, me } = f.cluster.snapshot()
    console.clear()
    console.log(`MEMBER ${process.pid} on ${me.listen} — life ${me.origin}`)
    console.log(`epoch ${epoch} — members ${Object.keys(members).length} — peers ${Object.keys(peers).length} — writable ${writable}`)
    console.log(f.snapshot)
}
f.data.tap(draw)
f.cluster.tap(draw)

// one short row, keyed by my port: a restart takes the same row back
setInterval(() => { f.data[port] = ++n }, 1000)
