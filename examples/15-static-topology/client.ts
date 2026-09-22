import { fero } from '../../api/index.ts'

// no directory: a client dials the addresses it is given, and follows
const hosts = process.argv.slice(2).map((p) => `127.0.0.1:${p}`)
const f = await fero('static', { hosts, rendezvous: false })

f.data.tap(() => {
    console.clear()
    console.log(`CLIENT ${process.pid} — hosts ${f.cluster.me.snapshot().hosts.join(' ')} — linked ${Object.keys(f.cluster.snapshot().peers).length}`)
    console.log(f.snapshot)
})

// one write: it goes to a member, is stamped there, and comes back to every screen
f.data[process.pid] = 'client'
