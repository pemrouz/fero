// Q-22's check-then-set question, from clients. Three servers hold `stock` (2 groups). Two CLIENTS
// call one method at once; a client's call runs on the server it reached, which is the writer of the
// row's group, or not. Each race picks clients so that both calls run on the writer, one does, or
// neither. Forms: `naive` (read the fold, plain set), `fresh` (a linearizable read, then a plain set),
// `cond` (read with its version, set if unchanged: API.md's), `op` (incr with min 0: API.md's), and
// `serial`: naive, but run on the writer one call at a time per row (Q-A8's `at: 'writer'`, built in
// the check), with a leader change inside the race in odd seeds. Counted: both callers sold the last one.
import { check, report, isMain, op, fero } from './common.ts'
import { boundWorld, type Proc } from '../../proto/world.ts'

const lockOn = new Map<string, Promise<void>>()   // the serial form's per-row queue, on the server that runs it
const serialRun = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = lockOn.get(key) ?? Promise.resolve()
  let done!: () => void
  lockOn.set(key, new Promise<void>((r) => { done = r }))
  await prev
  try { return await fn() } finally { done() }
}
const methods = {
  naive: async (k: string, ctx: any) => { const r = await ctx.get(k); if (r.left <= 0) throw new Error('sold out'); await ctx.set(k, { ...r, left: r.left - 1 }); return r.left - 1 },
  fresh: async (k: string, ctx: any) => { const r = await ctx.get(k, { fresh: true }); if (r.left <= 0) throw new Error('sold out'); await ctx.set(k, { ...r, left: r.left - 1 }); return r.left - 1 },
  cond: async (k: string, ctx: any) => { const r = await ctx.get(k, { version: true }); if (r.value.left <= 0) throw new Error('sold out'); await ctx.set(k, { ...r.value, left: r.value.left - 1 }, { if: { version: r.version } }); return r.value.left - 1 },
  op: async (k: string, ctx: any) => (await ctx.set([k, 'left'], op.incr(-1, { min: 0 }))).value,
  serial: (k: string, ctx: any) => serialRun(`${boundWorld()!.current().id}:${k}`, () => methods.naive(k, ctx)),   // one at a time per row, on this server
  // the same, with 3 s of work between the read and the write (a slow handler at the writer)
  slow: (k: string, ctx: any) => serialRun(`${boundWorld()!.current().id}:${k}`, async () => {
    const r = await ctx.get(k); if (r.left <= 0) throw new Error('sold out')
    await new Promise((res) => setTimeout(res, 3000))
    await ctx.set(k, { ...r, left: r.left - 1 }); return r.left - 1
  }),
}
export const slow = { races: 0, double: 0 }
const forms = ['naive', 'fresh', 'cond', 'op', 'serial'] as const
const places = ['writer+writer', 'writer+other', 'other+other'] as const
export const tally: Record<string, { races: number; double: number; faulted: number; dfault: number }> = {}

export const run = () => check('cts-check-then-set', async (c) => {
  const ss = c.procs('s1', 's2', 's3')
  const seed: Record<string, { left: number }> = {}
  for (const f of [...forms, 'slow']) seed[f] = { left: 1 }
  for (const s of ss) await s.run(() => fero('stock', { methods, data: seed }))
  await c.settle()
  const st = c.stack
  const meta = st.k.meta('stock')!
  const clients = c.procs(...Array.from({ length: 24 }, (_, i) => `c${i}`))
  const servedBy = (p: Proc): string => { const xs = [...meta.servers]; return xs[fnv(p.id + '/stock') % xs.length] }
  const place = places[c.seed % 3]
  const faulted = c.seed % 2 === 1
  if (faulted) c.chaos({ leaderChanges: 1, moves: 0, within: 3, res: 'stock' })
  const races = forms.map(async (f) => {
    while (st.k.groupOf(meta, st.k.slotOf(f)).leader === null) await c.w.advance(50)
    const writer = st.k.groupOf(meta, st.k.slotOf(f)).leader
    const want = f === 'serial' ? [true, true] : place.split('+').map((x) => x === 'writer')
    const pick: Proc[] = []
    for (const onWriter of want) pick.push(clients.find((p) => !pick.includes(p) && (servedBy(p) === writer) === onWriter)!)
    const outs = await Promise.allSettled(pick.map((p) => p.run(async () => (await fero('stock')).methods[f](f))))
    const ok = outs.filter((o) => o.status === 'fulfilled').length
    const t = (tally[`${f} ${place}`] ??= { races: 0, double: 0, faulted: 0, dfault: 0 })
    t.races++; if (ok === 2) t.double++
    if (faulted) { t.faulted++; if (ok === 2) t.dfault++ }
    if (f === 'cond' || f === 'op') c.ok(ok <= 1, `${f} ${place}: at most one sale of the last item (${ok})`)
  })
  await Promise.all(races)
  // serial at the writer across a failover: a slow call runs on the writer; the writer's group
  // fails over; a second call reaches the NEW writer while the first still works (Q-A8's at: writer)
  {
    const g = st.k.groupOf(meta, st.k.slotOf('slow'))
    while (g.leader === null) await c.w.advance(50)
    const w0 = g.leader
    const first = clients.find((p) => servedBy(p) === w0)!
    const call = (p: Proc) => p.run(async () => (await fero('stock')).methods.slow('slow')).then(() => 1, () => 0)
    const one = call(first)
    c.w.faults([{ at: c.w.time + 5, do: 'leader-change', res: 'stock', group: g.n }])
    await c.w.advance(5)
    while (g.leader === null || g.leader === w0) await c.w.advance(20)
    const second = clients.find((p) => p !== first && servedBy(p) === g.leader)!
    const n = (await Promise.all([one, call(second)])).reduce((a: number, b: number) => a + b, 0)
    slow.races++; if (n === 2) slow.double++
  }
}, { seeds: 120 })
const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  console.log(`  serial at the writer, a slow call across a failover: both sold the last item in ${slow.double} of ${slow.races} races`)
  for (const f of forms) console.log(`  ${f.padEnd(6)} ${places.map((p) => { const t = tally[`${f} ${p}`]; return `${p} ${t.double}/${t.races} (${t.dfault}/${t.faulted} with a leader change)` }).join('; ')}`)
}
