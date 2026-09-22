import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full frame a role drew, a count on its header line, and one server's row on it
const screen = (r: Spawned) => r.out.split(/^(?=SERVER |CLIENT )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const header = (r: Spawned, word: string) => Number(new RegExp(`${word} (\\d+)`).exec(screen(r))?.[1] ?? -1)
const row = (r: Spawned, of: Spawned) => Number(new RegExp(`'${of.pid}': (\\d+)`).exec(screen(r))?.[1] ?? -1)

// the first server a client meets is the one that feeds its live handle: one server alone, the client, then two more
const feeder = fero.spawn('server.ts')
const client = fero.spawn('client.ts')
assert.ok(await until(() => header(client, 'peers') === 1, 30_000), 'the client shows peers 1 (is this example open in another terminal?)')
const rest = [fero.spawn('server.ts'), fero.spawn('server.ts')]
const servers = [feeder, ...rest]
assert.ok(await until(() => header(client, 'peers') === 3 && servers.every((s) => header(s, 'members') === 3 && row(client, s) > 0), 30_000), 'the client shows peers 3 and a counting row from each server, every server shows members 3')

// kill -9 the feeder: a crash, never a stop — the hard case, the client's handle has to find another server by itself
const was = servers.map((s) => row(client, s))
feeder.child.kill('SIGKILL')
assert.ok(await until(() => header(client, 'peers') === 2, 2000), "the client's peers dropped to 2 at once")

// a client write meanwhile, through the door: it waits for the vote if the dead server stamped that row (retry is the by-hand idiom — this call starts after the drop)
const chain = 30 * (1 + 2 + 4 + 8 + 16 + 32 * 5) + 10 * 30
const c = await fero('feed')
await c.methods.mark('failover', { retry: true, timeout: 3 * chain })
assert.equal(await c.methods.read('after'), 'failover', 'the write committed on a survivor and reads back')
await c.destroy()

// the survivors vote the dead one out once the redial chain gives up: every surviving row counts on, the dead row stands
assert.ok(await until(() => rest.every((s) => header(s, 'members') === 2), 3 * chain), 'members 2 on both survivors')
assert.ok(await until(() => rest.every((s, i) => row(client, s) > was[i + 1] + 2) && [client, ...rest].every((r) => screen(r).includes("after: 'failover'")), 5000), "the client's picture kept moving: both survivor rows counted on, and the write shows on every screen still up")
assert.ok(row(client, feeder) >= was[0] && row(client, feeder) <= was[0] + 1, 'the dead row is still there, where it stopped')

for (const r of [client, ...rest]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
console.log('ok 14-failover')
