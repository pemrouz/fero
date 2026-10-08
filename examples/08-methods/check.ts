import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full frame the server logged: it starts with SERVER and ends with the object
const screen = (r: Spawned) => r.out.split(/^(?=SERVER )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''

// the server hosts the methods, seeded
const server = fero.spawn('server.ts')
assert.ok(await until(() => screen(server).includes('genesis:')), 'the server shows its seed (is this example open in another terminal?)')

// the client runs once: every await is one call, answered after the server committed
const client = fero.spawn('client.ts')
assert.equal(await client.exited, 0, 'the client ran through and exited by itself')
assert.deepEqual(client.out.trim().split('\n').slice(1), [
    'deposit 105', 'deposit 110', `whoami ${/me (\w+)/.exec(client.out)?.[1]}`, "read { who: 'alice', amount: 100 }",
    'fail methods.fail: nope', "nosuch methods.nosuch: unknown method 'nosuch'", 'update methods-only',
], 'two deposits, each counting the one before; ctx.peer is me; the read; a throw and an unknown name reject; a plain write is refused')
assert.ok(await until(() => screen(server).includes(`'deposit-${server.pid}-2'`)), "both deposits are rows on the server's screen")

// a caller in this process: a plain assignment is refused, then the deposit after it counts the two before
const bank = await fero('bank')
bank.data.hack = { who: 'alice', amount: 1000 }
assert.ok(await until(() => Object.values(bank.cluster.writes.snapshot()).some((w) => w.state === 'rejected' && w.reason === 'methods-only')), "a client's assignment is refused 'methods-only'")
assert.equal(await bank.methods.deposit({ who: 'alice', amount: 5 }), 115, 'the total counts every deposit committed before the reply')
assert.ok(await until(() => screen(server).includes(`'deposit-${server.pid}-3'`)) && !server.out.includes('hack') && !('hack' in bank.snapshot), 'the third deposit landed after the refusal, and hack never showed on either side')
await bank.destroy()

assert.equal(await server.stop(), 0, 'the server stopped cleanly')
console.log('ok 08-methods')
