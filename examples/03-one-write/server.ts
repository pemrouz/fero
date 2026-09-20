import { fero } from '../../api/index.ts'

// a server stamps every write it is sent, and keeps it
const f = await fero('notes', { server: true })

f.data.tap(() => {
    console.clear()
    console.log(`SERVER ${process.pid} — me ${f.cluster.me.snapshot().uuid} — clients ${Object.keys(f.cluster.snapshot().peers).length}`)
    console.log(f.snapshot)
})
