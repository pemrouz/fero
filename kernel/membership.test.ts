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
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, total: LEAVE_WINDOW + 1, done: true, why: 'unanswered', drain: undefined })
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
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 4, done: true, why: 'unanswered', drain: undefined })
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
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 3, done: true, why: 'unanswered', drain: undefined })
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
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, total: LEAVE_TICKS * 2 + 3, done: true, why: 'unanswered', drain: undefined }, 'every tick since the fault counted toward the bound')
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

//! ── the release rule (DESIGN-LEAVE §10.10, 2026-10-12) ──
test('a node remembers EVERY vote it gave above its view, not the latest alone: granted aa at 2 then cc at 3, votedFor is the vote at 3 with the vote at 2 behind it (prior); the boot record carries it and a restart brings it back; an install at 2 prunes the vote at 2 and keeps the one at 3', () => {
  const h = harness('bb', { hosts: ['sim:aa', 'sim:cc'], durable: true })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.admit(2, 'cc')
  const three: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: three }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']], p: 'aa' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']], p: 'cc' }) })
  const votes = [...h.sentOn(1, VERB.VOTE), ...h.sentOn(2, VERB.VOTE)].map((f) => (f.value as { g: number }).g)
  assert.deepEqual(votes, [1, 1], 'both granted: 2 and 3 are above view 1 and unspent')
  const vf = h.node.membership.votedFor
  assert.equal(vf.e, 3); assert.equal(vf.p, 'cc')
  assert.deepEqual(vf.prior, [{ e: 2, p: 'aa', h: 'aa,bb' }], 'the earlier vote above the view rides behind the latest')
  //! durable with the vote: the last boot record carries prior, as a copy of its own
  const boot = h.of('boot').pop()![1] as { votedFor: { e: number; prior?: unknown[] } }
  assert.equal(boot.votedFor.e, 3)
  assert.deepEqual(boot.votedFor.prior, [{ e: 2, p: 'aa', h: 'aa,bb' }])
  assert.notEqual(boot.votedFor.prior, vf.prior, 'the record does not share the live list')
  //! a restart from that record remembers both
  const r = harness('bb', { hosts: ['sim:aa', 'sim:cc'], durable: true, boot: { epoch: 1, members: three, votedFor: boot.votedFor as never } })
  assert.deepEqual(r.node.membership.votedFor, { e: 3, p: 'cc', h: 'bb,cc', prior: [{ e: 2, p: 'aa', h: 'aa,bb' }] })
  //! a view at 2 installs: the vote at 2 is history, the vote at 3 stays (vote-once still reads it)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.deepEqual(h.node.membership.votedFor, { e: 3, p: 'cc', h: 'bb,cc' }, 'pruned at the install: nothing at or below the view stays behind the latest')
  //! a re-grant to the SAME proposer at the same epoch replaces the vote at that epoch, never doubles it
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']], p: 'cc' }) })
  assert.deepEqual(h.node.membership.votedFor, { e: 3, p: 'cc', h: 'bb,cc' })
})

//! fiveAt1 — `me` with its four peers admitted, at view 1 {aa,bb,cc,dd,ee}; `link[u]` is the link id to u
const mem = (us: string[]): [string, string][] => us.map((u) => [u, `sim:${u}`])
const fiveAt1 = (me: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const ids = ['aa', 'bb', 'cc', 'dd', 'ee']
  const h = harness(me, { hosts: ids.filter((u) => u !== me).map((u) => `sim:${u}`), ...opts })
  h.node.step({ kind: 'start' })
  const link: Record<string, number> = {}
  ids.filter((u) => u !== me).forEach((u, i) => { link[u] = i + 1; h.admit(i + 1, u) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: mem(ids) }) })
  assert.equal(h.node.epoch, 1)
  const vote = (l: number) => h.sentOn(l, VERB.VOTE).pop()!.value as { g: number; ce: number; hm?: string[] }
  return { ...h, link, vote }
}

test('the hold (DESIGN-LEAVE §10.10.1-2): a vote for a view TWO members apart from mine closes my gate `held`; the same proposer\'s replacement at the same epoch is granted and re-read; while held I refuse a ballot that is not joint over the held view and name it (hm), and grant the re-offer that is (its own vote one apart holds nothing, the hold stays behind it) and a ballot whose member set IS the held view\'s; an install re-reads every vote against the new view', () => {
  const h = fiveAt1('cc')
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  //! aa evicts dd and ee at 2: {aa,bb,cc}, two apart from view 1
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1, 'granted: 2 is above view 1 and unspent')
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  assert.deepEqual(h.jk(JK.gateClose).map((e) => e.a), ['held'])
  assert.deepEqual(h.node.membership.holds(h.node).map((x) => x.h), ['aa,bb,cc'])
  //! aa's replacement ballot at the same epoch: granted (at most one of aa's ballots at 2 commits), and it is the hold now
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  assert.deepEqual(h.node.membership.holds(h.node).map((x) => x.h), ['aa,cc'])
  //! bb's ballot at 3 is one apart from view 1 but not joint over {aa,cc}: refused, and the refusal names the held view
  h.node.step({ kind: 'bytesIn', link: h.link.bb, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['bb', 'cc', 'dd', 'ee']), p: 'bb', o: 1 }) })
  assert.equal(h.vote(h.link.bb).g, 0)
  assert.deepEqual(h.vote(h.link.bb).hm, ['aa,cc'])
  //! the re-offer joint over it is granted; that vote is one apart (no hold of its own), and the hold at 2 stays behind it
  h.node.step({ kind: 'bytesIn', link: h.link.bb, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['bb', 'cc', 'dd', 'ee']), p: 'bb', o: 1, j: ['aa,cc'] }) })
  assert.equal(h.vote(h.link.bb).g, 1)
  assert.deepEqual(h.node.membership.votedFor, { e: 3, p: 'bb', h: 'bb,cc,dd,ee', prior: [{ e: 2, p: 'aa', h: 'aa,cc' }] })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  //! a ballot whose member set IS the held view's — aa's escalation past a burn — is joint by construction: granted
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 4, m: mem(['aa', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  assert.deepEqual(h.node.membership.holds(h.node).map((x) => `${x.e}:${x.h}`), ['4:aa,cc', '2:aa,cc'])
  //! view 2 = {aa,cc} installs: the votes at 2 are history; the vote at 4 is for view 2's own members (no hold) and the
  // vote at 3 for {bb,cc,dd,ee} is now FOUR apart — held, by the re-read (the kept ballot in the reversed order)
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['aa', 'cc']) }) })
  assert.deepEqual(h.node.membership.holds(h.node).map((x) => `${x.e}:${x.h}`), ['3:bb,cc,dd,ee'])
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  //! view 4 installs: nothing above it — no hold; cc and aa are 2 of 2
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 4, m: mem(['aa', 'cc']) }) })
  assert.deepEqual(h.node.membership.holds(h.node), [])
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  assert.deepEqual(h.jk(JK.gateOpen).length, 1)
})

test('form (β) (DESIGN-LEAVE §10.10.3): a PROPOSE carries the epoch of the view it is over (o); a ballot over a view BELOW mine is refused and the refusal teaches my view; one without o reads as over my own view; at the proposer NO ballot outlives an install — a ballot above the new view is dropped and re-proposed over the view I hold, with the new o', () => {
  //! the voter: cc at view 2 = {aa,bb,cc}
  const h = fiveAt1('cc')
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['aa', 'bb', 'cc']) }) })
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['aa', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 0, 'a ballot over view 1 while I hold view 2: its proposer is behind')
  assert.equal(h.vote(h.link.aa).ce, 2, 'the refusal teaches it my view')
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['aa', 'cc']), p: 'aa', o: 2 }) })
  assert.equal(h.vote(h.link.aa).g, 1, 'over my view: granted')
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['aa', 'cc']), p: 'aa' }) })
  assert.equal(h.vote(h.link.aa).g, 1, 'no o (an older peer): over my own view, the same proposer re-grants')
  //! the proposer: aa at view 1 = {aa,bb,cc} evicts cc at 2; bb's refusal burns 2; the ballot ages out and aa escalates to 3
  const p = formedView1()
  p.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  p.tick(); p.tick(); p.tick()
  let dials = 800
  //! exhaust the chain to cc (the heartbeat revives a given-up target, so the eviction waits on it again every time)
  const giveUp = () => { for (let i = 0; i < 11; i++) { const t = p.of('timer').filter((x) => x[2] === TAG.redial).pop(); if (t) p.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial }); p.node.step({ kind: 'linkDown', link: dials++, reason: 'refused', to: 'sim:cc' }) } }
  giveUp()
  p.tick()
  const proposes = () => p.sentOn(1, VERB.PROPOSE).map((f) => { const v = f.value as { e: number; o: number; j?: string[] }; return `${v.e}/${v.o}${v.j ? '+' : ''}` })
  assert.deepEqual(proposes(), ['1/0', '2/1'], 'genesis over the empty view, then the eviction at 2 over view 1, joint over nothing')
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 0, ce: 1, h: 'aa,bb', ve: 2 }) })
  for (let i = 0; i < 20 && !p.jk(JK.propose).some((e) => e.a === 3); i++) { giveUp(); p.tick() }
  assert.deepEqual(p.jk(JK.propose).map((e) => e.a), [1, 2, 3], 'escalated past the burn to 3, still over view 1')
  assert.equal(proposes().pop(), '3/1')
  //! bb's VIEW 2 = {aa,bb,cc} lands: the ballot at 3 is above it and the base kept it (a ballot over view 1, which no
  // voter at view 2 grants under (β)). Now it is dropped, and the next tick re-proposes the eviction over view 2.
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['aa', 'bb', 'cc']) }) })
  assert.equal(p.node.epoch, 2)
  giveUp(); p.tick()
  assert.deepEqual(p.jk(JK.propose).map((e) => e.a), [1, 2, 3, 3], 'dropped at the install and re-proposed at 3 (never below my own ballot, V4-25)')
  assert.equal(proposes().pop(), '3/2', 'over the view I hold now')
})

test('the joint commit (DESIGN-LEAVE §10.10.2, §10.10.4 supersession): a refusal naming a held view (hm) makes the ballot joint over it — the re-offer carries it (j) and the commit needs a majority of that view too; with the held view\'s majority consenting it commits', () => {
  const m = Mesh.formed(['aa', 'bb', 'cc', 'dd', 'ee'])
  m.cut('aa', 'dd'); m.cut('aa', 'ee')
  for (let i = 0; i < 3; i++) m.tick('aa')
  m.giveUp('aa', 'dd'); m.giveUp('aa', 'ee')
  m.tick('aa')
  const aa = m.nodes.get('aa')!
  assert.deepEqual(aa.journal.read().filter((e) => e.kind === JK.propose).map((e) => [e.a, e.b]), [[2, 3]], 'aa evicts dd and ee at 2')
  const q = (a: string, b: string) => m.q.get(`${a}>${b}`)!
  const first = q('aa', 'bb').shift()!.value as { o: number; j?: string[] }
  assert.equal(first.o, 1); assert.equal(first.j, undefined)
  q('aa', 'cc').shift()
  const feed = (from: string, body: object) => aa.step({ kind: 'bytesIn', link: m.linkOf.get('aa')!.get(from)!, bytes: encodeControl(VERB.VOTE, body) })
  //! a late refusal of ANOTHER same-epoch ballot of aa's (a different member set) names a hold: not this ballot's
  // business — its re-offer is joint over nothing (the fifth review: a phantom joint set would hold it a proposal age)
  feed('bb', { e: 2, g: 0, ce: 1, h: 'aa,bb', ve: 1, hm: ['zz,yy,xx'] })
  m.tick('aa'); m.tick('aa')
  assert.equal((q('aa', 'bb').pop()!.value as { j?: string[] }).j, undefined, 'a refusal of another ballot widens nothing')
  //! bb refuses, naming the view it holds a vote for (a ballot of cc's, say): aa's ballot becomes joint over it
  feed('bb', { e: 2, g: 0, ce: 1, h: 'aa,bb,cc', ve: 1, hm: ['bb,cc,dd,ee'] })
  m.tick('aa'); m.tick('aa')
  const re = q('aa', 'bb').pop()!.value as { o: number; j?: string[] }
  assert.deepEqual(re.j, ['bb,cc,dd,ee'], 'the re-offer is joint over the held view')
  //! bb and cc grant: 3 of the old 5, 3 of the new 3 — the base commits here — but 2 of the held view's 4
  feed('bb', { e: 2, g: 1, ce: 1, h: 'aa,bb,cc', ve: 2 }); feed('cc', { e: 2, g: 1, ce: 1, h: 'aa,bb,cc', ve: 2 })
  assert.equal(aa.epoch, 1, 'not committed: the held view {bb,cc,dd,ee} may be live and only two of its four consented')
  //! dd comes back and consents: 3 of 4 — the held view cannot be live any more, the ballot commits
  m.connect('aa', 'dd')
  feed('dd', { e: 2, g: 1, ce: 1, h: 'aa,bb,cc', ve: 2 })
  assert.equal(aa.epoch, 2, 'superseded by its own majority: committed')
})

test('the stayer\'s count (DESIGN-LEAVE §10.5, §10.10.6): a member whose last word names a hold above my view is not counted — learned from its ask (PULL vs) and from its HELLO (v) at admit; an empty ask or a HELLO that names no hold takes the word back; a client\'s word is not read', () => {
  const h = fiveAt1('dd')
  h.node.step({ kind: 'linkDown', link: h.link.bb, reason: 'cut' }); h.node.step({ kind: 'linkDown', link: h.link.ee, reason: 'cut' })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'dd, aa and cc: three of five')
  const hold = [{ e: 2, h: 'aa,bb,cc', p: 'aa' }]
  //! cc's ask: it holds a vote at 2 above view 1 — cc is reachable, but not a member to count toward writing at view 1
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.PULL, { e: 1, vs: hold }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'minority' })
  assert.deepEqual(h.jk(JK.gateClose).map((e) => e.a), ['minority'])
  //! the release is a frame: cc's empty ask, and cc counts again
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.PULL, { e: 1, vs: [] }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  //! a fresh link from cc whose HELLO names the hold: admitted knowing it — never a round trip in which cc is counted
  h.node.step({ kind: 'linkDown', link: h.link.cc, reason: 'cut' })
  h.node.step({ kind: 'linkUp', link: 21, dialed: true, to: 'sim:cc' })
  h.node.step({ kind: 'bytesIn', link: 21, bytes: encodeControl(VERB.HELLO, { u: 'cc', i: 2, l: 'sim:cc', v: hold }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'minority' })
  //! ...and a fresh HELLO that names no hold replaces the old word (a release lost on the dead link is learned here)
  h.node.step({ kind: 'linkDown', link: 21, reason: 'cut' })
  h.node.step({ kind: 'linkUp', link: 22, dialed: true, to: 'sim:cc' })
  h.node.step({ kind: 'bytesIn', link: 22, bytes: encodeControl(VERB.HELLO, { u: 'cc', i: 3, l: 'sim:cc' }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  //! a client's word is not read (I-23): its HELLO's v and its PULL's vs change nothing
  h.node.step({ kind: 'linkUp', link: 31, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 31, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1, v: [{ e: 9, h: 'q1,q2,q3', p: 'q1' }] }) })
  h.node.step({ kind: 'bytesIn', link: 31, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 9, h: 'aa,cc,dd', p: 'aa' }] }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  //! a MEMBER's malformed hold is no hold (the fifth review): an empty member list, a fractional or negative epoch —
  // the entry is dropped, cc is counted, and no ballot of mine is ever joint over a view nobody can be a majority of
  h.node.step({ kind: 'bytesIn', link: 22, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 5, h: '', p: 'zz' }, { e: 2.5, h: 'aa,bb', p: 'aa' }, { e: -3, h: 'aa,bb', p: 'aa' }] }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'none of the three is a hold')
})

test('the ask (DESIGN-LEAVE §10.10.6): a grant that holds me is announced at once as PULL {e, vs} on every member link, again on every tick, and once more, empty, when the last hold ends at an install (to the new view\'s members); nothing at epoch 0, where the HELLO alone carries the hold (v); at admit the ask goes on the fresh link only when my holds are not what my HELLO on it said', () => {
  const h = fiveAt1('cc')
  const pulls = (l: number) => h.sentOn(l, VERB.PULL).map((f) => f.value as { e: number; vs?: unknown[] })
  const hold = { e: 2, h: 'aa,bb,cc', p: 'aa' }
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  for (const u of ['aa', 'bb', 'dd', 'ee']) assert.deepEqual(pulls(h.link[u]), [{ e: 1, vs: [hold] }], `the ask on the ${u} link, at once`)
  h.tick()
  for (const u of ['aa', 'bb', 'dd', 'ee']) assert.equal(pulls(h.link[u]).length, 2, `the refresh on the ${u} link`)
  //! view 2 = {aa,bb,cc} installs: the hold ends; the empty ask is the release, to the members of the view I hold now
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['aa', 'bb', 'cc']) }) })
  for (const u of ['aa', 'bb']) assert.deepEqual(pulls(h.link[u]).pop(), { e: 2, vs: [] }, `the release on the ${u} link`)
  for (const u of ['dd', 'ee']) assert.equal(pulls(h.link[u]).length, 2, `${u} is not a member of view 2: nothing`)
  h.tick()
  for (const u of ['aa', 'bb']) assert.equal(pulls(h.link[u]).length, 3, 'holding nothing, the tick asks nothing more')
  //! epoch 0: a genesis grant is a hold, but no ask goes out — the HELLO on a fresh link carries it
  const g = harness('cc', { hosts: ['sim:aa', 'sim:bb'] })
  g.node.step({ kind: 'start' })
  g.admit(1, 'aa')
  g.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 0 }) })
  assert.equal((g.sentOn(1, VERB.VOTE).pop()!.value as { g: number }).g, 1)
  assert.deepEqual(g.node.membership.holds(g.node).map((x) => x.h), ['aa,bb,cc'], 'three apart from the empty view')
  g.tick()
  assert.equal(g.sentOn(1, VERB.PULL).length, 0, 'no ask at epoch 0')
  g.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:bb' })
  assert.deepEqual((g.sentOn(2, VERB.HELLO)[0].value as { v: unknown }).v, [{ e: 1, h: 'aa,bb,cc', p: 'aa' }], 'the HELLO names the hold')
  //! the hold ends while that HELLO is in flight (view 1 lands): at admit the ask on the fresh link says so, once
  g.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: mem(['aa', 'bb', 'cc']) }) })
  assert.deepEqual(g.node.membership.holds(g.node), [])
  g.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  assert.deepEqual(g.sentOn(2, VERB.PULL).map((f) => f.value), [{ e: 1, vs: [] }], 'the ask at admit: not what my HELLO said')
  g.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:dd' })
  g.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'dd', i: 1, l: 'sim:dd' }) })
  assert.equal(g.sentOn(3, VERB.PULL).length, 0, 'a HELLO that said nothing and holds that are nothing: no ask at admit')
})

test('holds() is memoized (the fifth review): a vote above my view that is NO hold — one apart, the common state after a failed one-member ballot — answers at the fast path\'s cost, the same list object on every call until the vote or the view changes; a replacement vote or an install is a new answer', () => {
  const h = fiveAt1('cc')
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc', 'dd']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  const first = h.node.membership.holds(h.node)
  assert.deepEqual(first, [], 'one apart: no hold')
  assert.equal(h.node.membership.holds(h.node), first, 'the memo: the same object, nothing recomputed')
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  //! aa's replacement at the same epoch is two apart: a new vote, a new answer
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  const held = h.node.membership.holds(h.node)
  assert.notEqual(held, first)
  assert.deepEqual(held.map((x) => x.h), ['aa,bb,cc'])
  assert.equal(h.node.membership.holds(h.node), held, 'memoized again')
  //! the install is a new view: re-read (the vote at 2 is history, nothing above view 2)
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['aa', 'bb', 'cc']) }) })
  assert.deepEqual(h.node.membership.holds(h.node), [])
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
})

test('a HELLO whose v is not a list of holds is a malformed HELLO: the link closes', () => {
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', v: 'held' }) })
  assert.deepEqual(h.jk(JK.frameDrop).map((e) => e.b), ['malformed hello'])
  assert.deepEqual(h.of('close').map((e) => e[2]), ['malformed-hello'])
  h.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:cc' })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'cc', i: 1, l: 'sim:cc', v: [{ e: 0, h: 'x', p: 'y' }] }) })
  assert.equal(h.of('close').length, 2, 'an epoch of 0 is no hold')
  h.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:dd' })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'dd', i: 1, l: 'sim:dd', v: [{ e: 2, h: '', p: 'y' }] }) })
  assert.equal(h.of('close').length, 3, 'an empty member list is no hold (the fifth review)')
})

test('the release, the proposer\'s word (DESIGN-LEAVE §10.10.4): a held voter\'s ask reaches its vote\'s proposer, which holds no such ballot and no view at or above it, and DISOWNS it (NACK) — the vote stays spent, warns no more (release row, gate open, the empty ask), and a re-grant to the same proposer re-holds; the proposer answers no NACK for a ballot it holds, for another proposer\'s ballot, or when its VIEW answers', () => {
  //! the voter: cc held on aa's {aa,bb,cc}@2
  const h = fiveAt1('cc', { durable: true })
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  //! a NACK from the wrong link, or for another ballot of aa's, releases nothing
  h.node.step({ kind: 'bytesIn', link: h.link.bb, bytes: encodeControl(VERB.NACK, { e: 2, h: 'aa,bb,cc' }) })
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.NACK, { e: 2, h: 'aa,cc' }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  //! aa's disown of the ballot cc holds a vote for
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.NACK, { e: 2, h: 'aa,bb,cc' }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'released: the vote warns no more')
  assert.deepEqual(h.jk(JK.release).map((e) => [e.a, e.b]), [[2, 'aa']])
  assert.deepEqual(h.jk(JK.gateOpen).length, 1)
  assert.deepEqual(h.node.membership.votedFor, { e: 2, p: 'aa', h: 'aa,bb,cc', f: 1 }, 'disowned, and still the spent vote')
  assert.deepEqual((h.of('boot').pop()![1] as { votedFor: unknown }).votedFor, { e: 2, p: 'aa', h: 'aa,bb,cc', f: 1 }, 'durable with the vote')
  for (const u of ['aa', 'bb', 'dd', 'ee']) assert.deepEqual(h.sentOn(h.link[u], VERB.PULL).pop()!.value, { e: 1, vs: [] }, `the release announced on the ${u} link`)
  //! still spent: a rival at 2 is refused (vote-once reads e and p, not f)
  h.node.step({ kind: 'bytesIn', link: h.link.bb, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['bb', 'cc', 'dd', 'ee']), p: 'bb', o: 1 }) })
  assert.equal(h.vote(h.link.bb).g, 0)
  //! aa re-offers the same ballot: the re-grant replaces the vote un-disowned and re-reads the hold
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  //! the proposer: aa at view 1 = {aa,bb,cc} with no ballot disowns a hold on a ballot of its own, and only that
  const p = formedView1()
  const nacks = () => p.sentOn(1, VERB.NACK).map((f) => f.value)
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'aa,bb', p: 'aa' }, { e: 2, h: 'bb,cc', p: 'cc' }] }) })
  assert.deepEqual(nacks(), [{ e: 2, h: 'aa,bb' }], 'mine and gone: disowned; cc\'s is not mine to answer')
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PULL, { e: 1, vs: [] }) }) // bb's release: holding nothing, its word is taken back (else aa's next ballot is joint over {bb,cc} and waits for cc)
  //! with the ballot open there is no disown — it may still commit
  p.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  p.tick(); p.tick(); p.tick()
  for (let i = 0; i < 11; i++) {
    const t = p.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) p.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    p.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  p.tick()
  assert.ok(p.jk(JK.propose).some((e) => e.a === 2), 'the eviction of cc is open at 2')
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'aa,bb', p: 'aa' }] }) })
  assert.equal(nacks().length, 1, 'no second disown while the ballot is open')
  //! committed: the VIEW is the answer, never a disown
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(p.node.epoch, 2)
  const views = p.sentOn(1, VERB.VIEW).length
  p.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'aa,bb', p: 'aa' }] }) })
  assert.equal(nacks().length, 1)
  assert.equal(p.sentOn(1, VERB.VIEW).length, views + 1, 'answered with the view at 2')
})

test('the ask reaches the vote\'s PROPOSER, member or not (the fifth review): cc, held on aa\'s {aa,bb,cc}@3 after bb\'s view 2 = {bb,cc,dd} left aa out, asks the members bb and dd AND aa — whose disown releases it, and the release goes to aa too; a node that is neither is told nothing', () => {
  const h = fiveAt1('cc')
  const pulls = (l: number) => h.sentOn(l, VERB.PULL).map((f) => f.value as { e: number; vs?: unknown[] })
  //! aa, escalated past a burn, offers {aa,bb,cc}@3 over view 1 — two apart: cc grants and is held
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  const hold = { e: 3, h: 'aa,bb,cc', p: 'aa' }
  for (const u of ['aa', 'bb', 'dd', 'ee']) assert.deepEqual(pulls(h.link[u]).pop(), { e: 1, vs: [hold] }, `every member of view 1: the ${u} link`)
  //! bb's view 2 = {bb,cc,dd} installs: aa is out of my view; the vote at 3 is still two apart ({aa,bb,cc} vs {bb,cc,dd})
  h.node.step({ kind: 'bytesIn', link: h.link.bb, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['bb', 'cc', 'dd']) }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' })
  for (const u of ['aa', 'bb', 'dd', 'ee']) assert.equal(pulls(h.link[u]).length, 1, 'the same hold against the new view: nothing changed, so no ask at the install')
  h.tick()
  for (const u of ['aa', 'bb', 'dd']) assert.deepEqual(pulls(h.link[u]).pop(), { e: 2, vs: [hold] }, `the refresh: the members bb and dd, and aa, my proposer (the ${u} link)`)
  assert.deepEqual(pulls(h.link.ee).pop(), { e: 1, vs: [hold] }, 'ee is neither a member of view 2 nor my proposer: nothing new')
  //! aa holds no such ballot: its disown releases cc, and the release (the empty ask) reaches aa as well
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.NACK, { e: 3, h: 'aa,bb,cc' }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  for (const u of ['aa', 'bb', 'dd']) assert.deepEqual(pulls(h.link[u]).pop(), { e: 2, vs: [] }, `the release on the ${u} link`)
  assert.deepEqual(pulls(h.link.ee).pop(), { e: 1, vs: [hold] })
})

test('the opener (the fifth review, DESIGN-LEAVE §10.10.4): bb, the lowest live member of view 2 = {bb,cc,dd}, counts neither cc nor dd once their asks name a hold on aa\'s {aa,cc,dd}@3 (minority) — no suspect, no knock, nothing would ever open a ballot — so it re-proposes {bb,cc,dd} at 4 (past the hold\'s epoch), over view 2, joint over {aa,cc,dd}: only while a majority of {aa,cc,dd} is linked, and cc\'s and dd\'s grants commit it; a hold whose proposer is ME opens nothing (my disown answers it)', () => {
  const h = fiveAt1('bb')
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['bb', 'cc', 'dd']) }) })
  h.node.step({ kind: 'linkDown', link: h.link.aa, reason: 'cut' }); h.node.step({ kind: 'linkDown', link: h.link.ee, reason: 'cut' })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'bb, cc and dd: three of three')
  const hold = [{ e: 3, h: 'aa,cc,dd', p: 'aa' }]
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.PULL, { e: 2, vs: hold }) })
  h.node.step({ kind: 'bytesIn', link: h.link.dd, bytes: encodeControl(VERB.PULL, { e: 2, vs: hold }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'minority' }, 'neither held member counts')
  const proposes = (l: number) => h.sentOn(l, VERB.PROPOSE).map((f) => { const p = f.value as { e: number; o: number; j?: string[] }; return `${p.e}/${p.o}/${p.j}` })
  //! dd's link drops: cc alone is one of the held view's three — a ballot could not commit, so none opens
  h.node.step({ kind: 'linkDown', link: h.link.dd, reason: 'cut' })
  h.tick()
  assert.deepEqual(h.jk(JK.propose), [], 'the held view\'s majority out of reach: no ballot')
  //! dd is back, its HELLO naming the hold: two of three linked — the opener fires, at 4, over view 2, joint
  h.node.step({ kind: 'linkUp', link: 21, dialed: true, to: 'sim:dd' })
  h.node.step({ kind: 'bytesIn', link: 21, bytes: encodeControl(VERB.HELLO, { u: 'dd', i: 2, l: 'sim:dd', v: hold }) })
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[4, 3]], 'the same members at 4: past the hold at 3, where cc\'s and dd\'s votes are spent on aa')
  for (const l of [h.link.cc, 21]) assert.deepEqual(proposes(l), ['4/2/aa,cc,dd'])
  //! cc and dd grant (a ballot joint over their hold): old {bb,cc,dd} 3 of 3, new the same, {aa,cc,dd} 2 of 3 — committed
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.VOTE, { e: 4, g: 1, ce: 2, h: 'bb,cc,dd' }) })
  assert.equal(h.node.epoch, 2, 'cc alone is one of the held view\'s three: not yet')
  h.node.step({ kind: 'bytesIn', link: 21, bytes: encodeControl(VERB.VOTE, { e: 4, g: 1, ce: 2, h: 'bb,cc,dd' }) })
  assert.equal(h.node.epoch, 4, 'superseded by its own majority')
  //! a hold whose proposer is me: aa at view 1 reads bb's and cc's asks on a ballot of its own it no longer holds — it
  // disowns (onPull) and opens nothing, minority or not
  const a = fiveAt1('aa')
  a.node.step({ kind: 'linkDown', link: a.link.dd, reason: 'cut' })
  for (const u of ['bb', 'cc']) a.node.step({ kind: 'bytesIn', link: a.link[u], bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'aa,bb,cc', p: 'aa' }] }) })
  assert.deepEqual(a.node.membership.gate(a.node), { open: false, reason: 'minority' }, 'aa and ee of five')
  assert.equal(a.sentOn(a.link.bb, VERB.NACK).length, 1); assert.equal(a.sentOn(a.link.cc, VERB.NACK).length, 1)
  a.tick()
  assert.deepEqual(a.jk(JK.propose), [], 'mine to disown, not to supersede')
})

test('the opener waits for a LOST member as the eviction does (the sixth review): aa at view 1 of five loses bb and keeps redialing it; dd\'s ask names a hold on bb\'s {bb,dd,ee}@2 — nothing opens while bb is unlinked but not yet a suspect, nor while it is a suspect whose chain still runs (the eviction is held back by the dialing window of V4-39, and the opener waits with it: a lost member is the membership change, and its eviction is the ballot); the tick after the chain gives up, the eviction of bb opens at 2, joint over {bb,dd,ee} — never the full view again at 3', () => {
  const h = fiveAt1('aa')
  h.node.step({ kind: 'linkDown', link: h.link.bb, reason: 'cut' })
  assert.equal(h.node.dialing('sim:bb'), true, 'a lost member link: the short redial chain runs')
  h.node.step({ kind: 'bytesIn', link: h.link.dd, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'bb,dd,ee', p: 'bb' }] }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'aa, cc and ee: three of five without the held dd')
  //! the first window: bb unlinked, not yet a suspect — a majority of my view linked would let a ballot commit
  h.tick()
  assert.deepEqual(h.jk(JK.suspect), [], 'not yet a suspect')
  assert.deepEqual(h.jk(JK.propose), [], 'nothing while a member of my view is unlinked: its eviction may be the next ballot')
  //! the second window: bb a suspect, its chain to it still dialing — the eviction is held back, and so is the opener
  for (let i = 0; i < h.node.tune.suspectTicks + 1; i++) h.tick()
  assert.ok(h.jk(JK.suspect).some((e) => e.a === 'bb'), 'bb is a suspect')
  assert.equal(h.node.dialing('sim:bb'), true, 'still dialing')
  assert.deepEqual(h.jk(JK.propose), [], 'nothing while the chain to the suspect runs: not the eviction, and not the opener')
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
  }
  assert.equal(h.node.dialing('sim:bb'), false, 'the chain gave up')
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[2, 4]], 'the eviction of bb is the ballot, at 2')
  const p = h.sentOn(h.link.dd, VERB.PROPOSE).pop()!.value as { e: number; o: number; j?: string[] }
  assert.deepEqual([p.e, p.o, p.j], [2, 1, ['bb,dd,ee']], 'joint over dd\'s hold')
})

test('the opener on my OWN hold (the eighth round, DESIGN-LEAVE §10.10.4): bb, held at view 1 on aa\'s {aa,bb,cc}@3, installs {bb,cc,dd,ee}@2 — the lowest live member of a view aa is no member of, held alone (cc, dd and ee hold nothing, so no ask names a hold); with aa LINKED nothing opens (my ask reaches it, and its disown is the release); with a member of my view lost nothing opens (its eviction is the ballot); with aa gone and every member linked bb opens {bb,cc,dd,ee} at 4 — past its own hold — over view 2, joint over {aa,bb,cc}, and cc\'s, dd\'s and ee\'s grants commit it: the hold goes with the install', () => {
  const h = fiveAt1('bb')
  const pulls = (l: number) => h.sentOn(l, VERB.PULL).map((f) => f.value as { e: number; vs?: unknown[] })
  const hold = { e: 3, h: 'aa,bb,cc', p: 'aa' }
  h.node.step({ kind: 'bytesIn', link: h.link.aa, bytes: encodeControl(VERB.PROPOSE, { e: 3, m: mem(['aa', 'bb', 'cc']), p: 'aa', o: 1 }) })
  assert.equal(h.vote(h.link.aa).g, 1)
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' }, 'two apart from view 1')
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['bb', 'cc', 'dd', 'ee']) }) })
  assert.equal(h.node.epoch, 2)
  assert.deepEqual(h.node.membership.gate(h.node), { open: false, reason: 'held' }, 'three apart from view 2, and I am its lowest live member')
  //! aa linked (an ex-member): the ask goes to it, my proposer — its word is the release, so no ballot
  h.tick()
  assert.deepEqual(h.jk(JK.propose), [], 'aa linked: its disown answers the ask, nothing opens')
  assert.deepEqual(pulls(h.link.aa).pop(), { e: 2, vs: [hold] }, 'the ask reaches aa, member or not')
  //! aa gone, and dd's link lost too: every member of my view must be linked (dd's eviction is the ballot otherwise)
  h.node.step({ kind: 'linkDown', link: h.link.aa, reason: 'cut' })
  h.node.step({ kind: 'linkDown', link: h.link.dd, reason: 'cut' })
  h.tick()
  assert.deepEqual(h.jk(JK.propose), [], 'dd lost: a membership change in the making, and its eviction carries the hold')
  //! dd back on a fresh link, its HELLO naming nothing: bb opens {bb,cc,dd,ee} at 4 over view 2, joint over {aa,bb,cc}
  h.node.step({ kind: 'linkUp', link: 21, dialed: true, to: 'sim:dd' })
  h.node.step({ kind: 'bytesIn', link: 21, bytes: encodeControl(VERB.HELLO, { u: 'dd', i: 2, l: 'sim:dd' }) })
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[4, 4]], 'the same members at 4: past my own hold at 3, where my vote is aa\'s')
  const p = h.sentOn(h.link.cc, VERB.PROPOSE).pop()!.value as { e: number; o: number; j?: string[] }
  assert.deepEqual([p.e, p.o, p.j], [4, 2, ['aa,bb,cc']], 'over view 2, joint over the held view')
  //! cc, dd and ee grant: old {bb,cc,dd,ee} 4 of 4, new the same, {aa,bb,cc} bb and cc 2 of 3 — committed, held no more
  for (const l of [h.link.cc, 21, h.link.ee]) h.node.step({ kind: 'bytesIn', link: l, bytes: encodeControl(VERB.VOTE, { e: 4, g: 1, ce: 2, h: 'bb,cc,dd,ee' }) })
  assert.equal(h.node.epoch, 4, 'superseded by the held view\'s own majority: bb and cc')
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' })
  assert.deepEqual(h.node.membership.holds(h.node), [], 'the vote at 3 is history at view 4')
})

test('the opener\'s two older guards, each with EVERY member of my view linked (the sixth review\'s minor: the every-member guard masked their pins): a held view whose majority is outside my view — cc\'s ask names {aa,cc,ee}@3 at view 2 = {bb,cc,dd} with aa and ee unlinked — opens nothing (a ballot that cannot commit would burn an epoch per proposal age, re-opened at every age-out); a hold on my OWN dropped ballot, all five linked, is disowned (one NACK) and opens nothing', () => {
  //! guard one: the held view's majority must be linked. bb at view 2 = {bb,cc,dd}, every member linked, aa and ee cut
  const h = fiveAt1('bb')
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.VIEW, { e: 2, m: mem(['bb', 'cc', 'dd']) }) })
  h.node.step({ kind: 'linkDown', link: h.link.aa, reason: 'cut' }); h.node.step({ kind: 'linkDown', link: h.link.ee, reason: 'cut' })
  h.node.step({ kind: 'bytesIn', link: h.link.cc, bytes: encodeControl(VERB.PULL, { e: 2, vs: [{ e: 3, h: 'aa,cc,ee', p: 'aa' }] }) })
  assert.deepEqual(h.node.membership.gate(h.node), { open: true, reason: '' }, 'bb and dd: two of three without the held cc')
  for (let i = 0; i < 3; i++) h.tick()
  assert.deepEqual(h.jk(JK.propose), [], 'cc alone is one of {aa,cc,ee}: a ballot joint over it could never commit, so none opens')
  //! guard two: never for a hold whose proposer is me. aa at view 1 of five, all linked, bb's ask names aa's own dropped
  // ballot at 2 — the disown answers it, and nothing opens
  const a = fiveAt1('aa')
  a.node.step({ kind: 'bytesIn', link: a.link.bb, bytes: encodeControl(VERB.PULL, { e: 1, vs: [{ e: 2, h: 'aa,bb,cc', p: 'aa' }] }) })
  assert.equal(a.sentOn(a.link.bb, VERB.NACK).length, 1, 'the disown')
  assert.deepEqual(a.node.membership.gate(a.node), { open: true, reason: '' }, 'aa, cc, dd and ee: four of five without the held bb')
  for (let i = 0; i < 3; i++) a.tick()
  assert.deepEqual(a.jk(JK.propose), [], 'mine to disown, not to supersede — with every member linked too')
})

//! ── THE EVICTION RIDES WITH THE LEAVE (wave 6b, 2026-10-12; DESIGN-LEAVE §10.7's note). A cluster on a bare majority —
// three members with one crashed and not yet voted out — and a second member stops. The lowest stayer's leave ballot
// kept the dead member in its new set, so it needed the dead member's vote and could never commit; it aged out, and the
// leaver's next knock, landing between ticks, reopened it before the tick's eviction branch ran: the dead member was
// never evicted while the leaver knocked, and the leaver went unclean at the window's end (the base: `left` b=0 at
// 200/800/3200 ms for a 4/16/64-tick window on the sim). Now a leave ballot the live members cannot carry leaves out
// every suspect whose chain gave up as well (#leaveView): one ballot, one round trip. ──
//! cc, a member of {aa,bb,cc}, is lost for good: its link dies, three ticks make it a suspect, and its redial chain is
// exhausted (every pending redial fired and refused) so it is dead to the ballot. No tick after the give-up: the
// heartbeat's give-up revival would re-arm the chain (V4-20), and the shape under test is the knock landing BETWEEN ticks.
const ccGone = (h: ReturnType<typeof harness>) => {
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  for (let i = 0; i < 3; i++) h.tick()
  assert.deepEqual(h.jk(JK.suspect).map((e) => e.a), ['cc'])
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  assert.ok(!h.node.dialing('sim:cc'), 'the chain gave up: cc is dead to a ballot')
}

test('the eviction rides with the leave (2026-10-12): a LEAVE knock at {aa,bb,cc} with cc given up proposes {aa}@2 — the leaver AND the dead member out — the leaver\'s grant commits it in one round trip, where the base proposed {aa,cc}@2, which needed cc\'s vote, and knocked for the whole window', () => {
  const h = formedView1()
  ccGone(h)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(proposed(h, 1, 2), [['aa']], 'without bb (leaving) and without cc (dead): the plain {aa,cc} could not be carried')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa' }) })
  assert.equal(h.node.epoch, 2, 'aa + bb: a majority of the old set; aa alone the new')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa'])
  assert.deepEqual(h.jk(JK.evict).map((e) => e.a), ['bb', 'cc'])
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 1]], 'genesis and one ballot — no doomed one')
  assert.ok(h.sentOn(1, VERB.VIEW).some((f) => (f.value as { e: number }).e === 2), 'the VIEW to bb is its exit proof')
  //! the same knock when the plain ballot CAN be carried — cc merely slow (not a suspect) — is byte-identical with before
  const k = formedView1()
  k.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(proposed(k, 1, 2), [['aa', 'cc']], 'one apart, as today')
})

test('the eviction rides with the leave: a leave ballot in flight is re-read when the suspect\'s chain gives up — bb knocks while cc is a suspect still dialing (the plain {aa,cc}@2 opens, as before), the chain gives up, and the next tick re-proposes {aa}@2 at the same epoch; a late grant for the dropped ballot counts for nothing (its identity differs). The base kept the doomed ballot until it aged out, and the next knock reopened it', () => {
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  for (let i = 0; i < 3; i++) h.tick()
  assert.ok(h.node.dialing('sim:cc'), 'a suspect, but the chain is still trying: its vote may still come')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(proposed(h, 1, 2), [['aa', 'cc']], 'the plain leave, as today')
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  assert.ok(!h.node.dialing('sim:cc'))
  h.tick()
  assert.deepEqual(proposed(h, 1, 2), [['aa', 'cc'], ['aa']], 're-read: cc leaves the ballot too, at the same epoch (my own vote at 2 is re-spent on me)')
  //! THE DROP IS STICKY (the first review of wave 6b): that same tick's give-up revival re-armed cc's chain, so cc reads as
  // dialing again — not dead. The next tick's re-read starts from the ballot in flight and puts nobody back; before it
  // read the view, proposed {aa,cc}@2 again, and bb's grant for {aa} — the vote in flight — counted for nothing
  assert.ok(h.node.dialing('sim:cc'), 'the revival re-armed the chain in the same heartbeat step')
  assert.deepEqual(h.jk(JK.revive).map((e) => e.a), ['sim:cc'])
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 2], [2, 1]], 'sticky: no new ballot — the one in flight is not re-read from the view (before: {aa,cc}@2 a third time, the vote in flight discarded)')
  assert.equal(h.node.membership.votedFor.h, 'aa', 'my vote still stands on {aa}')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,cc' }) })
  assert.equal(h.node.epoch, 1, 'bb\'s grant for the dropped ballot is not counted')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa' }) })
  assert.equal(h.node.epoch, 2, 'its grant for the re-read ballot commits it — two ticks after the drop, the round trip longer than a heartbeat')
  assert.deepEqual(h.jk(JK.evict).map((e) => e.a), ['bb', 'cc'])
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 2], [2, 1]], 'nothing more: the ballot is not re-read once it committed')
})

test('the eviction rides with the leave, the lowest leaver: aa leaves at {aa,bb,cc} with cc given up — its own exit ballot is {bb}@2 (the base proposed {bb,cc}@2, which needed cc\'s vote), bb\'s grant commits it and bb\'s echo is the exit proof; an eviction already in flight is replaced by it (leaving outranks, as before, and the exit carries the eviction); with no live majority nothing changes', () => {
  //! (i) the knock itself
  const h = formedView1()
  ccGone(h)
  h.node.step({ kind: 'leave' })
  assert.deepEqual(proposed(h, 1, 2), [['bb']], 'my exit without the dead member')
  //! the drop is sticky (the first review of wave 6b): two heartbeats pass before bb's vote lands — the first tick's
  // revival re-arms cc's chain (dialing again), and the second tick's knock re-reads my exit from ITSELF, keeping {bb};
  // before, it re-read the view, saw cc dialing, and replaced {bb}@2 with {bb,cc}@2, which needed cc's vote
  h.tick()
  assert.ok(h.node.dialing('sim:cc'), 'the revival re-armed the chain')
  h.tick()
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 1]], 'sticky: no new ballot — my exit in flight is not re-read from the view (before: {bb,cc}@2)')
  assert.equal(h.node.membership.votedFor.h, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'bb' }) })
  assert.equal(h.node.epoch, 2)
  assert.equal(h.of('left').length, 0, 'the echo is awaited')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['bb', 'sim:bb']] }) })
  assert.deepEqual(h.of('left'), [['left', true]], 'clean: bb echoed the view without aa')
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 1]])
  //! (ii) the eviction is in flight when the leave begins: my exit replaces it and carries it — and keeps carrying it
  // across the ticks that follow (the tick's re-read starts from the exit in flight, where before it read the view and
  // put the evictee back one tick later)
  const k = formedView1()
  ccGone(k)
  k.tick()
  assert.deepEqual(proposed(k, 1, 2), [['aa', 'bb']], 'the tick opened the eviction')
  assert.ok(k.node.dialing('sim:cc'), 'and its revival re-armed cc\'s chain')
  k.node.step({ kind: 'leave' })
  assert.deepEqual(proposed(k, 1, 2), [['aa', 'bb'], ['bb']], 'replaced at the same epoch by my exit, cc out with me')
  k.tick(); k.tick()
  assert.deepEqual(k.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 2], [2, 1]], 'sticky: the evictee stays out across the ticks, no new ballot (before: {bb,cc}@2 one tick later)')
  assert.equal(k.node.membership.votedFor.h, 'bb')
  k.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'bb' }) })
  assert.equal(k.node.epoch, 2)
  //! (iii) the guard: bb AND cc lost for good (both suspects, both chains given up) — the live set {aa} is no majority, so
  // nobody is dropped (nothing could commit either way), and the exit ballot {bb,cc}@2 is proposed as before; nobody is
  // linked, so the bound ends it
  const g = formedView1()
  g.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  g.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  for (let i = 0; i < 3; i++) g.tick()
  assert.deepEqual(g.jk(JK.suspect).map((e) => e.a).sort(), ['bb', 'cc'])
  for (let i = 0; i < 11; i++) {
    for (const t of g.of('timer').filter((x) => x[2] === TAG.redial)) g.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial }) // every pending redial (a fired id is ignored)
    g.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:bb' })
    g.node.step({ kind: 'linkDown', link: 850 + i, reason: 'refused', to: 'sim:cc' })
  }
  assert.ok(!g.node.dialing('sim:bb') && !g.node.dialing('sim:cc'), 'both chains gave up')
  g.node.step({ kind: 'leave' })
  assert.deepEqual(g.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 2]])
  assert.equal(g.node.membership.votedFor.h, 'bb,cc', 'my exit, as today: a ballot nobody can carry drops nobody')
  for (let i = 0; i <= LEAVE_TICKS; i++) g.tick()
  assert.deepEqual(g.of('left'), [['left', false]])
})

test('a knock from a member my view no longer holds is answered with the VIEW (wave 6b, 2026-10-12): bb left and aa installed {aa,cc}@2, but bb never saw the VIEW and knocks on — aa ships view 2 on bb\'s link and proposes nothing; on bb\'s side the VIEW without it is the exit proof', () => {
  const h = formedView1()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(proposed(h, 1, 2), [['aa', 'cc']])
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,cc' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,cc' }) })
  assert.equal(h.node.epoch, 2, 'bb (the old set) and cc (the new) voted')
  const views = () => h.sentOn(1, VERB.VIEW).filter((f) => (f.value as { e: number }).e === 2).length
  assert.equal(views(), 1, 'the install flooded view 2 to bb once (lost, in this story)')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.equal(views(), 2, 'bb knocked again: answered with the view it is missing')
  assert.deepEqual(h.jk(JK.propose).map((e) => [e.a, e.b]), [[1, 3], [2, 2]], 'no new ballot: bb is out already')
  //! bb\'s seat: still at view 1, knocking; the VIEW without it is the exit proof (onView), as for the flood
  const k = knockingPair()
  k.node.step({ kind: 'leave' })
  k.tick(); k.tick()
  k.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa']] }) })
  assert.deepEqual(k.of('left'), [['left', true]])
})
