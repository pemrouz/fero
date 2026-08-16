//! Tier-3 composer suite: fero() over REAL sockets and (one test) a REAL disk — the public surface
// exercised the way a consumer holds it. Deterministic protocol coverage stays in api/data.test.ts
// and the kernel/sim suites; this file proves the composition: config schema, await-fero-as-ready,
// replication visible through two proxies, the guarantee ladder under methods.update, restore into
// the proxy, and teardown.

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fero } from './index.ts'
import { snapshot } from './substrate.ts'
import { ports, until } from '#utils'
import type { WriteReject, WriteResolve } from './types.ts'

test('config recognition: unknown keys and unknown seams throw at fero() time; function values are methods', async () => {
  await assert.rejects(fero('r', { prot: 9 } as never), /unknown option 'prot'/)
  await assert.rejects(fero('r', { seams: { hash: () => 0 } } as never), /unknown seam 'hash'/)
  //! a function-valued opt is a METHOD (recognized by value type, not key name) — and on a server it
  // dispatches LOCALLY (M5c): one-shot invoke, flush-on-return, snapshot for proxy returns
  const f = await fero('r', { checkout: (n: unknown) => `order-${n}` })
  assert.equal(await f.methods.checkout(7), 'order-7')
  //! built-in read returns the resource (snapshot locally)
  f.data.k = 1
  assert.deepEqual(await f.methods.read(), { k: 1 })
  //! reserved names refuse loudly
  await assert.rejects(fero('r', { update: () => 0 } as never), /built-in writer/)
  await assert.rejects(fero('r', { ['\u0000evil']: () => 0 } as never), /reserved for the system plane/)
  await f.destroy()
})

test('M6 config: replicas validates loudly (integer ≥ 1, servers only) and surfaces on cluster.partitions; unscoped shows zeros', async () => {
  await assert.rejects(fero('r', { replicas: 0 } as never), /replicas must be an integer/)
  await assert.rejects(fero('r', { replicas: 1.5 } as never), /replicas must be an integer/)
  await assert.rejects(fero('r', { replicas: 2, hosts: ['tcp://nowhere:1'] } as never), /server-side setting/)
  //! unscoped: the partitions row is a truthful all-zeros projection (replicas 0 = R=∞)
  const plain = await fero('r', {})
  const p0 = (snapshot(plain.cluster) as { partitions: Record<string, unknown> }).partitions
  assert.deepEqual(p0, { replicas: 0, epoch: 0, w: 0, held: 0, acquiring: 0, orphaned: 0, acquired: 0, shed: 0, shedWaitingOn: [] })
  await plain.destroy()
  //! scoped solo: config reflected; w derives from R_eff (min(replicas, members)) — never configurable
  const f = await fero('r', { uuid: 'aa', replicas: 2 })
  const p = (snapshot(f.cluster) as { partitions: { replicas: number; w: number } }).partitions
  assert.equal(p.replicas, 2)
  assert.equal(p.w, 1, 'solo: R_eff = min(2, 1) = 1 ⇒ W = 1')
  await f.destroy()
})

test('solo: assignment and methods.update are ONE ingest — both commit, both visible, coordinates resolve', async () => {
  const f = await fero('inventory', { uuid: 'aa' })
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

//! Regression (v4 re-evaluation BLOCKER): the lens delegated EVERY reserved name raw —
// including data's WRITE builtins — so f.data.set('k',v) / f.data.k.update(v) /
// f.data.patch([...]) mutated the LOCAL projection only: no validation, no overlay, no
// replication (the sink saw only assignments). §4.1's "validation covers both by
// construction" now holds for the typed idioms too: set/update/patch/remove route through
// the SAME sink as assignment/delete (Bind.issue), and the verbs that cannot be made
// replication-correct through a lens (insert/ingest/raf/dispose) throw fero-shaped errors.
test('D3 lens: data write builtins route through issue() — validated — or throw; never the raw projection', async () => {
  const seen: unknown[] = []
  const f = await fero('lensguard', {
    uuid: 'aa',
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
    // signature was "validation bounced it but the handle mutated anyway"
    f.data.set('w', { stock: 13 })
    assert.deepEqual((snapshot(f.data) as Record<string, unknown>).w, { stock: 2 }, 'rejected verb write bounced PRE-COMMIT')

    //! the un-routable verbs throw with the fero-shaped alternative
    assert.throws(() => (f.data as { insert(v: unknown): unknown }).insert({ stock: 9 }), /fero: insert\(\)/)
    assert.throws(() => (f.data as { ingest(r: unknown[]): unknown }).ingest([]), /fero: ingest\(\)/)
    assert.throws(() => (f.data as { raf(): unknown }).raf(), /fero: raf\(\)/)
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
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 50 })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50 })
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

test('restore through the composer: fero(name, {dir}) refills the proxy from the WAL before the network exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-api-'))
  try {
    const first = await fero('r', { uuid: 'aa', dir })
    first.data.persisted = { rows: 3 }
    first.data.persisted.rows = 4
    await first.methods.update({ key: 'volatile', value: true })
    await first.destroy()

    const second = await fero('r', { uuid: 'aa', dir })
    assert.deepEqual(snapshot(second.data), { persisted: { rows: 4 }, volatile: true }, 'the heir folded the WAL into the proxy')
    assert.equal((snapshot(second.cluster) as { me: { origin: string } }).me.origin, 'aa~2', 'reborn lane')
    await second.destroy()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('destroy is clean: sockets down, timers cleared, capture detached — the proxy survives as a plain local value', async () => {
  const p = await ports.free()
  const f = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${p}` })
  f.data.k = 1
  await f.destroy()
  f.data.local = 2 // no capture, no kernel — a local mutation only
  assert.deepEqual(snapshot(f.data), { k: 1, local: 2 })
})

test('M5b — a CLIENT (hosts, no listen): full state through one feeder, read-your-writes over the relay, failover past a dead server', async () => {
  //! THREE servers: the failover leg kills one, and a surviving MAJORITY must exist to evict it —
  // with two, a write owned by the dead member would (correctly, CP) park forever
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const mk = (i: number, uuid: string) =>
    fero('r', { uuid, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), heartbeatMs: 50, redialMs: 30 })
  const a = await mk(0, 'aa')
  const b = await mk(1, 'bb')
  const d = await mk(2, 'dd')
  let c: Awaited<ReturnType<typeof fero>> | null = null
  try {
    //! a committed view first, so client writes exercise the relay (ae=0) path, not open genesis
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    a.data.seeded = 'before-client'
    c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
    //! catch-up: the spoke folds the full state through its primary
    assert.ok(await until(() => (snapshot(c!.data) as Record<string, unknown>).seeded === 'before-client'), 'client caught up')
    //! read-your-writes: the assigned value is visible NOW (the pending overlay), before any ack
    c.data.mine = { from: 'client' }
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

test('M5b — a durable client is refused loudly (offline-first is M6, not a silent misconfiguration)', async () => {
  await assert.rejects(fero('r', { hosts: ['127.0.0.1:1'], dir: '/tmp/x' } as never), /durable client/)
})

test('M5-REVIEW #9 — an async write rejection surfaces as a typed WriteReject, never a bare string', async () => {
  //! drive a MAX_PENDING overflow: a client with no reachable server, flood past the bound → 'dropped'
  const c = await fero('r', { uuid: 'zz', hosts: ['127.0.0.1:1'], heartbeatMs: 0 })
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

test('M5-REVIEW #3 — write() clears its timeout timer on settle (no timer/closure accumulation on the hot path)', async () => {
  const f = await fero('r', { uuid: 'aa' })
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
  const { value } = await import('../../../data/api/index.ts') as { value: symbol }
  const s = await fero('r', { uuid: 'aa' })
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
