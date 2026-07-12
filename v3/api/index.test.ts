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
  //! a function-valued opt is a METHOD (recognized by value type, not key name) — stashed until M5c
  const f = await fero('r', { checkout: () => 'later' })
  assert.equal(typeof f.methods.checkout, 'function')
  assert.throws(() => f.methods.checkout(), /M5c/)
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
