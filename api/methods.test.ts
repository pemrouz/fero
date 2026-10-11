//! Tier-3 method-plane suite (M5c): the RPC/subscription contract over REAL sockets, held the way a
// consumer holds it. Pins: one-shot CALL round-trips (values and proxy snapshots), typed errors
// (unknown method / thrown handler), the LIVE subscription lifecycle (initial snapshot → streamed
// deltas → close), flush-on-return (a reply provably follows the commits its handler made — the call
// stays UNRESOLVED while a write is parked at an unreachable owner), confirm-over-RPC (the M5b spoke
// residual, closed), and failover re-subscribe (v2's OQ2: the live handle survives its server dying).

//! the battery pins (utils/battery.ts), whichever way this suite is run: the directory OFF (a single-file
// `node --test` must never meet a live box directory) and the config layer OFF (no flag, variable or file reaches a test)
import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { fero } from './index.ts'
import { derived, records, snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { ports, until, sleep } from '#utils'

//! pair — two servers; `methods` (if any) are hosted under `methods:` (V4-5 — which also makes the pair
// PROTECTED: a spoke changes data only through them), `extra` is further config for both
const pair = async (methods: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const pa = await ports.free()
  const pb = await ports.free()
  const hosted = Object.keys(methods).length ? { methods } : {}
  let a: any
  let b: any
  try {
    a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, ...hosted, ...extra } as never)
    b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, ...hosted, ...extra } as never)
    assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
    return { a, b, addrs: [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`] }
  } catch (e) {
    //! a setup that throws must not leave a server listening: every test here calls pair() before its own
    // try, so a leaked server kept the file from ever exiting and the battery hung (2026-10-11, about 7 hours)
    await b?.destroy().catch(() => {})
    await a?.destroy().catch(() => {})
    throw e
  }
}

test('one-shot CALL: values round-trip, a returned proxy snapshots, unknown methods and thrown handlers reject typed', async () => {
  const { a, b, addrs } = await pair({
    total: (n: number, ctx: { data: any }) => { void ctx; return n * 2 },
    boom: () => { throw new Error('handler exploded') },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.equal(await c.methods.total(21), 42, 'a value round-trips')
    //! built-in read: await = snapshot of the resource (a proxy return collapses at the host)
    a.data.seeded = { v: 1 }
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).seeded !== undefined))
    assert.deepEqual(await c.methods.read(), snapshot(c.data), 'read() snapshot ≡ the replicated spoke state')
    //! handles are callable proxies — reject-assertions await them inside a closure
    await assert.rejects(async () => { await c.methods.nosuch() }, /unknown method 'nosuch'/)
    await assert.rejects(async () => { await c.methods.boom() }, /handler exploded/)
    //! …and CALLING a handle is the one-shot call (`apply` trap): `h()` is the promise, so assert.rejects
    // takes the handle as-is — it used to get undefined back and fail with ERR_INVALID_RETURN_VALUE
    await assert.rejects(c.methods.boom(), /handler exploded/)
    await assert.rejects(c.methods.nosuch(), /unknown method 'nosuch'/)
    assert.equal(await c.methods.total(4)(), 8, 'h() resolves the call')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('LIVE subscription: reactive touch opens the stream (initial snapshot + deltas); close() stops it; server-side writes keep flowing until then', async () => {
  const { a, b, addrs } = await pair({
    watch: (_: unknown, ctx: { data: any }) => ctx.data, // returns a ViewProxy → subscribable
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    //! happy path: the reply follows the commit — the value is on the HOST the instant the call returns
    const r = await c.methods.put({ k: 'x', v: 1 })
    assert.equal(r, 'committed-before-reply')
    //! no until(): flush-on-return means the hosting server committed BEFORE replying; with two
    // members either it owns the key (local commit) or it forwarded and awaited the WACK — both
    // resolve before the reply, so at least one server already folds it
    assert.ok((snapshot(a.data) as Record<string, unknown>).x === 1 || (snapshot(b.data) as Record<string, unknown>).x === 1,
      'the write was committed before the reply left')
    //! hold path: CRASH bb (no leave — destroy() is graceful since V4-6, and a clean leave would hand {aa}
    // a writable one-member view) → {aa} is a minority of 2 → the gate closes and puts park → the reply is HELD
    await diag(b)!.crash!()
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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

//! V4-52: a server's own call answered through structuredClone, which is not what the wire makes of a value: it kept a
// Date or a Map a client gets as {}, kept text UTF-8 changes (a lone surrogate, a leading byte order mark), threw a
// DataCloneError on a view of Proxies the wire carries as plain objects, and handed a plain result out by reference.
// Local and remote now answer the same: copyOf, the codec's own copy, with a reply's limits.
test("a server's own call answers what a client's call of the same handler answers: views of Proxies, Dates, Maps and text UTF-8 changes, a plain result, the deepest value a reply carries", async () => {
  const nest = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = [v]; return v }
  const plain = { when: new Date(0), s: 'x\uD800' }
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('r', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { luna: { mood: 'hungry' } }, methods: {
    proxies: (_: unknown, ctx: { data: any }) => ctx.data.map((r: object) => new Proxy(r, {})),
    dates: (_: unknown, ctx: { data: any }) => ctx.data.map(() => new Date(0)),
    maps: (_: unknown, ctx: { data: any }) => ctx.data.map(() => ({ m: new Map([[1, 2]]) })),
    text: (_: unknown, ctx: { data: any }) => ctx.data.map(() => ({ s: 'x\uD800', bom: '\uFEFFhi' })),
    plain: () => plain,
    deepest: () => nest(63),
    deeper: () => nest(64),
  } } as never)
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  type M = Record<string, (a?: unknown, o?: { timeout?: number }) => Promise<unknown>>
  try {
    assert.ok(await until(() => (snapshot(c.data) as Record<string, unknown>).luna !== undefined, 8000), 'the client caught up')
    for (const m of ['proxies', 'dates', 'maps', 'text', 'plain', 'deepest', 'read']) {
      const local = await (s.methods as M)[m]()
      const remote = await (c.methods as M)[m](undefined, { timeout: 8000 })
      assert.deepStrictEqual(local, remote, `methods.${m}: the server's own call and a client's agree, prototypes and all`)
    }
    assert.deepStrictEqual(await (s.methods as M).dates(), { luna: {} })
    assert.deepStrictEqual(await (s.methods as M).text(), { luna: { s: 'x\uFFFD', bom: 'hi' } })
    const got = await (s.methods as M).plain()
    assert.notEqual(got, plain, 'a plain result is a copy, never the handler\'s object')
    await assert.rejects((s.methods as M).deeper(), /^Error: methods\.deeper: the result could not be sent: deeper than 63 levels$/)
    await assert.rejects((c.methods as M).deeper(undefined, { timeout: 8000 }), /^Error: methods\.deeper: the result could not be sent: /)
  } finally {
    await c.destroy(); await s.destroy()
  }
})

//! V4-52: a server-local call handed the handler the caller's own object, so a handler that changed its argument
// changed the caller's object, and an argument a client's call refuses (a bigint, a Date) went through
test("a server-local call gives its handler fero's own copy of the argument, and refuses an argument a client's call refuses", async () => {
  const s = await fero('r', { uuid: 'aa', listen: false, methods: {
    touch: (a: { n: number }) => { a.n = 2; return a.n },
    echo: (a: unknown) => a,
  } } as never)
  type M = Record<string, (a?: unknown) => Promise<unknown>>
  try {
    const form = { n: 1 }
    assert.equal(await (s.methods as M).touch(form), 2, 'the handler changed its copy')
    assert.equal(form.n, 1, "the caller's object is as it was")
    await assert.rejects((s.methods as M).echo({ when: new Date(0) }), /^Error: methods\.echo: the argument cannot be sent: a Date \(send date\.getTime\(\) or date\.toISOString\(\)\) at when$/)
    await assert.rejects((s.methods as M).echo(10n), /^Error: methods\.echo: the argument cannot be sent: a bigint$/)
    await assert.rejects((s.methods as M).echo(s.data), /^Error: methods\.echo: the argument cannot be sent: a live view, not a value/)
    assert.deepStrictEqual(await (s.methods as M).echo({ n: [1, 'x'] }), { n: [1, 'x'] })
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
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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

test("ctx.peer on a SERVER-local call is the server's own uuid (it IS the caller) — the same handler stamps the same field either way", async () => {
  const s = await fero('r', { uuid: 'ss', listen: false, methods: { whoami: (_: unknown, ctx: { peer?: string }) => ctx.peer ?? 'nobody' } })
  try {
    //! before: a local invoke built its Context without `peer`, so a handler in 40-chat's shape wrote a
    // row with no `from` when the server called its own method — and every joiner's comparator threw
    assert.equal(await s.methods.whoami(), 'ss', 'a local call names the server itself')
  } finally {
    await s.destroy()
  }
})

test("I-28 — 'open, then act' right after a client's fero() resolves shows the delta: the held SUB is replayed before the held CALL, so the view shows the value before AND after", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { balance: 100 },
    methods: {
      balance: (_: unknown, ctx: { data: any }) => ctx.data,
      //! SYNC, and this server owns every cell: the deposit COMMITS inside the handler (V4-7)
      deposit: (n: number, ctx: { data: any }) => { ctx.data.balance = (snapshot(ctx.data) as { balance: number }).balance + n },
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    //! a client's fero() resolves with no admitted link: both the SUB and the CALL are HELD by the caller
    // and re-dispatched on the first primary. Before: CALLs first — the view's first real frame already
    // held 105, and 100 → 105 never rendered as a change (4/4 runs in the probe).
    const frames: unknown[] = []
    const live = c.methods.balance().open()
    records(live, () => frames.push((snapshot(live) as { balance?: number }).balance))
    await c.methods.deposit(5)
    assert.ok(await until(() => (snapshot(live) as { balance?: number }).balance === 105, 8000), `the view caught up (${JSON.stringify(frames)})`)
    assert.ok(frames.includes(100), `the view showed the value BEFORE the deposit too (${JSON.stringify(frames)})`)
  } finally {
    await c.destroy(); await s.destroy()
  }
})

test("I-29 — a derived view minted for a subscription or a one-shot call is DISPOSED when it is done: the source's derived count returns to 0; a shared view and the resource itself are never touched", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  let shared: any = null
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { u1: { who: 'alice', n: 1 }, u2: { who: 'bob', n: 2 } },
    methods: {
      feed: (who: string, ctx: { data: any }) => ctx.data.filter((r: { who: string }) => r.who === who),
      chain: (who: string, ctx: { data: any }) => ctx.data.filter((r: { who: string }) => r.who === who).filter((r: { n: number }) => r.n > 0),
      all: (_: unknown, ctx: { data: any }) => ctx.data,
      //! a view built ONCE outside the handler and handed out: not this invocation's to dispose
      bobs: () => shared,
    },
  })
  shared = s.data.filter((r: { who: string }) => r.who === 'bob')
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.equal(derived(s.data), 1, 'the shared view is the one derived node at the start')
    //! before: five open/close cycles left five `filter` children on the source, each re-evaluated on
    // every commit for the server's lifetime (the probe: children 0 → 5)
    for (let i = 0; i < 5; i++) {
      const h = c.methods.feed('alice'); const live = h.open()
      assert.ok(await until(() => Object.keys(snapshot(live) as object).length === 1, 8000), 'the filtered snapshot arrived')
      h.close()
    }
    assert.ok(await until(() => derived(s.data) === 1, 3000), `five closed subscriptions left nothing (${derived(s.data)} derived)`)
    //! a chain disposes whole; a one-shot CALL and a server-local call release theirs once collapsed
    const h = c.methods.chain('alice'); const live = h.open()
    assert.ok(await until(() => Object.keys(snapshot(live) as object).length === 1, 8000))
    h.close()
    assert.deepEqual(await c.methods.feed('bob'), { u2: { who: 'bob', n: 2 } })
    assert.deepEqual(await s.methods.chain('bob'), { u2: { who: 'bob', n: 2 } })
    assert.ok(await until(() => derived(s.data) === 1, 3000), `the chain, the call and the local call left nothing (${derived(s.data)} derived)`)
    //! never the resource itself, never the shared view: both still serve after their subscriptions close
    const whole = c.methods.all(); whole.open(); const bobs = c.methods.bobs(); bobs.open()
    assert.ok(await until(() => Object.keys(snapshot(whole.open()) as object).length === 2 && Object.keys(snapshot(bobs.open()) as object).length === 1, 8000))
    whole.close(); bobs.close()
    assert.equal(derived(s.data), 1, 'the shared view is still on the source')
    assert.deepEqual(snapshot(shared), { u2: { who: 'bob', n: 2 } }, 'and still live')
    s.data.u3 = { who: 'bob', n: 3 }
    assert.equal(Object.keys(snapshot(shared) as object).length, 2, 'it keeps folding')
    assert.deepEqual(await c.methods.bobs(), snapshot(shared), 'and the next caller gets it whole')
  } finally {
    await c.destroy(); await s.destroy()
  }
})

test("I-27 — a method that returns a live NUMBER streams it: the mirror reads { value } and follows the server; a plain-value SUB arrives the same way; the one-shot stays the bare number", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { count: 0 },
    methods: {
      count: (_: unknown, ctx: { data: any }) => ctx.data.count,
      five: () => 5,
      bump: (_: unknown, ctx: { data: any }) => { ctx.data.count = (snapshot(ctx.data) as { count: number }).count + 7 },
      drop: (_: unknown, ctx: { data: any }) => { delete ctx.data.count },
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.equal(await c.methods.count(), 0, 'the one-shot is the bare number')
    //! before: the client mirror is object-born, data refused the root number, and the refusal was
    // swallowed — the mirror stayed {} forever (the probe: `live after open: {}`)
    const live = c.methods.count().open()
    assert.ok(await until(() => (snapshot(live) as { value?: number }).value === 0, 8000), `the first frame is { value: 0 } (${JSON.stringify(snapshot(live))})`)
    await c.methods.bump()
    assert.ok(await until(() => (snapshot(live) as { value?: number }).value === 7, 8000), `a server write streams as { value: 7 } (${JSON.stringify(snapshot(live))})`)
    //! the cell goes away: the mirror empties instead of holding the last number
    await c.methods.drop()
    assert.ok(await until(() => JSON.stringify(snapshot(live)) === '{}', 8000), `a removed cell empties the mirror (${JSON.stringify(snapshot(live))})`)
    const five = c.methods.five().open()
    assert.ok(await until(() => (snapshot(five) as { value?: number }).value === 5, 8000), `a plain-value SUB arrives as { value: 5 } (${JSON.stringify(snapshot(five))})`)
    assert.equal(await c.methods.five(), 5)
  } finally {
    await c.destroy(); await s.destroy()
  }
})

test("the subscribe leg is LOUD: a handler that throws on SUB rejects `ready`, the handle reads 'failed' and every read throws; a refused write inside a SUB handler rejects the same way; a good sub resolves `ready`; a failed sub is dropped, never re-subscribed", async () => {
  let boomRuns = 0
  const { a, b, addrs } = await pair({
    watch: (_: unknown, ctx: { data: any }) => ctx.data,
    boom: () => { boomRuns++; throw new Error('handler exploded') },
    //! V4-5 on the SUB leg: the write is refused, so the stream must never open
    pokeLive: (_: unknown, ctx: { data: any }) => { ctx.data.admin = 1; return ctx.data },
  }, { seams: { validation: (r: { key: string[] }) => (r.key[0] !== 'admin' || 'reserved') } })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    a.data.pre = 1
    //! touching `ready` opens the subscription; it resolves on the first frame
    const good = c.methods.watch()
    await good.ready
    assert.equal(good.mode, 'live')
    assert.ok(await until(() => (snapshot(good.open()) as { pre?: number }).pre === 1, 8000), 'the good sub folded')
    //! before: the host's ok:false RESULT for a SUB id was looked up in the CALLS only — dropped; the
    // mirror stayed {} forever and the client said nothing
    const h = c.methods.boom(); h.open()
    await assert.rejects(h.ready, /methods\.boom: handler exploded/)
    assert.equal(h.mode, 'failed')
    assert.throws(() => h.anything, /methods\.boom: handler exploded/, 'a read on a failed handle throws the reason')
    assert.throws(() => h.open(), /methods\.boom: handler exploded/)
    h.close() // a no-op on a failed sub
    assert.equal(h.mode, 'failed')
    const r = c.methods.pokeLive(); r.open()
    await assert.rejects(r.ready, /methods\.pokeLive: write refused \(\["admin"\]\): reserved/)
    //! a failed sub is DROPPED: a primary change re-subscribes the good sub, not the failed one
    const primary = (snapshot(c.cluster) as { me: { primary: string } }).me.primary
    const [gone, kept] = primary === 'aa' ? [a, b] : [b, a]
    await gone.destroy()
    assert.ok(await until(() => {
      kept.data['post' + Date.now()] = true
      return Object.keys(snapshot(good.open()) as object).some((k) => k.startsWith('post'))
    }, 15_000), 'the good sub resumed on the survivor')
    assert.equal(boomRuns, 1, 'the failed sub was not re-run on the new primary')
  } finally {
    await c.destroy(); await a.destroy().catch(() => {}); await b.destroy().catch(() => {})
  }
})

test("a kernel outcome fails the call (the reply is true): an ASSIGNMENT in a handler that the node never commits rejects the call with `write destroyed`; a handler that awaited its own methods.update and caught the loss keeps its recovery", async () => {
  let self: any = null
  const { a, b } = await pair({
    put: (_: unknown, ctx: { data: any }) => { ctx.data.parked = 1; return 'ok' },
    careful: async () => {
      try { await self.methods.update({ key: 'parked2', value: 1 }); return 'landed' } catch { return 'recovered' }
    },
  })
  self = a
  try {
    //! crash bb (no leave): {aa} is a minority, the gate closes and every write parks — never committed
    await diag(b)!.crash!()
    assert.ok(await until(() => (snapshot(a.cluster) as { writable: boolean }).writable === false, 10_000), 'gate closed (minority)')
    const put = a.methods.put(); put.catch(() => {})
    const careful = a.methods.careful(); careful.catch(() => {})
    await sleep(200)
    //! the node goes away with both writes parked: each write's promise rejects 'destroyed'. Before: settle
    // swallowed every kernel outcome, so `put` resolved 'ok' for a write that never happened
    await a.destroy()
    await assert.rejects(put, /write destroyed \(\["parked"\]\)/)
    assert.equal(await careful, 'recovered', 'the handler saw the loss itself and decided — not overridden at flush')
  } finally {
    await a.destroy().catch(() => {}); await b.destroy().catch(() => {})
  }
})

test("I-29 — a returned SUM (a scalar view) is released on close like an operator; a view the handler hooked a sink onto stays", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const seen: number[] = []
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { u1: { who: 'alice', n: 1 }, u2: { who: 'bob', n: 2 } },
    methods: {
      total: (_: unknown, ctx: { data: any }) => ctx.data.sum('n'),
      //! a sink the handler hooked on is a live consumer: that view is the server's now, not dead
      hook: (_: unknown, ctx: { data: any }) => { records(ctx.data.filter((r: { n: number }) => r.n > 1), () => seen.push(1)); return 'hooked' },
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.equal(derived(s.data), 0)
    //! a returned SCALAR view (a sum) streams as { value } and is released on close like an operator
    // (before: disposeMinted stopped at any non-operator, so every closed sum stayed on the source)
    const t = c.methods.total(); const sum = t.open()
    assert.ok(await until(() => (snapshot(sum) as { value?: number }).value === 3, 8000), `the sum streamed (${JSON.stringify(snapshot(sum))})`)
    t.close()
    assert.ok(await until(() => derived(s.data) === 0, 3000), `the closed sum left nothing (${derived(s.data)} derived)`)
    assert.equal(await c.methods.hook(), 'hooked')
    assert.equal(derived(s.data), 1, 'the hooked view stays')
  } finally {
    await c.destroy(); await s.destroy()
  }
})

test("a view a plain-value handler minted and KEPT (a lazily cached module-level view) stays live: a later call reads the new rows, and a sub on it follows", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  let cached: any = null
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { r1: { n: 1 } },
    methods: {
      cachedCount: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(cached ??= ctx.data.filter((r: { n: number }) => r.n > 0)) as object).length,
      cachedView: () => cached,
      add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 1 } },
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    assert.equal(await c.methods.cachedCount(), 1)
    await c.methods.add('r2')
    //! before: the plain-value path disposed every view minted in the call that nothing hooked — the
    // handler's own cache among them — so the second call read the frozen first answer
    assert.equal(await c.methods.cachedCount(), 2, 'the cached view saw the new row')
    const h = c.methods.cachedView(); const live = h.open()
    assert.ok(await until(() => Object.keys(snapshot(live) as object).length === 2, 8000), `the sub on the cached view folded (${JSON.stringify(snapshot(live))})`)
    await c.methods.add('r3')
    assert.ok(await until(() => Object.keys(snapshot(live) as object).length === 3, 8000), `the sub on the cached view follows (${JSON.stringify(snapshot(live))})`)
    h.close()
  } finally {
    await c.destroy(); await s.destroy()
  }
})

test("a sub that fails AFTER its first frame is loud too: re-subscribed on a new primary whose handler throws, `onError` hears it, the fresh `ready` rejects, and the handle reads 'failed'", async () => {
  let runs = 0
  const { a, b, addrs } = await pair({
    //! the first run streams; the second (on the new primary) throws after a beat, so the test can take
    // the fresh `ready` before it rejects
    watch: (_: unknown, ctx: { data: any }) => {
      if (++runs === 1) return ctx.data
      return sleep(300).then(() => { throw new Error('second primary exploded') })
    },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const heard: Error[] = []
  try {
    a.data.pre = 1
    const h = c.methods.watch(undefined, { onError: (e: Error) => heard.push(e) })
    await h.ready
    assert.ok(await until(() => (snapshot(h.open()) as { pre?: number }).pre === 1, 8000), 'the sub folded')
    const primary = (snapshot(c.cluster) as { me: { primary: string } }).me.primary
    await (primary === 'aa' ? a : b).destroy()
    assert.ok(await until(() => runs === 2, 15_000), 'the sub was re-run on the new primary')
    //! before: `ready` had resolved on the first frame, so the failure rejected nothing; the mirror kept
    // the old primary's data as if live and nobody holding it heard a thing
    await assert.rejects(h.ready, /methods\.watch: second primary exploded/)
    assert.ok(await until(() => heard.length === 1, 3000), 'onError heard the failure')
    assert.match(heard[0].message, /second primary exploded/)
    assert.equal(h.mode, 'failed')
  } finally {
    await c.destroy(); await a.destroy().catch(() => {}); await b.destroy().catch(() => {})
  }
})

test("`ready` settles when the sub ends without a frame: close() rejects it 'closed' and does not re-open; destroy() rejects it 'destroyed' — neither hangs nor stops the process", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero('r', {
    uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { k: 1 },
    methods: { slow: async () => { await sleep(400); return 1 } },
  })
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const bounded = (p: Promise<unknown>) => Promise.race([p, sleep(1500).then(() => { throw new Error('ready still pending') })])
  try {
    const h = c.methods.slow(); h.open(); h.close()
    //! before: reading `ready` on a closed handle opened a NEW sub (`live ??= subscribe`), which then framed
    await assert.rejects(bounded(h.ready), /methods\.slow: closed/)
    assert.equal(h.mode, 'oneshot', 'reading ready did not re-open the closed sub')
    const d = c.methods.slow(); d.open()
    await c.destroy()
    //! before: destroy() cleared the subs without settling them — `await d.ready` hung forever
    await assert.rejects(bounded(d.ready), /methods\.slow: destroyed/)
  } finally {
    await c.destroy().catch(() => {}); await s.destroy()
  }
})

//! A view on a live method mirror that throws as a streamed record folds (api/substrate.ts Fault): before the fix
// the error left the caller's onSubRecs, inside the kernel's step, and the client process exited.
test('a view on a live method mirror that throws on a streamed row is reported, not fatal: the sub keeps streaming and the row comes back', async () => {
  const { a, b, addrs } = await pair({ watch: (_: unknown, ctx: { data: any }) => ctx.data })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  type Cats = Record<string, { mood: string } | null>
  try {
    a.data.luna = { mood: 'hungry' }
    const live = c.methods.watch()
    assert.ok(await until(() => (snapshot(live.open()) as Cats).luna !== undefined, 8000), 'the mirror folded')
    const hungry = live.open().filter((cat: { mood: string }) => cat.mood === 'hungry') // throws on a null row
    a.data.mochi = null
    a.data.biscuit = { mood: 'hungry' }
    assert.ok(await until(() => 'biscuit' in (snapshot(hungry) as Cats), 8000), 'the mirror keeps streaming past the bad row')
    assert.equal(live.mode, 'live', 'the sub did not fail')
    a.data.mochi = { mood: 'hungry' }
    assert.ok(await until(() => 'mochi' in (snapshot(hungry) as Cats), 8000), 'the left-out row comes back')
  } finally {
    process.stderr.write = orig
    await c.destroy(); await a.destroy(); await b.destroy()
  }
  const mine = out.join('').split('\n').filter((l) => l.startsWith(`fero('r'): filter threw on row "mochi"`))
  assert.equal(mine.length, 1, JSON.stringify(out))
})

//! data stops a view whose function threw (its SCHEDULE clause 4). A live subscription over it used to read
// 'live' over a mirror that would never move again; now the caller's handle fails with the reason, and the
// views the handler minted above the stopped one are released (disposeMinted walks through it).
test("a live subscription whose view data stops fails loudly: the handle reads 'failed' with the reason, and the server keeps nothing it minted", async () => {
  const unlucky = (x: { n: number }, y: { n: number }) => { if (x.n === 13 || y.n === 13) throw new Error('unlucky'); return x.n - y.n }
  //! a long-lived view per server (made outside any handler) that a one-shot call returns
  const boards = new Map<unknown, unknown>()
  const { a, b, addrs } = await pair({
    frozen: (_: unknown, ctx: { data: any }) => boards.get(ctx.data),
    board: (_: unknown, ctx: { data: any }) => ctx.data.filter((r: unknown) => r !== null).za(unlucky),
    //! the handler's own write stops the view before its stream opens
    trip: (_: unknown, ctx: { data: any }) => { const v = ctx.data.za(unlucky); ctx.data.bad = { n: 13 }; return v },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    a.data.one = { n: 1 }
    assert.ok(await until(() => (snapshot(b.data) as Record<string, unknown>).one !== undefined, 8000), 'both servers hold the row')
    //! either server may serve the sub: count the derived views on both. The two boards are made after the
    // count; data stops them too, so after the stop the count is back where it was.
    const views = () => derived(a.data) + derived(b.data)
    const before = views()
    boards.set(a.data, a.data.za(unlucky))
    boards.set(b.data, b.data.za(unlucky))
    const errs: string[] = []
    const live = c.methods.board(undefined, { onError: (e: Error) => errs.push(e.message) })
    //! a mirror is a keyed source: an ordered view arrives as { 0: …, 1: … }
    assert.ok(await until(() => Object.keys(snapshot(live.open()) as object).length === 1, 8000), 'the board streamed')
    a.data.thirteen = { n: 13 }
    assert.ok(await until(() => live.mode === 'failed', 8000), `the sub failed (mode ${live.mode})`)
    assert.ok(errs.some((m) => m.includes('the view this subscription streams has stopped')), JSON.stringify(errs))
    assert.ok(await until(() => views() === before, 3000), `the filter above the stopped za was released (${views()} derived, ${before} before)`)
    //! a one-shot call over a stopped view is refused too, never answered with a frozen picture
    await assert.rejects(c.methods.frozen(undefined, { timeout: 8000 }), /the view this method returns has stopped/)
    await assert.rejects(a.methods.frozen(), /the view this method returns has stopped/)
    const tripped = c.methods.trip(undefined, { onError: () => {} })
    tripped.open()
    assert.ok(await until(() => tripped.mode === 'failed', 8000), `a view stopped by the handler's own write fails at open (mode ${tripped.mode})`)
  } finally {
    process.stderr.write = orig
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

test('a method whose result cannot be sent rejects that call with the reason, and the server carries on', async () => {
  const { a, b, addrs } = await pair({
    big: () => 10n,
    odd: () => { throw Object.create(null) },
    ok: () => 'fine',
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    await assert.rejects(c.methods.big(undefined, { timeout: 8000 }), /the result could not be sent: .*bigint/)
    await assert.rejects(c.methods.odd(undefined, { timeout: 8000 }), /object/)
    assert.equal(await c.methods.ok(undefined, { timeout: 8000 }), 'fine', 'the server is alive')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

//! data's record sink used to copy each value (structuredClone) before fero's own sink saw it, so a value
// the copy cannot take (a function) failed inside data's commit: the row was lost, the sub read 'live' and the
// server blamed a tap. The Host now takes the records by reference and encodes them itself.
test("a served value the wire cannot carry ends the live sub loudly, once; the server prints one line and keeps nothing it minted", async () => {
  const { a, b, addrs } = await pair({
    shapes: (_: unknown, ctx: { data: any }) => ctx.data.map((r: { bad?: boolean }) => (r !== null && r.bad === true ? { f: () => 1 } : r)),
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    a.data.good = { n: 1 }
    const views = () => derived(a.data) + derived(b.data)
    const before = views()
    const errs: string[] = []
    const live = c.methods.shapes(undefined, { onError: (e: Error) => errs.push(e.message) })
    assert.ok(await until(() => Object.keys(snapshot(live.open()) as object).length === 1, 8000), 'the view streamed')
    a.data.worse = { bad: true }
    assert.ok(await until(() => live.mode === 'failed', 8000), `the sub failed (mode ${live.mode})`)
    assert.equal(errs.length, 1)
    assert.ok(errs[0].includes('the stream could not send a record'), errs[0])
    assert.ok(await until(() => views() === before, 3000), `nothing minted is left (${views()} derived, ${before} before)`)
  } finally {
    process.stderr.write = orig
    await c.destroy(); await a.destroy(); await b.destroy()
  }
  const mine = out.join('').split('\n').filter((l) => l.startsWith("fero('r'): a live subscription ended: a record could not be sent (methods.shapes)"))
  assert.equal(mine.length, 1, JSON.stringify(out))
  assert.ok(mine[0].endsWith(' — fero carried on'), mine[0])
})

test('a handler that throws a hostile value is refused, and the server carries on: a message getter that throws, a Proxy whose traps throw, a scoped error carrying a bigint', async () => {
  const bad = new Error('x')
  Object.defineProperty(bad, 'message', { get() { throw new Error('no message') } })
  const { a, b, addrs } = await pair({
    getter: () => { throw bad },
    trap: () => { throw new Proxy({}, { get() { throw new Error('get trap') }, getPrototypeOf() { throw new Error('proto trap') } }) },
    scoped: () => { throw { scoped: true, op: 'x', reason: 'unreachable', n: 10n } },
    ok: () => 'fine',
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    for (const m of ['getter', 'trap', 'scoped'])
      await assert.rejects((c.methods as Record<string, (a?: unknown, o?: object) => Promise<unknown>>)[m](undefined, { timeout: 8000 }), `methods.${m} is refused`)
    assert.equal(await c.methods.ok(undefined, { timeout: 8000 }), 'fine', 'the server is alive')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

//! A handler may return anything, a Proxy whose traps throw included: the Host's guards ask isProxy() inside
// their own catch blocks, where a throw was an unhandled rejection that ended the server (the third review).
test('a handler that returns a hostile Proxy is answered or refused, as a call and as a sub, and the server carries on', async () => {
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('r', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { luna: { mood: 'hungry' } }, methods: {
    hostile: () => new Proxy({}, { get() { throw new Error('get trap') } }),
    ok: () => 'fine',
  } } as never)
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    await c.methods.hostile(undefined, { timeout: 8000 }).then(() => {}, () => {})
    const live = c.methods.hostile(undefined, { onError: () => {} })
    live.open()
    assert.ok(await until(() => live.mode === 'failed', 8000), `the sub was refused (mode ${live.mode})`)
    assert.equal(await c.methods.ok(undefined, { timeout: 8000 }), 'fine', 'the server is alive')
  } finally {
    process.stderr.write = orig
    await c.destroy(); await s.destroy()
  }
})

test('a SUB closed while its handler is still flushing leaves nothing it minted on the server', async () => {
  const { a, b, addrs } = await pair({
    touchy: (_: unknown, ctx: { data: any }) => { ctx.data.touch = Date.now(); return ctx.data.filter((r: unknown) => r !== null) },
  })
  const c = await fero('r', { uuid: 'zz', hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
  try {
    //! linked first: a SUB opened before the client's first link is held, and a close drops it unsent
    assert.ok(await until(() => (snapshot(c.cluster) as { me: { primary: string | null } }).me.primary !== null, 8000), 'the client linked')
    const views = () => derived(a.data) + derived(b.data)
    const before = views()
    for (let i = 0; i < 10; i++) {
      const h = c.methods.touchy(undefined, { onError: () => {} })
      h.open()
      h.close()
    }
    await sleep(1000)
    assert.equal(views(), before, 'the ten views the handlers minted were released')
  } finally {
    await c.destroy(); await a.destroy(); await b.destroy()
  }
})

//! data cuts a write loop at its cap and drops the errors it had collected, a view it stopped among them: the
// composer sweeps the live subs on the loop error itself, or the sub would read 'live' over a frozen mirror.
test('a served view that data stops inside a write loop still fails its live sub', async () => {
  const cmp = (x: { n?: number } | null, y: { n?: number } | null) => { if (x?.n === 13 || y?.n === 13) throw new Error('unlucky 13'); return (x?.n ?? 0) - (y?.n ?? 0) }
  const p = await ports.free()
  const addr = `127.0.0.1:${p}`
  const s = await fero('r', { uuid: 'aa', listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, data: { a: { n: 1 }, k: { n: 0 } }, methods: {
    board: (_: unknown, ctx: { data: any }) => ctx.data.za(cmp),
  } } as never)
  const c = await fero('r', { uuid: 'zz', hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const out: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    const errs: string[] = []
    const live = c.methods.board(undefined, { onError: (e: Error) => errs.push(e.message) })
    assert.ok(await until(() => Object.keys(snapshot(live.open()) as object).length === 2, 8000), 'the board streamed')
    let armed = false
    let i = 0
    s.data.tap(() => { if (armed) s.data.k = { n: ++i } })
    armed = true
    s.data.go = { n: 100 } // the tap writes k on every change: data cuts the loop, and k.n passes 13 on the way
    armed = false
    assert.ok(await until(() => live.mode === 'failed', 8000), `the sub failed (mode ${live.mode})`)
    assert.ok(errs.some((m) => m.includes('has stopped')), JSON.stringify(errs))
  } finally {
    process.stderr.write = orig
    await c.destroy(); await s.destroy()
  }
  assert.ok(out.join('').includes("fero('r'): data cut a write loop after "), out.join(''))
})
