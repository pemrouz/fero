import { fero } from '../../api/index.ts'

// no directory: every address is in the call — mine to listen on, the others to dial
const [mine, ...peers] = process.argv.slice(2).map((p) => `127.0.0.1:${p}`)
const f = await fero('static', { listen: mine, hosts: peers, rendezvous: false })
let n = 0

f.data.tap(() => {
    const { me, members } = f.cluster.snapshot()
    console.clear()
    console.log(`MEMBER ${process.pid} on ${me.listen} — directory ${me.rendezvous ? 'on' : 'off'} — members ${Object.keys(members).length}`)
    console.log(f.snapshot)
})

setInterval(() => { f.data[process.pid] = ++n }, 1000)
