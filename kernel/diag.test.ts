//! ── kernel/diag.test — the DIAG plane: latch, denies, structural non-membership, cursors, parity ──
// Pins DESIGN-M7 §1: the r:2 HELLO latch (one branch in the safety-critical HELLO path), the
// constant wire deny vs the typed journal reason, the used-link guard (an admitted link can never be
// hijacked into LS.diag), the spoof-immunity (byUuid untouched — the dup-link keeper can never evict a
// member on a diag client's word), the chunked journal/logs cursors with triple-surfaced loss, and the
// captureNode ⇄ diagNode parity (one fold, two consumers). Drives the kernel by hand-crafted events
// against a recording sink — the write.test.ts/scoped.test.ts idiom.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK, type JEvent } from './journal.ts'
import { LS } from './link.ts'
import { VERB, Framer, encodeControl, type Frame } from './codec.ts'
import { DIAG_P, diagNode } from './diag.ts'
import { REC, TAG, type EffectSink, type Env } from './env.ts'
import { captureNode } from '../tools/debug/capture.ts'

const TOKEN = 'secret-token-abc'

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
  node.step({ kind: 'start' })
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  //! decode every frame shipped on one link, in order (each ship is a complete frame)
  const frames = (link: number): Frame[] => {
    const fr = new Framer()
    const out: Frame[] = []
    for (const e of of('send')) if (e[1] === link) for (const f of fr.push(e[2] as Uint8Array)) out.push(f)
    return out
  }
  const lastA = (link: number): Record<string, unknown> => {
    const da = frames(link).filter((f) => f.verb === VERB.DIAGA)
    assert.ok(da.length, `expected a DIAGA on link ${link}`)
    return da[da.length - 1].value as Record<string, unknown>
  }
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
  }
  const attach = (link: number, hello: Record<string, unknown> = {}) =>
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u: 'dbg', i: 1, l: '', r: 2, t: TOKEN, ...hello }) })
  const open = (link: number) => node.step({ kind: 'linkUp', link, dialed: false })
  const q = (link: number, body: Record<string, unknown>) =>
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIAGQ, body) })
  return { node, effects, of, jk, frames, lastA, admit, attach, open, q }
}
const diagged = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) =>
  harness('aa', { diag: { allow: { ops: TOKEN } }, ...opts })

test('the wire constants are pinned: verbs 23/24, LS.diag 2, JK 68-70', () => {
  assert.equal(VERB.DIAGQ, 23)
  assert.equal(VERB.DIAGA, 24)
  assert.equal(LS.diag, 2)
  assert.equal(JK.diagAuth, 68)
  assert.equal(JK.diagDeny, 69)
  assert.equal(JK.diagPull, 70)
})

test('latch happy path: ACCEPT {id:0, ok, u, i, p}, LS.diag, diagAuth by NAME — membership untouched', () => {
  const h = diagged()
  h.open(9)
  h.attach(9)
  const a = h.lastA(9)
  assert.deepEqual(a, { id: 0, ok: 1, u: 'aa', i: 1, p: DIAG_P })
  const link = h.node.links.get(9)!
  assert.equal(link.state, LS.diag)
  assert.equal(link.uuid, '', 'a diag session never takes a peer identity')
  assert.equal(h.node.byUuid.has('dbg'), false, 'never enters byUuid')
  assert.equal(h.node.clientLinks.size, 0, 'never enters clientLinks')
  assert.deepEqual(h.node.admitted(), [], 'never admitted')
  assert.deepEqual(h.jk(JK.diagAuth).map((e) => [e.a, e.b]), [[9, 'ops']], 'audited by allowlist NAME')
  assert.equal(h.of('close').length, 0, 'the session stays open')
})

test('every deny: ONE constant wire reason, the typed truth journal-only, the token never journaled', () => {
  //! no config — the channel is dead by default (fail closed)
  const h1 = harness('aa')
  h1.open(9); h1.attach(9)
  assert.deepEqual(h1.lastA(9), { id: 0, ok: 0, e: 'denied' }, 'deny carries NO state, NO reason detail')
  assert.deepEqual(h1.jk(JK.diagDeny).map((e) => e.b), ['no-config'])
  assert.ok(h1.of('close').some((c) => c[1] === 9 && c[2] === 'diag-denied'))
  //! bad token
  const h2 = diagged()
  h2.open(9); h2.attach(9, { t: 'wrong-token-xxxx' })
  assert.deepEqual(h2.lastA(9), { id: 0, ok: 0, e: 'denied' })
  assert.deepEqual(h2.jk(JK.diagDeny).map((e) => e.b), ['bad-token'])
  //! malformed (token missing) — and the wire verdict is byte-identical to every other deny
  const h3 = diagged()
  h3.open(9); h3.attach(9, { t: undefined })
  assert.deepEqual(h3.lastA(9), { id: 0, ok: 0, e: 'denied' })
  assert.deepEqual(h3.jk(JK.diagDeny).map((e) => e.b), ['malformed'])
  //! the presented token appears in NO journal row of any trajectory above
  for (const h of [h1, h2, h3])
    for (const e of h.node.journal.read())
      for (const f of [e.a, e.b, e.c])
        assert.ok(typeof f !== 'string' || !f.includes(TOKEN.slice(0, 6)), 'token material must never ride the journal')
})

test('used-link guard: r:2 on an ADMITTED link closes it without ghosting byUuid; re-HELLO on LS.diag closes', () => {
  const h = diagged()
  h.admit(3, 'bb')
  assert.deepEqual(h.node.admitted(), ['bb'])
  //! the member link tries to convert to a diag session with a VALID token — refused, identity intact
  h.attach(3)
  assert.equal(h.node.byUuid.get('bb'), 3, 'byUuid mapping survives the refused hijack')
  assert.equal(h.jk(JK.diagAuth).length, 0, 'no latch')
  assert.ok(h.of('close').some((c) => c[1] === 3 && c[2] === 'diag-denied'))
  //! a latched session re-HELLOing is equally dead
  const h2 = diagged()
  h2.open(9); h2.attach(9)
  assert.equal(h2.node.links.get(9)!.state, LS.diag)
  h2.attach(9)
  assert.ok(h2.of('close').some((c) => c[1] === 9 && c[2] === 'diag-denied'), 're-HELLO on a diag session closes it')
})

test('spoof immunity: a diag HELLO presenting a MEMBER uuid latches without touching the member', () => {
  const h = diagged()
  h.admit(3, 'bb')
  h.open(9)
  h.attach(9, { u: 'bb' }) // the spoof: a valid token + a real member's uuid
  assert.equal(h.node.links.get(9)!.state, LS.diag, 'latched as a session')
  assert.equal(h.node.byUuid.get('bb'), 3, 'the member keeps its link — the dup-link keeper never ran')
  assert.equal(h.node.links.get(3)!.dead, false, 'member link alive')
  //! and the session's death fires no membership/scope effect (uuid was never taken)
  h.node.step({ kind: 'linkDown', link: 9, reason: 'closed' })
  assert.equal(h.node.byUuid.get('bb'), 3)
  assert.deepEqual(h.node.admitted(), ['bb'])
})

test('the verb lattice: DIAGQ pre-latch closes; RECORDS on LS.diag closes; DIAGA at a node drops frame only; PING answers', () => {
  //! DIAGQ before any latch = records-before-hello shape
  const h = diagged()
  h.open(9)
  h.q(9, { id: 1, q: 'meta' })
  assert.ok(h.jk(JK.frameDrop).some((e) => e.b === 'diagq outside session'))
  assert.ok(h.of('close').some((c) => c[1] === 9 && c[2] === 'diag-denied'))
  //! an admitted-plane verb on a latched session is closed by the existing identity guards
  const h2 = diagged()
  h2.open(9); h2.attach(9)
  h2.node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  assert.ok(h2.of('close').some((c) => c[1] === 9), 'admitted-only verbs close a diag session')
  //! DIAGA arriving at a node: confused client — drop the frame, KEEP the link
  const h3 = diagged()
  h3.open(9); h3.attach(9)
  const closes = h3.of('close').length
  h3.node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.DIAGA, { id: 1, ok: 1 }) })
  assert.ok(h3.jk(JK.frameDrop).some((e) => e.b === 'unexpected diaga'))
  assert.equal(h3.of('close').length, closes, 'link survives')
  //! PING is state-blind — the attacher heartbeats its session
  h3.node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.PING) })
  assert.ok(h3.frames(9).some((f) => f.verb === VERB.PONG))
})

test('journal cursor: triple-surfaced loss, exact resumed reassembly, silent (never journaled) pulls', () => {
  const h = diagged({ journalCap: 16 })
  h.open(9); h.attach(9)
  //! overflow the 16-cap ring far past the cursor
  for (let i = 0; i < 40; i++) h.node.journal.emit(JK.ping, i)
  const n = h.node.journal.n
  const pullsBefore = h.jk(JK.diagPull).length
  h.q(9, { id: 2, q: 'journal', f: 0 })
  const a = h.lastA(9)
  assert.equal(a.ok, 1)
  assert.equal(a.t, n)
  assert.equal(a.f0, n - 16, 'the answer starts where retention starts')
  assert.equal(a.lost, n - 16, 'loss below the cursor is named, never spliced')
  assert.equal((a.ev as unknown[][]).length, 16)
  //! chunked resume: n:5 pages reassemble journal.read(f0) EXACTLY
  const got: unknown[][] = []
  let f = a.f0 as number
  for (let id = 3; ; id++) {
    h.q(9, { id, q: 'journal', f, n: 5 })
    const page = h.lastA(9)
    got.push(...(page.ev as unknown[][]))
    if (page.next === undefined) break
    f = page.next as number
  }
  assert.deepEqual(got, h.node.journal.read(0).map((e: JEvent) => [e.t, e.kind, e.a, e.b, e.c]))
  //! a cursor past the head answers empty, losing nothing
  h.q(9, { id: 99, q: 'journal', f: n + 100 })
  const past = h.lastA(9)
  assert.deepEqual([past.ev, past.lost], [[], 0])
  //! the eviction rule: journal pulls emit NOTHING (reads-of-the-journal must not evict the journal)
  assert.equal(h.jk(JK.diagPull).length, pullsBefore, 'q:journal is never journaled')
})

test('logs cursor: exclusive f, chunking via next, tail semantics, typed bad-op/bad-args keep the session', () => {
  const h = diagged()
  h.open(9); h.attach(9)
  for (let i = 0; i < 5; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  h.q(9, { id: 2, q: 'logs', o: 'aa', f: 0, n: 2 })
  let a = h.lastA(9)
  assert.equal(a.ok, 1)
  assert.equal(a.tail, 5)
  assert.equal((a.ev as unknown[]).length, 2)
  assert.equal(a.next, 2, 'next = last served seq (the EXCLUSIVE cursor to resume from)')
  //! resume to exhaustion, f exclusive throughout
  h.q(9, { id: 3, q: 'logs', o: 'aa', f: a.next as number })
  a = h.lastA(9)
  assert.deepEqual((a.ev as { s: number }[]).map((e) => e.s), [3, 4, 5])
  assert.equal(a.next, undefined)
  //! pulling from the tail answers empty (caught up, tail === f — distinguishable from compaction where tail > f)
  h.q(9, { id: 4, q: 'logs', o: 'aa', f: 5 })
  assert.deepEqual((h.lastA(9).ev as unknown[]), [])
  //! diagPull audited for the data-bearing read
  assert.ok(h.jk(JK.diagPull).some((e) => e.b === 'logs'))
  //! typed degradation: unknown op / missing args keep the link
  const closes = h.of('close').length
  h.q(9, { id: 5, q: 'wal' })
  assert.equal(h.lastA(9).e, 'bad-op')
  h.q(9, { id: 6, q: 'logs' })
  assert.equal(h.lastA(9).e, 'bad-args')
  h.q(9, { q: 'meta' }) // id missing entirely
  assert.equal(h.lastA(9).e, 'bad-args')
  assert.equal(h.of('close').length, closes, 'typed answers, never closes')
})

test('meta + node + state: self-describing vocab, the shared fold, atomic state with its hash', () => {
  const h = diagged()
  h.open(9); h.attach(9)
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['x'], value: { deep: [1, 'two'] } }] })
  h.q(9, { id: 2, q: 'meta' })
  const m = h.lastA(9)
  assert.deepEqual(m.vocab, JK, 'the node serves its OWN vocabulary — captures stay self-describing')
  assert.equal(m.p, DIAG_P)
  h.q(9, { id: 3, q: 'node' })
  const n = h.lastA(9).n as ReturnType<typeof diagNode>
  //! jn is the journal HEAD — it moves with the pull's own audit row, so compare the fold minus the clock
  const { jn: _a, ...wireN } = n
  const { jn: _b, ...localN } = diagNode(h.node)
  assert.deepEqual(wireN, localN, 'the wire serves THE fold')
  assert.equal(n.origins.aa.tail, 1)
  h.q(9, { id: 4, q: 'state' })
  const s = h.lastA(9)
  assert.equal(s.sh, h.node.stateHash)
  assert.deepEqual(s.cells, [...h.node.state])
  //! every reply carried the restart-detection echo
  for (const f of h.frames(9).filter((x) => x.verb === VERB.DIAGA).slice(1))
    assert.deepEqual([(f.value as { u: string }).u, (f.value as { i: number }).i], ['aa', 1])
})

test('seqs (DIAG_P 2): one origin\'s seq list, exclusive f, paged by next, typed bad-args — and never journaled (wave 5e)', () => {
  const h = diagged()
  h.open(9); h.attach(9)
  for (let i = 0; i < 5; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.ok(DIAG_P >= 2, 'the version says the op exists')
  const before = h.jk(JK.diagPull).length
  h.q(9, { id: 2, q: 'seqs', o: 'aa', f: 0 })
  let a = h.lastA(9)
  assert.deepEqual([a.ok, a.tail, a.s, a.next], [1, 5, [1, 2, 3, 4, 5], undefined], 'every seq in the book, ascending')
  h.q(9, { id: 3, q: 'seqs', o: 'aa', f: 3 })
  assert.deepEqual(h.lastA(9).s, [4, 5], 'f is exclusive, like the logs cursor')
  h.q(9, { id: 4, q: 'seqs', o: 'nobody', f: 0 })
  a = h.lastA(9)
  assert.deepEqual([a.ok, a.tail, a.s], [1, 0, []], 'an origin it never saw: an empty book')
  h.q(9, { id: 5, q: 'seqs' })
  assert.equal(h.lastA(9).e, 'bad-args')
  assert.equal(h.jk(JK.diagPull).length, before, 'asked at follow cadence, so never journaled')
})

test('state pages (DIAG_P 2): cells [f, f+n) with the torn-snapshot marker (sh, sz) on every page; a write between pages moves the marker (wave 5e)', () => {
  const h = diagged()
  h.open(9); h.attach(9)
  for (let i = 0; i < 5; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  const all = [...h.node.state]
  const pulls = h.jk(JK.diagPull).length
  h.q(9, { id: 2, q: 'state', f: 0, n: 2 })
  let a = h.lastA(9)
  assert.deepEqual([a.f, a.cells, a.next, a.sz, a.sh], [0, all.slice(0, 2), 2, 5, h.node.stateHash], 'the first page, with its marker and next')
  assert.deepEqual(h.jk(JK.diagPull).slice(pulls).map((e) => [e.b, e.c]), [['state', 2]], 'the first page is audited on its own: a reader that stops early still leaves its row')
  h.q(9, { id: 3, q: 'state', f: 2, n: 2 })
  assert.deepEqual(h.lastA(9).cells, all.slice(2, 4))
  const sh0 = h.node.stateHash
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['late'], value: 9 }] })
  h.q(9, { id: 4, q: 'state', f: 4, n: 2 })
  a = h.lastA(9)
  assert.ok(a.sh !== sh0 && a.sz === 6, 'the marker moved: the pages are not one instant')
  assert.deepEqual([a.cells, a.next], [[...h.node.state].slice(4, 6), undefined], 'the last page')
  assert.deepEqual(h.jk(JK.diagPull).slice(pulls).map((e) => [e.b, e.c]), [['state', 2], ['state', 2], ['state', 2]], 'one audit row per page, with its cell count')
  //! no n: the whole map, the pre-5e answer every older bridge asks
  h.q(9, { id: 5, q: 'state' })
  a = h.lastA(9)
  assert.deepEqual([a.cells, a.sz], [[...h.node.state], undefined])
})

test('parity by construction: captureNode is diagNode + the chunked planes (deepEqual, kinds ≥ 68 filtered)', () => {
  const h = diagged()
  h.admit(3, 'bb')
  for (let i = 0; i < 3; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  h.open(9); h.attach(9)
  h.q(9, { id: 2, q: 'node' })
  const wire = h.lastA(9).n as ReturnType<typeof diagNode>
  const cap = captureNode(h.node)
  //! every scalar/topology fact in the capture IS the wire's fold output — one producer, two consumers
  for (const k of ['uuid', 'listen', 'seq', 'epoch', 'view', 'gate', 'pendingWrites', 'client', 'replicas', 'holders', 'stateHash', 'streams'] as const)
    assert.deepEqual(cap[k], wire[k], `capture.${k} must equal the wire fold's`)
  assert.deepEqual(cap.links, wire.links)
  assert.equal(cap.dropped, wire.dropped)
})

//! scoped replication (ISSUES I-3): an ARMED node's fold carries replicas and, per partition of its OWN lane,
// the ring's holder set — over the wire and in the capture alike. An unarmed node carries no holders at all.
test('an armed node serves replicas + its own-lane holder sets (the ring\'s answer, carried); an unarmed node serves none', () => {
  const plain = diagged()
  assert.equal(diagNode(plain.node).replicas, 0)
  assert.equal('holders' in diagNode(plain.node), false, 'unscoped: no holder claim')
  const h = diagged({ replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } })
  h.admit(1, 'bb'); h.admit(2, 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.armed, true)
  //! pin two partitions to aa (the test-only placement seam) so its own writes stamp locally
  h.node.writes.ring.place('p1', 'aa', 'cc')
  h.node.writes.ring.place('p2', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['p1', 'x'], value: 1 }] })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['p2'], value: 2 }] })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['p1', 'y'], value: 3 }] })
  h.open(9); h.attach(9)
  h.q(9, { id: 2, q: 'node' })
  const wire = h.lastA(9).n as ReturnType<typeof diagNode>
  assert.equal(wire.replicas, 2)
  assert.deepEqual(wire.holders, { p1: ['aa', 'cc'], p2: ['aa', 'bb'] }, 'one entry per own-lane partition, the ring\'s list')
  assert.deepEqual(captureNode(h.node).holders, wire.holders, 'the capture carries the same fact')
  //! held (wave 5e): the partitions its scope machine holds — the debugger's per-row participants
  assert.deepEqual(wire.held, ['p1', 'p2'], 'both rows it holds, sorted')
  assert.deepEqual(captureNode(h.node).held, wire.held)
  assert.equal('held' in diagNode(plain.node), false, 'unscoped: no held claim')
  assert.equal('feeder' in wire, false, 'a member names no feeder')
})

test('a client serves its feeder: the uuid on its primary link, null before it has one (wave 5e)', () => {
  const c = diagged({ client: true, hosts: ['sim:bb'] })
  assert.equal(diagNode(c.node).feeder, null, 'no primary yet')
  c.admit(1, 'bb')
  assert.equal(diagNode(c.node).feeder, 'bb', 'the primary\'s uuid')
  assert.equal(captureNode(c.node).feeder, 'bb', 'the capture carries the same fact')
})

test('structural non-membership: a live session sees ZERO replication bytes while members converge', () => {
  const h = diagged()
  h.open(9); h.attach(9)
  h.admit(3, 'bb')
  const before = h.frames(9).length
  //! local writes fan out to admitted+synced peers and synced clients — never to LS.diag
  for (let i = 0; i < 4; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(h.frames(9).length, before, 'no RECORDS, no digests, nothing — the session is pull-only')
  assert.deepEqual(h.node.admitted(), ['bb'], 'membership never saw the attacher')
})

test('inertness: the diag CONFIG alone changes no trajectory (journals byte-identical ± allowlist)', () => {
  const run = (diag?: { allow: Record<string, string> }) => {
    const h = harness('aa', diag ? { diag } : {})
    h.admit(3, 'bb')
    for (let i = 0; i < 6; i++) h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
    h.node.step({ kind: 'linkDown', link: 3, reason: 'closed' })
    return h.node.journal.read()
  }
  assert.deepEqual(run({ allow: { ops: TOKEN } }), run(), 'config without an r:2 HELLO is invisible')
})
