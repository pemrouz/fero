import { fero, op } from 'fero'
import { lens } from 'fero-lens'
import type { Shop } from './server.ts'
declare const el: { textContent: string | null; rows: unknown }
const shop = await fero<Shop>('shop')
const d = lens(shop)
const stock = d.widgets.stock                       // an address
const w = stock.set(9)
await w
await d.at('widgets').at('stock').set(op.incr(-1))
// @ts-expect-error stock is a number
stock.set('nine')
// @ts-expect-error no such field
d.widgets.colour
const s1 = stock.connect(el, 'textContent')
// @ts-expect-error not a property of the target
stock.connect(el, 'nope')
const live = d.widgets.connect()
const n: number | undefined = live.value?.stock
const all = d.connect().filter((row, key) => row.stock < 5 && key !== 'x')
d.connect(el, (target, changes, now) => { for (const c of changes.rows) target.textContent = c.key + (c.prev?.stock ?? '') + (now.value ? '' : '') })
const sale = await d.widgets.methods.sell('widgets')
const left: number = sale.left
// a row named like a verb is reached with at(): the dot is the verb
const verb = d.set
const row = d.at('set')
s1.close(); live.close(); all.close()
export { n, left, verb, row }
