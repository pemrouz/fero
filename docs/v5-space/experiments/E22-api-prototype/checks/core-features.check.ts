// The core's feature check: one assertion per L2/L3/L4 behaviour the patterns lean on, each as
// API.md states it, on three servers and a client. No fault schedule (the other core checks own
// faults); several seeds, so the shuffle and the latencies vary. Each step names its requirement.
import { check, report, isMain } from '../proto/check.ts'
import { fero, op, internals } from '../proto/index.ts'

const code = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); return 'ok' } catch (e: any) { return e.code ?? String(e) } }

export const run = () => check('core-features', async (c) => {
  const [s1, s2, s3, cl] = c.procs('s1', 's2', 's3', 'client')
  const open = async (name: string, o: Record<string, unknown>) => { for (const s of [s1, s2, s3]) await s.fero(name, { server: true, ...o }); await c.settle(); return s1.fero(name) }
  // P-02: ttl and touch, removed by the writer with a reason
  const cache = await open('cache', { rows: { ttl: '10m' } })
  await cache.set('hot', { n: 1 }, { ttl: '30s' }); await cache.set('s', { v: 1 })
  const tail = cache.read({ from: 'latest' })[Symbol.asyncIterator]()
  await c.w.advance('31s')
  c.eq(cache.snapshot.hot, undefined, 'P-02 a row goes after its ttl')
  c.eq((await tail.next()).value.reason, 'ttl', 'P-02 the removal carries its reason')
  await c.w.advance('9m'); await cache.touch('s'); await c.w.advance('9m')
  c.eq(cache.snapshot.s, { v: 1 }, 'P-02 touch resets the ttl')
  // P-14: conditions and op bounds, refused with the current version
  const v = await cache.get('s', { version: true })
  c.eq(await code(() => cache.set('s', { v: 2 }, { if: { version: v.version } })), 'ok', 'if version (fresh)')
  c.eq(await code(() => cache.set('s', { v: 3 }, { if: { version: v.version } })), 'conflict', 'if version (stale)')
  c.eq(await code(() => cache.set('s', { v: 3 }, { if: { absent: true } })), 'conflict', 'if absent on a row')
  c.eq(await code(() => cache.set('n', op.incr(-1, { min: 0 }))), 'conflict', 'P-11 a bound is never crossed')
  c.eq(await code(() => cache.set(['nope', 'x'], 1)), 'absent-row', 'a field write to a missing row')
  c.eq(await code(() => cache.batch([{ key: 'x1', value: 1 }, { key: 'x2', value: 2 }])), 'cross-partition', 'a batch stays in one partition')
  // P-09 / P-22 building blocks: claim, lease, re-delivery, touch(lease), ack by version
  const q = await open('q', { partition: { before: '/' } })
  for (let i = 0; i < 3; i++) await q.set(`main/${i}`, { job: i })
  const got = await q.claim({ partition: 'main', n: 2, lease: '30s' })
  c.eq(got.map((g: any) => [g.key, g.deliveries]), [['main/0', 1], ['main/1', 1]], 'claim takes the oldest rows first')
  c.eq((await q.claim({ partition: 'main', n: 5, lease: '30s' })).map((g: any) => g.key), ['main/2'], 'a live lease is skipped')
  c.eq(await q.claim({ partition: 'main', n: 5, lease: '30s' }), [], 'an empty claim answers []')
  c.eq(await code(() => q.remove(got[0].key, { if: { version: got[0].token } })), 'ok', 'ack by the claim token')
  const ext = await q.touch(got[1].key, { lease: '60s', if: { version: got[1].token } })
  await c.w.advance('31s')
  c.eq((await q.claim({ partition: 'main', n: 5, lease: '30s' })).map((g: any) => [g.key, g.deliveries]), [['main/2', 2]], 'a lapsed lease re-delivers; an extended one holds (touch lease, API-NOTES C2)')
  await q.touch(got[1].key, { lease: 0, if: { version: ext.version } })
  c.eq((await q.claim({ partition: 'main', n: 5, lease: '30s' })).map((g: any) => [g.key, g.deliveries]), [['main/1', 2]], 'lease 0 ends it')
  // P-07: shares, history compaction, expired
  const st = await open('st', { rows: false, history: 10 })
  const saved = st.read({ from: 'latest' }); const cur = saved.cursor; saved.close()
  for (let i = 0; i < 200; i++) await st.set(`p${i % 20}`, { i })
  await c.settle()
  c.eq(await code(async () => { for await (const e of st.read({ from: cur })) void e }), 'expired', 'P-07 a cursor older than history: expired')
  // P-03: the near cache
  await cache.set('u1', { name: 'A' })
  await c.settle()   // a miss is served from a server's fold, which may trail another process's ack (only `fresh` is linearizable)
  const near = await cl.fero('cache', { cache: { memory: '1MB' } })
  c.eq(await code(async () => near.snapshot.u1), 'shortfall', 'P-03 a row not held throws shortfall')
  c.eq(await near.get('u1'), { name: 'A' }, 'P-03 a miss is one hop')
  c.eq(near.snapshot.u1, { name: 'A' }, 'P-03 then it is held')
  await cache.set('u1', { name: 'B' }); await c.settle()
  c.eq(near.snapshot.u1, { name: 'B' }, 'P-03 and followed')
  c.eq(await code(async () => Object.keys(near.snapshot)), 'holistic', 'P-03 enumerating a partial picture throws holistic')
  // follow: a snapshot of the selection, then deltas
  const f = cache.follow(['u1', 'u2']); await f.ready
  await cache.set('u2', { name: 'C' }); await cache.set('u3', { name: 'D' }); await c.settle()
  c.eq(Object.keys(f.snapshot()).sort(), ['u1', 'u2'], 'a follow holds exactly its partitions')
  // P-13: presence
  const online = await open('online', { rows: { while: 'session' } })
  await cl.run(async () => { await (await fero('online')).set('ada', { at: fero.now() }) })
  await c.settle()
  c.ok(online.snapshot.ada !== undefined, 'P-13 a live session keeps its row')
  c.w.kill('client')
  await c.w.advance('20s')
  c.eq(online.snapshot.ada, undefined, 'P-13 a lapsed session loses its row')
  // P-10: fences through #locks (the born version is the token, API-NOTES C6)
  const locks = internals.sys(c.w, s1, '#locks')
  const ledger = await open('ledger', {})
  const t1 = (await locks.set('payroll', { by: 'A' }, { if: { absent: true }, ttl: '10s' })).version
  await c.w.advance('11s')
  const t2 = (await locks.set('payroll', { by: 'B' }, { if: { expired: true }, ttl: '10s' })).version
  await c.settle()
  c.ok(t1 < t2, 'P-10 tokens rise and compare with <')
  c.eq(await code(() => ledger.set('r1', {}, { if: { fence: { lock: 'payroll', token: t1 } } })), 'fenced', 'P-10 an older token is fenced')
  c.eq(await code(() => ledger.set('r2', {}, { if: { fence: { lock: 'payroll', token: t2 } } })), 'ok', 'P-10 the current token writes')
  // methods: the door, keyed calls, live views
  let runs = 0
  const methods = {
    pay: async (n: number, ctx: any) => { runs++; await ctx.set(`pay:${ctx.key}`, { n }); return n },
    top: (n: number, ctx: any) => ctx.data.za('n', n),
  }
  for (const s of [s1, s2, s3]) await s.fero('bank', { methods })
  await c.settle()
  const [cl2] = c.procs('client2')
  const bank = await cl2.fero('bank')
  c.eq(await code(() => bank.set('x', { n: 1 })), 'methods-only', 'V4-5 the door')
  c.eq([await bank.methods.pay(5, { key: 'k1' }), await bank.methods.pay(5, { key: 'k1' }), runs], [5, 5, 1], 'TEST-03 a keyed call runs once')
  const live = bank.methods.top(1).open()
  await bank.methods.top(1)
  await (await s1.fero('bank')).set('big', { n: 50 }); await c.settle()
  c.eq(live.snapshot(), [{ n: 50 }], 'P-12 a live view streams to its caller')
  // P-04: read-through, one load per key
  let loads = 0
  for (const s of [s1, s2, s3]) await s.fero('prices', { load: async (sku: string) => { loads++; return { sku } } })
  await c.settle()
  await Promise.all([s1, s2, s3, cl2].map((p) => p.run(async () => (await fero('prices')).get('sku-1'))))
  c.eq(loads, 1, 'P-04 one load however many miss')
  // P-06: durability none answers at once
  const news = await open('news', { rows: false, durability: 'none' })
  const t0 = c.w.time; await news.set('sports', { h: 1 })
  c.ok(c.w.time - t0 < 5, 'P-06 a none write answers without a commit wait')
  // P-20: upcasters on replay and on held rows
  const users = await open('users', {})
  await users.set('u1', { name: 'Ada' })
  await fero.alter('users', { shape: { version: 2, up: { 1: (r: any) => (r.key.length === 1 && r.value ? { ...r, value: { name: { first: r.value.name } } } : r) } } })
  c.eq(users.snapshot.u1, { name: { first: 'Ada' } }, 'P-20 held rows pass the upcasters (API-NOTES C4)')
  // rows.max, the gate, lookup
  const lru = await open('lru', { rows: { max: 4 } })
  for (let i = 0; i < 40; i++) await lru.set(`k${i}`, { i })
  await c.settle()
  c.ok(Object.keys(lru.snapshot).length <= 4, 'rows.max is held')
  const ack = await lru.set('k', { i: 1 })
  c.eq((await lru.cluster.writes.lookup(ack.attempt)).state, 'committed', 'cluster.writes.lookup')
  await fero.alter('lru', { gate: 'maintenance' })
  c.eq(await code(() => lru.set('z', {})), 'read-only', 'the write gate')
}, { seeds: 20, chaos: false })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
