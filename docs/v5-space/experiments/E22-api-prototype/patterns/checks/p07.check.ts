// P-07's check (REQUIREMENTS P-07): a reader that stops at seeded points and resumes from the cursor
// it saved gets every committed record of its partitions once, in order per partition, across
// leader changes and a move; past `history` a saved cursor is refused 'expired' with the earliest.
import { check, report, isMain, servers, committed, code, fero, sleep } from './common.ts'
import { writer, replay } from '../p07-stream.ts'

export const run = () => check('p07-stream', async (c) => {
  const [s1] = await servers(c, 3, () => fero('events', { server: true, rows: false, history: '7d' }))
  const rd = c.procs('rd')[0]
  let saved: any
  const first = await rd.run(async () => { const r = (await fero('events')).read({ from: 'latest' }); const k = r.cursor; r.close(); return k })
  saved = first
  c.chaos({ leaderChanges: 2, moves: 1, within: 60, res: 'events' })
  const prod = s1.run(async () => { for (let i = 0; i < 40; i++) { await writer(`order:${i % 8}`, { type: 'paid', cents: i }); await sleep(1) } })
  const seen: any[] = []
  for (let k = 0; k < 40;) {
    const n = 1 + ((c.seed * 7 + k) % 6)
    await rd.run(() => replay(saved, (x) => { saved = x }, Math.min(n, 40 - k), seen))
    k += Math.min(n, 40 - k)
  }
  await prod
  await c.settle()
  const per = (xs: [string, number][]) => { const m: Record<string, number[]> = {}; for (const [p, v] of xs) (m[p] ??= []).push(v); return Object.fromEntries(Object.entries(m).sort()) }
  const want = per(committed(c, 'events').filter((e: any) => e.k === 'w').map((e: any) => [e.p, e.recs[0].value.cents]))
  c.eq(per(seen.map(([p, , v]: any) => [p, v.cents])), want, 'every record of every partition once, in order')
  // retention: a week on, after more writes, the first cursor is expired with the earliest kept
  await c.w.advance('8d')
  for (let i = 0; i < 200; i++) await s1.run(() => writer(`order:${i % 8}`, { type: "late", cents: i }))   // a group compacts past 64 entries
  await c.settle()
  let earliest: any
  const got = await code(() => rd.run(async () => { try { await replay(first, () => {}, 1, []) } catch (e: any) { earliest = e.earliest; throw e } }))
  c.eq(got, 'expired', 'a cursor older than history is refused expired')
  const again: any[] = []
  await rd.run(() => replay(earliest, () => {}, 5, again))
  c.eq(again.length, 5, 'and the earliest kept cursor reads on')
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
