//! Tier-1 binding suite: Bind driven deterministically — a Runtime with NO network, its node fed
// hand-crafted frames exactly like the kernel suites, the $() proxy asserted on top. Pins the four
// contracts the api rests on: capture→ingest (assignment IS a write), apply→proxy (inbound records
// project, echo pre-consumed), the write-route join (V4-7: a forwarded write shows only as its
// stamped echo — no optimistic copy, nothing hides a foreign commit, a refusal shows nothing), and
// the echo discipline under re-entrant user writes (the probed substrate drain).

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

test('V4-7 NO GHOST — a forwarded write is NOT visible until the owner\'s commit echoes back; a foreign commit meanwhile projects straight through; the echo settles the join', async () => {
  const h = harness()
  h.admit(1, 'bb')
  //! commit view 1 over {aa, bb} so writes take the attempt path; place the partition on bb
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 1)
  h.node.writes.ring.place('cart', 'bb')

  h.bind.data.cart = { items: 1 }
  assert.equal(h.node.writes.pending.size, 1, 'forwarded — pending until the ACK')
  assert.equal(h.node.state.size, 0, 'the CONFIRMED fold does not have it')
  assert.deepEqual(snapshot(h.bind.data), {}, 'and neither does the proxy: a write shows when it commits, not before')
  //! the in-flight write is a pending row of cluster.writes — delivery state lives there, never in data
  assert.ok([...h.bind.outcomes.rows.values()].some((r) => r.key === JSON.stringify(['cart']) && r.state === 'pending'))

  //! a FOREIGN commit for the same cell lands while ours is in flight: it projects straight through —
  // the proxy is the fold, nothing hides a commit
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 1, [{ type: REC.update, key: ['cart'], value: { items: 99 } }]) })
  assert.deepEqual(h.node.state.get(cellOf({ type: 0, key: ['cart'] } as Rec)), { items: 99 }, 'kernel: confirmed fold advanced')
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 99 } }, 'proxy: the foreign commit shows')

  //! now OUR commit replicates back from the owner (attempt identity = our issuer lane, cid 1):
  // the join settles and the committed form shows — the first time this node sees its own write
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 2, 1, [{ type: REC.update, key: ['cart'], value: { items: 1 } }], 'aa~1', 1) })
  assert.equal(h.node.writes.pending.size, 0, 'replication IS the ACK')
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 1 } })
  //! a later foreign write projects through exactly the same way
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 3, 1, [{ type: REC.update, key: ['cart'], value: { items: 7 } }]) })
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 7 } })
  await h.destroy()
})

test('V4-7 NO GHOST — a delete of a cell with our own write in flight is NOT a no-op: the remove issues too', async () => {
  const h = harness()
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  h.node.writes.ring.place('cart', 'bb')
  //! absent everywhere: the delete is the v2-parity no-op (nothing issues)
  delete h.bind.data.cart
  assert.equal(h.node.writes.pending.size, 0, 'deleting an absent cell issues nothing')
  //! absent from the fold but on the wire: the delete must follow the update (before V4-7 the optimistic
  // copy made the cell present; now the lens asks the settlement index instead)
  h.bind.data.cart = { items: 1 }
  delete h.bind.data.cart
  assert.equal(h.node.writes.pending.size, 2, 'update + remove, both forwarded')
  //! the typed spelling agrees
  h.bind.data.cart = { items: 2 }
  h.bind.data.cart.remove()
  assert.equal(h.node.writes.pending.size, 4)
  assert.deepEqual(snapshot(h.bind.data), {}, 'and still nothing shows until the owner answers')
  await h.destroy()
})

test('V4-18 overlapping cells — our in-flight FIELD write loses to a newer whole-row write: the row\'s apply settles it (the join never fires for a swept record), and the proxy shows the row', async () => {
  const h = harness()
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  h.node.writes.ring.place('cart', 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 1, [{ type: REC.update, key: ['cart'], value: { items: 0 } }]) })
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 0 } })
  //! our field write forwards to the owner; its WACK clears the attempt and remembers the coordinates
  const [p] = h.bind.issue([{ type: REC.update, key: ['cart', 'items'], value: 1 }]) as Promise<unknown>[]
  assert.equal(h.node.writes.pending.size, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 2, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 0, 'WACKed — the kernel no longer holds the attempt')
  //! a whole-row write from another lane, stamped ABOVE our field's commit, lands BEFORE our echo:
  // the row is the parent of our cell, so this apply is the probe for our in-flight field write
  let settled: unknown = 'pending'
  p.then((v) => { settled = v }, (e) => { settled = e })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: records('cc', 9, 1, [{ type: REC.update, key: ['cart'], value: { items: 7 } }]) })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(settled, { origin: 'bb', seq: 2, epoch: 1, cid: 1 }, 'settled from the WACK\'s coordinates, on the owner\'s lane — it committed, then lost')
  //! the echo of our commit now arrives — refused across depth (subsumed), so it never projects
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 2, 1, [{ type: REC.update, key: ['cart', 'items'], value: 1 }], 'aa~1', 1) })
  assert.equal(h.jk(JK.subsumed).length, 1)
  assert.deepEqual(snapshot(h.bind.data), { cart: { items: 7 } }, 'the proxy shows the newer row, never our older field')
  assert.ok([...h.bind.outcomes.rows.values()].every((r) => r.state !== 'pending'), 'no row of cluster.writes is left pending')
  //! and when the window has no coordinates for it, the same probe says 'superseded'
  const [q] = h.bind.issue([{ type: REC.update, key: ['cart', 'qty'], value: 2 }]) as Promise<unknown>[]
  let out: unknown = 'pending'
  q.then((v) => { out = v }, (e) => { out = e })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 2, n: 1, s: 3, e: 1 }) })
  h.node.writes.reset() // the window forgot the coordinates (condemn's path) — nothing can vouch for the commit
  h.node.step({ kind: 'bytesIn', link: 2, bytes: records('cc', 10, 1, [{ type: REC.update, key: ['cart'], value: { items: 8 } }]) })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(out, 'superseded')
  await h.destroy()
})

test('V4-18 overlapping cells — on the epoch-0 fast path, removing the last field of a row that only fields made up settles committed: the kernel\'s seq-0 repair of the row is never mistaken for a foreign commit', async () => {
  const h = harness()
  const seqs = async (ps: unknown[]) => Promise.all(ps.map((p) => (p as Promise<{ seq: number }>).then((c) => c.seq, (e) => `rejected ${e}`)))
  //! a field write makes the row on the screen; removing that one field un-makes it (a seq-0 repair of
  // ['cart'] rides along) — and the remove's own promise resolves with ITS seq, not 'superseded'
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.update, key: ['cart', 'item'], value: 1 }])), [1])
  assert.deepEqual(snapshot(h.bind.data), { cart: { item: 1 } })
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.remove, key: ['cart', 'item'] }])), [2])
  assert.deepEqual(snapshot(h.bind.data), {}, 'the row only the field had made up is gone')
  //! one batch: remove a field, write its sibling — the repair after the remove must not reject the
  // sibling's still-pending promise; each settles positionally with its own seq
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.update, key: ['g', 'a'], value: 1 }])), [3])
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.remove, key: ['g', 'a'] }, { type: REC.update, key: ['g', 'b'], value: 2 }])), [4, 5])
  assert.deepEqual(snapshot(h.bind.data), { g: { b: 2 } })
  //! the repair's cell can be IN the batch too: [remove the field, remove the row] — the row's remove
  // settles with the kernel's stamp (seq 7), never with the repair's seq 0 (the fast-path collector
  // takes no settlement from a seq-0 apply)
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.update, key: ['h', 'a'], value: 1 }])), [6])
  assert.deepEqual(await seqs(h.bind.issue([{ type: REC.remove, key: ['h', 'a'] }, { type: REC.remove, key: ['h'] }])), [7, 8])
  assert.deepEqual(snapshot(h.bind.data), { g: { b: 2 } })
  assert.ok([...h.bind.outcomes.rows.values()].every((r) => r.state === 'committed'), 'every row of cluster.writes is committed')
  await h.destroy()
})

test('V4-18 overlapping cells — through data\'s real lane: a field written into a non-object row and then removed shows the row\'s value again, in all six arrival orders', async () => {
  const permutations = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))
  //! three lanes, one record each (bb the row at seq 3, cc the field at 5, dd the remove at 7), fed in every order
  for (const v of [5, null, 'txt', {}]) {
    const frames: [number, Uint8Array][] = [
      [1, records('bb', 3, 0, [{ type: REC.update, key: ['g'], value: v }])],
      [2, records('cc', 5, 0, [{ type: REC.update, key: ['g', 'b'], value: 1 }])],
      [3, records('dd', 7, 0, [{ type: REC.remove, key: ['g', 'b'] }])],
    ]
    for (const order of permutations(frames)) {
      const h = harness()
      h.admit(1, 'bb'); h.admit(2, 'cc'); h.admit(3, 'dd')
      for (const [link, bytes] of order) h.node.step({ kind: 'bytesIn', link, bytes })
      assert.deepEqual(snapshot(h.bind.data), { g: v }, `row ${JSON.stringify(v)}, order ${order.map((f) => f[0]).join(',')}`)
      await h.destroy()
    }
  }
})

test('M5a — issue() resolves coordinates: synchronously on the fast path, via the apply join when forwarded', async () => {
  const h = harness()
  //! fast path (epoch 0): coordinates resolve within the call
  const [fast] = h.bind.issue([{ type: REC.update, key: ['a'], value: 1 }])
  assert.ok(fast instanceof Promise)
  const c1 = await fast
  assert.equal(c1.origin, 'aa')
  assert.equal(c1.seq, 1)
  //! forwarded path: resolve only when the owner's commit replicates back
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  h.node.writes.ring.place('theirs', 'bb')
  const [fwd] = h.bind.issue([{ type: REC.update, key: ['theirs'], value: 2 }])
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

test('M5a VALIDATION — the seams hook covers assignment and direct issue alike; a rejected assignment never shows (nothing to bounce)', async () => {
  const h = harness({ validate: (rec) => (rec.key[0] === 'locked' || rec.at === 'locked' ? 'locked cells are read-only' : true) })
  //! seed a confirmed value for the locked cell from a peer
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [{ type: REC.insert, key: [], value: 'sealed', at: 'locked' }]) })
  assert.deepEqual(snapshot(h.bind.data), { locked: 'sealed' })
  //! the assignment is refused: nothing issues, and the visible value never changed
  h.bind.data.locked = 'overwritten'
  assert.equal(h.jk(JK.writeLocal).length, 0, 'nothing entered the pipeline')
  assert.deepEqual(snapshot(h.bind.data), { locked: 'sealed' }, 'the refused write never showed')
  //! direct issue rejects with the reason string
  const [r] = h.bind.issue([{ type: REC.update, key: ['locked'], value: 'x' }])
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
  const [pa] = h.bind.issue([{ type: REC.update, key: ['a'], value: 1 }])
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

test("V4-7 NO GHOST — the CLIENT role at the binding tier: a spoke's own write shows only as the server's stamped echo; a refusal shows nothing at all", async () => {
  //! a client Runtime driven by hand-crafted frames: aa is its primary (HELLO + DIGEST + VIEW)
  const rt = new Runtime({ uuid: 'zz', heartbeatMs: 0, client: true })
  const bind = new Bind(rt)
  const node = rt.node
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:aa' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa']] }) })
  const rows = () => [...bind.outcomes.rows.values()]
  //! the write is relayed (ae=0 attempt), nothing commits locally, nothing shows locally
  bind.data.k = 1
  assert.equal(node.writes.pending.size, 1, 'relayed — pending until the server answers')
  assert.equal(node.state.size, 0, 'a client never commits')
  assert.deepEqual(snapshot(bind.data), {}, 'no optimistic copy: the proxy is what the cluster holds')
  assert.ok(rows().some((r) => r.key === JSON.stringify(['k']) && r.state === 'pending'), 'cluster.writes carries the in-flight write')
  //! the server refuses it (a validator, or the methods door): the WNACK is terminal — the outcome row
  // reads the reason, the promise rejects, and the proxy never moved (the composer's fold calls sweep)
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'zz~1', c: 1, n: 1, r: 'invalid', m: 'reserved', ce: 1 }) })
  bind.sweep()
  await new Promise((r) => setImmediate(r))
  assert.equal(node.writes.pending.size, 0)
  assert.ok(rows().some((r) => r.key === JSON.stringify(['k']) && r.state === 'rejected' && r.reason === 'reserved'), 'the server\'s reason, verbatim')
  assert.deepEqual(snapshot(bind.data), {}, 'refused is invisible — there was nothing to bounce')
  //! an admitted write: the value shows exactly when the server's stamped record echoes back through the
  // spoke feed, attempt identity intact — the same apply every other node sees
  bind.data.k = 2
  assert.deepEqual(snapshot(bind.data), {}, 'still nothing before the echo')
  node.step({ kind: 'bytesIn', link: 1, bytes: records('aa', 1, 1, [{ type: REC.update, key: ['k'], value: 2 }], 'zz~1', 2) })
  assert.equal(node.writes.pending.size, 0, 'replication IS the ACK')
  assert.deepEqual(snapshot(bind.data), { k: 2 }, 'the echo painted it')
  await new Promise((r) => setImmediate(r))
  assert.ok(rows().some((r) => r.key === JSON.stringify(['k']) && r.state === 'committed' && r.origin === 'aa'), 'stamped under the server')
  bind.destroy()
  await rt.destroy()
})
