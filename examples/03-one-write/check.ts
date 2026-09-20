import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full screen a role drew: every screen starts with its role word and ends with the object
const screen = (r: Spawned) => r.out.split(/^(?=CLIENT |SERVER )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const rows = (r: Spawned, state: string) => (screen(r).match(new RegExp(` ${state}`, 'g')) ?? []).length
const me = (r: Spawned) => /me (\w+)/.exec(screen(r))?.[1]

// a client alone: its notes wait, and nothing lands
const client = fero.spawn('client.ts')
assert.ok(await until(() => rows(client, 'pending') === 3), 'three notes waiting (is this example open in another terminal?)')
assert.ok(screen(client).trimEnd().endsWith('{}'), 'and nothing shows: a write is a request')

// a server appears and stamps them
const server = fero.spawn('server.ts')
assert.ok(await until(() => rows(client, 'committed') === 3, 15_000), 'the waiting notes are committed')
assert.ok(screen(client).includes(`by ${me(server)}`) && me(server) !== me(client), 'stamped by the server, not by me')
assert.ok(await until(() => [client, server].every((r) => screen(r).includes(`'note-3':`))), 'and the note shows on both screens')

// ctrl-c the server: the next notes wait; run it again and the new server stamps them
assert.equal(await server.stop(), 0, 'the server stopped cleanly')
assert.ok(await until(() => rows(client, 'pending') >= 2), 'with no server the notes wait again')
const next = fero.spawn('server.ts')
assert.ok(await until(() => rows(client, 'committed') === 3 && screen(client).includes(`by ${me(next)}`), 20_000), 'the new server stamped them')

for (const r of [client, next]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 03-one-write')
