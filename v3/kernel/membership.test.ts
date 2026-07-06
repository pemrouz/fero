//! Tier-1 membership suite: ballots, the write-gate, epoch staleness, boot modes — the kernel driven
// by hand-crafted frames against a recording sink, exactly like node.test.ts. Every safety property
// claimed in membership.ts's banner has a pin here; the sim scenarios (sim/membership.test.ts) then
// prove the same machinery end-to-end under partitions.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { MAX_PULLS, MAX_PENDING } from './membership.ts'
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
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  h.tick(); h.tick(); h.tick(); h.tick()
  assert.ok(h.jk(JK.propose).some((e) => e.a === 2), 'eviction ballot for epoch 2 is out')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb,zz' }) })
  assert.equal(h.node.epoch, 1, 'a grant echoing a different proposal identity must not commit')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 2, 'the correctly-echoed grant commits')
})

test('write-gate: minority buffers (bounded, surfaced); regaining majority flushes through the normal path at the current epoch', () => {
  const h = formedView1()
  //! sever both peers — 1 of 3 reachable is a minority: the gate closes
  h.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  const applies = h.of('apply').length
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['gated'], value: 1 }] })
  assert.equal(h.of('apply').length, applies, 'a gated write must not commit')
  assert.equal(h.node.state.size, 0)
  assert.equal(h.jk(JK.writeBuffered).length, 1)
  //! one peer returns → 2 of 3 is a majority → the next tick settles the gate open and flushes
  h.admit(3, 'bb')
  h.tick()
  assert.equal(h.node.state.size, 1, 'buffered write committed on gate-open')
  assert.equal(h.node.membership.pending.length, 0)
  const v = h.node.versions.get(JSON.stringify(['gated']))!
  assert.equal(v.epoch, 1, 'flushed writes stamp at the CURRENT epoch')
  assert.ok(h.jk(JK.gateClose).some((e) => e.a === 'minority'))
  assert.ok(h.jk(JK.gateOpen).length >= 1)
})

test('pending buffer is bounded drop-oldest with a surfaced counter', () => {
  const h = formedView1()
  h.node.step({ kind: 'linkDown', link: 1, reason: 'cut' })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  for (let i = 0; i <= MAX_PENDING; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(h.node.membership.pending.length, MAX_PENDING)
  assert.equal(h.node.membership.droppedPending, 1)
  assert.ok(h.jk(JK.writeBufferDrop).length === 1)
})

test('epoch-staleness: a higher-epoch record closes the gate and pulls the view ON THAT LINK; the VIEW reopens it', () => {
  const h = formedView1()
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
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  h.tick(); h.tick(); h.tick(); h.tick()
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
  for (let i = 0; i < 11; i++) {
    const t = h.of('timer').filter((x) => x[2] === TAG.redial).pop()
    if (t) h.node.step({ kind: 'timer', id: t[1] as number, tag: TAG.redial })
    h.node.step({ kind: 'linkDown', link: 800 + i, reason: 'refused', to: 'sim:cc' })
  }
  for (let i = 0; i < 16; i++) h.tick() // suspect → propose → ... no votes arrive → PROPOSAL_AGE expiry
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
