//! Tier-3 composer suite: fero() over REAL sockets and (one test) a REAL disk — the public surface
// exercised the way a consumer holds it. Deterministic protocol coverage stays in api/data.test.ts
// and the kernel/sim suites; this file proves the composition: config schema, await-fero-as-ready,
// replication visible through two proxies, the guarantee ladder under methods.update, restore into
// the proxy, and teardown.

//! the battery pins (utils/battery.ts), whichever way this suite is run: the directory OFF (a single-file
// `node --test` must never meet a live box directory) and the config layer OFF (no flag, variable or file reaches a test)
import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { fero, WriteRejectError } from './index.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { JK } from '../kernel/journal.ts'
import { TUNE } from '../kernel/tune.ts'
import { VERB, encodeControl, MAX_FRAME } from '../kernel/codec.ts'
import { ports, until, sleep } from '#utils'
import type { Fero, WriteReject, WriteResolve } from './types.ts'

test('config recognition (V4-5): unknown keys, unknown seams and TOP-LEVEL FUNCTIONS throw at fero() time; methods live under methods:', async () => {
  await assert.rejects(fero('r', { prot: 9 } as never), /unknown option 'prot'/)
  await assert.rejects(fero('r', { seams: { hash: () => 0 } } as never), /unknown seam 'hash'/)
  //! the pre-V4-5 spelling ("any function is a method") is refused with the pointer — moving the function
  // under methods: also declares the door, on purpose
  await assert.rejects(fero('r', { listen: false, checkout: (n: unknown) => `order-${n}` } as never), /methods live under methods: \{ checkout \}/)
  await assert.rejects(fero('r', { methods: 'sell' } as never), /methods must be a plain object/)
  await assert.rejects(fero('r', { methods: () => 1 } as never), /methods must be a plain object/, 'a function-valued methods: gets the plain-object message, not a pointer to methods: { methods }')
  await assert.rejects(fero('r', { methods: new (class { sell() { return 1 } })() } as never), /plain object of handlers/, 'a class instance keeps its handlers on the prototype — it would host nothing and protect everything')
  await assert.rejects(fero('r', { methods: { sell: 1 } } as never), /methods\.sell must be a function/)
  //! under methods: a handler dispatches LOCALLY on a server (M5c): one-shot invoke, flush-on-return,
  // snapshot for proxy returns
  const f = await fero('r', { listen: false, methods: { checkout: (n: unknown) => `order-${n}` } })
  assert.equal(await f.methods.checkout(7), 'order-7')
  //! built-in read returns the resource (snapshot locally)
  f.data.k = 1
  assert.deepEqual(await f.methods.read(), { k: 1 })
  //! reserved names refuse loudly
  await assert.rejects(fero('r', { methods: { update: () => 0 } } as never), /built-in writer/)
  await assert.rejects(fero('r', { methods: { ['\u0000evil']: () => 0 } } as never), /reserved for the system plane/)
  await f.destroy()
})

test("V4-5 the door: `methods:` makes clients change data ONLY through the methods — plain writes and the write builtins are refused 'methods-only' and never show; the server's own writes and its handlers stay trusted; the validator still guards the trusted side", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 },
    data: { stock: 3 },
    seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') },
    //! the handler READ idiom: `await ctx.data.stock` is the current value (the live view is thenable —
    // v2 parity); a bare `ctx.data.stock` is the live child view, not the number
    methods: { sell: async (n: number, ctx: { data: any }) => { const stock = (await ctx.data.stock) as number; ctx.data.stock = stock - n; return stock - n } },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const view = (f: typeof c) => snapshot(f.data) as Record<string, unknown>
  const rows = (f: typeof c) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; reason?: string }>)
  try {
    assert.ok(await until(() => view(c).stock === 3, 8000), 'the spoke folded the seed')
    //! a plain client assignment: NOTHING shows (V4-7 — a client's write is a request until the server
    // stamps it), the relay refuses it, and only cluster.writes tells the story, with the door's reason
    c.data.stock = 99
    assert.equal(view(c).stock, 3, 'no optimistic copy: the proxy is the cluster\'s truth')
    assert.ok(await until(() => rows(c).some((r) => r.key === JSON.stringify(['stock']) && r.state === 'rejected' && r.reason === 'methods-only'), 8000), 'cluster.writes names the door')
    assert.equal(view(c).stock, 3, 'refused — and it never showed, so there was nothing to bounce')
    //! the write builtins are the same bytes as assignment — refused identically, typed, never a timeout
    const door = (e: { reason: string; reached: string }) => e.reason === 'methods-only' && e.reached === 'issued'
    await assert.rejects(c.methods.update({ key: 'stock', value: 1 }, { timeout: 8000 }), door)
    await assert.rejects(c.methods.insert({ value: { x: 1 } }, { timeout: 8000 }), door)
    await assert.rejects(c.methods.remove({ key: 'stock' }, { timeout: 8000 }), door)
    //! THE door: the method changes data (flush-on-return — the host holds it before replying)
    assert.equal(await c.methods.sell(1), 2)
    assert.equal(view(s).stock, 2)
    assert.ok(await until(() => view(c).stock === 2, 8000), 'the change replicated back to the spoke')
    //! the pin is about the WIRE: the server's own write lands and replicates…
    s.data.note = 'mine'
    assert.ok(await until(() => view(c).note === 'mine', 8000))
    //! …and the validator still guards the trusted side: the server's OWN admin write is refused locally
    s.data.admin = 5
    assert.equal(view(s).admin, undefined)
    assert.equal(view(s).stock, 2, 'nothing the client sent directly ever landed')
  } finally {
    await c.destroy()
    await s.destroy()
  }
  //! `methods: {}` alone is a server that clients may only read
  const ro = await fero(`ro-${process.pid}`, { methods: {}, heartbeat: { ms: 0 } })
  try { assert.equal((snapshot(ro.cluster) as { me: { role: string } }).me.role, 'server') } finally { await ro.destroy() }
})

test("a remove of an array's own element is refused 'sparse-hole' before it commits: the server's methods.remove, and a client's relayed remove (refused at the client, or at the relay when the client cannot see the array yet)", async () => {
  //! data will not delete an array's own key (a sparse hole), so such a remove used to commit a tombstone that
  // showed nothing anywhere. The lens refuses `delete data.g[0]`; methods.remove skips the lens, so the
  // ingest refuses it now, typed, with data's message, the way the door refuses 'methods-only'.
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { g: [1, 2] } })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const view = (f: typeof c) => snapshot(f.data) as Record<string, unknown>
  const rows = (f: typeof c) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; reason?: string }>)
  const hole = (path: string) => (e: unknown) => {
    assert.ok(e instanceof WriteRejectError, 'one WriteRejectError, like every refusal')
    assert.equal(e.reason, 'sparse-hole')
    assert.equal(e.reached, 'issued', 'refused before anything was stamped')
    assert.ok(e.message.includes(`remove() of array element [${path}] would leave a sparse hole — write the spliced array instead`), e.message)
    return true
  }
  try {
    assert.ok(await until(() => JSON.stringify(view(c).g) === '[1,2]', 8000), 'the spoke folded the seed')
    const logged = diag(s)!.logSize()
    //! the server's own call: refused at its ingest — no tombstone in any log, a rejected row in cluster.writes
    await assert.rejects(s.methods.remove({ key: ['g', 0] as never }, { timeout: 8000 }), hole('g.0'))
    assert.equal(diag(s)!.logSize(), logged, 'nothing committed')
    assert.ok(await until(() => rows(s).some((r) => r.key === JSON.stringify(['g', '0']) && r.state === 'rejected' && r.reason === 'sparse-hole'), 2000), 'cluster.writes names the reason')
    //! the client sees the array: its own ingest refuses, nothing is relayed
    await assert.rejects(c.methods.remove({ key: ['g', '1'] }, { timeout: 8000 }), hole('g.1'))
    //! the client cannot see the array yet (the server wrote it this tick): the remove is relayed, and the
    // server's relay predicate refuses it with the same reason, which rides the WNACK back
    s.data.h = [3, 4]
    assert.equal(view(c).h, undefined, 'the spoke has not folded h yet')
    await assert.rejects(c.methods.remove({ key: ['h', '0'] }, { timeout: 8000 }), hole('h.0'))
    assert.equal(diag(s)!.logSize(), logged + 1, 'only the write of h committed')
    //! the arrays are whole everywhere, and the spliced array is the way to remove an element
    assert.ok(await until(() => JSON.stringify(view(c).h) === '[3,4]', 8000))
    assert.deepEqual(view(s).g, [1, 2])
    await c.methods.update({ key: 'g', value: [2] }, { timeout: 8000 })
    assert.ok(await until(() => JSON.stringify(view(s).g) === '[2]' && JSON.stringify(view(c).g) === '[2]', 8000))
  } finally {
    await c.destroy()
    await s.destroy()
  }
})

test('M6 config: replicas validates loudly (integer ≥ 1, servers only) and surfaces on cluster.partitions; unscoped shows zeros', async () => {
  await assert.rejects(fero('r', { replicas: 0 } as never), /replicas must be an integer/)
  await assert.rejects(fero('r', { replicas: 1.5 } as never), /replicas must be an integer/)
  //! v4.1: replicas + hosts is a legal DIALING MEMBER now (replicas implies server), so the old
  // spoke-with-replicas reject is unrepresentable by construction — role is a pure function of config
  //! unscoped: the partitions row is a truthful all-zeros projection (replicas 0 = R=∞)
  const plain = await fero('r', { listen: false })
  const p0 = (snapshot(plain.cluster) as { partitions: Record<string, unknown> }).partitions
  assert.deepEqual(p0, { replicas: 0, epoch: 0, w: 0, held: 0, acquiring: 0, orphaned: 0, acquired: 0, shed: 0, shedWaitingOn: [] })
  await plain.destroy()
  //! scoped solo: config reflected; w derives from R_eff (min(replicas, members)) — never configurable
  const f = await fero('r', { uuid: 'aa', replicas: 2, listen: false })
  const p = (snapshot(f.cluster) as { partitions: { replicas: number; w: number } }).partitions
  assert.equal(p.replicas, 2)
  assert.equal(p.w, 1, 'solo: R_eff = min(2, 1) = 1 ⇒ W = 1')
  await f.destroy()
})

test('redial.tries reaches the kernel: a client dialing a dead port gives up after exactly that many tries', async () => {
  //! the tune table's one config key (kernel/tune.ts row `redials`): the composer hands it to the node, and
  // the dial chain to a port nothing listens on ends after `tries` arms — journal-visible (JK.redial ×2, then
  // JK.giveUp). Heartbeats off, so nothing revives the chain; no directory, so the dead port is the only target.
  const dead = `127.0.0.1:${await ports.free()}`
  const c = await fero(`tries-${process.pid}`, { hosts: [dead], rendezvous: false, heartbeat: { ms: 0 }, redial: { ms: 10, tries: 2 } })
  try {
    const events = () => diag(c)!.journal().events
    assert.ok(await until(() => events().some((e) => e.kind === JK.giveUp), 5000), 'the chain gave up')
    assert.equal(events().filter((e) => e.kind === JK.redial).length, 2, 'exactly two redials before give-up')
    assert.deepEqual(diag(c)!.config()['redial.tries'], { value: 2, from: 'the call' })
  } finally { await c.destroy() }
  await assert.rejects(fero('r', { redial: { tries: 1.5 } } as never), /redial\.tries must be an integer ≥ 0/)
  await assert.rejects(fero('r', { redial: { tries: -1 } } as never), /redial\.tries must be an integer ≥ 0/)
})

//! V4-51: the tune row `frame` is the kernel's test seam for frame cuts — it has no config key and the composer never
// passes it, so every fero() builds at MAX_FRAME. A composer that started passing it (or a default that moved) would
// make production cut frames smaller than the wire allows; this goes red first.
test('fero() never sets the frame row: a server and a client run at MAX_FRAME', async () => {
  const p = await ports.free()
  const s = await fero(`frame-${process.pid}`, { listen: `127.0.0.1:${p}`, heartbeat: { ms: 0 } })
  try {
    assert.equal(diag(s)!.tune().frame, MAX_FRAME)
    const c = await fero(`frame-${process.pid}`, { hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 0 }, redial: { ms: 30 } })
    try { assert.equal(diag(c)!.tune().frame, MAX_FRAME) } finally { await c.destroy() }
  } finally { await s.destroy() }
})

test('leave.ms (the knock window, DESIGN-LEAVE §10.7) reaches the kernel as the tune row leaveWindow — ms ÷ heartbeat.ms, rounded up; 0 is the bound alone; heartbeats off leave the row at its default — and is shown with its source; its default is 16 heartbeats at this node\'s cadence; a bad value is refused naming the key', async () => {
  //! the tune table's second config key (kernel/tune.ts row `leaveWindow`, in heartbeat ticks): the composer divides
  // by the effective cadence and rounds up. The door shows the value the operator set, or the effective default —
  // and diag(f).tune() shows the row itself, so a composer that stopped passing the row to the node goes red here
  // (the review's finding: config() alone displays what was READ, not what the kernel RUNS with).
  const f = await fero(`knock-${process.pid}`, { listen: false, heartbeat: { ms: 100 }, leave: { ms: 1250 } })
  try {
    assert.deepEqual(diag(f)!.config()['leave.ms'], { value: 1250, from: 'the call' })
    assert.equal(diag(f)!.tune().leaveWindow, 13, '1250 ms at 100 ms a tick, rounded UP: 13 ticks (12.5 would cut the window short)')
    assert.equal(diag(f)!.tune().leaveTicks, TUNE.leaveTicks, 'the bound is untouched')
  } finally { await f.destroy() }
  const z = await fero(`knock-z-${process.pid}`, { listen: false, heartbeat: { ms: 100 }, leave: { ms: 0 } })
  try {
    assert.equal(diag(z)!.tune().leaveWindow, 1, 'leave.ms 0: a row at 1, below the four-tick bound — the kernel reads max(window, bound), so this is the bound alone')
    assert.deepEqual(diag(z)!.config()['leave.ms'], { value: 0, from: 'the call' }, '0 is a value, shown as set')
  } finally { await z.destroy() }
  const d = await fero(`knock-d-${process.pid}`, { listen: false })
  try {
    assert.deepEqual(diag(d)!.config()['leave.ms'], { value: 8000, from: 'the default' }, '16 heartbeats × 500 ms')
    assert.equal(diag(d)!.tune().leaveWindow, TUNE.leaveWindow, 'no key: the frozen default row')
  } finally { await d.destroy() }
  const q = await fero(`knock-q-${process.pid}`, { listen: false, heartbeat: { ms: 100 } })
  try { assert.deepEqual(diag(q)!.config()['leave.ms'], { value: 1600, from: 'the default' }, '16 heartbeats × 100 ms') } finally { await q.destroy() }
  //! heartbeats off: no clock, so no window — the row stays at its default whatever leave.ms says, and the door shows
  // no effective value (16 × 0 = 0 would read as "the bound alone", which is not what no clock means)
  const o = await fero(`knock-o-${process.pid}`, { listen: false, heartbeat: { ms: 0 }, leave: { ms: 1250 } })
  try {
    assert.equal(diag(o)!.tune().leaveWindow, TUNE.leaveWindow, 'heartbeats off: the row is left at its default')
    assert.deepEqual(diag(o)!.config()['leave.ms'], { value: 1250, from: 'the call' }, 'what was set is still shown')
  } finally { await o.destroy() }
  const n = await fero(`knock-n-${process.pid}`, { listen: false, heartbeat: { ms: 0 } })
  try { assert.equal(diag(n)!.config()['leave.ms'], undefined, 'heartbeats off and nothing set: no effective window to show') } finally { await n.destroy() }
  await assert.rejects(fero('r', { leave: { ms: -1 } } as never), /leave\.ms must be a finite number of milliseconds ≥ 0/)
  await assert.rejects(fero('r', { leave: { ms: 'soon' } } as never), /leave\.ms must be a finite number of milliseconds ≥ 0/)
  await assert.rejects(fero('r', { leave: 5 } as never), /'leave' from the call is a group, not a value/)
})

test('solo: assignment and methods.update are ONE ingest — both commit, both visible, coordinates resolve', async () => {
  const f = await fero('inventory', { uuid: 'aa', listen: false })
  assert.equal(f.name, 'inventory')
  f.data.widget = { stock: 3 }
  const r: WriteResolve = await f.methods.update({ key: 'widget', value: { stock: 2 } })
  assert.equal(r.guarantee, 'committed')
  assert.equal(r.origin, 'aa')
  assert.ok(r.seq >= 2)
  assert.deepEqual(snapshot(f.data), { widget: { stock: 2 } })
  //! methods.remove ≡ delete f.data.widget
  await f.methods.remove({ key: 'widget' })
  assert.deepEqual(snapshot(f.data), {})
  //! insert mints a row key when none is given
  const ins = await f.methods.insert({ value: { stock: 9 } })
  assert.equal(ins.key.length, 1)
  assert.deepEqual(Object.values(snapshot(f.data) as object), [{ stock: 9 }])
  await f.destroy()
})

test('I-25: a lens COERCES to its cell — `data.k = data.k + 1` commits k+1 and `data.k++` routes through the set trap; a row coerces like a plain object, never a debug label; valueOf() is the value', async () => {
  const f = await fero('r', { uuid: 'aa', listen: false })
  const view = () => snapshot(f.data) as Record<string, unknown>
  try {
    f.data.count = 1
    f.data.count = f.data.count + 1
    assert.strictEqual(view().count, 2, "the old lens committed the STRING '[data source#1 .count]1'")
    f.data.count++
    assert.strictEqual(view().count, 3, 'the old lens committed NaN')
    f.data.count += 2
    assert.strictEqual(view().count, 5)
    assert.strictEqual(`${f.data.count}`, '5')
    assert.strictEqual(f.data.count > 4, true)
    assert.strictEqual(f.data.count.valueOf(), 5)
    //! an object cell coerces as a plain object would; an absent cell is undefined (NaN in arithmetic)
    f.data.row = { a: 1 }
    assert.strictEqual(`${f.data.row}`, '[object Object]')
    assert.deepEqual(f.data.row.valueOf(), { a: 1 })
    assert.ok(Number.isNaN(f.data.missing + 1))
    assert.deepEqual(view(), { count: 5, row: { a: 1 } }, 'only the values landed — no label, no NaN, no stray cell')
  } finally {
    await f.destroy()
  }
})

//! Regression (v4 re-evaluation BLOCKER): the lens delegated EVERY reserved name raw —
// including data's WRITE builtins — so f.data.set('k',v) / f.data.k.update(v) /
// f.data.patch([...]) mutated the LOCAL projection only: no validation, no join, no
// replication (the sink saw only assignments). §4.1's "validation covers both by
// construction" now holds for the typed idioms too: set/update/patch/remove route through
// the SAME sink as assignment/delete (Bind.issue), and the verbs that cannot be made
// replication-correct through a lens (insert/ingest/raf/dispose) throw fero-shaped errors.
test('D3 lens: data write builtins route through issue() — validated — or throw; never the raw projection', async () => {
  const seen: unknown[] = []
  const f = await fero('lensguard', {
    uuid: 'aa',
    listen: false,
    seams: {
      validation: (rec: { value?: { stock?: number } }) => {
        seen.push(rec)
        return rec.value?.stock === 13 ? 'unlucky' : true
      },
    },
  })
  try {
    //! the v2-parity typed idioms — same sink as assignment, observationally ≡ it
    f.data.set('w', { stock: 1 })
    assert.deepEqual(snapshot(f.data), { w: { stock: 1 } })
    f.data.w.update({ stock: 2 })
    assert.deepEqual(snapshot(f.data), { w: { stock: 2 } })
    f.data.patch([['x', { stock: 4 }], ['y', { stock: 5 }]])
    assert.deepEqual((snapshot(f.data) as Record<string, unknown>).x, { stock: 4 })
    f.data.y.remove()
    assert.equal((snapshot(f.data) as Record<string, unknown>).y, undefined)
    assert.ok(seen.length >= 4, 'every routed verb passed the validation seam (issue), not the raw handle')

    //! a REJECTED verb write never lands in the projection — the backdoor's exact
    // signature was "validation refused it but the handle mutated anyway"
    f.data.set('w', { stock: 13 })
    assert.deepEqual((snapshot(f.data) as Record<string, unknown>).w, { stock: 2 }, 'rejected verb write refused PRE-COMMIT — nothing showed')

    //! the un-routable verbs throw with the fero-shaped alternative
    assert.throws(() => (f.data as { insert(v: unknown): unknown }).insert({ stock: 9 }), /fero: insert\(\)/)
    assert.throws(() => (f.data as { ingest(r: unknown[]): unknown }).ingest([]), /fero: ingest\(\)/)
    assert.throws(() => (f.data as { raf(): unknown }).raf(), /fero: raf\(\)/)
    //! …and each fits a terminal: no line past 90 characters (the pointer rides a second line), and the
    // clause before ` — ` is the one examples/04-rows prints — byte-identical to before
    const firstClause: Record<string, string> = {
      insert: 'fero: insert() mints a data-side key that would not replicate',
      ingest: 'fero: ingest() is the replication ingress',
      raf: 'fero: raf() writes the local projection directly and would not replicate',
    }
    for (const verb of ['insert', 'ingest', 'raf'] as const) {
      const message = (() => { try { (f.data as Record<string, () => unknown>)[verb](); return '' } catch (e) { return (e as Error).message } })()
      assert.equal(message.split(' — ')[0], firstClause[verb], `${verb}(): the first clause is unchanged`)
      assert.ok(message.split('\n').every((l) => l.length <= 90), `${verb}(): every line fits — ${JSON.stringify(message)}`)
    }
    assert.throws(() => (f.data as { dispose(): void }).dispose(), /fero: dispose\(\)/)
    assert.throws(() => (f.data as { update(v: unknown): void }).update({}), /resource root/)
    assert.throws(() => (f.data as { remove(): void }).remove(), /destroy/)

    //! first()/last() return LENSES — the one-child-down backdoor is closed too
    f.data.first().update({ stock: 6 })
    assert.deepEqual((snapshot(f.data) as Record<string, unknown>).w, { stock: 6 })
  } finally {
    await f.destroy()
  }
})

test('two nodes over real sockets: writes on either side converge through the PUBLIC surface, both directions', async () => {
  const pa = await ports.free()
  const pb = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}` })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`] })
  try {
    a.data.left = { from: 'aa' }
    b.data.right = { from: 'bb' }
    assert.ok(await until(() => (snapshot(b.data) as Record<string, unknown>).left !== undefined
      && (snapshot(a.data) as Record<string, unknown>).right !== undefined), 'both proxies converged')
    //! nested + remove converge too
    a.data.left.deep = 1
    delete b.data.right
    assert.ok(await until(() => (snapshot(b.data) as { left?: { deep?: number } }).left?.deep === 1
      && (snapshot(a.data) as Record<string, unknown>).right === undefined))
    //! and the cluster surface saw the peer
    assert.ok((snapshot(a.cluster) as { peers: Record<string, unknown> }).peers.bb, 'cluster.peers folded the identified link')
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test("the guarantee ladder under methods: confirm:'replicated' proves against a live peer; confirm:'persisted' without disks REJECTS honestly at reached:'committed'", async () => {
  const pa = await ports.free()
  const pb = await ports.free()
  //! genesis needs the full topology on the proposer (lowest uuid, all configured hosts admitted)
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 } })
  try {
    //! wait for the mesh + committed view (replicated evidence needs a majority of a real view)
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1
      && (snapshot(b.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    const r = await a.methods.update({ key: 'k', value: 1 }, { confirm: 'replicated', timeout: 8000 })
    assert.equal(r.guarantee, 'replicated')
    //! persisted without a single durable disk can never be proven — an honest reject, never a hang
    await assert.rejects(
      a.methods.update({ key: 'k2', value: 2 }, { confirm: 'persisted', timeout: 500 }),
      (e: WriteReject) => e.guarantee === 'persisted' && e.reached === 'committed' && e.localCommit !== undefined,
    )
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test("confirm:'persisted' where no disk can ever prove it rejects AT ONCE ('not-durable', reached committed, the write landed, the dir: pointer) — and a memory-only member beside a durable majority still reaches it", async () => {
  //! two memory-only members: nothing can ever fsync, so waiting out the deadline would prove nothing
  const pa = await ports.free()
  const pb = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1 && (snapshot(b.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    const t0 = performance.now()
    const e = await a.methods.update({ key: 'k', value: 1 }, { confirm: 'persisted', timeout: 8000 }).then(() => null, (e: unknown) => e) as WriteRejectError
    assert.ok(performance.now() - t0 < 4000, `rejected at once, not at the 8s deadline (${(performance.now() - t0).toFixed(0)}ms)`)
    assert.ok(e instanceof WriteRejectError && e.reason === 'not-durable' && e.reached === 'committed' && e.localCommit !== undefined, `typed: ${String(e)}`)
    assert.match(e.message, /no member has announced a disk — pass dir: to persist\)$/)
    assert.equal((snapshot(a.data) as { k?: number }).k, 1, 'a reject is not a rollback: the write landed')
  } finally {
    await a.destroy()
    await b.destroy()
  }
  //! three members, two with a disk: the memory-only one asks for 'persisted' and the durable majority proves it
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'fero-nd-')), fs.mkdtempSync(path.join(os.tmpdir(), 'fero-nd-'))]
  const ps: number[] = []
  for (let i = 0; i < 3; i++) ps.push(await ports.free())
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const n = await Promise.all(addrs.map((listen, i) =>
    fero('r', { uuid: `n${i}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, ...(i < 2 ? { dir: dirs[i] } : {}) })))
  try {
    assert.ok(await until(() => n.every((f) => (snapshot(f.cluster) as { epoch: number }).epoch >= 1), 10_000), 'view of three formed')
    const r = await n[2].methods.update({ key: 'k', value: 2 }, { confirm: 'persisted', timeout: 8000 })
    assert.equal(r.guarantee, 'persisted', 'the memory-only member proved it on its peers\' disks')
  } finally {
    for (const f of n) await f.destroy()
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('restore through the composer: fero(name, {dir}) refills the proxy from the WAL before the network exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-api-'))
  try {
    const first = await fero('r', { uuid: 'aa', dir, listen: false })
    first.data.persisted = { rows: 3 }
    first.data.persisted.rows = 4
    await first.methods.update({ key: 'volatile', value: true })
    await first.destroy()

    const second = await fero('r', { uuid: 'aa', dir, listen: false })
    assert.deepEqual(snapshot(second.data), { persisted: { rows: 4 }, volatile: true }, 'the heir folded the WAL into the proxy')
    assert.equal((snapshot(second.cluster) as { me: { origin: string } }).me.origin, 'aa~2', 'reborn lane')
    await second.destroy()

    //! v4.1 identity recovery: the dir knows who it belongs to — a THIRD life with uuid OMITTED must
    // boot as 'aa', not as a fresh random heir over aa's log (the silent evicted-read-only bug)
    const third = await fero('r', { dir, listen: false })
    assert.equal((snapshot(third.cluster) as { me: { uuid: string } }).me.uuid, 'aa', 'restore recovered the identity')
    assert.equal((snapshot(third.cluster) as { me: { origin: string } }).me.origin, 'aa~3', 'same node, next incarnation')
    assert.deepEqual(snapshot(third.data), { persisted: { rows: 4 }, volatile: true }, 'the fold rode the recovered lane')
    await third.destroy()

    //! and a CONTRADICTING uuid refuses loudly — adopting a foreign log under a new name is never a default
    await assert.rejects(fero('r', { uuid: 'bb', dir }), /does not match this dir's previous life 'aa'/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v4.1 name echo: a dial onto a DIFFERENT resource refuses loudly — never admitted, never merged', async () => {
  const p = await ports.free()
  const alpha = await fero('alpha', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 0 } })
  //! 'beta' reaches for alpha's port — the exact misdial that used to silently cross-replicate
  const beta = await fero('beta', { uuid: 'bb', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 0 }, redial: { ms: 30 } })
  try {
    alpha.data.k = 'alpha-only'
    assert.ok(await until(() => diag(alpha)!.journal().events.some((e) => e.kind === JK.nameReject), 4000), 'the refusal is journal-visible (JK.nameReject)')
    assert.deepEqual((snapshot(alpha.cluster) as { peers: object }).peers, {}, 'never admitted')
    assert.deepEqual(snapshot(beta.data), {}, 'no cross-resource merge — beta never folded alpha')
  } finally {
    await beta.destroy()
    await alpha.destroy()
  }
})

test('the role rule (DESIGN-DOOR §3 step 12): a CLIENT composed with a MEMBER\'s uuid is refused at the door — the member stays linked and `cluster` keeps both members', async () => {
  const p = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type View = { epoch: number; members: Record<string, string>; peers: Record<string, unknown> }
  const view = (f: typeof a) => snapshot(f.cluster) as View
  let c: Awaited<ReturnType<typeof fero>> | null = null
  try {
    assert.ok(await until(() => view(a).epoch >= 1 && Object.keys(view(a).members).length === 2, 8000), `two members formed (${JSON.stringify(view(a))})`)
    //! the STATUS case: a stray FERO_UUID (or a copied line) gives a client a member's uuid. Before the rule
    // the duplicate-link check ran against the REAL member and could close its link.
    c = await fero('r', { uuid: 'bb', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 0 }, redial: { ms: 30 } })
    const rows = () => diag(a)!.journal().events.filter((e) => e.kind === JK.doorReject)
    assert.ok(await until(() => rows().length > 0, 8000), 'the refusal is journal-visible (JK.doorReject)')
    //! the OPEN path ships no notice (DESIGN-DOOR §3 step 12: zero new frames there), so the refused client reads a
    // bare close, redials at its redial cadence for good, elects aa as its primary for a millisecond or two on every
    // dial and loses it on the close, and aa journals one uuid-taken row per dial (about every 50 ms here; the
    // V4-32 review, STATUS records the loop). So the ROW COUNT grows and the client's primary FLICKERS: neither is
    // read as a fixed value here. What holds: every row is the one reason, and the client is never fed
    const reasons = () => [...new Set(rows().map((e) => `${e.b}:${e.c}`))]
    assert.deepEqual(reasons(), ['uuid-taken:bb'], 'the reason and the uuid claimed; never anything else')
    assert.equal(diag(a)!.journal().events.some((e) => e.kind === JK.dupLink), false, 'no duplicate-link row against the member')
    assert.deepEqual(Object.keys(view(a).members).sort(), ['aa', 'bb'], 'the view keeps both members')
    assert.ok('bb' in view(a).peers, 'the member\'s link is alive on aa')
    assert.ok('aa' in view(b).peers, 'and on bb')
    //! the members still work: a write on one lands on the other — and never on the refused client, which keeps
    // dialing and is refused on every dial (two more rows is two more dials)
    a.data.k = 1
    assert.ok(await until(() => (snapshot(b.data) as { k?: number }).k === 1, 8000), 'replication between the members is intact')
    const seen = rows().length
    assert.ok(await until(() => rows().length >= seen + 2, 8000), 'the client dials again and is refused again')
    assert.deepEqual(reasons(), ['uuid-taken:bb'], 'still the one reason')
    assert.equal((snapshot(c.data) as { k?: number }).k, undefined, 'the refused client was never fed, across those dials')
  } finally {
    await c?.destroy()
    await b.destroy()
    await a.destroy()
  }
})

test('the cluster contract (DESIGN-DOOR §4): heartbeat.ms 500 against 250 → contractReject on BOTH ends naming heartbeat.ms and the other side\'s value; never linked; a fixed value heals', async () => {
  const p = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 500 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 250 }, redial: { ms: 30 } })
  const rows = (f: typeof a) => diag(f)!.journal().events.filter((e) => e.kind === JK.contractReject).map((e) => [e.b, e.c])
  let b2: Awaited<ReturnType<typeof fero>> | null = null
  try {
    assert.ok(await until(() => rows(a).length > 0 && rows(b).length > 0, 8000), 'both journals carry the refusal')
    assert.deepEqual(rows(a)[0], ['heartbeat.ms', '250'], 'aa names the key and bb\'s value')
    assert.deepEqual(rows(b)[0], ['heartbeat.ms', '500'], 'bb names the key and aa\'s value')
    assert.deepEqual((snapshot(a.cluster) as { peers: object }).peers, {}, 'never admitted on aa')
    assert.deepEqual((snapshot(b.cluster) as { peers: object }).peers, {}, 'never admitted on bb')
    assert.equal(diag(a)!.journal().events.some((e) => e.kind === JK.identified), false, 'no identified row: the check runs before admit')
    //! bb restarts with the right value: the two form at the next heartbeat (aa's parked target is revived)
    await b.destroy()
    b2 = await fero('r', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 500 }, redial: { ms: 30 } })
    assert.ok(await until(() => Object.keys((snapshot(a.cluster) as { members: object }).members).length === 2, 8000), 'the fixed member joins')
  } finally {
    await b2?.destroy()
    await b.destroy()
    await a.destroy()
  }
})

test('the cluster contract: a different validation rule names `validation` — under methods: too (the V4-5 pair) — and a bound or native validator is refused at fero() time', async () => {
  const p = await ports.free()
  const rule1 = (r: { value?: { stock?: number } }) => (r.value?.stock ?? 0) >= 0 || 'negative stock'
  const rule2 = (r: { value?: { stock?: number } }) => (r.value?.stock ?? 0) >= 1 || 'no stock'
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, validation: rule1, methods: { sell: () => 1 } })
  const b = await fero('r', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, validation: rule2, methods: { sell: () => 1 } })
  const rows = (f: typeof a) => diag(f)!.journal().events.filter((e) => e.kind === JK.contractReject).map((e) => e.b)
  try {
    assert.ok(await until(() => rows(a).length > 0 && rows(b).length > 0, 8000), 'both refuse')
    assert.deepEqual([rows(a)[0], rows(b)[0]], ['validation', 'validation'], 'the validator text differs, even with the door on')
    assert.deepEqual((snapshot(a.cluster) as { peers: object }).peers, {})
  } finally {
    await b.destroy()
    await a.destroy()
  }
  //! a validator whose source is [native code] would hash alike for two different rules: refused in plain words
  await assert.rejects(fero('r', { listen: false, validation: rule1.bind(null) as never }), /validation must be a plain function whose source is visible/)
})

test('the methods-only hint (DESIGN-DOOR §4): a client whose feeder said m: 1 refuses its own plain writes LOCALLY — a rejected row, no pending row, no round trip; methods.update rejects at once with the same WriteRejectError; a write before the first admit is still refused remotely', async () => {
  const p = await ports.free()
  const s = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { stock: 3 }, methods: { sell: () => 1 } })
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type Row = { key: string; state: string; reason?: string }
  const rows = (f: typeof c) => Object.values(f.cluster.writes.snapshot() as Record<string, Row>)
  const nacks = (f: typeof c) => diag(f)!.journal().events.filter((e) => e.kind === JK.writeNack).length
  let early: Awaited<ReturnType<typeof fero>> | null = null
  let s2: Awaited<ReturnType<typeof fero>> | null = null
  try {
    assert.ok(await until(() => (snapshot(c.cluster) as { me: { primary: string | null } }).me.primary !== null, 8000), 'the client is fed')
    const states: string[] = []
    c.cluster.writes.tap(() => { states.push(rows(c).map((r) => r.state).join()) })
    states.length = 0
    c.data.x = 1
    await Promise.resolve()
    assert.deepEqual(rows(c).map((r) => [r.state, r.reason]), [['rejected', 'methods-only']], 'refused in the same tick — the hint, not the round trip')
    await sleep(200)
    assert.ok(states.every((s) => !s.includes('pending')), `no pending row was ever shown (${JSON.stringify(states)})`)
    assert.equal(nacks(c), 0, 'nothing went to the relay: no WNACK came back')
    assert.equal((snapshot(s.data) as { x?: number }).x, undefined, 'and nothing landed')
    //! the write methods: the SAME WriteRejectError the relay's refusal throws today
    const t0 = Date.now()
    await assert.rejects(c.methods.update({ key: 'stock', value: 1 }, { timeout: 8000 }),
      (e: WriteRejectError) => e instanceof WriteRejectError && e.reached === 'issued' && e.reason === 'methods-only' && /the server takes changes only through its methods/.test(e.message))
    assert.ok(Date.now() - t0 < 1000, 'at once')
    assert.equal(nacks(c), 0)
    //! the door is still the guard: a write issued BEFORE the first admit knows nothing, goes to the relay,
    // and comes back refused the old way (one WNACK). Deterministic: the client dials a port nobody listens
    // on yet, writes while parked (the row is `pending`), THEN the methods server starts there.
    const p2 = await ports.free()
    early = await fero('r', { uuid: 'yy', hosts: [`127.0.0.1:${p2}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, signals: false })
    assert.equal((snapshot(early.cluster) as { me: { primary: string | null } }).me.primary, null, 'nobody to dial yet')
    early.data.y = 1
    await Promise.resolve()
    assert.deepEqual(rows(early).map((r) => r.state), ['pending'], 'the write waits for a feeder — no hint has been heard')
    s2 = await fero('r', { uuid: 'ab', listen: `127.0.0.1:${p2}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, methods: { sell: () => 1 } })
    assert.ok(await until(() => rows(early!).some((r) => r.state === 'rejected' && r.reason === 'methods-only'), 8000), 'refused at the relay')
    assert.equal(nacks(early), 1, 'this one took the round trip')
  } finally {
    await early?.destroy()
    await s2?.destroy()
    await c.destroy()
    await s.destroy()
  }
})

//! ── the door with a secret (DESIGN-DOOR §3, §5, §8): node:crypto's HMAC and nonces over real sockets ──
type View = { epoch: number; writable: boolean; members: Record<string, string>; peers: Record<string, unknown>; me: { primary: string | null } }
const view = (f: Fero) => snapshot(f.cluster) as View
const doorRows = (f: Fero) => diag(f)!.journal().events.filter((e) => e.kind === JK.doorReject).map((e) => [e.b, e.c] as [string, string])
//! stderrOf — the composer's refusal lines printed while `fn` runs (process.stderr.write is swapped and
// restored; the suite runs its tests one at a time). Only fero's own lines, in order.
const stderrOf = async (fn: () => Promise<void>): Promise<string[]> => {
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  try { await fn() } finally { process.stderr.write = orig }
  return out.join('').split('\n').filter((l) => l.startsWith("fero('"))
}
//! leaks — every place a secret must never show, as one string: the journals, the captures, the config
// doors and the refusal lines of the given instances
const leaks = (lines: string[], ...fs: Fero[]): string =>
  [lines.join('\n'), ...fs.map((f) => JSON.stringify([diag(f)!.journal().events, diag(f)!.capture(), diag(f)!.config()]))].join('\n')

test('the door (DESIGN-DOOR §3): one secret forms three members over real TCP and feeds a client that holds it; admission waits for the proof (4 frames per link); nothing a secret touches appears in a journal, a capture, the config door or a message', async () => {
  const S = 'index-test-secret-CHARLIE-03'
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const mk = (i: number, uuid: string) => fero('door3', { uuid, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
  const a = await mk(0, 'aa'); const b = await mk(1, 'bb'); const d = await mk(2, 'dd')
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      assert.ok(await until(() => [a, b, d].every((f) => view(f).epoch >= 1 && Object.keys(view(f).members).length === 3), 10_000), `three members formed (${JSON.stringify(view(a))})`)
      assert.deepEqual([a, b, d].flatMap(doorRows), [], 'no refusal anywhere')
      c = await fero('door3', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
      assert.ok(await until(() => view(c!).me.primary !== null && view(c!).writable, 8000), 'the client proved as the dialer and is fed')
      c.data.k = 'from-client'
      assert.ok(await until(() => [a, b, d].every((f) => (snapshot(f.data) as { k?: string }).k === 'from-client'), 8000), 'its write landed everywhere')
      assert.equal(await c.methods.read('k'), 'from-client', 'and it can call methods')
      //! the config door says a secret is set and where from — never what it is
      assert.deepEqual(diag(a)!.config().secret, { value: '<set>', from: 'the call' })
      assert.ok(!leaks([], a, b, d, c).includes(S), 'the secret appears in no journal, capture or config door')
    } finally {
      await c?.destroy()
      await Promise.all([a, b, d].map((f) => f.destroy()))
    }
  })
  assert.deepEqual(lines, [], 'nothing was refused, nothing was printed')
})

test('the door: two members with DIFFERENT secrets never link — the acceptor journals bad-proof, the dialer refused; one stderr line per peer and reason with no duplicate across heartbeat revivals; the right secret heals', async () => {
  const S1 = 'index-test-secret-DELTA-04-one', S2 = 'index-test-secret-DELTA-04-two'
  const p = await ports.free()
  const a = await fero('doorkeys', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S1 })
  let b: Fero | null = null, b2: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      b = await fero('doorkeys', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S2 })
      assert.ok(await until(() => doorRows(a).length >= 3 && doorRows(b!).length >= 3, 8000), 'both journals carry the refusal, re-dialed at heartbeat cadence')
      assert.ok(doorRows(a).every(([r]) => r === 'bad-proof'), `aa (the acceptor) sees bad-proof: ${JSON.stringify(doorRows(a))}`)
      assert.ok(doorRows(b!).every(([r, c]) => r === 'refused' && c === `127.0.0.1:${p}`), `bb (the dialer) sees refused with its dial target: ${JSON.stringify(doorRows(b!))}`)
      assert.deepEqual(view(a).peers, {}, 'never admitted on aa')
      assert.deepEqual(view(b!).peers, {}, 'never admitted on bb')
      assert.equal(diag(a)!.journal().events.some((e) => e.kind === JK.identified), false, 'no identified row: the proof failed before admit')
      assert.ok(!leaks([], a, b!).includes(S1) && !leaks([], a, b!).includes(S2), 'neither secret appears in a journal or a capture')
      //! the fix: bb restarts with aa's secret and joins at the next heartbeat (aa's parked target is revived)
      await b.destroy()
      b2 = await fero('doorkeys', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S1 })
      assert.ok(await until(() => Object.keys(view(a).members).length === 2, 8000), 'the fixed member joins')
    } finally {
      await b2?.destroy()
      await b?.destroy()
      await a.destroy()
    }
  })
  //! one line per peer and reason, however many revivals wrote the row again
  assert.equal(lines.filter((l) => /^fero\('doorkeys'\): refused a peer that connected as 127\.0\.0\.1:\d+ — its secret differs from this node's$/.test(l)).length, 1, `aa printed once, naming the listen bb CLAIMED (aa accepted this link): ${JSON.stringify(lines)}`)
  //! bb's row is the NOTICE's (DOOR {e: 'denied'}, read on the real socket before aa's close), so its line says so; a bare close would print nothing.
  // bb holds no view and aa is its one host, so the line also says the first view waits on it (DESIGN-DIRECTORY §13: a door
  // refusal keeps the target in the genesis count, loudly)
  assert.equal(lines.filter((l) => l === `fero('doorkeys'): refused 127.0.0.1:${p} — it refused this node's proof (the secrets probably differ) — the first view waits on it`).length, 1, `bb printed once: ${JSON.stringify(lines)}`)
  assert.equal(lines.length, 2, `nothing else: ${JSON.stringify(lines)}`)
  assert.ok(!lines.join('\n').includes(S1) && !lines.join('\n').includes(S2), 'no secret in a line')
})

test("the door: a secured server and a client with NO secret — the server journals no-secret, the client peer-secret; the client's line names FERO_SECRET; its cluster.writable stays false and it never gets a feeder", async () => {
  const S = 'index-test-secret-ECHO-05'
  const p = await ports.free()
  const s = await fero('doornone', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S, data: { stock: 3 } })
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      c = await fero('doornone', { uuid: 'zz', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      assert.ok(await until(() => doorRows(c!).length >= 2 && doorRows(s).length >= 2, 8000), 'both refuse, and keep refusing at heartbeat cadence')
      assert.ok(doorRows(c!).every(([r, to]) => r === 'peer-secret' && to === `127.0.0.1:${p}`), JSON.stringify(doorRows(c!)))
      assert.ok(doorRows(s).every(([r]) => r === 'no-secret'), JSON.stringify(doorRows(s)))
      await sleep(300)
      assert.equal(view(c!).me.primary, null, 'no feeder')
      assert.equal(view(c!).writable, false, 'cluster.writable stays false')
      assert.deepEqual(snapshot(c!.data), {}, 'the client learned nothing')
      assert.deepEqual(view(s).peers, {}, 'never admitted')
    } finally {
      await c?.destroy()
      await s.destroy()
    }
  })
  assert.equal(lines.length, 2, `one line per end, however many revivals: ${JSON.stringify(lines)}`)
  assert.ok(lines.includes(`fero('doornone'): refused by 127.0.0.1:${p} — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)`), `the client's line names FERO_SECRET: ${JSON.stringify(lines)}`)
  assert.ok(lines.includes("fero('doornone'): refused a peer that connected — it has no secret and this node has one; every member must share FERO_SECRET, a client holds it or FERO_SECRET_CLIENT"), `the server's line: ${JSON.stringify(lines)}`)
  assert.ok(!lines.join('\n').includes(S))
})

test('the call\'s secret is trimmed like the text layers trim theirs: a client whose call pads the secret with spaces is fed by a server with the bare value; sixteen spaces are refused as a short value without echoing them', async () => {
  const S = 'index-test-secret-LIMA-12'
  const p = await ports.free()
  const s = await fero('doortrim', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S, data: { stock: 3 } })
  let c: Fero | null = null
  try {
    c = await fero('doortrim', { uuid: 'zz', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: `  ${S}\t` })
    assert.ok(await until(() => (snapshot(c!.data) as { stock?: number }).stock === 3, 8000), `fed: ${JSON.stringify(doorRows(s))}`)
    assert.deepEqual(doorRows(s), [], 'no refusal: the two secrets are one')
    await assert.rejects(fero('doortrim', { listen: false, secret: ' '.repeat(16) }), (e: Error) => /at least 16 characters/.test(e.message) && !e.message.includes('    '))
  } finally { await c?.destroy(); await s.destroy() }
})

//! rawHello — a hand-written peer: connect, write one HELLO, wait for the server to close (or `ms`)
const rawHello = (addr: string, hello: Record<string, unknown>, ms = 1500): Promise<void> => new Promise((resolve) => {
  const [host, port] = [addr.slice(0, addr.lastIndexOf(':')), Number(addr.slice(addr.lastIndexOf(':') + 1))]
  let done = false
  const finish = () => { if (done) return; done = true; sock.destroy(); resolve() }
  const sock = net.connect(port, host, () => { sock.write(encodeControl(VERB.HELLO, hello)) })
  sock.on('close', finish); sock.on('error', () => {})
  setTimeout(finish, ms).unref()
})

//! V4-NN (STATUS: "The refusal lines can skip a line on a journal ring overflow"): the lines were fed from the
// composer's post-step journal cursor, so a refusal row the ring overwrote inside its own step never printed. The
// shape: a member that evicts a client squatting on a member's uuid goes on to admit that member IN THE SAME STEP
// (identified, the digest, the join…), so below a few rows of journal.cap the eviction's row is gone by the fold.
// The refusal rows are kept beside the ring now (kernel/journal.ts keep) and the composer reads them from there.
test('a refusal line survives the journal ring overflowing inside its own step: a member with journal.cap 1 evicts a client squatting on a joining member\'s uuid, and says so', async () => {
  const p = await ports.free()
  const A = `127.0.0.1:${p}`
  const a = await fero('ringcap', { uuid: 'aa', listen: A, heartbeat: { ms: 50 }, redial: { ms: 30 }, journal: { cap: 1 } })
  let b: Fero | null = null
  //! the squatter: a raw client that took the uuid bb before any member had it, and never re-dials
  let sock: net.Socket | null = null
  const lines = await stderrOf(async () => {
    try {
      sock = net.connect(p, '127.0.0.1', () => { sock!.write(encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: '', r: 1 })) })
      sock.on('error', () => {})
      type Peer = { client: boolean }
      const peer = () => (view(a).peers as Record<string, Peer | undefined>).bb
      assert.ok(await until(() => peer()?.client === true, 8000), 'the squatter is admitted as a client')
      b = await fero('ringcap', { uuid: 'bb', server: true, hosts: [A], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      assert.ok(await until(() => peer()?.client === false && Object.keys(view(a).members).length === 2, 8000), 'the member bb took its uuid back, and joined')
      assert.equal(diag(a)!.journal().events.some((e) => e.kind === JK.doorReject), false, 'the ring did not keep the eviction row')
    } finally {
      ;(sock as net.Socket | null)?.destroy()
      await b?.destroy()
      await a.destroy()
    }
  })
  assert.deepEqual(lines.filter((l) => l.startsWith("fero('ringcap')")), ["fero('ringcap'): refused a client claiming uuid bb — that uuid belongs to a member (a shared FERO_UUID?)"], 'the line, though its row is gone')
})

test('the refusal lines print nothing a peer chose unfiltered: a connecting socket\'s claimed listen with a newline and an escape gives ONE line, cut and clean (100k characters is a malformed HELLO and prints nothing); another socket with another claim prints nothing new (inbound refusals print once per reason); an open server\'s forged contract value is cut and clean too', async () => {
  const S = 'index-test-secret-KILO-11'
  const p = await ports.free(), p2 = await ports.free()
  const s = await fero('doorsafe', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
  const o = await fero('doorsafe2', { uuid: 'ab', listen: `127.0.0.1:${p2}`, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  //! 235 bytes: inside LISTEN_MAX (259, kernel/door.ts), far past the line's cut of 64
  const evil = `x\nfero('doorsafe'): a fake line\u001b[2J` + 'y'.repeat(200)
  const lines = await stderrOf(async () => {
    try {
      //! a claim past LISTEN_MAX never reaches the door: a malformed HELLO, with no row a line could print
      await rawHello(`127.0.0.1:${p}`, { u: 'zw', i: 1, l: evil + 'y'.repeat(100_000), n: 'doorsafe' })
      assert.ok(await until(() => diag(s)!.journal().events.some((e) => e.kind === JK.frameDrop && e.b === 'malformed hello: listen over 259 bytes'), 5000), 'malformed')
      assert.equal(doorRows(s).length, 0, 'no door row for the long claim')
      await rawHello(`127.0.0.1:${p}`, { u: 'zz', i: 1, l: evil, n: 'doorsafe' })
      assert.ok(await until(() => doorRows(s).length >= 1, 5000), 'refused no-secret')
      assert.equal(doorRows(s)[0][1].length, evil.length, 'the row carries the claim as made — the row is the record, the line is the print')
      await rawHello(`127.0.0.1:${p}`, { u: 'zy', i: 1, l: 'z\rother' + 'q'.repeat(200), n: 'doorsafe' })
      assert.ok(await until(() => doorRows(s).length >= 2, 5000), 'refused again')
      await rawHello(`127.0.0.1:${p2}`, { u: 'zx', i: 1, l: '127.0.0.1:1', n: 'doorsafe2', c: 'v1;heartbeat.ms=\nanything\u001b[2J' })
      assert.ok(await until(() => diag(o)!.journal().events.some((e) => e.kind === JK.contractReject), 5000), 'contractReject')
      await sleep(100)
    } finally { await o.destroy(); await s.destroy() }
  })
  const mine = lines.filter((l) => l.startsWith("fero('doorsafe')"))
  assert.equal(mine.length, 1, `one line for two inbound no-secret refusals, and the injected newline forged none: ${JSON.stringify(lines)}`)
  assert.ok(mine[0].startsWith("fero('doorsafe'): refused a peer that connected as xfero('doorsafe'): a fake line[2Jyyyy"), mine[0])
  assert.ok(mine[0].includes('…') && mine[0].length < 260, `cut at 64 characters of claim: ${mine[0].length} chars in all`)
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(mine[0]), 'no control character')
  const theirs = lines.filter((l) => l.startsWith("fero('doorsafe2')"))
  assert.equal(theirs.length, 1, JSON.stringify(lines))
  assert.ok(theirs[0].includes('heartbeat.ms is 50 here, anything[2J there'), theirs[0])
  assert.ok(!theirs[0].includes('\u001b'))
})

test('the door: the role rule holds WITH a secret — a client that holds the secret and a member\'s uuid is refused uuid-taken after its proof, the member stays linked; the server\'s line names the uuid, the client\'s line names the dial target and its own uuid', async () => {
  const S = 'index-test-secret-FOXTROT-06'
  const p = await ports.free()
  const a = await fero('doorrole', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S, data: { seed: 1 } })
  const b = await fero('doorrole', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      assert.ok(await until(() => view(a).epoch >= 1 && Object.keys(view(a).members).length === 2, 8000), 'two members formed')
      //! heartbeats ON for the client: a refused target is parked, and revival re-dials it once per tick, so the
      // best-effort notice (lost under socket.destroy() now and then) is read on some attempt
      c = await fero('doorrole', { uuid: 'bb', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
      //! the client's proof verifies (it holds the secret), and THEN the role rule refuses it — a stranger without
      // the secret never gets this far. The client re-dials on its chain, so the row repeats; every one is this.
      assert.ok(await until(() => doorRows(a).length > 0, 8000), 'refused')
      await sleep(300)
      assert.ok(doorRows(a).length > 0 && doorRows(a).every(([r, u]) => r === 'uuid-taken' && u === 'bb'), `the role rule and the uuid claimed, nothing else: ${JSON.stringify(doorRows(a))}`)
      assert.equal(diag(a)!.journal().events.some((e) => e.kind === JK.dupLink), false, 'no duplicate-link row against the member')
      assert.deepEqual(Object.keys(view(a).members).sort(), ['aa', 'bb'])
      assert.ok('bb' in view(a).peers && 'aa' in view(b).peers, 'the member\'s link is alive on both ends')
      assert.deepEqual(snapshot(c.data), {}, 'the refused client never received the seed: it was refused before any digest')
      //! the client's own side: the role rule ran BEFORE the server's proof, so the client was still proving when
      // the notice reached it — its row keeps the notice's word, uuid-taken, naming the dial target. A LOST notice
      // (the frame is best-effort under socket.destroy()) writes NO row: the bare close that follows is a link loss,
      // re-dialed on the chain (the third review) — so every row the client holds is the notice's; it never admitted aa
      assert.ok(await until(() => doorRows(c!).some(([r]) => r === 'uuid-taken'), 8000), `the client has its own row with the reason: ${JSON.stringify(doorRows(c!))}`)
      assert.ok(doorRows(c!).every(([r, to]) => r === 'uuid-taken' && to === `127.0.0.1:${p}`), `the notice's word and the dial target on every row — a lost notice writes none: ${JSON.stringify(doorRows(c!))}`)
      assert.equal(view(c!).me.primary, null, 'never admitted the server on its own side')
      a.data.k = 1
      assert.ok(await until(() => (snapshot(b.data) as { k?: number }).k === 1, 8000), 'replication between the members is intact')
    } finally {
      await c?.destroy()
      await b.destroy()
      await a.destroy()
    }
  })
  assert.ok(lines.includes("fero('doorrole'): refused a client claiming uuid bb — that uuid belongs to a member (a shared FERO_UUID?)"), JSON.stringify(lines))
  //! the client's line says what the kernel was told — the uuid clash — not a guess about the secret
  assert.ok(lines.includes(`fero('doorrole'): refused by 127.0.0.1:${p} — the uuid this process runs as, bb, belongs to a member there (a shared FERO_UUID?)`), JSON.stringify(lines))
  assert.equal(lines.filter((l) => l.startsWith("fero('doorrole'): refused by")).length, 1, `one line for the dial target across every revival: ${JSON.stringify(lines)}`)
})

//! rawListener — a hand-written peer that LISTENS, so a member dials it as a typed host; it reads the member's HELLO and,
// once `release` resolves, answers with `reply` (a HELLO of its own). Resolves with its address.
const rawListener = (reply: Record<string, unknown>, release: Promise<void>) => new Promise<{ addr: string; close: () => void }>((resolve) => {
  const socks = new Set<net.Socket>()
  const srv = net.createServer((sock) => {
    socks.add(sock); sock.on('error', () => {}); sock.on('close', () => socks.delete(sock))
    sock.once('data', () => { release.then(() => { if (!sock.destroyed) sock.write(encodeControl(VERB.HELLO, reply)) }) })
  })
  srv.listen(0, '127.0.0.1', () => {
    const a = srv.address() as net.AddressInfo
    resolve({ addr: `127.0.0.1:${a.port}`, close: () => { for (const s of socks) s.destroy(); srv.close() } })
  })
})

test('the printer says the SIDE, not the link table (the third review\'s minor): a member that DIALED a host which answers as a client claiming another member\'s uuid prints the refusing-side line — the host\'s address and the uuid it claimed — never "the uuid this process runs as"; the row is the refusing side\'s (c = the claimed uuid) and the member\'s link is untouched', async () => {
  const p = await ports.free()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const x = await rawListener({ u: 'aa', i: 1, l: '', r: 1 }, gate)
  const a = await fero('doorside', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let b: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      //! bb dials aa and the raw host; the host holds its answer until aa is admitted at bb, then claims aa's uuid as a client
      b = await fero('doorside', { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`, x.addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      assert.ok(await until(() => 'aa' in view(b!).peers, 8000), 'bb admitted aa over its dialed link')
      //! and the pair has FORMED before the host answers: a member that holds no view yet says "the first view waits on it"
      // on every refusal of a dialed host (DESIGN-DIRECTORY §13), which is not this test's line
      assert.ok(await until(() => Object.keys(view(b!).members).length === 2, 8000), 'the pair formed')
      release()
      assert.ok(await until(() => doorRows(b!).length >= 1, 8000), 'bb refused the host')
      assert.deepEqual(doorRows(b!)[0], ['uuid-taken', 'aa'], 'the refusing side\'s row on a DIALED link: c is the uuid the host claimed')
      assert.ok('aa' in view(b!).peers, 'the member\'s link is untouched')
      await sleep(100)
    } finally { await b?.destroy(); await a.destroy(); x.close() }
  })
  const mine = lines.filter((l) => l.startsWith("fero('doorside')"))
  assert.deepEqual(mine, [`fero('doorside'): refused ${x.addr} — it answered as a client claiming uuid aa; that uuid belongs to a member (a shared FERO_UUID?)`], JSON.stringify(lines))
  assert.ok(!lines.some((l) => l.includes('the uuid this process runs as')), `the client wording belongs to the refused client alone: ${JSON.stringify(lines)}`)
})

test('the off-loopback rule (DESIGN-DOOR §14 Q1): a server listening off loopback with no secret is refused at fero() time; secret: false runs it open on purpose; a secret runs it; the directory-socket refusal still wins for 0.0.0.0:3376; a client is never refused; secret: 123 and a short secret are refused without echoing them', async () => {
  const p = await ports.free()
  await assert.rejects(fero('r', { listen: `0.0.0.0:${p}` }), new RegExp(`^Error: fero\\('r'\\): listen 0\\.0\\.0\\.0:${p} is reachable from other machines and no secret is set — set FERO_SECRET \\(the same value on every member; a client holds it or FERO_SECRET_CLIENT\\), or pass secret: false \\(FERO_SECRET=off\\) to run open on purpose$`))
  await assert.rejects(fero('r', { listen: `[::]:${p}` }), /is reachable from other machines and no secret is set/)
  await assert.rejects(fero('r', { listen: '0.0.0.0:3376' }), /would take the directory's socket/, 'the directory-socket check runs first (example 15\'s line is untouched)')
  for (const host of ['127.0.0.1', 'localhost', '127.0.0.2']) {
    const f = await fero('r', { listen: `${host}:${p}` })
    try { assert.equal(diag(f)!.config().secret, undefined, `${host} is loopback: open by default`) } finally { await f.destroy() }
  }
  const open = await fero('r', { listen: `0.0.0.0:${p}`, secret: false })
  try { assert.deepEqual(diag(open)!.config().secret, { value: false, from: 'the call' }, 'open on purpose, and the door says so') } finally { await open.destroy() }
  const locked = await fero('r', { listen: `0.0.0.0:${p}`, secret: 'index-test-secret-GOLF-07' })
  try { assert.deepEqual(diag(locked)!.config().secret, { value: '<set>', from: 'the call' }) } finally { await locked.destroy() }
  //! a client has no listen: nothing to refuse
  const c = await fero('r', { hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 0 }, redial: { ms: 30 } })
  try { assert.equal(view(c).me.primary, null) } finally { await c.destroy() }
  //! the call's shape: a number, a boolean, a short string — refused in the config's words, the value never echoed
  for (const bad of [123456789012345678, true, 'short-secret', ''] as unknown[])
    await assert.rejects(fero('r', { listen: false, secret: bad as never }), (e: Error) => {
      assert.match(e.message, /^fero\('r'\): secret must be text of at least 16 characters — a value that is all digits is read as a number; openssl rand -base64 24 prints a good one; or secret: false to run open on purpose$/)
      assert.ok(bad === '' || !e.message.includes(String(bad)), `never the value: ${e.message}`)
      return true
    }, String(bad))
})

//! ── the derived client key (DESIGN-DOOR §15): node:crypto's derivation over real sockets ──
test('the client key (§15): fero.clientKey(secret) is the openssl one-liner\'s string — 43 base64url characters, trimmed like every layer trims the secret; a short secret is refused naming the floor', async () => {
  const { execFileSync } = await import('node:child_process')
  const S = 'index-test-secret-MIKE-13'
  const k = fero.clientKey(S)
  assert.equal(k.length, 43); assert.match(k, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(fero.clientKey(`  ${S}\t`), k, 'trimmed')
  assert.notEqual(k, fero.clientKey(S + 'x'))
  //! the README's shell line gives the same string (a sh child; the secret rides argv there, which the README says)
  const sh = execFileSync('sh', ['-c', `printf 'fero/client/1' | openssl dgst -sha256 -hmac "$1" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='`, 'sh', S], { encoding: 'utf8' }).trim()
  assert.equal(sh, k, 'openssl and node:crypto agree')
  assert.throws(() => fero.clientKey('short'), /^Error: fero\.clientKey\(secret\): the secret must be text of at least 16 characters — openssl rand -base64 24 prints a good one$/)
  assert.throws(() => fero.clientKey(undefined as never), /at least 16 characters/)
})

test('the client key (§15) over real TCP: a client with secret: { client } follows a secured cluster — fed, its write lands, methods work; the same process composed as a server is refused at fero(); neither the secret nor the key appears in a journal, a capture, the config door or a line', async () => {
  const S = 'index-test-secret-NOVEMBER-14'
  const K = fero.clientKey(S)
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const mk = (i: number, uuid: string) => fero('ckey', { uuid, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S, data: { seed: 1 } })
  const a = await mk(0, 'aa'); const b = await mk(1, 'bb')
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      assert.ok(await until(() => [a, b].every((f) => view(f).epoch >= 1 && Object.keys(view(f).members).length === 2), 10_000), 'two members formed')
      //! the same opts as a server: refused before any socket, in plain words, never echoing the key
      await assert.rejects(fero('ckey', { uuid: 'zz', server: true, hosts: addrs, secret: { client: K } }), (e: Error) => {
        assert.equal(e.message, "fero('ckey'): secret.client is the client key — it lets a process follow, never serve; a server needs the secret (secret: '…' or FERO_SECRET)")
        return true
      })
      c = await fero('ckey', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: { client: K } })
      assert.ok(await until(() => view(c!).me.primary !== null && view(c!).writable, 8000), 'the client-key client proved as the dialer, verified the member\'s client-key answer, and is fed')
      assert.ok(await until(() => (snapshot(c!.data) as { seed?: number }).seed === 1, 8000), 'it reads the seed')
      c.data.k = 'from-client-key'
      assert.ok(await until(() => [a, b].every((f) => (snapshot(f.data) as { k?: string }).k === 'from-client-key'), 8000), 'its write landed on both members')
      assert.equal(await c.methods.read('k'), 'from-client-key', 'and it can call methods')
      assert.deepEqual([a, b, c].flatMap(doorRows), [], 'no refusal anywhere')
      assert.ok(Object.values(view(a).peers).length >= 1 && 'zz' in view(a).peers || 'zz' in view(b).peers, 'a member holds it as a peer')
      assert.deepEqual(Object.keys(view(a).members).sort(), ['aa', 'bb'], 'never a member')
      //! the config door: the client key is set and where from; secret itself is unset on the client, <set> on a member
      assert.deepEqual(diag(c)!.config()['secret.client'], { value: '<set>', from: 'the call' })
      assert.equal(diag(c)!.config().secret, undefined)
      assert.deepEqual(diag(a)!.config().secret, { value: '<set>', from: 'the call' })
      assert.equal(diag(a)!.config()['secret.client'], undefined)
      const all = leaks([], a, b, c)
      assert.ok(!all.includes(S) && !all.includes(K), 'neither the secret nor the client key appears in a journal, a capture or a config door')
    } finally {
      await c?.destroy()
      await Promise.all([a, b].map((f) => f.destroy()))
    }
  })
  assert.deepEqual(lines, [], 'nothing was refused, nothing was printed')
})

test("the client key (§15) over real TCP: two clients with the key and a member WITHOUT a secret — the member's line names FERO_SECRET, the clients' lines say they hold the client key; a client with a WRONG key is refused by a secured server and reads the notice with the client-only line; no key in a line", async () => {
  const S = 'index-test-secret-OSCAR-15'
  const K = fero.clientKey(S)
  const p = await ports.free()
  const open = await fero('ckeyopen', { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { stock: 3 } })
  let c1: Fero | null = null, c2: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      c1 = await fero('ckeyopen', { uuid: 'c1', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: { client: K } })
      c2 = await fero('ckeyopen', { uuid: 'c2', hosts: [`127.0.0.1:${p}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: { client: K } })
      assert.ok(await until(() => doorRows(c1!).length >= 1 && doorRows(c2!).length >= 1 && doorRows(open).length >= 2, 8000), 'both refuse at both ends')
      assert.ok(doorRows(open).every(([r]) => r === 'peer-secret'), JSON.stringify(doorRows(open)))
      assert.ok([c1!, c2!].every((c) => doorRows(c).every(([r, to]) => r === 'no-secret' && to === `127.0.0.1:${p}`)), JSON.stringify([doorRows(c1!), doorRows(c2!)]))
      await sleep(200)
      assert.equal(view(c1!).me.primary, null); assert.equal(view(c2!).me.primary, null)
      assert.deepEqual(view(open).peers, {}, 'never admitted')
    } finally {
      await c1?.destroy(); await c2?.destroy(); await open.destroy()
    }
  })
  assert.ok(lines.includes("fero('ckeyopen'): refused by a peer that connected — it has a secret and this process has none (set FERO_SECRET to the cluster's secret)"), `the member's line names FERO_SECRET: ${JSON.stringify(lines)}`)
  assert.equal(lines.filter((l) => l === `fero('ckeyopen'): refused 127.0.0.1:${p} — it has no secret and this process holds the client key; every member must set FERO_SECRET`).length, 1, `the client-only line once: both clients share this process, the name and the dial target, and the printer dedupes on those: ${JSON.stringify(lines)}`)
  assert.ok(!lines.join('\n').includes(K))
  //! a WRONG client key against a secured server: bad-proof at the server (its usual line), the notice read at the client
  // as refused, with the client-only wording
  const p2 = await ports.free()
  const s = await fero('ckeywrong', { uuid: 'aa', listen: `127.0.0.1:${p2}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
  let w: Fero | null = null
  const wrong = await stderrOf(async () => {
    try {
      w = await fero('ckeywrong', { uuid: 'ww', hosts: [`127.0.0.1:${p2}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: { client: fero.clientKey(S + '-other') } })
      assert.ok(await until(() => doorRows(s).length >= 1 && doorRows(w!).some(([r]) => r === 'refused'), 8000), `refused: ${JSON.stringify([doorRows(s), doorRows(w!)])}`)
      assert.ok(doorRows(s).every(([r]) => r === 'bad-proof'), JSON.stringify(doorRows(s)))
      assert.ok(doorRows(w!).every(([r, to]) => r === 'refused' && to === `127.0.0.1:${p2}`), JSON.stringify(doorRows(w!)))
      assert.equal(view(w!).me.primary, null)
    } finally { await w?.destroy(); await s.destroy() }
  })
  assert.ok(wrong.includes(`fero('ckeywrong'): refused 127.0.0.1:${p2} — it refused this process's client key (is FERO_SECRET_CLIENT fero.clientKey of that cluster's secret?)`), JSON.stringify(wrong))
  assert.ok(wrong.some((l) => /^fero\('ckeywrong'\): refused a peer that connected — its secret differs from this node's$/.test(l)), `the server's usual line: ${JSON.stringify(wrong)}`)
  assert.ok(!wrong.join('\n').includes(S))
})

test('an IPv6 address goes in brackets: a server on [::1]:0 prints its listen back with them, a client dials that printed form and sees the data; a host with a colon that is not a whole IPv6 literal is refused with the bracket hint', async () => {
  const s = await fero('r', { uuid: 'aa', listen: '[::1]:0', data: { w: 1 }, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let c: Fero | undefined
  try {
    const l = (snapshot(s.cluster) as { me: { listen: string } }).me.listen
    assert.match(l, /^\[::1\]:\d+$/, `the printed listen keeps its brackets: ${l}`)
    assert.notEqual(l, '[::1]:0', 'the real port, not 0')
    c = await fero('r', { uuid: 'cc', hosts: [l], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => (c!.snapshot as { w?: number }).w === 1, 8000), `the client dialed ${l} and was fed`)
  } finally { await c?.destroy(); await s.destroy() }
  const hint = /an IPv6 address goes in brackets: '\[::1\]:4000', or '\[fdaa::3\]' for a bare host/
  await assert.rejects(fero('r', { listen: 'fdaa::3' }), hint, "a bare 'fdaa::3' would read as host 'fdaa:', port 3")
  await assert.rejects(fero('r', { hosts: ['fdaa::3'] }), hint, 'the same in hosts, where a bare host asks that box\'s directory')
  await assert.rejects(fero('r', { listen: '[nothost]:0' }), /listen must be a 'host:port' string/, 'brackets hold an IPv6 literal only')
})

test('v4.1 uuid discipline: empty and lane-separator uuids refuse at fero() time', async () => {
  await assert.rejects(fero('r', { uuid: '' }), /uuid must be a non-empty string/)
  await assert.rejects(fero('r', { uuid: 'a~1' }), /without '~'/)
})

test('the uuid is bounded at 64 bytes (UTF-8): a longer one is refused at fero() time with the bound and its size (the FERO_UUID refusal: tests/config.test.ts); 64 bytes compose', async () => {
  await assert.rejects(fero('r', { uuid: 'x'.repeat(65), listen: false }), /^Error: fero\('r'\): uuid must be at most 64 bytes \(UTF-8\), got 65 — it names this node's lane in every record frame it sends$/)
  await assert.rejects(fero('r', { uuid: 'é'.repeat(33), listen: false }), /uuid must be at most 64 bytes \(UTF-8\), got 66/, 'bytes, not characters: 33 two-byte characters')
  const f = await fero('r', { uuid: 'x'.repeat(64), listen: false })
  try { assert.equal((snapshot(f.cluster) as { me: { uuid: string } }).me.uuid.length, 64) } finally { await f.destroy() }
})

//! refuses — fero() must reject with `re`. If it composes instead (a check gone), the instance is destroyed first, so a
// missing check is a red line, never a test process held open by a live instance until the battery's time limit
const refuses = async (p: Promise<Fero>, re: RegExp, msg?: string): Promise<void> => {
  let f: Fero
  try { f = await p } catch (e) { assert.match(String(e), re, msg); return }
  await f.destroy()
  assert.fail(`fero() composed; expected a refusal matching ${re}${msg ? ` (${msg})` : ''}`)
}

test('the name is bounded at 255 bytes (UTF-8, kernel/door.ts NAME_MAX): a longer one is refused at fero() time with the bound and its size, and so is a dir whose boot record carries one; 255 bytes compose', async () => {
  await refuses(fero('s'.repeat(256), { listen: false }), /^Error: fero\('s{24}…'\): name must be at most 255 bytes \(UTF-8\), got 256 — it rides every HELLO and every directory row$/)
  await refuses(fero('é'.repeat(128), { listen: false }), /name must be at most 255 bytes \(UTF-8\), got 256/, 'bytes, not characters')
  await refuses(fero('x'.repeat(1 << 20), { listen: false }), /got 1048576/, 'a long one is refused without a megabyte message')
  //! the message's cut never splits a character in two: 'a' and 11 emoji are 23 UTF-16 units, so a cut at 24 would keep
  // half of the 12th (a lone surrogate, which prints as U+FFFD)
  await refuses(fero('a' + '😀'.repeat(200), { listen: false }), /^Error: fero\('a(?:😀){11}…'\): name must be at most 255 bytes \(UTF-8\), got 801 /, 'cut at a whole character')
  const f = await fero('s'.repeat(255), { listen: false })
  await f.destroy()
  //! a restored dir: the name a hand edit put in boot.json is refused for its size, not printed whole by the
  // one-dir-one-resource refusal
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-name-'))
  try {
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'aa', name: 'r'.repeat(300), epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    await refuses(fero('r', { dir, listen: false }), /^Error: fero\('r'\): this dir's boot record carries a name over 255 bytes \(UTF-8; got 300\) — repair boot\.json$/)
    //! …and a name that is not a string at all (a hand edit) is refused in words, never a TypeError, and the refusal gives
    // the dir back: a second fero() on it meets the same refusal, not "held by this process already"
    for (const [bad, what] of [[Array(300).fill('a'), 'an array'], [{ length: 300 }, 'an object'], [7, 'a number']] as const) {
      fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'aa', name: bad, epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
      for (const time of ['first', 'second'])
        await refuses(fero('r', { dir, listen: false }), new RegExp(`^Error: fero\\('r'\\): this dir's boot record carries a name that is not a string \\(${what}\\) — repair boot\\.json$`), `${what}, the ${time} time`)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an address\'s host is bounded at 253 bytes (UTF-8, kernel/door.ts HOST_MAX, the longest DNS name) wherever an address is given — listen, hosts (with a port or bare), rendezvous — so every listen fits the 259 bytes a peer checks; 253 bytes pass the check', async () => {
  const long = / \(its host is 254 bytes; a host is at most 253, the longest DNS name\)$/
  await refuses(fero('r', { listen: 'h'.repeat(254) + ':0' }), /^Error: fero\('r'\): listen must be a 'host:port' string/)
  await refuses(fero('r', { listen: 'h'.repeat(254) + ':0' }), long)
  await refuses(fero('r', { listen: 'é'.repeat(127) + ':4000' }), long, 'bytes, not characters')
  await refuses(fero('r', { hosts: ['h'.repeat(254) + ':4000'] }), /hosts\[0\] .* is not a 'host:port' address .* \(its host is 254 bytes/)
  //! a bare host is a dotted DNS name: labels of 63, 255 bytes in all
  const dotted = (n: number) => ['h'.repeat(63), 'h'.repeat(63), 'h'.repeat(63), 'h'.repeat(n - 192)].join('.')
  await refuses(fero('r', { hosts: [dotted(255)] }), /hosts\[0\] .* is not a 'host:port' address .* \(its host is 255 bytes/)
  await refuses(fero('r', { rendezvous: 'h'.repeat(254) + ':3376', listen: false }), /rendezvous must be a 'host:port' string .* \(its host is 254 bytes/)
  //! FERO_RENDEZVOUS, read here with the config layer off (the battery's pin), names the size too (the layer-on read:
  // tests/config.test.ts 'refusals name their source')
  const saved = process.env.FERO_RENDEZVOUS
  try {
    process.env.FERO_RENDEZVOUS = 'h'.repeat(254) + ':3376'
    await refuses(fero('r', { server: true, heartbeat: { ms: 0 } }), /^Error: fero\('r'\): FERO_RENDEZVOUS='h{254}:3376' is not a 'host:port' address \(or 'off'\) \(its host is 254 bytes; a host is at most 253, the longest DNS name\)$/)
  } finally { if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved }
  //! the bound itself passes the address check, and meets the next rule: a routable listen needs a secret; a bare host
  // needs the directory (the battery runs it off)
  await refuses(fero('r', { listen: 'h'.repeat(253) + ':0' }), /is reachable from other machines and no secret is set/)
  await refuses(fero('r', { hosts: [dotted(253)] }), /has no port, which means "ask that box's directory" — but the directory is off/)
})

test('v4.1 f.snapshot: the synchronous dense value — data\'s [value] read surfaced first-class', async () => {
  const f = await fero('r', { uuid: 'aa', listen: false })
  try {
    f.data.w = { stock: 3 }
    assert.deepEqual(f.snapshot, { w: { stock: 3 } })
    assert.deepEqual(f.snapshot, snapshot(f.data), 'identical to the substrate read — no internals import needed')
    assert.equal(JSON.stringify(f.snapshot), '{"w":{"stock":3}}', 'stringify-ready (the render-loop idiom)')
  } finally { await f.destroy() }
})

test('destroy is clean: sockets down, timers cleared, capture detached — the proxy survives as a plain local value', async () => {
  const p = await ports.free()
  const f = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}` })
  f.data.k = 1
  await f.destroy()
  f.data.local = 2 // no capture, no kernel — a local mutation only
  assert.deepEqual(snapshot(f.data), { k: 1, local: 2 })
})

test('M5b — a CLIENT (hosts, no listen): full state through one feeder, its own write shows as the server-stamped echo, failover past a dead server', async () => {
  //! THREE servers: the failover leg kills one, and a surviving MAJORITY must exist to evict it —
  // with two, a write owned by the dead member would (correctly, CP) park forever
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const mk = (i: number, uuid: string) =>
    fero('r', { uuid, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const a = await mk(0, 'aa')
  const b = await mk(1, 'bb')
  const d = await mk(2, 'dd')
  let c: Awaited<ReturnType<typeof fero>> | null = null
  try {
    //! a committed view first, so client writes exercise the relay (ae=0) path, not open genesis
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    a.data.seeded = 'before-client'
    c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
    //! catch-up: the spoke folds the full state through its primary
    assert.ok(await until(() => (snapshot(c!.data) as Record<string, unknown>).seeded === 'before-client'), 'client caught up')
    //! V4-7: a client never commits, so its own assignment is NOT visible yet — it shows when the
    // server's stamped record echoes back (the same apply every other node sees)
    c.data.mine = { from: 'client' }
    assert.equal((snapshot(c.data) as Record<string, unknown>).mine, undefined, 'no optimistic copy')
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).mine !== undefined, 8000), 'the echo painted it')
    assert.deepEqual((snapshot(c.data) as Record<string, unknown>).mine, { from: 'client' })
    const r = await c.methods.update({ key: 'via-method', value: 1 }, { timeout: 8000 })
    assert.notEqual(r.origin, 'zz', 'a client NEVER stamps provenance — the commit is server-stamped')
    assert.ok(await until(() => (snapshot(a.data) as Record<string, unknown>)['via-method'] === 1
      && (snapshot(b.data) as Record<string, unknown>).mine !== undefined), 'client writes visible cluster-wide')
    //! failover: kill a whole server (maybe the feeder, maybe an owner) — the surviving majority
    // evicts it, the spoke re-feeds if needed, and writes flow again
    await a.destroy()
    c.data.after = 'failover'
    assert.ok(await until(() => (snapshot(b.data) as Record<string, unknown>).after === 'failover'
      && (snapshot(d.data) as Record<string, unknown>).after === 'failover', 30000), 'the write flowed past the dead server (eviction + re-route)')
    assert.ok((snapshot(c.data) as Record<string, unknown>).seeded === 'before-client', 'spoke state intact')
  } finally {
    await c?.destroy()
    await b.destroy()
    await d.destroy()
    await a.destroy().catch(() => {})
  }
})

test("relayed client writes run the SERVER's validation: at the relay: the refused row never lands anywhere — not even on the client's own screen — and its methods.update rejects with the server's reason", async () => {
  //! the IDEAS probe (2026-09-05): before this fix a server that refused its OWN `data.admin = …` still
  // let a bare client's `data.admin = …` LAND (the relay re-stamped but ran no validator)
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 },
    validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved'),
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const rows = (f: typeof c) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; reason?: string }>)
  try {
    //! the server refuses its OWN admin write (the local hook, unchanged)
    s.data.admin = 'local'
    assert.equal((snapshot(s.data) as Record<string, unknown>).admin, undefined)
    //! a plain client assignment: nothing shows (V4-7), the relay refuses it, and cluster.writes shows
    // the server's reason on the rejected row
    c.data.admin = 'from-client'
    assert.equal((snapshot(c.data) as Record<string, unknown>).admin, undefined, 'no optimistic copy on the client')
    const rejected = () => rows(c).find((r) => r.key === JSON.stringify(['admin']) && r.state === 'rejected')
    assert.ok(await until(() => rejected() !== undefined, 8000), 'cluster.writes shows the rejected row')
    assert.equal(rejected()?.reason, 'reserved', "the client reads the SERVER's validator verbatim")
    assert.equal((snapshot(c.data) as Record<string, unknown>).admin, undefined, 'still nothing: refused is invisible, not bounced')
    //! methods.update rejects TYPED with the same reason — the WriteReject contract, not a hang or a timeout
    await assert.rejects(
      c.methods.update({ key: 'admin', value: 1 }, { timeout: 8000 }),
      (e: { guarantee: string; reached: string; reason: string }) => e.reason === 'reserved' && e.reached === 'issued' && e.guarantee === 'committed')
    //! an admitted client write still lands cluster-wide, and the refused row never existed anywhere
    c.data.open = 1
    assert.ok(await until(() => (snapshot(s.data) as Record<string, unknown>).open === 1, 8000), 'the admitted write flowed')
    assert.equal((snapshot(s.data) as Record<string, unknown>).admin, undefined, 'the server never held the refused row')
    assert.equal(rows(s).some((r) => r.key === JSON.stringify(['admin']) && r.state !== 'rejected'), false)
  } finally {
    await c.destroy()
    await s.destroy()
  }
})

test("a spoke re-syncs to the cluster's truth: a server reborn EMPTY makes the client's stale cells disappear — the client never re-teaches it", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const a = await fero('r', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let a2: Awaited<ReturnType<typeof fero>> | null = null
  const view = (f: typeof c) => snapshot(f.data) as Record<string, unknown>
  try {
    a.data.x = 1
    a.data.y = 2
    assert.ok(await until(() => view(c).y === 2, 8000), 'the spoke folded the server')
    await a.destroy()
    //! the server comes back with NOTHING (no dir): the cluster's truth is now empty
    a2 = await fero('r', { uuid: 'aa2', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => view(c).x === undefined && view(c).y === undefined, 12000), 'the stale cells disappeared from the spoke')
    assert.deepEqual(view(a2), {}, 'the spoke taught the reborn server nothing')
  } finally {
    await c.destroy()
    await a2?.destroy()
  }
})

test("V4-18 overlapping cells — a seeded row plus a client's field write across a memory-only restart: the reborn server re-seeds the row, the spoke's re-download keeps it whole, and both snapshots are equal", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const seed = () => ({ gadgets: { stock: 3, name: 'gizmo' } })
  const a = await fero('cells', { uuid: 'aa', listen: addr, data: seed(), heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const c = await fero('cells', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let a2: Awaited<ReturnType<typeof fero>> | null = null
  const view = (f: typeof c) => snapshot(f.data) as { gadgets?: { stock?: number; name?: string } }
  try {
    assert.ok(await until(() => view(c).gadgets?.stock === 3, 8000), 'the spoke folded the seed')
    c.data.gadgets.stock = 9 // a FIELD write on the seeded row, relayed and stamped by the server
    assert.ok(await until(() => view(c).gadgets?.stock === 9 && view(a).gadgets?.stock === 9, 8000), 'the field write shows on both')
    await a.destroy()
    //! the server comes back memory-only: a fresh identity, the seed applied again, the client's field gone
    a2 = await fero('cells', { uuid: 'aa2', listen: addr, data: seed(), heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => view(c).gadgets?.stock === 3, 12000), `the spoke re-synced to the reborn seed (it shows ${JSON.stringify(view(c))})`)
    //! before V4-18 the spoke's resync removed its stale ['gadgets','stock'] cell as a ghost — tearing the
    // field out of the row it had just re-downloaded whole — and the two screens disagreed for good
    await sleep(200)
    assert.deepEqual(view(c), view(a2), 'both snapshots equal')
    assert.deepEqual(view(a2), seed())
  } finally {
    await c.destroy()
    await a2?.destroy()
  }
})

test('v4.1 roles: following is ambient, serving is a declared act — in the battery the directory is OFF, so topologies are explicit', async () => {
  //! no marker = a CLIENT (the open method namespace is the client tell). With no directory (the
  // battery runs FERO_RENDEZVOUS=off) a client needs hosts — bare refuses loudly: nothing to dial.
  await assert.rejects(fero(`bare-role-${process.pid}`, { heartbeat: { ms: 0 } }), /needs something to dial/)
  const feeder = `127.0.0.1:${await ports.free()}`
  const bare = await fero(`bare-role-${process.pid}`, { hosts: [feeder], heartbeat: { ms: 0 } })
  assert.equal(typeof bare.methods.anything, 'function', 'bare fero is a client — open namespace')
  //! observability: the role, the effective dial targets and the rendezvous state ride cluster.me
  const bm = (snapshot(bare.cluster) as { me: { role: string; hosts: string[]; rendezvous: unknown } }).me
  assert.equal(bm.role, 'client')
  assert.deepEqual(bm.hosts, [feeder], 'the effective dial targets are public')
  assert.equal(bm.rendezvous, false, 'no directory')
  await bare.destroy()
  //! a data seed / a method / dir / replicas / server: true each imply SERVER (closed namespace) — and a
  // server without listen binds a FREE loopback port (V4-3: port 0, the OS picks), visible in me.listen.
  // NB this also retires M5b's durable-client refusal: dir implies server, so a durable spoke is
  // unrepresentable by construction — {hosts, dir} is a durable dialing MEMBER now.
  const viaData = await fero(`role-via-data-${process.pid}`, { data: { k: 1 }, heartbeat: { ms: 0 } })
  assert.equal(typeof viaData.methods.anything, 'undefined', 'a data seed implies server')
  const vm = (snapshot(viaData.cluster) as { me: { role: string; listen: string } }).me
  assert.equal(vm.role, 'server')
  assert.match(vm.listen, /^127\.0\.0\.1:[1-9]\d*$/, 'a real ephemeral port, never :0')
  assert.deepEqual(snapshot(viaData.data), { k: 1 }, 'seeded')
  await viaData.destroy()
  const viaMethod = await fero('r', { listen: false, methods: { m: () => 1 } })
  assert.equal(typeof viaMethod.methods.anything, 'undefined', 'methods imply server')
  await viaMethod.destroy()
  //! the loud refusals: an undialable member; a role pin that is not literally true; a dead-end
  // client with an EMPTY hosts and no directory; a loopback default listen gossiped to non-local peers
  await assert.rejects(fero('r', { listen: false, hosts: ['127.0.0.1:1'] }), /undialable/)
  await assert.rejects(fero('r', { server: 1 } as never), /server must be true/)
  await assert.rejects(fero('r', { hosts: [] }), /needs something to dial/)
  await assert.rejects(fero('r', { server: true, hosts: ['10.0.0.5:4800'] }), /to be reachable from another box, listen on a routable address — hosts names 10\.0\.0\.5:4800, another box, but listen 127\.0\.0\.1:0 \(the default/)
  //! an EXPLICIT listen that cannot bind still rejects (and the failure path tears the runtime down,
  // not leaks it); the default listen is port 0, which cannot collide
  const caddr = `127.0.0.1:${await ports.free()}`
  const ci = caddr.lastIndexOf(':')
  const blocker = net.createServer()
  await new Promise<void>((res, rej) => { blocker.once('error', rej); blocker.listen(Number(caddr.slice(ci + 1)), caddr.slice(0, ci), res) })
  try {
    await assert.rejects(fero(`collide-${process.pid}`, { listen: caddr }), /EADDRINUSE/)
  } finally { await new Promise<void>((r) => blocker.close(() => r())) }
})

test("hosts entries are checked as ADDRESSES and the bad one is named — a role file that read its ports off argv and got a --fero flag used to die deep in the shell on Node's raw port error", async () => {
  await assert.rejects(fero('r', { hosts: ['127.0.0.1:4801', '--fero.heartbeat.ms', '50'] }), /fero\('r'\): hosts\[1\] '--fero\.heartbeat\.ms' is not a 'host:port' address/)
  await assert.rejects(fero('r', { hosts: ['127.0.0.1:4801', 7] } as never), /hosts\[1\] 7 is not a 'host:port' address/)
  await assert.rejects(fero('r', { hosts: ['127.0.0.1:4801', '50'] }), /hosts\[1\] '50' is not a 'host:port' address/)
  //! a host with no port is legal now — it asks that box's directory (docs/DESIGN-DIRECTORY.md §11) — but
  // never in silence with the directory off (the battery's FERO_RENDEZVOUS=off): there is no port to ask at
  await assert.rejects(fero('r', { hosts: ['127.0.0.1'] }), /hosts entry '127\.0\.0\.1' has no port, which means "ask that box's directory" — but the directory is off \(from FERO_RENDEZVOUS\)/)
  await assert.rejects(fero('r', { hosts: 'nope' } as never), /hosts must be an array/)
})

test('v4.1 identity hardening: legacy dirs, incomplete dirs, invalid and cross-resource boot records all refuse loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-idh-'))
  try {
    //! a v4.0 boot record (no uuid): the RANDOM default may never claim it — one misboot would stamp
    // the accident into boot.json and lock the true owner out behind the mismatch throw
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    await assert.rejects(fero('r', { dir, listen: false }), /predates identity recovery/)
    const up = await fero('r', { uuid: 'aa', dir, listen: false }) // the one-time named upgrade…
    await up.destroy()
    const rec = await fero('r', { dir, listen: false }) // …and recovery is automatic thereafter
    assert.equal((snapshot(rec.cluster) as { me: { uuid: string } }).me.uuid, 'aa')
    await rec.destroy()
    //! the dir records WHAT as well as WHO — the disk twin of the HELLO name echo
    await assert.rejects(fero('other', { dir, listen: false }), /belongs to resource 'r'/)
    //! an invalid uuid planted in boot.json refuses with the same rule as config
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'x~2', epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    await assert.rejects(fero('r', { dir, listen: false }), /invalid uuid/)
    //! …and the same size bound as config (UUID_MAX, 64 UTF-8 bytes): a longer restored uuid would boot, and then every
    // peer would drop its HELLO as malformed, with no message on either side (the 2026-10-21 review's probe)
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'y'.repeat(70), name: 'r', epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    await assert.rejects(fero('r', { dir, listen: false }), /^Error: fero\('r'\): this dir's boot record carries a uuid over 64 bytes \(UTF-8; got 70\) — every peer would refuse it; repair boot\.json$/)
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'é'.repeat(33), name: 'r', epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    await assert.rejects(fero('r', { dir, listen: false }), /uuid over 64 bytes \(UTF-8; got 66\)/, 'bytes, not characters')
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'y'.repeat(64), name: 'r', epoch: 0, members: [], lamport: 0, incarnation: 1, votedFor: { e: 0, p: '', h: '' } }))
    const at64 = await fero('r', { dir, listen: false }) // 64 bytes is the bound itself: it boots
    assert.equal((snapshot(at64.cluster) as { me: { uuid: string } }).me.uuid, 'y'.repeat(64))
    await at64.destroy()
    //! …and the life count: ISSUER_MAX gives the incarnation 16 digits (a safe integer). A hand-edited 1e17 on a 64-byte
    // uuid made an 83-byte origin, and every WRITE that node forwarded was refused as malformed at its owner, with no
    // message (the 2026-10-21 re-check's probe); a string count would concatenate at the bump; a count below 1 would
    // reuse the first life's lane. Each is refused at compose with "repair boot.json"; a whole number boots and bumps.
    for (const bad of [1e17, '5', 1.5, 0, -1]) {
      fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'y'.repeat(64), name: 'r', epoch: 0, members: [], lamport: 0, incarnation: bad, votedFor: { e: 0, p: '', h: '' } }))
      await assert.rejects(fero('r', { dir, listen: false }), /invalid incarnation .* repair boot\.json$/, `incarnation ${JSON.stringify(bad)}`)
    }
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ uuid: 'y'.repeat(64), name: 'r', epoch: 0, members: [], lamport: 0, incarnation: 7, votedFor: { e: 0, p: '', h: '' } }))
    const life8 = await fero('r', { dir, listen: false })
    assert.equal((snapshot(life8.cluster) as { me: { incarnation: number } }).me.incarnation, 8, 'a whole number boots as the next life')
    await life8.destroy()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  //! a NON-EMPTY wal.log with no boot.json is an incomplete dir (partial copy) — never adopted
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-idh2-'))
  try {
    fs.writeFileSync(path.join(dir2, 'wal.log'), Buffer.from([1, 2, 3]))
    await assert.rejects(fero('r', { uuid: 'bb', dir: dir2, listen: false }), /no boot\.json/)
  } finally { fs.rmSync(dir2, { recursive: true, force: true }) }
})

test('v4.1 data seed: a row the validation refuses throws at fero() time — never a silent partial seed (both spellings)', async () => {
  const rule = (r: { value?: { stock?: number } }) => ((r.value?.stock ?? 0) >= 0 ? true : 'negative stock')
  await assert.rejects(fero('r', { listen: false, data: { a: { stock: 1 }, b: { stock: -5 } }, validation: rule }),
    /data seed row 'b' rejected by validation — negative stock/)
  await assert.rejects(fero('r', { listen: false, data: { a: { stock: 1 }, b: { stock: -5 } }, seams: { validation: rule } }),
    /data seed row 'b' rejected by validation — negative stock/, 'the old spelling is the same rule (one release)')
})

test('validation: is a top-level function (not a method pointer); a non-function is refused; the door shows it as [function] under either spelling', async () => {
  const rule = (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved')
  await assert.rejects(fero('r', { listen: false, validation: 'strict' } as never), /fero\('r'\): validation must be a function \(record\) => true \| 'the reason' — it runs on every write that enters/)
  for (const opts of [{ validation: rule }, { seams: { validation: rule } }]) {
    const f = await fero('r', { listen: false, ...opts } as never)
    try {
      f.data.admin = 1
      f.data.ok = 1
      assert.deepEqual(f.snapshot, { ok: 1 }, 'the rule ran on the local ingest')
      await assert.rejects(f.methods.update({ key: 'admin', value: 2 }), (e: WriteReject) => e.reason === 'reserved')
      assert.deepEqual(diag(f)!.config().validation, { value: '[function]', from: 'the call' })
      assert.equal(diag(f)!.config()['seams.validation'], undefined, 'one key: the old spelling is folded into it')
    } finally { await f.destroy() }
  }
})

test('diag.allow: the DIAG allowlist reaches the kernel; the door names who may attach and never shows a token; a bad shape is refused', async () => {
  const f = await fero('r', { listen: false, diag: { allow: { ops: 'tok-123', alice: 'tok-456' } } })
  try {
    assert.deepEqual(diag(f)!.config()['diag.allow'], { value: { ops: '[redacted]', alice: '[redacted]' }, from: 'the call' })
    assert.ok(!JSON.stringify(diag(f)!.config()).includes('tok-'), 'no token anywhere in the door')
  } finally { await f.destroy() }
  const plain = await fero('r', { listen: false })
  try { assert.equal(diag(plain)!.config()['diag.allow'], undefined, 'absent: the channel is dead, nothing to show') } finally { await plain.destroy() }
  await assert.rejects(fero('r', { listen: false, diag: { allow: { ops: 7 } } } as never), /diag\.allow\.ops must be a non-empty token string/)
  await assert.rejects(fero('r', { listen: false, diag: { allow: 'tok' } } as never), /diag\.allow must be an object of name → token/)
})

test('v4.1 data seed: applied only when the local fold is empty at boot — a restore never re-seeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-seed-'))
  const seed = { widgets: { stock: 10 } }
  try {
    const a = await fero('r', { uuid: 'aa', dir, listen: false, data: seed })
    assert.deepEqual(snapshot(a.data), { widgets: { stock: 10 } }, 'the empty fold seeded')
    a.data.widgets.stock = 4
    await a.destroy()
    const b = await fero('r', { dir, listen: false, data: seed })
    assert.equal((snapshot(b.data) as { widgets: { stock: number } }).widgets.stock, 4, 'the restore kept the newer value — no re-seed clobber')
    await b.destroy()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  await assert.rejects(fero('r', { listen: false, data: [1] as never }), /plain object/)
})

test('M5-REVIEW #9 — an async write rejection surfaces as a typed WriteReject, never a bare string', async () => {
  //! drive a MAX_PENDING overflow: a client with no reachable server, flood past the bound → 'dropped'
  const c = await fero('r', { uuid: 'zz', hosts: ['127.0.0.1:1'], heartbeat: { ms: 0 } })
  try {
    const rejects: unknown[] = []
    //! MAX_PENDING is 1024; issue well past it while nothing can drain (no primary)
    await Promise.all(Array.from({ length: 1100 }, (_, i) =>
      c.methods.update({ key: `k${i}`, value: i }, { timeout: 2000 }).catch((e) => rejects.push(e))))
    assert.ok(rejects.length > 0, 'some writes were rejected under overflow/timeout')
    for (const e of rejects) {
      assert.equal(typeof e, 'object', 'a typed WriteReject object, never a bare string')
      assert.ok((e as { guarantee?: string }).guarantee, 'carries guarantee')
      assert.ok((e as { reached?: string }).reached, 'carries reached')
    }
  } finally {
    await c.destroy()
  }
})

test("a write rejection is a WriteRejectError: an Error with a stack whose message names the resource, the verb, the key and the rung — the typed fields ride on it unchanged, and a client with nobody to write to is told why", async () => {
  //! a client dialing a dead port: the write is issued and times out with no primary — the rung-04 shape
  const c = await fero('shop', { uuid: 'zz', hosts: ['127.0.0.1:1'], heartbeat: { ms: 0 } })
  try {
    const e = await c.methods.update({ key: 'x', value: 1 }, { timeout: 200 }).then(() => null, (e: unknown) => e) as WriteRejectError
    assert.ok(e instanceof WriteRejectError && e instanceof Error, 'an Error subclass, so an uncaught one dies with a stack')
    assert.equal(e.name, 'WriteRejectError')
    assert.ok(typeof e.stack === 'string' && e.stack.startsWith('WriteRejectError: fero'), 'the stack opens with the message')
    assert.equal(e.message, `fero('shop') update ["x"]: timeout after 200ms — reached issued (nobody to write to: a bare fero(name) is a client; pass server: true to host)`)
    //! the fields are own enumerable properties and nothing else is: `{ ...e }` IS the WriteReject
    assert.deepEqual({ ...e }, { guarantee: 'committed', reached: 'issued', reason: 'timeout' })
  } finally {
    await c.destroy()
  }
  //! a local refusal (the validator) and a confirm that cannot be proven read the same way
  const s = await fero('shop', { uuid: 'aa', listen: false, seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') } })
  try {
    const e = await s.methods.remove({ key: ['admin', 'role'] }).then(() => null, (e: unknown) => e) as WriteRejectError
    assert.ok(e instanceof WriteRejectError)
    assert.equal(e.message, `fero('shop') remove ["admin","role"]: reserved — reached issued`)
    assert.deepEqual({ ...e }, { guarantee: 'committed', reached: 'issued', reason: 'reserved' })
  } finally {
    await s.destroy()
  }
})

test("I-30: an EMPTY key on methods.update / methods.remove is refused TYPED ('invalid-key') before any stamp — solo and on a two-member cluster; nothing reaches the kernel and the process lives on", async () => {
  const bad = (e: WriteRejectError) => e instanceof WriteRejectError && e.reason === 'invalid-key' && e.reached === 'issued' && /data\.k/.test(e.message)
  //! solo: the old code rejected with data's own Error thrown from inside the kernel step
  const f = await fero('r', { uuid: 'aa', listen: false })
  try {
    f.data.k = 1
    await assert.rejects(f.methods.update({ value: 7 } as never), bad)
    await assert.rejects(f.methods.remove({ key: [] }), bad)
    await assert.rejects(f.methods.update({ key: [], value: 7 }), bad)
    assert.deepEqual(snapshot(f.data), { k: 1 }, 'nothing landed, nothing was lost')
    assert.equal(diag(f).logSize(), 1, 'nothing was ever stamped')
  } finally {
    await f.destroy()
  }
  //! two members (epoch ≥ 1 — the attempt path): the old code threw AGAIN from the projection about a
  // second later, outside any try, and killed the process even though the caller had caught the first
  const pa = await ports.free()
  const pb = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1 && (snapshot(b.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    await assert.rejects(a.methods.update({ value: 7 } as never), bad)
    await assert.rejects(b.methods.remove({ key: [] }), bad)
    await sleep(1200)
    a.data.k = 1
    assert.ok(await until(() => (snapshot(b.data) as { k?: number }).k === 1, 8000), 'the cluster is whole and still replicates')
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test('M5-REVIEW #3 — write() clears its timeout timer on settle (no timer/closure accumulation on the hot path)', async () => {
  const f = await fero('r', { uuid: 'aa', listen: false })
  try {
    const before = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length : 0
    //! a burst of fast (epoch-0) writes — each resolves immediately; none may leave a live timer behind
    for (let i = 0; i < 200; i++) await f.methods.update({ key: `k${i}`, value: i })
    const after = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length : 0
    assert.ok(after - before < 50, `write() timers cleared on settle (Timeout handles: ${before} → ${after})`)
  } finally {
    await f.destroy()
  }
})

test('M5-REVIEW #12 (v4 form) — an illegal root replace throws PRE-COMMIT: no ghost, no heal, binding stays live', async () => {
  //! the v3 throw-then-heal microtask dance is structurally gone: fero's LENS refuses the
  // root replace BEFORE data commits anything (DESIGN-DATA3 §4.1/W6), so the state below
  // is asserted IMMEDIATELY — nothing to heal. The v4 value symbol is the read hatch now.
  const { value } = await import('../../data/api/index.ts') as { value: symbol }
  const s = await fero('r', { uuid: 'aa', listen: false })
  try {
    s.data.keep = { n: 1 }
    s.data.also = 2
    assert.throws(() => { (s.data as Record<symbol, unknown>)[value] = { wiped: true } }, /replace keys/)
    assert.deepEqual(snapshot(s.data), { keep: { n: 1 }, also: 2 }, 'refused pre-commit — no ghost root, synchronously')
    //! and it is still LIVE: a normal write straight after works
    s.data.after = 3
    assert.equal((snapshot(s.data) as Record<string, unknown>).after, 3)
  } finally {
    await s.destroy()
  }
})

test('a clean destroy LEAVES (V4-6): two servers, one destroyed — the survivor\'s view shrinks by ballot and stays writable ALONE; a new identity then joins it', async () => {
  const [pa, pb, pc] = [await ports.free(), await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const view = () => snapshot(a.cluster) as { epoch: number; writable: boolean; members: Record<string, string> }
  let c: Awaited<ReturnType<typeof fero>> | undefined
  try {
    assert.ok(await until(() => view().epoch >= 1 && (snapshot(b.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    b.data.before = 'from b'
    assert.ok(await until(() => a.snapshot.before === 'from b'))
    //! Ctrl-C in the two-terminals story: destroy() LEAVES — a ballot with the survivor — before it tears down
    const t0 = Date.now()
    await b.destroy()
    assert.ok(diag(b)!.journal().events.some((e) => e.kind === JK.left && e.b === 1), 'the leaver went CLEAN: its shrunk view committed and aa echoed it')
    assert.ok(await until(() => view().epoch === 2 && Object.keys(view().members).length === 1 && view().writable, 5000), `the survivor is alone and writable (${JSON.stringify(view())})`)
    assert.ok(Date.now() - t0 < 4000, 'a ballot, not a suspicion timeout')
    const r = await a.methods.update({ key: 'after', value: 1 }, { timeout: 5000 })
    assert.equal(r.guarantee, 'committed')
    //! the restarted terminal is a NEW identity — it joins the one-member view (old majority = aa alone)
    c = await fero('r', { uuid: 'cc', listen: `127.0.0.1:${pc}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => Object.keys(view().members).length === 2 && (snapshot(c!.cluster) as { epoch: number }).epoch === view().epoch, 8000), 'the newcomer was admitted')
    assert.ok(await until(() => c!.snapshot.after === 1 && c!.snapshot.before === 'from b'), 'and caught up — including the row the leaver wrote')
  } finally {
    await a.destroy()
    await c?.destroy()
  }
})

test('the cluster view folds in ONE batch (V4-8): a bare cluster.tap fires once per change with the whole picture landed — never a half-updated view, never for a refold that changed nothing', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type View = { epoch: number; writable: boolean; members: Record<string, string>; peers: Record<string, unknown> }
  const pictures: { epoch: number; writable: boolean; members: number; peers: number }[] = []
  //! the tap is attached BEFORE the peer exists, so every fold of the forming view is recorded
  a.cluster.tap(() => { const v = snapshot(a.cluster) as View; pictures.push({ epoch: v.epoch, writable: v.writable, members: Object.keys(v.members).length, peers: Object.keys(v.peers).length }) })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.ok(await until(() => pictures.some((p) => p.epoch >= 1 && p.members === 2 && p.peers === 1), 8000), `the view formed and the tap saw it whole (${JSON.stringify(pictures)})`)
    //! pre-V4-8 the fold set epoch, writable, members, peers one record at a time and the tap fired per
    // record: a picture with the new epoch but the old (empty) members was observable. Never again.
    assert.ok(pictures.every((p) => p.epoch === 0 || p.members >= 2), `no half-updated picture (${JSON.stringify(pictures)})`)
    //! and only real changes fire: the construction fire, the link (peers 0→1), the view (epoch 0→1 with its
    // members) — a heartbeat's worth of refolds that change nothing adds none
    const n = pictures.length
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(pictures.length, n, 'a settled view fires nothing more')
    assert.ok(n <= 4, `${n} fires for construction + link + view`)
    //! a write outcome is NOT a picture change: the ring is its own handle (f.cluster.writes), so the
    // cluster tap stays quiet across writes — a render loop over the view repaints only when the view moves
    let ring = 0
    a.cluster.writes.tap(() => { ring++ })
    assert.equal(ring, 1, 'a tap fires once as it attaches')
    ring = 0
    for (let i = 0; i < 10; i++) a.data['k' + i] = i
    assert.ok(await until(() => b.snapshot.k9 === 9, 3000), 'the writes landed')
    await sleep(150)
    assert.equal(pictures.length, n, `ten writes fire the cluster tap NOT AT ALL (${JSON.stringify(pictures.slice(n))})`)
    assert.ok(ring >= 1, `the ring has its own tap, and the writes fired it (${ring})`)
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test('journal.cap below one step\'s burst never starves the cluster view: the fold sees the ring overflow (journal.dropped) and refolds from live state', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  //! a ring of 2: a link coming up or a view install emits more rows in one step than the ring holds, so
  // the rows the fold rides on (identified, viewInstall, linkDown) can be gone before the fold reads them
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, journal: { cap: 2 },
    methods: { watch: (_: unknown, ctx: { data: unknown }) => ctx.data } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, journal: { cap: 2 },
    methods: { watch: (_: unknown, ctx: { data: unknown }) => ctx.data } })
  type View = { epoch: number; writable: boolean; members: Record<string, string>; peers: Record<string, unknown> }
  const view = (f: typeof a) => snapshot(f.cluster) as View
  const d = diag(a)!
  let c: Awaited<ReturnType<typeof fero>> | undefined
  try {
    assert.ok(await until(() => view(a).epoch >= 1 && Object.keys(view(a).members).length === 2 && view(a).writable, 5000), `the view formed (${JSON.stringify(view(a))})`)
    //! the client arrives into a SETTLED view: the step that admits it is the only one that names it, and
    // nothing after it refolds — the picture must follow the live links, not the rows that survived
    //! redial.ms 500 keeps the client's reconnect out of the window after the drop (as in the served() test)
    c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 500 } })
    assert.ok(await until(() => Object.keys(view(a).peers).sort().join() === 'bb,zz', 3000), `the server's picture names the client (${JSON.stringify(view(a).peers)})`)
    assert.ok(await until(() => (snapshot(c!.cluster) as { me: { primary: string | null } }).me.primary === 'aa', 3000), 'the client is fed by aa')
    assert.ok(d.journal().dropped > 0, 'the ring did overflow')
    const live = c.methods.watch() as { first?: unknown }
    void live.first
    assert.ok(await until(() => d.served() === 1, 4000), 'the host serves the sub')
    assert.equal(d.drop!('zz'), true)
    assert.ok(await until(() => d.served() === 0 && Object.keys(view(a).peers).join() === 'bb', 2000), `linkDown reaped the serve and the client left the picture (${JSON.stringify(view(a).peers)})`)
    await b.destroy()
    assert.ok(await until(() => view(a).epoch >= 2 && Object.keys(view(a).members).length === 1 && view(a).writable, 5000), `the survivor's view shrank (${JSON.stringify(view(a))})`)
  } finally {
    await c?.destroy()
    await a.destroy()
    await b.destroy()
  }
})

test('journal.cap 2 on a SCOPED cluster: the overflow refold keeps every held row in the LOCAL lens, and a partition that moved away leaves it', async () => {
  const [pa, pb, pc] = [await ports.free(), await ports.free(), await ports.free()]
  const opts = (uuid: string, port: number, hosts: number[]) =>
    ({ uuid, listen: `127.0.0.1:${port}`, hosts: hosts.map((h) => `127.0.0.1:${h}`), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1, journal: { cap: 2 } })
  const a = await fero('r', opts('aa', pa, [pb]))
  const b = await fero('r', opts('bb', pb, [pa]))
  let c: Awaited<ReturnType<typeof fero>> | undefined
  let z: Awaited<ReturnType<typeof fero>> | undefined
  type View = { epoch: number; writable: boolean; members: Record<string, string> }
  //! the LOCAL lens (the shard this node shows), never the gather: `await f.data` asks every holder for
  // its rows, so it would hide a row the refold wrongly mirrored out of this node's own lens
  const shown = (f: typeof a) => Object.keys(snapshot(f.data) as object).sort()
  const all = Array.from({ length: 20 }, (_, i) => 'p' + i).sort()
  //! replicas 1: once the shards settle, every row is in exactly one member's lens and none is missing
  const split = (fs: (typeof a)[]) => {
    const seen = fs.flatMap(shown)
    return seen.length === all.length && seen.sort().join() === all.join()
  }
  try {
    assert.ok(await until(() => [a, b].every((f) => (snapshot(f.cluster) as View).epoch >= 1 && (snapshot(f.cluster) as View).writable), 5000), 'the view formed')
    for (let i = 0; i < 20; i++) a.data['p' + i] = i
    assert.ok(await until(() => split([a, b]), 5000), `every row is in exactly one lens (aa ${shown(a)} | bb ${shown(b)})`)
    const [heldA, heldB] = [shown(a).join(), shown(b).join()]
    assert.ok(heldA !== '' && heldB !== '', 'both members hold some rows')
    assert.ok(diag(a)!.journal().dropped > 0 && diag(b)!.journal().dropped > 0, 'both rings overflowed')
    //! more lost folds over the settled shards: a client coming up (one step of many rows) and a burst
    // of writes to a key of its own. A refold that mirrored out a held row would empty a lens here.
    z = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 500 } })
    assert.ok(await until(() => (snapshot(z!.cluster) as { me: { primary: string | null } }).me.primary === 'aa', 3000), 'the client is fed by aa')
    for (let i = 0; i < 10; i++) a.data.extra = i
    await sleep(300)
    assert.deepEqual([shown(a).filter((k) => k !== 'extra').join(), shown(b).filter((k) => k !== 'extra').join()], [heldA, heldB], 'the lost folds kept every held row in its lens')
    await z.destroy()
    z = undefined
    delete a.data.extra
    //! a third member takes some partitions: the old holders SHED them, and a ring of 2 can lose the
    // shed row before the fold reads it. The refold mirrors out exactly the rows whose partition the
    // kernel no longer has, so the three lenses still split the rows with none twice and none missing.
    c = await fero('r', opts('cc', pc, [pa, pb]))
    assert.ok(await until(() => [a, b, c!].every((f) => Object.keys((snapshot(f.cluster) as View).members).length === 3), 8000), 'the view grew to three')
    assert.ok(await until(() => shown(c!).length > 0 && split([a, b, c!]), 15000), `the shards re-split (aa ${shown(a)} | bb ${shown(b)} | cc ${shown(c)})`)
    await sleep(300)
    assert.ok(split([a, b, c]), `and stay split (aa ${shown(a)} | bb ${shown(b)} | cc ${shown(c)})`)
  } finally {
    await z?.destroy()
    await c?.destroy()
    await a.destroy()
    await b.destroy()
  }
})

test("a leaving member paints no frame after destroy(): its own shrunk view is the survivors' picture, not its last frame", async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    type View = { epoch: number; writable: boolean; members: Record<string, string> }
    assert.ok(await until(() => [a, b].every((f) => (snapshot(f.cluster) as View).epoch >= 1 && Object.keys((snapshot(f.cluster) as View).members).length === 2), 8000), 'the view formed')
    let stopped = false
    const after: string[] = []
    b.cluster.tap(() => { if (stopped) { const v = snapshot(b.cluster) as View; after.push(`epoch ${v.epoch} writable ${v.writable} members ${Object.keys(v.members).length}`) } })
    stopped = true
    await b.destroy()
    assert.ok(diag(b)!.journal().events.some((e) => e.kind === JK.left && e.b === 1), 'the leave went through the ballot (so the leaver DID install the shrunk view)')
    await sleep(100)
    assert.deepEqual(after, [], 'no cluster frame follows destroy() on the leaver')
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test('cluster.writes is its own handle and on time: committed one microtask after a solo write, no timer; its tap fires per outcome; the cluster tap does not', async () => {
  //! a heartbeat of a whole second: the old ring folded only on the NEXT kernel step, so `committed`
  // showed up to heartbeat.ms late, under an object that already held the value
  const f = await fero('r', { listen: false, heartbeat: { ms: 1000 } })
  try {
    type Row = { key: string; state: string; origin?: string; seq?: number }
    const rows = () => Object.values(f.cluster.writes.snapshot() as Record<string, Row>)
    let views = 0
    f.cluster.tap(() => { views++ })
    const seen: string[][] = []
    f.cluster.writes.tap(() => { seen.push(rows().map((r) => `${r.key} ${r.state}`)) })
    seen.length = 0 // a tap fires once as it attaches; count from here
    views = 0
    f.data.k = 1
    assert.equal(f.snapshot.k, 1, 'the value is there at once')
    await Promise.resolve()
    assert.deepEqual(rows().map((r) => [r.key, r.state, r.origin]), [[JSON.stringify(['k']), 'committed', f.cluster.snapshot().me.origin]], 'committed one microtask later — no timer')
    assert.deepEqual(seen, [[`${JSON.stringify(['k'])} committed`]], 'ONE ring fire for the issue and its settle in one tick')
    for (let i = 0; i < 10; i++) f.data['n' + i] = i
    await Promise.resolve()
    assert.equal(rows().length, 11)
    assert.ok(rows().every((r) => r.state === 'committed'))
    assert.equal(seen.length, 2, 'a burst of ten is one more fire, not ten')
    assert.equal(views, 0, 'the cluster view did not move')
    assert.equal('writes' in (f.cluster.snapshot() as object), false, 'the ring is not a key of the cluster view')
    //! the wrapper forwards everything else: a data operator over the cluster view still works
    const epochs = f.cluster.map((v: unknown) => v)
    assert.ok(epochs !== undefined)
    //! a full ring keeps the last 64, oldest evicted, in order
    for (let i = 0; i < 70; i++) f.data['m' + i] = i
    await Promise.resolve()
    const last = rows()
    assert.equal(last.length, 64)
    assert.equal(last[last.length - 1].key, JSON.stringify(['m69']))
  } finally {
    await f.destroy()
  }
})

test('cluster.writes on a client: a relayed write is `pending` until the server commits it (V4-7), then `committed` — one ring fire each', async () => {
  const pa = await ports.free()
  const s = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, heartbeat: { ms: 50 } })
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    type Row = { key: string; state: string; origin?: string }
    const rows = () => Object.values(c.cluster.writes.snapshot() as Record<string, Row>)
    assert.ok(await until(() => (snapshot(c.cluster) as { me: { primary: string | null } }).me.primary !== null, 8000), 'the client is fed')
    const seen: string[] = []
    c.cluster.writes.tap(() => { seen.push(rows().map((r) => r.state).join()) })
    seen.length = 0 // a tap fires once as it attaches; count from here
    c.data.k = 1
    await Promise.resolve()
    assert.deepEqual(rows().map((r) => r.state), ['pending'], 'a request until the server stamps it')
    assert.equal(c.snapshot.k, undefined, 'and nothing shows early')
    assert.ok(await until(() => rows()[0]?.state === 'committed', 3000), 'committed once the server stamped it')
    assert.equal(rows()[0].origin, 'aa', "under the server's lane")
    assert.equal(c.snapshot.k, 1)
    assert.deepEqual(seen, ['pending', 'committed'], 'one fire per outcome')
  } finally {
    await c.destroy()
    await s.destroy()
  }
})

test('cluster.writes after destroy(): a write still in flight reads `rejected destroyed`, as its promise does — never `pending` for ever', async () => {
  //! a client whose server is not there: its write parks as a `pending` row and never commits
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${await ports.free()}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type Row = { key: string; state: string; reason?: string }
  const rows = () => Object.values(c.cluster.writes.snapshot() as Record<string, Row>)
  const seen: string[] = []
  c.cluster.writes.tap(() => { seen.push(rows().map((r) => r.state).join()) })
  seen.length = 0 // a tap fires once as it attaches; count from here
  c.data.q = 1
  await Promise.resolve()
  assert.deepEqual(rows().map((r) => r.state), ['pending'], 'in flight')
  await c.destroy()
  await sleep(20)
  assert.deepEqual(rows().map((r) => [r.key, r.state, r.reason]), [[JSON.stringify(['q']), 'rejected', 'destroyed']], 'the stop rejected it, and the ring says so')
  assert.deepEqual(seen, ['pending', 'rejected'], 'one last fire for the stop, then nothing')
  c.data.r = 2 // after the stop the surface is a local value: nothing new enters the ring
  await sleep(20)
  assert.equal(rows().length, 1)
  assert.equal(seen.length, 2)
})

test('the clean stop on Ctrl-C (V4-8): one SIGINT/SIGTERM listener per process while any instance lives, gone after the last destroy; signals: false opts out; destroy() is idempotent', async () => {
  const count = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  const before = count()
  const f = await fero('r', { listen: false })
  const g = await fero('r2', { listen: false })
  const h = await fero('r3', { listen: false, signals: false })
  try {
    assert.deepEqual(count(), [before[0] + 1, before[1] + 1], 'the first live instance installs one listener per signal; a second shares it; an opted-out one never counts')
    await f.destroy()
    assert.deepEqual(count(), [before[0] + 1, before[1] + 1], 'still listening while g lives')
    const p1 = g.destroy()
    const p2 = g.destroy()
    assert.equal(p1, p2, 'the second destroy() joins the first')
    await p1
    assert.deepEqual(count(), before, 'the last tracked instance removes the listeners')
    await assert.rejects(fero('r', { listen: false, signals: 'yes' } as never), /signals must be true or false/)
  } finally {
    await f.destroy(); await g.destroy(); await h.destroy()
  }
})

test('Ctrl-C by hand (V4-8): a child process holding a member gets SIGINT with NO handler in its code — it leaves by ballot and exits 0; the survivor is alone and writable', async () => {
  const { spawn } = await import('node:child_process')
  const [pa, pb] = [await ports.free(), await ports.free()]
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fero-sig-')), 'member.ts')
  //! the whole child: one server, no signal code — what a reader's `node server.ts` is
  fs.writeFileSync(script, `import { fero } from ${JSON.stringify(path.join(import.meta.dirname, 'index.ts'))}
await fero('sig', { uuid: 'aa', listen: '127.0.0.1:${pa}', hosts: ['127.0.0.1:${pb}'], rendezvous: false, heartbeat: { ms: 50 }, redial: { ms: 30 } })
setInterval(() => {}, 1000)
`)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d })
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)))
  const b = await fero('sig', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], rendezvous: false, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const view = () => snapshot(b.cluster) as { epoch: number; writable: boolean; members: Record<string, string> }
  try {
    assert.ok(await until(() => view().epoch >= 1 && Object.keys(view().members).length === 2, 10_000), 'the pair formed')
    const t0 = Date.now()
    child.kill('SIGINT')
    assert.equal(await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 8000))]), 0, `the child exited 0 by itself on SIGINT (stderr: ${err})`)
    assert.ok(await until(() => Object.keys(view().members).length === 1 && view().writable, 5000), `the survivor is alone and writable (${JSON.stringify(view())})`)
    assert.ok(Date.now() - t0 < 5000, 'a ballot, not a suspicion timeout')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await b.destroy()
  }
})

test('a Peer row carries the ROLE: `client` is true for a spoke, false for a member — so a screen can count its clients apart from joined servers', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type Peers = Record<string, { uuid: string; incarnation: number; up: boolean; client: boolean }>
  const peers = (f: typeof a) => (snapshot(f.cluster) as { peers: Peers }).peers
  try {
    assert.ok(await until(() => peers(a).bb !== undefined && peers(a).zz !== undefined && peers(c).aa !== undefined, 8000), 'aa links both')
    //! before: a row was { uuid, incarnation, up } — 02's `watchers N` and 11's `clients N` counted a joined server
    assert.deepEqual(peers(a).zz, { uuid: 'zz', incarnation: 1, up: true, client: true }, 'the spoke reads as a client')
    assert.deepEqual(peers(a).bb, { uuid: 'bb', incarnation: 1, up: true, client: false }, 'the member does not')
    assert.equal(peers(c).aa.client, false, 'and from the spoke, its feeder is a server')
    assert.equal(Object.values(peers(a)).filter((p) => p.client).length, 1, 'clients N is now one filter')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test("a client's `cluster.writable` is its feeder's gate (I-33): false before a link, true once a writable member feeds it, false when the feeder's gate closes", async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  type View = { writable: boolean; epoch: number; me: { primary: string | null } }
  const view = (f: { cluster: unknown }) => snapshot((f as { cluster: unknown }).cluster) as View
  //! the client comes first: nothing to write to, so not writable (it used to read a member's open genesis gate: true)
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let a: Awaited<ReturnType<typeof fero>> | undefined, b: typeof a
  try {
    assert.strictEqual(view(c).writable, false, 'no feeder: not writable')
    a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => view(a!).epoch >= 1 && view(b!).epoch >= 1 && view(c).me.primary !== null && view(c).writable, 8000), `fed by a writable member (${JSON.stringify(view(c))})`)
    //! the OTHER server dies: the feeder stays linked, but one of two is not a majority — its gate closes,
    // and the next digest tells the client (one heartbeat behind)
    const feeder = view(c).me.primary!
    const [fed, other] = feeder === 'aa' ? [a, b] : [b, a]
    assert.strictEqual(await diag(other!)!.crash!(), false, 'a crash resolves the teardown verdict, and a crash is never clean')
    assert.ok(await until(() => view(fed!).writable === false, 4000), "the feeder's gate closed")
    assert.ok(await until(() => view(c).writable === false, 500), `the client follows within a few heartbeats (${JSON.stringify(view(c))})`)
    assert.equal(view(c).me.primary, feeder, 'still fed by the same member — only its gate moved')
    await diag(fed!)!.crash!()
    assert.ok(await until(() => view(c).me.primary === null, 4000))
    assert.strictEqual(view(c).writable, false, 'no feeder again: not writable')
  } finally {
    await c.destroy(); await a?.destroy().catch(() => {}); await b?.destroy().catch(() => {})
  }
})

test('a client says who feeds it: `cluster.me.primary` is the feeder\'s uuid, null before a link and on a server; when the feeder dies it moves to the survivor', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type Me = { uuid: string; primary: string | null }
  const me = (f: typeof a) => (snapshot(f.cluster) as { me: Me }).me
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const moves: (string | null)[] = []
  try {
    //! the whole cluster view is the tap (a child path is an address, not a view); we record the distinct feeders it showed
    c.cluster.tap(() => { const p = me(c).primary; if (moves[moves.length - 1] !== p) moves.push(p) })
    assert.strictEqual(me(a).primary, null, 'a server has no feeder')
    //! before: the kernel held the feeder as a link id and the composer watched it change to re-subscribe
    // live handles, but the view exposed nothing — 14's story could not name the survivor
    assert.ok(await until(() => me(c).primary !== null, 8000), 'the client names its feeder once a link is admitted')
    const feeder = me(c).primary!
    assert.ok(feeder === 'aa' || feeder === 'bb', `the feeder is one of the servers (${feeder})`)
    await diag(feeder === 'aa' ? a : b)!.crash!()
    const survivor = feeder === 'aa' ? 'bb' : 'aa'
    assert.ok(await until(() => me(c).primary === survivor, 8000), `primary moved to the survivor (${JSON.stringify(me(c))})`)
    assert.deepEqual(moves.slice(-2), [feeder, survivor], `the me row re-folded on each change (${JSON.stringify(moves)})`)
  } finally {
    await c.destroy(); await a.destroy().catch(() => {}); await b.destroy().catch(() => {})
  }
})

test('`cluster.me.origin` is the lane this life stamps under — the bare uuid in life 1, `uuid~2` from life 2 — and `me.incarnation` counts the lives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-origin-'))
  type Me = { uuid: string; origin: string; incarnation: number }
  const me = (f: Awaited<ReturnType<typeof fero>>) => (snapshot(f.cluster) as { me: Me }).me
  //! life 1: the origin on the me row must be the origin on the stamp — before, the row said `aa~1`
  // while every WriteResolve and cluster.writes row said `aa`, so "which writes are mine?" failed in life 1
  const one = await fero('r', { uuid: 'aa', listen: false, dir })
  try {
    const r = await one.methods.update({ key: 'k', value: 1 })
    assert.equal(me(one).origin, 'aa', 'life 1 stamps under the bare uuid')
    assert.equal(r.origin, me(one).origin, 'the me row and the stamp agree')
    assert.equal(me(one).incarnation, 1)
  } finally {
    await one.destroy()
  }
  const two = await fero('r', { listen: false, dir })
  try {
    const r = await two.methods.update({ key: 'k', value: 2 })
    assert.equal(me(two).origin, 'aa~2', 'life 2 is the fenced lane')
    assert.equal(r.origin, 'aa~2')
    assert.equal(me(two).incarnation, 2)
  } finally {
    await two.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Ctrl-C before fero() resolves is the clean stop too (V4-8): a provisional entry holds the signal registry from Runtime construction, and a SIGINT in the start window tears down what was built', async () => {
  const count = () => process.listenerCount('SIGINT')
  const before = count()
  //! (a) the registry is armed SYNCHRONOUSLY at the call — before any await in compose — and the instance
  // replaces the provisional entry without doubling it
  const p = fero('r', { listen: false })
  const armed = count()
  const f = await p
  try {
    assert.equal(armed, before + 1, 'armed at the call, before fero() resolves (was: only at the end of compose)')
    assert.equal(count(), before + 1, 'the instance took the entry over — one listener, not two')
  } finally {
    await f.destroy()
  }
  assert.equal(count(), before, 'and the last destroy removes it')
  //! (b) a SIGINT in the start window: the provisional entry's destroy tears down what was built. A second
  // listener keeps the handler from exiting THIS process (others > 0 — the app-has-its-own-listener rule).
  const noop = () => {}
  process.on('SIGINT', noop)
  const port = await ports.free()
  const q = fero('r', { listen: `127.0.0.1:${port}`, rendezvous: false })
  process.emit('SIGINT', 'SIGINT') // lands while rt.start() awaits its listen bind
  const g = await q
  try {
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(false) })
      s.once('error', () => resolve(true))
    })
    assert.ok(refused, 'the port it had bound is released — the runtime was torn down by the signal')
    assert.equal(count(), before + 1, "nothing live is tracked any more (only the test's own listener remains)")
  } finally {
    process.off('SIGINT', noop)
    await g.destroy() // joins the stop that already ran — resolves, never hangs
  }
})

//! The user's own code throws because fero changed a source it watches (api/substrate.ts Fault; data's SCHEDULE
// clause 4, VERSION 5). Before the fix a client whose filter met a row the server set to null exited with code 1
// (the error left fero's projection into the kernel's frame handler, which rethrows anything that is not a
// FrameError), and the server's own write threw at the assignment, cut short inside the kernel's step.
test("a view or a tap that throws never stops fero: a client's filter meets a null row the server wrote — one stderr line per failure, the client keeps folding and the row comes back; the server's own throwing view never cuts its write short", async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  type Cats = Record<string, { mood: string } | null>
  const s = await fero('throwy', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { luna: { mood: 'hungry' } } })
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      const cl = c = await fero('throwy', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      assert.ok(await until(() => (snapshot(cl.data) as Cats).luna !== undefined, 8000), 'the client caught up')
      const hungry = cl.data.filter((cat: { mood: string }) => cat.mood === 'hungry') // throws on a null row
      cl.data.tap(() => { if ((snapshot(cl.data) as Cats).mochi === null) throw new Error('the tap trips on mochi\u001b[2J') })
      const sleepy = s.data.filter((cat: { mood: string }) => cat.mood === 'sleepy') // the server's own view throws inside its local write
      s.data.mochi = null // no throw at the assignment
      assert.ok(await until(() => 'mochi' in (snapshot(cl.data) as Cats), 8000), "the server's write shipped: its step ran to the end")
      s.data.biscuit = { mood: 'hungry' }
      assert.ok(await until(() => 'biscuit' in (snapshot(hungry) as Cats), 8000), 'the client keeps folding past the bad row')
      s.data.mochi = { mood: 'hungry' }
      assert.ok(await until(() => 'mochi' in (snapshot(hungry) as Cats), 8000), 'the left-out row comes back when it changes')
      assert.deepEqual(snapshot(sleepy), {})
    } finally {
      await c?.destroy()
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('throwy')"))
  //! the client's filter, the server's filter and the tap: one line each, however many commits each threw in
  assert.equal(mine.length, 3, JSON.stringify(mine))
  assert.equal(mine.filter((l) => l.startsWith(`fero('throwy'): filter threw on row "mochi" — left out of that view until the row changes (TypeError: `)).length, 2, JSON.stringify(mine))
  const tap = mine.find((l) => l.startsWith("fero('throwy'): a tap or subscriber threw (Error: the tap trips on mochi[2J, at file://"))
  assert.ok(tap !== undefined && tap.includes('api/index.test.ts:'), `one tap line, saying where the tap threw: ${JSON.stringify(mine)}`)
  assert.ok(mine.every((l) => l.endsWith(' — the change stands; fero carried on')), JSON.stringify(mine))
  assert.ok(mine.every((l) => !/[\u0000-\u001f\u007f-\u009f]/.test(l)), 'no control character reaches the terminal')
})

test('a cluster tap or a cluster.writes tap that throws never stops the fold: one stderr line each, and the cluster view and the writes ring keep up', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('throwy2', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let b: Fero | null = null
  let views = 0
  let rows = 0
  const lines = await stderrOf(async () => {
    try {
      //! a tap fires once as it attaches: that call passes, every later one throws
      a.cluster.tap(() => { if (++views > 1) throw new Error('the cluster tap trips') })
      a.cluster.writes.tap(() => { if (++rows > 1) throw new Error('the writes tap trips') })
      b = await fero('throwy2', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      type View = { epoch: number; members: Record<string, unknown> }
      assert.ok(await until(() => { const v = snapshot(a.cluster) as View; return v.epoch >= 1 && Object.keys(v.members).length === 2 }, 8000), 'the fold kept going: the view formed with both members')
      a.data.k = 1
      assert.ok(await until(() => Object.values(snapshot(a.cluster.writes) as Record<string, { state: string }>).some((r) => r.state === 'committed'), 8000), 'the writes ring published the outcome')
    } finally {
      await b?.destroy()
      await a.destroy()
    }
  })
  assert.ok(views > 2 && rows > 1, `both taps ran past their first throw (${views}, ${rows})`)
  const mine = lines.filter((l) => l.startsWith("fero('throwy2')"))
  assert.equal(mine.length, 2, JSON.stringify(mine))
  assert.ok(mine.some((l) => l.startsWith("fero('throwy2'): a tap or subscriber threw (Error: the cluster tap trips, at ")), JSON.stringify(mine))
  assert.ok(mine.some((l) => l.startsWith("fero('throwy2'): a tap or subscriber threw (Error: the writes tap trips, at ")), JSON.stringify(mine))
})

//! The printer itself must never throw (the review of 2026-10-11): a thrown value can be anything — data a
// peer wrote, a null-prototype object, an Error whose message getter throws — and a printer that throws is the
// crash it guards against. And one bug is one line: never keyed on the row or the message (a filter that
// throws a row's text, or a message whose text forges an `at` line, printed a line per row).
test('the fault printer is total and keys on the bug, not the row: unprintable throws, a forged stack line and a row per message each print once, and every write still lands', async () => {
  const s = await fero('total', { listen: false, data: { seed: { n: 0 } } })
  type Row = { err?: unknown; name?: string; at?: string } | null
  const lines = await stderrOf(async () => {
    try {
      s.data.filter((r: Row) => { if (r !== null && r.err !== undefined) throw r.err === 'bare' ? Object.create(null) : r.err; return true })
      s.data.filter((r: Row) => { if (r !== null && r.name !== undefined) throw new Error(`cat ${r.name} has no age`); return true })
      s.data.tap(() => {
        const v = s.snapshot as Record<string, Row>
        if (v.weird !== undefined) { const e = new Error('x'); Object.defineProperty(e, 'message', { get() { throw new Error('no message for you') } }); throw e }
      })
      s.data.tap(() => { const at = (s.snapshot as Record<string, Row>).spam; if (at != null && at.at !== undefined) throw `no cat at ${at.at}` })
      //! a value String() cannot convert: plain data a peer could write, and a null-prototype object (the filter makes
      // it: a row written as one is fero's own plain copy since V4-52, as every other copy decodes it)
      s.data.job = { err: { toString: 1, valueOf: 1 } }
      s.data.nul = { err: 'bare' }
      s.data.weird = { n: 1 }
      for (let i = 0; i < 25; i++) s.data['forged' + i] = { name: `x\n    at /etc/forged-${i}.ts:6:6` }
      for (let i = 0; i < 25; i++) s.data.spam = { at: `row-${i}` }
      s.data.after = { n: 2 }
      const v = s.snapshot as Record<string, unknown>
      assert.ok(v.job !== undefined && v.nul !== undefined && v.weird !== undefined && v.forged24 !== undefined && v.after !== undefined, 'every write landed')
    } finally {
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('total')"))
  //! five: the filter that throws a row's own value, once for a plain object and once for a null-prototype one
  // (no stack, so the kind of value is the key), the filter whose message carries a forged frame, the tap whose
  // message getter throws, and the tap that throws a row's text (25 rows, one line)
  assert.equal(mine.length, 5, `one line per bug: ${JSON.stringify(mine, null, 1)}`)
  assert.equal(mine.filter((l) => l.startsWith(`fero('total'): filter threw on row "job"`)).length, 1, JSON.stringify(mine, null, 1))
  //! V8 formats a stack lazily from the message, so an Error whose message getter throws has no place to show
  assert.equal(mine.filter((l) => l.startsWith("fero('total'): a tap or subscriber threw ([object Error])")).length, 1, JSON.stringify(mine, null, 1))
  const forged = mine.filter((l) => l.includes('has no age'))
  assert.equal(forged.length, 1, 'the forged frames are one bug')
  assert.ok(!forged[0].includes('/etc/forged') || forged[0].includes('api/index.test.ts:'), `the place is the test's own line, not a row's text: ${forged[0]}`)
  assert.ok(/, at file:\/\/\/.*api\/index\.test\.ts:\d+:\d+\) — the change stands; fero carried on$/.test(forged[0]), forged[0])
  assert.equal(mine.filter((l) => l.includes('no cat at')).length, 1, 'a thrown string per row is one line')
  assert.ok(mine.every((l) => !/[\u0000-\u001f\u007f-\u009f]/.test(l)), 'no control character')
})

test("a write loop prints data's cut, not 'the change stands', and fero carries on", async () => {
  const s = await fero('loopy', { listen: false, data: { seed: 1 } })
  let armed = false
  const lines = await stderrOf(async () => {
    try {
      s.data.tap(() => { if (armed) s.data.n = ((s.snapshot as { n?: number }).n ?? 0) + 1 })
      armed = true
      s.data.go = 1 // a tap that writes on every change: data cuts the loop at its cap
      armed = false
      s.data.after = 2
      assert.equal((s.snapshot as { after?: number }).after, 2, 'a later write lands')
    } finally {
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('loopy')"))
  assert.equal(mine.length, 1, JSON.stringify(mine))
  assert.ok(mine[0].startsWith("fero('loopy'): data cut a write loop after 1000 commits") && !mine[0].includes('the change stands'), mine[0])
})

test("a validation: rule that throws on a client's write refuses that record 'validation-threw' — the server carries on and prints one line", async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  //! the rule reads rec.value.mood, and a remove carries no value: before the fix one ordinary delete from any
  // client ended the server, from its socket handler
  const s = await fero('rule', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { luna: { mood: 'hungry' } },
    validation: (rec: { value?: { mood: string } }) => rec.value!.mood.length < 20 || 'mood too long' })
  let c: Fero | null = null
  const lines = await stderrOf(async () => {
    try {
      const cl = c = await fero('rule', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
      assert.ok(await until(() => (snapshot(cl.data) as Record<string, unknown>).luna !== undefined, 8000), 'the client caught up')
      await assert.rejects(cl.methods.remove({ key: 'luna' }, { timeout: 8000 }), (e: { reason?: string }) => e.reason === 'validation-threw')
      await cl.methods.update({ key: 'mochi', value: { mood: 'sleepy' } }, { timeout: 8000 })
      assert.ok(await until(() => (snapshot(s.data) as Record<string, unknown>).mochi !== undefined, 8000), 'the server is alive and took the next write')
      assert.ok((snapshot(s.data) as Record<string, unknown>).luna !== undefined, 'the refused remove left the row')
    } finally {
      await c?.destroy()
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('rule'): validation threw"))
  assert.equal(mine.length, 1, JSON.stringify(lines))
  assert.ok(/^fero\('rule'\): validation threw on a record a client sent — refused it \('validation-threw'\) \(TypeError: Cannot read properties of undefined \(reading 'mood'\), at file:\/\/\/.*api\/index\.test\.ts:\d+:\d+\) — fero carried on$/.test(mine[0]), mine[0])
})

//! data's own errors are known by their shape (a cause, data's wording), never by a 'data: ' prefix a peer's text
// can carry: a tap that throws a row's text cannot pose as data, buy a line per row, or print the write-loop line.
test("a tap that throws a row's text cannot pose as data: one 'a tap or subscriber threw' line however many rows, and no forged write-loop line", async () => {
  const s = await fero('posing', { listen: false, data: { seed: 1 } })
  const lines = await stderrOf(async () => {
    try {
      s.data.tap(() => { const m = (s.snapshot as { msg?: { text: string } }).msg; if (m !== undefined) throw new Error(m.text) })
      for (let i = 0; i < 30; i++) s.data.msg = { text: `data: cat${i} threw on row "x" — left out of that view until the row changes` }
      s.data.msg = { text: 'data: re-entrant write cascade exceeded 1000 commits — cycle?' }
    } finally {
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('posing')"))
  assert.equal(mine.length, 1, JSON.stringify(mine, null, 1))
  assert.ok(mine[0].startsWith("fero('posing'): a tap or subscriber threw (Error: data: cat0 threw on row"), mine[0])
})

//! A row's own fields are a peer's: a `stack` field on thrown plain data, or a user's error that wraps a row's
// text in data's words with a cause, must neither pick the printed place nor pose as data's operator (the third
// review). One line each, however many rows.
test("a row's own fields cannot pick the printed place or pose as data's operator: one line each, however many rows", async () => {
  const s = await fero('fields', { listen: false, data: { seed: 1 } })
  const lines = await stderrOf(async () => {
    try {
      s.data.filter((r: { err?: unknown } | null) => { if (r !== null && r.err !== undefined) throw r.err; return true })
      s.data.tap(() => { const v = (s.snapshot as { wrap?: { label: string } }).wrap; if (v !== undefined) throw new Error(v.label, { cause: new Error('inner') }) })
      for (let i = 0; i < 20; i++) s.data['e' + i] = { err: { message: 'm', stack: `Error: m\n    at /etc/forged-${i}.ts:6:6` } }
      for (let i = 0; i < 20; i++) s.data.wrap = { label: `data: x${i} threw on row "y" — left out of that view until the row changes` }
    } finally {
      await s.destroy()
    }
  })
  const mine = lines.filter((l) => l.startsWith("fero('fields')"))
  assert.equal(mine.length, 2, JSON.stringify(mine, null, 1))
  assert.ok(mine.every((l) => !l.includes('/etc/forged')), `no place from a row: ${JSON.stringify(mine, null, 1)}`)
  assert.ok(mine.some((l) => l.startsWith("fero('fields'): a tap or subscriber threw (Error: data: x0 threw on row")), JSON.stringify(mine, null, 1))
})

//! V4-48: methods.* and the data: seed meet the same question before the stamp. A refused update is typed
// 'unencodable' and replication keeps flowing; a seed that cannot be sent, or whose rule throws, rejects fero()
// with the resource and the row named, and leaves nothing behind (no Ctrl-C listener).
test("methods.update with a value the wire cannot carry rejects 'unencodable' on a server and a client, and replication keeps flowing", async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('enc', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { luna: { mood: 'hungry' } } })
  let c: Fero | null = null
  try {
    const cl = c = await fero('enc', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => (snapshot(cl.data) as Record<string, unknown>).luna !== undefined, 8000), 'the client caught up')
    const enc = (e: WriteReject & Error) => e.reason === 'unencodable' && /: unencodable \((a bigint at n|a function); fero sends null, /.test(e.message)
    await assert.rejects(s.methods.update({ key: 'big', value: { n: 10n } }, { timeout: 8000 }), enc)
    await assert.rejects(cl.methods.update({ key: 'fn', value: () => 1 }, { timeout: 8000 }), enc)
    s.data.after = 1
    assert.ok(await until(() => (snapshot(cl.data) as Record<string, unknown>).after === 1, 8000), 'a later write still reaches the client')
    assert.equal((snapshot(s.data) as Record<string, unknown>).big, undefined)
  } finally {
    await c?.destroy()
    await s.destroy()
  }
})

test('a data: seed the wire cannot carry, or whose validation: rule throws, rejects fero() naming the row — and leaves no Ctrl-C listener', async () => {
  const before = process.listenerCount('SIGINT')
  //! a start that wrongly resolves is destroyed at once, so a regression fails here instead of holding the battery open
  const started = (p: Promise<Fero>) => p.then(async (f) => { await f.destroy(); return f })
  await assert.rejects(started(fero('seedenc', { listen: false, data: { luna: { n: 10n } } })), /^Error: fero\('seedenc'\): data seed row 'luna' cannot be sent: a bigint at n\n  fero sends null, /)
  await assert.rejects(started(fero('seedthrow', { listen: false, data: { luna: null }, validation: (r: { value: { mood: string } }) => r.value.mood.length > 0 || 'needs a mood' })),
    /^Error: fero\('seedthrow'\): data seed row 'luna' — validation threw: TypeError: Cannot read properties of null/)
  //! the rest of what the seed runs of the user's ends the same way: a getter on the seed object, a rule's answer that is not text
  await assert.rejects(started(fero('seedget', { listen: false, data: { get luna() { throw new Error('no luna') } } })), /^Error: fero\('seedget'\): reading the data seed threw: Error: no luna$/)
  await assert.rejects(started(fero('seedsym', { listen: false, data: { luna: 1 }, validation: (() => Symbol('nope')) as unknown as () => true })),
    /^Error: fero\('seedsym'\): data seed row 'luna' rejected by validation — the rule returned Symbol\(nope\)$/)
  //! a getter that throws a revoked Proxy: the check used to test it with instanceof, and threw out of itself
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  await assert.rejects(started(fero('seedrevoked', { listen: false, data: { luna: { get x() { throw revoked } } } })),
    /^Error: fero\('seedrevoked'\): data seed row 'luna' cannot be sent: reading it threw \(an unreadable error\) at x\n/)
  assert.equal(process.listenerCount('SIGINT'), before, 'no Ctrl-C listener left behind')
})

//! V4-48: the write limit is what every built-in read can send back. The wire carries 64 levels; a keyed call wraps a
// value once, a whole read twice, a keyed live sub three times, a live sub of the whole resource four (the scoped
// gather's claim is as deep), and a field sits a level under its row. A value 61 deep was written and replicated, and
// then could not be read back.
test('a value at the write limit reads back through every built-in read — the copy, a call and a live sub, keyed and whole', async () => {
  const nest = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = [v]; return v }
  const want = { row: nest(60), obj: { f: nest(59) } }
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('limit', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: want })
  let c: Fero | null = null
  try {
    assert.throws(() => { (s.data as Record<string, unknown>).over = nest(61) }, /\["over"\] cannot be sent: deeper than 60 levels/)
    assert.throws(() => { (s.data as Record<string, any>).obj.g = nest(60) }, /\["obj","g"\] cannot be sent: deeper than 60 levels/)
    const cl = c = await fero('limit', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => (snapshot(cl.data) as Record<string, unknown>).obj !== undefined, 8000), 'the client caught up')
    assert.deepEqual(snapshot(cl.data), want, 'the copy')
    const m = cl.methods as Record<string, (a?: unknown, o?: { timeout?: number }) => any>
    assert.deepEqual(await m.read('row', { timeout: 8000 }), want.row, 'a keyed call')
    assert.deepEqual(await m.read('obj', { timeout: 8000 }), want.obj, 'a keyed call of a field')
    assert.deepEqual(await m.read(undefined, { timeout: 8000 }), want, 'a whole call')
    for (const [k, v] of [['obj', want.obj], [undefined, want]] as const) {
      const h = m.read(k, { timeout: 8000 })
      await h.ready
      assert.deepEqual(snapshot(h.open()), v, `a live sub of ${k ?? 'the whole resource'}`)
      h.close()
    }
  } finally {
    await c?.destroy()
    await s.destroy()
  }
})

//! V4-48: a method's argument is encoded into the CALL frame inside the kernel step; one the wire cannot carry threw out
// of it and ended the client — at once when it had a server, and when a held call replayed on the next primary when it
// had none. It is asked at the call now, and the call (or the live sub) fails with the reason.
test('a method argument the wire cannot carry fails the call — with no server yet, with one, and on a live sub — and the client carries on', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const c = await fero('args', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let s: Fero | null = null
  try {
    const m = c.methods as Record<string, (a?: unknown, o?: { timeout?: number }) => any>
    await assert.rejects(async () => { await m.echo(10n, { timeout: 8000 }) }, /^Error: methods\.echo: the argument cannot be sent: a bigint$/)
    s = await fero('args', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { a: 1 }, methods: { echo: (a: unknown) => a } })
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).a === 1, 8000), 'the client caught up')
    await assert.rejects(async () => { await m.echo({ f: () => 1 }, { timeout: 8000 }) }, /the argument cannot be sent: a function/)
    const h = m.echo([Symbol('s')])
    assert.throws(() => h.anything, /^Error: methods\.echo: the argument cannot be sent: a symbol at \[0\]$/)
    await assert.rejects(async () => { await m.echo(c.data, { timeout: 8000 }) }, /the argument cannot be sent: a live view, not a value/)
    assert.equal(await m.echo('fine', { timeout: 8000 }), 'fine')
  } finally {
    await c.destroy()
    await s?.destroy()
  }
})

//! V4-52: a method's argument reaches the server through the codec, which sends an object's own fields: a Date in it
// arrived there as {}, a Map as {}, a Float64Array as an object of its indices. It is refused at the call like a
// bigint, with what to send instead and where it sits, and nothing is sent.
test('a method argument that would arrive changed is refused at the call like a bigint, as a call and as a live sub, with what to send instead', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('kinds', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { a: 1 }, methods: { echo: (a: unknown) => a } })
  const c = await fero('kinds', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).a === 1, 8000), 'the client caught up')
    const m = c.methods as Record<string, (a?: unknown, o?: { timeout?: number }) => any>
    await assert.rejects(async () => { await m.echo({ when: new Date(0) }, { timeout: 8000 }) },
      /^Error: methods\.echo: the argument cannot be sent: a Date \(send date\.getTime\(\) or date\.toISOString\(\)\) at when$/)
    await assert.rejects(async () => { await m.echo([new Float64Array([1.5])], { timeout: 8000 }) }, /the argument cannot be sent: a Float64Array \(send Array\.from\(it\), or its bytes as a Uint8Array\) at \[0\]$/)
    const h = m.echo(new Map([[1, 2]]))
    assert.throws(() => h.anything, /^Error: methods\.echo: the argument cannot be sent: a Map \(send Object\.fromEntries\(map\), or \[\.\.\.map\]\)$/)
    assert.deepEqual(await m.echo({ when: 0, list: [1] }, { timeout: 8000 }), { when: 0, list: [1] }, 'what it says to send arrives')
  } finally {
    await c.destroy()
    await s.destroy()
  }
})

//! V4-52: fero kept the object the program wrote. A change made after the write reached the writer at once, and every
// copy that caught up later (the writer's log held the same object), but not a copy that already had it; a change to a
// bigint left a late client unable to catch up at all. Each write keeps fero's own copy now: a later change reaches
// no copy, and every copy reads what was written.
test('a value changed after its write reaches no copy: the writer, its own read, a live client and a late client all read what was written', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('chg', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, server: true })
  let live: Fero | null = null
  let late: Fero | null = null
  const rows = (f: Fero) => snapshot(f.data) as Record<string, unknown>
  try {
    const lv = live = await fero('chg', { uuid: 'yy', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    const o = { n: 1, list: [1] }
    const big: Record<string, unknown> = { n: 1 }
    const sd = s.data as Record<string, unknown>
    sd.r = o
    sd.big = big
    assert.ok(await until(() => rows(lv).big !== undefined, 8000), 'the live client has both rows')
    o.n = 2
    o.list.push(2)
    big.n = 10n
    sd.after = 1
    const lt = late = await fero('chg', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => rows(lt).after === 1, 8000), 'the late client caught up')
    assert.ok(await until(() => rows(lv).after === 1, 8000))
    for (const [who, got] of [['the writer', rows(s)], ['the live client', rows(lv)], ['the late client', rows(lt)]] as const)
      assert.deepEqual({ r: got.r, big: got.big }, { r: { n: 1, list: [1] }, big: { n: 1 } }, who)
    assert.deepEqual(await s.methods.read('r'), { n: 1, list: [1] }, "the writer's own read")
  } finally {
    await late?.destroy()
    await live?.destroy()
    await s.destroy()
  }
})

//! V4-52: the same for the other ways a value is written — a client's methods.update, held by its kernel until a
// server is there (its retries re-encoded the program's object), and the data: seed
test('a client write held for a server that is not up yet, and a data: seed, send the value as it was at the write', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const c = await fero('held', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let s: Fero | null = null
  try {
    const v = { n: 1 }
    const w = c.methods.update({ key: 'r', value: v }, { timeout: 8000 })
    v.n = 2
    const seed = { a: { n: 1 } }
    const sv = s = await fero('held', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: seed })
    seed.a.n = 2
    await w
    assert.deepEqual(rows(sv), { a: { n: 1 }, r: { n: 1 } }, 'the server has what was written')
    assert.ok(await until(() => JSON.stringify(rows(c)) === JSON.stringify({ a: { n: 1 }, r: { n: 1 } }), 8000), `the client too: ${JSON.stringify(rows(c))}`)
  } finally {
    await c.destroy()
    await s?.destroy()
  }
  function rows(f: Fero) { return snapshot(f.data) as Record<string, unknown> }
})

//! V4-52: a call or a live sub made before there is a server is held, and replayed on the next primary. It re-encoded
// the caller's object then: a change made meanwhile was sent, and one to a bigint threw from the client's socket
// handler while the call hung. The argument is copied at the call now, by the walk that checks it.
test('a held call and a held live sub send their argument as it was at the call: a change made meanwhile is not sent, and a change to a bigint ends nothing', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const c = await fero('heldarg', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  let s: Fero | null = null
  try {
    const m = c.methods as Record<string, (a?: unknown, o?: { timeout?: number }) => any>
    const arg = { n: 1 }
    const big: Record<string, unknown> = { n: 1 }
    const sub = { n: 1 }
    const first = m.echo(arg, { timeout: 8000 }).then((x: unknown) => x)
    const second = m.echo(big, { timeout: 8000 }).then((x: unknown) => x)
    const h = m.echo(sub)
    h.open()
    arg.n = 2
    big.n = 10n
    sub.n = 2
    s = await fero('heldarg', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, methods: { echo: (a: unknown) => a } })
    assert.deepEqual(await first, { n: 1 })
    assert.deepEqual(await second, { n: 1 })
    await h.ready
    assert.deepEqual(snapshot(h.open()), { n: 1 }, 'the sub, re-sent on the primary')
    h.close()
  } finally {
    await c.destroy()
    await s?.destroy()
  }
})

//! V4-52: data folds an insert at the row only. methods.insert({ key: ['row', 'f'] }) was stamped and then refused by
// data: on a server the call rejected with data's words after the stamp and its write stayed `pending` for ever; on a
// client the call resolved 'committed' while the server threw from its socket handler, and every client that caught up
// later threw too. It is refused before the stamp now, typed, with what to write instead.
test("methods.insert with a key of two parts or more, or an empty at, is refused 'invalid-key' before the stamp, on a server and on a client, and every node carries on", async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('ins', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { row: { a: 1 } } })
  let c: Fero | null = null
  let late: Fero | null = null
  const rows = (f: Fero) => snapshot(f.data) as Record<string, unknown>
  const pending = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { state: string }>).filter((w) => w.state === 'pending').length
  const bad = (hint: RegExp) => (e: WriteRejectError) => e instanceof WriteRejectError && e.reason === 'invalid-key' && e.reached === 'issued' && hint.test(e.message)
  try {
    const cl = c = await fero('ins', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => rows(cl).row !== undefined, 8000), 'the client caught up')
    for (const f of [s, cl]) {
      await assert.rejects(f.methods.insert({ key: ['row', 'f'], at: 'y', value: 3 }, { timeout: 8000 }), bad(/: invalid-key — reached issued \(an insert adds a row: /))
      await assert.rejects(f.methods.insert({ key: ['row', 'f', 'g'], value: 3 }, { timeout: 8000 }), bad(/an insert adds a row/))
      await assert.rejects(f.methods.insert({ at: '', value: 1 }, { timeout: 8000 }), bad(/an insert needs its row/))
      assert.equal(pending(f), 0, 'no write left pending')
    }
    //! the shapes data folds still insert: a row under the resource, and a row at a one-part key
    await s.methods.insert({ at: 'made', value: { n: 1 } })
    await cl.methods.insert({ key: 'row2', value: { n: 2 } }, { timeout: 8000 })
    s.data.after = 1
    const lt = late = await fero('ins', { uuid: 'yy', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    const want = { row: { a: 1 }, made: { n: 1 }, row2: { n: 2 }, after: 1 }
    for (const f of [s, cl, lt]) assert.ok(await until(() => isDeepStrictEqual(rows(f), want), 8000), JSON.stringify(rows(f)))
  } finally {
    await late?.destroy()
    await c?.destroy()
    await s.destroy()
  }
})

//! the V4-51/52 review: a client's methods.x(o) copied `o` only at the await or the first touch — the handle is lazy —
// so a change the program made in between was sent, and each await of the same handle sent the object as it then was.
// A server's own call copies at the call. The handle takes its copy when it is made now, once, for every call and sub.
test('a client method handle sends its argument as it was when the handle was made — every await of it, and a refusal stays one', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('handlearg', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { a: 1 }, methods: { echo: (a: unknown) => a } })
  let c: Fero | null = null
  try {
    const cl = c = await fero('handlearg', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    assert.ok(await until(() => (snapshot(cl.data) as Record<string, unknown>).a === 1, 8000), 'the client caught up')
    const m = cl.methods as Record<string, (a?: unknown, o?: { timeout?: number }) => any>
    const o: Record<string, unknown> = { n: 1 }
    const h = m.echo(o, { timeout: 8000 })
    o.n = 2
    assert.deepEqual(await h, { n: 1 }, 'the change after the call is not sent')
    o.n = 10n
    assert.deepEqual(await h, { n: 1 }, 'a second await sends the same copy, not the object as it is now')
    const bad: Record<string, unknown> = { n: 10n }
    const r = m.echo(bad, { timeout: 8000 })
    bad.n = 1
    await assert.rejects(async () => { await r }, /^Error: methods\.echo: the argument cannot be sent: a bigint at n$/)
  } finally {
    await c?.destroy()
    await s.destroy()
  }
})

//! the fix check: a refused methods.update was walked twice — once by issue(), once more by the reject's message —
// so a getter in it ran twice (four times past the first share). issue() keeps its reason for the message now.
test('a methods.update refused for its value walks that value once: the reject\'s words are the ones issue() found', async () => {
  const s = await fero('walkonce', { listen: false })
  try {
    let calls = 0
    await assert.rejects(s.methods.update({ key: 'k', value: { get n() { calls++; return 10n } } }), (e: WriteReject & Error) =>
      e.reason === 'unencodable' && e.message.includes('unencodable (a bigint at n; fero sends null'))
    assert.equal(calls, 1)
  } finally { await s.destroy() }
})
