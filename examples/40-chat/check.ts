import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the messages a bot printed under its header, one line each
const lines = (r: Spawned) => r.out.split('\n').filter((l) => /^\d\d:\d\d:\d\d </.test(l))
rmSync('./room-general', { recursive: true, force: true })

// the room, then two bots at once: five lines each, and both leave once the room holds ten
const room = fero.spawn('room.ts', ['general'])
assert.ok(await until(() => room.out.includes('ROOM general')), 'the room is up (is this example open in another terminal?)')
const ada = fero.spawn('bot.ts', ['general', 'ada', '5', '10']), bob = fero.spawn('bot.ts', ['general', 'bob', '5', '10'])
// and the reader's own screen, watching: fero.spawn closes its stdin, so it only draws
const cy = fero.spawn('join.ts', ['general', 'cy'])
const shown = () => (cy.out.split(/^(?=CHAT )/m).pop() ?? '').split('\n').filter((l) => /^\d\d:\d\d:\d\d </.test(l))
assert.ok(await until(() => lines(ada).length === 10 && lines(bob).length === 10, 20_000), 'each bot posted five lines, saw ten, and printed them')
assert.ok((await ada.exited) === 0 && (await bob.exited) === 0, 'and left by itself')
assert.deepEqual(lines(ada).filter((l) => l.includes('<ada>')).map((l) => l.at(-1)), ['1', '2', '3', '4', '5'], 'five of them hers, in the order she posted them: the screen is sorted by time')
assert.deepEqual(lines(ada), lines(bob), 'both screens list the ten in the same order')
assert.ok(await until(() => room.out.includes('— messages 10')), 'the room counts ten')

// a joiner in this process: the rule is thrown on the server and heard here; the row says who; a plain write is refused at the door
const me = await fero('chat-general')
assert.equal(await me.methods.post({ nick: 'cy', text: 'x'.repeat(300) }).then(() => 'accepted', (e) => e.message), 'methods.post: too long', 'a 300-character line is refused with the rule')
await me.methods.post({ nick: 'cy', text: 'hi' })
assert.ok(await until(() => Object.values(me.snapshot).some((m) => m.text === 'hi' && m.from === me.cluster.me.snapshot().uuid && Date.now() - m.at < 10_000)), "my line came back with from = my id and at from the server's clock: the server's word, not mine")
assert.ok(await until(() => shown().length === 11 && shown().slice(0, 10).join('\n') === lines(ada).join('\n')), "the joiner's screen: the same ten in the same order, then mine")
me.data.hack = { nick: 'cy', text: 'hack', at: 0, from: 'cy' }
assert.ok(await until(() => Object.values(me.cluster.snapshot().writes).some((w) => w.state === 'rejected' && w.reason === 'methods-only')), "a plain write is refused 'methods-only': post is the one way in")
assert.ok(!('hack' in me.snapshot) && Object.keys(me.snapshot).length === 11, 'and never showed: eleven messages, no hack')
await me.destroy()

for (const r of [cy, room]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
rmSync('./room-general', { recursive: true, force: true })
console.log('ok 40-chat')
