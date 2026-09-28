import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last screen a life drew (its header, the object, and the guarantee under it), and the life rows on it
const screen = (r: Spawned) => r.out.split(/^(?=NOTES )/m).pop() ?? ''
const rows = (r: Spawned) => screen(r).match(/'\w+(~\d+)?': '[\d:]+'/g) ?? []

// a fresh dir: the first life seeds its own pid, writes a row keyed by its origin, and proves it is on disk
rmSync('./notes', { recursive: true, force: true })
const first = fero.spawn('server.ts')
assert.ok(await until(() => screen(first).includes('persisted'), 15_000), 'the first life proved its row persisted (is this example open in another terminal?)')
const uuid = /life (\w+)\n/.exec(screen(first))?.[1]
assert.ok(uuid && screen(first).includes(`seed: ${first.pid}`) && rows(first)[0]?.startsWith(`'${uuid}'`), 'life 1 is the bare uuid: the seed is its pid, and one row keyed by that origin')
assert.equal(await first.stop(), 0, 'stopped cleanly on Ctrl-C')

// the next life: the same uuid at ~2, the old row back as it was, the seed still life 1's
const next = fero.spawn('server.ts')
assert.ok(await until(() => screen(next).includes('persisted'), 15_000), 'the next life proved its row persisted')
assert.ok(screen(next).includes(`life ${uuid}~2\n`), 'the same uuid at ~2: the same node, its next life')
assert.ok(rows(next)[0] === rows(first)[0] && rows(next)[1]?.startsWith(`'${uuid}~2'`) && rows(next).length === 2, "life 1's row is back as it was, beside life 2's")
assert.ok(screen(next).includes(`seed: ${first.pid}`) && !screen(next).includes(`seed: ${next.pid}`), "the seed applied once: it still holds life 1's pid, not life 2's")
assert.equal(await next.stop(), 0, 'stopped cleanly')

// one dir is one node of one resource: another name or another uuid is refused
await assert.rejects(fero('other', { dir: './notes' }), /belongs to resource 'notes'/, 'another resource may not adopt the dir')
await assert.rejects(fero('notes', { dir: './notes', uuid: 'zz' }), /previous life/, 'another uuid may not adopt the dir')
rmSync('./notes', { recursive: true, force: true })
console.log('ok 12-durable')
