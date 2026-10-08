import { fero } from '../../api/index.ts'

// a customer, run once: it sets the price, then buys one — the same two lines against either shop
const shop = await fero('shop')

console.log(`CUSTOMER ${process.pid}`)
// methods.update is the plain write shop.data.widgets = { price: 0 }, with a reply
await shop.methods.update({ key: 'widgets', value: { price: 0 } })
    .then((r) => console.log('price 0:', r.guarantee), (e) => console.log('price 0:', e.reason))
await shop.methods.sell('widgets').then((r) => console.log('sell:', r), (e) => console.log('sell:', e.message))
await shop.destroy()
