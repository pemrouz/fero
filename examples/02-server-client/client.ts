import { fero } from '../../api/index.ts'

// bare fero(name) is a client: it finds the shop by name and follows it
const shop = await fero('shop')
let n = 0

shop.data.tap(() => {
    console.clear()
    console.log(`WATCHER ${process.pid} — shop ${shop.cluster.me.snapshot().hosts[0] ?? 'not found yet'}`)
    console.log(shop.snapshot)
})

// a sale is a new row: it goes to the shop, is stamped there, and comes back
setInterval(() => { shop.data[`sale-${process.pid}-${++n}`] = { item: 'gadgets', qty: 1 } }, 4000)
