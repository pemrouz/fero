//! Tier-1 suite for the views a method handler makes (I-29): the Host driven over a no-network Runtime,
// with a real garbage collector. A view a handler makes through ctx.data and then DROPS is released once
// the handler's handle to it is collected; a view the handler KEEPS (a cache, a closure, a returned view
// it also stored) stays live and keeps folding. `npm test` runs without --expose-gc, so the suite turns
// the collector on itself (v8.setFlagsFromString + a vm context hands back `gc`).

import { test } from 'node:test'
import assert from 'node:assert'
import v8 from 'node:v8'
import vm from 'node:vm'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { Host } from './methods.ts'
import { derived, snapshot } from './substrate.ts'
import { VERB, Framer, encodeControl } from '../kernel/codec.ts'

const gc: () => void = (globalThis as { gc?: () => void }).gc ?? (v8.setFlagsFromString('--expose-gc'), vm.runInNewContext('gc') as () => void)
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

//! settle — collect, then give the registry's cleanup callbacks a few turns to run; stop early once
// `done` holds. Returns whether it held (a test asserts on it, so a slow box still fails loudly).
const settle = async (done: () => boolean = () => false, rounds = 20): Promise<boolean> => {
  for (let i = 0; i < rounds; i++) {
    gc()
    await tick(); await tick()
    if (done()) return true
  }
  return done()
}

//! solo — one server Runtime with a Bind and a Host over `methods`; `link` opens a caller link (2) so a
// wire CALL/SUB can reach the Host. Every SUBREC/RESULT the host sends is recorded. `onFault` is where what
// a view's function throws lands (V4-47); without one it throws out of the write, as data's own.
const solo = (methods: Record<string, (a: any, ctx: any) => unknown>, seed: Record<string, unknown> = {}, onFault?: (e: unknown) => void) => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const node = rt.node
  const sent: { verb: number; value: any }[] = []
  const realSend = node.env.sink.send.bind(node.env.sink)
  node.env.sink.send = (link: number, bytes: Uint8Array) => {
    for (const f of new Framer().push(bytes.slice())) sent.push({ verb: f.verb, value: f.value })
    realSend(link, bytes)
  }
  const bind = new Bind(rt, { onFault })
  for (const [k, v] of Object.entries(seed)) bind.data[k] = v
  const host = new Host(rt, bind.data, methods, {})
  const link = () => {
    node.step({ kind: 'linkUp', link: 2, dialed: false })
    node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  }
  const wire = (verb: number, value: unknown) => node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(verb, value) })
  const stop = async () => { host.destroy(); bind.destroy(); await rt.destroy() }
  return { rt, bind, host, sent, link, wire, stop }
}

test('I-29 — a handler that makes a view and returns a plain value leaves nothing behind once the view is collected', async () => {
  const s = solo({
    count: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.filter((r: { n: number }) => r.n > 0)) as object).length,
    chain: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.filter((r: { n: number }) => r.n > 0).filter((r: { n: number }) => r.n < 9)) as object).length,
  }, { r1: { n: 1 }, r2: { n: 2 } })
  try {
    const N = 50
    for (let i = 0; i < N; i++) assert.equal(await s.host.invokeLocal('count', undefined), 2)
    for (let i = 0; i < N; i++) assert.equal(await s.host.invokeLocal('chain', undefined), 2)
    //! before: one dead filter per call stayed on the source and was worked out again on every commit
    // (50 + 50 children after 100 calls)
    assert.ok(await settle(() => derived(s.bind.data) === 0), `${N * 2} plain-value calls left ${derived(s.bind.data)} views on the source`)
  } finally {
    await s.stop()
  }
})

test('I-29 / V4-16 — a view the handler KEEPS stays live and correct across calls and collections: a module cache, a closure, a map', async () => {
  let cached: any = null
  const byKey = new Map<string, any>()
  const made = (() => { let v: any = null; return (ctx: { data: any }) => (v ??= ctx.data.filter((r: { n: number }) => r.n > 1)) })()
  const s = solo({
    cachedCount: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(cached ??= ctx.data.filter((r: { n: number }) => r.n > 0)) as object).length,
    closureCount: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(made(ctx)) as object).length,
    mapCount: (k: string, ctx: { data: any }) => {
      if (!byKey.has(k)) byKey.set(k, ctx.data.filter((r: { n: number }) => r.n > 0).filter((r: { n: number }) => r.n < 9))
      return Object.keys(snapshot(byKey.get(k)) as object).length
    },
    add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 2 } },
  }, { r1: { n: 1 } })
  try {
    assert.equal(await s.host.invokeLocal('cachedCount', undefined), 1)
    assert.equal(await s.host.invokeLocal('closureCount', undefined), 0)
    assert.equal(await s.host.invokeLocal('mapCount', 'a'), 1)
    const views = derived(s.bind.data)
    assert.equal(views, 3, 'three kept views hang off the source')
    await settle()
    assert.equal(derived(s.bind.data), 3, 'a collection releases none of them: the handler still holds each')
    await s.host.invokeLocal('add', 'r2')
    await settle()
    //! V4-16's regression: releasing the views of a plain-value call froze the cache, and the next call
    // read the first answer (1, not 2) — silent stale data
    assert.equal(await s.host.invokeLocal('cachedCount', undefined), 2, 'the cached view saw the new row')
    assert.equal(await s.host.invokeLocal('closureCount', undefined), 1, 'the closure view saw it')
    assert.equal(await s.host.invokeLocal('mapCount', 'a'), 2, 'the mapped chain saw it')
    assert.equal(derived(s.bind.data), 3, 'and no call made a new one')
    //! the handler lets go: the views go with the next collections
    cached = null; byKey.clear()
    assert.ok(await settle(() => derived(s.bind.data) === 1), `dropped views released, the closure's stays (${derived(s.bind.data)})`)
  } finally {
    await s.stop()
  }
})

test("I-29 — the proxy-return cousin: a view cached on the first call and RETURNED there stays live (CALL, local call, SUB), and a returned view nobody kept is released", async () => {
  let cached: any = null
  const s = solo({
    view: (_: unknown, ctx: { data: any }) => (cached ??= ctx.data.filter((r: { n: number }) => r.n > 0)),
    fresh: (_: unknown, ctx: { data: any }) => ctx.data.filter((r: { n: number }) => r.n > 0).filter((r: { n: number }) => r.n < 9),
    add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 1 } },
  }, { r1: { n: 1 } })
  const results = () => s.sent.filter((f) => f.verb === VERB.RESULT).map((f) => f.value)
  try {
    s.link()
    //! a wire CALL: the reply collapses the returned view to its snapshot
    s.wire(VERB.CALL, { id: 1, m: 'view', a: undefined })
    assert.ok(await settle(() => results().length === 1, 5))
    assert.deepEqual(Object.keys(results()[0].v), ['r1'])
    await s.host.invokeLocal('add', 'r2')
    await settle()
    //! before: the first call disposed the view it returned, the cache with it, so this read stayed ['r1']
    s.wire(VERB.CALL, { id: 2, m: 'view', a: undefined })
    assert.ok(await settle(() => results().length === 2, 5))
    assert.deepEqual(Object.keys(results()[1].v).sort(), ['r1', 'r2'], 'the second CALL reads the live cache')
    assert.deepEqual(Object.keys(await s.host.invokeLocal('view', undefined) as object).sort(), ['r1', 'r2'], 'the local call too')
    //! a SUB on the cached view, then UNSUB: the stream goes, the view stays
    s.wire(VERB.SUB, { id: 3, m: 'view', a: undefined })
    assert.ok(await settle(() => s.sent.some((f) => f.verb === VERB.SUBREC && f.value.id === 3), 5), 'the sub streamed')
    s.wire(VERB.UNSUB, { id: 3 })
    assert.equal(s.host.served, 0)
    await s.host.invokeLocal('add', 'r3')
    await settle()
    assert.deepEqual(Object.keys(snapshot(cached) as object).sort(), ['r1', 'r2', 'r3'], 'the cache still folds after the closed sub')
    assert.equal(derived(s.bind.data), 1, 'only the cache hangs off the source')
    //! a returned view nobody kept: released by the collector after the CALL, the local call and the SUB
    s.wire(VERB.CALL, { id: 4, m: 'fresh', a: undefined })
    assert.ok(await settle(() => results().length === 3, 5))
    assert.equal(Object.keys(results()[2].v).length, 3)
    await s.host.invokeLocal('fresh', undefined)
    assert.ok(await settle(() => derived(s.bind.data) === 1), `the CALL's and the local call's chains were released (${derived(s.bind.data)} left)`)
    s.wire(VERB.SUB, { id: 5, m: 'fresh', a: undefined })
    assert.ok(await settle(() => s.sent.some((f) => f.verb === VERB.SUBREC && f.value.id === 5), 5))
    assert.equal(derived(s.bind.data), 2, 'the open sub holds its chain')
    await settle()
    assert.equal(derived(s.bind.data), 2, 'a collection while the sub is open releases nothing')
    s.wire(VERB.UNSUB, { id: 5 })
    assert.ok(await settle(() => derived(s.bind.data) === 1), `the returned chains were released (${derived(s.bind.data)} left)`)
  } finally {
    await s.stop()
  }
})

test('I-29 — a method taken off a view keeps that view: the view is not released while the method is held', async () => {
  let narrow: ((fn: (r: { n: number }) => boolean) => any) | null = null
  const s = solo({
    keep: (_: unknown, ctx: { data: any }) => { narrow = ctx.data.filter((r: { n: number }) => r.n > 0).filter; return 'kept' },
    add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 2 } },
  }, { r1: { n: 1 } })
  try {
    assert.equal(await s.host.invokeLocal('keep', undefined), 'kept')
    await settle()
    assert.equal(derived(s.bind.data), 1, 'the view behind the held method is kept')
    await s.host.invokeLocal('add', 'r2')
    const v = narrow!((r) => r.n > 1)
    assert.deepEqual(Object.keys(snapshot(v) as object), ['r2'], 'a view made later off it is live')
    narrow = null
  } finally {
    await s.stop()
  }
})

test('I-29 — a view a handler hooked a subscription onto stays while it is hooked, and goes once the hook is disposed', async () => {
  let hook: { dispose(): void } | null = null
  let seen = 0
  const s = solo({
    hook: (_: unknown, ctx: { data: any }) => { hook = ctx.data.filter((r: { n: number }) => r.n > 0).connect({}, () => { seen++ }); return 'hooked' },
    add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 1 } },
  }, { r1: { n: 1 } })
  try {
    assert.equal(await s.host.invokeLocal('hook', undefined), 'hooked')
    await settle()
    assert.equal(derived(s.bind.data), 1, 'the hooked view is a live consumer: kept')
    const before = seen
    await s.host.invokeLocal('add', 'r2')
    assert.ok(seen > before, 'and it still fires')
    hook!.dispose()
    assert.ok(await settle(() => derived(s.bind.data) === 0), `the unhooked view was released (${derived(s.bind.data)} left)`)
  } finally {
    await s.stop()
  }
})

test("I-29 — a deduped view (sum('n')) a handler made and dropped is released, unless code outside a handler holds it raw", async () => {
  const s = solo({
    total: (_: unknown, ctx: { data: any }) => snapshot(ctx.data.sum('n')),
    top: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.filter((r: { n: number }) => r.n > 0).top(1)) as object).length,
  }, { r1: { n: 1 }, r2: { n: 2 } })
  try {
    for (let i = 0; i < 5; i++) assert.equal(await s.host.invokeLocal('total', undefined), 3)
    assert.ok(await settle(() => derived(s.bind.data) === 0), `the dropped sum was released (${derived(s.bind.data)} left)`)
    assert.equal(await s.host.invokeLocal('total', undefined), 3, 'and the next call mints a fresh one')
    //! module code reaches the SAME deduped handle raw (data dedups sum('n') per source) — the handler's
    // wrapper dies, the view must not
    const outside = s.bind.data.sum('n')
    assert.ok(await settle(() => false, 5) === false)
    assert.equal(derived(s.bind.data), 1, 'the sum module code holds is kept')
    s.bind.data.r3 = { n: 4 }
    assert.equal(snapshot(outside), 7, 'and still live')
    assert.equal(await s.host.invokeLocal('total', undefined), 7, 'the handler shares it')
    await settle()
    assert.equal(snapshot(outside), 7)
    s.bind.data.r4 = { n: 1 }
    assert.equal(snapshot(outside), 8, 'still live after the handler wrappers were collected')
    //! a chain whose tail is deduped on its own parent goes whole
    for (let i = 0; i < 5; i++) assert.equal(await s.host.invokeLocal('top', undefined), 1)
    assert.ok(await settle(() => derived(s.bind.data) === 1), `the filter→top chains were released (${derived(s.bind.data)} left)`)
  } finally {
    await s.stop()
  }
})

test('I-29 — a deduped view made off a view module code holds raw stays when the handler drops it: module code can reach it through that view', async () => {
  const s = solo({
    best: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.top(2).top(1)) as object).length,
  }, { r1: { n: 1 }, r2: { n: 2 }, r3: { n: 3 } })
  try {
    //! module code holds top(2) raw (data dedups it on the source, so the handler's ctx.data.top(2) is the
    // SAME view); the handler makes top(1) off it, and data dedups that on top(2) — module code asking
    // top(2).top(1) later gets the handle the handler made
    const base = s.bind.data.top(2)
    assert.equal(await s.host.invokeLocal('best', undefined), 1)
    const tail = base.top(1)
    await settle()
    assert.equal(derived(base), 1, 'the top(1) module code holds is still hooked on top(2)')
    s.bind.data.r0 = { n: 0 }
    assert.deepEqual(snapshot(tail), snapshot(base.top(1)))
    assert.equal(Object.keys(snapshot(tail) as object).length, 1, 'and it still answers')
    assert.equal(tail[Symbol.for('data.v4.node')].disposed, false, 'not released')
  } finally {
    await s.stop()
  }
})

test('I-29 / V4-47 — a view data stopped (a function in it threw) is walked through: the view under it goes once nothing holds it, even when its own wrapper died first', async () => {
  const NODE = Symbol.for('data.v4.node')
  const unlucky = (x: { n: number }, y: { n: number }) => { if (x.n === 13 || y.n === 13) throw new Error('unlucky'); return x.n - y.n }
  const faults: unknown[] = []
  let kept: any = null
  const s = solo({
    board: (_: unknown, ctx: { data: any }) => { kept = ctx.data.filter((r: { n: number }) => r.n > 0).za(unlucky); return 'kept' },
    add: (k: string, ctx: { data: any }) => { ctx.data[k] = { n: 13 } },
  }, { r1: { n: 1 }, r2: { n: 2 } }, (e) => faults.push(e))
  try {
    assert.equal(await s.host.invokeLocal('board', undefined), 'kept')
    //! the handler dropped the filter's wrapper and kept the za's: the filter's wrapper is collected now, and
    // the filter stays, since the za is still its child
    await settle()
    assert.equal(derived(s.bind.data), 1, 'the filter stays while the za hangs off it')
    //! data stops the za (its comparator throws on the new row, data's SCHEDULE clause 4): the throw goes to
    // the fault, the filter is still on the source, and only the za's wrapper can lead the collector back to it
    await s.host.invokeLocal('add', 'r13')
    assert.equal(faults.length, 1, 'the throw went to the fault')
    assert.equal(kept[NODE].disposed, true, 'data stopped the za')
    assert.equal(derived(s.bind.data), 1, 'the filter under it is still on the source')
    kept = null
    //! before: release() returned at the stopped za, and the filter stayed for good
    assert.ok(await settle(() => derived(s.bind.data) === 0), `the filter under the stopped za was released (${derived(s.bind.data)} left)`)
  } finally {
    await s.stop()
  }
})

test('I-29 — the handler FIRST, module code later: a deduped view module code reaches raw through a parent it escaped is kept (sum, a two-deep and a three-deep chain, a closure over f.data)', async () => {
  const NODE = Symbol.for('data.v4.node')
  let closed: any = null
  const s = solo({
    total: (_: unknown, ctx: { data: any }) => snapshot(ctx.data.top(3).sum('n')),
    best: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.top(2).top(1)) as object).length,
    deep: (_: unknown, ctx: { data: any }) => Object.keys(snapshot(ctx.data.top(4).top(3).top(2)) as object).length,
    min: (_: unknown, ctx: { data: any }) => snapshot(ctx.data.top(5).min('n')),
    //! a handler that closes over the resource and keeps what it reaches raw: the same as module code
    keep: () => { closed = s.bind.data.top(5).min('n'); return snapshot(closed) },
  }, { r1: { n: 1 }, r2: { n: 2 }, r3: { n: 3 } })
  try {
    //! the handler makes each chain first and drops it; then module code asks for the same chain raw,
    // and data's dedup hands it the handler's handles. The handler's wrappers die; the views must not.
    assert.equal(await s.host.invokeLocal('total', undefined), 6)
    assert.equal(await s.host.invokeLocal('best', undefined), 1)
    assert.equal(await s.host.invokeLocal('deep', undefined), 2)
    assert.equal(await s.host.invokeLocal('min', undefined), 1)
    const sum = s.bind.data.top(3).sum('n')
    const tail = s.bind.data.top(2).top(1)
    const deep = s.bind.data.top(4).top(3).top(2)
    assert.equal(await s.host.invokeLocal('keep', undefined), 1)
    await settle()
    for (const [name, v] of [['sum', sum], ['tail', tail], ['deep', deep], ['closed', closed]] as const)
      assert.equal(v[NODE].disposed, false, `the ${name} module code holds raw was released under it`)
    s.bind.data.r1 = { n: 100 }
    assert.equal(snapshot(sum), 105, 'the module sum still folds')
    assert.deepEqual(snapshot(tail), [{ n: 100 }], 'the module tail still folds')
    assert.deepEqual(snapshot(deep), [{ n: 100 }, { n: 2 }], 'the three-deep chain still folds')
    assert.equal(snapshot(closed), 2, 'the closure min still folds')
  } finally {
    await s.stop()
  }
})

test('I-29 — the registry at volume: a handler that makes 5000 views in one call leaves none behind (the cost ratio is pinned in api/methods.perf.ts)', async () => {
  const N = 5000
  const s = solo({
    many: (_: unknown, ctx: { data: any }) => { let k = 0; for (let i = 0; i < N; i++) k += ctx.data.filter((r: { n: number }) => r.n > i % 3).rowCount(); return k },
  }, { r1: { n: 1 }, r2: { n: 2 }, r3: { n: 3 } })
  try {
    let want = 0
    for (let i = 0; i < N; i++) want += 3 - (i % 3) // rows 1, 2, 3 over n > i % 3
    assert.equal(await s.host.invokeLocal('many', undefined), want)
    assert.ok(await settle(() => derived(s.bind.data) === 0, 40), `${N} views released (${derived(s.bind.data)} left)`)
  } finally {
    await s.stop()
  }
})
