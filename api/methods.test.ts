//! Tier-3 method-plane suite (M5c): the RPC/subscription contract over REAL sockets, held the way a
// consumer holds it. Pins: one-shot CALL round-trips (values and proxy snapshots), typed errors
// (unknown method / thrown handler), the LIVE subscription lifecycle (initial snapshot → streamed
// deltas → close), flush-on-return (a reply provably follows the commits its handler made — the call
// stays UNRESOLVED while a write is parked at an unreachable owner), confirm-over-RPC (the M5b spoke
// residual, closed), and failover re-subscribe (v2's OQ2: the live handle survives its server dying).

//! the directory is OFF in this suite regardless of how it is run: a single-file `node --test` must never
// meet a live box directory (the battery's npm script sets the same default)
process.env.FERO_RENDEZVOUS ??= 'off'

import { test } from 'node:test'
import assert from 'node:assert'
import { fero } from './index.ts'
import { snapshot } from './substrate.ts'
import { ports, until, sleep } from '#utils'

//! pair — two servers; `methods` (if any) are hosted under `methods:` (V4-5 — which also makes the pair
// PROTECTED: a spoke changes data only through them), `extra` is further config for both
const pair = async (methods: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const pa = await ports.free()
  const pb = await ports.free()
  const hosted = Object.keys(methods).length ? { methods } : {}
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 50, redialMs: 30, ...hosted, ...extra } as never)
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50, redialMs: 30, ...hosted, ...extra } as never)
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

test("M5-REVIEW #7 — a handler that throws the exact text 'unreachable' rejects typed at the client, never held/hung/re-run", async () => {
  const { a, b, addrs } = await pair({ check: () => { throw new Error('unreachable') } })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    //! the handler's 'unreachable' arrives as a wire RESULT (local=false) → ordinary rejection, fast,
    // NOT mistaken for the kernel's no-primary pre-dispatch failure (which would hang then re-execute)
    await assert.rejects(async () => { await c.methods.check() }, /methods\.check: unreachable/)
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('M5-REVIEW #8 — introspecting a one-shot handle (String/JSON/`in`/symbols) never opens a leaked subscription', async () => {
  const { a, b, addrs } = await pair({ total: (n: number) => n * 2 })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    const h = c.methods.total(21)
    //! every coercion/introspection path must be passive — no SUB frame, no subscription
    void `${h}`; void String(h); void JSON.stringify({ h }); void ('items' in h); void (h as any)[Symbol.iterator]
    assert.equal(h.mode, 'oneshot', 'still a one-shot handle — nothing opened it')
    //! the await path still works after all that introspection
    assert.equal(await h, 42)
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('M5-REVIEW #11 — a live subscription over a DERIVED (operator) proxy keeps streaming across GC', async () => {
  const { a, b, addrs } = await pair({ actives: (_: unknown, ctx: { data: any }) => ctx.data.filter((r: any) => r.active === true) }) // v4: predicate-only filter (data MIGRATION §3.1)
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    a.data.u1 = { active: true, n: 1 }
    a.data.u2 = { active: false, n: 2 }
    const live = c.methods.actives()
    const p = live.open()
    assert.ok(await until(() => Object.keys(snapshot(p) as object).length === 1, 8000), 'initial filtered snapshot (only u1)')
    //! force GC if exposed, then write more — the derived chain must still feed the stream
    if (typeof (globalThis as { gc?: () => void }).gc === 'function') { (globalThis as { gc?: () => void }).gc!(); (globalThis as { gc?: () => void }).gc!() }
    a.data.u3 = { active: true, n: 3 }
    assert.ok(await until(() => Object.keys(snapshot(p) as object).length === 2, 8000), 'the derived stream survived GC and delivered u3')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('M5-REVIEW #5/#10 — a SERVER-local method flushes before returning AND returns a fresh copy (no live alias to kernel state)', async () => {
  const s = await fero('r', { uuid: 'aa', listen: false })
  try {
    //! #5: a handler that writes must have its write committed before the local call returns
    const setK = await fero('r', { uuid: 'bb', listen: false, methods: { setK: (v: unknown, ctx: { data: any }) => { ctx.data.K = v; return 'done' } } })
    const r = await setK.methods.setK(42)
    assert.equal(r, 'done')
    assert.equal((snapshot(setK.data) as Record<string, unknown>).K, 42, 'flush-on-return: the write committed before the reply')
    //! #10: read() returns a fresh COPY — mutating it must not corrupt committed kernel state
    await s.methods.update({ key: 'u', value: { n: 1 } })
    const got = await s.methods.read() as Record<string, { n: number }>
    got.u.n = 999
    assert.equal((snapshot(s.data) as Record<string, { n: number }>).u.n, 1, 'the read result was a copy — kernel state intact')
    await setK.destroy()
  } finally {
    await s.destroy()
  }
})

test("V4-5 — a validator-refused write inside a HANDLER fails the call with the reason (wire and local); ctx.flush() throws it so a handler can recover; admitted writes still resolve", async () => {
  const { a, b, addrs } = await pair({
    poke: (_: unknown, ctx: { data: any }) => { ctx.data.admin = 1; return 'ok' },
    careful: async (_: unknown, ctx: { data: any; flush(): Promise<void> }) => {
      ctx.data.admin = 1
      try { await ctx.flush(); return 'landed' } catch (e) { return 'recovered: ' + (e as Error).message }
    },
    fine: (_: unknown, ctx: { data: any }) => { ctx.data.ok = 1; return 'fine' },
  }, { seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') } })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  const view = (f: typeof c) => snapshot(f.data) as Record<string, unknown>
  try {
    //! before V4-5 this call resolved 'ok' while the write silently vanished — the banned silent partial
    await assert.rejects(async () => { await c.methods.poke() }, /write refused \(\["admin"\]\): reserved/)
    assert.equal(view(a).admin, undefined); assert.equal(view(b).admin, undefined)
    //! a mid-body flush throws the same refusal — the handler decides what to do with it
    assert.equal(await c.methods.careful(), 'recovered: write refused (["admin"]): reserved')
    //! admitted writes keep the ordinary flush-on-return contract
    assert.equal(await c.methods.fine(), 'fine')
    assert.ok(view(a).ok === 1 || view(b).ok === 1, 'committed before the reply')
    //! a SERVER-local invocation follows the same rule
    await assert.rejects(a.methods.poke(), /write refused/)
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
  //! the Refused rides the LENS path only: a handler that calls the instance's own methods.update gets its
  // typed WriteReject alone, and a handler that catches it RECOVERS (the panel's double-report finding)
  const s = await fero('r', {
    uuid: 'ss', listen: false, seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') },
    methods: { tryAdmin: async () => { try { await s.methods.update({ key: 'admin', value: 1 }); return 'set' } catch (e) { return 'refused: ' + (e as { reason: string }).reason } } },
  })
  try { assert.equal(await s.methods.tryAdmin(), 'refused: reserved', 'the handler handled it — flush-on-return must not override the recovery') }
  finally { await s.destroy() }
})
