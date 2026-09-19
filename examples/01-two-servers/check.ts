import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last line a copy printed; the object may wrap over several lines
const screen = (r: Spawned) => r.out.split(/^(?=pid )/m).pop() ?? ''
const members = (r: Spawned) => Number(/members (\d+)/.exec(screen(r))?.[1] ?? -1)
const ticks = (r: Spawned, of: Spawned) => Number(new RegExp(`'${of.pid}': \\{ ticks: (\\d+)`).exec(screen(r))?.[1] ?? -1)

// two copies meet
const a = fero.spawn('server.ts'), b = fero.spawn('server.ts')
assert.ok(await until(() => members(a) === 2 && members(b) === 2, 30_000), 'both screens show members 2')
assert.ok(await until(() => ticks(a, b) >= 1 && ticks(b, a) >= 1), 'each copy shows the other row')

// ctrl-c one: a clean leave, not a crash
assert.equal(await b.stop(), 0, 'B stopped cleanly on Ctrl-C')
const before = ticks(a, a)
assert.ok(await until(() => members(a) === 1 && ticks(a, a) >= before + 2, 5000), 'A shows members 1 and keeps counting alone')
assert.ok(!a.out.includes('writable false'), 'the write gate never closed on A')

// a third copy joins and catches up
const c = fero.spawn('server.ts')
assert.ok(await until(() => members(a) === 2 && ticks(a, c) >= 1, 30_000), 'C was voted in and its row reached A')
assert.ok(await until(() => ticks(c, b) === ticks(a, b) && ticks(c, a) >= ticks(a, a) - 1, 15_000), "C caught up: B's old row and A's latest")

for (const r of [a, c]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 01-two-servers')
