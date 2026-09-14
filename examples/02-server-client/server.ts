// 02 · the shop — terminal 1:   node server.ts      (terminal 2: node client.ts — either order)      node check.ts (proves it)

import { fero } from '../../api/index.ts'

const shop = await fero('shop', { data: { widgets: { stock: 10 }, gadgets: { stock: 3 } } })
shop.data.tap(() => {
  console.clear()
  console.log(`fero two-terminal demo — SHOP on ${shop.cluster.me.snapshot().listen} — watchers ${Object.keys(shop.cluster.snapshot().peers).length}`)
  console.log(shop.snapshot)
})

let t = 0
setInterval(() => { shop.data.widgets = { stock: 8 + (++t % 5) } }, 1000)
