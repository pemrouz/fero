//! Tier-1 method-plane routing pins (M5c): the kernel ROUTES rpc frames and never runs handlers —
// CALL/SUB/UNSUB in → invoke effect; reply/subOut events → RESULT/SUBREC frames on the caller's
// link; rpc events → frames on the PRIMARY (or an immediate failed result when there is none);
// RESULT/SUBREC in → result/subRecs effects. Malformed frames journal + drop without severing the
// link (the method plane sits above the replication contract).

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { Framer, VERB, encodeControl } from './codec.ts'
import { type EffectSink, type Env } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (rec) => effects.push(['apply', rec]),
    persist: (batch, bytes, prev) => effects.push(['persist', batch, bytes, prev]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 0, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const sentOn = (link: number, verb: number) =>
    of('send').filter((e) => e[1] === link)
      .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
      .filter((f) => f.verb === verb)
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
  }
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  return { node, effects, of, sentOn, admit, jk }
}

test('a CALL frame surfaces as the invoke effect with the caller link; the reply event frames RESULT back on it', () => {
  const h = harness('aa')
  h.admit(1, 'zz')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.CALL, { id: 3, m: 'checkout', a: { qty: 2 } }) })
  assert.deepEqual(h.of('invoke')[0], ['invoke', 1, 3, VERB.CALL, 'checkout', { qty: 2 }])
  assert.equal(h.jk(JK.rpcIn).length, 1)
  //! the host answers — the kernel frames it down the same link
  h.node.step({ kind: 'reply', link: 1, id: 3, ok: true, value: { total: 42 } })
  const r = h.sentOn(1, VERB.RESULT)
  assert.equal(r.length, 1)
  assert.deepEqual(r[0].value, { id: 3, ok: 1, v: { total: 42 } })
  //! subOut streams a record batch the same way
  h.node.step({ kind: 'subOut', link: 1, id: 4, recs: [{ type: 'update', key: [], value: { a: 1 } } as never] })
  const sr = h.sentOn(1, VERB.SUBREC)
  assert.equal(sr.length, 1)
  assert.deepEqual(sr[0].value, { id: 4, recs: [{ type: 'update', key: [], value: { a: 1 } }] })
})

test('a CLIENT rpc event ships on the primary; with no primary it fails IMMEDIATELY as a local result', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  //! no primary yet: the failure is synchronous and typed — the api owns the retry policy
  h.node.step({ kind: 'rpc', id: 1, mode: VERB.CALL, m: 'x', a: 1 })
  assert.deepEqual(h.of('result')[0], ['result', 1, false, 'unreachable', true])
  assert.equal(h.jk(JK.rpcFail).length, 1)
  //! primary admitted: CALL/SUB/UNSUB frames flow to it
  h.admit(1, 'aa')
  h.node.step({ kind: 'rpc', id: 2, mode: VERB.CALL, m: 'checkout', a: 'x' })
  h.node.step({ kind: 'rpc', id: 3, mode: VERB.SUB, m: 'read', a: undefined })
  h.node.step({ kind: 'rpc', id: 3, mode: VERB.UNSUB })
  assert.deepEqual(h.sentOn(1, VERB.CALL)[0].value, { id: 2, m: 'checkout', a: 'x' })
  assert.deepEqual(h.sentOn(1, VERB.SUB)[0].value, { id: 3, m: 'read', a: undefined })
  assert.deepEqual(h.sentOn(1, VERB.UNSUB)[0].value, { id: 3 })
  //! RESULT and SUBREC arriving back surface as caller-side effects
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.RESULT, { id: 2, ok: 1, v: 'done' }) })
  assert.deepEqual(h.of('result')[1], ['result', 2, true, 'done', false])
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.SUBREC, { id: 3, recs: [{ type: 'update', key: ['k'], value: 5 }] }) })
  assert.deepEqual(h.of('subRecs')[0], ['subRecs', 3, [{ type: 'update', key: ['k'], value: 5 }]])
})

test('malformed rpc frames journal + drop WITHOUT severing the link; pre-admission rpc IS link-fatal', () => {
  const h = harness('aa')
  h.admit(1, 'zz')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.CALL, { m: 'no-id' }) })
  assert.equal(h.of('invoke').length, 0)
  assert.ok(h.jk(JK.frameDrop).some((e) => e.b === 'malformed rpc'))
  assert.equal(h.of('close').length, 0, 'the data link survives a bad call')
  //! identity-before-everything still holds: rpc before HELLO severs
  h.node.step({ kind: 'linkUp', link: 2, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.CALL, { id: 1, m: 'x' }) })
  assert.ok(h.of('close').some((e) => e[1] === 2))
})
