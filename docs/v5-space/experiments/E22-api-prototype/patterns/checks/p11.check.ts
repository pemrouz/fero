// P-11's check (REQUIREMENTS P-11): three clients run the example at once under leader changes, a
// move and 5% message loss: the counter ends at the number of acknowledged incrs and the acks report
// distinct counts. A limiter of 5 a minute, raced by 12 takes from three processes in one window:
// exactly 5 pass, the rest are 'limited' with retryAfter, and the refusals append nothing.
import { check, report, isMain, servers, appended, code, fero } from './common.ts'
import { p11 } from '../p11-counters.ts'
import { limiter } from '../lib/index.ts'

export const run = () => check('p11-counters', async (c) => {
  await servers(c, 3, async () => { await fero('views', { server: true }); await fero('api', { server: true }); await fero('api5', { server: true }) })
  c.chaos({ leaderChanges: 2, moves: 1, within: 6 })
  c.w.faults([{ at: c.w.time, do: 'drop', p: 0.05 }, { at: c.w.time + 2000, do: 'drop', p: 0 }])
  const rs = await Promise.all(c.procs('a', 'b', 'c').map((p) => p.run(() => p11(() => {}))))
  await c.settle()
  const views = await c.procs('s1')[0].fero('views')
  c.eq(views.snapshot['page:/'], 3, 'three acknowledged incrs, counted once each')
  c.eq(rs.map((r) => r.a.value).sort(), [1, 2, 3], 'each ack reports the count it made')
  c.ok(rs.every((r) => r.left >= 97 && r.left <= 99), 'the limiter counted each take')
  // the limiter at its bound, inside one window
  await c.w.advance(60_000 - (c.w.time % 60_000) + 1000)
  const before = appended(c, 'api5')
  const outs = (await Promise.all(c.procs('a', 'b', 'c').flatMap((p) => [0, 1, 2, 3].map(() => p.run(async () => {
    const api = await limiter('api5', { max: 5, per: '1m' })
    try { await api.take('user:42'); return 'ok' } catch (e: any) { return e.retryAfter > 0 ? e.code : `${e.code} without retryAfter` }
  }))))).sort()
  c.eq(outs, [...Array(5).fill('ok'), ...Array(7).fill('limited')].sort(), 'exactly 5 of 12 pass')
  c.eq(appended(c, 'api5') - before, 5, 'a refused take appends nothing')
  void code
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
