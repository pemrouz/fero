import { fero } from '../../api/index.ts'

// run this file in two terminals: each copy is one row, keyed by its pid
const f = await fero('hello', { server: true })
let n = 0

f.data.tap(() => {
    const c = f.cluster.snapshot()
    console.log(`pid ${process.pid} members ${Object.keys(c.members).length} writable ${c.writable}`, f.snapshot)
})

setInterval(() => { f.data[process.pid] = { ticks: ++n } }, 1000)
