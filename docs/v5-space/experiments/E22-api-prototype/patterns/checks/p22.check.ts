// P-22's check (REQUIREMENTS P-22): the example enqueues a delayed, a cron and a priority-0 message;
// the waiting take gets the priority one first. A second waiting take on an empty queue appends
// nothing while it waits, and is woken by an enqueue within a few ms of its commit. The delayed
// message is never claimed before its time by writer time (from the log), across a leader change
// and a writer clock skewed by 200 ms; the cron message comes due at 06:00 UTC and its ack re-adds
// the next day's.
import { check, report, isMain, servers, committed, sleep } from './common.ts'
import { enqueue, consume } from '../p22-delayed.ts'
import { queue } from '../lib/index.ts'

export const wake: number[] = []
export const run = () => check('p22-delayed', async (c) => {
  await servers(c, 3, () => queue('mail'))
  const [p, q] = c.procs('p', 'q')
  c.w.faults([{ at: c.w.time + 1, do: 'skew', proc: `s${1 + (c.seed % 3)}`, by: (c.seed % 2 ? 1 : -1) * 200 }])
  c.chaos({ leaderChanges: 1, moves: 1, within: 10 })
  await p.run(enqueue)
  const sent: string[] = []
  const m1 = await q.run(() => consume(async (to) => { sent.push(to) }))
  c.eq(m1?.job.to, 'vip@x.io', 'the priority-0 message is taken first')
  // a waiting take on an empty queue: nothing appended while it waits, woken by an enqueue
  const mail = await q.run(() => queue<{ to: string }>('mail'))
  // what the waiting process itself appends (a new leader's no-op or a ttl removal is not the take's)
  const app = () => c.stack.k.meta('mail')!.groups.reduce((n: number, g: any) => n + g.log.filter((e: any) => e.a?.startsWith(q.session + ':')).length, 0)
  const before = app()
  const waiting = q.run(() => mail.take(1, { wait: '20s', partitions: ['later'] }))
  await c.w.advance('5s')
  c.eq(app(), before, 'a waiting take appends nothing')
  let tAck = 0
  const prod = await p.run(() => queue<{ to: string }>('mail'))
  await p.run(async () => { await prod.add({ to: 'late@x.io' }, { partition: 'later' }); tAck = c.w.time })
  const [m2] = await waiting
  wake.push(c.w.time - tAck)
  c.eq(m2?.job.to, 'late@x.io', 'the waiting take got the new message')
  c.ok(c.w.time - tAck <= 5, `woken ${(c.w.time - tAck).toFixed(2)} ms after the enqueue's ack`)
  await m2.ack()
  // the delayed message: not before its time by writer time
  c.w.faults([{ at: c.w.time + 10 * 60_000, do: 'leader-change', res: 'mail' }])
  const t15 = (await q.run(async () => { const xs = await mail.take(1, { wait: '16m' }); return xs }))
  c.eq(t15[0]?.job.to, 'ada@x.io', 'the delayed message comes after 15 minutes')
  const at = committed(c, 'mail').find((e: any) => e.recs.some((r: any) => r.value?.job?.to === 'ada@x.io'))!.recs[0].value.at
  const claimT = t15[0].until - 30_000
  c.ok(claimT >= at, `never claimed before its time by writer time (claimed ${(claimT - at).toFixed(1)} ms after)`)
  await t15[0].ack()
  // the cron message: due at 06:00 UTC; its ack re-adds the next day's
  await c.w.advance(6 * 3_600_000 - c.w.time + 1000)
  const [cr] = await q.run(() => mail.take(1, { wait: '1s' }))
  c.eq(cr?.id, 'daily-report', 'the cron message is due at 06:00')
  await cr.ack()
  await c.settle()
  const rows = Object.entries((await p.fero('mail')).snapshot) as [string, any][]
  c.eq(rows.map(([k, v]) => [k.replace(/\d+$/, 'T'), v.at - 30 * 3_600_000]), [['main/daily-report@T', 0]], 'and the next one is due tomorrow at 06:00')
  void sleep
}, { seeds: 40 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  a waiting take woke ${Math.max(...wake).toFixed(2)} ms (max) after the enqueue was acknowledged`) }
