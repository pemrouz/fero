// P-04's check (REQUIREMENTS P-04): 1 load per key however many readers miss at once (six readers on
// three servers and three clients), and a write that lands during the load wins. The db stand-in
// answers after 50 ms of virtual time (a fake timer). A leader change and a move land in the work.
import { check, report, isMain, servers, sleep, fero } from './common.ts'
import { server, reader } from '../p04-read-through.ts'

export const run = () => check('p04-read-through', async (c) => {
  let loads = 0
  const db = { price: async (sku: string) => { loads++; await sleep(50); return { sku, cents: 100 } } }
  const ss = await servers(c, 3, () => server(db))
  const rs = [...ss, ...c.procs('a', 'b', 'c')]
  c.chaos({ leaderChanges: 1, moves: 1, within: 30 })
  const race = c.seed % 2 === 0                                  // even seeds: a write lands during the load
  const writer = race ? c.procs('w')[0].run(async () => { await sleep(10); await (await fero('prices')).set('sku-1', { sku: 'sku-1', cents: 999 }) }) : null
  const got = await Promise.all(rs.map((p) => p.run(() => reader(() => {}))))
  await writer
  await c.settle()
  c.eq(loads, 1, 'one load however many readers miss')
  const want = race ? 999 : 100
  c.eq((await ss[1].run(async () => (await fero('prices')).get('sku-1', { fresh: true }))).cents, want, race ? 'a write during the load wins' : 'the loaded row is written')
  c.ok(got.every((x: any) => x === undefined || x.cents === 100 || x.cents === 999), `every reader got a value of the row (${got.map((x: any) => x?.cents)})`)
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
