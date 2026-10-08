import { fero } from '../../api/index.ts'

// an open shop: a seed makes it a server, and with no methods: every client may change any row
const shop = await fero('shop', { data: { widgets: { price: 10 } } })

shop.data.tap(() => {
    console.clear()
    console.log(`SHOP ${process.pid} — open`)
    console.log(shop.snapshot)
})
