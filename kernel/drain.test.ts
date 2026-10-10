//! Tier-1 drain-then-go suite (DESIGN-SCALE §7 stage 1 (b), 2026-10-10): a SCOPED leaver, once the view without
// it has committed and echoed, holds the `left` effect until the new holders of what it held have proved they
// hold it, bounded by tune.drainTicks. The kernel driven by hand-crafted frames against a recording sink (the
// membership.test.ts / scoped.test.ts idiom).
//
// "Drained" is the shed bar: every REACHABLE current holder of an orphaned partition has attested, in a HAVEA ok
// (or a HAVEQ announcement), floors at or above the orphan's frozen content tails on every lane (kernel/scope.ts
// undrained — evaluateSheds' quantifier narrowed to holders with a live link). When every holder covers, the
// partition sheds and leaves the count by construction, so the ordinary story is orphaned → (teach) → shed → left.
// Past the bound, or with nobody to drain to (no reachable holder; the solo view), the leaver goes at once with an
// `undrained` row (a = partitions) and `left` b=0. Unscoped leavers never enter any of this (the last test).

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { DRAIN_TICKS, LEAVE_TICKS } from './membership.ts'
import { JK } from './journal.ts'
import { SCOPE } from './scope.ts'
import { Framer, VERB, encodeControl, encodeRuns } from './codec.ts'
import { REC, TAG, type EffectSink, type Env, type Rec } from './env.ts'

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
  const sentOn = (link: number, verb: number) =>
    of('send').filter((e) => e[1] === link)
      .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
      .filter((f) => f.verb === verb)
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  const bytes = (link: number, b: Uint8Array) => node.step({ kind: 'bytesIn', link, bytes: b })
  return { node, effects, of, tick, jk, sentOn, admit, bytes }
}

const rec = (key: string[], value: unknown): Rec => ({ type: REC.update, key, value })
const frame = (origin: string, rows: { seq: number; rec: Rec; pp?: number }[], epoch = 1): Uint8Array => {
  const out = encodeRuns(rows.map((r) => ({ rec: r.rec, origin, seq: r.seq, epoch, pp: r.pp })), VERB.RECORDS, rows.some((r) => r.pp !== undefined))
  assert.equal(out.length, 1)
  return out[0]
}
const havea = (e: number, a: Record<string, { ok: number; need: number; m?: Record<string, number> }>) => encodeControl(VERB.HAVEA, { e, a })
const view = (e: number, ...us: string[]) => encodeControl(VERB.VIEW, { e, m: us.map((u) => [u, `sim:${u}`]) })
const vote = (e: number, ...us: string[]) => encodeControl(VERB.VOTE, { e, g: 1, ce: e - 1, h: us.join(',') })
const ALL: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]

//! an ARMED aa at committed view 1 over {aa, bb, cc}, replicas 1, holding partition `p` with one record on lane bb
// (seq 5) — placed on aa by the test pin, then re-pinned to bb so that the view WITHOUT aa makes bb its holder.
// aa is the lowest live member: its leave proposes the shrunk view itself (the V4-6 proposer leg).
const holderAtView1 = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const h = harness('aa', { replicas: 1, boot: { epoch: 1, members: ALL }, ...opts })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.bytes(1, view(1, 'aa', 'bb', 'cc')) // a live peer confirms the restored view: the rejoin floor clears
  assert.equal(h.node.armed, true)
  h.node.writes.ring.place('p', 'aa')
  h.bytes(1, frame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1), pp: 0 }]))
  assert.equal(h.node.scope!.held('p'), true, 'aa holds p (first-ever record to its lawful holder mints held)')
  h.node.writes.ring.place('p', 'bb')
  return h
}
//! the leave up to the exit proof: aa proposes {bb, cc} at 2, both survivors vote, the view installs (p freezes into
// an orphan whose current holder is bb), and bb's VIEW echo is the proof. Returns after the echo.
const leaveToEcho = (h: ReturnType<typeof holderAtView1>) => {
  h.node.step({ kind: 'leave' })
  h.bytes(1, vote(2, 'bb', 'cc'))
  h.bytes(2, vote(2, 'bb', 'cc'))
  assert.equal(h.node.epoch, 2, 'the view without aa committed')
  assert.equal(h.node.scope!.entries.get('p')?.state, SCOPE.orphan, 'p froze into an orphan at the install')
  assert.deepEqual([...h.node.writes.ring.holders('p', 1)], ['bb'], 'its current holder is bb')
  assert.equal(h.of('left').length, 0, 'not gone: no echo yet')
  h.bytes(1, view(2, 'bb', 'cc'))
}

test('DRAIN — the exit proof no longer ends a scoped leave: `left` is held while the new holder has not proved it holds p; the teach runs as for any orphan; the shed ends the wait with left(true) and no undrained row', () => {
  const h = holderAtView1()
  leaveToEcho(h)
  //! the proof arrived, but p is undrained: the leave is in its second wait
  assert.equal(h.of('left').length, 0, 'the echo alone does not let a scoped leaver go')
  assert.equal(h.jk(JK.left).length, 0)
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, done: true, drain: 0, clean: true }, 'the view half is done (and was clean); the drain counts from 0')
  assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 1, stranded: 0 })
  //! the install's round asked bb; bb (absent and assigned) answers need — aa teaches p exactly as any orphan would
  assert.equal(h.sentOn(1, VERB.HAVEQ).length, 1, 'the install round announced p to its new holder')
  h.bytes(1, havea(2, { p: { ok: 0, need: 1, m: {} } }))
  assert.equal(h.sentOn(1, VERB.ACQ).length, 1, 'the one-teacher delta shipped')
  assert.equal(h.sentOn(1, VERB.ACQDONE).length, 1)
  assert.equal(h.of('left').length, 0, 'teaching is not proof: bb has attested nothing yet')
  //! bb's attestation at aa's frozen tail (bb:5) is the shed bar — and the drain's: shed, then left(true), in one step
  h.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.jk(JK.shed).length, 1, 'every current holder covers ⇒ shed')
  assert.deepEqual(h.of('left'), [['left', true]], 'and the shed ends the drain the instant it lands')
  const rows = h.node.journal.read().filter((e) => e.kind === JK.shed || e.kind === JK.left || e.kind === JK.undrained).map((e) => e.kind)
  assert.deepEqual(rows, [JK.shed, JK.left], 'the journal reads shed → left; no undrained row')
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[2, 1]])
  assert.equal(h.node.membership.leaving!.drain, undefined, 'the drain is over')
  //! once: later ticks and marks change nothing
  h.tick(); h.tick()
  h.bytes(2, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.of('left').length, 1)
})

test('DRAIN waits for the RIGHT event: a holder\'s ok answer whose floors sit BELOW the frozen tail is not cover — the leaver keeps waiting (no shed, no left) until an answer reaches the tail; with two lanes, one covered lane does not drain the partition', () => {
  //! the bar is the content tail, not "any ok answer": under the pp law a holder's floors lawfully under-claim
  // (M6 findings 12/21), so an ok at bb:4 against a frozen tail of bb:5 proves bb holds LESS than aa did.
  // Mutation: make `covers` (kernel/scope.ts) return true for any non-empty mark set and this test goes red.
  const h = holderAtView1()
  leaveToEcho(h)
  h.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 4 } } }))
  assert.equal(h.jk(JK.shed).length, 0, 'bb:4 < the frozen tail bb:5: not covered, not shed')
  assert.equal(h.of('left').length, 0, 'an ok answer below the tail does not end the drain')
  assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 1, stranded: 0 }, 'still waiting on bb')
  h.tick()
  assert.equal(h.of('left').length, 0, 'the tick re-checks the same bar: still waiting')
  h.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.jk(JK.shed).length, 1, 'bb:5 reaches the tail: covered, shed')
  assert.deepEqual(h.of('left'), [['left', true]], 'and the drain ends on that answer')
  assert.equal(h.jk(JK.undrained).length, 0)
  //! two lanes: aa's frozen tails are bb:5 AND cc:3; bb covering one lane is not cover
  const t = holderAtView1()
  t.bytes(2, frame('cc', [{ seq: 3, rec: rec(['p', 'y'], 2), pp: 0 }]))
  leaveToEcho(t)
  assert.deepEqual(t.node.scope!.entries.get('p')?.tails, { bb: 5, cc: 3 }, 'two lanes frozen at the install')
  t.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(t.of('left').length, 0, 'lane bb covered, lane cc not: the partition is not drained')
  assert.deepEqual(t.node.scope!.undrained(t.node), { waiting: 1, stranded: 0 })
  t.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5, cc: 2 } } }))
  assert.equal(t.of('left').length, 0, 'cc:2 < cc:3: still not drained')
  t.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { cc: 3 } } }))
  assert.deepEqual(t.of('left'), [['left', true]], 'marks are per lane and monotone: bb:5 from before + cc:3 now cover both lanes')
  assert.equal(t.jk(JK.shed).length, 1)
})

test('DRAIN, the bound: a holder that never attests holds the leaver for exactly drainTicks ticks, then it goes with `undrained` 1 and left(false) — the leave\'s own bound (leaveTicks) never fires during the drain', () => {
  const h = holderAtView1({ tune: { drainTicks: 6 } })
  leaveToEcho(h)
  assert.ok(LEAVE_TICKS < 6, 'the test needs the drain bound past the leave bound to show the latter is silent')
  for (let i = 0; i < 6; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `tick ${i + 1}: still draining`)
    assert.equal(h.node.membership.leaving!.drain, i + 1)
  }
  assert.ok(h.sentOn(1, VERB.HAVEQ).length >= 3, 'the orphan kept polling its holder while waiting (the shed poll cadence)')
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'past the bound: it goes, and says the stop was not clean')
  assert.deepEqual(h.jk(JK.undrained).map((e) => [e.a, e.b]), [[1, 2]], 'one partition went with it, at epoch 2')
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[2, 0]])
  assert.equal(h.node.scope!.entries.get('p')?.state, SCOPE.orphan, 'the data is still here for the teardown to take (or the dir to keep)')
  //! the default bound is the record's 16
  assert.equal(DRAIN_TICKS, 16)
  const d = holderAtView1()
  leaveToEcho(d)
  for (let i = 0; i < DRAIN_TICKS; i++) d.tick()
  assert.equal(d.of('left').length, 0)
  d.tick()
  assert.deepEqual(d.of('left'), [['left', false]])
})

test('DRAIN never follows a vote that did not come back: a scoped leaver whose shrunk view never commits goes at leaveTicks + 1 with left(false), no drain, no `undrained` row — it still holds p (nothing froze), and the survivors evict it the slow way', () => {
  //! the ballot is proposed but nobody votes: the leave's own bound (V4-6) ends it, clean=false. The drain is the
  // SECOND wait of a leave whose first wait succeeded; a leaver going like a crash does not drain (there is no
  // orphan: p is still held, no install re-ranged it) and counts nothing undrained — `undrained` counts only the
  // drain window. Mutation: drop `clean &&` in #finishLeave and this leaver holds instead of going.
  const h = holderAtView1()
  h.node.step({ kind: 'leave' })
  for (let i = 0; i < LEAVE_TICKS; i++) {
    h.tick()
    assert.equal(h.of('left').length, 0, `tick ${i + 1}: knocking`)
  }
  h.tick()
  assert.deepEqual(h.of('left'), [['left', false]], 'leaveTicks + 1: it goes like a crash')
  assert.equal(h.node.epoch, 1, 'the view never changed')
  assert.equal(h.node.scope!.entries.get('p')?.state, SCOPE.held, 'p is still held: no install froze it into an orphan')
  assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, done: true, drain: undefined }, 'no drain was entered')
  assert.equal(h.jk(JK.undrained).length, 0, 'nothing counted undrained: the count covers the drain window only')
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[1, 0]])
  //! a late vote changes nothing: the leave is over
  h.bytes(1, vote(2, 'bb', 'cc'))
  h.bytes(2, vote(2, 'bb', 'cc'))
  h.tick()
  assert.equal(h.of('left').length, 1)
})

test('DRAIN after a timed-out view half: the votes came back and the leaver installed its own shrunk view, but no survivor echo arrived inside leaveTicks — p is an orphan with a reachable new holder all the same, so it drains; the verdict stays false (the view half was never proved) and `undrained` counts what was not copied', () => {
  //! the shape (third review, 2026-10-10): aa is the proposer; bb and cc vote; aa commits epoch 2 itself (p
  // freezes into an orphan whose holder is bb); the VIEW echo is lost. Before the fix #finishLeave(false) skipped
  // the drain: at R=1 the only copy of p went with aa, uncounted, while bb had a live link. Mutation: make
  // #finishLeave ask #exit only when clean and this leaver goes at leaveTicks + 1 with left(false) and no row.
  const timedOut = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
    const h = holderAtView1(opts)
    h.node.step({ kind: 'leave' })
    h.bytes(1, vote(2, 'bb', 'cc'))
    h.bytes(2, vote(2, 'bb', 'cc'))
    assert.equal(h.node.epoch, 2, 'the proposer commits from the votes alone')
    assert.equal(h.node.membership.isMember('aa'), false, 'its own view no longer holds it')
    assert.equal(h.node.scope!.entries.get('p')?.state, SCOPE.orphan, 'p froze into an orphan at the install')
    for (let i = 0; i < LEAVE_TICKS; i++) { h.tick(); assert.equal(h.of('left').length, 0, `tick ${i + 1}: waiting for the echo`) }
    h.tick() // leaveTicks + 1: the view half times out
    assert.equal(h.of('left').length, 0, 'not gone: bb is reachable and has not proved it holds p — the drain begins')
    assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 1, stranded: 0 })
    assert.deepEqual(h.node.membership.leaving, { ticks: LEAVE_TICKS + 1, done: true, drain: 0, clean: false }, 'the drain carries the view half\'s verdict')
    return h
  }
  //! (a) bb attests at the frozen tail: shed, then left(false) — copied, but the stop was not clean all the way
  const h = timedOut()
  h.bytes(1, view(2, 'bb', 'cc'))
  assert.equal(h.of('left').length, 0, 'a late echo neither ends the drain nor re-opens the view half')
  h.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.jk(JK.shed).length, 1, 'bb covers ⇒ shed')
  assert.deepEqual(h.of('left'), [['left', false]], 'the rows were handed over, but the view half was never proved: not clean')
  assert.equal(h.jk(JK.undrained).length, 0, 'nothing went with it: no undrained row')
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[2, 0]])
  h.tick(); h.tick()
  assert.equal(h.of('left').length, 1, 'once')
  //! (b) nobody attests: the drain bound, then `undrained` 1 and left(false) — the count now names the lost copy
  const d = timedOut({ tune: { drainTicks: 6 } })
  for (let i = 0; i < 6; i++) { d.tick(); assert.equal(d.of('left').length, 0, `drain tick ${i + 1}`) }
  d.tick()
  assert.deepEqual(d.of('left'), [['left', false]])
  assert.deepEqual(d.jk(JK.undrained).map((e) => [e.a, e.b]), [[1, 2]], 'one partition went with it, at epoch 2')
  //! (c) nobody to drain to: bb's link is down when the view half times out ⇒ at once, `undrained` 1
  const s = holderAtView1()
  s.node.step({ kind: 'leave' })
  s.bytes(1, vote(2, 'bb', 'cc'))
  s.bytes(2, vote(2, 'bb', 'cc'))
  s.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  for (let i = 0; i <= LEAVE_TICKS; i++) s.tick()
  assert.deepEqual(s.of('left'), [['left', false]])
  assert.deepEqual(s.jk(JK.undrained).map((e) => [e.a, e.b]), [[1, 2]], 'stranded: counted at once, no hold')
  assert.equal(s.node.membership.leaving!.drain, undefined)
})

test('DRAIN, nobody to drain to: the new holder\'s link is down at the proof ⇒ left(false) at once with `undrained` 1; a holder that dies DURING the drain ends it at the next tick the same way', () => {
  //! (a) dead before the echo: cc still stays, its echo is the proof — but p's only holder, bb, is unreachable
  const h = holderAtView1()
  h.node.step({ kind: 'leave' })
  h.bytes(1, vote(2, 'bb', 'cc'))
  h.bytes(2, vote(2, 'bb', 'cc'))
  assert.equal(h.node.epoch, 2)
  h.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 0, stranded: 1 }, 'p has content and no reachable holder')
  h.bytes(2, view(2, 'bb', 'cc'))
  assert.deepEqual(h.of('left'), [['left', false]], 'at once: waiting for nobody is not a drain')
  assert.deepEqual(h.jk(JK.undrained).map((e) => [e.a, e.b]), [[1, 2]])
  assert.equal(h.node.membership.leaving!.drain, undefined, 'never entered the drain')
  //! (b) dies mid-drain: the hold was lawful while bb could still answer; its death leaves nothing to wait for
  const m = holderAtView1()
  leaveToEcho(m)
  m.tick()
  assert.equal(m.of('left').length, 0, 'draining')
  m.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  assert.equal(m.of('left').length, 0, 'a link loss is not a tick: the re-check rides the clock')
  m.tick()
  assert.deepEqual(m.of('left'), [['left', false]])
  assert.deepEqual(m.jk(JK.undrained).map((e) => e.a), [1])
})

test('DRAIN, R=2 with one holder behind: the drain waits for EVERY reachable holder; the unreachable one is not waited for; the shed needs all of them but the drain ends when the reachable set covers', () => {
  //! replicas 2: after the leave p's holders are {bb, cc}. bb attests; cc never does — but cc is reachable, so the drain
  // waits for cc; once cc's link dies the reachable set (bb) covers and the drain ends — left(true): nothing reachable
  // is behind, nothing is stranded (bb holds it). The orphan itself stays (the shed still wants cc) — the teardown takes it.
  const h = harness('aa', { replicas: 2, boot: { epoch: 1, members: ALL } })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.bytes(1, view(1, 'aa', 'bb', 'cc'))
  h.node.writes.ring.place('p', 'aa', 'bb')
  h.bytes(1, frame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1), pp: 0 }]))
  assert.equal(h.node.scope!.held('p'), true)
  h.node.writes.ring.place('p', 'bb', 'cc')
  h.node.step({ kind: 'leave' })
  h.bytes(1, vote(2, 'bb', 'cc'))
  h.bytes(2, vote(2, 'bb', 'cc'))
  assert.deepEqual([...h.node.writes.ring.holders('p', 2)], ['bb', 'cc'])
  h.bytes(1, view(2, 'bb', 'cc'))
  assert.equal(h.of('left').length, 0, 'draining: two holders, neither has attested')
  h.bytes(1, havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.of('left').length, 0, 'bb covers; cc is reachable and has not — still draining')
  assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 1, stranded: 0 })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'test' })
  assert.deepEqual(h.node.scope!.undrained(h.node), { waiting: 0, stranded: 0 }, 'the reachable holders cover: drained')
  h.tick()
  assert.deepEqual(h.of('left'), [['left', true]])
  assert.equal(h.jk(JK.undrained).length, 0)
  assert.equal(h.jk(JK.shed).length, 0, 'the shed itself still wants every holder (cc): the orphan is kept, the teardown takes it')
})

test('DRAIN, the solo view: the last scoped member has nobody to drain to — with content it goes left(false) + `undrained` = its partitions; without content left(true); an UNSCOPED last member is byte-identical to before (left(true), no undrained row)', () => {
  //! a scoped solo at a restored one-member view: the self-ballot commits epoch 6; a write of its own holds `q`
  const solo = (replicas: number | undefined, write: boolean) => {
    const h = harness('aa', { ...(replicas !== undefined ? { replicas } : {}), boot: { epoch: 5, members: [['aa', 'sim:aa']] } })
    h.node.step({ kind: 'start' })
    for (let i = 0; i < 10; i++) h.tick()
    assert.equal(h.node.epoch, 6, 'the solo self-ballot committed')
    if (write) {
      h.node.step({ kind: 'write', recs: [rec(['q'], 1), rec(['r'], 2)] })
      assert.equal(h.node.state.size, 2, 'committed: one of one is a majority')
    }
    h.node.step({ kind: 'leave' })
    return h
  }
  const s = solo(1, true)
  assert.deepEqual(s.of('left'), [['left', false]], 'the rows go with it: not a clean stop')
  assert.deepEqual(s.jk(JK.undrained).map((e) => [e.a, e.b]), [[2, 6]], 'two partitions (q, r) undrained at epoch 6')
  assert.deepEqual(s.jk(JK.left).map((e) => [e.a, e.b]), [[6, 0]])
  const e = solo(1, false)
  assert.deepEqual(e.of('left'), [['left', true]], 'nothing held ⇒ nothing to drain ⇒ clean')
  assert.equal(e.jk(JK.undrained).length, 0)
  const u = solo(undefined, true)
  assert.deepEqual(u.of('left'), [['left', true]], 'unscoped: the last member simply goes, as V4-6 says')
  assert.equal(u.jk(JK.undrained).length, 0)
  assert.equal(u.jk(JK.left).length, 0, 'and journals nothing — the solo leave never did')
})

test('DRAIN, heartbeats off: there is no drain clock (the shed poll never runs either), so a scoped leaver decides at once from the evidence — undrained content ⇒ left(false) + `undrained`, never a hold that nothing could end', () => {
  const h = holderAtView1({ heartbeatMs: 0 })
  assert.equal(h.node.heartbeats, false)
  leaveToEcho(h)
  assert.deepEqual(h.of('left'), [['left', false]], 'at once: no tick will ever bound a hold')
  assert.deepEqual(h.jk(JK.undrained).map((e) => [e.a, e.b]), [[1, 2]])
  assert.equal(h.node.membership.leaving!.drain, undefined)
})

test('DRAIN, re-assignment mid-drain: a newer view the leaver hears (another member joins or leaves) re-ranges the holders — the drain waits for the NEW holder, and a stale attestation from the old one no longer counts', () => {
  const h = holderAtView1()
  leaveToEcho(h)
  assert.equal(h.of('left').length, 0)
  //! view 3 arrives: cc alone stays (bb left too). p's holder is now cc; bb's answer is void for the bar
  h.node.writes.ring.place('p', 'cc')
  h.bytes(2, view(3, 'cc'))
  assert.equal(h.node.epoch, 3, 'a non-member still installs newer views it is told (the flood reaches every admitted link)')
  assert.deepEqual([...h.node.writes.ring.holders('p', 1)], ['cc'])
  h.bytes(1, havea(3, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.equal(h.of('left').length, 0, 'bb is not a holder any more: its attestation does not drain p')
  h.bytes(2, havea(3, { p: { ok: 1, need: 0, m: { bb: 5 } } }))
  assert.deepEqual(h.of('left'), [['left', true]], 'cc covers ⇒ shed ⇒ left(true)')
  assert.equal(h.jk(JK.shed).length, 1)
})

test('UNSCOPED leaves never drain: the proposer leg and the knock leg report `left` at the echo exactly as before, `leaving` never gains a drain field, no undrained row, and the scope hook is unreachable', () => {
  const h = harness('aa', { boot: { epoch: 1, members: ALL } })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.bytes(1, view(1, 'aa', 'bb', 'cc'))
  h.bytes(1, frame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1) }]))
  assert.equal(h.node.scope, null)
  h.node.step({ kind: 'leave' })
  h.bytes(1, vote(2, 'bb', 'cc'))
  h.bytes(2, vote(2, 'bb', 'cc'))
  assert.equal(h.node.epoch, 2)
  assert.equal(h.of('left').length, 0)
  h.bytes(1, view(2, 'bb', 'cc'))
  assert.deepEqual(h.of('left'), [['left', true]], 'the echo IS the exit, as V4-6 says')
  assert.deepEqual(h.node.membership.leaving, { ticks: 0, done: true, drain: undefined })
  assert.equal(h.jk(JK.undrained).length, 0)
  assert.deepEqual(h.jk(JK.left).map((e) => [e.a, e.b]), [[2, 1]])
})
