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
  //! the view comes from the MEMBER (link 1): a spoke's VIEW is dropped (I-23), and without a view the write would commit at once instead of parking
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
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
  //! the view comes from the MEMBER (link 1): a spoke's VIEW is dropped (I-23), and without a view the write would commit at once instead of parking
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
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

//! ── V4-51: a read too big for one frame is refused TYPED ─────────────────────────
// A RESULT or a SUBREC carries ONE value and cannot be cut. Past the node's frame cap (the tune row `frame`, 8 KiB
// here) the host refuses with a ScopedError, reason 'too-large', and a hint — never the untyped 'the result could not
// be sent: Error: frame exceeds MAX_FRAME' it used to send, and never a dropped link. The caller hands a `scoped: true`
// value over as-is (Caller.rehydrate), so old clients get the same typed error: no wire change.
const tooLargeHost = (methods: Record<string, (a: unknown, ctx: { data: any }) => unknown>, rows = 20, row: (i: number) => unknown = (i) => ({ b: new Uint8Array(1024).fill(i) })) => {
  const frames: { link: number; verb: number; value: unknown; bytes: number }[] = []
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0, tune: { frame: 8192 } })
  const node = rt.node
  const realSend = node.env.sink.send.bind(node.env.sink)
  node.env.sink.send = (link: number, bytes: Uint8Array) => {
    const f = new Framer().push(bytes.slice())[0]
    if (f) frames.push({ link, verb: f.verb, value: f.verb === VERB.RECORDS ? null : f.value, bytes: bytes.length })
    realSend(link, bytes)
  }
  const closes: number[] = []
  const realClose = node.env.sink.close.bind(node.env.sink)
  node.env.sink.close = (link: number, reason: string) => { closes.push(link); realClose(link, reason) }
  const bind = new Bind(rt)
  for (let i = 0; i < rows; i++) bind.data[`r${i}`] = row(i)
  const reports: string[] = []
  const host = new Host(rt, bind.data, methods, {}, (_e, what) => reports.push(what))
  //! a client on link 2 (HELLO r:1); CALL and SUB need no digest
  node.step({ kind: 'linkUp', link: 2, dialed: false })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  const results = () => frames.filter((f) => f.link === 2 && f.verb === VERB.RESULT).map((f) => ({ ...(f.value as { id: number; ok: number; v: any }), bytes: f.bytes }))
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)) }
  const done = async () => { host.destroy(); bind.destroy(); await rt.destroy() }
  return { rt, node, bind, host, frames, closes, reports, results, settle, done }
}
const read = (a: unknown, ctx: { data: any }) => (a == null ? ctx.data : ctx.data.get(a))

test('V4-51 — a whole read bigger than one frame is refused typed with plain words; the link stays up and a keyed read still answers', async () => {
  const h = tooLargeHost({ read })
  try {
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'read' }) })
    await h.settle()
    const [r] = h.results()
    assert.deepEqual([r.id, r.ok], [1, 0])
    assert.deepEqual({ ...r.v, hint: undefined }, { scoped: true, op: 'read', reason: 'too-large', replicas: 0, hint: undefined })
    assert.match(r.v.hint, /^the answer is bigger than one frame \(8 KiB\), so fero cannot send it: read one key at a time \(methods\.read\(key\)\)/)
    assert.ok(r.bytes <= 8192 + 11, 'the refusal itself fits a frame')
    assert.deepEqual(h.closes, [], 'no link dropped')
    assert.deepEqual(h.reports, ['refused a read whose answer is bigger than one frame, 8 KiB (methods.read) — the caller was told to read a smaller part'], 'one plain line for the server\'s owner')
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 2, m: 'read', a: 'r1' }) })
    await h.settle()
    const keyed = h.results()[1]
    assert.deepEqual([keyed.id, keyed.ok], [2, 1], 'a keyed read on the same link answers')
    assert.deepEqual(keyed.v.b, new Uint8Array(1024).fill(1))
  } finally { await h.done() }
})

test('V4-51 — a live subscription whose first picture is bigger than one frame fails typed; nothing is streamed and the host holds no sub', async () => {
  const h = tooLargeHost({ read })
  try {
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 5, m: 'read' }) })
    await h.settle()
    const rs = h.results()
    assert.equal(rs.length, 1)
    assert.deepEqual([rs[0].id, rs[0].ok, rs[0].v.reason, rs[0].v.op], [5, 0, 'too-large', 'read'])
    assert.match(rs[0].v.hint, /^this subscription's first picture is bigger than one frame \(8 KiB\)/)
    assert.equal(h.frames.filter((f) => f.verb === VERB.SUBREC).length, 0, 'nothing streamed')
    assert.equal(h.host.served, 0, 'the host holds no sub')
    assert.deepEqual(h.closes, [])
    assert.match(h.reports[0], /^refused a live read whose first picture is bigger than one frame, 8 KiB \(methods\.read\)/)
  } finally { await h.done() }
})

test('V4-51 — a live subscription ends typed when one change grows past one frame (a map view that grows one row); the source keeps its write', async () => {
  const h = tooLargeHost({ grow: (_a, ctx) => ctx.data.map((r: { n?: number }) => 'x'.repeat(r?.n ?? 1)) }, 0)
  try {
    h.bind.data.a = { n: 10 }
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 9, m: 'grow' }) })
    await h.settle()
    assert.equal(h.frames.filter((f) => f.verb === VERB.SUBREC).length, 1, 'the first picture streamed')
    assert.equal(h.host.served, 1)
    h.bind.data.b = { n: 5000 } // a small row; its mapped change is 5,000 characters, 15 KB as the writer counts them
    await h.settle()
    const rs = h.results()
    assert.deepEqual(rs.map((r) => [r.id, r.ok, r.v.reason]), [[9, 0, 'too-large']])
    assert.match(rs[0].v.hint, /^a change in this subscription is bigger than one frame \(8 KiB\)/)
    assert.equal(h.host.served, 0)
    assert.equal(h.frames.filter((f) => f.verb === VERB.SUBREC).length, 1, 'the change was never sent')
    assert.equal(h.rt.node.state.has(JSON.stringify(['b'])), true, 'the write itself stands')
    assert.match(h.reports[0], /^ended a live read: one change is bigger than one frame, 8 KiB \(methods\.grow\)/)
  } finally { await h.done() }
})

test('V4-51 — endLive ends every live sub streaming one proxy with a typed reason (the gather\'s hook when a member\'s share is too large); other subs stream on', async () => {
  const h = tooLargeHost({ read, other: (_a, ctx) => ctx.data.map((r: unknown) => r) }, 2)
  try {
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 1, m: 'read' }) })
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.SUB, { id: 2, m: 'other' }) })
    await h.settle()
    assert.equal(h.host.served, 2)
    const reason = { scoped: true, op: 'gather', reason: 'too-large', replicas: 2, missing: ['x'], hint: 'the rows x holds are bigger than one frame' }
    h.host.endLive(h.bind.data, reason)
    await h.settle()
    assert.deepEqual(h.results().map((r) => [r.id, r.ok, r.v]), [[1, 0, reason]], 'the sub over that proxy ended with the reason as sent')
    assert.equal(h.host.served, 1, 'the other sub streams on')
  } finally { await h.done() }
})

//! V4-51 + V4-52, together: a server's own read is what a client's read decodes (V4-52), so it is refused where a client's
// is (V4-51) — in the same words. A read too big for one frame is the same typed 'too-large'; a result the codec cannot
// carry is 'the result could not be sent: <why>' on both (the remote reply used to say 'FrameError: unencodable value
// type: bigint'). And every limit follows the node's frame cap: a write that could not go alone in one frame of it is
// refused before the stamp, typed, instead of being stamped and then thrown out of the encoder.
test('V4-51/52 — a server\'s own read too big for one frame is refused as a client\'s is: the same typed too-large; a keyed read still answers', async () => {
  const h = tooLargeHost({ read })
  try {
    await assert.rejects(h.host.invokeLocal('read', undefined), (e: { scoped?: boolean; reason?: string; op?: string; hint?: string }) =>
      e.scoped === true && e.reason === 'too-large' && e.op === 'read' && /^the answer is bigger than one frame \(8 KiB\)/.test(e.hint ?? ''))
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'read' }) })
    await h.settle()
    const [r] = h.results()
    assert.deepEqual([r.ok, r.v.reason, r.v.op], [0, 'too-large', 'read'], 'the remote read is refused the same way')
    assert.deepEqual(await h.host.invokeLocal('read', 'r1'), { b: new Uint8Array(1024).fill(1) })
  } finally { await h.done() }
})

test('V4-52 — a result fero cannot send is refused in the same words on a server\'s own call and on a client\'s', async () => {
  const h = tooLargeHost({ odd: () => ({ toys: ['ball', { n: 10n }] }) }, 0)
  try {
    await assert.rejects(h.host.invokeLocal('odd', undefined), /^Error: methods\.odd: the result could not be sent: a bigint at toys\[1\]\.n$/)
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'odd' }) })
    await h.settle()
    const [r] = h.results()
    assert.deepEqual([r.ok, r.v], [0, 'the result could not be sent: a bigint at toys[1].n'])
  } finally { await h.done() }
})

test('V4-51/52 — at a node\'s frame cap, a write that could not go alone in one frame is refused before the stamp, typed', async () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0, tune: { frame: 4096 } })
  const bind = new Bind(rt)
  try {
    assert.throws(() => { bind.data.big = { b: new Uint8Array(5000) } }, (e: Error) => e instanceof TypeError && e.message.startsWith('fero: ["big"] cannot be sent: bigger than 3.8 KiB'))
    assert.deepEqual(bind.issue([{ type: 0, key: ['big'], value: new Uint8Array(5000) }]), ['unencodable'])
    assert.equal(rt.node.seq, 0, 'nothing was stamped')
    bind.data.small = { b: new Uint8Array(1000) }
    assert.equal(rt.node.seq, 1, 'a write that fits is taken')
  } finally { bind.destroy(); await rt.destroy() }
})

//! the V4-51/52 review: copyOf's byte charge is a worst case — 3 bytes a character, 8 a number — and over a whole read it
// ran 1.5 to 4.5 times the real reply, so a server refused its own read 'too-large' where a client's reply of the same
// rows fit (from about 57-90 MiB at the production cap; a few KB at this one). The real encoder decides now, and only
// when the charge passes the room. The rows of the test above were bytes, charged exactly, so it could not see this.
test('V4-51/52 — a server\'s own whole read of text rows that fit one frame is answered, as a client\'s is; one that does not fit is refused on both', async () => {
  const h = tooLargeHost({ read }, 60, (i) => ({ s: 'x'.repeat(50), n: [i, 1, 2, 3] }))
  try {
    const mine = await h.host.invokeLocal('read', undefined) as Record<string, unknown>
    assert.equal(Object.keys(mine).length, 60, 'the server\'s own read is answered')
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'read' }) })
    await h.settle()
    const [r] = h.results()
    assert.equal(r.ok, 1, 'and the client\'s')
    assert.deepEqual(r.v, mine, 'the same answer')
    for (let i = 60; i < 200; i++) h.bind.data[`r${i}`] = { s: 'x'.repeat(50), n: [i, 1, 2, 3] }
    await assert.rejects(h.host.invokeLocal('read', undefined), (e: { reason?: string }) => e.reason === 'too-large')
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 2, m: 'read' }) })
    await h.settle()
    assert.equal(h.results()[1].v.reason, 'too-large', 'past one frame, both refuse')
  } finally { await h.done() }
})

test('V4-52 — a view\'s result fero cannot send is refused in the same words on a server\'s own call and a client\'s', async () => {
  const h = tooLargeHost({ bigs: (_a, ctx) => ctx.data.map(() => 10n) }, 2)
  try {
    await assert.rejects(h.host.invokeLocal('bigs', undefined), /^Error: methods\.bigs: the result could not be sent: a bigint at r0$/)
    h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'bigs' }) })
    await h.settle()
    const [r] = h.results()
    assert.deepEqual([r.ok, r.v], [0, 'the result could not be sent: a bigint at r0'])
  } finally { await h.done() }
})
