import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// a free port for each member: bind port 0, read what the OS picked, let it go
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const ports = [free(), free(), free()].map(String), dirs = ports.map((p) => `./ledger-${p}`)
// the last full frame a member drew: three lines, the last one the fold
const screen = (r: Spawned) => r.out.split(/^(?=MEMBER )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''

// three durable members: the mint pays alice 100 through a teller, and the notifier starts after that — it still delivers it
for (const d of dirs) rmSync(d, { recursive: true, force: true })
const m = ports.map((p) => fero.spawn('member.ts', [p]))
assert.ok(await until(() => m.every((r) => /members 3 — peers \d+ — writable true/.test(screen(r))), 30_000), 'three members, each on its port (is this example open in another terminal?)')
const teller = fero.spawn('teller.ts', ['mint', 'alice', '100'])
assert.ok(await teller.exited === 0 && /^\w{8} \{ mint: -100, alice: 100 \}$/m.test(teller.out), 'the teller got an id back, and its balances show the mint at -100')
const ids = [/^(\w{8}) /m.exec(teller.out)![1]]
const notifier = fero.spawn('notifier.ts')
assert.ok(await until(() => notifier.out.includes(`n-${ids[0]} → alice 100 — cleared`), 15_000), 'the notifier came late, still delivered the genesis notice, and cleared the intent')

// 30 transfers from a client, member 2 killed after #10 and back after #20 — a row the dead member owned waits for the vote, ~6 s at redial 30
const c = await fero('ledger')
for (let i = 1; i <= 30; i++) {
    ids.push(await c.methods.transfer({ from: 'alice', to: 'bob', amount: 1 }, { timeout: 20_000 }))
    if (i === 10) assert.ok(m[1].child.kill('SIGKILL') && await until(() => Object.keys(c.cluster.snapshot().peers).length === 2, 5000), 'member 2 killed: the client lost its link to it at once')
    if (i === 20) m[1] = fero.spawn('member.ts', [ports[1]])
}
// the rules are thrown from the method, and nothing lands: an overdraft, a bad amount
await assert.rejects(async () => c.methods.transfer({ from: 'bob', to: 'alice', amount: 31 }), /insufficient funds/, 'bob holds 30: an overdraft is refused')
await assert.rejects(async () => c.methods.transfer({ from: 'alice', to: 'bob', amount: 0 }), /amount must be positive/, 'a zero transfer is refused')

// the audit, member by member: a reader asks its primary — the one address it dialed first — and every member holds every row
for (const p of ports) {
    const r = await fero('ledger', { hosts: [`127.0.0.1:${p}`], rendezvous: false })
    assert.ok(await until(() => r.methods.read().then((rows) => ids.every((id) => rows[id]?.notified === true)), 30_000), `all 31 transfers are on the member at ${p}, each notified`)
    await r.destroy()
}
assert.ok(await until(() => screen(m[1]).includes('~2\n') && m.every((r) => ['members 3 — ', 'rows 31', 'mint: -100', 'alice: 70', 'bob: 30'].every((s) => screen(r).includes(s)))), 'the heir is itself (~2), voted back in on every screen, and every member folds the same balances, summing to zero')
const n = await fero('notices')
assert.ok(await until(() => ids.every((id) => n.snapshot[`n-${id}`]?.amount > 0)), '31 notices on a fresh client, one per transfer, keyed by its id')

for (const f of [c, n]) await f.destroy()
for (const r of [notifier, ...m]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log('ok 43-ledger')
