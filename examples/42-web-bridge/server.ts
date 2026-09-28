import { fero } from '../../api/index.ts'

// a seed makes the server; dir keeps its rows on disk, so a restart replays them and the seed applies once
const seed = { widgets: { stock: 8, price: 4 }, gadgets: { stock: 3, price: 9 } }
const f = await fero('inventory', { dir: './inventory', data: seed })

f.data.tap(() => {
    console.clear()
    console.log(`INVENTORY ${process.pid} on ${f.cluster.me.snapshot().listen}`)
    console.log(f.snapshot)
})
