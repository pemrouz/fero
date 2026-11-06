// P-14's check, and Q-22's check-then-set question. Three servers hold `stock`. Each seed races two
// calls at once, each run on a chosen server (a local call runs where it is called): on the writer
// of the row's group, or on another server. The API's `sell` (an op) and `reprice` (a condition)
// must allow exactly one winner wherever they run. A naive check-then-set (read the fold, then a
// plain set) is counted, not required: how often both callers "sell" the last item.
import { check, report, isMain } from '../proto/check.ts'
import { stockServer } from '../examples/p14-invariants.ts'

const naive = {
  sellNaive: async (sku: string, ctx: any) => {
    const row = await ctx.get(sku)                          // the server's own fold: may trail the writer
    if (row.left <= 0) throw new Error('sold out')
    await ctx.set(sku, { ...row, left: row.left - 1 })      // no condition
    return row.left - 1
  },
}
const pairs = ['writer+writer', 'writer+other', 'other+other'] as const
export const tally: Record<string, { races: number; double: number }> = Object.fromEntries(pairs.map((p) => [p, { races: 0, double: 0 }]))

export const run = () => check('p14-invariants', async (c) => {
  const [s1, s2, s3] = c.procs('s1', 's2', 's3')
  const seed = { a: { left: 1, price: 5 }, b: { left: 1, price: 5 }, c: { left: 1, price: 5 }, d: { left: 1, price: 5 } }
  const hs = [await s1.run(() => stockServer(seed, naive)), await s2.run(() => stockServer(seed, naive)), await s3.run(() => stockServer(seed, naive))]
  await c.settle()
  const st = c.stack
  const writerOf = (sku: string) => st.k.groupOf(st.k.meta('stock')!, st.k.slotOf(sku)).leader
  const pick = (sku: string, where: 'writer' | 'other', not?: number): number => {
    const w = writerOf(sku)
    const i = ['s1', 's2', 's3'].findIndex((x, j) => (where === 'writer' ? x === w : x !== w && j !== not))
    return i
  }
  const race = async (sku: string, kind: (typeof pairs)[number], method: string, args: [unknown, unknown]) => {
    while (writerOf(sku) === null) await c.w.advance(50)    // an election is on: wait for the writer
    const [x, y] = kind.split('+') as ('writer' | 'other')[]
    const i = pick(sku, x), j = pick(sku, y, x === 'other' ? i : undefined)
    return Promise.allSettled([hs[i].methods[method](args[0]), hs[j].methods[method](args[1])])
  }
  const kind = pairs[c.seed % 3]
  c.chaos({ leaderChanges: 1, moves: 1, within: 4 })
  // the API's op: exactly one sale of the last item, wherever the two calls run
  const sells = await race('a', kind, 'sell', ['a', 'a'])
  c.eq(sells.filter((r) => r.status === 'fulfilled').length, 1, `${kind}: exactly one sell of the last item`)
  // the API's conditioned check-then-set: no lost update
  const re = await race('b', kind, 'reprice', [{ sku: 'b', price: 7 }, { sku: 'b', price: 9 }])
  await c.settle()
  const price = (await hs[0].get('b', { fresh: true })).price
  const won = re.filter((r) => r.status === 'fulfilled').length
  c.ok(won >= 1 && [7, 9].includes(price), `${kind}: a reprice landed (price ${price}, ${won} ok)`)
  for (const r of re) if (r.status === 'rejected') c.ok(/conflict/.test(String(r.reason?.reason ?? r.reason)), `${kind}: the losing reprice is a conflict`)
  // the naive check-then-set: counted
  const nv = await race('c', kind, 'sellNaive', ['c', 'c'])
  tally[kind].races++
  if (nv.filter((r) => r.status === 'fulfilled').length === 2) tally[kind].double++
}, { seeds: 99 })

if (isMain(import.meta.url)) {
  const r = await run()
  report(r, import.meta.url)
  for (const p of pairs) console.log(`  naive check-then-set, ${p}: both callers sold the last item in ${tally[p].double} of ${tally[p].races} races`)
}
