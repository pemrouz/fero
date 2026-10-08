import { fero } from '../../api/index.ts'

// the same shop with a door: declaring methods: means clients change data only through them
let n = 0
const shop = await fero('shop', { data: { widgets: { price: 10 } }, methods: {
    // a sale is a new row at the shop's price: the caller names the item, never the price
    sell: (item, ctx) => {
        const sale = { item, price: ctx.data.snapshot()[item].price }
        ctx.data[`sale-${process.pid}-${++n}`] = sale
        return sale
    },
} })

shop.data.tap(() => {
    console.clear()
    console.log(`SHOP ${process.pid} — methods: sell`)
    console.log(shop.snapshot)
})
