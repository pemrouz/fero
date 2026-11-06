// P-16's check (REQUIREMENTS P-16): a live projection (a reader from the start, beside the writer) and
// a rebuild from 'earliest' on another process equal each other byte for byte, after 40 facts under
// leader changes and a move; history 'all' never drops a record (no group compacts).
import { check, report, isMain, servers, fero, sleep } from './common.ts'
import { record, rebuild } from '../p16-event-sourcing.ts'

export const run = () => check('p16-event-sourcing', async (c) => {
  const [s1] = await servers(c, 3, () => fero('facts', { server: true, rows: false, history: 'all' }))
  const live = new Map<string, number>()
  const lp = c.procs('live')[0]
  const reader = await lp.run(async () => (await fero('facts')).read({ from: 'earliest' }))
  void (async () => { for await (const e of reader) if (e.row) live.set(e.row.account, (live.get(e.row.account) ?? 0) + e.row.cents) })()
  c.chaos({ leaderChanges: 2, moves: 1, within: 80 })
  for (let i = 0; i < 40; i++) { await s1.run(() => record(`acct:${['alice', 'bob', 'cy'][i % 3]}`, { account: ['alice', 'bob', 'cy'][i % 3], cents: (i * 37) % 500 - 100 })); await sleep(1) }
  await c.settle()
  const rebuilt = await c.procs('new')[0].run(() => rebuild(40))
  reader.close()
  const order = (m: Map<string, number>) => JSON.stringify([...m].sort())
  c.eq(order(rebuilt), order(live), 'the rebuilt projection equals the live one')
  c.ok(c.stack.k.meta('facts')!.groups.every((g: any) => g.base === 0), "history 'all' kept every record")
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
