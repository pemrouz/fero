import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// a free port for each member: bind port 0, read what the OS picked, let it go
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const ports = [free(), free(), free()].map(String), dirs = ports.map((p) => `./vault-${p}`)

// the last full screen a member drew — two header lines and the object — and the view on it
const screen = (r: Spawned) => r.out.split(/^(?=MEMBER )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const view = (r: Spawned) => /members \d+ — peers \d+ — writable \w+/.exec(screen(r))?.[0] ?? ''

// three members on fixed ports, each with a disk; a client proves one write is on two of them
for (const d of dirs) rmSync(d, { recursive: true, force: true })
const m = ports.map((p) => fero.spawn('server.ts', [p]))
assert.ok(await until(() => m.every((r, i) => screen(r).includes(`on 127.0.0.1:${ports[i]} — life `) && view(r) === 'members 3 — peers 2 — writable true'), 30_000), 'three members, each on its port (is this example open in another terminal?)')
const client = fero.spawn('client.ts')
assert.ok(await client.exited === 0 && /^CLIENT \d+ — persisted by \w+ seq \d+ epoch \d+$/m.test(client.out), 'the client proved persisted over RPC and exited by itself')

// kill one: the link drops at once, the vote waits for the redial chain, then two of three still persist a write
m[2].child.kill('SIGKILL')
assert.ok(await until(() => view(m[0]).startsWith('members 3 — peers 1')), 'the survivor lost the link at once, and still shows members 3')
const chain = 30 * (1 + 2 + 4 + 8 + 16 + 32 * 5) + 10 * 30
assert.ok(await until(() => m.slice(0, 2).every((r) => view(r) === 'members 2 — peers 1 — writable true'), 3 * chain), `members 2 and writable once the dead member's redial chain gave up (~${chain} ms)`)
const c = await fero('vault')
assert.equal((await c.methods.update({ key: 'outage', value: 1 }, { confirm: 'persisted' })).guarantee, 'persisted', 'with one member down a write still lands on two disks')

// the same command again: the same member in its next life, voted back in, with the write it missed
m[2] = fero.spawn('server.ts', [ports[2]])
assert.ok(await until(() => m.every((r) => view(r).startsWith('members 3')) && screen(m[2]).includes('~2\n') && view(m[2]).endsWith('writable true') && screen(m[2]).includes('outage: 1'), 30_000), 'the heir is itself (~2), voted back in on every screen, writable, and holds the outage write')

await c.destroy()
for (const r of m) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log('ok 13-cluster-of-three')
