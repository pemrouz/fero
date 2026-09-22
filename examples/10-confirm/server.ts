import { fero } from '../../api/index.ts'

// run this file twice: a majority needs two, and the view commits once both are in
const f = await fero('ledger', { server: true })

// the screen is the committed view, then the object
const draw = () => {
    const { epoch, writable, members, me } = f.cluster.snapshot()
    console.clear()
    console.log(`MEMBER ${process.pid} — me ${me.uuid} — epoch ${epoch} — writable ${writable} — members ${Object.keys(members).length}`)
    console.log(f.snapshot)
}
f.data.tap(draw)
f.cluster.tap(draw)
