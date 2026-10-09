import { fero } from '../../api/index.ts'

// a member: its own port, then the others to dial; the secret is NOT in the call — it comes from FERO_SECRET
const [mine, ...peers] = process.argv.slice(2).map((p) => `127.0.0.1:${p}`)
const f = await fero('vault', { listen: mine, hosts: peers, rendezvous: false })

// one row, keyed by my pid: it reaches every member of my cluster, and nobody else
f.data[process.pid] = 'member'

// one line per change: the object, and who I am — my address, and how many members the vote admitted
f.data.tap(() => console.log(f.snapshot))
let last = ''
f.cluster.tap(() => {
    const line = `MEMBER ${process.pid} on ${mine} — members ${Object.keys(f.cluster.snapshot().members).length}`
    if (line !== last) console.log(last = line)
})
