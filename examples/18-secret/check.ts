import assert from 'node:assert'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { sleep, until } from '../lib.ts'

// a free port for each server: bind port 0, read what the OS picked, let it go
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const [a, b, c] = [free(), free(), free()].map(String)
const SECRET = 'a-secret-for-this-check-only-18'

// a role with the environment its terminal would have: FERO_SECRET set or not, and FERO_CONFIG lifted (the
// battery pins it off, which silences every variable) — restored before anything else in this process runs
const start = (args: string[], secret?: string) => {
    const saved = { FERO_SECRET: process.env.FERO_SECRET, FERO_CONFIG: process.env.FERO_CONFIG }
    delete process.env.FERO_CONFIG
    if (secret) process.env.FERO_SECRET = secret; else delete process.env.FERO_SECRET
    try { return fero.spawn('server.ts', args) } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
// the last MEMBER line a role printed, and the refusal lines it printed (they go to stderr, which `out` does not carry)
const header = (r: Spawned) => r.out.split('\n').filter((l) => l.startsWith('MEMBER ')).pop() ?? ''
const refusals = (r: Spawned, s = '') => (r.child.stderr!.on('data', (d: string) => { s += d }), () => s.split('\n').filter((l) => l.startsWith("fero('vault'): refused")))

// two members started with the secret form a cluster of two, and each holds the other's row
const m1 = start([a, b], SECRET), m2 = start([b, a], SECRET), said1 = refusals(m1), said2 = refusals(m2)
assert.ok(await until(() => [m1, m2].every((r) => header(r).includes('— secret set — members 2')), 30_000), 'two members with the secret: members 2 on both screens (is this example open in another terminal?)')
assert.ok(await until(() => [m1, m2].every((r) => r.out.includes(`'${m1.pid}': 'member'`) && r.out.includes(`'${m2.pid}': 'member'`))), 'both rows on both screens')

// a third server started without the secret: refused at the door by both, and its own screen says why, once per member
const m3 = start([c, a, b]), said3 = refusals(m3)
const line = (p: string) => `fero('vault'): refused by 127.0.0.1:${p} — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)`
assert.ok(await until(() => said3().includes(line(a)) && said3().includes(line(b)), 15_000), `the third's screen names both members and FERO_SECRET: ${JSON.stringify(said3())}`)
const inbound = `fero('vault'): refused a peer that connected as 127.0.0.1:${c} — it has no secret and this node has one; every member and client must share FERO_SECRET`
assert.ok(await until(() => said1().includes(inbound) && said2().includes(inbound)), `each member's screen shows the refusal too: ${JSON.stringify([said1(), said2()])}`)
await sleep(2000) // the third keeps redialing: one line per peer and reason, never one per attempt
assert.deepEqual(said3().sort(), [line(a), line(b)].sort(), 'exactly one line per member on the third')
assert.deepEqual([said1(), said2()], [[inbound], [inbound]], 'exactly one line on each member')
assert.ok(header(m3).includes('— secret none — members 0') && !m3.out.includes(`'${m1.pid}'`), 'the third is in no cluster and holds no row of theirs')
assert.ok([m1, m2].every((r) => header(r).includes('members 2') && !r.out.includes(`'${m3.pid}'`)), 'and the members never saw its row')
assert.ok(![m1, m2, m3].some((r) => r.out.includes(SECRET)) && ![said1, said2, said3].some((s) => s().join().includes(SECRET)), 'no screen ever shows the secret')

// Ctrl-C, and the same command with the secret: the third is admitted, members 3 on every screen, its row on all of them
assert.equal(await m3.stop(), 0, 'the refused server still stops cleanly on Ctrl-C')
const m3b = start([c, a, b], SECRET)
assert.ok(await until(() => [m1, m2, m3b].every((r) => header(r).includes('— secret set — members 3') && r.out.includes(`'${m3b.pid}': 'member'`)), 30_000), 'with the secret the same command joins: members 3 and its row on every screen')
assert.deepEqual([said1(), said2()], [[inbound], [inbound]], 'the members print nothing new for a peer that proves itself')

for (const r of [m3b, m1, m2]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 18-secret')
