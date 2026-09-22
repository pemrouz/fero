import assert from 'node:assert'
import { fero } from '../../api/index.ts'

// one run of the till: every line it printed, in order, and how it ended
const till = fero.spawn('server.ts')
const code = await till.exited, lines = till.out.trimEnd().split('\n')

// a tap on a scalar fires once on attach, with the empty fold
assert.equal(lines[0], 'nothing = 0', 'the sum tap fired on attach with no facts (is this example open in another terminal?)')

// then once per sale, each line a fold over every fact so far
assert.deepEqual(lines.slice(1, 6), ['3 = 3', '3 + 8 = 11', '3 + 8 + 4 = 15', '3 + 8 + 4 + 9 = 24', '3 + 8 + 4 + 9 + 6 = 30'], 'one line per sale: the facts, and their sum')

// every other number had settled by the time it was read
assert.equal(lines[6], '{ n: 5, avg: 6, min: 3, max: 9, median: 6, p75: 8, big: 23, cash: 50 }', 'the closing numbers: count, mean, range, quantiles, a fold over a view, a reduce with an init')
assert.equal(lines.length, 7, 'and nothing else was printed')
assert.equal(code, 0, 'the till exited by itself after destroy()')
console.log('ok 06-numbers')
