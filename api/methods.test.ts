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
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, ...hosted, ...extra } as never)
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeat: { ms: 50 }, redial: { ms: 30 }, ...hosted, ...extra } as never)
  assert.ok(await until(() => (snapshot(a.cluster) as { epoch: number }).epoch >= 1, 8000), 'view formed')
  return { a, b, addrs: [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`] }
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
