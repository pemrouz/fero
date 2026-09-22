import assert from 'node:assert'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// three free ports, and what a member printed: its holdings line, and one hop line per row it does not hold
const free = () => {
    const s = createServer().listen(0), { port } = s.address() as AddressInfo
    s.close()
    return String(port)
}
const ports = [free(), free(), free()]
const holds = (r: Spawned) => /^holds (\d+) of (\d+)$/m.exec(r.out)
const hops = (r: Spawned) => [...r.out.matchAll(/^(\d)-\d+ shortfall → \{ v: (\d) \}$/gm)]

// three members, the ports rotated: each waits for the other two, writes three rows, and gathers the nine
const members = ports.map((_, i) => fero.spawn('server.ts', [...ports.slice(i), ...ports.slice(0, i)]))
assert.ok(await until(() => members.every((r) => holds(r)), 30_000), 'every member gathered the whole resource (is this example open in another terminal?)')
assert.ok(members.every((r) => holds(r)![2] === '9'), 'nine rows: three per member')
assert.equal(members.reduce((n, r) => n + Number(holds(r)![1]), 0), 18, 'every row is on exactly two members: nine rows, two holders each')
for (const r of members) assert.ok(r.out.includes('snapshot holistic') && r.out.includes('filter holistic'), 'a sync read and an operator on a member throw typed')

// the rows a member does not hold are one hop away: one line per missing row, each answering the owner's value
assert.ok(await until(() => members.every((r) => hops(r).length === 9 - Number(holds(r)![1]))), 'a hop for exactly the rows not held here')
for (const r of members) for (const [, n, v] of hops(r)) assert.equal(v, n, "a hop answers the owner's value")
assert.ok(members.some((r) => hops(r).length > 0), 'someone lacks a row: 18 holdings over three members')

// a client downloads the union through the member it dialed, and exits by itself
const client = fero.spawn('client.ts', ports)
assert.equal(await client.exited, 0, 'the client printed and exited on its own')
assert.ok(/^CLIENT \d+ — 9 rows$/m.test(client.out), 'the client sees all nine rows')

for (const r of members) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 16-scoped')
