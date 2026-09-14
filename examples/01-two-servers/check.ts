// 01 · the proof:  node check.ts   — two copies meet; Ctrl-C one, the other carries on; a third joins and catches up

import assert from 'node:assert'
import path from 'node:path'
import { privateDirectory, spawnRole, until, type Role } from '../lib.ts'

const server = path.join(import.meta.dirname, 'server.ts')
const screen = (r: Role) => r.out.split(/^(?=pid )/m).pop() ?? ''                       // the last printed line (the object may wrap)
const members = (r: Role) => Number(/members (\d+)/.exec(screen(r))?.[1] ?? -1)
const ticks = (r: Role, of: Role) => Number(new RegExp(`'${of.pid}': \\{ ticks: (\\d+)`).exec(screen(r))?.[1] ?? -1)

await privateDirectory()
const a = spawnRole(server, 'A'), b = spawnRole(server, 'B')
assert.ok(await until(() => members(a) === 2 && members(b) === 2, 30_000), 'both screens show members 2')
assert.ok(await until(() => ticks(a, b) >= 1 && ticks(b, a) >= 1), 'each copy shows the other row')
assert.equal(await b.stop(), 0, 'B stopped cleanly on Ctrl-C')                          // a clean leave, not a crash
const before = ticks(a, a)
assert.ok(await until(() => members(a) === 1 && ticks(a, a) >= before + 2, 5000), 'A shows members 1 and keeps counting alone')
assert.ok(!a.out.includes('writable false'), 'the write gate never closed on A')
const c = spawnRole(server, 'C')
assert.ok(await until(() => members(a) === 2 && ticks(a, c) >= 1, 30_000), 'C was voted in and its row reached A')
assert.ok(await until(() => ticks(c, b) === ticks(a, b) && ticks(c, a) >= ticks(a, a) - 1, 15_000), "C caught up: B's old row and A's latest")
for (const r of [a, c]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 01-two-servers')
