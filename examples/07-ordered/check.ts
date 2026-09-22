import assert from 'node:assert'
import { fero } from '../../api/index.ts'

// runs once and exits by itself — every view is one line: a label, then the array
const r = fero.spawn('server.ts')
assert.equal(await r.exited, 0, 'server.ts printed its lines and exited 0 on its own (is this example open in another terminal?)')
const lines = (label: string) => r.out.split('\n').filter((l) => l.startsWith(label + ' ')).map((l) => l.slice(label.length).trim())

// a column sort ranks by price and keeps arrival order at the tie — the comparator's tiebreak puts bolt first
assert.deepEqual(lines('az price'), ["[ 'nut 1', 'cog 3', 'bolt 3', 'gear 5' ]"], 'az ranks by price, the tie at 3 in arrival order')
assert.deepEqual(lines('az price, name'), ["[ 'nut 1', 'bolt 3', 'cog 3', 'gear 5' ]"], 'the comparator breaks the tie by name')
assert.deepEqual(lines('limit 2'), ["[ 'cog 3', 'nut 1' ]"], 'limit is the first rows in arrival order')
assert.deepEqual(lines('reverse'), ["[ 'bolt 3', 'gear 5', 'nut 1', 'cog 3' ]"], 'reverse is arrival order, newest first')

// the window printed once on attach and once more after the rewrite: one batch, not one line per row
assert.deepEqual(lines('za price 2'), ["[ 'gear 5', 'cog 3' ]", "[ 'nut 9', 'gear 5' ]"], 'nut enters the top two and cog leaves, in one batch')
assert.deepEqual(lines('top 2'), ['[ 91, 85 ]'], 'top(n) on numeric rows is the n largest values, an array of numbers')

console.log('ok 07-ordered')
