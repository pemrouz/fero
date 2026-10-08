import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full frame a shop drew (its SHOP line and the object), and what a customer printed under its header
const screen = (r: Spawned) => r.out.split(/^(?=SHOP )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const said = (r: Spawned) => r.out.trim().split('\n').slice(1)

// the open shop: the customer's price lands for everyone, and there is no sell to call
const open = fero.spawn('open.ts')
assert.ok(await until(() => screen(open).includes('widgets: { price: 10 }')), 'the open shop shows its seed (is this example open in another terminal?)')
const first = fero.spawn('customer.ts')
assert.equal(await first.exited, 0, 'the customer ran once and exited by itself')
assert.deepEqual(said(first), ['price 0: committed', "sell: methods.sell: unknown method 'sell'"], 'its price write committed; the open shop hosts no sell')
assert.ok(await until(() => screen(open).includes('widgets: { price: 0 }')), "the open shop's own screen shows the customer's price")
assert.equal(await open.stop(), 0, 'the open shop stopped cleanly on Ctrl-C')

// the same shop with a door: the same customer's price write is refused, and its sale is at the shop's price
const door = fero.spawn('door.ts')
assert.ok(await until(() => screen(door).includes('widgets: { price: 10 }')), 'the shop with a door shows its seed')
const second = fero.spawn('customer.ts')
assert.equal(await second.exited, 0, 'the customer ran once more and exited by itself')
assert.deepEqual(said(second), ['price 0: methods-only', "sell: { item: 'widgets', price: 10 }"], 'its price write is refused at the door; sell answers with the sale it wrote')
assert.ok(await until(() => screen(door).includes(`'sale-${door.pid}-1': { item: 'widgets', price: 10 }`)), "the sale is a row on the shop's screen")

// a plain assignment in this process meets the same door: refused, so the next sale is still at 10
const me = await fero('shop')
me.data.widgets = { price: 0 }
assert.deepEqual(await me.methods.sell('widgets'), { item: 'widgets', price: 10 }, 'a plain assignment is refused too: the price is still 10')
assert.ok(screen(door).includes('widgets: { price: 10 }') && me.snapshot.widgets.price === 10, 'and the price 0 never showed, on the shop or here')
await me.destroy()

assert.equal(await door.stop(), 0, 'the shop with a door stopped cleanly on Ctrl-C')
console.log('ok 44-sell')
