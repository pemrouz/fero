import assert from 'node:assert'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { sleep, until } from '../lib.ts'

// a free port for each member: bind port 0, read what the OS picked, let it go
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const ports = [free(), free(), free()].map(String)

// the last full screen a role drew: the header line and the object
const screen = (r: Spawned) => r.out.split(/^(?=MEMBER |CLIENT )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''

// three members, each told its own port and the other two, and no directory
const m = ports.map((p, i) => fero.spawn('server.ts', [p, ...ports.filter((_, j) => j !== i)]))
assert.ok(await until(() => m.every((r, i) => screen(r).includes(`on 127.0.0.1:${ports[i]} — directory off — members 3`)), 30_000), 'every member shows directory off and members 3 on the port it was given (is this example open in another terminal?)')

// a client told the three addresses: its one write is stamped by a member and reaches every screen
const c = fero.spawn('client.ts', ports)
assert.ok(await until(() => [...m, c].every((r) => screen(r).includes(`'${c.pid}': 'client'`)), 15_000), "the client's write reached every screen")
await sleep(2000)
assert.ok(m.every((r) => screen(r).includes('— members 3')), 'a client joins no vote: still members 3')

// every shape fero refuses: one line each, then the process ends by itself
const r = fero.spawn('refusals.ts')
assert.ok(await until(() => (r.out.match(/^refused: /gm) ?? []).length === 7, 15_000), 'seven shapes, seven refusals')
assert.equal(await r.exited, 0, 'and it ended by itself: nothing was accepted')

for (const x of [c, ...m]) assert.equal(await x.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 15-static-topology')
