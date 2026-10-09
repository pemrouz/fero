//! Tier-1 door suite (docs/DESIGN-DOOR.md): the rules that run on an inbound HELLO before a link is
// admitted. This file grows with the door's commits; the discover.test.ts idiom (one node, links
// stepped by hand against the recording sink) so every row and every close is read, not inferred.
//
// Commit 1 — the role rule (§3 step 12), four ways:
//   r:1 against a committed-view member · r:1 against an admitted member link · a member against a
//   client squatting on its uuid · client against client (today's duplicate-link rule, untouched).
// The member's link is never touched and no dupLink row is written where the design says so.
// Commit 2 — the contract and the methods-only hint. Commit 3 — the handshake itself (the bottom half):
//   k on HELLO, DOOR {p} / {e}, LS.proving, the matrix, the address rule, the deadline, replay and
//   reflection, the role rule under a door, the crossing dial. Every guard mutation-checked.
// §15 — the derived client key: a second function on the door, picked by the dialer's r:1 on both sides.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node, type NodeOpts } from './node.ts'
import { VERB, Framer, encodeControl, encodeFrame } from './codec.ts'
import { JK } from './journal.ts'
import { LS } from './link.ts'
import { PROOF_LEN, proofMsg } from './door.ts'
import { TAG, type EffectSink, type Env } from './env.ts'
import { toyDoor, toyClientDoor, toyClientKey } from '../sim/door.ts'
import { mulberry32 } from '../sim/exec.ts'

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

// ── Commit 3 — the handshake (§2, §3, §9): the secret as two injected functions, `k` on HELLO, DOOR {p} ──
// Two nodes stepped by hand with every frame relayed by `pump` (a FIFO link, delivered a round at a time), so
// every frame's ORDER is read off the recording sink, never inferred. Doors are the sim's toy (sim/door.ts).

const SECRET = 'the-cluster-secret-0001'
const doorFor = (seed: number, secret = SECRET) => toyDoor(secret, mulberry32(seed))
const dec = (b: Uint8Array) => new Framer().push(b)[0]
const verbs = (bs: Uint8Array[]) => bs.map((b) => dec(b).verb)

//! rec — one node over the recording sink, with the readers the door tests need
const rec = (uuid: string, opts: Partial<NodeOpts> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (r) => effects.push(['apply', r]),
    persist: (batch, bytes) => effects.push(['persist', batch, bytes]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
  }
  const node = new Node({ uuid, listen: `sim:${uuid}`, redialMs: 10, ...opts }, { now: () => 0, rng: () => 0, sink })
  node.step({ kind: 'start' })
  const sends = (link: number) => effects.filter((e) => e[0] === 'send' && e[1] === link).map((e) => e[2] as Uint8Array)
  const closes = () => effects.filter((e) => e[0] === 'close').map((e) => [e[1], e[2]])
  const connects = () => effects.filter((e) => e[0] === 'connect').map((e) => e[1])
  const rows = (kind: number) => node.journal.read().filter((e) => e.kind === kind).map((e) => [e.a, e.b, e.c])
  const timers = (tag: number) => effects.filter((e) => e[0] === 'timer' && e[2] === tag).map((e) => ({ id: e[1] as number, ms: e[3] as number }))
  const cancels = () => effects.filter((e) => e[0] === 'cancel').map((e) => e[1] as number)
  const fire = (id: number, tag: number) => node.step({ kind: 'timer', id, tag })
  const up = (link: number, dialed = false, to?: string) => node.step({ kind: 'linkUp', link, dialed, to })
  const feed = (link: number, bytes: Uint8Array) => node.step({ kind: 'bytesIn', link, bytes })
  const down = (link: number, reason = 'closed') => node.step({ kind: 'linkDown', link, reason })
  return { node, effects, sends, closes, connects, rows, timers, cancels, fire, up, feed, down }
}
type Rec2 = ReturnType<typeof rec>

//! pump — relay every new frame between a's link al and b's link bl, a round at a time, until quiet;
// ai/bi skip frames a test has already delivered by hand
const pump = (a: Rec2, al: number, b: Rec2, bl: number, rounds = 20, ai = 0, bi = 0) => {
  for (let r = 0; r < rounds; r++) {
    const fa = a.sends(al), fb = b.sends(bl)
    if (ai >= fa.length && bi >= fb.length) break
    const fromA = fa.slice(ai); ai = fa.length
    const fromB = fb.slice(bi); bi = fb.length
    for (const f of fromA) b.feed(bl, f)
    for (const f of fromB) a.feed(al, f)
  }
}
const VIEW1: NodeOpts['boot'] = { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }

test('k: a node with a door mints a fresh nonce per link and sends it as HELLO.k (last key); without a door no k, no timer, no stash', () => {
  const a = rec('aa', { door: doorFor(1) })
  a.up(1, true, 'sim:bb'); a.up(2, true, 'sim:cc')
  const h1 = dec(a.sends(1)[0]).value as Record<string, unknown>, h2 = dec(a.sends(2)[0]).value as Record<string, unknown>
  assert.deepEqual(Object.keys(h1), ['u', 'i', 'l', 'k'])
  assert.equal(typeof h1.k, 'string'); assert.equal((h1.k as string).length, 32, 'the toy: 16 bytes as hex')
  assert.notEqual(h1.k, h2.k, 'never reused across links')
  assert.equal(a.node.links.get(1)!.nonce, h1.k, 'kept on the Link')
  assert.deepEqual(a.node.links.get(1)!.said, h1, 'the sent HELLO is kept: my proof signs exactly these keys')
  const o = rec('aa')
  o.up(1, true, 'sim:bb')
  assert.equal('k' in (dec(o.sends(1)[0]).value as object), false)
  assert.equal(o.node.links.get(1)!.said, null)
})

test('malformed k is a malformed HELLO (not a string, empty, 15 or 65 chars); 16 and 64 are accepted', () => {
  for (const k of [7, '', 'x'.repeat(15), 'x'.repeat(65), null, ['x'.repeat(20)]]) {
    const a = rec('aa', { door: doorFor(2) })
    a.up(1)
    a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k }))
    assert.deepEqual(a.closes(), [[1, 'malformed-hello']], JSON.stringify(k))
    assert.deepEqual(a.rows(JK.frameDrop), [[1, 'malformed hello', null]])
  }
  for (const k of ['x'.repeat(16), 'x'.repeat(64)]) {
    const a = rec('aa', { door: doorFor(2) })
    a.up(1)
    a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k }))
    assert.deepEqual(a.closes(), [])
    assert.equal(a.node.links.get(1)!.state, LS.proving, `${k.length} chars: proving`)
  }
})

test('the handshake: admission only after DOOR; the dialer proves first; the acceptor\'s DOOR precedes its VIEW and DIGEST; 4 handshake frames per link; the deadline is armed and cancelled', () => {
  const a = rec('aa', { door: doorFor(3), boot: VIEW1 }), b = rec('bb', { door: doorFor(4), boot: VIEW1 })
  a.up(1, true, 'sim:bb'); b.up(1)
  //! the HELLOs cross: both proving, nobody admitted, the DIALER has already sent its proof, the acceptor nothing more
  b.feed(1, a.sends(1)[0]); a.feed(1, b.sends(1)[0])
  assert.deepEqual([a.node.links.get(1)!.state, b.node.links.get(1)!.state], [LS.proving, LS.proving])
  assert.deepEqual([a.node.admitted(), b.node.admitted()], [[], []], 'nothing is admitted on a HELLO alone')
  assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR], 'the dialer proves at once')
  assert.deepEqual(verbs(b.sends(1)), [VERB.HELLO], 'the acceptor waits: it never proves first')
  assert.deepEqual([a.rows(JK.identified), b.rows(JK.identified)], [[], []])
  assert.equal(a.node.byUuid.size + b.node.byUuid.size, 0, 'a proving link is outside byUuid')
  assert.deepEqual(a.timers(TAG.prove).map((t) => t.ms), [5000], 'the proving deadline, tune.proveMs')
  assert.deepEqual(b.timers(TAG.prove).map((t) => t.ms), [5000])
  //! the dialer's proof lands: the acceptor proves back FIRST, then admits (VIEW, then the digest answer later)
  b.feed(1, a.sends(1)[1])
  assert.deepEqual(verbs(b.sends(1)), [VERB.HELLO, VERB.DOOR, VERB.VIEW], 'DOOR before anything admission ships')
  assert.deepEqual(b.node.admitted(), ['aa'])
  assert.deepEqual(b.rows(JK.identified), [[1, 'aa', 1]])
  assert.deepEqual(b.cancels(), [b.timers(TAG.prove)[0].id], 'the deadline is cancelled at admit')
  assert.equal(b.node.links.get(1)!.hello, null, 'the stash is cleared (step 13)')
  //! the rest of the exchange
  pump(a, 1, b, 1)
  assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']])
  assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR, VERB.DIGEST, VERB.VIEW], 'the lower uuid opens the digest at admit, then announces its view — today\'s admit order, after its proof')
  assert.deepEqual(verbs(b.sends(1)), [VERB.HELLO, VERB.DOOR, VERB.VIEW, VERB.DIGEST], 'the acceptor: proof, then the view, then the digest answer')
  assert.equal(verbs([...a.sends(1), ...b.sends(1)]).filter((v) => v === VERB.HELLO || v === VERB.DOOR).length, 4, '4 handshake frames per link: two HELLOs, two DOORs')
  assert.deepEqual(a.cancels(), [a.timers(TAG.prove)[0].id])
  //! a late fire of the cancelled deadline is ignored
  a.fire(a.timers(TAG.prove)[0].id, TAG.prove)
  assert.deepEqual(a.rows(JK.doorReject), [])
  assert.deepEqual(a.closes(), [])
})

test('a proving link carries nothing but DOOR: RECORDS, DIGEST, WRITE and a membership frame each close it before-hello', () => {
  const cases: [number, Uint8Array, string][] = [
    [VERB.DIGEST, encodeControl(VERB.DIGEST, { d: {}, r: 1 }), 'digest-before-hello'],
    [VERB.RECORDS, encodeFrame([{ type: 0, key: ['x'], value: 1 }], { origin: 'bb', baseSeq: 1, epoch: 0 }), 'records-before-hello'],
    [VERB.WRITE, encodeControl(VERB.WRITE, {}), 'write-before-hello'],
    [VERB.VIEW, encodeControl(VERB.VIEW, { e: 1, m: [] }), 'membership-before-hello'],
  ]
  for (const [verb, frame, reason] of cases) {
    const a = rec('aa', { door: doorFor(5) }), b = rec('bb', { door: doorFor(6) })
    a.up(1, true, 'sim:bb'); b.up(1)
    b.feed(1, a.sends(1)[0]) // b is proving
    assert.equal(b.node.links.get(1)!.state, LS.proving)
    b.feed(1, frame)
    assert.deepEqual(b.closes(), [[1, reason]], `verb ${verb}`)
    assert.deepEqual(b.node.admitted(), [])
  }
})

test('wrong secret: the acceptor journals bad-proof, sends DOOR {e: denied} and closes; the dialer journals refused and parks — heartbeat revival re-dials once per tick', () => {
  const a = rec('aa', { door: doorFor(7), hosts: ['sim:bb'], heartbeatMs: 100 }), b = rec('bb', { door: doorFor(8, 'another-secret-value') })
  a.up(1, true, 'sim:bb'); b.up(1)
  pump(a, 1, b, 1)
  assert.deepEqual(b.rows(JK.doorReject), [[1, 'bad-proof', 'sim:aa']], 'c = the claimed listen (b accepted this link)')
  assert.deepEqual(verbs(b.sends(1)), [VERB.HELLO, VERB.DOOR], 'HELLO then the notice — never a proof to a bad dialer')
  assert.deepEqual(dec(b.sends(1)[1]).value, { e: 'denied' })
  assert.deepEqual(b.closes(), [[1, 'door']])
  assert.deepEqual(a.rows(JK.doorReject), [[1, 'refused', 'sim:bb']], 'the dialer: refused, c = the dial target')
  assert.deepEqual(a.closes(), [[1, 'door']])
  const l = a.node.links.get(1)!
  assert.ok(l.dead && l.noRedial)
  assert.deepEqual([a.node.admitted(), b.node.admitted()], [[], []])
  a.down(1, 'door')
  assert.equal(a.timers(TAG.redial).length, 0, 'no redial chain: parked')
  assert.equal(a.node.dialing('sim:bb'), false)
  a.fire(a.timers(TAG.heartbeat)[0].id, TAG.heartbeat)
  assert.deepEqual(a.connects(), ['sim:bb', 'sim:bb'], 'revived once by the heartbeat — a fixed secret heals at heartbeat cadence')
  assert.deepEqual(a.rows(JK.revive), [['sim:bb', null, null]])
})

test('one side only: no-secret on the secured end, peer-secret on the open end; both refuse, a dialed target parks on either side', () => {
  //! the secured node dialed the open one
  { const a = rec('aa', { door: doorFor(9), hosts: ['sim:bb'] }), b = rec('bb')
    a.up(1, true, 'sim:bb'); b.up(1)
    pump(a, 1, b, 1)
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'no-secret', 'sim:bb']])
    assert.deepEqual(b.rows(JK.doorReject), [[1, 'peer-secret', 'sim:aa']], 'the open end sees k and names the claimed listen')
    assert.deepEqual([a.closes(), b.closes()], [[[1, 'door']], [[1, 'door']]])
    assert.deepEqual([a.node.admitted(), b.node.admitted()], [[], []])
    a.down(1, 'door'); assert.equal(a.node.dialing('sim:bb'), false); assert.equal(a.timers(TAG.redial).length, 0, 'parked, no chain')
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO], 'no proof was spent on a peer without a door') }
  //! the open node dialed the secured one: it parks too
  { const a = rec('aa', { door: doorFor(10) }), b = rec('bb', { hosts: ['sim:aa'] })
    b.up(1, true, 'sim:aa'); a.up(1)
    pump(b, 1, a, 1)
    assert.deepEqual(b.rows(JK.doorReject), [[1, 'peer-secret', 'sim:aa']])
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'no-secret', 'sim:bb']])
    b.down(1, 'door'); assert.equal(b.node.dialing('sim:aa'), false); assert.equal(b.timers(TAG.redial).length, 0) }
})

test('REPLAY (the STATUS.md:54 regression): a captured HELLO + DOOR on a fresh link is bad-proof — the real member\'s link stays admitted, byUuid untouched, no dupLink row; a forged HELLO with a random k times out the same way; confirm marks untouched', () => {
  const a = rec('aa', { door: doorFor(11) }), b = rec('bb', { door: doorFor(12) })
  a.up(1, true, 'sim:bb'); b.up(1)
  pump(a, 1, b, 1)
  assert.deepEqual(b.node.admitted(), ['aa'])
  //! evidence on b about aa's lane: a digest from the real aa
  b.feed(1, encodeControl(VERB.DIGEST, { d: { aa: 5 }, r: 0 }))
  assert.equal(b.node.confirm.mark('aa', 'aa'), 5)
  const [helloA, doorA] = a.sends(1)
  assert.deepEqual(verbs([helloA, doorA]), [VERB.HELLO, VERB.DOOR])
  //! the replay: the same two frames on a NEW connection to b
  b.up(2)
  b.feed(2, helloA)
  assert.equal(b.node.links.get(2)!.state, LS.proving, 'the forged HELLO sits in proving — byUuid is not consulted')
  assert.equal(b.node.byUuid.get('aa'), 1)
  b.feed(2, doorA)
  assert.deepEqual(b.rows(JK.doorReject), [[2, 'bad-proof', 'sim:aa']], 'the fresh nonce: the old proof signs the old one')
  assert.deepEqual(b.closes(), [[2, 'door']], 'only the replayed link closes')
  assert.deepEqual(b.rows(JK.dupLink), [], 'the duplicate-link rule never ran')
  assert.equal(b.node.byUuid.get('aa'), 1, 'the real member\'s link holds the uuid')
  assert.equal(b.node.links.get(1)!.dead, false)
  assert.deepEqual(b.node.admitted(), ['aa'])
  //! a forged HELLO claiming aa with a HIGHER incarnation and a random k, then silence: the deadline
  b.up(3)
  b.feed(3, encodeControl(VERB.HELLO, { u: 'aa', i: 7, l: 'sim:aa', k: 'f'.repeat(32) }))
  assert.equal(b.node.links.get(3)!.state, LS.proving)
  const t = b.timers(TAG.prove).find((x) => b.cancels().indexOf(x.id) < 0 && x.id !== b.timers(TAG.prove)[0].id)!
  b.fire(b.timers(TAG.prove)[b.timers(TAG.prove).length - 1].id, TAG.prove)
  assert.ok(t)
  assert.deepEqual(b.rows(JK.doorReject).slice(1), [[3, 'timeout', '']])
  assert.deepEqual(b.closes().slice(1), [[3, 'door-timeout']])
  assert.equal(b.node.confirm.mark('aa', 'aa'), 5, 'the reincarnation fence never ran: confirm marks untouched by an intruder')
  assert.equal(b.node.byUuid.get('aa'), 1)
  assert.deepEqual(b.node.admitted(), ['aa'])
  //! the real link still works
  b.feed(1, encodeControl(VERB.DIGEST, { d: { aa: 6 }, r: 0 }))
  assert.equal(b.node.confirm.mark('aa', 'aa'), 6)
})

test('reflection: an acceptor that hands the dialer\'s own proof back (with its own k, or echoing the dialer\'s k) is bad-proof — the side label and the nonces stop it', () => {
  for (const echo of [false, true]) {
    const a = rec('aa', { door: doorFor(13), hosts: ['sim:xx'] })
    a.up(1, true, 'sim:xx')
    const kA = (dec(a.sends(1)[0]).value as { k: string }).k
    const kX = echo ? kA : 'e'.repeat(32)
    a.feed(1, encodeControl(VERB.HELLO, { u: 'xx', i: 1, l: 'sim:xx', k: kX }))
    const pA = (dec(a.sends(1)[1]).value as { p: string }).p
    assert.equal(pA.length, PROOF_LEN)
    a.feed(1, encodeControl(VERB.DOOR, { p: pA }))
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'bad-proof', 'sim:xx']], `echo=${echo}`)
    assert.deepEqual(dec(a.sends(1)[2]).value, { e: 'denied' })
    assert.deepEqual(a.closes(), [[1, 'door']])
    assert.deepEqual(a.node.admitted(), [])
    a.down(1, 'door'); assert.equal(a.node.dialing('sim:xx'), false, 'parked')
  }
})

test('malformed p is a malformed DOOR: not a string, empty, 42 or 44 chars, or neither p nor e — frameDrop + close, never bad-proof', () => {
  for (const body of [{ p: 7 }, { p: '' }, { p: 'x'.repeat(42) }, { p: 'x'.repeat(44) }, {}, { p: null }]) {
    const a = rec('aa', { door: doorFor(14) }), b = rec('bb', { door: doorFor(15) })
    a.up(1, true, 'sim:bb'); b.up(1)
    b.feed(1, a.sends(1)[0])
    b.feed(1, encodeControl(VERB.DOOR, body))
    assert.deepEqual(b.closes(), [[1, 'malformed-door']], JSON.stringify(body))
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'malformed door', null]])
    assert.deepEqual(b.rows(JK.doorReject), [])
  }
})

test('DOOR out of order: on an admitted link it is dropped and the link lives (secured and open nodes); before any HELLO it closes', () => {
  //! secured, admitted
  { const a = rec('aa', { door: doorFor(16) }), b = rec('bb', { door: doorFor(17) })
    a.up(1, true, 'sim:bb'); b.up(1); pump(a, 1, b, 1)
    b.feed(1, a.sends(1)[1]) // the dialer's DOOR again (the dup fault)
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'door out of order', null]])
    assert.deepEqual(b.closes(), []); assert.deepEqual(b.node.admitted(), ['aa']) }
  //! open, admitted
  { const o = rec('aa'); o.up(1); o.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }))
    o.feed(1, encodeControl(VERB.DOOR, { p: 'x'.repeat(43) }))
    assert.deepEqual(o.rows(JK.frameDrop), [[1, 'door out of order', null]]); assert.deepEqual(o.closes(), []) }
  //! before HELLO: the write-before-hello idiom
  for (const opts of [{ door: doorFor(18) }, {}]) {
    const n = rec('aa', opts); n.up(1)
    n.feed(1, encodeControl(VERB.DOOR, { p: 'x'.repeat(43) }))
    assert.deepEqual(n.closes(), [[1, 'door-before-hello']]); assert.deepEqual(n.rows(JK.frameDrop), [[1, 'door before hello', null]])
  }
})

test('a second HELLO: dropped on a secured node (the stash keeps the first nonce, the proof over it still verifies; after admit the link lives); re-admits on an open node as today', () => {
  //! secured, proving: the dup fault re-delivers HELLO (here with a different k, the worst case)
  { const a = rec('aa', { door: doorFor(19) }), b = rec('bb', { door: doorFor(20) })
    a.up(1, true, 'sim:bb'); b.up(1)
    b.feed(1, a.sends(1)[0])
    const first = b.node.links.get(1)!.hello
    b.feed(1, encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', k: 'd'.repeat(32) }))
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'hello twice', null]])
    assert.equal(b.node.links.get(1)!.state, LS.proving)
    assert.equal(b.node.links.get(1)!.hello, first, 'the stash is the FIRST HELLO')
    pump(a, 1, b, 1, 20, 1, 0) // a's HELLO was delivered by hand above
    assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']], 'the proof over the first nonce verifies')
    //! secured, admitted: dropped, the link lives
    b.feed(1, a.sends(1)[0])
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'hello twice', null], [1, 'hello twice', null]])
    assert.deepEqual(b.closes(), []); assert.deepEqual(b.rows(JK.identified).length, 1) }
  //! open: today's path, the golden's 14 of 20 seeds re-admit through the dup fault
  { const o = rec('aa'); o.up(1)
    const h = encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' })
    o.feed(1, h); o.feed(1, h)
    assert.equal(o.rows(JK.identified).length, 2, 're-admitted'); assert.deepEqual(o.rows(JK.frameDrop), []); assert.deepEqual(o.closes(), []) }
})

test('the notice and the close mid-handshake: DOOR {e: denied} while proving reads refused and parks; {e: uuid-taken} keeps its word (c = the dial target) and parks; neither starts a chain. A BARE close after my proof is a link loss: no row, no park, the ordinary redial chain (the third review: with heartbeats off a park here stranded honest pairs cut during the handshake)', () => {
  //! the notice: denied
  { const a = rec('aa', { door: doorFor(21), hosts: ['sim:bb'] })
    a.up(1, true, 'sim:bb')
    a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
    assert.equal(a.node.links.get(1)!.proved, true)
    a.feed(1, encodeControl(VERB.DOOR, { e: 'denied' }))
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'refused', 'sim:bb']])
    assert.deepEqual(a.closes(), [[1, 'door']])
    a.down(1, 'door')
    assert.deepEqual(a.rows(JK.doorReject).length, 1, 'journaled once, not again at linkDown')
    assert.equal(a.timers(TAG.redial).length, 0); assert.equal(a.node.dialing('sim:bb'), false) }
  //! the notice: uuid-taken — the one reason this side cannot guess, so the row keeps it (the second review's minor);
  // an unknown word reads refused like a bare close
  { const a = rec('aa', { door: doorFor(21), hosts: ['sim:bb'] })
    a.up(1, true, 'sim:bb')
    a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
    a.feed(1, encodeControl(VERB.DOOR, { e: 'uuid-taken' }))
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'uuid-taken', 'sim:bb']], 'the dial target, not the uuid: the row says where')
    assert.deepEqual(a.closes(), [[1, 'door']])
    a.down(1, 'door')
    assert.equal(a.rows(JK.doorReject).length, 1); assert.equal(a.timers(TAG.redial).length, 0); assert.equal(a.node.dialing('sim:bb'), false, 'parked')
    const x = rec('aa', { door: doorFor(21), hosts: ['sim:bb'] })
    x.up(1, true, 'sim:bb'); x.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
    x.feed(1, encodeControl(VERB.DOOR, { e: 'some-future-word' }))
    assert.deepEqual(x.rows(JK.doorReject), [[1, 'refused', 'sim:bb']]) }
  //! the bare close after my proof: a cut, a crash or a reset mid-handshake — or a refusal whose best-effort
  // notice was lost. From here they look the same, so it is a LINK LOSS: no doorReject row, no park, and the
  // same bounded redial chain a link that died before HELLO gets (never noRedial). Before the third review this
  // wrote `refused` against an honest peer and parked it; with heartbeats off nothing clears a park.
  { const a = rec('aa', { door: doorFor(22), hosts: ['sim:bb'] })
    a.up(1, true, 'sim:bb')
    a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
    assert.equal(a.node.links.get(1)!.proved, true)
    a.down(1, 'reset')
    assert.deepEqual(a.rows(JK.doorReject), [], 'no row: the door did not speak')
    assert.equal(a.timers(TAG.redial).length, 1, 'the ordinary redial chain toward the target'); assert.equal(a.node.dialing('sim:bb'), true, 'not parked')
    assert.deepEqual(a.cancels(), [a.timers(TAG.prove)[0].id], 'the deadline is cancelled with the link')
    //! the chain is the ordinary bounded one and it ENDS: fire each redial, fail each dial, until no timer is left
    let fired = 0
    for (let i = 0; i < 40 && a.timers(TAG.redial).length > fired; i++) {
      a.fire(a.timers(TAG.redial)[fired++].id, TAG.redial)
      a.node.step({ kind: 'linkDown', link: 900 + i, reason: 'refused', to: 'sim:bb' })
    }
    assert.ok(fired > 1 && fired <= 10, `a bounded chain (${fired} dials)`)
    assert.deepEqual(a.rows(JK.giveUp), [['sim:bb', null, null]], 'the chain gave up: nothing hangs, nothing re-arms with heartbeats off')
    assert.equal(a.node.dialing('sim:bb'), false) }
  //! an acceptor that never proved: a close while proving is just a lost link (no row)
  { const b = rec('bb', { door: doorFor(23) })
    b.up(1)
    b.feed(1, encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', k: 'a'.repeat(32) }))
    b.down(1, 'reset')
    assert.deepEqual(b.rows(JK.doorReject), []) }
  //! an acceptor that never proved reads a NOTICE: a stranger's frame, not a refusal — dropped and closed like a
  // malformed DOOR, no `refused` row (the review's nit: only a link I proved on can be refused)
  { const b = rec('bb', { door: doorFor(23) })
    b.up(1)
    b.feed(1, encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', k: 'a'.repeat(32) }))
    assert.equal(b.node.links.get(1)!.proved, false)
    b.feed(1, encodeControl(VERB.DOOR, { e: 'denied' }))
    assert.deepEqual(b.rows(JK.doorReject), [], 'no refused row: this node never sent a proof to be refused')
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'notice before proof', null]])
    assert.deepEqual(b.closes(), [[1, 'malformed-door']]) }
})


test('the deadline: a proving link with no DOOR is refused timeout at tune.proveMs (heartbeats off), dead + noRedial, parked, closed door-timeout', () => {
  const a = rec('aa', { door: doorFor(24), hosts: ['sim:bb'], tune: { proveMs: 7 } })
  a.up(1, true, 'sim:bb')
  a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
  assert.deepEqual(a.timers(TAG.prove).map((t) => t.ms), [7], 'the tune row, not a heartbeat sweep')
  assert.equal(a.timers(TAG.heartbeat).length, 0, 'heartbeats are off')
  a.fire(a.timers(TAG.prove)[0].id, TAG.prove)
  assert.deepEqual(a.rows(JK.doorReject), [[1, 'timeout', 'sim:bb']])
  assert.deepEqual(a.closes(), [[1, 'door-timeout']])
  const l = a.node.links.get(1)!
  assert.ok(l.dead && l.noRedial)
  a.down(1, 'door-timeout')
  assert.equal(a.timers(TAG.redial).length, 0); assert.equal(a.node.dialing('sim:bb'), false, 'parked')
  //! the same on an accepted link: nothing to park
  const b = rec('bb', { door: doorFor(25) })
  b.up(1); b.feed(1, encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', k: 'a'.repeat(32) }))
  b.fire(b.timers(TAG.prove)[0].id, TAG.prove)
  assert.deepEqual(b.rows(JK.doorReject), [[1, 'timeout', '']])
  assert.deepEqual(b.closes(), [[1, 'door-timeout']])
})

test('a debug attach (r:2) on a SECURED node is unchanged (§8): with the token it latches LS.diag with diagAuth, no proving state, no deadline, no door row; a wrong token is diagDeny bad-token; an r:2 HELLO on a link that is already proving closes diag-denied', () => {
  const TOKEN = 'secret-token-for-r2-tests'
  const attach = (b: Rec2, link: number, t: string) => b.feed(link, encodeControl(VERB.HELLO, { u: 'dbg', i: 1, l: '', r: 2, t }))
  //! the token: a session, outside the door entirely
  { const b = rec('bb', { door: doorFor(53), diag: { allow: { ops: TOKEN } } })
    b.up(1); attach(b, 1, TOKEN)
    assert.equal(b.node.links.get(1)!.state, LS.diag)
    assert.deepEqual(b.rows(JK.diagAuth), [[1, 'ops', null]])
    assert.deepEqual(b.timers(TAG.prove), [], 'never asked for a proof')
    assert.deepEqual(b.rows(JK.doorReject), []); assert.deepEqual(b.rows(JK.frameDrop), [])
    assert.equal(b.node.links.get(1)!.hello, null, 'nothing stashed') }
  //! a wrong token: the attach's own door, not ours
  { const b = rec('bb', { door: doorFor(54), diag: { allow: { ops: TOKEN } } })
    b.up(1); attach(b, 1, 'wrong-token-xxxxxxxxxxx')
    assert.deepEqual(b.rows(JK.diagDeny), [[1, 'bad-token', null]])
    assert.deepEqual(b.closes(), [[1, 'diag-denied']])
    assert.deepEqual(b.rows(JK.doorReject), []); assert.deepEqual(b.timers(TAG.prove), []) }
  //! r:2 on a link already proving: the used-link guard, unchanged
  { const b = rec('bb', { door: doorFor(55), diag: { allow: { ops: TOKEN } } })
    b.up(1)
    b.feed(1, encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', k: 'a'.repeat(32) }))
    assert.equal(b.node.links.get(1)!.state, LS.proving)
    attach(b, 1, TOKEN)
    assert.deepEqual(b.rows(JK.frameDrop), [[1, 'diag hello on used link', null]])
    assert.deepEqual(b.closes(), [[1, 'diag-denied']])
    assert.deepEqual(b.rows(JK.diagAuth), [], 'never latched') }
})

test('the address rule: a DISCOVERED or VIEW-LEARNED target must answer as the address I dialed (else address, parked, no proof spent); a STATIC host is exempt; an accepted link is never checked', () => {
  const peer = (k = 'b'.repeat(32)) => encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k })
  //! discovered: the directory said sim:x, the peer says it is sim:bb — someone in between
  { const a = rec('aa', { door: doorFor(26) })
    a.node.step({ kind: 'discover', hosts: ['sim:x'] })
    assert.deepEqual(a.connects(), ['sim:x'])
    a.up(1, true, 'sim:x'); a.feed(1, peer())
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'address', 'sim:bb']], 'c = the claimed listen')
    assert.deepEqual(a.closes(), [[1, 'door']])
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO], 'refused BEFORE any proof left')
    a.down(1, 'door'); assert.equal(a.node.dialing('sim:x'), false, 'parked') }
  //! view-learned: the committed view names bb at sim:x (a stale or forged entry); the dial is not a static host
  { const a = rec('aa', { door: doorFor(27), boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:x']] } })
    a.up(1, true, 'sim:x'); a.feed(1, peer())
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'address', 'sim:bb']])
    assert.deepEqual(a.closes(), [[1, 'door']]) }
  //! static: the operator typed sim:x; spelling is theirs — exempt, the handshake proceeds
  { const a = rec('aa', { door: doorFor(28), hosts: ['sim:x'] })
    a.up(1, true, 'sim:x'); a.feed(1, peer())
    assert.deepEqual(a.rows(JK.doorReject), [])
    assert.equal(a.node.links.get(1)!.state, LS.proving)
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR]) }
  //! accepted: whatever the peer claims, I did not dial it
  { const a = rec('aa', { door: doorFor(29) })
    a.up(1); a.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:elsewhere', k: 'b'.repeat(32) }))
    assert.deepEqual(a.rows(JK.doorReject), []); assert.equal(a.node.links.get(1)!.state, LS.proving) }
  //! the matching claim passes
  { const a = rec('aa', { door: doorFor(30) })
    a.node.step({ kind: 'discover', hosts: ['sim:bb'] })
    a.up(1, true, 'sim:bb'); a.feed(1, peer())
    assert.deepEqual(a.rows(JK.doorReject), []); assert.equal(a.node.links.get(1)!.state, LS.proving) }
})

test('the REWRITE relay (the review\'s blocker): a relay that answers for a member under its OWN address passes the address rule — so the dialer\'s proof signs the listen it was shown, and the real member, rebuilding over the listen it sent, reads bad-proof; member victim, the real link untouched, client victim', () => {
  //! x — the relay: aa was told (discover) that the resource is at sim:x; x dials bb and forwards every frame,
  // but rewrites bb's HELLO so that `l` reads sim:x, the address aa dialed. addressOk cannot tell.
  const viaX = (hb: Record<string, unknown>) => encodeControl(VERB.HELLO, { ...hb, l: 'sim:x' })
  //! 1/3 the member victim: bb must never admit aa over x's link
  { const a = rec('aa', { door: doorFor(47) }), b = rec('bb', { door: doorFor(48) })
    a.node.step({ kind: 'discover', hosts: ['sim:x'] })
    a.up(1, true, 'sim:x'); b.up(1) // aa → x, and x → bb
    a.feed(1, viaX(dec(b.sends(1)[0]).value as Record<string, unknown>))
    assert.deepEqual(a.rows(JK.doorReject), [], 'the address rule is blind to the rewrite: the claim equals the dial target')
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR], 'so aa, the dialer, proves — over the listen it was SHOWN')
    b.feed(1, a.sends(1)[0]); b.feed(1, a.sends(1)[1]) // x forwards aa's HELLO and proof verbatim
    assert.deepEqual(b.rows(JK.doorReject), [[1, 'bad-proof', 'sim:aa']], 'bb rebuilt the message over the listen it SENT (sim:bb): the proof does not verify')
    assert.deepEqual(verbs(b.sends(1)), [VERB.HELLO, VERB.DOOR], 'HELLO, then the notice — bb never proved to the relay')
    assert.deepEqual(dec(b.sends(1)[1]).value, { e: 'denied' })
    assert.deepEqual([a.node.admitted(), b.node.admitted()], [[], []])
    assert.equal(b.node.byUuid.has('aa'), false)
    assert.deepEqual(b.rows(JK.identified), [])
    a.feed(1, b.sends(1)[1]) // the notice comes back through x
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'refused', 'sim:x']], 'aa parks the relay\'s address') }
  //! 2/3 the real link: bb (the higher uuid) already holds aa over a link bb dialed; the relay must not evict it
  { const a = rec('aa', { door: doorFor(49) }), b = rec('bb', { door: doorFor(50), hosts: ['sim:aa'] })
    b.up(1, true, 'sim:aa'); a.up(1); pump(b, 1, a, 1)
    assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']])
    a.node.step({ kind: 'discover', hosts: ['sim:x'] })
    a.up(2, true, 'sim:x'); b.up(2)
    a.feed(2, viaX(dec(b.sends(2)[0]).value as Record<string, unknown>))
    b.feed(2, a.sends(2)[0]); b.feed(2, a.sends(2)[1])
    assert.deepEqual(b.rows(JK.doorReject), [[2, 'bad-proof', 'sim:aa']])
    assert.equal(b.node.byUuid.get('aa'), 1, 'the real link still holds aa'); assert.equal(b.node.links.get(1)!.dead, false)
    assert.deepEqual(b.rows(JK.dupLink), [], 'no duplicate-link row: the duplicate-link rule never ran')
    assert.deepEqual(b.closes(), [[2, 'door']], 'only the relay\'s link closes') }
  //! 3/3 the client victim: a secured client told about sim:x by the directory; bb must not admit it as the client
  { const c = rec('cc', { client: true, listen: '', door: doorFor(51) }), b = rec('bb', { door: doorFor(52) })
    c.node.step({ kind: 'discover', hosts: ['sim:x'] })
    c.up(1, true, 'sim:x'); b.up(1)
    c.feed(1, viaX(dec(b.sends(1)[0]).value as Record<string, unknown>))
    assert.deepEqual(verbs(c.sends(1)), [VERB.HELLO, VERB.DOOR])
    b.feed(1, c.sends(1)[0]); b.feed(1, c.sends(1)[1])
    assert.deepEqual(b.rows(JK.doorReject), [[1, 'bad-proof', '']], 'c = the claimed listen, \'\' for a client')
    assert.equal(b.node.clientLinks.size, 0, 'never a client link: bb ships it no RECORDS')
    assert.deepEqual(b.node.admitted(), []); assert.equal(b.node.byUuid.has('cc'), false) }
  //! 4/4 the REVERSE order (the second review's nit): the relay dials the victim FIRST and holds its HELLO (and nonce)
  // before any member dials the relay; the member is one the victim's committed view already lists, so a proof that
  // verified would admit it as a known member. The member's dialer proof, made over the listen it was shown (sim:x),
  // is replayed at the victim: bad-proof, no identified row, nothing in byUuid
  { const m = rec('mm', { door: doorFor(56) }), a = rec('aa', { door: doorFor(57), boot: { epoch: 1, members: [['aa', 'sim:aa'], ['mm', 'sim:mm']] } })
    a.up(1) // x → aa, before mm knows anything: aa's HELLO (with its nonce) is in x's hands
    const aaHello = dec(a.sends(1)[0]).value as Record<string, unknown>
    m.node.step({ kind: 'discover', hosts: ['sim:x'] })
    m.up(1, true, 'sim:x') // mm → x; x answers with aa's HELLO under its own address
    m.feed(1, viaX(aaHello))
    assert.deepEqual(verbs(m.sends(1)), [VERB.HELLO, VERB.DOOR], 'mm proves to what it thinks is aa at sim:x')
    a.feed(1, m.sends(1)[0]); a.feed(1, m.sends(1)[1]) // x replays mm's HELLO and proof at aa
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'bad-proof', 'sim:mm']], 'aa rebuilt over the listen it sent (sim:aa): bad-proof, though mm is a member of its view')
    assert.deepEqual(a.rows(JK.identified), []); assert.equal(a.node.byUuid.has('mm'), false); assert.deepEqual(a.node.admitted(), [])
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR]); assert.deepEqual(dec(a.sends(1)[1]).value, { e: 'denied' }, 'the notice, never aa\'s own proof') }
  //! the control: a relay that forwards VERBATIM is caught by the address rule before any proof (the earlier test)
})

test('the role rule with a door, four ways: the client\'s proof is checked first, then uuid-taken BEFORE this node\'s own proof (the notice {e: uuid-taken}, never a proof), so the client is still proving and journals refused; a member evicts a squatting client; client vs client keeps dup-link', () => {
  const clientOf = (uuid: string, seed: number) => rec(uuid, { client: true, hosts: ['sim:aa'], listen: '', door: doorFor(seed) })
  //! 1/4 r:1 against a committed-view member
  { const a = rec('aa', { door: doorFor(31), boot: VIEW1 }), c = clientOf('bb', 32)
    c.up(1, true, 'sim:aa'); a.up(1)
    pump(c, 1, a, 1)
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'uuid-taken', 'bb']])
    assert.deepEqual(verbs(a.sends(1)), [VERB.HELLO, VERB.DOOR], 'HELLO, then the notice — the role rule ran before this node\'s proof, so no proof went to the refused client')
    assert.deepEqual(dec(a.sends(1)[1]).value, { e: 'uuid-taken' })
    assert.deepEqual(a.closes(), [[1, 'uuid-taken']])
    assert.deepEqual(a.rows(JK.dupLink), []); assert.equal(a.node.byUuid.has('bb'), false); assert.equal(a.node.clientLinks.size, 0)
    //! the client's side: still proving when the notice arrives, so it reads it — uuid-taken with the dial target (the
    // notice's one word this side cannot guess), parked, never admitted aa
    assert.deepEqual(c.rows(JK.doorReject), [[1, 'uuid-taken', 'sim:aa']], 'the client has its own row, with the reason (the reviews\' minors)')
    assert.deepEqual(c.node.admitted(), []); assert.deepEqual(c.rows(JK.identified), [])
    assert.deepEqual(c.rows(JK.frameDrop), [], 'the notice was not dropped as out of order') }
  //! 2/4 r:1 against an admitted member link: the member's link is untouched
  { const a = rec('aa', { door: doorFor(33) }), b = rec('bb', { door: doorFor(34) }), c = clientOf('bb', 35)
    a.up(1, true, 'sim:bb'); b.up(1); pump(a, 1, b, 1)
    assert.deepEqual(a.node.admitted(), ['bb'])
    c.up(1, true, 'sim:aa'); a.up(2); pump(c, 1, a, 2)
    assert.deepEqual(a.rows(JK.doorReject), [[2, 'uuid-taken', 'bb']])
    assert.deepEqual(a.closes(), [[2, 'uuid-taken']], 'only the client link closes')
    assert.equal(a.node.byUuid.get('bb'), 1); assert.equal(a.node.links.get(1)!.dead, false); assert.deepEqual(a.node.admitted(), ['bb']) }
  //! 3/4 a member whose uuid a client link squats on: the client link closes, the member is admitted
  { const a = rec('aa', { door: doorFor(36) }), b = rec('bb', { door: doorFor(37) }), c = clientOf('bb', 38)
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.equal(a.node.clientLinks.size, 1); assert.equal(a.node.byUuid.get('bb'), 1)
    a.up(2); b.up(1, true, 'sim:aa'); pump(b, 1, a, 2)
    assert.deepEqual(a.closes(), [[1, 'uuid-taken']]); assert.deepEqual(a.rows(JK.doorReject), [[1, 'uuid-taken', 'bb']])
    assert.equal(a.node.byUuid.get('bb'), 2); assert.deepEqual(a.node.admitted(), ['bb']); assert.equal(a.node.links.get(2)!.client, false) }
  //! 4/4 two clients, one uuid: today's duplicate-link rule
  { const a = rec('aa', { door: doorFor(39) }), c1 = clientOf('cc', 40), c2 = clientOf('cc', 41)
    c1.up(1, true, 'sim:aa'); a.up(1); pump(c1, 1, a, 1)
    c2.up(1, true, 'sim:aa'); a.up(2); pump(c2, 1, a, 2)
    assert.equal(a.rows(JK.dupLink).length, 1); assert.deepEqual(a.rows(JK.doorReject), []); assert.equal(a.closes()[0][1], 'dup-link') }
})

test('the crossing dial, secured: both dial each other, both links prove, the keeper rule picks the link dialed by the lower uuid — as today', () => {
  const a = rec('aa', { door: doorFor(42), hosts: ['sim:bb'] }), b = rec('bb', { door: doorFor(43), hosts: ['sim:aa'] })
  a.up(1, true, 'sim:bb'); b.up(2) // a's dial lands on b's link 2
  b.up(1, true, 'sim:aa'); a.up(2) // b's dial lands on a's link 2
  for (let r = 0; r < 6; r++) { pump(a, 1, b, 2, 1); pump(b, 1, a, 2, 1) }
  assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']])
  assert.equal(a.rows(JK.dupLink).length, 1); assert.equal(b.rows(JK.dupLink).length, 1)
  assert.equal(a.node.byUuid.get('bb'), 1, 'aa dialed: its dialed link survives')
  assert.equal(b.node.byUuid.get('aa'), 2, 'bb keeps the link aa dialed')
  assert.deepEqual(a.closes(), [[2, 'dup-link']]); assert.deepEqual(b.closes(), [[1, 'dup-link']])
  assert.equal(a.node.links.get(1)!.state, LS.admitted); assert.equal(b.node.links.get(2)!.state, LS.admitted)
})

test('the crossing dial, secured, the LOSER\'s close overtakes the acceptor\'s proof: a dialer that already holds the peer over the winning link reads the close as the duplicate-link resolution — no refused row, no park, no redial; its later loss of the winner still starts a chain', () => {
  //! the sim posts a close after the minimum delay and bytes after a random one, so the acceptor's DOOR {p}
  // (shipped right before it closed the link as the dup-link loser) can arrive AFTER the close. The dialer is
  // still proving with its proof sent — exactly the shape of a refusal — but it already holds the peer over the
  // other link, so this close is the keeper rule's, not a refusal (the second review's major).
  const a = rec('aa', { door: doorFor(53), hosts: ['sim:bb'] }), b = rec('bb', { door: doorFor(54), hosts: ['sim:aa'] })
  a.up(1, true, 'sim:bb'); b.up(2) // a's dial lands on b's link 2
  b.up(1, true, 'sim:aa'); a.up(2) // b's dial lands on a's link 2
  //! link 2 (bb dialed) completes first: bb's HELLO + proof reach aa, aa proves back and admits
  a.feed(2, b.sends(1)[0]); b.feed(1, a.sends(2)[0]); a.feed(2, b.sends(1)[1])
  assert.deepEqual(a.node.admitted(), ['bb']); assert.equal(a.node.byUuid.get('bb'), 2)
  //! link 1 (aa dialed): aa read bb's HELLO and proved; bb has not answered yet
  a.feed(1, b.sends(2)[0])
  assert.equal(a.node.links.get(1)!.state, LS.proving); assert.equal(a.node.links.get(1)!.proved, true)
  //! bb closes link 1 (the keeper rule at bb: it holds aa over link 2 already) and the close overtakes its proof
  a.down(1, 'dup-link')
  assert.deepEqual(a.rows(JK.doorReject), [], 'an honest peer is never journaled refused')
  assert.deepEqual(a.timers(TAG.redial), [], 'no redial: the pair is linked')
  assert.deepEqual(a.node.admitted(), ['bb'], 'the winner is untouched')
  //! sim:bb is NOT parked: when the winner later dies, the redial chain starts (a parked target returns at once)
  a.down(2, 'reset')
  assert.equal(a.timers(TAG.redial).length, 1, 'a redial chain toward bb — the target was never parked given-up')
  assert.equal(a.node.dialing('sim:bb'), true)
  //! the control: the same close with NO other link to the peer is a link loss — no row, and the chain runs
  { const c = rec('cc', { door: doorFor(55), hosts: ['sim:bb'] })
    c.up(1, true, 'sim:bb'); c.feed(1, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
    c.down(1, 'reset')
    assert.deepEqual(c.rows(JK.doorReject), [])
    assert.equal(c.timers(TAG.redial).length, 1); assert.equal(c.node.dialing('sim:bb'), true) }
})

test('held is judged on the PROVEN listen, not the closing peer\'s claim (the third review\'s nit): aa holds bb; a typed host sim:x answers aa\'s dial as bb with a nonce, aa proves, sim:x closes — no row, and sim:x IS dialed again on the chain; the same close from bb\'s own proven address is the keeper rule and starts nothing', () => {
  const a = rec('aa', { door: doorFor(56), hosts: ['sim:bb', 'sim:x'] }), b = rec('bb', { door: doorFor(57) })
  a.up(1, true, 'sim:bb'); b.up(1); pump(a, 1, b, 1)
  assert.deepEqual(a.node.admitted(), ['bb'])
  assert.equal(a.node.links.get(1)!.listen, 'sim:bb', 'the proven listen of the held link')
  //! the stranger at the typed host claims a uuid aa holds — unproven, and it closes after aa's proof
  a.up(3, true, 'sim:x')
  a.feed(3, encodeControl(VERB.HELLO, { u: 'bb', i: 9, l: 'sim:x', k: 'x'.repeat(32) }))
  assert.equal(a.node.links.get(3)!.proved, true)
  a.down(3, 'reset')
  assert.deepEqual(a.rows(JK.doorReject), [], 'no row: a bare close')
  assert.deepEqual(a.timers(TAG.redial).length, 1, 'sim:x is dialed again: the claim it made bought it no silence')
  assert.equal(a.node.dialing('sim:x'), true)
  assert.deepEqual(a.node.admitted(), ['bb'], 'the real link is untouched')
  //! the control: a second dial to bb's OWN proven address that closes while proving is the crossing dial's keeper
  // close — held by listen, so no chain (the pair is linked over link 1)
  a.up(4, true, 'sim:bb')
  a.feed(4, encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb', k: 'b'.repeat(32) }))
  a.down(4, 'dup-link')
  assert.deepEqual(a.rows(JK.doorReject), [])
  assert.deepEqual(a.timers(TAG.redial).length, 1, 'no new chain: bb is held over link 1')
  assert.equal(a.node.dialing('sim:bb'), false)
})

test('hygiene: no journal row ever carries a nonce or a proof — on either end, admitted or refused', () => {
  const a = rec('aa', { door: doorFor(44) }), b = rec('bb', { door: doorFor(45) }), x = rec('xx', { door: doorFor(46, 'wrong-secret-abc') })
  a.up(1, true, 'sim:bb'); b.up(1); pump(a, 1, b, 1)
  x.up(1, true, 'sim:bb'); b.up(2); pump(x, 1, b, 2)
  const secrets = new Set<string>()
  for (const n of [a, b, x]) for (const l of [1, 2]) for (const f of n.sends(l)) {
    const v = dec(f).value as { k?: string; p?: string }
    if (typeof v?.k === 'string') secrets.add(v.k)
    if (typeof v?.p === 'string') secrets.add(v.p)
  }
  assert.ok(secrets.size >= 5, `the handshakes minted nonces and proofs (${secrets.size})`)
  for (const n of [a, b, x]) for (const e of n.node.journal.read()) for (const f of [e.a, e.b, e.c]) if (typeof f === 'string') assert.ok(!secrets.has(f), `${n.node.uuid}: row ${e.kind} carries a secret value`)
  assert.deepEqual(b.rows(JK.doorReject), [[2, 'bad-proof', 'sim:xx']])
})

// ── §15 — the derived client key: clientMac on the door, picked by the DIALER's r:1 on both sides ──────
// A process that holds only the client key can follow but never prove as a member; a member answers a
// client with a client-key proof (the client holds nothing else). The toy derives its client key the way
// the api does (a MAC of the secret over 'fero/client/1'); real crypto is the api tier's.

const CLIENT_KEY = toyClientKey(SECRET)
const clientDoor = (seed: number, key = CLIENT_KEY) => toyClientDoor(key, mulberry32(seed))

test('the client key (§15): a client-key dialer is admitted r:1 and verifies the member\'s client-key answer; the same door without r:1 is bad-proof at the member; a member\'s uuid claim is uuid-taken; a holder that ACCEPTS a member\'s dial refuses its secret-proof; a secret-holding client still follows; a door without clientMac keeps the one-key rule; a client-key proof under r:true, \'1\', 2.5 or -1 is bad-proof (sign and the admit tail agree on exactly r === 1); a one-key V4-30 door and a two-key door do not link on a client link', () => {
  assert.notEqual(CLIENT_KEY, SECRET); assert.equal(CLIENT_KEY.length, PROOF_LEN, 'the toy key is one MAC long')
  assert.equal(toyDoor(SECRET, () => 0).clientMac!('m'), clientDoor(0).mac('m'), 'the member derives the key the client-only door is keyed with')
  assert.notEqual(toyDoor(SECRET, () => 0).mac('m'), toyDoor(SECRET, () => 0).clientMac!('m'), 'two keys, two proofs')
  //! 1/6 a client that holds ONLY the client key follows: admitted r:1 at the member; the member's answer is a
  // client-key proof, which the client verifies — it elects the member as its primary
  { const a = rec('aa', { door: doorFor(60) }), c = rec('cc', { client: true, hosts: ['sim:aa'], listen: '', door: clientDoor(61) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), c.rows(JK.doorReject)], [[], []], 'no refusal on either side')
    assert.deepEqual(a.node.admitted(), ['cc']); assert.equal(a.node.clientLinks.size, 1); assert.equal(a.node.links.get(1)!.client, true)
    assert.deepEqual(c.node.admitted(), ['aa']); assert.equal(c.node.primary, 1, 'the client verified the member\'s client-key answer and elected it')
    assert.deepEqual(verbs(a.sends(1)).slice(0, 2), [VERB.HELLO, VERB.DOOR], 'the member answered with a proof, not a notice') }
  //! 2/6 the same door on a node that omits r:1 (it poses as a member): the member checks the proof with the SECRET —
  // bad-proof, the notice, nothing admitted; the poser reads refused and parks the target
  { const a = rec('aa', { door: doorFor(62) }), x = rec('xx', { hosts: ['sim:aa'], door: clientDoor(63) })
    x.up(1, true, 'sim:aa'); a.up(1); pump(x, 1, a, 1)
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'bad-proof', 'sim:xx']]); assert.deepEqual(a.closes(), [[1, 'door']])
    assert.deepEqual(dec(a.sends(1)[1]).value, { e: 'denied' }); assert.deepEqual(a.node.admitted(), []); assert.equal(a.node.byUuid.has('xx'), false)
    assert.deepEqual(x.rows(JK.doorReject), [[1, 'refused', 'sim:aa']]); assert.deepEqual(x.node.admitted(), [])
    x.down(1, 'door'); assert.equal(x.node.dialing('sim:aa'), false, 'parked') }
  //! 3/6 a client-key dialer claiming a member's uuid: its client-key proof verifies, THEN the role rule refuses it
  // uuid-taken — exactly as a secret-holding client is refused; the member's link is never touched
  { const a = rec('aa', { door: doorFor(64), boot: VIEW1 }), c = rec('bb', { client: true, hosts: ['sim:aa'], listen: '', door: clientDoor(65) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'uuid-taken', 'bb']]); assert.deepEqual(a.rows(JK.dupLink), []); assert.equal(a.node.byUuid.has('bb'), false)
    assert.deepEqual(c.rows(JK.doorReject), [[1, 'uuid-taken', 'sim:aa']]); assert.deepEqual(c.node.admitted(), []) }
  //! 4/6 a client-key holder that ACCEPTS a member's dial (it listens where a member would): the member proves with the
  // secret, the holder can only check with the client key — bad-proof on the holder, a notice, never a proof of its own;
  // the member reads refused and admits nothing
  { const a = rec('aa', { door: doorFor(66), hosts: ['sim:xx'] }), x = rec('xx', { door: clientDoor(67) })
    a.up(1, true, 'sim:xx'); x.up(1); pump(a, 1, x, 1)
    assert.deepEqual(x.rows(JK.doorReject), [[1, 'bad-proof', 'sim:aa']]); assert.deepEqual(x.node.admitted(), [])
    assert.deepEqual(verbs(x.sends(1)), [VERB.HELLO, VERB.DOOR]); assert.deepEqual(dec(x.sends(1)[1]).value, { e: 'denied' }, 'the notice, never a proof')
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'refused', 'sim:xx']]); assert.deepEqual(a.node.admitted(), []) }
  //! 5/6 a client that holds the SECRET follows as before: it signs with the derived client key (its HELLO says r:1)
  // and the member checks with the same derivation
  { const a = rec('aa', { door: doorFor(68) }), c = rec('cc', { client: true, hosts: ['sim:aa'], listen: '', door: doorFor(69) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), c.rows(JK.doorReject)], [[], []]); assert.deepEqual(a.node.admitted(), ['cc']); assert.equal(c.node.primary, 1) }
  //! 6/8 an embedder's door with no clientMac keeps the one-key rule: a client and a member that both sign with mac link
  const one = (seed: number) => { const d = doorFor(seed); return { mac: d.mac, nonce: d.nonce } }
  { const a = rec('aa', { door: one(70) }), c = rec('cc', { client: true, hosts: ['sim:aa'], listen: '', door: one(71) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), c.rows(JK.doorReject)], [[], []]); assert.deepEqual(a.node.admitted(), ['cc']); assert.equal(c.node.primary, 1) }
  //! 7/8 the one rule the key rests on: `sign` picks the client key on EXACTLY r === 1, the same test the admit tail
  // makes a client link on. A raw dialer that holds only the client key and says r: true, '1', 2.5 or -1 (every
  // value a loosened truthy check would take) sends a client-key proof: the member checks it with the SECRET, so it
  // is bad-proof and nothing is admitted. Were the two tests to differ, such a dialer would be verified with the
  // client key and admitted as a MEMBER link (the skeptic's mutation M3). r: 2 is a DIAG attach, another path.
  for (const r of [true, '1', 2.5, -1]) {
    const a = rec('aa', { door: doorFor(72) })
    a.up(1)
    const k = 'x'.repeat(32), h = { u: 'xx', i: 1, l: '', r, k }
    a.feed(1, encodeControl(VERB.HELLO, h))
    const ah = dec(a.sends(1)[0]).value as { k: string; u: string; l: string }
    a.feed(1, encodeControl(VERB.DOOR, { p: clientDoor(73).mac(proofMsg('dialer', ah.k, k, ah.u, ah.l, h as never)) }))
    assert.deepEqual(a.rows(JK.doorReject), [[1, 'bad-proof', '']], `r=${JSON.stringify(r)}: ${JSON.stringify(a.rows(JK.doorReject))}`)
    assert.deepEqual(a.node.admitted(), [], `r=${JSON.stringify(r)}: admitted ${JSON.stringify(a.node.admitted())}`)
    assert.equal(a.node.byUuid.has('xx'), false); assert.deepEqual(a.closes(), [[1, 'door']])
  }
  //! 8/8 the version mix, stated so nobody is surprised: a V4-30 door (one key, the secret on every link) and a
  // two-key door do not link on a CLIENT link in either direction — the old client signs r:1 with the secret and the
  // new member checks with the client key, and the reverse — each reads bad-proof ("secrets differ"). Member links
  // (no r:1) still use the secret on both and are unaffected. V4-30 is unreleased, so nothing deployed is caught.
  { const a = rec('aa', { door: doorFor(74) }), c = rec('cc', { client: true, hosts: ['sim:aa'], listen: '', door: one(75) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), c.rows(JK.doorReject)], [[[1, 'bad-proof', '']], [[1, 'refused', 'sim:aa']]], 'old client, new member')
    assert.deepEqual([a.node.admitted(), c.node.admitted()], [[], []]) }
  { const a = rec('aa', { door: one(76) }), c = rec('cc', { client: true, hosts: ['sim:aa'], listen: '', door: doorFor(77) })
    c.up(1, true, 'sim:aa'); a.up(1); pump(c, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), c.rows(JK.doorReject)], [[[1, 'bad-proof', '']], [[1, 'refused', 'sim:aa']]], 'new client, old member')
    assert.deepEqual([a.node.admitted(), c.node.admitted()], [[], []]) }
  { const a = rec('aa', { door: doorFor(78) }), b = rec('bb', { hosts: ['sim:aa'], door: one(79) })
    b.up(1, true, 'sim:aa'); a.up(1); pump(b, 1, a, 1)
    assert.deepEqual([a.rows(JK.doorReject), b.rows(JK.doorReject)], [[], []], 'two members, one old: a member link is signed with the secret on both')
    assert.deepEqual([a.node.admitted(), b.node.admitted()], [['bb'], ['aa']]) }
})
