import { fero } from '../../api/index.ts'

// a seed makes a server; watchers find it by name
const shop = await fero('shop', { data: { widgets: { stock: 10 }, gadgets: { stock: 3 } } })
let t = 0

shop.data.tap(() => {
    console.clear()
    console.log(`SHOP ${process.pid} on ${shop.cluster.me.snapshot().listen} — watchers ${Object.keys(shop.cluster.snapshot().peers).length}`)
    console.log(shop.snapshot)
})

// restock: the whole row, every second
setInterval(() => { shop.data.widgets = { stock: 8 + (++t % 5) } }, 1000)
