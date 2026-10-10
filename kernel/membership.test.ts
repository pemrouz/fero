//! Tier-1 membership suite: ballots, the write-gate, epoch staleness, boot modes — the kernel driven
// by hand-crafted frames against a recording sink, exactly like node.test.ts. Every safety property
// claimed in membership.ts's banner has a pin here; the sim scenarios (sim/membership.test.ts) then
// prove the same machinery end-to-end under partitions.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node, MAX_REDIALS, MEMBER_REDIALS } from './node.ts'
import { LEAVE_TICKS, LEAVE_WINDOW, MAX_PULLS } from './membership.ts'
import { LS } from './link.ts'
import { Mesh } from '../sim/mesh.ts'
import { MAX_PENDING } from './write.ts'
import { JK } from './journal.ts'
import { Framer, VERB, encodeControl, encodeFrame } from './codec.ts'
import { REC, TAG, type EffectSink, type Env } from './env.ts'

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
    left: (clean) => effects.push(['left', clean]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  //! decode every frame sent on `link` with the given verb (control frames only)
  const sentOn = (link: number, verb: number) =>
    of('send').filter((e) => e[1] === link)
      .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
      .filter((f) => f.verb === verb)
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  return { node, effects, of, tick, jk, sentOn, admit }
}

//! drive a 3-node genesis to a committed view 1 on the 'aa' (lowest, proposer) node
const formedView1 = () => {
  const h = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.tick() // genesis: fully formed + lowest uuid ⇒ propose view 1
  assert.equal(h.jk(JK.propose).length, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  assert.equal(h.node.epoch, 1, 'aa + bb = 2 of 3 — joint majority commits view 1')
  return h
}

test('genesis: the lowest uuid proposes over the formed mesh; 2-of-3 votes commit; VIEW broadcasts', () => {
  const h = formedView1()
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa', 'bb', 'cc'])
  assert.equal(h.jk(JK.viewInstall)[0].a, 1)
  //! the committed view is announced to every admitted link
  assert.ok(h.sentOn(1, VERB.VIEW).length >= 1)
  assert.ok(h.sentOn(2, VERB.VIEW).length >= 1)
  //! and a NON-lowest node never proposes genesis
  const m = harness('mm', { hosts: ['sim:aa'] })
  m.node.step({ kind: 'start' })
  m.admit(1, 'aa')
  m.tick()
  assert.equal(m.jk(JK.propose).length, 0, 'mm > aa — not the genesis proposer')
})

test('ballots: one vote per epoch — a rival same-epoch proposer is refused; the SAME proposer re-grants (lost-VOTE heal)', () => {
  const h = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.admit(2, 'cc')
  const m3: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: m3, p: 'aa' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']], p: 'cc' }) })
  //! a RE-OFFER from the original proposer (its VOTE frame may have been lost) is granted again — idempotent
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: m3, p: 'aa' }) })
  const votes = [...h.sentOn(1, VERB.VOTE), ...h.sentOn(2, VERB.VOTE)].map((f) => (f.value as { g: number }).g)
  assert.deepEqual(votes, [1, 1, 0], 'granted, re-granted to the same proposer, refused for the rival')
})

test('the propose path cannot double-vote: a member that granted its epoch vote elsewhere refuses to propose that epoch', () => {
  //! the review’s CRITICAL: #propose once self-voted unconditionally, so a member that had already
  // granted epoch e to another proposer could commit a SECOND epoch-e view — permanent split-brain.
  const h = formedView1() // aa is the lowest live member — normally the proposer
  //! aa grants bb's epoch-2 ballot first (bb believed itself proposer during an asymmetric window)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']], p: 'bb' }) })
  assert.equal((h.sentOn(1, VERB.VOTE).pop()!.value as { g: number }).g, 1, 'aa granted epoch 2 to bb')
  //! a JOIN now lands at aa — its own epoch-2 proposal MUST be refused (the vote is spent on bb)
  h.admit(5, 'dd')
  h.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.JOIN, { u: 'dd', i: 1, l: 'sim:dd' }) })
  assert.equal(h.jk(JK.propose).filter((e) => e.a === 2).length, 0, 'aa must not propose an epoch its vote is spent on')
  assert.equal(h.node.epoch, 1)
})

test('a vote only counts for the exact proposal it granted: a stale grant for different members cannot commit', () => {
  const h = formedView1()
  //! aa proposes evict-cc (drive give-up then suspicion), then receives a VOTE echoing the WRONG members-hash
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  h.tick(); h.tick(); h.tick() // suspect first (the default order: 1.5 s), held by the running chain
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  h.tick() // give-up ended the hold: the ballot opens here, before the revival re-dials cc
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'eviction ballot for epoch 2 is out')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb,zz' }) })
  assert.equal(h.node.epoch, 1, 'a grant echoing a different proposal identity must not commit')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 2, 'the correctly-echoed grant commits')
})

test('write-gate: minority parks (bounded, surfaced); regaining majority flushes through the normal path at the current epoch', () => {
  const h = formedView1()
  h.node.writes.ring.place('gated', 'aa') // pin self-ownership: the flush must exercise the local commit leg
  //! sever both peers — 1 of 3 reachable is a minority: the gate closes
  h.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  const applies = h.of('apply').length
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['gated'], value: 1 }] })
  assert.equal(h.of('apply').length, applies, 'a gated write must not commit')
  assert.equal(h.node.state.size, 0)
  assert.equal(h.jk(JK.writeBuffered).length, 1)
  //! one peer returns → 2 of 3 is a majority → the admit settles the gate open and flushes
  h.admit(3, 'bb')
  h.tick()
  assert.equal(h.node.state.size, 1, 'parked write committed on gate-open')
  assert.equal(h.node.writes.pending.size, 0)
  const v = h.node.versions.get(JSON.stringify(['gated']))!
  assert.equal(v.epoch, 1, 'flushed writes stamp at the CURRENT epoch')
  assert.ok(h.jk(JK.gateClose).some((e) => e.a === 'minority'))
  assert.ok(h.jk(JK.gateOpen).length >= 1)
})

test('the pending queue is bounded drop-oldest with a surfaced counter', () => {
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  for (let i = 0; i <= MAX_PENDING; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(h.node.writes.pending.size, MAX_PENDING)
  assert.equal(h.node.writes.droppedPending, 1)
  assert.ok(h.jk(JK.writeBufferDrop).length === 1)
})

test('epoch-staleness: a higher-epoch record closes the gate and pulls the view ON THAT LINK; the VIEW reopens it', () => {
  const h = formedView1()
  h.node.writes.ring.place('during', 'aa') // pin: the flushed write must commit HERE to observe its stamp
  const rec = encodeFrame([{ type: REC.update, key: ['x'], value: 9 }], { origin: 'bb', baseSeq: 50, epoch: 3 })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: rec })
  assert.ok(h.jk(JK.epochStale).length === 1)
  assert.equal(h.node.membership.gate(h.node).open, false)
  assert.ok(h.sentOn(1, VERB.PULL).length >= 1, 'targeted pull goes out immediately, on the evidencing link')
  //! writes buffer while stale
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['during'], value: 1 }] })
  assert.equal(h.jk(JK.writeBuffered).length, 1)
  //! the missing view arrives → install, reopen, flush — and the node's epoch is now 3
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 3, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.epoch, 3)
  assert.equal(h.node.membership.gate(h.node).open, true)
  assert.equal(h.node.versions.get(JSON.stringify(['during']))!.epoch, 3, 'post-view-install writes stamp at the new higher epoch')
})

test('gate release protocol: pull retries exhaust → the gate RELEASES with a journal alarm, never wedges', () => {
  const h = formedView1()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 9 }], { origin: 'bb', baseSeq: 50, epoch: 7 }) })
  assert.equal(h.node.membership.gate(h.node).open, false)
  for (let i = 0; i <= MAX_PULLS; i++) h.tick() // nobody answers the pulls
  assert.ok(h.jk(JK.gateAlarm).some((e) => e.a === 7), 'release is alarmed with the wanted epoch')
  assert.equal(h.node.membership.gate(h.node).open, true, 'a wedged gate is a named state, not a hang')
})

test('suspicion + eviction: suspect after 3 ticks, but eviction WAITS for the dial chain to exhaust (dialing-hold)', () => {
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' }) // cc unreachable; aa+bb still majority
  h.tick(); h.tick()
  assert.equal(h.jk(JK.suspect).length, 0, 'not yet — suspicion needs 3 consecutive ticks')
  h.tick()
  assert.deepEqual(h.jk(JK.suspect).map((e) => e.a), ['cc'])
  //! suspect, but the redial chain to cc is still trying: reachability is UNKNOWN — no eviction ballot yet
  assert.ok(!h.jk(JK.propose).some((e) => e.a === 2), 'eviction held while a dial chain is active')
  //! exhaust the chain (fire each pending redial, fail each dial) — give-up ends the hold
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  assert.ok(h.jk(JK.giveUp).length >= 1)
  h.tick()
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'aa (lowest live) proposes the eviction view after give-up')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 2, 'aa+bb = majority of OLD (2/3) and of NEW (2/2) — joint consensus commits')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa', 'bb'])
  assert.deepEqual(h.jk(JK.evict).map((e) => e.a), ['cc'])
})

test('a crashed member runs the SHORT chain (memberRedials 5): the eviction hold ends after five failed redials, not ten', () => {
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' }) // cc's admitted member link dies → the member chain
  let n = 0
  const fail = () => {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()!
    h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + ++n, reason: 'refused', to: 'sim:cc' })
  }
  fail(); fail()
  h.tick(); h.tick(); h.tick()
  assert.deepEqual(h.jk(JK.suspect).map((e) => e.a), ['cc'], 'suspect after three ticks')
  assert.ok(h.node.dialing('sim:cc') && !h.jk(JK.propose).some((e) => e.a === 2), 'held: the chain is still running')
  fail(); fail()
  h.tick()
  assert.ok(h.node.dialing('sim:cc') && !h.jk(JK.propose).some((e) => e.a === 2), 'held: the fifth attempt is pending')
  fail() // the fifth attempt fails — the member chain gives up here, where the generic chain would arm a sixth
  assert.equal(h.jk(JK.redial).filter((e) => e.b === 'sim:cc').length, MEMBER_REDIALS, 'five arms, no sixth')
  assert.deepEqual(h.jk(JK.giveUp).map((e) => e.a), ['sim:cc'])
  assert.ok(!h.node.dialing('sim:cc'), 'give-up ends the hold')
  h.tick()
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'the eviction ballot opens at the next tick')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 2)
  assert.deepEqual(h.jk(JK.evict).map((e) => e.a), ['cc'])
  //! the same node, a target that never linked up: the long chain (MAX_REDIALS) — the two caps are independent
  const g = harness('aa', { hosts: ['sim:zz'] })
  g.node.step({ kind: 'start' })
  g.node.step({ kind: 'linkDown', link: 700, reason: 'refused', to: 'sim:zz' })
  for (let i = 0; i < 12; i++) {
    const t = g.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (!t) break
    g.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    g.node.step({ kind: 'linkDown', link: 701 + i, reason: 'refused', to: 'sim:zz' })
  }
  assert.equal(g.jk(JK.redial).length, MAX_REDIALS)
})

test('a crashed member whose chain gave up BEFORE suspicion: the heartbeat revival runs the SHORT chain too, so eviction never waits on a long one', () => {
  //! heartbeat.ms 2000 at redial.ms 100: the member chain (about 3 s) ends before the third tick (6 s), so
  // the tick-2 revival re-dials the dead member and that dial starts a fresh chain. If that chain were the
  // long one, the hold would last 10 more tries — eviction at about 23 s, SLOWER than before the short chain.
  // A revived target that is still a committed member must get the member chain again (review finding).
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  let n = 0
  const fail = () => {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()!
    h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + ++n, reason: 'refused', to: 'sim:cc' })
  }
  for (let i = 0; i < MEMBER_REDIALS; i++) fail()
  assert.deepEqual(h.jk(JK.giveUp).map((e) => e.a), ['sim:cc'], 'the member chain gave up before any tick')
  h.tick() // tick 1: not yet suspect; the revival re-dials cc from scratch
  assert.deepEqual(h.jk(JK.revive).map((e) => e.a), ['sim:cc'])
  h.node.step({ kind: 'linkDown', link: 800 + ++n, reason: 'refused', to: 'sim:cc' }) // the revived dial fails → a fresh chain
  h.tick(); h.tick() // ticks 2 and 3: suspect
  assert.deepEqual(h.jk(JK.suspect).map((e) => e.a), ['cc'])
  assert.ok(h.node.dialing('sim:cc') && !h.jk(JK.propose).some((e) => e.a === 2), 'held: the revived chain is running')
  for (let i = 0; i < MEMBER_REDIALS; i++) fail()
  assert.equal(h.jk(JK.redial).filter((e) => e.b === 'sim:cc').length, 2 * MEMBER_REDIALS, 'the revived chain is the member chain too: five arms, no sixth')
  assert.deepEqual(h.jk(JK.giveUp).map((e) => e.a), ['sim:cc', 'sim:cc'], 'it gave up again')
  assert.ok(!h.node.dialing('sim:cc'), 'give-up ends the hold')
  h.tick()
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'the eviction ballot opens at the next tick — within the member chain plus three ticks of the crash')
})

test('join: a member receiving JOIN from an admitted non-member proposes the grown view', () => {
  const h = formedView1()
  //! evict cc first (via a VIEW install), then cc knocks
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 2)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.JOIN, { u: 'cc', i: 2, l: 'sim:cc' }) })
  const p = h.jk(JK.propose).find((e) => e.a === 3)
  assert.ok(p, 'the member proposes epoch 3 with the joiner back in')
  assert.equal(p!.b, 3, '3 members proposed')
})

test('boot modes: a rejoining node is read-only until a committed view ≥ its restored epoch installs', () => {
  const h = harness('cc', { hosts: ['sim:aa'], boot: { epoch: 5, members: [['aa', 'sim:aa'], ['cc', 'sim:cc']] } })
  h.node.writes.ring.place('early', 'cc') // pin: the rejoin flush must commit HERE to observe its stamp
  h.node.step({ kind: 'start' })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'rejoining' })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['early'], value: 1 }] })
  assert.equal(h.node.state.size, 0, 'read-only: restored-with-peers must not self-trust (AA.5 carried up)')
  h.admit(1, 'aa')
  h.tick()
  //! a rejoiner is a MEMBER of its restored view — it PULLs for live confirmation (JOIN is the evictee's verb)
  assert.ok(h.sentOn(1, VERB.PULL).length >= 1, 'the rejoiner pulls the committed view')
  //! the live cluster answers with a view at the restored epoch that includes us → gate opens, write flushes
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 5, m: [['aa', 'sim:aa'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.epoch, 5)
  assert.equal(h.node.membership.gate(h.node).open, true)
  assert.equal(h.node.state.size, 1, 'the buffered write flushed at rejoin')
  assert.equal(h.node.versions.get(JSON.stringify(['early']))!.epoch, 5)
})

test('malformed membership frames are rejected, never crash, never install: the frame-validation net', () => {
  //! review finding: a crc-valid VIEW/PROPOSE with a garbage members body once threw a TypeError past
  // the FrameError net (crashing the node) or installed garbage into committed state.
  const h = formedView1()
  const hostile = [
    encodeControl(VERB.VIEW, { e: 9, m: 'garbage' }),
    encodeControl(VERB.VIEW, { e: 9, m: [['aa']] }),
    encodeControl(VERB.VIEW, { e: 9, m: [['aa', 'sim:aa'], ['aa', 'twice']] }),
    encodeControl(VERB.VIEW, { e: 'nine', m: [['aa', 'sim:aa']] }),
    encodeControl(VERB.PROPOSE, { e: 2, m: { not: 'array' }, p: 'bb' }),
    encodeControl(VERB.VOTE, { e: 'x', g: true }),
    encodeControl(VERB.JOIN, { u: 7 }),
    encodeControl(VERB.PULL, {}),
  ]
  for (const bytes of hostile) h.node.step({ kind: 'bytesIn', link: 1, bytes }) // must not throw
  assert.equal(h.node.epoch, 1, 'nothing installed')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa', 'bb', 'cc'])
})

test('an equal-epoch VIEW with different members is IGNORED: committed views are immutable per epoch', () => {
  const h = formedView1()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['zz', 'sim:zz']] }) })
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa', 'bb', 'cc'], 'view unchanged')
})

test('joint consensus needs the OLD-set majority too: new-set majority alone must not commit', () => {
  //! mutation-killer (review): weakening majority() to the new set only survived the whole suite
  const h = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  const five: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd'], ['ee', 'sim:ee']]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: five }) })
  assert.equal(h.node.epoch, 1)
  //! dd+ee are unreachable (never dialed by us: no chain → no dialing-hold); 3 ticks → suspects → propose [aa,bb,cc]
  h.tick(); h.tick(); h.tick(); h.tick()
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'eviction ballot proposed')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb,cc' }) })
  assert.equal(h.node.epoch, 1, '2 of 5 OLD members is not a majority — new-set majority (2 of 3) must NOT commit')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb,cc' }) })
  assert.equal(h.node.epoch, 2, '3 of 5 OLD and 3 of 3 NEW — joint majority commits')
})

test('view propagation: view-on-admit announces to new links; install FLOODS to all admitted links', () => {
  //! review finding: only the committer broadcast — a detached evictee never learned its fate
  const h = formedView1()
  h.admit(5, 'dd')
  assert.ok(h.sentOn(5, VERB.VIEW).some((f) => (f.value as { e: number }).e === 1), 'view-on-admit')
  //! bb-side: installing a view re-announces it on OTHER links (gossip hop)
  const b = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  b.node.step({ kind: 'start' })
  b.admit(1, 'aa')
  b.admit(2, 'cc')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.ok(b.sentOn(2, VERB.VIEW).some((f) => (f.value as { e: number }).e === 1), 'install floods the view one hop onward')
})

test('JOIN discipline: a non-lowest member relays one hop; an unreachable joiner is refused (churn guard)', () => {
  const b = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  b.node.step({ kind: 'start' })
  b.admit(1, 'aa')
  b.admit(2, 'cc')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  b.admit(3, 'dd')
  b.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.JOIN, { u: 'dd', i: 1, l: 'sim:dd' }) })
  assert.equal(b.jk(JK.propose).length, 0, 'bb is not the lowest live member — it must not duel ballots')
  assert.ok(b.sentOn(1, VERB.JOIN).length >= 1, 'the knock is relayed to aa (the proposer)')
  //! and the proposer side refuses a joiner it cannot reach (no admitted link) — no evict/rejoin churn
  const h = formedView1()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' }) // the evictee's transport link is gone too
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.JOIN, { u: 'cc', i: 2, l: 'sim:cc' }) }) // relayed by bb; aa holds no link to cc
  assert.equal(h.jk(JK.propose).filter((e) => e.a === 3).length, 0, 'unreachable joiner refused')
  h.admit(6, 'cc') // now cc actually reaches aa
  h.node.step({ kind: 'bytesIn', link: 6, bytes: encodeControl(VERB.JOIN, { u: 'cc', i: 2, l: 'sim:cc' }) })
  assert.ok(h.jk(JK.propose).some((e) => e.a === 3), 'reachable joiner proposed back in')
})

test('a returned suspect abandons the in-flight eviction ballot: a late vote must not commit it', () => {
  //! mutation-killer (review): deleting the abandon-on-return branch survived the suite
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  h.tick(); h.tick(); h.tick() // suspect first (the default order: 1.5 s), held by the running chain
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  h.tick() // give-up ended the hold: the ballot opens here, before the revival re-dials cc
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'eviction ballot in flight')
  h.admit(9, 'cc') // cc RETURNS before any vote lands
  h.tick()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 1, 'the abandoned ballot must not commit against a live member')
})

test('an aged-out proposal unblocks membership: a later JOIN can ballot the same epoch afresh', () => {
  //! review finding: a zombie proposal (voter down, votes unreachable) swallowed all JOINs forever
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  h.tick(); h.tick(); h.tick() // suspect first (the default order: 1.5 s), held by the running chain
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  for (let i = 0; i < 13; i++) h.tick() // propose → ... no votes arrive → PROPOSAL_AGE expiry
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2))
  h.admit(7, 'dd')
  h.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.JOIN, { u: 'dd', i: 1, l: 'sim:dd' }) })
  assert.ok(h.jk(JK.propose).filter((e) => e.a === 2).length >= 2, 'the expired ballot released the epoch for the join')
})

test('full-cluster restart: the lowest restored member self-ballots the restored view after REJOIN_TICKS', () => {
  //! review finding: with every node rejoining, nobody could ever confirm a view — read-only forever
  const h = harness('aa', { hosts: ['sim:bb'], boot: { epoch: 5, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  h.node.step({ kind: 'start' })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'rejoining' })
  h.admit(1, 'bb') // bb is also rejoining: it answers PULLs with nothing (same epoch)
  for (let i = 0; i < 10; i++) h.tick()
  const p = h.sentOn(1, VERB.PROPOSE).find((f) => (f.value as { e: number }).e === 6)
  assert.ok(p, 'the self-ballot proposes the restored view at epoch+1')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 6, g: 1, ce: 5, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 6)
  assert.equal(h.node.membership.gate(h.node).open, true, 'the cluster is writable again after a full restart')
})

test('membership frames before HELLO are a protocol violation: the link closes', () => {
  const h = harness('aa')
  h.node.step({ kind: 'linkUp', link: 1, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 9, m: [] }) })
  assert.deepEqual(h.of('close')[0], ['close', 1, 'membership-before-hello'])
  assert.equal(h.node.epoch, 0, 'and the view was NOT installed')
})

//! ── the graceful leave (V4-6, 2026-09-07) — see membership.ts's banner ──

//! drive a 2-node genesis to a committed view 1 on 'aa' (lowest, proposer): the smallest view that can vote —
// and the one suspicion + eviction can never shrink (a dead half is a missing old-majority vote)
const formedPair = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const h = harness('aa', { hosts: ['sim:bb'], ...opts })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.tick()
  assert.equal(h.jk(JK.propose).length, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 1, 'aa + bb = 2 of 2 — view 1')
  return h
}
const proposed = (h: ReturnType<typeof harness>, link: number, e: number) =>
  h.sentOn(link, VERB.PROPOSE).filter((f) => (f.value as { e: number }).e === e).map((f) => (f.value as { m: [string, string][] }).m.map((m) => m[0]))

test('graceful leave (V4-6), n=2, the leaver IS the lowest live member: it proposes the view without itself, the survivor\'s vote commits it, and the survivor\'s VIEW echo lets it go', () => {
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  assert.deepEqual(h.jk(JK.leave).map((e) => e.a), ['aa'], 'journaled once, naming self')
  assert.deepEqual(proposed(h, 1, 2), [['bb']], 'the shrunk view is proposed at epoch 2: members WITHOUT the leaver')
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 0, 'the lowest never knocks — it proposes')
  assert.equal(h.of('left').length, 0, 'not gone: nothing committed yet')
  //! bb's grant: OLD majority = aa + bb of {aa,bb} — the leaver's own vote, exactly what an eviction of a
  // DEAD aa can never have; NEW majority = bb of {bb}. Joint consensus passes.
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'bb' }) })
  assert.equal(h.node.epoch, 2, 'committed')
  assert.equal(h.node.membership.isMember('aa'), false)
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'evicted' }, 'a leaver stops writing the instant it is out')
  assert.ok(h.sentOn(1, VERB.VIEW).some((f) => (f.value as { e: number }).e === 2), 'the view floods to the survivor')
  assert.equal(h.of('left').length, 0, 'STILL not gone: the survivor has not echoed — going now could take the commit with us')
  //! the survivor installs and floods the view back — THAT is the exit proof
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['bb', 'sim:bb']] }) })
  assert.deepEqual(h.of('left'), [['left', true]])
  const left = h.jk(JK.left)
  assert.equal(left.length, 1)
  assert.equal(left[0].a, 2)
  assert.equal(left[0].b, 1)
  //! ticks after the exit change nothing: no re-knock, no second outcome
  h.tick(); h.tick()
  assert.equal(h.of('left').length, 1)
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 0)
})

test('graceful leave (V4-6), n=2, the leaver is NOT the lowest: it knocks LEAVE on the member link every tick, the lowest proposes, and the VIEW without it is the exit proof', () => {
  const h = harness('bb', { hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']], p: 'aa' }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 1)
  h.node.step({ kind: 'leave' })
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 1, 'LEAVE knocked at aa')
  assert.equal(h.sentOn(1, VERB.PROPOSE).length, 0, 'a non-lowest leaver never proposes (single-proposer discipline)')
  h.tick()
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 2, 're-knocked on the tick — idempotent at the receiver')
  //! aa proposes {aa}; the leaver GRANTS (voting is not writing): its vote is the old-majority half
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa']], p: 'aa' }) })
  const vote = h.sentOn(1, VERB.VOTE).find((f) => (f.value as { e: number }).e === 2)
  assert.ok(vote && (vote.value as { g: number }).g === 1, 'granted')
  assert.equal(h.of('left').length, 0)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa']] }) })
  assert.equal(h.node.epoch, 2)
  assert.deepEqual(h.of('left'), [['left', true]], 'the proposer\'s VIEW without me proves the commit reached a survivor')
  assert.equal(h.jk(JK.left)[0].b, 1)
})

test('graceful leave (V4-6), the receiver: a LEAVE from a member makes the lowest live member propose the view without it; 2-of-2 old + 1-of-1 new commits; the survivor is writable ALONE', () => {
  const h = formedPair()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(h.jk(JK.leave).map((e) => e.a), ['bb'], 'journaled with the leaver\'s AUTHENTICATED uuid — the frame carries none')
  assert.deepEqual(proposed(h, 1, 2), [['aa']], 'proposed at epoch 2 without the leaver')
  //! a second knock while the ballot is in flight is ignored — no duelling ballots
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(h.jk(JK.propose).filter((e) => e.a === 2).length, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa' }) })
  assert.equal(h.node.epoch, 2)
  assert.deepEqual(h.node.membership.view.members, [['aa', 'sim:aa']])
  assert.ok(h.jk(JK.evict).some((e) => e.a === 'bb'), 'the leaver left the view at install (evict = left the view, however it went)')
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'one of one is a majority: writable alone — the two-member wedge is gone')
  assert.equal(h.node.membership.leaving, null, 'the receiver itself is not leaving')
})

test('graceful leave (V4-6): a LEAVE is ignored at open genesis, from a non-member, at a non-lowest member, and while a ballot is in flight', () => {
  //! open genesis: there is no view to shrink
  const g = harness('aa', { hosts: ['sim:bb'] })
  g.node.step({ kind: 'start' })
  g.admit(1, 'bb')
  g.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(g.jk(JK.propose).length, 0)
  //! a non-member knocking: nothing to remove
  const h = formedView1()
  h.admit(3, 'dd')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(h.jk(JK.propose).filter((e) => e.a === 2).length, 0)
  //! a non-lowest member hears it and defers — the leaver knocks on EVERY member link, so the lowest hears it too
  const m = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  m.node.step({ kind: 'start' })
  m.admit(1, 'aa')
  m.admit(2, 'cc')
  m.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  m.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(m.jk(JK.propose).length, 0, 'bb > aa: not the proposer')
  assert.deepEqual(m.jk(JK.leave).map((e) => e.a), ['cc'], 'but the knock is journaled')
  //! a ballot in flight (dd's join): cc's LEAVE waits for its next knock
  const k = formedView1()
  k.admit(3, 'dd')
  k.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.JOIN, { u: 'dd', i: 1, l: 'sim:dd' }) })
  assert.equal(k.jk(JK.propose).filter((e) => e.a === 2).length, 1)
  k.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(k.jk(JK.propose).length, 2, 'no second ballot while one is in flight (genesis + the join)')
})

//! ── the knock window (DESIGN-LEAVE §10.7, 2026-10-10). A tick counts toward the LEAVE_TICKS bound only while the
// leaver has no admitted link to a member that could answer — one that has neither knocked LEAVE at it nor proposed
// its own exit to it. With such a link up it keeps knocking, up to LEAVE_WINDOW ticks in all. On the kernel before
// the window every test below that says "past LEAVE_TICKS" goes red at tick 5 with `left` b=0. ──

//! a non-lowest leaver at view {aa,bb}: it knocks, aa proposes
const knockingPair = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const h = harness('bb', { hosts: ['sim:aa'], ...opts })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 1)
  return h
}

test('the knock window: a leaver whose member link is up knocks every tick PAST the old bound until the vote lands — the lowest re-offers its ballot, a non-lowest re-knocks LEAVE — and goes clean on the echo', () => {
  //! the lowest live member: its ballot is re-offered every other tick while bb (linked, a member, not leaving) says nothing
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS + 3; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `tick ${i + 1}: still knocking — bb is linked and could answer`)
  }
  assert.ok(h.sentOn(1, VERB.PROPOSE).length >= 4, `the ballot was re-offered while waiting (${h.sentOn(1, VERB.PROPOSE).length} PROPOSEs): a lost PROPOSE heals`)
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: LEAVE_TICKS + 3, done: false }, 'no tick counted toward the bound')
  //! bb wakes: its vote commits the shrunk view, its echo is the exit proof — a clean stop, where the old bound gave up at tick 5
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'bb' }) })
  assert.equal(h.node.epoch, 2)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['bb', 'sim:bb']] }) })
  assert.deepEqual(h.of('left'), [['left', true]])
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[2, 1]])
  //! the non-lowest: one LEAVE per tick on the member link, past the bound
  const k = knockingPair()
  k.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS + 3; i++) k.tick()
  assert.equal(k.sentOn(1, VERB.LEAVE).length, LEAVE_TICKS + 4, 'knocked at leave() and on every tick since')
  assert.equal(k.of('left').length, 0, 'past LEAVE_TICKS and still waiting: aa is linked')
  k.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa']], p: 'aa' }) })
  assert.equal((k.sentOn(1, VERB.VOTE).find((f) => (f.value as { e: number }).e === 2)!.value as { g: number }).g, 1, 'granted — voting is not writing')
  k.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa']] }) })
  assert.deepEqual(k.of('left'), [['left', true]])
})

test('the knock window\'s end: a linked member that never answers → `left` b=0 at LEAVE_WINDOW + 1, not before; the tune row moves it; a row at or below the bound is the bound alone', () => {
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_WINDOW; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `tick ${i + 1}: inside the window`)
  }
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'the window ran out: it goes like a crash')
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[1, 0]])
  assert.equal(h.node.epoch, 1, 'nothing committed: the view is unchanged')
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: LEAVE_WINDOW + 1, done: true, drain: undefined })
  assert.equal(LEAVE_WINDOW, 16, 'the record\'s default: 16 ticks, 8 s at the default cadence (DESIGN-LEAVE §10.7)')
  //! the row: leaveWindow 6 ends it at 7
  const w = formedPair({ tune: { leaveWindow: 6 } })
  w.node.step({ kind: 'leave' })
  for (let i = 0; i < 6; i++) w.tick()
  assert.equal(w.of('left').length, 0)
  w.tick()
  assert.deepEqual(w.of('left'), [['left', false]])
  //! a row BELOW the bound never cuts the bound short: leaveWindow 2 is "the bound alone", so it ends at LEAVE_TICKS + 1
  const b = formedPair({ tune: { leaveWindow: 2 } })
  b.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS; i++) b.tick()
  assert.equal(b.of('left').length, 0, 'the bound still has a tick to go')
  b.tick()
  assert.deepEqual(b.of('left'), [['left', false]], 'leaveTicks + 1: today\'s behaviour, by choice (leave.ms 0)')
})

test('the knock window counts only links to members that could ANSWER: a fellow leaver — one that knocked LEAVE at me, or proposed its own exit to me — keeps no window open, so a leaver among leavers stops at the old bound; a fresh admit forgets it until it knocks again', () => {
  //! bb at {aa,bb,cc}: it knocks at aa and cc. cc knocks back (a fellow leaver); aa still could answer
  const h = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.admit(2, 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  h.node.step({ kind: 'leave' })
  assert.equal(h.sentOn(1, VERB.LEAVE).length + h.sentOn(2, VERB.LEAVE).length, 2, 'knocked on both member links')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.LEAVE, {}) })
  for (let i = 0; i < LEAVE_TICKS + 2; i++) h.tick()
  assert.equal(h.of('left').length, 0, 'past the bound: aa is linked and has not said it is leaving')
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: LEAVE_TICKS + 2, done: false })
  //! aa proposes ITS OWN exit (a ballot that leaves its proposer out is a leave): now every member link is a fellow leaver's
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']], p: 'aa' }) })
  assert.equal((h.sentOn(1, VERB.VOTE).find((f) => (f.value as { e: number }).e === 2)!.value as { g: number }).g, 1, 'bb grants aa\'s exit all the same (a knocking leaver may vote)')
  assert.deepEqual(h.jk(JK.leave).map((e) => e.a), ['bb', 'cc', 'aa'], 'the diary: my own knock, cc\'s knock, aa\'s exit ballot')
  for (let i = 0; i < LEAVE_TICKS; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `bound tick ${i + 1}`)
  }
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS, total: LEAVE_TICKS * 2 + 2, done: false }, 'every tick since aa\'s ballot counted toward the bound')
  //! a fresh admit of cc (a redial, or a new life) forgets what the old link heard: cc could be answering again
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close', to: 'sim:cc' })
  h.admit(3, 'cc')
  h.tick()
  assert.equal(h.node.membership.leaving!.ticks, LEAVE_TICKS, 'not counted: cc, re-admitted, has not knocked yet on this link')
  assert.equal(h.of('left').length, 0)
  //! cc knocks again on the new link: back to the bound, which now runs out
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.LEAVE, {}) })
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'the bound ran out among leavers: nobody linked could commit anything')
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 4, done: true, drain: undefined })
  assert.ok(h.node.membership.leaving!.total < LEAVE_WINDOW, 'well inside the window: the bound ended it, not the window')
})

test('the knock window closes with the link: a link loss is not a tick, but from then on the old bound counts — a leaver whose last member link dies goes LEAVE_TICKS ticks later, not at the window\'s end', () => {
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS + 2; i++) h.tick()
  assert.equal(h.of('left').length, 0, 'past the bound, bb linked: knocking on')
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close', to: 'sim:bb' })
  assert.equal(h.of('left').length, 0, 'the loss itself is not a tick')
  for (let i = 0; i < LEAVE_TICKS; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `unlinked tick ${i + 1}: inside the bound`)
  }
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'LEAVE_TICKS + 1 unlinked ticks: it goes like a crash, as before')
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 3, done: true, drain: undefined })
  assert.ok(h.node.membership.leaving!.total < LEAVE_WINDOW, 'the bound ended it, not the window')
})

test('the knock window counts no link that is DEAD on a wire fault: the kernel marks the link dead and asks the shell to close it, but the link stays admitted until linkDown arrives — the bound counts from the fault, not from the close', () => {
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS + 2; i++) h.tick()
  assert.equal(h.of('left').length, 0, 'past the bound, bb linked: knocking on')
  //! a frame whose body length exceeds MAX_FRAME is a wire fault: the link is dead at once (no more frames dispatch on
  // it), the shell is asked to close it, and the linkDown that follows is a LATER event — until then the link is still
  // in node.links as admitted. A dead link keeps no window open: bb cannot read a knock on it.
  h.node.step({ kind: 'bytesIn', link: 1, bytes: new Uint8Array([0xf3, 0, VERB.LEAVE, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]) })
  assert.deepEqual(h.of('close').map((e) => [e[1], e[2]]), [[1, 'wire-fault']], 'the kernel asked the shell to close the link')
  assert.equal(h.node.links.get(1)!.dead, true)
  assert.equal(h.node.links.get(1)!.state, LS.admitted, 'still admitted: linkDown has not arrived')
  for (let i = 0; i < LEAVE_TICKS; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `dead-link tick ${i + 1}: inside the bound`)
  }
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'LEAVE_TICKS + 1 ticks after the fault: it goes like a crash')
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 3, done: true, drain: undefined }, 'every tick since the fault counted toward the bound')
})

test('the knock window needs the clock: with heartbeats off a leaver knocks once and waits, as before — no tick is counted either way, and the answer still ends it', () => {
  const h = knockingPair({ heartbeatMs: 0 })
  h.node.step({ kind: 'leave' })
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 1)
  assert.equal(h.of('timer').filter((x) => x[2] === TAG.heartbeat).length, 0, 'no heartbeat timer exists')
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: 0, done: false })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa']], p: 'aa' }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa']] }) })
  assert.deepEqual(h.of('left'), [['left', true]])
})

test('the knock window covers the echo too: the lowest member leaves, the vote comes late and the survivor\'s echo later still — both inside the window — and the stop is clean where the old bound called it a crash', () => {
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS + 2; i++) h.tick()
  assert.equal(h.of('left').length, 0, 'bb is slow to vote')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'bb' }) })
  assert.equal(h.node.epoch, 2, 'the proposer commits from the vote')
  assert.equal(h.node.membership.isMember('aa'), false)
  assert.ok(h.sentOn(1, VERB.VIEW).some((f) => (f.value as { e: number }).e === 2), 'the view floods to bb')
  //! not a member of its own view any more — but bb IS, and its link is up: the window stays open for the echo
  for (let i = 0; i < LEAVE_TICKS + 2; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `echo tick ${i + 1}: still waiting for a survivor to echo`)
  }
  assert.equal(h.sentOn(1, VERB.LEAVE).length, 0, 'nothing to knock for: only the echo is awaited')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['bb', 'sim:bb']] }) })
  assert.deepEqual(h.of('left'), [['left', true]])
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: LEAVE_TICKS * 2 + 4, done: true, drain: undefined })
})

//! the round-1 shapes (DESIGN-LEAVE §3, §10.8 H1 and H3) on real Nodes, with the window on: two members stop at once
// at n=3 (the lowest among them or not) and at n=4. A stayer is linked throughout, so the window is open — and the
// fellow-leaver memory must not stop a leaver from granting the other's exit. Every frame lands, everyone ticks.
const settled = (m: Mesh, rounds: number) => {
  const drain = () => { for (let g = 0; g < 2000; g++) { const qs = [...m.q.entries()].filter(([, f]) => f.length); if (!qs.length) break; for (const [k] of qs) { const [a, b] = k.split('>'); m.deliver(a, b) } } }
  for (let r = 0; r < rounds; r++) { drain(); for (const u of [...m.nodes.keys()]) m.tick(u) }
  drain()
}
test('two leavers at once with the window on — n=3 (bb, cc), n=3 with the lowest among them (aa, bb), n=4 (cc, dd): both go clean within a few ticks, the stayers end writable in one view, no split', () => {
  for (const [ids, leavers] of [[['aa', 'bb', 'cc'], ['bb', 'cc']], [['aa', 'bb', 'cc'], ['aa', 'bb']], [['aa', 'bb', 'cc', 'dd'], ['cc', 'dd']]] as [string[], string[]][]) {
    const m = Mesh.formed(ids)
    for (const u of leavers) m.nodes.get(u)!.step({ kind: 'leave' })
    settled(m, 6)
    const label = `${ids.join(',')} minus ${leavers.join(',')}`
    assert.deepEqual(leavers.map((u) => m.left.get(u)), leavers.map(() => true), `${label}: both leavers went clean (${m.log.filter((l) => l.includes(' left ')).join('; ')})`)
    assert.deepEqual(m.splits, [], `${label}: one view per epoch`)
    const stayers = ids.filter((u) => !leavers.includes(u))
    for (const u of stayers) {
      const x = m.nodes.get(u)!
      assert.deepEqual(x.membership.view.members.map((v) => v[0]), stayers, `${label}: ${u} holds the view of the stayers`)
      assert.equal(x.epoch, 3, `${label}: two shrinks, epoch 3`)
      assert.equal(x.membership.gate(x).open, true, `${label}: ${u} is writable`)
    }
    for (const u of leavers) assert.ok(m.nodes.get(u)!.membership.leaving!.total <= 6, `${label}: ${u} went inside a few ticks, not at the window`)
  }
})

test('graceful leave (V4-6): nothing to leave answers at once — open genesis, a rejoiner, a solo view — with no LEAVE, no ballot, no journal; a second leave() is a no-op', () => {
  const g = harness('aa')
  g.node.step({ kind: 'start' })
  g.node.step({ kind: 'leave' })
  assert.deepEqual(g.of('left'), [['left', true]])
  assert.equal(g.jk(JK.leave).length, 0)
  assert.equal(g.jk(JK.left).length, 0)
  //! a rejoiner (restored, unconfirmed) still holds a RESTORED view that names it — and its peers can
  // be holding it too, so "nothing to leave" would be a lie: it knocks like any other member and
  // answers only on a survivor's echo, or (unanswered) when the tick bound runs out.
  const r = harness('cc', { hosts: ['sim:aa'], boot: { epoch: 5, members: [['aa', 'sim:aa'], ['cc', 'sim:cc']] } })
  r.node.step({ kind: 'start' })
  r.node.step({ kind: 'leave' })
  assert.deepEqual(r.of('left'), [], 'not answered at once: a restored view names it')
  assert.equal(r.jk(JK.leave).length, 1, 'it knocked instead')
  assert.equal(r.jk(JK.propose).length, 0, 'and never proposed: aa is the lowest live member')
  for (let i = 0; i <= LEAVE_TICKS; i++) r.tick()
  assert.deepEqual(r.of('left'), [['left', false]], 'nobody answered: it goes like a crash — journaled, never silent')
  //! a solo view (the full-restart self-ballot committed a one-member view): the last member simply goes
  const s = harness('aa', { boot: { epoch: 5, members: [['aa', 'sim:aa']] } })
  s.node.step({ kind: 'start' })
  for (let i = 0; i < 10; i++) s.tick()
  assert.equal(s.node.epoch, 6, 'the solo self-ballot committed')
  s.node.step({ kind: 'leave' })
  assert.deepEqual(s.of('left'), [['left', true]])
  assert.equal(s.jk(JK.leave).length, 0)
  //! one outcome per node
  const h = formedPair()
  h.node.step({ kind: 'leave' })
  h.node.step({ kind: 'leave' })
  assert.equal(h.jk(JK.leave).length, 1)
  assert.equal(h.jk(JK.propose).filter((e) => e.a === 2).length, 1)
})

test('graceful leave (V4-6), rebase: a newer view that still holds the leaver drops its stale shrunk ballot; the next tick re-proposes from the NEW members — a member admitted meanwhile is never dropped', () => {
  const h = formedView1() // {aa,bb,cc} at 1; aa is the lowest
  //! aa's epoch-2 vote goes to bb's ballot (dd joining, relayed) — so aa's own shrunk ballot must escalate to 3
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd']], p: 'bb' }) })
  h.node.step({ kind: 'leave' })
  assert.deepEqual(proposed(h, 1, 3), [['bb', 'cc']], 'proposed past the spent vote, from the view as it stands')
  //! bb's ballot commits first: view 2 holds aa AND dd — aa's epoch-3 ballot was built on a stale old set
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd']] }) })
  assert.equal(h.node.epoch, 2)
  assert.equal(h.of('left').length, 0, 'still a member: not gone')
  h.tick()
  assert.deepEqual(proposed(h, 1, 3), [['bb', 'cc'], ['bb', 'cc', 'dd']], 're-proposed at 3 from the NEW base: dd stays')
})

//! ── the proposer-side double vote (I-20 salvage, 2026-10-08). votedFor remembers only the LATEST ballot. A node
// that granted another proposer at 2, then opened a ballot of its own at 3 (past that vote) and lost it, had
// votedFor = {3, me}: #nextEpoch saw "my own ballot" and started again at view+1 = 2 — spending at 2 a vote it
// had already given away there. Two ballots at one epoch with its vote in both; with two old-set majorities that
// share only this voter, two views commit at one epoch. The fix: a fresh ballot of mine never opens BELOW my own
// last ballot (the same epoch again is the idempotent same-proposer case). ──
test('#nextEpoch never goes back below my own ballot: granted at 2, proposed at 3, re-proposing lands at 3 again — never at 2', () => {
  const h = formedView1() // {aa,bb,cc} at 1
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd']], p: 'bb' }) })
  assert.deepEqual(h.node.membership.votedFor, { e: 2, p: 'bb', h: 'aa,bb,cc,dd' }, 'granted bb at 2')
  //! cc is gone for good: aa evicts it — at 3, past the vote it gave bb
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  //! suspect first, then exhaust the chain (V4-20): a chain exhausted before suspicion is revived by the
  // heartbeat, and the revived dial holds eviction until it gives up too
  for (let i = 0; i < 3; i++) h.tick()
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [3, 2]], 'the eviction ballot opened at 3')
  //! the ballot ages out unanswered (bb never votes); the next one must open at 3 again, not at 2. Every tick
  // revives the given-up dial to cc (V4-20), so the chain is exhausted again after each tick, or the hold never ends
  for (let i = 0; i < 12; i++) {
    h.tick()
    for (let k = 0; k < 11; k++) {
      const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
      if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
      h.node.step({ kind: 'linkDown', link: 900 + i * 11 + k, reason: 'refused', to: 'sim:cc' })
    }
  }
  const later = h.jk(JK.propose).slice(2).map((e) => [e.a, e.b])
  assert.ok(later.length >= 1, 'proposed again after the ballot aged out')
  assert.ok(later.every(([e]) => e >= 3), `every later ballot is at 3 or above: ${JSON.stringify(later)}`)
  assert.ok(h.node.membership.votedFor.e >= 3)
})

//! ── real Nodes in a mesh, driven by hand: the test below only chooses the order their frames arrive in ──
const meshIds = { aa: 1, bb: 2, cc: 3, ee: 5 } as const
type MeshId = keyof typeof meshIds
const meshNode = (uuid: MeshId) => {
  const h = harness(uuid, { hosts: [] })
  h.node.step({ kind: 'start' })
  //! the raw bytes of every control frame of `verb` sent to peer `to`, in order
  const sent = (to: MeshId, verb: number) =>
    h.of('send').filter((e) => e[1] === meshIds[to]).map((e) => e[2] as Uint8Array)
      .filter((b) => new Framer().push(b.slice())[0]?.verb === verb)
  //! exhaust the redial chain to `to`: the dial is refused until the node gives up (membership holds eviction while dialing).
  // Each round fires every redial timer armed toward `to` (the i-th redial timer and the i-th JK.redial row are one
  // arm, so the row names the target), then fails the dial. That includes a timer an OLDER chain left pending
  // across a reconnect: under the one-chain rule (kernel/node.ts #redial) it owns the target, and the chain cannot
  // end until it fires.
  // (Firing only the newest timer of any target used to look like exhaustion only because that rule dropped the
  // dead member's chain entry, so nothing held eviction — the bug the review found.)
  const giveUp = (to: MeshId) => {
    for (let i = 0; i < 11; i++) {
      const timers = h.of('timer').filter((x) => x[2] === TAG.redial), rows = h.jk(JK.redial)
      assert.equal(timers.length, rows.length, 'one JK.redial row per redial timer')
      timers.forEach((t, k) => { if (rows[k].b === `sim:${to}`) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial }) })
      h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: `sim:${to}` })
    }
    assert.ok(!h.node.dialing(`sim:${to}`), `the chain to ${to} ended`)
  }
  return { uuid, ...h, sent, giveUp, admitPeer: (u: MeshId) => h.admit(meshIds[u], u), down: (u: MeshId) => h.node.step({ kind: 'linkDown', link: meshIds[u], reason: 'close' }) }
}
type Mesh = ReturnType<typeof meshNode>
//! deliver the LAST frame of `verb` that `from` sent to `to`
const deliver = (from: Mesh, to: Mesh, verb: number) => {
  const all = from.sent(to.uuid, verb)
  assert.ok(all.length, `${from.uuid} sent no ${verb} to ${to.uuid}`)
  to.node.step({ kind: 'bytesIn', link: meshIds[from.uuid], bytes: all[all.length - 1] })
}
const viewOf = (h: Mesh) => `${h.node.epoch}:${h.node.membership.view.members.map((m) => m[0]).join(',')}`

//! the double vote committing TWO VIEWS AT ONE EPOCH, on three real nodes whose frames arrive in a chosen order.
// {aa,bb,cc} at 1. bb, cut from aa, proposes ee's join at 2 (ee grants); the cut heals and aa grants bb at 2 too.
// cc then drops out: aa evicts it at 3 (past the vote it gave bb) — cc returns and the ballot is abandoned. aa's
// VOTE reaches bb: bb commits {aa,bb,cc,ee}@2 on bb + ee + aa. Now bb drops out of aa's sight for good, and aa
// evicts it: before the fix at 2 again — cc, who never saw bb's ballot, grants, and aa commits {aa,cc}@2 on aa + cc.
// Two old-set majorities of {aa,bb,cc}, sharing exactly the voter that voted twice; both proposers writable.
test('the double vote splits the cluster: aa granted bb at 2, lost its own ballot at 3, and re-proposed at 2 — two views commit at epoch 2 (base); the fix keeps aa at 3', () => {
  const aa = meshNode('aa'), bb = meshNode('bb'), cc = meshNode('cc')
  aa.admitPeer('bb'); aa.admitPeer('cc'); bb.admitPeer('aa'); bb.admitPeer('cc'); cc.admitPeer('aa'); cc.admitPeer('bb')
  aa.tick() // genesis: aa is the lowest over the formed mesh
  deliver(aa, bb, VERB.PROPOSE); deliver(aa, cc, VERB.PROPOSE)
  deliver(bb, aa, VERB.VOTE); deliver(cc, aa, VERB.VOTE)
  deliver(aa, bb, VERB.VIEW); deliver(aa, cc, VERB.VIEW)
  for (const h of [aa, bb, cc]) assert.equal(viewOf(h), '1:aa,bb,cc')
  //! 1. aa and bb lose each other (both keep dialing, so neither evicts); ee joins through bb, who is the lowest
  // live member in its own eyes — bb opens {aa,bb,cc,ee}@2 and ee grants it. cc never sees this ballot.
  aa.down('bb'); bb.down('aa')
  for (let i = 0; i < 3; i++) { aa.tick(); bb.tick() }
  bb.admitPeer('ee')
  bb.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.JOIN, { u: 'ee', i: 1, l: 'sim:ee' }) })
  assert.deepEqual(bb.jk(JK.propose).map((e) => [e.a, e.b]), [[2, 4]], 'bb proposed the join at 2')
  bb.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 0, h: 'aa,bb,cc,ee' }) })
  //! 2. the cut heals; bb's re-offer reaches aa, and aa grants bb at 2 (its VOTE is slow)
  aa.admitPeer('bb'); bb.admitPeer('aa')
  aa.tick(); bb.tick(); bb.tick()
  deliver(bb, aa, VERB.PROPOSE)
  assert.deepEqual(aa.node.membership.votedFor, { e: 2, p: 'bb', h: 'aa,bb,cc,ee' }, 'aa granted bb at 2')
  //! 3. cc drops out of aa's sight and the dial gives up: aa evicts cc — at 3, past the vote it gave bb.
  // Then cc is back, and the eviction ballot is abandoned (nobody voted on it).
  aa.down('cc'); cc.down('aa')
  for (let i = 0; i < 3; i++) aa.tick() // suspect first, then exhaust the chain (V4-20)
  aa.giveUp('cc')
  aa.tick()
  assert.deepEqual(aa.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [3, 2]], 'aa evicted cc at 3')
  aa.admitPeer('cc'); cc.admitPeer('aa')
  aa.tick()
  //! 4. aa's slow VOTE lands: bb commits {aa,bb,cc,ee}@2 on bb + ee + aa (2 of 3 old, 3 of 4 new)
  deliver(aa, bb, VERB.VOTE)
  assert.equal(viewOf(bb), '2:aa,bb,cc,ee')
  //! 5. bb drops out of aa's sight for good (its VIEW@2 dies with the link): aa evicts bb
  aa.down('bb'); bb.down('aa')
  for (let i = 0; i < 3; i++) aa.tick() // suspect first, then exhaust the chain (V4-20)
  aa.giveUp('bb')
  aa.tick()
  const evictBb = aa.jk(JK.propose).slice(2).map((e) => [e.a, e.b])
  assert.equal(evictBb.length, 1, 'aa proposed the view without bb')
  //! cc never saw bb's ballot: its vote at this epoch is free, so it grants aa — and aa's ballot commits
  deliver(aa, cc, VERB.PROPOSE); deliver(cc, aa, VERB.VOTE)
  assert.deepEqual(aa.node.membership.view.members.map((m) => m[0]), ['aa', 'cc'], 'aa committed the view without bb')
  assert.deepEqual(aa.node.membership.gate(aa.node), { open: true, reason: '' })
  assert.deepEqual(bb.node.membership.gate(bb.node), { open: true, reason: '' })
  //! THE PIN: never two views at one epoch. Before the fix aa re-proposed at 2 and this read '2:aa,cc' beside bb's '2:aa,bb,cc,ee'.
  assert.notEqual(aa.node.epoch, bb.node.epoch, `two views at one epoch: aa ${viewOf(aa)} vs bb ${viewOf(bb)}`)
  assert.deepEqual(evictBb, [[3, 2]], 'the eviction of bb opened at 3, never below aa\'s own last ballot')
})
