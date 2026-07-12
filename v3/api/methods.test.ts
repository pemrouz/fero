//! Tier-3 method-plane suite (M5c): the RPC/subscription contract over REAL sockets, held the way a
// consumer holds it. Pins: one-shot CALL round-trips (values and proxy snapshots), typed errors
// (unknown method / thrown handler), the LIVE subscription lifecycle (initial snapshot → streamed
// deltas → close), flush-on-return (a reply provably follows the commits its handler made — the call
// stays UNRESOLVED while a write is parked at an unreachable owner), confirm-over-RPC (the M5b spoke
// residual, closed), and failover re-subscribe (v2's OQ2: the live handle survives its server dying).

import { test } from 'node:test'
import assert from 'node:assert'
import { fero } from './index.ts'
import { snapshot } from './substrate.ts'
import { ports, until, sleep } from '#utils'

const pair = async (methods: Record<string, unknown> = {}) => {
  const pa = await ports.free()
  const pb = await ports.free()
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 50, redialMs: 30, ...methods })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50, redialMs: 30, ...methods })
  assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
  return { a, b, addrs: [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`] }
}

test('one-shot CALL: values round-trip, a returned proxy snapshots, unknown methods and thrown handlers reject typed', async () => {
  const { a, b, addrs } = await pair({
    total: (n: number, ctx: { data: any }) => { void ctx; return n * 2 },
    boom: () => { throw new Error('handler exploded') },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    assert.equal(await c.methods.total(21), 42, 'a value round-trips')
    //! built-in read: await = snapshot of the resource (a proxy return collapses at the host)
    a.data.seeded = { v: 1 }
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).seeded !== undefined))
    assert.deepEqual(await c.methods.read(), snapshot(c.data), 'read() snapshot ≡ the replicated spoke state')
    //! handles are callable proxies — reject-assertions await them inside a closure
    await assert.rejects(async () => { await c.methods.nosuch() }, /unknown method 'nosuch'/)
    await assert.rejects(async () => { await c.methods.boom() }, /handler exploded/)
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('LIVE subscription: reactive touch opens the stream (initial snapshot + deltas); close() stops it; server-side writes keep flowing until then', async () => {
  const { a, b, addrs } = await pair({
    watch: (_: unknown, ctx: { data: any }) => ctx.data, // returns a ViewProxy → subscribable
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    a.data.first = 1
    const live = c.methods.watch()
    //! any reactive touch opens the subscription; the initial snapshot then streamed deltas arrive
    assert.ok(await until(() => (live.first as { [k: symbol]: unknown })), 'handle opened')
    assert.ok(await until(() => JSON.stringify(snapshot(live.open())) === JSON.stringify({ first: 1 }), 8000), 'initial snapshot folded')
    a.data.second = 2
    assert.ok(await until(() => (snapshot(live.open()) as Record<string, unknown>).second === 2, 8000), 'a delta streamed')
    assert.equal(live.mode, 'live')
    //! close() detaches server-side: later writes never arrive
    live.close()
    a.data.third = 3
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).third === 3, 8000), 'the replica saw it (control)')
    assert.equal((snapshot(live.open()) as Record<string, unknown>).third, undefined, 'the closed stream did not')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test("flush-on-return: a handler's reply is HELD while its write is parked at an unreachable owner, and released when the route completes", async () => {
  //! a 3-server view; the method writes a key. We kill the key's owner mid-flight... ownership is
  // hash-picked, so instead we hold the reply hostage the honest way: kill a MAJORITY (gate closes,
  // every write parks) — the call must stay pending; then... a closed gate cannot reopen without the
  // members back, so assert the HOLD half here and the RELEASE half in the happy path below.
  const { a, b, addrs } = await pair({
    put: async (kv: { k: string; v: unknown }, ctx: { data: any; flush(): Promise<void> }) => {
      ctx.data[kv.k] = kv.v
      return 'committed-before-reply'
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    //! happy path: the reply follows the commit — the value is on the HOST the instant the call returns
    const r = await c.methods.put({ k: 'x', v: 1 })
    assert.equal(r, 'committed-before-reply')
    //! no until(): flush-on-return means the hosting server committed BEFORE replying; with two
    // members either it owns the key (local commit) or it forwarded and awaited the WACK — both
    // resolve before the reply, so at least one server already folds it
    assert.ok((snapshot(a.data) as Record<string, unknown>).x === 1 || (snapshot(b.data) as Record<string, unknown>).x === 1,
      'the write was committed before the reply left')
    //! hold path: kill bb → {aa} is a minority of 2 → the gate closes and puts park → the reply is HELD
    await b.destroy()
    assert.ok(await until(() => (snapshot(a.cluster) as { writable: boolean }).writable === false, 10_000), 'gate closed (minority)')
    let settled = false
    const held = c.methods.put({ k: 'y', v: 2 }, { timeout: 60_000 }).then(() => { settled = true }, () => { settled = true })
    await sleep(1500)
    assert.equal(settled, false, 'the reply is HELD — flush-on-return refuses to reply before its write commits')
    void held
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy().catch(() => {})
  }
})

test("confirm-over-RPC: a spoke's methods.update({confirm:'replicated'}) proves at the PRIMARY (the M5b residual, closed)", async () => {
  const { a, b, addrs } = await pair()
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    const r = await c.methods.update({ key: 'proven', value: 1 }, { confirm: 'replicated', timeout: 8000 })
    assert.equal(r.guarantee, 'replicated', 'the spoke proved a majority holds it — via the system plane')
    assert.notEqual(r.origin, 'zz')
    assert.ok(await until(() => (snapshot(b.data) as Record<string, unknown>).proven === 1))
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('failover re-subscribe (OQ2): a live handle survives its serving primary dying — the stream resumes off the new feeder', async () => {
  const { a, b, addrs } = await pair({ watch: (_: unknown, ctx: { data: any }) => ctx.data })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    a.data.pre = 1
    const live = c.methods.watch()
    assert.ok(await until(() => (snapshot(live.open()) as Record<string, unknown>).pre === 1, 8000), 'subscribed')
    //! kill ONE server — whichever was the feeder, the sub must re-subscribe and keep streaming
    await a.destroy()
    assert.ok(await until(() => {
      b.data['post' + Date.now()] = true
      return Object.keys(snapshot(live.open()) as Record<string, unknown>).some((k) => k.startsWith('post'))
    }, 15_000), 'deltas resumed through the surviving server')
  } finally {
    await c.destroy(); await b.destroy(); await a.destroy().catch(() => {})
  }
})
