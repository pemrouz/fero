import { fero } from '../../api/index.ts'

// a client's write meets the shop's rule at the shop: the good row lands, the bad one comes back refused, with the reason
const shop = await fero('shop')

// the screen: this client's writes, each with its outcome, then the object
const draw = () => {
    console.clear()
    console.log(`CLIENT ${process.pid}`)
    for (const w of Object.values(shop.cluster.snapshot().writes)) console.log(`${w.key} ${w.state}${w.reason ? `: ${w.reason}` : ''}`)
    console.log(shop.snapshot)
}
for (const v of [shop.data, shop.cluster]) v.tap(draw)

shop.data[`saw-${process.pid}`] = { stock: 1 }
shop.data[`hammer-${process.pid}`] = { stock: -3 }
