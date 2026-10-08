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
import { fero, WriteRejectError } from './index.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { JK } from '../kernel/journal.ts'
import { ports, until, sleep } from '#utils'
import type { WriteReject, WriteResolve } from './types.ts'

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
  const rows = (f: typeof c) => Object.values(snapshot(f.cluster).writes as Record<string, { key: string; state: string; reason?: string }>)
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

test('v4.1 uuid discipline: empty and lane-separator uuids refuse at fero() time', async () => {
  await assert.rejects(fero('r', { uuid: '' }), /uuid must be a non-empty string/)
  await assert.rejects(fero('r', { uuid: 'a~1' }), /without '~'/)
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

test("relayed client writes run the SERVER's seams.validation at the relay: the refused row never lands anywhere — not even on the client's own screen — and its methods.update rejects with the server's reason", async () => {
  //! the IDEAS probe (2026-09-05): before this fix a server that refused its OWN `data.admin = …` still
  // let a bare client's `data.admin = …` LAND (the relay re-stamped but ran no validator)
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 },
    seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const rows = (f: typeof c) => Object.values(snapshot(f.cluster).writes as Record<string, { key: string; state: string; reason?: string }>)
  try {
    //! the server refuses its OWN admin write (the local hook, unchanged)
    s.data.admin = 'local'
    assert.equal((snapshot(s.data) as Record<string, unknown>).admin, undefined)
    //! a plain client assignment: nothing shows (V4-7), the relay refuses it, and cluster.writes shows
    // the server's reason on the rejected row
    c.data.admin = 'from-client'
    assert.equal((snapshot(c.data) as Record<string, unknown>).admin, undefined, 'no optimistic copy on the client')
    //! the outcome row settles in a microtask and folds on the NEXT step (api/data.ts outcomes) — await it
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
  await assert.rejects(fero('r', { server: true, hosts: ['10.0.0.5:4800'] }), /explicit listen required/)
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
  await assert.rejects(fero('r', { hosts: ['127.0.0.1'] }), /hosts\[0\] '127\.0\.0\.1' is not a 'host:port' address/)
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  //! a NON-EMPTY wal.log with no boot.json is an incomplete dir (partial copy) — never adopted
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-idh2-'))
  try {
    fs.writeFileSync(path.join(dir2, 'wal.log'), Buffer.from([1, 2, 3]))
    await assert.rejects(fero('r', { uuid: 'bb', dir: dir2, listen: false }), /no boot\.json/)
  } finally { fs.rmSync(dir2, { recursive: true, force: true }) }
})

test('v4.1 data seed: a row the validation seam refuses throws at fero() time — never a silent partial seed', async () => {
  await assert.rejects(
    fero('r', {
      listen: false,
      data: { a: { stock: 1 }, b: { stock: -5 } },
      seams: { validation: (r: { value?: { stock?: number } }) => ((r.value?.stock ?? 0) >= 0 ? true : 'negative stock') },
    }),
    /data seed row 'b' rejected by seams\.validation — negative stock/)
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
    //! a write outcome IS a cluster change (cluster.writes, the confirm ring) — the honest remaining fire
    a.data.k = 1
    assert.ok(await until(() => pictures.length > n, 3000), 'the confirm ring moving fires the tap')
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

test('journal.cap 2 on a SCOPED pair: the overflow refold keeps every held row (it mirrors out only a partition the kernel no longer has at all)', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1, journal: { cap: 2 } })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1, journal: { cap: 2 } })
  try {
    assert.ok(await until(() => [a, b].every((f) => (snapshot(f.cluster) as { epoch: number; writable: boolean }).epoch >= 1 && (snapshot(f.cluster) as { writable: boolean }).writable), 5000), 'the view formed')
    for (let i = 0; i < 20; i++) a.data['p' + i] = i
    const all = Array.from({ length: 20 }, (_, i) => 'p' + i).sort().join()
    //! the gather asks every holder for its rows: a row the refold wrongly mirrored out would be missing
    assert.ok(await until(async () => Object.keys((await a.data) as object).sort().join() === all, 5000), 'every row is on its holder')
    assert.ok(diag(a)!.journal().dropped > 0 && diag(b)!.journal().dropped > 0, 'both rings overflowed')
    await sleep(300) // heartbeats and folds over the settled shards
    assert.equal(Object.keys((await a.data) as object).sort().join(), all, 'and stays there after a few more folds')
    assert.equal(Object.keys((await b.data) as object).sort().join(), all, 'seen from the other member too')
  } finally {
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
