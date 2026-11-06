// The core's log-reader check (P-07's promise): a writer appends numbered events to 12 partitions
// while the schedule changes leaders and moves a slot. A reader on a client reads from 'earliest'
// live, beside the writer, and stops at seeded points, saving its cursor; a new reader resumes from it. Per partition, the
// records read are exactly the acknowledged ones, once each, in order: no gap, no repeat.
import { check, report, isMain } from '../proto/check.ts'
import { fero } from '../proto/index.ts'

export const run = () => check('core-reader', async (c) => {
  const [s1, s2, s3, wr, rd] = c.procs('s1', 's2', 's3', 'writer', 'reader')
  for (const s of [s1, s2, s3]) await s.run(() => fero('events', { server: true, rows: false, history: 'all' }))
  await c.settle()
  c.chaos({ leaderChanges: 2, moves: 1, within: 40 })
  const parts = Array.from({ length: 12 }, (_, i) => `order:${i}`)
  const acked: Record<string, number[]> = {}
  const writing = wr.run(async () => {
    const events = await fero('events')
    for (let i = 0; i < 120; i++) {
      const p = parts[c.w.rng.int(parts.length)]
      await events.set(p, { i })
      ;(acked[p] ??= []).push(i)
    }
  })
  // the reader runs live, beside the writer and the faults
  const got: Record<string, number[]> = {}
  const reading = rd.run(async () => {
    const events = await fero('events')
    let cursor: string = 'earliest'
    let total = 0
    while (total < 120) {
      const r = events.read({ from: cursor })
      const stopAt = 1 + c.w.rng.int(40)
      let n = 0
      for await (const e of r) {
        ;(got[e.partition] ??= []).push((e.rec.value as { i: number }).i)
        total++
        if (++n >= stopAt || total >= 120) break
      }
      cursor = r.cursor
    }
  })
  await Promise.all([writing, reading])
  for (const p of parts) c.eq(got[p] ?? [], acked[p] ?? [], `${p}: read exactly the acked records, in order`)
}, { seeds: 100 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
