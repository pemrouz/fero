import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the bank's last full frame, and a client's printed lines
const screen = (r: Spawned) => r.out.split(/^(?=BANK )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const lines = (r: Spawned) => r.out.trimEnd().split('\n')

// the bank holds its seed, then each client runs its story once: alice, then bob
const bank = fero.spawn('server.ts')
assert.ok(await until(() => screen(bank).includes("opening: { who: 'alice', amount: 100 }")), 'the bank shows its seed (is this example open in another terminal?)')
const alice = fero.spawn('client.ts')
assert.equal(await alice.exited, 0, "alice's client ran its story and exited 0")
assert.deepEqual(lines(alice).slice(0, 3).map((l) => l.startsWith('live {') ? 'live {' : l), ['alice total 0 top []', 'alice total 105 top [ 100, 5 ]', 'live {'], 'an empty mirror, the fold with her first deposit in it, then the live handle answers one-shot')
assert.equal(lines(alice).pop(), 'alice total 115 top [ 100, 10, 5 ]', 'a deposit after the open is one delta, sorted here')
assert.ok(await until(() => screen(bank).includes("{ who: 'alice', amount: 10 }")), 'both deposits are rows at the bank')
const bob = fero.spawn('client.ts', ['bob'])
assert.ok(await bob.exited === 0 && lines(bob).pop() === 'bob total 15 top [ 10, 5 ]', "bob's client exited 0, and his feed holds bob's rows only: the filter runs at the bank")

// in-process: close() ends the stream — a deposit after it commits at the bank (the reply follows the commit) and never reaches the closed mirror
const c = await fero('bank')
const feed = c.methods.feed('alice'), live = feed.open()
assert.ok(await until(() => live.rowCount() === 3), "joined live: alice's three rows")
feed.close()
await c.methods.deposit({ who: 'alice', amount: 1 })
assert.ok(live.rowCount() === 3 && feed.mode === 'oneshot', 'the closed mirror did not get it: a one-shot handle again')
await c.destroy()

assert.equal(await bank.stop(), 0, 'the bank stopped cleanly on Ctrl-C')
console.log('ok 09-live')
