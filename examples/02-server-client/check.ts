import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { sleep, until } from '../lib.ts'

// the last screen a role drew: its header line and the object
const screen = (r: Spawned) => r.out.split(/^(?=SHOP |WATCHER )/m).pop() ?? ''
const stock = (r: Spawned) => Number(/widgets: \{ stock: (\d+)/.exec(screen(r))?.[1] ?? -1)

// the watcher first: nothing to find yet, so it waits
const watcher = fero.spawn('client.ts')
assert.ok(await until(() => screen(watcher).includes('{}')), 'a watcher alone draws an empty object')
await sleep(1500)
assert.ok(screen(watcher).includes('shop not found yet') && stock(watcher) < 0, 'and waits: no shop yet, so no rows')

// the shop appears and stock flows down
const shop = fero.spawn('server.ts')
assert.ok(await until(() => stock(watcher) > 0, 15_000), 'the watcher found the shop by name and holds its rows')
const listen = /SHOP \d+ on (127\.0\.0\.1:\d+)/.exec(shop.out)?.[1]
assert.ok(await until(() => screen(watcher).includes(`— shop ${listen}`)), "the watcher's screen names the shop's port")
const s0 = stock(watcher)
assert.ok(await until(() => stock(watcher) !== s0, 5000), 'stock keeps flowing down: the restock reached the watcher')

// sales flow up
assert.ok(await until(() => screen(shop).includes(`'sale-${watcher.pid}-2'`), 20_000), "the watcher's second sale reached the shop")
assert.ok(screen(shop).includes('gadgets: { stock: 3 }') && screen(shop).includes('watchers 1'), 'the seeded gadgets row is untouched, and the shop counts one watcher')

for (const r of [watcher, shop]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 02-server-client')
