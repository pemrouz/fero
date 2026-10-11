//! Tier-1 watchClients suite (wave 5e): the #directory host's failure detector over CLIENT links, against the
// recording sink. With the option set, the node PINGs every admitted client link each heartbeat whatever the
// uuid order, and closes a client link it heard nothing from for more than the bound; any byte in resets the
// count. Without it, nothing changes: no extra PING, no close (every other node's trajectory is untouched).

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { Framer, VERB, encodeControl } from './codec.ts'
import { TAG, type EffectSink, type Env } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink = {
    connect: (to: string) => effects.push(['connect', to]),
    send: (link: number, bytes: Uint8Array) => effects.push(['send', link, bytes]),
    close: (link: number, reason: string) => effects.push(['close', link, reason]),
    timer: (id: number, tag: number, ms: number) => effects.push(['timer', id, tag, ms]),
    cancel: (id: number) => effects.push(['cancel', id]),
    apply: () => {}, persist: () => {}, boot: () => {}, confirm: () => {}, snapshot: () => {},
    invoke: () => {}, result: () => {}, subRecs: () => {},
  } as unknown as EffectSink
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, name: '#directory', listen: 'sim:host', heartbeatMs: 50, ...opts }, env)
  node.step({ kind: 'start' })
  //! the heartbeat re-arms every tick: fire the LATEST armed one
  const heartbeat = () => {
    const t = effects.filter((e) => e[0] === 'timer' && e[2] === TAG.heartbeat).at(-1)!
    node.step({ kind: 'timer', id: t[1] as number, tag: t[2] as number })
  }
  //! an accepted CLIENT link (HELLO r:1) from `peer`
  const client = (link: number, peer: string) => {
    node.step({ kind: 'linkUp', link, dialed: false })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u: peer, i: 1, l: '', r: 1, n: '#directory' }) })
  }
  //! PINGs this node sent on `link`, counted off the bytes
  const pings = (link: number) => effects.filter((e) => e[0] === 'send' && e[1] === link)
    .flatMap((e) => new Framer().push(e[2] as Uint8Array)).filter((f) => f.verb === VERB.PING).length
  const closed = (link: number) => effects.some((e) => e[0] === 'close' && e[1] === link && e[2] === 'silent')
  return { node, heartbeat, client, pings, closed }
}

test('watchClients: a client link is PINGed every heartbeat even when its uuid sorts LOWER, and a silent one is closed after the bound — not before', () => {
  const h = harness('mm', { watchClients: 3 })
  h.client(1, 'aa') // lower than the host: v2's rule alone would leave the PINGs to the client
  h.client(2, 'zz') // higher: the host PINGs it under the ordinary rule
  for (let i = 1; i <= 3; i++) {
    h.heartbeat()
    assert.equal(h.pings(1), i, `tick ${i}: the lower-uuid client is PINGed from the host`)
    assert.equal(h.pings(2), i, `tick ${i}: the higher-uuid client once per tick, not twice`)
    assert.equal(h.closed(1) || h.closed(2), false, `tick ${i}: within the bound`)
  }
  h.heartbeat()
  assert.ok(h.closed(1) && h.closed(2), 'the fourth silent tick closes both: silence past the bound')
  assert.ok(h.node.links.get(1)!.dead && h.node.links.get(1)!.noRedial)
})

test('watchClients: any byte in resets the count — a client that answers every tick is never closed, however long it lives', () => {
  const h = harness('mm', { watchClients: 3 })
  h.client(1, 'aa')
  for (let i = 0; i < 50; i++) {
    h.heartbeat()
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PONG) }) // its answer to the PING
  }
  assert.equal(h.closed(1), false, 'fifty ticks, answered each time: alive')
  //! a slow answerer: it replies every third tick, inside the bound
  for (let i = 0; i < 30; i++) {
    h.heartbeat()
    if (i % 3 === 2) h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PONG) })
  }
  assert.equal(h.closed(1), false, 'slow but inside the bound: alive')
})

test('watchClients off (the default): no extra PING toward a lower-uuid client and no close, however long it is silent', () => {
  const h = harness('mm')
  h.client(1, 'aa')
  for (let i = 0; i < 30; i++) h.heartbeat()
  assert.equal(h.pings(1), 0, 'the ordinary rule: the lower uuid (the client) originates PINGs')
  assert.equal(h.closed(1), false)
})

test('watchClients watches only CLIENT links: a member link is left to suspicion', () => {
  const h = harness('mm', { watchClients: 2 })
  h.node.step({ kind: 'linkUp', link: 1, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', n: '#directory' }) })
  for (let i = 0; i < 10; i++) h.heartbeat()
  assert.equal(h.closed(1), false)
})
