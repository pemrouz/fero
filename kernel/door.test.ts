//! Tier-1 door suite (docs/DESIGN-DOOR.md): the rules that run on an inbound HELLO before a link is
// admitted. This file grows with the door's commits; the discover.test.ts idiom (one node, links
// stepped by hand against the recording sink) so every row and every close is read, not inferred.
//
// Commit 1 — the role rule (§3 step 12), four ways:
//   r:1 against a committed-view member · r:1 against an admitted member link · a member against a
//   client squatting on its uuid · client against client (today's duplicate-link rule, untouched).
// The member's link is never touched and no dupLink row is written where the design says so.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { VERB, encodeControl } from './codec.ts'
import { JK } from './journal.ts'
import type { EffectSink, Env } from './env.ts'

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
  const node = new Node({ uuid, listen: `sim:${uuid}`, redialMs: 10, ...opts }, env)
  node.step({ kind: 'start' })
  const closes = () => effects.filter((e) => e[0] === 'close').map((e) => [e[1], e[2]])
  const rows = (kind: number) => node.journal.read().filter((e) => e.kind === kind).map((e) => [e.a, e.b, e.c])
  //! a peer connects to us and says hello — `r` rides only when given, as the kernel sends it
  const up = (link: number, dialed = false, to?: string) => node.step({ kind: 'linkUp', link, dialed, to })
  const hello = (link: number, u: string, r?: number) =>
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: r === 1 ? '' : `sim:${u}`, ...(r !== undefined ? { r } : {}) }) })
  return { node, effects, closes, rows, up, hello }
}

test('role rule 1/4: a CLIENT HELLO claiming a committed-view member\'s uuid is refused uuid-taken — nothing else moves', () => {
  const { node, closes, rows, up, hello } = harness('aa', { boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] } })
  up(1)
  hello(1, 'bb', 1)
  assert.deepEqual(closes(), [[1, 'uuid-taken']], 'the client link closes with the door\'s reason')
  assert.deepEqual(rows(JK.doorReject), [[1, 'uuid-taken', 'bb']], 'a = the refused link, b = the reason, c = the uuid it claimed')
  assert.deepEqual(rows(JK.dupLink), [], 'no duplicate-link row: the rule ran before that check')
  assert.deepEqual(rows(JK.identified), [], 'never admitted')
  assert.equal(node.byUuid.has('bb'), false, 'byUuid untouched')
  assert.equal(node.clientLinks.size, 0)
  const l = node.links.get(1)!
  assert.ok(l.dead && l.noRedial, 'dead + noRedial: a deliberate close, never a redial')
})

test('role rule 2/4: a CLIENT HELLO claiming the uuid of an ADMITTED member link is refused — the member\'s link is not touched', () => {
  const { node, closes, rows, up, hello } = harness('aa')
  up(1, true, 'sim:bb')
  hello(1, 'bb')
  assert.deepEqual(node.admitted(), ['bb'], 'the member is admitted on link 1')
  up(2)
  hello(2, 'bb', 1)
  assert.deepEqual(closes(), [[2, 'uuid-taken']], 'only the client link closes')
  assert.deepEqual(rows(JK.doorReject), [[2, 'uuid-taken', 'bb']])
  assert.deepEqual(rows(JK.dupLink), [], 'no dupLink row against the real member')
  const member = node.links.get(1)!
  assert.equal(member.dead, false, 'the member\'s link is alive')
  assert.equal(node.byUuid.get('bb'), 1, 'byUuid still names the member\'s link')
  assert.deepEqual(node.admitted(), ['bb'])
  assert.equal(node.clientLinks.size, 0, 'the squatter never entered clientLinks')
})

test('role rule 3/4: a MEMBER HELLO whose uuid a CLIENT link squats on evicts the client link and is admitted — the row names the client\'s link', () => {
  const { node, closes, rows, up, hello } = harness('aa')
  up(1)
  hello(1, 'bb', 1)
  assert.equal(node.clientLinks.size, 1, 'the client was admitted first (it connected first)')
  assert.equal(node.byUuid.get('bb'), 1)
  up(2)
  hello(2, 'bb')
  assert.deepEqual(closes(), [[1, 'uuid-taken']], 'the squatting client link closes; the member\'s does not')
  assert.deepEqual(rows(JK.doorReject), [[1, 'uuid-taken', 'bb']], 'a = the CLIENT\'s link id')
  assert.deepEqual(rows(JK.dupLink), [], 'the member wins without a duplicate-link race')
  assert.equal(node.byUuid.get('bb'), 2, 'the member holds the uuid now')
  assert.deepEqual(node.admitted(), ['bb'])
  assert.equal(node.links.get(2)!.client, false)
  //! the evicted link's linkDown echo cleans only its own entries: byUuid keeps pointing at the member
  node.step({ kind: 'linkDown', link: 1, reason: 'uuid-taken' })
  assert.equal(node.byUuid.get('bb'), 2)
  assert.equal(node.clientLinks.size, 0)
  assert.deepEqual(node.admitted(), ['bb'])
})

test('role rule 4/4: two CLIENT links with one uuid keep today\'s duplicate-link rule — a dupLink row, no doorReject', () => {
  const { node, closes, rows, up, hello } = harness('aa')
  up(1)
  hello(1, 'bb', 1)
  up(2)
  hello(2, 'bb', 1)
  assert.equal(rows(JK.dupLink).length, 1, 'the duplicate-link rule fired')
  assert.deepEqual(rows(JK.doorReject), [], 'the door did not speak: a client was the holder')
  assert.equal(closes().length, 1)
  assert.equal(closes()[0][1], 'dup-link')
})
