//! Tier-1 node suite: the kernel driven by hand-crafted events against a recording sink — no sockets, no timers, no sim.
// This is the payoff of the write-path-as-a-function design: v2's equivalent
// logic (closure-captured inside a 1604-line fero()) was untestable without
// standing up real transports; here every protocol decision is one step() call
// and every consequence is a recorded effect.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { LS, MAX_QUEUED } from './link.ts'
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
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
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

test('tune: { redials: 2 } — the chain gives up after two tries, and the curve follows redialGrowth / redialCap', () => {
  const { node, of } = harness('aa', { redialMs: 10, tune: { redials: 2, redialGrowth: 3, redialCap: 4 } })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  for (let i = 0; i < 6; i++) {
    const t = of('timer')[of('timer').length - 1]
    node.step({ kind: 'timer', id: t[1] as number, tag: t[2] as number })
    node.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
  }
  assert.equal(of('timer').length, 2, 'two tries, then give-up')
  assert.deepEqual(of('timer').map((t) => t[3]), [10, 30], 'base, then ×3 (rng pinned to 0)')
  assert.equal(node.journal.read().filter((e) => e.kind === JK.giveUp).length, 1, 'give-up journaled once')
  //! the cap: base × redialCap = 40 — a longer chain never waits past it
  const { node: n2, of: of2 } = harness('aa', { redialMs: 10, tune: { redials: 5, redialGrowth: 3, redialCap: 4 } })
  n2.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  n2.step({ kind: 'linkDown', link: 1, reason: 'close' })
  for (let i = 0; i < 6; i++) {
    const t = of2('timer')[of2('timer').length - 1]
    n2.step({ kind: 'timer', id: t[1] as number, tag: t[2] as number })
    n2.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
  }
  assert.deepEqual(of2('timer').map((t) => t[3]), [10, 30, 40, 40, 40])
})

test('a dead MEMBER link runs the short chain (memberRedials = 5); a dial that never linked up still runs the long one', () => {
  //! a restored view with bb as a member: the link to bb is admitted, then dies — that is a crashed member,
  // and its chain is what holds eviction, so it is capped at memberRedials. The dial to cc (in hosts, never
  // linked up) is the generic chain and keeps the long cap.
  const { node, of } = harness('aa', { redialMs: 10, hosts: ['sim:bb', 'sim:cc'], boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  assert.equal(node.links.get(1)!.state, LS.admitted)
  node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  node.step({ kind: 'linkDown', link: 900, reason: 'refused', to: 'sim:cc' }) // cc never linked up
  //! drive both chains: fire every armed redial timer in arming order and fail its dial. The i-th redial
  // timer and the i-th JK.redial row are the same arm (#redial emits both), so the row names the target.
  let fired = 0
  for (;;) {
    const timers = of('timer').filter((x) => x[2] === TAG.redial)
    if (fired >= timers.length) break
    const t = timers[fired++]
    const to = node.journal.read().filter((e) => e.kind === JK.redial)[fired - 1].b as string
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    node.step({ kind: 'linkDown', link: 900 + fired, reason: 'refused', to })
  }
  const redials = (to: string) => node.journal.read().filter((e) => e.kind === JK.redial && e.b === to).length
  assert.equal(redials('sim:bb'), 5, 'the member chain: memberRedials tries, then give-up')
  assert.equal(redials('sim:cc'), 10, 'the generic chain: redials tries')
  assert.deepEqual(node.journal.read().filter((e) => e.kind === JK.giveUp).map((e) => e.a).sort(), ['sim:bb', 'sim:cc'])
  assert.ok(!node.dialing('sim:bb') && !node.dialing('sim:cc'), 'both chains ended — the eviction hold is released')
})

test('the other half of the gate: an admitted NON-member link, and a CLIENT\'s member link, both keep the long chain', () => {
  //! only a SERVER's lost MEMBER link is an eviction clock. A peer outside the committed view (cc, admitted
  // while the view is {aa, bb}) is not; nor is anything a client dials — a client evicts nobody, and with
  // heartbeats off it would give up on a restarting server after 3 s instead of 19 s and never come back.
  const exhaust = (h: ReturnType<typeof harness>) => {
    let fired = 0
    for (;;) {
      const timers = h.of('timer').filter((x) => x[2] === TAG.redial)
      if (fired >= timers.length) break
      const t = timers[fired++]
      const to = h.node.journal.read().filter((e) => e.kind === JK.redial)[fired - 1].b as string
      h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
      h.node.step({ kind: 'linkDown', link: 900 + fired, reason: 'refused', to })
    }
    return (to: string) => h.node.journal.read().filter((e) => e.kind === JK.redial && e.b === to).length
  }
  const s = harness('aa', { redialMs: 10, hosts: ['sim:cc'], boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  s.node.step({ kind: 'start' })
  s.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:cc' })
  s.node.step({ kind: 'bytesIn', link: 1, bytes: hello('cc') })
  assert.equal(s.node.links.get(1)!.state, LS.admitted)
  assert.ok(!s.node.membership.isMember('cc'), 'admitted, but outside the committed view')
  s.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  assert.equal(exhaust(s)('sim:cc'), 10, 'a non-member link: the generic chain')
  const c = harness('zz', { redialMs: 10, client: true, hosts: ['sim:bb'] })
  c.node.step({ kind: 'start' })
  c.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.ok(c.node.membership.isMember('bb'), 'the client follows its feeder\'s view: bb IS a member')
  assert.equal(c.node.links.get(1)!.state, LS.admitted)
  c.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  assert.equal(exhaust(c)('sim:bb'), 10, 'a client\'s member link: the generic chain — a client evicts nobody')
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

test('a view install during a running redial chain dials nobody that chain is already dialing: one timer line, the full member chain', () => {
  //! the install loop dials every member it holds no link to (the joiner's side of a join, a healed evictee's
  // peers). It used to dial bb too while bb's chain was mid-backoff: that dial failed, its linkDown armed a
  // SECOND timer on the same chain entry, and the two timer lines shared the tries, so the chain (and the
  // eviction hold it carries) gave up after 4 timer fires instead of 5, about half the time. The chain owns
  // the target until it ends; a member with no chain (dd, new in this view) is still dialed at once.
  const { node, of } = harness('aa', { redialMs: 10, hosts: ['sim:bb', 'sim:cc'], boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } })
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:cc' })
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('cc') })
  node.step({ kind: 'linkDown', link: 1, reason: 'cut' }) // bb crashed: the member chain starts, one timer armed
  const redialTimers = () => of('timer').filter((x) => x[2] === TAG.redial)
  assert.equal(redialTimers().length, 1)
  assert.ok(node.dialing('sim:bb'))
  const connects = (to: string) => of('connect').filter((x) => x[1] === to).length
  const c0 = connects('sim:bb')
  //! cc floods view 2 (dd joined); bb is still a member of it, and aa holds no link to bb
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd']] }) })
  assert.equal(node.epoch, 2, 'the view installed')
  assert.equal(connects('sim:dd'), 1, 'a member with no chain is dialed at once')
  assert.equal(connects('sim:bb'), c0, 'no dial over the running chain')
  //! (a forked dial would fail here, while bb is down, and arm a second timer line)
  if (connects('sim:bb') > c0) node.step({ kind: 'linkDown', link: 800, reason: 'refused', to: 'sim:bb' })
  assert.equal(redialTimers().length, 1, 'still one timer line')
  //! run the chain out: fire bb's timers in arming order and fail each dial; give-up after exactly five
  let fired = 0
  const gaveUp = () => node.journal.read().some((e) => e.kind === JK.giveUp && e.a === 'sim:bb')
  while (!gaveUp() && fired < redialTimers().length) {
    const t = redialTimers()[fired++]
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    node.step({ kind: 'linkDown', link: 900 + fired, reason: 'refused', to: 'sim:bb' })
  }
  assert.ok(gaveUp())
  assert.equal(fired, 5, 'the member chain gave up after its five tries, not after four')
})

test('two linkDowns toward one target arm ONE redial chain: a timer already pending owns the target, and the tries are neither shared nor forked', () => {
  //! the double-arm (STATUS, 2026-10-09): #redial never looked for a timer already pending toward its
  // target, so a second linkDown toward the same listen (a crossing dial cut while both links were up —
  // the dialed link's `to` and the accepted link's gossiped listen name one address) armed a second
  // timer line on the same entry; the two lines shared the tries, so the chain gave up in about half
  // its time. Now a pending timer owns the target: the second linkDown is a no-op, exactly as the view
  // install's own guard (membership.ts) already treats a dialing target.
  const { node, of } = harness('aa', { redialMs: 10 })
  const redialTimers = () => of('timer').filter((x) => x[2] === TAG.redial)
  node.step({ kind: 'linkDown', link: 900, reason: 'refused', to: 'sim:bb' })
  node.step({ kind: 'linkDown', link: 901, reason: 'refused', to: 'sim:bb' }) // a second failed dial, same target
  assert.equal(redialTimers().length, 1, 'one chain: the pending timer owns the target')
  assert.equal(node.journal.read().filter((e) => e.kind === JK.redial).length, 1, 'one redial row — the second linkDown armed nothing')
  //! run the chain out, with a stray linkDown toward the target after EVERY fire (the other link line of a
  // crossing pair dying late, a late refused dial): the chain still takes its full ten tries
  let fired = 0
  const gaveUp = () => node.journal.read().some((e) => e.kind === JK.giveUp && e.a === 'sim:bb')
  while (!gaveUp() && fired < redialTimers().length) {
    const t = redialTimers()[fired++]
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    node.step({ kind: 'linkDown', link: 910 + fired, reason: 'refused', to: 'sim:bb' })
    if (!gaveUp()) {
      assert.ok(node.dialing('sim:bb'), `after fire ${fired} the chain is still dialing`)
      node.step({ kind: 'linkDown', link: 950 + fired, reason: 'refused', to: 'sim:bb' }) // the stray one
      assert.equal(redialTimers().length, fired + 1, `after fire ${fired}: one timer line, no fork`)
      assert.ok(node.dialing('sim:bb'), `after the stray linkDown ${fired} the chain is still dialing — no early give-up`)
    }
  }
  assert.ok(gaveUp())
  assert.equal(fired, 10, 'the generic chain gave up after its ten tries, not sooner')
  assert.equal(node.journal.read().filter((e) => e.kind === JK.giveUp).length, 1, 'give-up journaled once')
  assert.deepEqual(redialTimers().map((t) => t[3]), [10, 20, 40, 80, 160, 320, 320, 320, 320, 320], 'the one chain\'s own curve: ×2 per try, capped at 32 × base (rng pinned to 0)')
})

test('a member that dies right after a reconnect, while an older chain\'s timer is still pending, gets a FRESH member chain at the base delay', () => {
  //! the review race (2026-10-09): a successful identify deletes the backoff entry but leaves the old
  // chain's timer pending, up to 32 × base away. Letting that orphan own the target lost the `member`
  // mark (first fix: eviction in about 20 s, not 3.4 — V4-20), and then still made the member chain
  // wait for the orphan's long delay (second review: median eviction 4.3 s against 2.0 s on the old
  // kernel). The dead member's linkDown now cancels the orphan and starts the member chain at once.
  const { node, of } = harness('aa', { redialMs: 10, hosts: ['sim:bb'], boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  node.step({ kind: 'start' })
  //! the redial timers still pending: armed, neither cancelled nor fired
  const fired = new Set<unknown>()
  const live = () => { const gone = new Set(of('cancel').map((c) => c[1])); return of('timer').filter((x) => x[2] === TAG.redial && !gone.has(x[1]) && !fired.has(x[1])) }
  const fire = (t: unknown[]) => { fired.add(t[1]); node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial }) }
  //! bb unreachable: a generic chain that has climbed to a long delay (four tries: 10, 20, 40, 80)
  for (let i = 0; i < 4; i++) {
    const t = live().at(-1)
    if (t) fire(t)
    node.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
  }
  const orphan = live().at(-1)!
  assert.equal(orphan[3], 80, 'the old chain\'s pending timer is 80 ms away')
  //! bb comes back and dials US first: admitted, and the identify resets the entry — the old timer stays out
  node.step({ kind: 'linkUp', link: 60, dialed: false })
  node.step({ kind: 'bytesIn', link: 60, bytes: hello('bb') })
  assert.equal(node.links.get(60)!.state, LS.admitted)
  assert.ok(!node.dialing('sim:bb'), 'the identify reset the chain')
  //! bb crashes now: a dead MEMBER link, while the orphan is still pending
  const rows0 = node.journal.read().filter((e) => e.kind === JK.redial).length
  node.step({ kind: 'linkDown', link: 60, reason: 'cut' })
  assert.ok(of('cancel').some((c) => c[1] === orphan[1]), 'the orphaned timer is cancelled')
  assert.equal(live().length, 1, 'one timer line: the member chain\'s own')
  assert.equal(live()[0][3], 10, 'the member chain starts at the base delay, not at the orphan\'s 80 ms')
  assert.ok(node.dialing('sim:bb'), 'eviction is held while the member chain runs')
  //! run it out
  let tries = 0
  const gaveUp = () => node.journal.read().some((e) => e.kind === JK.giveUp && e.a === 'sim:bb')
  while (!gaveUp() && tries < 20) {
    assert.equal(live().length, 1, `try ${tries + 1}: one timer line`)
    fire(live()[0])
    tries++
    node.step({ kind: 'linkDown', link: 910 + tries, reason: 'refused', to: 'sim:bb' })
  }
  assert.ok(gaveUp())
  assert.equal(node.journal.read().filter((e) => e.kind === JK.redial).length - rows0, 5, 'the member chain: memberRedials tries after the crash, not the generic ten')
  assert.equal(tries, 5, 'the member chain\'s five tries and nothing else')
  assert.ok(!node.dialing('sim:bb'), 'the chain ended — the eviction hold is released')
})

test('a member that dies while a GENERIC chain toward it is running gets the member chain, and a later linkDown never restarts it', () => {
  //! the open-path half of the review race (2026-10-09, sim seed 2): the peer closed my duplicate dial
  // before I identified it, so that hello-state link's linkDown started a GENERIC chain toward a live
  // member. When the member then crashed, its linkDown found that chain pending and armed nothing: ten
  // tries, eviction at about 20 s. The member linkDown now replaces it with the member chain.
  const { node, of } = harness('aa', { redialMs: 10, hosts: ['sim:bb'], boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  node.step({ kind: 'start' })
  //! the redial timers still pending: armed, neither cancelled nor fired
  const fired = new Set<unknown>()
  const live = () => { const gone = new Set(of('cancel').map((c) => c[1])); return of('timer').filter((x) => x[2] === TAG.redial && !gone.has(x[1]) && !fired.has(x[1])) }
  const fire = (t: unknown[]) => { fired.add(t[1]); node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial }) }
  node.step({ kind: 'linkUp', link: 60, dialed: false })
  node.step({ kind: 'bytesIn', link: 60, bytes: hello('bb') })
  assert.equal(node.links.get(60)!.state, LS.admitted)
  //! a dial of mine to bb links up and the peer closes it as the duplicate before its HELLO reaches me
  node.step({ kind: 'linkUp', link: 70, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'linkDown', link: 70, reason: 'dup-link' })
  assert.equal(live().length, 1, 'that close started a generic chain toward bb')
  const generic = live()[0]
  //! let the generic chain climb once, so its pending delay is no longer the base
  fire(generic)
  node.step({ kind: 'linkDown', link: 71, reason: 'refused', to: 'sim:bb' })
  const stale = live().at(-1)!
  assert.equal(stale[3], 20)
  //! bb crashes: the member link dies
  const rows0 = node.journal.read().filter((e) => e.kind === JK.redial).length
  node.step({ kind: 'linkDown', link: 60, reason: 'cut' })
  assert.ok(of('cancel').some((c) => c[1] === stale[1]), 'the generic chain\'s pending timer is cancelled')
  assert.equal(live().length, 1, 'one timer line')
  assert.equal(live()[0][3], 10, 'the member chain starts fresh at the base delay')
  //! a stray linkDown toward bb (a late refused dial) leaves the member chain alone
  node.step({ kind: 'linkDown', link: 72, reason: 'refused', to: 'sim:bb' })
  assert.equal(live().length, 1, 'the stray linkDown armed nothing and cancelled nothing')
  let tries = 0
  const gaveUp = () => node.journal.read().some((e) => e.kind === JK.giveUp && e.a === 'sim:bb')
  while (!gaveUp() && tries < 20) {
    assert.equal(live().length, 1, `try ${tries + 1}: one timer line`)
    fire(live()[0])
    tries++
    node.step({ kind: 'linkDown', link: 910 + tries, reason: 'refused', to: 'sim:bb' })
  }
  assert.ok(gaveUp())
  assert.equal(tries, 5, 'the member chain\'s five tries, not what was left of the generic ten')
  assert.equal(node.journal.read().filter((e) => e.kind === JK.redial).length - rows0, 5)
  assert.deepEqual(of('timer').filter((x) => x[2] === TAG.redial).slice(-5).map((t) => t[3]), [10, 20, 40, 80, 160], 'the member chain\'s own curve')
})

test('a NON-member link that dies while an orphaned redial timer is pending marks the target dialing, so a view install does not dial over that timer', () => {
  //! the orphan's other door (2026-10-09 review): an identify deletes the backoff entry and leaves an older
  // chain's timer pending. A dead MEMBER link cancels that timer (the member rule); a dead NON-member link
  // does not, and its linkDown writes the fresh entry, so dialing() reads true while the orphan is out. The
  // view install then leaves the target to that timer (V4-28's rule) instead of dialing it a second time,
  // which on a live peer is a crossing dial and a dup-link close.
  const { node, of } = harness('aa', { redialMs: 10, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['cc', 'sim:cc']] } })
  node.step({ kind: 'start' })
  node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:cc' })
  node.step({ kind: 'bytesIn', link: 2, bytes: hello('cc') })
  const fired = new Set<unknown>()
  const live = () => { const gone = new Set(of('cancel').map((c) => c[1])); return of('timer').filter((x) => x[2] === TAG.redial && !gone.has(x[1]) && !fired.has(x[1])) }
  //! dd (not a member) is unreachable: a generic chain, one timer out
  node.step({ kind: 'linkDown', link: 900, reason: 'refused', to: 'sim:dd' })
  const orphan = live()[0]
  assert.ok(orphan && live().length === 1)
  //! dd dials US: admitted outside the view, and the identify resets the entry — the old timer stays out
  node.step({ kind: 'linkUp', link: 60, dialed: false })
  node.step({ kind: 'bytesIn', link: 60, bytes: hello('dd') })
  assert.equal(node.links.get(60)!.state, LS.admitted)
  assert.ok(!node.membership.isMember('dd'))
  assert.ok(!node.dialing('sim:dd'), 'the identify reset the chain')
  //! dd's link dies: a NON-member linkDown toward its gossiped listen, while the orphan is pending
  node.step({ kind: 'linkDown', link: 60, reason: 'cut' })
  assert.deepEqual(live().map((t) => t[1]), [orphan[1]], 'the orphan still owns the target: nothing cancelled, nothing armed')
  assert.ok(node.dialing('sim:dd'), 'the target reads dialing while the orphan is out')
  //! cc floods view 2 with dd in it; aa holds no link to dd
  const connects = () => of('connect').filter((x) => x[1] === 'sim:dd').length
  const c0 = connects()
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['cc', 'sim:cc'], ['dd', 'sim:dd']] }) })
  assert.equal(node.epoch, 2, 'the view installed')
  assert.equal(connects(), c0, 'no install dial over the pending orphan')
  //! the orphan fires: that is the one dial
  fired.add(orphan[1])
  node.step({ kind: 'timer', id: orphan[1] as number, tag: TAG.redial })
  assert.equal(connects(), c0 + 1)
})

test('the floor is silent on a paused link; a digest arriving mid-pause defers its suffix to drain', () => {
  //! adversarial-review regression: control frames queued into a drop-oldest queue are doomed work,
  // and serialising the missing suffix per inbound digest during a pause is O(suffix) discarded per
  // tick — both must be deferred to the drain-time exchange.
  //! two hosts, one linked: genesis waits for the mesh, so the tick's only business here is the floor
  // (a hostless listener with one member link would propose view 1 on this tick — I-22)
  const { node, of } = harness('aa', { heartbeatMs: 50, hosts: ['sim:bb', 'sim:cc'] })
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

//! ── the admit exchange has ONE opener (2026-10-06) ───────────────────────────────────────────────
// Two real kernels wired back to back, frames delivered in FIFO order (what TCP gives). Each side
// holds records the other lacks, then the link comes up. The old rule had BOTH ends open with an
// r=1 digest: each end shipped its suffix on the peer's r=1, then shipped it AGAIN on the peer's
// r=0 reply (that reply's tails were built before the first suffix landed), and the receiver
// dup-dropped the second copy. RED on the old kernel: aeShip 2+2, four digest frames, dupDrops.
const pair = (a: ReturnType<typeof harness>, b: ReturnType<typeof harness>) => {
  const cur = [0, 0]
  const pump = () => {
    for (let moved = true; moved;) {
      moved = false
      for (const [i, from, to] of [[0, a, b], [1, b, a]] as const) {
        const sends = from.of('send')
        while (cur[i] < sends.length) { to.node.step({ kind: 'bytesIn', link: 1, bytes: sends[cur[i]++][2] as Uint8Array }); moved = true }
      }
    }
  }
  const up = () => {
    a.node.step({ kind: 'linkUp', link: 1, dialed: true, to: `sim:${b.node.uuid}` })
    b.node.step({ kind: 'linkUp', link: 1, dialed: false })
    pump()
  }
  const jk = (h: ReturnType<typeof harness>, kind: number) => h.node.journal.read().filter((e) => e.kind === kind)
  return { up, pump, jk }
}
const put = (h: ReturnType<typeof harness>, keys: string[]) => {
  for (const k of keys) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [k], value: k }] })
}

test('admit: the lower uuid opens the digest exchange, so each missing suffix ships ONCE (aeShip 1+1, dupDrop 0+0, two digest frames)', () => {
  //! whichever side DIALS, the lower uuid opens — the rule is direction-independent
  for (const dialer of ['aa', 'bb']) {
    const [aa, bb] = [harness('aa'), harness('bb')]
    put(aa, ['a1', 'a2', 'a3'])
    put(bb, ['b1', 'b2', 'b3', 'b4'])
    const p = dialer === 'aa' ? pair(aa, bb) : pair(bb, aa)
    p.up()
    assert.deepEqual(p.jk(aa, JK.digestOut).map((e) => e.b), [1], `${dialer} dials: aa (lower) opens with r=1, once`)
    assert.deepEqual(p.jk(bb, JK.digestOut).map((e) => e.b), [0], `${dialer} dials: bb (higher) only answers, r=0`)
    assert.deepEqual(p.jk(aa, JK.aeShip).map((e) => e.b), [3], `${dialer} dials: aa ships its 3 records once`)
    assert.deepEqual(p.jk(bb, JK.aeShip).map((e) => e.b), [4], `${dialer} dials: bb ships its 4 records once`)
    assert.equal(p.jk(aa, JK.dupDrop).length + p.jk(bb, JK.dupDrop).length, 0, `${dialer} dials: nothing arrives twice`)
    assert.equal(aa.node.state.size, 7)
    assert.equal(aa.node.stateHash, bb.node.stateHash, `${dialer} dials: converged`)
    assert.ok(aa.node.links.get(1)!.synced && bb.node.links.get(1)!.synced, `${dialer} dials: BOTH ends synced by the one exchange`)
    //! live records flow both ways afterwards, still nothing twice
    put(aa, ['a4']); put(bb, ['b5']); p.pump()
    assert.equal(aa.node.stateHash, bb.node.stateHash)
    assert.equal(aa.node.state.size, 9)
    assert.equal(p.jk(aa, JK.dupDrop).length + p.jk(bb, JK.dupDrop).length, 0)
  }
})

test('admit: one side holds everything — the single exchange heals in BOTH directions', () => {
  //! lower has it all: its r=1 says so; bb has nothing to ship and answers r=0 with empty tails; aa ships
  //! higher has it all: aa's r=1 carries empty tails, so bb ships at once; bb's r=0 reply pulls nothing
  for (const full of ['aa', 'bb']) {
    const [aa, bb] = [harness('aa'), harness('bb')]
    put(full === 'aa' ? aa : bb, ['k1', 'k2', 'k3'])
    const p = pair(aa, bb)
    p.up()
    const [has, lacks] = full === 'aa' ? [aa, bb] : [bb, aa]
    assert.deepEqual(p.jk(has, JK.aeShip).map((e) => e.b), [3], `${full} holds all: it ships 3, once`)
    assert.equal(p.jk(lacks, JK.aeShip).length, 0, `${full} holds all: the empty side ships nothing`)
    assert.equal(p.jk(aa, JK.digestOut).length + p.jk(bb, JK.digestOut).length, 2, 'two digest frames, not four')
    assert.equal(p.jk(aa, JK.dupDrop).length + p.jk(bb, JK.dupDrop).length, 0)
    assert.equal(lacks.node.state.size, 3)
    assert.equal(aa.node.stateHash, bb.node.stateHash)
    assert.ok(aa.node.links.get(1)!.synced && bb.node.links.get(1)!.synced)
  }
})

test('admit: the higher uuid stays quiet until the opener speaks; a server never opens toward a client', () => {
  const frames = (h: ReturnType<typeof harness>) => h.of('send').flatMap((e) => new Framer().push(e[2] as Uint8Array))
  const bb = harness('bb')
  bb.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:aa' })
  bb.node.step({ kind: 'bytesIn', link: 1, bytes: hello('aa') })
  assert.deepEqual(frames(bb).map((f) => f.verb), [VERB.HELLO], 'bb > aa: admitted, no digest of its own')
  bb.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  assert.deepEqual(frames(bb).map((f) => f.verb), [VERB.HELLO, VERB.DIGEST], 'it answers the opener')
  assert.deepEqual(frames(bb)[1].value, { d: {}, r: 0 })
  //! a client link: the CLIENT opens (to its primary). The server never does, whichever uuid is lower —
  // a client never ANSWERED a non-primary digest (single-feeder rule); it only consumed it as confirm
  // evidence, and no guarantee a client gives reads those marks (a spoke proves its writes at the primary)
  for (const client of ['zz', '00']) {
    const aa = harness('aa')
    aa.node.step({ kind: 'linkUp', link: 1, dialed: false })
    aa.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: client, i: 1, l: '', r: 1 }) })
    assert.deepEqual(frames(aa).map((f) => f.verb), [VERB.HELLO], `server aa, client ${client}: no digest from the server`)
    put(aa, ['held'])
    aa.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
    const out = frames(aa).slice(1)
    assert.deepEqual(out.map((f) => f.verb), [VERB.RECORDS, VERB.DIGEST], `client ${client} opened: the server ships, then answers r=0`)
    assert.equal(aa.node.links.get(1)!.synced, true)
  }
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

//! overlapping cells (V4-18): a whole-row write and a field write on one row are two cells. The rule:
// the newer stamp wins ACROSS depth — a row write at T hides every field cell at or below T, a field
// write newer than T shows on top. Both arrival orders must give the same cells AND the same object.
// `project` folds the apply effects the way the api's lane does (replace at the path, delete at the
// path, a deep write under an absent or non-object row vivifies `{}` there, a remove under one is a
// no-op) — the object a screen would show, for OBJECT rows and scalars. Probed against data's lane.
// ARRAYS are modelled, not mirrored: here a deep write and a deep remove under an array are ignored,
// where data writes into an array (an index write replaces the element, a field inside an element
// lands, a non-index key becomes a hidden array property) and refuses only a remove of the array's own
// key (a sparse hole). So a REPAIR the kernel makes up directly under an array (seq 0) is modelled as
// the crash it would be without the substrate's no-op; a user's own record removing an array element
// is modelled as that no-op. What lands under an array is the guarantee's limit, not checked here.
const project = (effects: unknown[][]): Record<string, unknown> => {
  const root: Record<string, unknown> = {}
  for (const e of effects) {
    if (e[0] !== 'apply') continue
    const r = e[1] as { type: number; key: string[]; value?: unknown; at?: string }
    const path = r.key.length ? r.key : [r.at ?? '']
    let o: Record<string, unknown> = root
    let blocked = false
    for (let i = 0; i < path.length - 1; i++) {
      if (Array.isArray(o[path[i]])) {
        if (r.type === REC.remove && i === path.length - 2 && (e[1] as { seq: number }).seq === 0) throw new Error(`a seq-0 repair removes array element [${path[i + 1]}] under ${JSON.stringify(path.slice(0, i + 1))}`)
        blocked = true; break
      }
      if (typeof o[path[i]] !== 'object' || o[path[i]] === null) {
        if (r.type === REC.remove) { blocked = true; break }
        o[path[i]] = {}
      }
      o = o[path[i]] as Record<string, unknown>
    }
    if (blocked) continue
    if (r.type === REC.remove) delete o[path[path.length - 1]]
    else o[path[path.length - 1]] = structuredClone(r.value)
  }
  return root
}
//! a node fed `recs` in the given order, each from its own origin at its own seq (epoch 0 throughout)
const fed = (recs: { seq: number; origin: string; rec: { type: number; key: string[]; value?: unknown } }[]) => {
  const h = harness('aa')
  h.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: hello('bb') })
  for (const r of recs) h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([r.rec], { origin: r.origin, baseSeq: r.seq, epoch: 0 }) })
  return h
}
const cells = (n: Node) => Object.fromEntries([...n.state].sort())
const bothOrders = (a: Parameters<typeof fed>[0][number], b: Parameters<typeof fed>[0][number]) => [fed([a, b]), fed([b, a])]

test('overlapping cells (V4-18): a newer stamp wins across depth — both arrival orders of a row write and a field write agree on the cells and the object', () => {
  const row = (seq: number, v: unknown) => ({ seq, origin: 'bb', rec: { type: REC.update, key: ['g'], value: v } })
  const gone = (seq: number) => ({ seq, origin: 'bb', rec: { type: REC.remove, key: ['g'] } })
  const leaf = (seq: number, v: unknown) => ({ seq, origin: 'cc', rec: { type: REC.update, key: ['g', 'stock'], value: v } })
  //! (a) the field write is NEWER than the row write: it shows on top, in both orders
  for (const h of bothOrders(row(5, { stock: 3 }), leaf(7, 9))) {
    assert.deepEqual(cells(h.node), { '["g"]': { stock: 3 }, '["g","stock"]': 9 })
    assert.deepEqual(project(h.effects), { g: { stock: 9 } })
  }
  //! (b) the row write is NEWER: the older field is hidden — swept when it arrived first, refused when
  // it arrived second — and never comes back
  for (const h of bothOrders(row(7, { stock: 3 }), leaf(5, 9))) {
    assert.deepEqual(cells(h.node), { '["g"]': { stock: 3 } })
    assert.deepEqual(project(h.effects), { g: { stock: 3 } })
    assert.equal(h.node.journal.read().filter((e) => e.kind === JK.subsumed).length, 1, 'the loser is journaled as subsumed')
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([leaf(6, 11).rec], { origin: 'dd', baseSeq: 6, epoch: 0 }) })
    assert.deepEqual(cells(h.node), { '["g"]': { stock: 3 } }, 'a late field write still below the row stamp loses')
    assert.deepEqual(project(h.effects), { g: { stock: 3 } })
  }
  //! (c) a row REMOVE is a parent write too: newer than the field, both are gone
  for (const h of bothOrders(gone(7), leaf(5, 9))) {
    assert.deepEqual(cells(h.node), {})
    assert.deepEqual(project(h.effects), {})
  }
  //! (d) a field newer than the row's remove survives it (the row is reborn with that one field)
  for (const h of bothOrders(gone(5), leaf(7, 9))) {
    assert.deepEqual(cells(h.node), { '["g","stock"]': 9 })
    assert.deepEqual(project(h.effects), { g: { stock: 9 } })
  }
  //! (e) a field REMOVE newer than the row takes that one field out of the row — in both orders. The
  // remove is a tombstone, not a live cell: arriving first, it must be found again when the older row
  // lands and be re-applied on top of it (the row's value still carries the field)
  const drop = (seq: number) => ({ seq, origin: 'cc', rec: { type: REC.remove, key: ['g', 'stock'] } })
  for (const h of bothOrders(row(5, { stock: 3, name: 'n' }), drop(7))) {
    assert.deepEqual(cells(h.node), { '["g"]': { stock: 3, name: 'n' } })
    assert.deepEqual(project(h.effects), { g: { name: 'n' } })
    assert.deepEqual(h.node.fields('g'), ['["g","stock"]'], 'the tombstone stays indexed above its live row')
  }
  //! (f) a field remove OLDER than the row is hidden by it, in both orders, and leaves the index
  for (const h of bothOrders(row(7, { stock: 3 }), drop(5))) {
    assert.deepEqual(cells(h.node), { '["g"]': { stock: 3 } })
    assert.deepEqual(project(h.effects), { g: { stock: 3 } })
    assert.deepEqual(h.node.fields('g'), [])
  }
  //! the two orders hash identically — the sweep maintains the rolling hash exactly like a remove
  const [x, y] = bothOrders(row(7, { stock: 3 }), leaf(5, 9))
  assert.equal(x.node.stateHash, y.node.stateHash)
})

test('overlapping cells (V4-18): a field remove takes back what the field alone had made up — a row or a level only a vivify created goes, a scalar it was written over comes back', () => {
  const put = (seq: number, key: string[], value: unknown) => ({ seq, origin: 'cc', rec: { type: REC.update, key, value } })
  const cut = (seq: number, key: string[]) => ({ seq, origin: 'dd', rec: { type: REC.remove, key } })
  //! (a) no row at all: the field made the row, the remove un-makes it — the node that refused the write shows the same
  for (const h of bothOrders(put(5, ['g', 'a'], 1), cut(7, ['g', 'a']))) {
    assert.deepEqual(cells(h.node), {})
    assert.deepEqual(project(h.effects), {})
  }
  //! (b) a live row without `f`: the deep write made `f`, the remove of x leaves no `f: {}` behind
  for (const h of bothOrders(put(5, ['g', 'f', 'x'], 1), cut(7, ['g', 'f', 'x']))) {
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['g'], value: { k: 0 } }], { origin: 'bb', baseSeq: 3, epoch: 0 }) })
    assert.deepEqual(cells(h.node), { '["g"]': { k: 0 } })
    assert.deepEqual(project(h.effects), { g: { k: 0 } })
  }
  //! (c) the row HAS `f` as an object: it was never made up, it stays (with x gone)
  const hc = fed([put(3, ['g'], { f: { x: 1, y: 2 } }), put(5, ['g', 'f', 'x'], 9), cut(7, ['g', 'f', 'x'])])
  assert.deepEqual(project(hc.effects), { g: { f: { y: 2 } } })
  //! (d) the row has `f` as a scalar the deep write was written over: the scalar comes back
  const hd = fed([put(3, ['g'], { f: 5 }), put(5, ['g', 'f', 'x'], 9), cut(7, ['g', 'f', 'x'])])
  assert.deepEqual(project(hd.effects), { g: { f: 5 } })
  //! (e) a level a NEWER field remove took out stays gone, even though the row's value has it as an object
  const he = fed([put(3, ['g'], { f: { y: 2 } }), cut(5, ['g', 'f']), put(7, ['g', 'f', 'x'], 9), cut(9, ['g', 'f', 'x'])])
  assert.deepEqual(project(he.effects), { g: {} })
  //! (f) a sibling field keeps the level alive
  const hf = fed([put(5, ['g', 'f', 'x'], 1), put(6, ['g', 'f', 'y'], 2), cut(7, ['g', 'f', 'x'])])
  assert.deepEqual(project(hf.effects), { g: { f: { y: 2 } } })
})

test('overlapping cells (V4-18): a field remove above its row rides out a late older row, and a row write above it releases it', () => {
  const h = fed([
    { seq: 7, origin: 'cc', rec: { type: REC.remove, key: ['g', 'a'] } },
    { seq: 5, origin: 'bb', rec: { type: REC.update, key: ['g'], value: { a: 1, b: 2 } } },
  ])
  const ka = JSON.stringify(['g', 'a']), kg = JSON.stringify(['g'])
  assert.deepEqual(project(h.effects), { g: { b: 2 } })
  assert.deepEqual(h.node.versions.get(ka), { epoch: 0, seq: 7, origin: 'cc' }, 'the remove is still the winner of its cell')
  //! a late field write between the two stamps loses to the tombstone, not to the row
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['g', 'a'], value: 3 }], { origin: 'dd', baseSeq: 6, epoch: 0 }) })
  assert.deepEqual(project(h.effects), { g: { b: 2 } })
  //! a row write ABOVE the remove carries the whole row again: the tombstone is swept (its version becomes
  // the row's stamp, it leaves the index) and the field shows
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['g'], value: { a: 4 } }], { origin: 'bb', baseSeq: 9, epoch: 0 }) })
  assert.deepEqual(project(h.effects), { g: { a: 4 } })
  assert.deepEqual(h.node.versions.get(ka), h.node.versions.get(kg))
  assert.deepEqual(h.node.fields('g'), [])
  assert.equal(h.node.deep.size, 0, 'no empty set is left behind')
})

//! every order of a short history, as `fed` takes it
const permutations = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))

test('overlapping cells (V4-18): a field written INTO a non-object value and then removed — the value comes back, in every order, at depths 1 to 3', () => {
  const put = (seq: number, origin: string, key: string[], value: unknown) => ({ seq, origin, rec: { type: REC.update, key, value } })
  const cut = (seq: number, key: string[]) => ({ seq, origin: 'dd', rec: { type: REC.remove, key } })
  //! 5, null and 'txt' are values a field cannot land in: the projection vivifies `{}` over them for the
  // field, and after the field's remove nothing live is left there — the value itself must come back.
  // {} is the control: an object was never made up, it stays
  for (const v of [5, null, 'txt', {}]) {
    const label = JSON.stringify(v)
    //! depth 1: the row is the value
    for (const o of permutations([put(3, 'bb', ['g'], v), put(5, 'cc', ['g', 'b'], 1), cut(7, ['g', 'b'])])) {
      const h = fed(o)
      assert.deepEqual(cells(h.node), { '["g"]': v }, `row ${label}, order ${o.map((r) => r.seq).join(',')}: the cells`)
      assert.deepEqual(project(h.effects), { g: v }, `row ${label}, order ${o.map((r) => r.seq).join(',')}: the screen`)
    }
    //! depth 2: the row holds the value at `f`, a deeper field lands in it
    for (const o of permutations([put(3, 'bb', ['g'], { f: v }), put(5, 'cc', ['g', 'f', 'x'], 1), cut(7, ['g', 'f', 'x'])])) {
      const h = fed(o)
      assert.deepEqual(project(h.effects), { g: { f: v } }, `row {f:${label}}, order ${o.map((r) => r.seq).join(',')}: the screen`)
    }
    //! depth 2 as a FIELD cell: the value is itself a field, the deeper field lands in it
    for (const o of permutations([put(3, 'bb', ['g', 'f'], v), put(5, 'cc', ['g', 'f', 'x'], 1), cut(7, ['g', 'f', 'x'])])) {
      const h = fed(o)
      assert.deepEqual(cells(h.node), { '["g","f"]': v }, `field ${label}, order ${o.map((r) => r.seq).join(',')}: the cells`)
      assert.deepEqual(project(h.effects), { g: { f: v } }, `field ${label}, order ${o.map((r) => r.seq).join(',')}: the screen`)
    }
    //! depth 3: two fields made up two levels over the value; removing both brings it back
    for (const o of permutations([put(3, 'bb', ['g'], v), put(5, 'cc', ['g', 'a', 'b'], 1), cut(7, ['g', 'a', 'b'])])) {
      const h = fed(o)
      assert.deepEqual(project(h.effects), { g: v }, `row ${label} under a depth-3 field, order ${o.map((r) => r.seq).join(',')}: the screen`)
    }
  }
  //! a live sibling field keeps the made-up object: {g:{c:2}} everywhere, the scalar stays hidden
  // (each record on its own lane — two seqs of one origin must arrive in order, the stream dedup drops the other)
  for (const o of permutations([put(3, 'bb', ['g'], 5), put(4, 'ee', ['g', 'c'], 2), put(5, 'cc', ['g', 'b'], 1), cut(7, ['g', 'b'])])) {
    const h = fed(o)
    assert.deepEqual(project(h.effects), { g: { c: 2 } }, `order ${o.map((r) => r.seq).join(',')}`)
  }
  //! …and at depth 3 the level the deeper field made up over the scalar (g.a) must still go: the
  // per-level repair is what makes {g:{c:2}} match the node that refused the field (data vivifies `{}`
  // over a scalar, so the repair is a real remove there)
  for (const o of permutations([put(3, 'bb', ['g'], 5), put(4, 'ee', ['g', 'c'], 2), put(5, 'cc', ['g', 'a', 'y'], 1), cut(7, ['g', 'a', 'y'])])) {
    const h = fed(o)
    assert.deepEqual(project(h.effects), { g: { c: 2 } }, `depth 3, order ${o.map((r) => r.seq).join(',')}`)
  }
  //! an ARRAY row: data writes the field into the array (g.a becomes a hidden array property), and a
  // remove of an array's own key THROWS there (a sparse hole) — so the kernel must make up no per-level
  // repair under one. The reviewer's history: before this the un-vivify emitted `remove ['g','a']` at
  // seq 0 after the field remove, and data threw out of node.step() in the orders where the array was
  // live (the base tree never threw in these orders). The model ignores what lands under an array.
  for (const v of [[], [1], { a: [] }]) {
    for (const o of permutations([put(3, 'bb', ['g'], v), put(5, 'cc', ['g', 'a', 'y'], 5), cut(6, ['g', 'a', 'y'])])) {
      const h = fed(o)
      assert.deepEqual(project(h.effects), { g: v }, `array row ${JSON.stringify(v)}, order ${o.map((r) => r.seq).join(',')}: no repair under an array, the screen`)
    }
  }
})

test('overlapping cells (V4-18): ancestors at EVERY depth — a three-level history folds the same in all six orders', () => {
  const a = { seq: 5, origin: 'cc', rec: { type: REC.update, key: ['g', 'a', 'b'], value: 'leaf' } }
  const b = { seq: 7, origin: 'bb', rec: { type: REC.update, key: ['g', 'a'], value: { b: 'mid' } } }
  const c = { seq: 6, origin: 'dd', rec: { type: REC.update, key: ['g'], value: { a: { b: 'row' }, z: 1 } } }
  const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]
  for (const o of orders) {
    const h = fed(o)
    //! ['g','a','b']@5 loses to ['g','a']@7; ['g','a']@7 beats ['g']@6 and stays on top of it
    assert.deepEqual(cells(h.node), { '["g"]': { a: { b: 'row' }, z: 1 }, '["g","a"]': { b: 'mid' } }, o.map((r) => r.seq).join(','))
    assert.deepEqual(project(h.effects), { g: { a: { b: 'mid' }, z: 1 } }, o.map((r) => r.seq).join(','))
  }
})

test('M6 arming predicate: scoped is config, armed requires a committed view — open genesis is never scoped', () => {
  const { node: plain } = harness('aa')
  assert.equal(plain.scoped, false)
  assert.equal(plain.armed, false)
  const { node } = harness('aa', { replicas: 2 })
  assert.equal(node.replicas, 2)
  assert.equal(node.scoped, true)
  assert.equal(node.armed, false, 'epoch 0 (open genesis): no committed ring to scope against')
  //! a committed view arms it: boot a restored epoch-1 view the M4 way (constructor boot facts)
  const { node: restored } = harness('aa', { replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  assert.equal(restored.armed, true, 'scoped ∧ epoch > 0 ⇒ armed')
})

//! ── the paused queue's byte bound (tune row queuedBytes) ─────────────────────────
// The count bound alone let a paused link hold 256 frames of up to the frame cap each (64 GiB at 256 MiB). The byte
// bound clears the queue when a frame meets a queue that already holds queuedBytes; a queue of small frames still
// fills to the count. Both are read off the same push (Link.full), and the drain heals either clear the same way.
test('the paused queue is bounded by bytes too: big frames clear at the byte bound, small frames still fill to the count, and the drain heals both', () => {
  const tune = { frame: 4096, queued: 256, queuedBytes: 64 * 1024 }
  const run = (recs: number, size: number, perWrite: number) => {
    const A = harness('aa', { tune })
    const B = harness('bb', { tune: { frame: 4096 } })
    A.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
    B.node.step({ kind: 'linkUp', link: 1, dialed: false })
    let ai = 0, bi = 0
    const pump = () => {
      for (let round = 0; round < 8; round++) {
        const as = A.of('send'), bs = B.of('send')
        for (; ai < as.length; ai++) B.node.step({ kind: 'bytesIn', link: 1, bytes: as[ai][2] as Uint8Array })
        for (; bi < bs.length; bi++) A.node.step({ kind: 'bytesIn', link: 1, bytes: bs[bi][2] as Uint8Array })
      }
    }
    pump()
    const la = A.node.links.get(1)!
    assert.equal(la.synced, true)
    A.node.step({ kind: 'pause', link: 1 })
    let most = 0, mostBytes = 0, at = -1
    for (let w = 0; w < recs / perWrite; w++) {
      A.node.step({ kind: 'write', recs: Array.from({ length: perWrite }, (_, i) => ({ type: REC.update, key: [`r${w * perWrite + i}`], value: new Uint8Array(size).fill(1) })) })
      most = Math.max(most, la.queued.length); mostBytes = Math.max(mostBytes, la.queuedBytes)
      if (at < 0 && A.node.journal.read().some((e) => e.kind === JK.dropOldest)) at = w
    }
    const drop = A.node.journal.read().find((e) => e.kind === JK.dropOldest)
    A.node.step({ kind: 'drain', link: 1 })
    pump()
    assert.equal(B.node.state.size, recs, 'the drain digest re-shipped the lost tail')
    return { most, mostBytes, drop: drop?.b, left: la.queuedBytes }
  }
  //! big: one 3 KB frame per write (two 1.5 KB records); 22 of them pass 64 KiB, so the 23rd clears — the count is far off
  const big = run(60, 1500, 2)
  assert.equal(big.drop, 23, 'the byte bound cleared the queue at its 23rd frame (256 is the count bound)')
  assert.equal(big.most, 22)
  assert.ok(big.mostBytes >= 64 * 1024 && big.mostBytes < 64 * 1024 + 4096 + 64, `held under the bound plus one frame: ${big.mostBytes}`)
  //! small: one ~40-byte frame per write; 256 of them are ~10 KB, so the count clears at the 257th, as before
  const small = run(300, 8, 1)
  assert.equal(small.drop, 257, 'small frames still fill to the count')
  assert.equal(small.most, 256)
  assert.ok(small.mostBytes < 64 * 1024, `far under the byte bound: ${small.mostBytes}`)
  assert.equal(small.left, 0, 'the drain zeroes the byte count')
})

//! the drain zeroes the byte count: pause and drain cycles that each queue UNDER the byte bound never clear, however
// many there are. Read without the drain's zero, the count grew by every cycle's frames (1 frame, 2, 3 ... of 3 KB) and
// the queue cleared at the cycle that carried it past the bound, with no overflow in that cycle at all.
test('the paused queue\'s byte count starts again at every drain: cycles that each queue under queuedBytes never clear, and every write arrives', () => {
  const A = harness('aa', { tune: { frame: 4096, queued: 256, queuedBytes: 16 * 1024 } })
  const B = harness('bb', { tune: { frame: 4096 } })
  A.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  B.node.step({ kind: 'linkUp', link: 1, dialed: false })
  let ai = 0, bi = 0
  const pump = () => {
    for (let round = 0; round < 8; round++) {
      const as = A.of('send'), bs = B.of('send')
      for (; ai < as.length; ai++) B.node.step({ kind: 'bytesIn', link: 1, bytes: as[ai][2] as Uint8Array })
      for (; bi < bs.length; bi++) A.node.step({ kind: 'bytesIn', link: 1, bytes: bs[bi][2] as Uint8Array })
    }
  }
  pump()
  const la = A.node.links.get(1)!
  assert.equal(la.synced, true)
  let n = 0
  for (let cycle = 0; cycle < 8; cycle++) {
    A.node.step({ kind: 'pause', link: 1 })
    //! three 3 KB frames a cycle: about 9 KB, under the 16 KiB bound; eight cycles carry about 72 KB
    for (let w = 0; w < 3; w++, n++) A.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`r${n}`], value: new Uint8Array(3000).fill(1) }] })
    assert.equal(la.queued.length, 3, `cycle ${cycle}: three frames queued`)
    A.node.step({ kind: 'drain', link: 1 })
    assert.equal(la.queuedBytes, 0, `cycle ${cycle}: the drain zeroes the byte count`)
    pump()
  }
  assert.deepEqual(A.node.journal.read().filter((e) => e.kind === JK.dropOldest), [], 'never cleared')
  assert.equal(B.node.state.size, n, 'every write arrived')
})

//! ── V4-51: a flush that clears the queue ships nothing more ─────────────────────
// A run bigger than the frame cap leaves in several frames, so one flush can now ship several. If the paused queue
// overflows at one of them, the rest of the flush must not follow it into the queue: those frames would sit ABOVE the
// hole, reach the peer at the drain, and move its scalar fence past the lost records — and the drain digest re-ships
// only above the peer's tails, so the hole would never heal (the design's probe E: 4 of 10 rows, for good).
test('an unscoped member whose link overflows in the middle of a flush ships nothing more of it, and converges after the drain', () => {
  const A = harness('aa', { tune: { frame: 4096, queued: 2 } })
  const B = harness('bb', { tune: { frame: 4096 } })
  A.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  B.node.step({ kind: 'linkUp', link: 1, dialed: false })
  let ai = 0, bi = 0
  const pump = () => {
    for (let round = 0; round < 8; round++) {
      const as = A.of('send'), bs = B.of('send')
      for (; ai < as.length; ai++) B.node.step({ kind: 'bytesIn', link: 1, bytes: as[ai][2] as Uint8Array })
      for (; bi < bs.length; bi++) A.node.step({ kind: 'bytesIn', link: 1, bytes: bs[bi][2] as Uint8Array })
    }
  }
  pump()
  const la = A.node.links.get(1)!
  assert.equal(la.synced, true, 'admitted and synced: live records flow')
  A.node.step({ kind: 'pause', link: 1 })
  //! one commit of ten 1.5 KB records: five cut frames of two records each, into a paused queue with room for two
  A.node.step({ kind: 'write', recs: Array.from({ length: 10 }, (_, i) => ({ type: REC.update, key: [`r${i + 1}`], value: new Uint8Array(1500).fill(i + 1) })) })
  assert.ok(A.node.journal.read().some((e) => e.kind === JK.dropOldest), 'the third frame overflowed the queue')
  assert.deepEqual(la.queued, [], 'nothing queued after the clear: the rest of the flush is part of the lost tail')
  assert.equal(la.synced, false)
  A.node.step({ kind: 'drain', link: 1 })
  pump()
  assert.equal(B.node.state.size, 10, 'the drain digest re-shipped the whole tail')
  assert.equal(B.node.streams.get('aa')!.applied, 10)
  const frames = A.of('send').map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f.verb === VERB.RECORDS)
  assert.equal(frames.length, 5, 'the drain\'s catch-up answer left in five cuts too')
  assert.ok(frames.every((f) => f.buf.length - 11 <= 4096), 'every frame within the cap')
})
