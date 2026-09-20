import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last line a copy printed, and one row's count on it
const last = (r: Spawned) => r.out.trimEnd().split('\n').pop() ?? ''
const members = (r: Spawned) => Number(/members (\d+)/.exec(last(r))?.[1] ?? -1)
const count = (r: Spawned, of: Spawned) => Number(new RegExp(`'${of.pid}': (\\d+)`).exec(last(r))?.[1] ?? -1)

// two copies meet
const a = fero.spawn('server.ts'), b = fero.spawn('server.ts')
assert.ok(await until(() => members(a) === 2 && members(b) === 2, 30_000), 'both screens show members 2 (is this example open in another terminal?)')
assert.ok(await until(() => count(a, b) >= 1 && count(b, a) >= 1), 'each copy shows the other row')

// ctrl-c one: a clean leave, not a crash
assert.equal(await b.stop(), 0, 'B stopped cleanly on Ctrl-C')
const before = count(a, a)
assert.ok(await until(() => members(a) === 1 && count(a, a) >= before + 2, 5000), 'A shows members 1 and keeps counting alone')

// a third copy joins and catches up
const c = fero.spawn('server.ts')
assert.ok(await until(() => members(a) === 2 && count(a, c) >= 1, 30_000), 'C was voted in and its row reached A')
assert.ok(await until(() => count(c, b) === count(a, b) && count(c, a) >= count(a, a) - 1, 15_000), "C caught up: B's old row and A's latest")

for (const r of [a, c]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 01-two-servers')
