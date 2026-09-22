import assert from 'node:assert'
import { fero } from '../../api/index.ts'

// the run prints the shelf, then every view once, then after each write only the views it changed
const r = fero.spawn('server.ts')
assert.equal(await r.exited, 0, 'the run ends by itself with exit 0 (is this example open in another terminal?)')
const blocks = r.out.split(/^(?=\w+ = )/m)
assert.equal(blocks.length, 3, 'three blocks: the shelf, then one per write')
const [start, afterSaw, afterKite] = blocks
const has = (block: string, line: string) => block.includes(`\n ${line}\n`)
const names = (block: string) => block.trimEnd().split('\n').slice(1).map((l) => l.trim().split(' ')[0]).sort()

// the seed, and every view once
assert.ok(start.startsWith('shelf = {') && has(start, 'prices { nail: 2, glue: 6, saw: 25, kite: 30 }'), 'the shelf, and the price list mapped off it')
assert.ok(has(start, "cheap { nail: { cat: 'tool', price: 2 } }") && has(start, "pricey { saw: { cat: 'tool', price: 25 }, kite: { cat: 'toy', price: 30 } }"), 'the two price bands')
assert.ok(has(start, "cats { tool: 'tool', art: 'art', toy: 'toy' }") && has(start, 'count { tool: { value: 2 }, art: { value: 1 }, toy: { value: 1 } }'), 'the categories, and a count per category')
assert.ok(has(start, "cheapTools { nail: { cat: 'tool', price: 2 } }"), 'a view built from two views')

// saw 25 → 4: it crosses from pricey into cheap and cheapTools follows — every other view stays quiet
assert.ok(afterSaw.startsWith("saw = { cat: 'tool', price: 4 }\n"), 'the first write prints as it lands')
assert.deepEqual(names(afterSaw), ['cheap', 'cheapTools', 'prices', 'pricey'], 'only the views the saw crossed spoke')
assert.ok(has(afterSaw, "cheap { nail: { cat: 'tool', price: 2 }, saw: { cat: 'tool', price: 4 } }") && has(afterSaw, "pricey { kite: { cat: 'toy', price: 30 } }") && has(afterSaw, 'prices { nail: 2, glue: 6, saw: 4, kite: 30 }'), 'the saw moved from pricey to cheap, and its price followed')

// kite toy → art at the same price: the toy bucket empties — cats drops it, count keeps it at 0, pricey only redraws its rewritten row
assert.ok(afterKite.startsWith("kite = { cat: 'art', price: 30 }\n"), 'the second write prints as it lands')
assert.deepEqual(names(afterKite), ['cats', 'count', 'pricey'], 'only the category views spoke, and pricey, whose kite row was rewritten')
assert.ok(has(afterKite, "cats { tool: 'tool', art: 'art' }") && has(afterKite, 'count { tool: { value: 2 }, art: { value: 2 }, toy: { value: 0 } }') && has(afterKite, "pricey { kite: { cat: 'art', price: 30 } }"), 'distinct forgets the empty bucket, the histogram keeps it at 0, pricey shows the new aisle')
console.log('ok 05-views')
