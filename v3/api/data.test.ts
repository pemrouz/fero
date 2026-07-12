//! Tier-1 binding suite: Bind driven deterministically — a Runtime with NO network, its node fed
// hand-crafted frames exactly like the kernel suites, the $() proxy asserted on top. Pins the four
// contracts the api rests on: capture→ingest (assignment IS a write), apply→proxy (inbound records
// project, echo pre-consumed), the cid-overlay (read-your-writes over foreign commits, release on own
// commit), and the echo discipline under re-entrant user writes (the probed substrate drain).

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind, cellOf } from './data.ts'
import { snapshot } from './substrate.ts'
import { JK } from '../kernel/journal.ts'
import { VERB, encodeControl, encodeRuns } from '../kernel/codec.ts'
import { REC, type Rec } from '../kernel/env.ts'

//! a Runtime with no listen/hosts: real timers exist but nothing fires network-side; the node is
// driven by direct step() calls (linkUp/HELLO/DIGEST/VOTE frames — the kernel-suite idiom)
const harness = (opts: { validate?: (rec: Rec) => true | string } = {}) => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const bind = new Bind(rt, opts)
  const node = rt.node
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  return { rt, bind, node, admit, jk, destroy: () => { bind.destroy(); return rt.destroy() } }
}

//! a committed replication frame from a peer (origin bb), optionally carrying attempt identity
const records = (origin: string, s0: number, epoch: number, recs: Rec[], iss?: string, cid0?: number): Uint8Array =>
  encodeRuns(recs.map((rec, i) => ({ rec, origin, seq: s0 + i, epoch, iss, cid: cid0 !== undefined ? cid0 + i : undefined })))[0]

test('assignment IS a write: the capture sink feeds the kernel, state and proxy agree, nothing echoes back out', async () => {
  const h = harness()
  h.bind.data.user42 = { active: true }
  h.bind.data.user42.name = 'ada'
  delete h.bind.data.gone // no-op remove of an absent key: substrate filters it, nothing must issue
  //! cells are FIELD-GRANULAR (the kernel's version keys): the root insert and the nested update
  // are two cells — ['user42'] and ['user42','name']
  assert.equal(h.node.state.size, 2, 'epoch-0 fast path committed synchronously, one cell per record')
  assert.equal(h.node.state.get(cellOf({ type: 0, key: ['user42', 'name'] } as Rec)), 'ada')
  assert.equal(h.jk(JK.writeLocal).length, 2, 'exactly the two user writes — no echo re-issues')
  assert.deepEqual(snapshot(h.bind.data), { user42: { active: true, name: 'ada' } })
  await h.destroy()
})

test('a remove round-trips: delete on the proxy commits a remove; the echo (which carries the old value) is consumed, not re-issued', async () => {
  const h = harness()
  h.bind.data.k = { v: 1 }
  delete h.bind.data.k
  assert.equal(h.node.state.size, 0)
  assert.equal(h.jk(JK.writeLocal).length, 2, 'update + remove, nothing else')
  assert.deepEqual(snapshot(h.bind.data), {})
  await h.destroy()
})

test('inbound records project into the proxy and NEVER re-issue (the echo is consumed by cell + ref)', async () => {
  const h = harness()
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [
    { type: REC.insert, key: [], value: { active: false }, at: 'u9' },
    { type: REC.update, key: ['u9', 'name'], value: 'grace' },
  ]) })
  assert.deepEqual(snapshot(h.bind.data), { u9: { active: false, name: 'grace' } })
  assert.equal(h.jk(JK.writeLocal).length, 0, 'zero local writes — the echo discipline held')
  assert.equal(h.node.writes.pending.size, 0)
  //! and an inbound remove projects too (echo carries the old value — matched by type, not ref)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 3, 0, [{ type: REC.remove, key: ['u9'] }]) })
  assert.deepEqual(snapshot(h.bind.data), {})
  assert.equal(h.jk(JK.writeLocal).length, 0)
  await h.destroy()
})

test('a re-entrant user write from a tap reacting to an inbound apply IS captured (drained inside the apply — the probed substrate contract)', async () => {
  const h = harness()
  h.admit(1, 'bb')
  h.bind.data.tap((c: { at?: string }) => { if (c.at === 'poke') h.bind.data.reaction = 'observed' })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [{ type: REC.insert, key: [], value: 1, at: 'poke' }]) })
  assert.equal(h.jk(JK.writeLocal).length, 1, "the tap's write issued as a genuine local write")
  assert.deepEqual(snapshot(h.bind.data), { poke: 1, reaction: 'observed' })
  assert.equal(h.node.state.size, 2, 'both cells committed')
  await h.destroy()
})

test('M5a OVERLAY — a forwarded write stays visible over foreign commits and releases on its OWN commit (read-your-writes)', async () => {
  const h = harness()
  h.admit(1, 'bb')
  //! commit view 1 over {aa, bb} so writes take the attempt path; place the partition on bb
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 1)
  h.node.writes.ring.place('cart', 'bb')

  h.bind.data.cart = { items: 1 }
  assert.equal(h.node.writes.pending.size, 1, 'forwarded — pending until the ACK')
  assert.equal(h.node.state.size, 0, 'the CONFIRMED fold does not have it')
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 1 } }, 'the proxy DOES — the pending layer')

  //! a FOREIGN commit for the same cell lands while ours is in flight: the kernel folds it, the
  // proxy holds our pending value on top
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 1, [{ type: REC.update, key: ['cart'], value: { items: 99 } }]) })
  assert.deepEqual(h.node.state.get(cellOf({ type: 0, key: ['cart'] } as Rec)), { items: 99 }, 'kernel: confirmed fold advanced')
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 1 } }, 'proxy: our write still layers over')

  //! now OUR commit replicates back from the owner (attempt identity = our issuer lane, cid 1):
  // the overlay releases and the committed form shows through
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 2, 1, [{ type: REC.update, key: ['cart'], value: { items: 1 } }], 'aa~1', 1) })
  assert.equal(h.node.writes.pending.size, 0, 'replication IS the ACK')
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 1 } })
  //! a later foreign write now projects straight through (no overlay left)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 3, 1, [{ type: REC.update, key: ['cart'], value: { items: 7 } }]) })
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 7 } })
  await h.destroy()
})

test('M5a OVERLAY — issue() resolves coordinates: synchronously on the fast path, via the apply join when forwarded', async () => {
  const h = harness()
  //! fast path (epoch 0): coordinates resolve within the call
  const [fast] = h.bind.issue([{ type: REC.update, key: ['a'], value: 1 }], false)
  assert.ok(fast instanceof Promise)
  const c1 = await fast
  assert.equal(c1.origin, 'aa')
  assert.equal(c1.seq, 1)
  //! forwarded path: resolve only when the owner's commit replicates back
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  h.node.writes.ring.place('theirs', 'bb')
  const [fwd] = h.bind.issue([{ type: REC.update, key: ['theirs'], value: 2 }], false)
  let settled = false
  ;(fwd as Promise<unknown>).then(() => { settled = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, 'unsettled while the attempt is in flight')
  const cid = h.node.writes.cid
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 5, 1, [{ type: REC.update, key: ['theirs'], value: 2 }], 'aa~1', cid) })
  const c2 = await (fwd as Promise<{ origin: string; seq: number; cid?: number }>)
  assert.equal(c2.origin, 'bb', 'stamped under the OWNER')
  assert.equal(c2.seq, 5)
  assert.equal(c2.cid, cid)
  await h.destroy()
})

test('M5a VALIDATION — the seams hook covers assignment and direct issue alike; a rejected assignment BOUNCES (reverts to the confirmed fold)', async () => {
  const h = harness({ validate: (rec) => (rec.key[0] === 'locked' || rec.at === 'locked' ? 'locked cells are read-only' : true) })
  //! seed a confirmed value for the locked cell from a peer
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [{ type: REC.insert, key: [], value: 'sealed', at: 'locked' }]) })
  assert.deepEqual(snapshot(h.bind.data), { locked: 'sealed' })
  //! the assignment is refused: nothing issues, and the visible value SNAPS BACK
  h.bind.data.locked = 'overwritten'
  assert.equal(h.jk(JK.writeLocal).length, 0, 'nothing entered the pipeline')
  assert.deepEqual(snapshot(h.bind.data), { locked: 'sealed' }, 'the bounce reverted the cell')
  //! direct issue rejects with the reason string
  const [r] = h.bind.issue([{ type: REC.update, key: ['locked'], value: 'x' }], false)
  assert.equal(r, 'locked cells are read-only')
  //! unlocked writes pass
  h.bind.data.open = 1
  assert.equal(h.jk(JK.writeLocal).length, 1)
  await h.destroy()
})

test('destroy detaches synchronously: post-destroy assignments stay local to the proxy, applies stop projecting', async () => {
  const h = harness()
  h.bind.data.before = 1
  assert.equal(h.node.state.size, 1)
  h.bind.destroy()
  h.bind.data.after = 2
  assert.equal(h.node.state.size, 1, 'no capture after detach')
  assert.equal(h.jk(JK.writeLocal).length, 1)
  await h.rt.destroy()
})

test('M5-REVIEW #0/#1/#4 — a re-entrant tap write during an epoch-0 fast-path write never orphans or mis-rejects the outer batch', async () => {
  const h = harness()
  //! a tap mirroring cell a into cell b: fires during the apply of an 'a' write, issuing a NESTED
  // fast-path write that re-uses the SAME predicted cid (the fast path mints none)
  h.bind.data.tap((c: { at?: string; key?: string[] }) => {
    if ((c.at === 'a' || c.key?.[0] === 'a')) h.bind.data.b = 'mirror'
  })
  //! single-record outer write (finding #0): the outer promise MUST resolve, not orphan
  const [pa] = h.bind.issue([{ type: REC.update, key: ['a'], value: 1 }], false)
  const settledA = await Promise.race([
    (pa as Promise<{ seq: number }>).then((c) => `ok:${c.seq}`, (e) => `rej:${e}`),
    new Promise((r) => setTimeout(() => r('ORPHANED'), 300)),
  ])
  assert.match(String(settledA), /^ok:/, 'the outer a-write resolved (not orphaned)')
  assert.equal(snapshot(h.bind.data).b, 'mirror', 'the re-entrant mirror committed too')
  assert.equal(snapshot(h.bind.data).a, 1)

  //! multi-record outer batch (findings #1/#4): every record settles committed, none spuriously 'superseded'
  const h2 = harness()
  h2.bind.data.tap((c: { at?: string; key?: string[] }) => {
    if (c.at === 'x' || c.key?.[0] === 'x') h2.bind.data.z = 'from-tap'
  })
  const outs = h2.bind.issue([
    { type: REC.update, key: ['x'], value: 10 },
    { type: REC.update, key: ['y'], value: 20 },
  ], false)
  const rs = await Promise.all(outs.map((o) => Promise.race([
    (o as Promise<{ seq: number }>).then((c) => ({ ok: true, seq: c.seq }), (e) => ({ ok: false, e: String(e) })),
    new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: false }), 300)),
  ])))
  assert.ok(rs.every((r) => r.ok), `both records committed, none mis-rejected: ${JSON.stringify(rs)}`)
  assert.equal(snapshot(h2.bind.data).x, 10)
  assert.equal(snapshot(h2.bind.data).y, 20)
  assert.equal(snapshot(h2.bind.data).z, 'from-tap')
  await h.destroy(); await h2.destroy()
})
