import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the lines a copy printed, and the index of the first event with this name at or after a line (-1: none, or no such line)
const lines = (r: Spawned) => r.out.trimEnd().split('\n')
const at = (r: Spawned, name: string, from = 0): number => from < 0 ? -1 : lines(r).findIndex((l, i) => i >= from && new RegExp(`^ *\\d+ ${name}( |$)`).test(l))

// one copy alone: the diary opens with start
const a = fero.spawn('server.ts')
assert.ok(await until(() => at(a, 'start') === 1), 'the pid line, then the diary opens with start (is this example open in another terminal?)')

// a second copy: the first identifies it, ships it the row it lacks, and a view of two is installed
const b = fero.spawn('server.ts')
assert.ok(await until(() => at(a, 'identified') > 0 && at(a, 'viewInstall') > at(a, 'identified'), 30_000), 'identified, then viewInstall, on the first copy')
assert.ok(await until(() => at(a, 'aeShip') > 0 && at(b, 'applyInbound') > 0 && at(b, 'viewInstall') > 0), 'anti-entropy shipped the row and the second copy applied it')

// ctrl-c the second: voted out (a view of one is installed), and only then the link closes
const n = lines(a).length
assert.equal(await b.stop(), 0, 'B stopped cleanly on Ctrl-C')
assert.ok(await until(() => at(a, 'evict', n) >= n && at(a, 'viewInstall', n) > at(a, 'evict', n) && at(a, 'linkDown', n) > at(a, 'viewInstall', n)), 'evict, viewInstall, then linkDown')

// run it again: a fresh identified after the linkDown line, a view of two again, and the new copy's gate opens
const c = fero.spawn('server.ts')
assert.ok(await until(() => at(a, 'viewInstall', at(a, 'identified', at(a, 'linkDown', n))) > 0 && at(c, 'gateOpen') > 0, 30_000), 'a new identified after the link went down, then a view of two; the new copy is voted in')

for (const r of [c, a]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 21-journal')
