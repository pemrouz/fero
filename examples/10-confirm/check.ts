import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full frame a member drew — it starts with MEMBER and ends with the object — and its header: me, epoch, writable, members
const screen = (r: Spawned) => r.out.split(/^(?=MEMBER )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const head = (r: Spawned) => /me (\w+) — epoch (\d+) — writable (\w+) — members (\d+)/.exec(screen(r))?.slice(1) ?? []

// two members: the view commits once both are in
const a = fero.spawn('server.ts'), b = fero.spawn('server.ts')
assert.ok(await until(() => [a, b].every((r) => head(r).slice(1).join(' ') === '1 true 2'), 30_000), 'both screens show epoch 1, writable true, members 2 (is this example open in another terminal?)')

// the client runs once: the same write at three rungs, one line each, then the object
const client = fero.spawn('client.ts')
assert.equal(await client.exited, 0, 'the client ran through and exited by itself')
const lines = client.out.trim().split('\n')
assert.match(lines[1] ?? '', new RegExp(`^k=1 committed by (${head(a)[0]}|${head(b)[0]}) seq 1 epoch 1$`), 'the default rung: committed, stamped by one of the members, with its coordinates')
assert.match(lines[2] ?? '', /^k=2 replicated by \w+ seq 2 epoch 1$/, 'replicated: both members hold it, proven at the primary')
assert.match(lines[3] ?? '', /^k=3 persisted timeout — reached committed by \w+ seq 3 epoch 1$/, 'persisted: no disks, so not proven in time — it reached committed')
assert.ok(lines[4] === '{ k: 3 }' && await until(() => [a, b].every((r) => screen(r).includes('{ k: 3 }'))), 'and the write is there, on the client and both members: a reject is not a rollback')

// a caller in this process: the resolve and the reject as values
const c = await fero('ledger')
const r = await c.methods.update({ key: 'k', value: 4 }, { confirm: 'replicated', timeout: 5000 })
assert.deepEqual([r.guarantee, r.key, r.epoch], ['replicated', ['k'], 1], 'a resolve names the rung it proved and the commit coordinates')
const e = await c.methods.update({ key: 'k', value: 5 }, { confirm: 'persisted', timeout: 1000 }).then(() => null, (e) => e)
assert.deepEqual([e, c.snapshot.k], [{ guarantee: 'persisted', reached: 'committed', reason: 'timeout', localCommit: { origin: r.origin, seq: r.seq + 1, epoch: 1 } }, 5], 'a reject says how far it got, with the local commit, and the write landed before it')
await c.destroy()

for (const r of [a, b]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 10-confirm')
