import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fero, type Spawned } from '../../api/index.ts'
import { sleep, until } from '../lib.ts'

// a free port for each server: bind port 0, read what the OS picked, let it go
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const [a, b, c] = [free(), free(), free()].map(String)
const SECRET = 'a-secret-for-this-check-only-18'

// a role with the environment its terminal would have, and nothing else: FERO_SECRET set or not, FERO_CONFIG lifted
// (the battery pins it off, which silences every variable), every other FERO_* variable dropped, and HOME an empty
// folder (a $HOME/fero.opt.ts is a real place for a secret; it must not reach this check) — all restored before
// anything else in this process runs
const home = mkdtempSync(join(tmpdir(), 'fero-18-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
const start = (args: string[], secret?: string) => {
    const saved = Object.fromEntries(Object.keys(process.env).filter((k) => k === 'HOME' || k.startsWith('FERO_')).map((k) => [k, process.env[k]]))
    for (const k of Object.keys(saved)) delete process.env[k]
    process.env.HOME = home
    if (secret) process.env.FERO_SECRET = secret
    try { return fero.spawn('server.ts', args) } finally { delete process.env.FERO_SECRET; Object.assign(process.env, saved) }
}
// the member count on the last MEMBER line a role printed (the whole line must have the README's shape, or -1);
// everything it printed on stderr (`out` is stdout only), and the refusal lines in it
const shape = /^MEMBER \d+ on 127\.0\.0\.1:\d+ — members (\d+)$/
const members = (r: Spawned, l = r.out.split('\n').filter((l) => l.startsWith('MEMBER ')).pop() ?? '') => Number(shape.exec(l)?.[1] ?? -1)
const errs = (r: Spawned, s = '') => (r.child.stderr!.on('data', (d: string) => { s += d }), () => s)
const refusals = (err: () => string) => err().split('\n').filter((l) => l.startsWith("fero('vault'): refused"))

// two members started with the secret form a cluster of two, and each holds the other's row
const m1 = start([a, b], SECRET), m2 = start([b, a], SECRET), err1 = errs(m1), err2 = errs(m2)
assert.ok(await until(() => [m1, m2].every((r) => members(r) === 2), 30_000), 'two members with the secret: members 2 on both screens (is this example open in another terminal?)')
assert.ok(await until(() => [m1, m2].every((r) => r.out.includes(`'${m1.pid}': 'member'`) && r.out.includes(`'${m2.pid}': 'member'`))), 'both rows on both screens')

// a third server started without the secret: refused at the door by both, and its own screen says why, once per member —
// and that its first view waits on them (it holds no view, and they are its hosts; DESIGN-DIRECTORY §13)
const m3 = start([c, a, b]), err3 = errs(m3)
const line = (p: string) => `fero('vault'): refused by 127.0.0.1:${p} — it has a secret and this process has none (set FERO_SECRET to the cluster's secret) — the first view waits on it`
assert.ok(await until(() => refusals(err3).includes(line(a)) && refusals(err3).includes(line(b)), 15_000), `the third's screen names both members and FERO_SECRET: ${JSON.stringify(refusals(err3))}`)
const inbound = `fero('vault'): refused a peer that connected as 127.0.0.1:${c} — it has no secret and this node has one; every member must share FERO_SECRET, a client holds it or FERO_SECRET_CLIENT`
assert.ok(await until(() => refusals(err1).includes(inbound) && refusals(err2).includes(inbound)), `each member's screen shows the refusal too: ${JSON.stringify([refusals(err1), refusals(err2)])}`)
await sleep(2000) // the third keeps redialing: one line per peer and reason, never one per attempt
assert.deepEqual(refusals(err3).sort(), [line(a), line(b)].sort(), 'exactly one line per member on the third')
assert.deepEqual([refusals(err1), refusals(err2)], [[inbound], [inbound]], 'exactly one line on each member')
assert.ok(members(m3) === 0 && !m3.out.includes(`'${m1.pid}'`), 'the third is in no cluster and holds no row of theirs')
assert.ok([m1, m2].every((r) => members(r) === 2 && !r.out.includes(`'${m3.pid}'`)), 'and the members never saw its row')

// Ctrl-C, and the same command with the secret: the third is admitted, members 3 on every screen, its row on all of them
assert.equal(await m3.stop(), 0, 'the refused server still stops cleanly on Ctrl-C')
const m3b = start([c, a, b], SECRET), err3b = errs(m3b)
assert.ok(await until(() => [m1, m2, m3b].every((r) => members(r) === 3 && r.out.includes(`'${m3b.pid}': 'member'`)), 30_000), 'with the secret the same command joins: members 3 and its row on every screen')
assert.deepEqual([refusals(err1), refusals(err2)], [[inbound], [inbound]], 'the members print nothing new for a peer that proves itself')

// every screen of the whole story, stdout and stderr, refused and admitted: the value itself is printed nowhere
const screens = [[m1, err1], [m2, err2], [m3, err3], [m3b, err3b]] as const
assert.ok(!screens.some(([r, err]) => r.out.includes(SECRET) || err().includes(SECRET)), 'no screen ever shows the secret')

for (const r of [m3b, m1, m2]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 18-secret')
