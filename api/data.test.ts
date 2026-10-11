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
const harness = (opts: { validate?: (rec: Rec) => true | string; onFault?: (e: unknown) => void } = {}) => {
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

//! the user's own code throws inside the apply hook (data runs views and taps as each commit closes, AFTER
// the record landed — its SCHEDULE clause 4). Before the fix the throw escaped into the kernel's step: on an
// inbound frame the rest of the frame never folded, and the step threw (in a process: an uncaught exception
// out of the socket handler, exit code 1). Now it goes to onFault and the step runs to its end.
test('a view or a tap that throws on an inbound record never cuts the step short: the whole frame folds, kernel and proxy agree, and the failure goes to onFault', async () => {
  const faults: unknown[] = []
  const h = harness({ onFault: (e) => faults.push(e) })
  h.admit(1, 'bb')
  const hungry = h.bind.data.filter((c: { mood: string }) => c.mood === 'hungry') // throws on a null row
  h.bind.data.tap(() => { if ((snapshot(h.bind.data) as Record<string, unknown>).mochi === null) throw new Error('the tap trips on mochi') })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [
    { type: REC.update, key: ['mochi'], value: null },
    { type: REC.update, key: ['luna'], value: { mood: 'hungry' } },
  ]) })
  assert.equal(h.node.state.size, 2, 'both records folded in the kernel')
  assert.deepEqual(snapshot(h.bind.data), { mochi: null, luna: { mood: 'hungry' } }, 'and both show')
  assert.deepEqual(snapshot(hungry), { luna: { mood: 'hungry' } }, 'the filter left the bad row out and kept the good one')
  //! one data commit per record: the first failed in the filter AND the tap, the second in the tap again
  assert.equal(faults.length, 2)
  const msgs = faults.map((f) => (f as AggregateError).errors.map((x: Error) => x.message))
  assert.deepEqual(msgs, [
    ['data: filter threw on row "mochi" — left out of that view until the row changes', 'the tap trips on mochi'],
    ['the tap trips on mochi'],
  ])
  //! the next frame folds as ever, and the row comes back when it changes
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 3, 0, [{ type: REC.update, key: ['mochi'], value: { mood: 'hungry' } }]) })
  assert.deepEqual(snapshot(hungry), { luna: { mood: 'hungry' }, mochi: { mood: 'hungry' } })
  await h.destroy()
})

test('a view that throws inside a LOCAL write never cuts the write short: every record of the issue is stamped, logged and shown, and issue() returns', async () => {
  const faults: unknown[] = []
  const h = harness({ onFault: (e) => faults.push(e) })
  const hungry = h.bind.data.filter((c: { mood: string }) => c.mood === 'hungry')
  //! before the fix the throw left the kernel's commit loop after the FIRST record: the second was never
  // stamped, and issue() threw although the first had committed
  const out = h.bind.issue([
    { type: REC.update, key: ['mochi'], value: null },
    { type: REC.update, key: ['luna'], value: { mood: 'hungry' } },
  ])
  assert.equal(out.length, 2)
  assert.equal(h.jk(JK.writeLocal).length, 2, 'both records stamped')
  assert.equal(h.node.state.size, 2)
  assert.deepEqual(snapshot(h.bind.data), { mochi: null, luna: { mood: 'hungry' } })
  assert.deepEqual(snapshot(hungry), { luna: { mood: 'hungry' } })
  assert.equal(faults.length, 1)
  await h.destroy()
})

//! V4-48: a value the codec cannot carry is asked about BEFORE the stamp. Stamped first, it failed in every frame
// that carried it afterwards (the WAL, each link, each digest answer): replication stopped for good, and a getter
// that throws ended the server from its socket handler.
test('a value the wire cannot carry throws at the assignment and stamps nothing — a bigint, a function, a symbol, deep nesting, a getter that throws; a patch with one such pair issues none of it', async () => {
  const h = harness()
  let deep: unknown = { leaf: 1 }
  for (let i = 0; i < 70; i++) deep = { deep }
  const bad: [string, unknown, RegExp][] = [
    ['big', { n: 10n }, /a bigint/],
    ['fn', { f: () => 1 }, /a function/],
    ['sym', [Symbol('s')], /a symbol/],
    ['deep', deep, /deeper than 60 levels/],
    ['getter', { get age() { throw new Error('age trips') } }, /reading it threw \(Error: age trips\)/],
    ['huge', { s: 'x'.repeat(90_000_000) }, /bigger than 255 MiB/],
  ]
  for (const [k, v, why] of bad)
    assert.throws(() => { h.bind.data[k] = v }, (e: Error) => e instanceof TypeError && e.message.startsWith(`fero: ["${k}"] cannot be sent: `) && why.test(e.message) &&
      e.message.includes('\n  fero sends null, undefined, true and false, numbers, strings, Uint8Array, and arrays and objects of these'), k)
  assert.throws(() => h.bind.data.patch([['ok', 1], ['bad', 2n]]), /\["bad"\] cannot be sent: a bigint/)
  assert.equal(h.jk(JK.writeLocal).length, 0, 'nothing was stamped, not even the good pair of the patch')
  assert.equal(h.node.state.size, 0)
  h.bind.data.fine = { when: new Date(0), bytes: new Uint8Array([1, 2]), list: [1, 'two', null, undefined] } // carried (a Date as its fields, as ever)
  assert.equal(h.jk(JK.writeLocal).length, 1)
  await h.destroy()
})

//! the depth limit counts from the ROW: the built-in reads wrap a row in up to four levels (a live sub of the whole
// resource), so a value fero takes is a value every read can send back (api/index.test.ts drives each read)
test('the depth limit counts from the row: 60 levels at the row, 59 under a field of it', async () => {
  const h = harness()
  const nest = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = [v]; return v }
  h.bind.data.row = nest(60)
  assert.throws(() => { h.bind.data.over = nest(61) }, /\["over"\] cannot be sent: deeper than 60 levels/)
  h.bind.data.obj = { a: 1 }
  h.bind.data.obj.f = nest(59)
  assert.throws(() => { h.bind.data.obj.g = nest(60) }, /\["obj","g"\] cannot be sent: deeper than 60 levels/)
  assert.equal(h.jk(JK.writeLocal).length, 3)
  await h.destroy()
})

//! a validation: rule answers true or the reason. Any other answer — false (the common slip), undefined (a rule
// that forgot to return), a Symbol — was handed on as it was, and the write path, which reads a non-string outcome
// as a commit's promise, threw 'r.then is not a function' at methods.update and 'r.catch is not a function' at
// the assignment. It is a refusal, with its text as the reason.
test("a validation: rule that answers neither true nor a string refuses the write, with its answer's text as the reason", async () => {
  const answers: Record<string, unknown> = { f: false, u: undefined, s: Symbol('nope'), z: 0, e: '' }
  const h = harness({ validate: ((rec: Rec) => (rec.key[0] in answers ? answers[rec.key[0]] : true)) as (rec: Rec) => true | string })
  const out = h.bind.issue(Object.keys(answers).map((k) => ({ type: REC.update, key: [k], value: 1 })))
  assert.deepEqual(out, ['the rule returned false', 'the rule returned undefined', 'the rule returned Symbol(nope)', 'the rule returned 0', 'the rule returned an empty reason'])
  h.bind.data.f = 2 // refused, invisibly, like any refused assignment — it used to throw 'r.catch is not a function'
  h.bind.data.ok = 1
  assert.deepEqual(snapshot(h.bind.data), { ok: 1 })
  await h.destroy()
})

//! the likely slip `data.b = data.a`: a live view written as a value was read through its traps — an empty object
// for every leaf, on every copy and the writer's own, which also went on aliasing the source. And a remove carries
// no value, but its key travels: one too big for a frame was stamped and then failed every frame that carried it.
test('a live view written as a value is refused, and a remove whose key is too big to send is too', async () => {
  const h = harness()
  h.bind.data.a = { x: 1, o: { y: 'z' } }
  assert.throws(() => { h.bind.data.b = h.bind.data.a }, (e: Error) => e instanceof TypeError &&
    e.message.startsWith(`fero: ["b"] cannot be sent: a live view, not a value (use a plain copy, such as the resource's snapshot of it)\n`))
  assert.equal(snapshot(h.bind.data).b, undefined)
  assert.deepEqual(h.bind.issue([{ type: REC.remove, key: ['x'.repeat(90_000_000)] }]), ['unencodable'])
  assert.equal(h.jk(JK.writeLocal).length, 1, 'only the first write was stamped')
  await h.destroy()
})

test("issue() refuses a record the wire cannot carry 'unencodable' (a cluster.writes row says so) and commits the rest of the batch", async () => {
  const h = harness()
  const out = h.bind.issue([
    { type: REC.update, key: ['big'], value: 10n },
    { type: REC.update, key: ['ok'], value: 1 },
  ])
  assert.equal(out[0], 'unencodable')
  assert.notEqual(typeof out[1], 'string')
  assert.deepEqual(snapshot(h.bind.data), { ok: 1 })
  const rows = [...h.bind.outcomes.rows.values()]
  assert.ok(rows.some((r) => r.key === JSON.stringify(['big']) && r.state === 'rejected' && r.reason === 'unencodable'), JSON.stringify(rows))
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
  //! a MID-DEPTH parent settles too: our depth-3 write ['cart','a','x'] is WACKed, then a newer foreign
  // ['cart','a'] lands from another member and our echo never comes. The in-flight index is keyed by
  // EVERY ancestor, so the mid-depth apply finds our write (keyed by the row alone it stayed pending)
  const m = harness()
  m.admit(1, 'bb'); m.admit(2, 'cc')
  m.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  m.node.writes.ring.place('cart', 'bb')
  const [d] = m.bind.issue([{ type: REC.update, key: ['cart', 'a', 'x'], value: 1 }]) as Promise<unknown>[]
  let deep: unknown = 'pending'
  d.then((v) => { deep = v }, (e) => { deep = `rejected ${e}` })
  m.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 2, e: 1 }) })
  assert.equal(m.node.writes.pending.size, 0, 'WACKed')
  m.node.step({ kind: 'bytesIn', link: 2, bytes: records('cc', 9, 1, [{ type: REC.update, key: ['cart', 'a'], value: { y: 2 } }]) })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(deep, { origin: 'bb', seq: 2, epoch: 1, cid: 1 }, 'the mid-depth apply settled our deeper write from the WACK\'s coordinates')
  assert.deepEqual(snapshot(m.bind.data), { cart: { a: { y: 2 } } })
  assert.ok([...m.bind.outcomes.rows.values()].every((r) => r.state === 'committed'), 'no row of cluster.writes is left pending')
  await m.destroy()
})

test('V4-18 overlapping cells — our in-flight write settles when the kernel REFUSES its echo: a newer foreign row (or a newer same-cell write) lands before our WACK, then the WACK, then the echo — committed from the echo\'s own coordinates, never pending for ever', async () => {
  //! the reviewer's sequence: view e1 {aa,bb} with cart at bb; our field write forwarded to bb; the view
  // moves on (e2 adds cc and cart moves to cc) and cc's newer row reaches us FIRST — at that moment the
  // kernel still holds our attempt, so the row's apply decides nothing; then bb's WACK clears it (a step
  // that applies nothing); then bb's echo arrives and is refused across depth — before this it never
  // reached the api, and the write sat 'pending' for ever (the base tree resolved it committed).
  const run = async (label: string, cross: boolean, field: boolean) => {
    const h = harness()
    h.admit(1, 'bb'); h.admit(2, 'cc')
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
    h.node.writes.ring.place('cart', 'bb')
    const key = field ? ['cart', 'items'] : ['cart']
    const [p] = h.bind.issue([{ type: REC.update, key, value: 1 }]) as Promise<unknown>[]
    let settled: unknown = 'pending'
    p.then((v) => { settled = v }, (e) => { settled = `rejected ${e}` })
    if (cross) {
      h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
      h.node.writes.ring.place('cart', 'cc')
      h.node.step({ kind: 'bytesIn', link: 2, bytes: records('cc', 1, 2, [{ type: REC.update, key: ['cart'], value: { items: 7 } }]) })
    } else h.node.step({ kind: 'bytesIn', link: 2, bytes: records('cc', 9, 1, [{ type: REC.update, key: ['cart'], value: { items: 7 } }]) })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(settled, 'pending', `${label}: the kernel still holds the attempt when the newer row lands — nothing is decided`)
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 2, e: 1 }) })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(h.node.writes.pending.size, 0, `${label}: WACKed`)
    //! the echo: our commit on bb's lane, refused by the election (subsumed under the row, or lwwSkip on the cell)
    h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 2, 1, [{ type: REC.update, key, value: 1 }], 'aa~1', 1) })
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(settled, { origin: 'bb', seq: 2, epoch: 1, cid: 1 }, `${label}: settled committed from the refused echo's own coordinates`)
    assert.equal(h.jk(field ? JK.subsumed : JK.lwwSkip).length, 1, `${label}: the echo was refused`)
    assert.deepEqual(snapshot(h.bind.data), { cart: { items: 7 } }, `${label}: the newer row stands`)
    assert.ok([...h.bind.outcomes.rows.values()].every((r) => r.state === 'committed'), `${label}: no pending row of cluster.writes`)
    await h.destroy()
  }
  await run('field, two epochs', true, true)
  await run('field, one epoch', false, true)
  await run('same cell, two epochs', true, false)
  await run('same cell, one epoch', false, false)
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
  //! an ARRAY row: data writes the field INTO the array (g.b becomes a hidden array property) and
  // REFUSES a remove of an array's own key (a sparse hole) — the substrate folds a replicated one as a
  // no-op; before, data's throw came out of node.step in the orders where the newer field was
  // re-applied over the older array. The screen here is the array alone because the kernel re-emits
  // the array's own value once nothing live is left under it; with a live sibling, or with index keys,
  // an array row can still differ by order (the array limit). Depth 2 (the remove's parent IS the
  // array) and depth 3 (where the kernel's un-vivify must make up no repair under the array — its
  // seq-0 `remove ['g','a']` threw here too).
  for (const v of [[1], []]) {
    const frames: [number, Uint8Array][] = [
      [1, records('bb', 3, 0, [{ type: REC.update, key: ['g'], value: v }])],
      [2, records('cc', 5, 0, [{ type: REC.update, key: ['g', 'b'], value: 1 }])],
      [3, records('dd', 6, 0, [{ type: REC.remove, key: ['g', 'b'] }])],
    ]
    for (const order of permutations(frames)) {
      const h = harness()
      h.admit(1, 'bb'); h.admit(2, 'cc'); h.admit(3, 'dd')
      for (const [link, bytes] of order) h.node.step({ kind: 'bytesIn', link, bytes })
      assert.deepEqual(snapshot(h.bind.data), { g: v }, `array row ${JSON.stringify(v)}, a depth-2 field, order ${order.map((f) => f[0]).join(',')}`)
      await h.destroy()
    }
  }
  //! …the field two levels under the array; and a scalar row with a live sibling field:
  // the level the deeper field made up (g.a) goes, the sibling keeps the made-up object — {g:{c:2}},
  // the same as on a node that refused the field.
  for (const [v, want, extra] of [[[], { g: [] }, null], [5, { g: { c: 2 } }, [4, records('ee', 4, 0, [{ type: REC.update, key: ['g', 'c'], value: 2 }])]]] as [unknown, unknown, [number, Uint8Array] | null][]) {
    const frames: [number, Uint8Array][] = [
      [1, records('bb', 3, 0, [{ type: REC.update, key: ['g'], value: v }])],
      [2, records('cc', 5, 0, [{ type: REC.update, key: ['g', 'a', 'y'], value: 5 }])],
      [3, records('dd', 6, 0, [{ type: REC.remove, key: ['g', 'a', 'y'] }])],
    ]
    if (extra) frames.push(extra)
    for (const order of permutations(frames)) {
      const h = harness()
      h.admit(1, 'bb'); h.admit(2, 'cc'); h.admit(3, 'dd'); h.admit(4, 'ee')
      for (const [link, bytes] of order) h.node.step({ kind: 'bytesIn', link, bytes })
      assert.deepEqual(snapshot(h.bind.data), want, `row ${JSON.stringify(v)} under a depth-3 field, order ${order.map((f) => f[0]).join(',')}`)
      await h.destroy()
    }
  }
})

test('V4-18 overlapping cells — a field removed INSIDE an array element stays removed: `delete data.todos[0].done` shows, and a newer remove is never put back by a repair', async () => {
  //! the everyday shape: one local delete, nothing concurrent
  const h = harness()
  h.bind.data.todos = [{ done: true, n: 1 }]
  delete h.bind.data.todos[0].done
  assert.deepEqual(snapshot(h.bind.data), { todos: [{ n: 1 }] }, 'the field is gone from the screen')
  await h.destroy()
  //! the reviewer's history (a), every order: the row [{d:0}]@3, g.0.e=1@4, g.0.d=1@5, rm g.0.d@6 — the
  // remove is newer than the row, so `d` is gone and `e` shows: [{e:1}]
  const permutations = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))
  const frames: [number, Uint8Array][] = [
    [1, records('bb', 3, 0, [{ type: REC.update, key: ['g'], value: [{ d: 0 }] }])],
    [2, records('cc', 4, 0, [{ type: REC.update, key: ['g', '0', 'e'], value: 1 }])],
    [3, records('dd', 5, 0, [{ type: REC.update, key: ['g', '0', 'd'], value: 1 }])],
    [4, records('ee', 6, 0, [{ type: REC.remove, key: ['g', '0', 'd'] }])],
  ]
  for (const order of permutations(frames)) {
    const m = harness()
    m.admit(1, 'bb'); m.admit(2, 'cc'); m.admit(3, 'dd'); m.admit(4, 'ee')
    for (const [link, bytes] of order) m.node.step({ kind: 'bytesIn', link, bytes })
    assert.deepEqual(snapshot(m.bind.data), { g: [{ e: 1 }] }, `order ${order.map((f) => f[0]).join(',')}`)
    await m.destroy()
  }
})

test('V4-18 overlapping cells — a LOCAL delete of an array element is refused before it commits, with data\'s message; a REPLICATED remove under an array row still folds as the no-op', async () => {
  const h = harness()
  h.bind.data.g = [1, 2]
  const seq = h.node.seq, rows = h.bind.outcomes.rows.size
  //! data refuses to leave a sparse hole in an array; the lens says so to the caller, the way it
  // refuses a root replace — nothing is stamped, no tombstone, no row of cluster.writes
  assert.throws(() => { delete h.bind.data.g[0] }, /remove\(\) of array element \[g\.0\] would leave a sparse hole — write the spliced array instead/)
  assert.throws(() => h.bind.data.g.get('1').remove(), /array element \[g\.1\] would leave a sparse hole/, 'the remove() verb too')
  assert.equal(h.node.seq, seq, 'nothing committed')
  assert.equal(h.node.versions.has(JSON.stringify(['g', '0'])), false, 'no tombstone')
  assert.equal(h.bind.outcomes.rows.size, rows, 'no write outcome')
  assert.deepEqual(snapshot(h.bind.data), { g: [1, 2] })
  //! an index past the end is absent: the no-op delete filter issues nothing, as before
  delete h.bind.data.g[5]
  assert.equal(h.node.seq, seq)
  //! a replicated remove of an array element cannot be refused: the substrate folds it as the no-op
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: records('bb', 1, 0, [{ type: REC.update, key: ['r'], value: [7, 8] }, { type: REC.remove, key: ['r', '0'] }]) })
  assert.deepEqual((snapshot(h.bind.data) as { r: unknown }).r, [7, 8], 'the array stays whole')
  await h.destroy()
})

test("a remove record that skips the lens (methods.remove's spelling) is refused 'sparse-hole' at the ingest — the same rule as the lens, typed, before any stamp", async () => {
  const h = harness()
  h.bind.data.g = [1, { x: 1 }]
  h.bind.data.o = { a: 1 }
  const seq = h.node.seq
  //! an array's own element: refused, a rejected outcome row, nothing stamped
  assert.deepEqual(h.bind.issue([{ type: REC.remove, key: ['g', '0'] }]), ['sparse-hole'])
  assert.equal(h.node.seq, seq, 'nothing committed')
  assert.equal(h.node.versions.has(JSON.stringify(['g', '0'])), false, 'no tombstone')
  assert.ok([...h.bind.outcomes.rows.values()].some((r) => r.key === JSON.stringify(['g', '0']) && r.state === 'rejected' && r.reason === 'sparse-hole'))
  assert.equal(h.bind.admit({ type: REC.remove, key: ['g', '0'] }), 'sparse-hole', 'the relay predicate reads the same rule')
  //! everything else still goes through: a field inside an element (data folds it), a field of an object
  // row, a whole-row remove, and an index past the end (not an own key; data's remove is idempotent)
  for (const key of [['g', '1', 'x'], ['o', 'a'], ['g', '5'], ['o']]) {
    const [r] = h.bind.issue([{ type: REC.remove, key }])
    assert.notEqual(typeof r, 'string', `${key.join('.')} admitted`)
    await r
  }
  assert.deepEqual(snapshot(h.bind.data), { g: [1, {}] })
  await h.destroy()
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

//! wave 5e at the binding tier — a spoke of a SCOPED cluster whose feeder dies between the WACK and the tap. The
// feeder WACKed both writes with `l` (the lane: it will tap the records) and died before either tap left. The spoke
// fails over onto oo and resyncs; oo holds py and not px. py settles through the join with its value already on the
// proxy (V4-7); px settles at the resync's end, committed on the owner's lane from the WACK's coordinates, and its
// value never shows here (oo does not hold it). Neither cluster.writes row is left pending. Red without the fix: px's
// row stays `pending` and its promise never settles.
test('wave 5e — a spoke whose scoped feeder dies between the WACK and the tap: a write the next feeder holds settles after its value shows; one it does not hold settles committed on the owner\'s lane at the resync\'s end; no row left pending', async () => {
  const rt = new Runtime({ uuid: 'zz', heartbeatMs: 0, client: true })
  const bind = new Bind(rt)
  const node = rt.node
  const SCOPED = 'v1;heartbeat.ms=50;replicas=2;methods=0;validation=none;ring=fmix32'
  //! real-looking addresses: the failover's redial dials the dead feeder through the Runtime's real socket layer
  // (a 'sim:' label is not a port); port 9 refuses, and the test is over before the backoff fires anyway
  const admit = (link: number, u: string) => {
    const at = u === 'pp' ? '127.0.0.1:9' : '127.0.0.1:7'
    node.step({ kind: 'linkUp', link, dialed: true, to: at })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: at, c: SCOPED }) })
  }
  admit(1, 'pp')
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['pp', '127.0.0.1:9'], ['oo', '127.0.0.1:7'], ['tt', '127.0.0.1:13']] }) })
  admit(2, 'oo')
  const rows = () => [...bind.outcomes.rows.values()]
  const [pa] = bind.issue([{ type: REC.update, key: ['px'], value: 'x' }]) as Promise<{ origin: string; seq: number; epoch: number }>[]
  const [pb] = bind.issue([{ type: REC.update, key: ['py'], value: 'y' }]) as Promise<{ origin: string; seq: number; epoch: number }>[]
  let shownAtSettle: unknown = 'unset'
  const pbSeen = pb.then((c) => { shownAtSettle = (snapshot(bind.data) as Record<string, unknown>).py; return c })
  let paDone = false
  pa.then(() => { paDone = true }, () => { paDone = true })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'zz~1', c: 1, n: 2, s: 7, e: 1, l: 'tt' }) })
  await new Promise((r) => setImmediate(r))
  assert.equal(node.writes.pending.size, 0, 'cleared: nothing will be re-sent')
  assert.equal(rows().filter((r) => r.state === 'pending').length, 2, 'both still pending: waiting for the tap')
  assert.equal(paDone, false)
  //! pp dies before the taps; the failover onto oo is a resync; oo ships py and then its reply
  node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  node.step({ kind: 'bytesIn', link: 2, bytes: records('tt', 8, 1, [{ type: REC.update, key: ['py'], value: 'y' }], 'zz~1', 2) })
  node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { tt: 8 }, r: 0 }) })
  assert.equal(node.resync, null, 'the resync ended')
  //! bounded: a regression must fail here, not hang the battery (on the base kernel px never settles)
  const within = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(what + ' never settled')), 2000).unref())])
  assert.deepEqual(await within(pbSeen, 'py'), { origin: 'tt', seq: 8, epoch: 1, cid: 2 }, 'py: through the join')
  assert.equal(shownAtSettle, 'y', 'py: its value was on the proxy when the promise resolved (V4-7)')
  assert.deepEqual(await within(pa, 'px'), { origin: 'tt', seq: 7, epoch: 1, cid: 1 }, 'px: committed on the owner\'s lane, from the WACK')
  assert.equal((snapshot(bind.data) as Record<string, unknown>).px, undefined, 'px never shows here: oo does not hold it')
  assert.deepEqual(rows().map((r) => [r.key, r.state, r.origin]).sort(), [[JSON.stringify(['px']), 'committed', 'tt'], [JSON.stringify(['py']), 'committed', 'tt']], 'no row left pending')
  bind.destroy()
  await rt.destroy()
})
