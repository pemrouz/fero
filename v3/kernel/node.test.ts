//! Tier-1 node suite: the kernel driven by hand-crafted events against a recording sink — no sockets, no timers, no sim.
// This is the payoff of the write-path-as-a-function design: v2's equivalent
// logic (closure-captured inside a 1604-line fero()) was untestable without
// standing up real transports; here every protocol decision is one step() call
// and every consequence is a recorded effect.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { MAX_QUEUED } from './link.ts'
import { Framer, VERB, encodeControl, encodeFrame, crcFrame } from './codec.ts'
import { REC, TAG, type EffectSink, type Env } from './env.ts'

//! recording sink — effects become an inspectable array; env.rng is fixed so backoff maths are exact.
const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (rec) => effects.push(['apply', rec]),
    persist: (batch, bytes) => effects.push(['persist', batch, bytes]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  return { node, effects, of }
}

const hello = (u: string, i = 1, l = `sim:${u}`) => encodeControl(VERB.HELLO, { u, i, l })

test('linkUp sends HELLO immediately; a valid HELLO admits the peer', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  assert.equal(of('send').length, 1) // identity first — HELLO before anything else can route
  const sent = new Framer().push(of('send')[0][2] as Uint8Array)[0]
  assert.equal(sent.verb, VERB.HELLO)
  assert.deepEqual(sent.value, { u: 'aa', i: 1, l: 'sim:aa' })

  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  assert.deepEqual(node.admitted(), ['bb'])
})

test('self-reject: a HELLO carrying our own uuid closes the link and never redials', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:elsewhere' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('aa') })
  assert.deepEqual(of('close')[0], ['close', 1, 'self'])
  node.step({ kind: 'linkDown', link: 1, reason: 'self' })
  assert.equal(of('timer').length, 0) // no redial for a deliberate close
})

test('one-logical-link-per-pair: both HELLO arrival orders converge on the link dialed by the lower uuid', () => {
  // aa < bb, so the keeper is ALWAYS aa's dialed link — regardless of which HELLO lands first
  for (const order of [[1, 2], [2, 1]] as const) {
    const { node, of } = harness('aa')
    node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' }) // aa dialed — the keeper
    node.step({ kind: 'linkUp', link: 2, dialed: false })             // bb dialed us — the loser
    for (const l of order) node.step({ kind: 'bytesIn', link: l, bytes: hello('bb') })
    const closes = of('close')
    assert.equal(closes.length, 1, `order ${order}`)
    assert.deepEqual(closes[0], ['close', 2, 'dup-link'])
    assert.equal(node.byUuid.get('bb'), 1)
    node.step({ kind: 'linkDown', link: 2, reason: 'dup-link' })
    assert.equal(of('timer').length, 0) // the loser never redials — closing it must not re-create the race
    assert.deepEqual(node.admitted(), ['bb'])
  }
})

test('local writes apply locally, stamp own provenance, and broadcast one frame per SYNCED link', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  //! admitted but not yet synced: a write here must NOT ship live (it would leapfrog the digest suffix)
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['presync'], value: 0 }] })
  assert.equal(of('send').flatMap((e) => new Framer().push(e[2] as Uint8Array)).filter((f) => f.verb === VERB.RECORDS).length, 0)
  //! the peer's digest syncs the link — it also pulls the withheld write as the suffix
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  const suffix = of('send').flatMap((e) => new Framer().push(e[2] as Uint8Array)).filter((f) => f.verb === VERB.RECORDS).flatMap((f) => f.records())
  assert.deepEqual(suffix.map((r) => r.key[0]), ['presync'])
  const sendsBefore = of('send').length

  node.step({ kind: 'write', recs: [
    { type: REC.update, key: ['k1'], value: 'v1' },
    { type: REC.update, key: ['k2'], value: { n: 2 } },
  ] })

  assert.equal(node.state.get(JSON.stringify(['k1'])), 'v1')
  const applies = of('apply')
  assert.equal(applies.length, 3) // presync + k1 + k2
  assert.deepEqual((applies[0][1] as { origin: string; seq: number }).origin, 'aa')

  const sends = of('send').slice(sendsBefore)
  assert.equal(sends.length, 1) // a synchronous batch coalesces into ONE frame — the counted invariant
  const frame = new Framer().push(sends[0][2] as Uint8Array)[0]
  const recs = frame.records()
  assert.equal(recs.length, 2)
  assert.deepEqual([recs[0].seq, recs[1].seq], [2, 3]) // contiguous seqs, one origin, one epoch
  assert.equal(recs[0].origin, 'aa')
})

test('ingest: monotone gap-tolerant dedup + Lamport merge + per-cell LWW', () => {
  const { node } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })

  const frame = (seq: number, v: unknown, origin = 'bb') =>
    encodeFrame([{ type: REC.update, key: ['k'], value: v }], { origin, baseSeq: seq, epoch: 0 })

  node.step({ kind: 'bytesIn', link: 1, bytes: frame(1, 'a') })
  assert.equal(node.state.get(JSON.stringify(['k'])), 'a')

  node.step({ kind: 'bytesIn', link: 1, bytes: frame(1, 'a') }) // duplicate delivery — dropped by the high-water
  assert.equal(node.journal.read().filter((e) => e.kind === JK.dupDrop).length, 1)

  //! Lamport seqs are monotone, NOT contiguous — a jump is a normal clock merge, applied immediately (no hold-back to leak)
  node.step({ kind: 'bytesIn', link: 1, bytes: frame(7, 'c') })
  assert.equal(node.state.get(JSON.stringify(['k'])), 'c')

  //! FIFO link + single broadcaster ⇒ an arrival below the watermark can only be a duplicate — dropped
  node.step({ kind: 'bytesIn', link: 1, bytes: frame(3, 'stale') })
  assert.equal(node.state.get(JSON.stringify(['k'])), 'c')

  //! Lamport merge-up: having seen bb@7, aa's next local write must stamp ABOVE it (locals are causally newest)
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 'local' }] })
  assert.equal(node.seq > 7, true)
  assert.equal(node.state.get(JSON.stringify(['k'])), 'local')

  //! per-cell LWW: a concurrent same-seq write from a HIGHER origin wins over a lower one, deterministically
  const s = node.seq
  node.step({ kind: 'bytesIn', link: 1, bytes: frame(s, 'from-bb') }) // bb > aa at equal (epoch, seq) — bb wins
  assert.equal(node.state.get(JSON.stringify(['k'])), 'from-bb')
  assert.ok(node.journal.read().every((e) => e.kind !== JK.lwwSkip || e.a !== 'bb'), 'bb must not have been skipped')
})

test('a dialed link that drops redials with backoff; attempts are bounded and give up loudly', () => {
  const { node, of } = harness('aa', { redialMs: 10 })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  const timers = of('timer')
  assert.equal(timers.length, 1)
  assert.equal(timers[0][3], 10) // first backoff = base (rng pinned to 0)

  // drive the retry loop to exhaustion via failed dials (linkDown with `to`, no linkUp)
  for (let i = 0; i < 20; i++) {
    const t = of('timer')[of('timer').length - 1]
    node.step({ kind: 'timer', id: t[1] as number, tag: t[2] as number })
    node.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
  }
  assert.ok(node.journal.read().some((e) => e.kind === JK.giveUp), 'exhaustion must be journal-visible')
  assert.ok(of('timer').length <= 12, `unbounded redial: ${of('timer').length} timers`)
})

test('revival: only a FAILED final attempt revives; the pending window and a peer-dialed link do not', () => {
  //! adversarial-review regression: tries increments at ARM time, so tries==MAX during the 10th
  // attempt's pending window is NOT parked — a revive there orphans the live timer into a second
  // concurrent dial chain. Revival must key on gaveUp (the final attempt actually failed).
  const { node, of } = harness('aa', { redialMs: 10, heartbeatMs: 50, hosts: ['sim:bb'] })
  const fire = (tag: number) => {
    const t = of('timer').filter((x) => x[2] === tag).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag })
  }
  const revives = () => node.journal.read().filter((e) => e.kind === JK.revive).length
  node.step({ kind: 'start' }) // dials sim:bb, arms the heartbeat
  node.step({ kind: 'linkDown', link: 900, reason: 'refused', to: 'sim:bb' })
  const exhaust = (n: number) => {
    for (let i = 0; i < n; i++) { fire(TAG.redial); node.step({ kind: 'linkDown', link: 901 + i, reason: 'refused', to: 'sim:bb' }) }
  }
  exhaust(9) // 10 arms total — the FINAL attempt's timer is now pending
  let c0 = of('connect').length
  fire(TAG.heartbeat)
  assert.equal(revives(), 0, 'the pending final attempt is not parked — no revive')
  assert.equal(of('connect').length, c0, 'no dial forked over the live chain')
  fire(TAG.redial) // the final attempt fires...
  node.step({ kind: 'linkDown', link: 950, reason: 'refused', to: 'sim:bb' }) // ...and FAILS → parked
  assert.ok(node.journal.read().some((e) => e.kind === JK.giveUp), 'give-up precedes any revive')
  fire(TAG.heartbeat)
  assert.equal(revives(), 1, 'a parked target revives exactly once per tick')
  //! the revived dial fails → a fresh chain runs to give-up again; then the PEER dials us instead
  node.step({ kind: 'linkDown', link: 951, reason: 'refused', to: 'sim:bb' })
  exhaust(9); fire(TAG.redial)
  node.step({ kind: 'linkDown', link: 952, reason: 'refused', to: 'sim:bb' })
  node.step({ kind: 'linkUp', link: 60, dialed: false }) // bb dialed US — accepted link, no `to`
  node.step({ kind: 'bytesIn', link: 60, bytes: hello('bb') }) // gossiped listen identifies it as sim:bb
  c0 = of('connect').length
  fire(TAG.heartbeat)
  assert.equal(revives(), 1, 'a live peer-dialed link clears the stale give-up instead of reviving')
  assert.equal(of('connect').length, c0, 'no dial into a dup race')
  node.step({ kind: 'linkDown', link: 60, reason: 'close' }) // accepted link dies — we do not redial those
  fire(TAG.heartbeat)
  assert.equal(revives(), 1, 'the cleared give-up stays cleared — no parked ghost')
  assert.equal(of('connect').length, c0)
})

test('the floor is silent on a paused link; a digest arriving mid-pause defers its suffix to drain', () => {
  //! adversarial-review regression: control frames queued into a drop-oldest queue are doomed work,
  // and serialising the missing suffix per inbound digest during a pause is O(suffix) discarded per
  // tick — both must be deferred to the drain-time exchange.
  const { node, of } = harness('aa', { heartbeatMs: 50 })
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) }) // synced
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }] })
  node.step({ kind: 'pause', link: 1 })
  const link = node.links.get(1)!
  const s0 = of('send').length
  const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
  node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  assert.equal(of('send').length, s0, 'no PING/digest sent on a paused link')
  assert.equal(link.queued.length, 0, 'and none parked in the doomed queue')
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) }) // peer floor ticks anyway
  assert.equal(link.queued.length, 0, 'the missing suffix must not serialise into a paused queue')
  assert.equal(of('send').length, s0)
  assert.equal(link.droppedWhilePaused, true, 'the deferred-suffix debt is marked')
  node.step({ kind: 'drain', link: 1 })
  const drained = of('send').slice(s0).map((e) => new Framer().push(e[2] as Uint8Array)[0])
  assert.deepEqual(drained.map((f) => f.verb), [VERB.DIGEST], 'drain settles the debt with ONE re-sync digest')
  assert.deepEqual(drained[0].value, { d: { aa: 2 }, r: 1 }, 'carrying the REAL log tail, reciprocal')
})

test('a node never ingests its OWN origin: an echoed self-record cannot poison the log (seed-79 regression)', () => {
  //! local writes never advance the node's own stream watermark, so a peer echoing our records back
  // (digest-snapshot race) once appended a DUPLICATE out-of-order log entry — and a non-ascending log
  // silently breaks the AE suffix walk, stranding an interior record forever.
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }] })
  const applies = of('apply').length
  //! bb echoes aa's own seq-1 record back (as an AE ship computed from a stale digest snapshot)
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['a'], value: 1 }], { origin: 'aa', baseSeq: 1, epoch: 0 }) })
  const log = node.logs.get('aa')!
  assert.deepEqual(log.map((e) => e.seq), [1, 2], 'the self-echo must NOT append — the own log is authoritative')
  assert.equal(of('apply').length, applies, 'and must not re-apply')
  assert.ok(node.journal.read().some((e) => e.kind === JK.dupDrop && e.a === 'aa'), 'journal-visible as a dup')
})

test('malformed HELLO and wire faults drop the link; unknown verbs drop the frame but keep the link', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: false })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { nope: true }) })
  assert.deepEqual(of('close')[0], ['close', 1, 'malformed-hello'])

  const { node: n2, of: of2 } = harness('cc')
  n2.step({ kind: 'linkUp', link: 1, dialed: false })
  n2.step({ kind: 'bytesIn', link: 1, bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0]) })
  assert.deepEqual(of2('close')[0], ['close', 1, 'wire-fault'])

  const { node: n3, of: of3 } = harness('dd')
  n3.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:ee' })
  n3.step({ kind: 'bytesIn', link: 1, bytes: hello('ee') })
  n3.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(99 as never) })
  assert.equal(of3('close').length, 0) // fail closed on the FRAME, not the link — an unknown verb from a newer peer is not a wire fault
  assert.ok(n3.journal.read().some((e) => e.kind === JK.frameDrop))
})

test('digest anti-entropy: admit exchanges digests; a peer digest pulls exactly the missing suffix (the dial-race loss fix)', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'write', recs: [
    { type: REC.update, key: ['pre1'], value: 1 },
    { type: REC.update, key: ['pre2'], value: { nested: true } },
    { type: REC.update, key: ['pre3'], value: 3 },
  ] })
  assert.equal(of('send').length, 0) // nobody to send to yet

  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })

  //! on admit we announce what we hold: HELLO first, then DIGEST {d:{aa:3}, r:1}
  let frames = of('send').flatMap((e) => new Framer().push(e[2] as Uint8Array))
  const digest = frames.find((f) => f.verb === VERB.DIGEST)!
  assert.deepEqual(digest.value, { d: { aa: 3 }, r: 1 })

  //! the peer's digest says it already holds aa:1 — we ship ONLY seqs 2..3, and reply r:0 to their r:1
  const before = of('send').length
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: 1 }, r: 1 }) })
  frames = of('send').slice(before).flatMap((e) => new Framer().push(e[2] as Uint8Array))
  const records = frames.filter((f) => f.verb === VERB.RECORDS).flatMap((f) => f.records())
  assert.deepEqual(records.map((r) => [r.key[0], r.seq]), [['pre2', 2], ['pre3', 3]])
  const reply = frames.find((f) => f.verb === VERB.DIGEST)!
  assert.deepEqual(reply.value, { d: { aa: 3 }, r: 0 }) // r:0 — the exchange is two-legged, never a loop
  assert.ok(node.journal.read().some((e) => e.kind === JK.aeShip && e.b === 2))
})

test('a digest with Lamport gaps ships valid split frames (encodeRuns), and losers are served too', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  //! manufacture a Lamport jump: ingest bb@5 (merges the clock to 5), then write twice (seqs 6,7 — gap 1→6 in aa's stream)
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['k'], value: 'bb5' }], { origin: 'bb', baseSeq: 5, epoch: 0 }) })
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }] })
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 'aa-wins' }] }) // beats bb@5 by Lamport

  const before = of('send').length
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) }) // a peer with NOTHING
  const frames = of('send').slice(before).flatMap((e) => new Framer().push(e[2] as Uint8Array))
  const shipped = frames.filter((f) => f.verb === VERB.RECORDS).flatMap((f) => f.records())
  //! everything we hold ships: our own stream AND bb's record (the LWW loser — the election re-runs at the receiver)
  assert.deepEqual(
    shipped.map((r) => [r.origin, r.seq]).sort(),
    [['aa', 6], ['aa', 7], ['bb', 5]].sort(),
  )
})

test('backpressure: paused links queue (bounded); overflow clears to a TAIL hole, de-syncs, and heals by digest at drain', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) }) // sync the link
  const link = node.links.get(1)!
  const sendsBefore = of('send').length

  node.step({ kind: 'pause', link: 1 })
  //! below the cap: everything queues, nothing drops
  for (let i = 0; i < 10; i++) node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(of('send').length, sendsBefore) // paused: NOTHING hits the wire
  assert.equal(link.queued.length, 10)

  //! past the cap: the WHOLE queue clears (pure tail loss — partial drops would let survivors leapfrog the
  // hole at drain and manufacture an interior gap no digest can heal), the link de-syncs, loss is journaled
  for (let i = 10; i < MAX_QUEUED + 30; i++) node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(link.queued.length, 0)
  assert.equal(link.synced, false)
  assert.ok(node.journal.read().some((e) => e.kind === JK.dropOldest), 'overflow is journal-visible, never silent')

  //! drain: nothing stale flushes; the heal digest goes out asking the peer to answer with theirs
  node.step({ kind: 'drain', link: 1 })
  const drainFrames = of('send').slice(sendsBefore).flatMap((e) => new Framer().push(e[2] as Uint8Array))
  assert.deepEqual(drainFrames.map((f) => f.verb), [VERB.DIGEST])
  assert.deepEqual(drainFrames[0].value, { d: { aa: MAX_QUEUED + 30 }, r: 1 })

  //! the peer's reply (it received nothing) re-syncs and pulls the ENTIRE tail — every "lost" write recovers
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  assert.equal(link.synced, true)
  const shipped = of('send').slice(sendsBefore).flatMap((e) => new Framer().push(e[2] as Uint8Array))
    .filter((f) => f.verb === VERB.RECORDS).flatMap((f) => f.records())
  assert.equal(shipped.length, MAX_QUEUED + 30)
  assert.equal(shipped[0].key[0], 'k0')
})

test('records before HELLO are a protocol violation: the link is closed, nothing is ingested', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: false })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 1 }], { origin: 'bb', baseSeq: 1, epoch: 0 }) })
  assert.deepEqual(of('close')[0], ['close', 1, 'records-before-hello'])
  assert.equal(node.state.size, 0)
})

test('a crc-valid frame with a malformed BODY drops the link, never crashes the node (lazy-decode FrameError net)', () => {
  const { node, of } = harness('aa')
  node.step({ kind: 'linkUp', link: 1, dialed: false })
  const bytes = encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }).slice()
  bytes[11] = 0xff // corrupt the body's vt tag...
  new DataView(bytes.buffer).setUint32(7, crcFrame(bytes, bytes.length), true) // ...and re-checksum, like a hostile peer would
  node.step({ kind: 'bytesIn', link: 1, bytes }) // must not throw
  assert.deepEqual(of('close')[0], ['close', 1, 'wire-fault'])
})

test('heartbeat: the lower uuid originates PINGs, the peer replies PONG, the timer re-arms', () => {
  const { node, of } = harness('mm', { heartbeatMs: 50 })
  node.step({ kind: 'start' })
  assert.equal(of('timer').filter((t) => t[2] === TAG.heartbeat).length, 1)

  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:zz' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('zz') }) // mm < zz — mm originates
  node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('aa') }) // aa < mm — aa originates, mm stays silent

  const hb = of('timer').find((t) => t[2] === TAG.heartbeat)!
  const sendsBefore = of('send').length
  node.step({ kind: 'timer', id: hb[1] as number, tag: TAG.heartbeat })
  const sent = of('send').slice(sendsBefore).map((e) => [e[1], new Framer().push(e[2] as Uint8Array)[0].verb])
  //! the PING side also carries the periodic AE floor: one reciprocal digest per tick, same link only
  assert.deepEqual(sent, [[1, VERB.PING], [1, VERB.DIGEST]]) // originator link only; the aa link stays silent
  const dig = of('send').slice(sendsBefore)[1]
  assert.deepEqual(new Framer().push(dig[2] as Uint8Array)[0].value, { d: {}, r: 1 }) // r=1: asks for theirs back
  assert.equal(of('timer').filter((t) => t[2] === TAG.heartbeat).length, 2) // re-armed

  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PING) })
  const last = of('send')[of('send').length - 1]
  assert.deepEqual([last[1], new Framer().push(last[2] as Uint8Array)[0].verb], [2, VERB.PONG])
})

test('stateHash is order-insensitive and remove-aware — identical states hash identically', () => {
  const { node: a } = harness('aa')
  const { node: b } = harness('bb')
  a.step({ kind: 'write', recs: [
    { type: REC.update, key: ['x'], value: 1 },
    { type: REC.update, key: ['y'], value: { n: [1, 2] } },
    { type: REC.remove, key: ['x'] },
  ] })
  b.step({ kind: 'write', recs: [{ type: REC.update, key: ['y'], value: { n: [1, 2] } }] })
  assert.equal(a.stateHash, b.stateHash)
  assert.equal(a.state.size, b.state.size)
})
