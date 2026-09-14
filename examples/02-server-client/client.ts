// 02 · a watcher — terminal 2:   node client.ts      (terminal 1: node server.ts — either order; a client waits for the name)

import { fero } from '../../api/index.ts'

const shop = await fero('shop')
shop.data.tap(() => {
  console.clear()
  console.log(`fero two-terminal demo — WATCHER ${process.pid} — shop ${shop.cluster.me.snapshot().hosts[0] ?? 'not found yet'}`)
  console.log(shop.snapshot)
})

let n = 0
setInterval(() => { shop.data[`sale-${process.pid}-${++n}`] = { item: 'gadgets', qty: 1 } }, 4000)
