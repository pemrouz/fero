// P-09's check (REQUIREMENTS P-09): 20 jobs and one poison job; three workers, one killed mid-job and
// one paused 40 s (past the 30 s lease: a zombie), leader changes and a move. From the log: every
// job is acked exactly once (one removal) or dead-lettered after 5 deliveries; never two live leases
// (each claim starts at or after the previous lease's end, by writer time); first deliveries in add
// order (FIFO); none lost; an empty take appends nothing.
import { check, report, isMain, servers, committed, fero, sleep } from './common.ts'
import { producer, worker } from '../p09-queue.ts'
import { queue } from '../lib/index.ts'

export const run = () => check('p09-queue', async (c) => {
  await servers(c, 3, () => queue('thumbs', { lease: '30s', deliveries: 5 }))
  const urls = [...Array.from({ length: 20 }, (_, i) => `u${i}.png`), 'bad.png']
  const done: string[] = []
  const resize = async (url: string) => { if (url === 'bad.png') throw new Error('poison'); await sleep(40); done.push(url); return url }
  await c.procs('prod')[0].run(() => producer(urls))
  c.chaos({ leaderChanges: 2, moves: 1, within: 300 })
  const ws = c.procs('w1', 'w2', 'w3')
  const runners = await Promise.all(ws.map((p) => p.run(() => worker(resize))))
  c.w.faults([{ at: c.w.time + 20 + (c.seed % 60), do: 'kill', proc: 'w2' }, { at: c.w.time + 10 + (c.seed % 50), do: 'pause', proc: 'w3', for: 40_000 }])
  await c.w.advance('4m')
  for (const r of [runners[0]]) await r.stop()
  await c.settle()
  const log = committed(c, 'thumbs')
  const removed: Record<string, number> = {}, firstClaim: string[] = [], adds: string[] = []
  const leaseEnd: Record<string, number> = {}
  for (const e of log) {
    for (const r of e.recs) { const k = String(r.key[0]); if (r.type === 2) removed[k] = (removed[k] ?? 0) + 1; else if (e.m?.born?.includes(k)) adds.push(k) }
    for (const [k, [until]] of Object.entries((e.m?.claims ?? {}) as Record<string, [number, number]>)) {
      if (e.m?.ans?.rows) { c.ok(e.t >= (leaseEnd[k] ?? 0), `${k}: claimed at ${e.t} while a lease ran to ${leaseEnd[k]}`); if (!firstClaim.includes(k)) firstClaim.push(k) }
      leaseEnd[k] = until
    }
  }
  const dead = await c.procs('s1')[0].fero('thumbs.dead')
  const deadRows = Object.values(dead.snapshot) as any[]
  c.eq(deadRows.map((r) => [r.job.url, r.deliveries]), [['bad.png', 5]], 'the poison job is dead-lettered after 5 deliveries')
  for (const k of adds) c.eq(removed[k] ?? 0, 1, `${k}: removed exactly once (acked or moved to dead)`)
  for (const u of urls.slice(0, 20)) c.ok(done.includes(u), `${u} resized at least once`)
  c.eq(firstClaim, adds.filter((k) => firstClaim.includes(k)), 'first deliveries in add order')
  const q = await c.procs('s1')[0].run(() => queue('thumbs'))
  const before = c.stack.k.meta('thumbs')!.groups.reduce((n: number, g: any) => n + g.last, 0)
  c.eq(await q.take(5), [], 'the queue is empty')
  c.eq(c.stack.k.meta('thumbs')!.groups.reduce((n: number, g: any) => n + g.last, 0), before, 'an empty take appends nothing')
  await runners[2].stop().catch(() => {})
}, { seeds: 40 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
