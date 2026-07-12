//! Tier-1 method-HOST suite (M5c + M5-review #2/#6): the Host driven deterministically over a
// no-network Runtime, so the flush-on-return WINDOW (between a handler's parked write and its commit)
// is controllable. Pins the sub-lifecycle race the review found: an UNSUB (or a link death) arriving
// DURING that window must cancel the subscription, and the deferred stream-open must then be a no-op —
// no leaked server-side stream, no subOut to a gone/unsubscribed listener.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { Host } from './methods.ts'
import { VERB, Framer, encodeControl } from '../kernel/codec.ts'

test('M5-REVIEW #2/#6 — UNSUB during the flush-on-return window cancels the sub; the deferred open never streams', async () => {
  const sends: { link: number; verb: number; id?: number }[] = []
  //! intercept the wire: record every SUBREC the host emits
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const node = rt.node
  const realSend = node.env.sink.send.bind(node.env.sink)
  node.env.sink.send = (link: number, bytes: Uint8Array) => {
    const f = new Framer().push(bytes.slice())[0]
    if (f) sends.push({ link, verb: f.verb, id: (f.value as { id?: number })?.id })
    realSend(link, bytes)
  }
  const bind = new Bind(rt)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'linkUp', link: 2, dialed: false })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  node.writes.ring.place('owned', 'bb')

  //! the handler writes a bb-owned key (parks pending the WACK) then returns the live proxy
  const h = new Host(rt, bind.data, {
    feed: (_a, ctx) => { ctx.data.owned = 1; return ctx.data },
  }, {})

  //! SUB arrives on link 2 — the handler runs, the write parks, flush-on-return suspends
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 5, m: 'feed', a: undefined }) })
  await new Promise((r) => setImmediate(r)) // let the async IIFE run up to the flush await
  assert.equal(node.writes.pending.size, 1, 'the handler write is parked (flush window open)')
  assert.equal(sends.filter((s) => s.verb === VERB.SUBREC).length, 0, 'no stream opened yet')

  //! UNSUB arrives DURING the window — must cancel the sub the handler is still flushing
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.UNSUB, { id: 5 }) })

  //! now the owner ACKs — the write commits, flush resolves, the deferred open runs... and finds it cancelled
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: node.writes.cid, n: 1, s: 1, e: 1 }) })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(sends.filter((s) => s.verb === VERB.SUBREC).length, 0, 'the cancelled sub NEVER opened a stream — no leak')

  h.destroy(); bind.destroy(); await rt.destroy()
})

test('M5-REVIEW #2/#6 — an uninterrupted SUB that writes-then-returns DOES open its stream once the write commits', async () => {
  const sends: { verb: number }[] = []
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const node = rt.node
  const realSend = node.env.sink.send.bind(node.env.sink)
  node.env.sink.send = (link: number, bytes: Uint8Array) => {
    const f = new Framer().push(bytes.slice())[0]
    if (f) sends.push({ verb: f.verb })
    realSend(link, bytes)
  }
  const bind = new Bind(rt)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'linkUp', link: 2, dialed: false })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  node.writes.ring.place('owned', 'bb')
  const h = new Host(rt, bind.data, { feed: (_a, ctx) => { ctx.data.owned = 1; return ctx.data } }, {})

  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 7, m: 'feed', a: undefined }) })
  await new Promise((r) => setImmediate(r))
  //! no UNSUB this time — the WACK lands, the write commits, flush resolves, the stream opens
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: node.writes.cid, n: 1, s: 1, e: 1 }) })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.ok(sends.filter((s) => s.verb === VERB.SUBREC).length >= 1, 'the stream opened and shipped the initial snapshot')

  h.destroy(); bind.destroy(); await rt.destroy()
})
