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
import { VERB, Framer, encodeControl } from './codec.ts'
import { JK } from './journal.ts'
import { TAG, type EffectSink, type Env } from './env.ts'

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

// ── Commit 2 — the contract and the methods-only hint (§2, §4, §8) ──────────────────────────────────

//! the byte-identity guard (§8): a node that sets nothing sends the v4.0 HELLO — these exact bytes,
// recorded from the tree at e9c1a77 (not a round trip: a round trip would follow a changed encoder).
const V40_HELLO_AA = 'f3000120000000fea631430803818000750782800061618180006905028180006c0786800073696d3a6161'
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const sends = (effects: unknown[][]) => effects.filter((e) => e[0] === 'send').map((e) => e[2] as Uint8Array)

test('byte identity: a node with nothing set encodes its HELLO to the literal v4.0 bytes — no c, no m', () => {
  const { node, effects, up } = harness('aa')
  up(1, true, 'sim:bb')
  assert.equal(hex(sends(effects)[0]), V40_HELLO_AA, 'the v4.0 frame, byte for byte')
  assert.equal(node.contract, undefined)
  assert.equal(node.methodsOnly, false)
})

test('journal golden: the no-secret two-node HELLO sequence is the rows of e9c1a77, both sides, two frames each', () => {
  const mk = (uuid: string) => {
    const sent: Uint8Array[] = []
    const sink = { connect() {}, send: (_l: number, b: Uint8Array) => { sent.push(b) }, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {}, invoke() {}, result() {}, subRecs() {} } as unknown as EffectSink
    const node = new Node({ uuid, listen: `sim:${uuid}`, redialMs: 10 }, { now: () => 0, rng: () => 0, sink })
    node.step({ kind: 'start' })
    return { node, sent }
  }
  const a = mk('aa'), b = mk('bb')
  a.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  b.node.step({ kind: 'linkUp', link: 1, dialed: false })
  let ai = 0, bi = 0
  for (let round = 0; round < 20 && (ai < a.sent.length || bi < b.sent.length); round++) {
    const fromA = a.sent.slice(ai); ai = a.sent.length
    const fromB = b.sent.slice(bi); bi = b.sent.length
    for (const f of fromA) b.node.step({ kind: 'bytesIn', link: 1, bytes: f })
    for (const f of fromB) a.node.step({ kind: 'bytesIn', link: 1, bytes: f })
  }
  const rows = (n: Node) => n.journal.read().map((e) => [e.kind, e.a ?? null, e.b ?? null, e.c ?? null])
  const { start, linkUp, identified, digestOut, digestIn } = JK
  assert.deepEqual(rows(a.node), [[start, null, null, null], [linkUp, 1, 1, null], [identified, 1, 'bb', 1], [digestOut, 1, 1, null], [digestIn, 1, null, null]])
  assert.deepEqual(rows(b.node), [[start, null, null, null], [linkUp, 1, 0, null], [identified, 1, 'aa', 1], [digestIn, 1, null, null], [digestOut, 1, 0, null]])
  assert.deepEqual([a.sent.length, b.sent.length], [2, 2], 'two frames per side: HELLO and one digest')
  assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']])
})

const CONTRACT = 'v1;heartbeat.ms=500;replicas=0;methods=0;validation=none'
const helloWith = (link: number, node: Node, extra: Record<string, unknown>) =>
  node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', ...extra }) })

test('the kernel appends the ring label: NodeOpts.contract rides HELLO as `c` with `;ring=fmix32`, and `methodsOnly` as `m: 1` — in the order u, i, l, r, n, c, m', () => {
  const { node, effects, up } = harness('aa', { name: 'shop', contract: CONTRACT, methodsOnly: true })
  assert.equal(node.contract, `${CONTRACT};ring=fmix32`)
  up(1, true, 'sim:bb')
  const f = new Framer().push(sends(effects)[0])[0]
  assert.deepEqual(f.value, { u: 'aa', i: 1, l: 'sim:aa', n: 'shop', c: `${CONTRACT};ring=fmix32`, m: 1 })
  assert.deepEqual(Object.keys(f.value as object), ['u', 'i', 'l', 'n', 'c', 'm'])
})

test('malformed c or m is a malformed HELLO: frameDrop + close, never admitted', () => {
  for (const extra of [{ c: '' }, { c: 'x'.repeat(257) }, { c: 7 }, { c: null }, { m: 2 }, { m: '1' }, { m: true }]) {
    const { node, closes, rows, up } = harness('aa', { contract: CONTRACT })
    up(1)
    helloWith(1, node, extra)
    assert.deepEqual(closes(), [[1, 'malformed-hello']], JSON.stringify(extra))
    assert.deepEqual(rows(JK.frameDrop), [[1, 'malformed hello', null]], JSON.stringify(extra))
    assert.deepEqual(node.admitted(), [])
  }
  //! the bounds: 1 and 256 characters are fine
  for (const c of ['x', 'x'.repeat(256)]) {
    const { node, closes, up } = harness('aa') // no contract of our own: one side absent → no check
    up(1)
    helloWith(1, node, { c })
    assert.deepEqual(closes(), [])
    assert.deepEqual(node.admitted(), ['bb'])
  }
})

test('contract mismatch: both carry c and differ → contractReject names the first key that differs and THEIR value; the link closes contract-mismatch; a dialed target is parked and revived at heartbeat cadence', () => {
  const { node, closes, rows, up, effects } = harness('aa', { contract: CONTRACT, hosts: ['sim:bb'], heartbeatMs: 100 })
  const connects = () => effects.filter((e) => e[0] === 'connect').map((e) => e[1])
  assert.deepEqual(connects(), ['sim:bb'])
  up(1, true, 'sim:bb')
  helloWith(1, node, { c: 'v1;heartbeat.ms=250;replicas=0;methods=0;validation=none;ring=fmix32' })
  assert.deepEqual(rows(JK.contractReject), [[1, 'heartbeat.ms', '250']], 'the key, and the OTHER side\'s value — never ours')
  assert.deepEqual(closes(), [[1, 'contract-mismatch']])
  assert.deepEqual(node.admitted(), [])
  assert.deepEqual(rows(JK.identified), [])
  const l = node.links.get(1)!
  assert.ok(l.dead && l.noRedial)
  node.step({ kind: 'linkDown', link: 1, reason: 'contract-mismatch' })
  assert.equal(effects.filter((e) => e[0] === 'timer' && e[2] === TAG.redial).length, 0, 'no redial chain against a misconfigured member')
  assert.equal(node.dialing('sim:bb'), false, 'parked given-up: no eviction hold')
  node.step(effects.filter((e) => e[0] === 'timer' && e[2] === TAG.heartbeat).map((t) => ({ kind: 'timer' as const, id: t[1] as number, tag: t[2] as number }))[0])
  assert.deepEqual(connects(), ['sim:bb', 'sim:bb'], 'the heartbeat revives it once — a fixed value heals at heartbeat cadence')
  //! the fixed peer answers with the same contract: admitted
  up(2, true, 'sim:bb')
  helloWith(2, node, { c: `${CONTRACT};ring=fmix32` })
  assert.deepEqual(node.admitted(), ['bb'])
})

test('contract: every other key names itself; a key one side lacks reads missing:<key>', () => {
  const cases: [string, [string, string]][] = [
    [`v1;heartbeat.ms=500;replicas=3;methods=0;validation=none;ring=fmix32`, ['replicas', '3']],
    [`v1;heartbeat.ms=500;replicas=0;methods=1;validation=none;ring=fmix32`, ['methods', '1']],
    [`v1;heartbeat.ms=500;replicas=0;methods=0;validation=0a1b2c3d;ring=fmix32`, ['validation', '0a1b2c3d']],
    [`v1;heartbeat.ms=500;replicas=0;methods=0;validation=none;ring=other`, ['ring', 'other']],
    [`v2;heartbeat.ms=500;replicas=0;methods=0;validation=none;ring=fmix32`, ['version', 'v2']],
    [`v1;heartbeat.ms=500;replicas=0;methods=0;validation=none`, ['missing:ring', '']],
    [`v1;heartbeat.ms=500;replicas=0;methods=0;validation=none;ring=fmix32;suspect.ticks=3`, ['missing:suspect.ticks', '3']],
  ]
  for (const [theirs, want] of cases) {
    const { node, rows, up } = harness('aa', { contract: CONTRACT })
    up(1)
    helloWith(1, node, { c: theirs })
    assert.deepEqual(rows(JK.contractReject), [[1, ...want]], theirs)
  }
})

test('contract: equal strings admit; one side absent admits (an embedder, the sim, an old peer); a CLIENT\'s c is never checked; an r:2 HELLO\'s c is never read', () => {
  //! equal
  { const { node, rows, up } = harness('aa', { contract: CONTRACT }); up(1); helloWith(1, node, { c: `${CONTRACT};ring=fmix32` }); assert.deepEqual(node.admitted(), ['bb']); assert.deepEqual(rows(JK.contractReject), []) }
  //! we carry one, they do not
  { const { node, rows, up } = harness('aa', { contract: CONTRACT }); up(1); helloWith(1, node, {}); assert.deepEqual(node.admitted(), ['bb']); assert.deepEqual(rows(JK.contractReject), []) }
  //! they carry one, we do not
  { const { node, rows, up } = harness('aa'); up(1); helloWith(1, node, { c: 'v1;heartbeat.ms=250' }); assert.deepEqual(node.admitted(), ['bb']); assert.deepEqual(rows(JK.contractReject), []) }
  //! a client link with a different c: the single-feeder rule covers clients, never the contract
  { const { node, rows, up } = harness('aa', { contract: CONTRACT }); up(1); helloWith(1, node, { r: 1, l: '', c: 'v1;heartbeat.ms=250' }); assert.deepEqual(node.admitted(), ['bb']); assert.equal(node.clientLinks.size, 1); assert.deepEqual(rows(JK.contractReject), []) }
  //! a debug attach: the diag branch runs first — with no allowlist it is denied, the contract is never compared
  { const { node, rows, up } = harness('aa', { contract: CONTRACT }); up(1); helloWith(1, node, { r: 2, l: '', c: 'v1;heartbeat.ms=250', t: 'tok' }); assert.deepEqual(rows(JK.contractReject), []); assert.equal(rows(JK.diagDeny).length, 1) }
})

test('the hint: m: 1 sets link.methodsOnly at admit; a client\'s feederMethodsOnly is read LIVE off its primary and follows a failover', () => {
  const { node, up } = harness('cc', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  assert.equal(node.feederMethodsOnly, false, 'no primary yet')
  up(1, true, 'sim:aa')
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: `${CONTRACT.replace('methods=0', 'methods=1')};ring=fmix32`, m: 1 }) })
  assert.equal(node.links.get(1)!.methodsOnly, true)
  assert.equal(node.primary, 1)
  assert.equal(node.feederMethodsOnly, true, 'the primary said methods-only')
  up(2, true, 'sim:bb')
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) }) // an old or open server: no m
  assert.equal(node.links.get(2)!.methodsOnly, false)
  assert.equal(node.feederMethodsOnly, true, 'still the primary\'s word')
  node.step({ kind: 'linkDown', link: 1, reason: 'crash' })
  assert.equal(node.primary, 2, 'failover to the second link')
  assert.equal(node.feederMethodsOnly, false, 'read live: the new feeder sent no hint, so the write takes the round trip')
})
