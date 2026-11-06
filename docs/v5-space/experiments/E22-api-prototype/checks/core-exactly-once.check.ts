// The core's exactly-once check (P-11's promise, on the kernel and L2 alone): two clients and a
// server add 1 to four counters, 60 times in all, while the schedule changes leaders (losing
// uncommitted tails), moves one slot, and drops 5% of messages for a while (so acks are lost and
// attempts are resent). Every acknowledged incr counts once: the final sum equals the acks, and
// each ack's value is a distinct count of its key. The fsync range is wide on purpose: a follower
// then often holds an entry the old leader had not counted, so a resend can find its attempt still
// in the new leader's uncommitted tail (the 'from the tail' dedup path).
import { check, report, isMain } from '../proto/check.ts'
import { fero, op } from '../proto/index.ts'

export const run = () => check('core-exactly-once', async (c) => {
  const [s1, s2, s3, a, b] = c.procs('s1', 's2', 's3', 'a', 'b')
  for (const s of [s1, s2, s3]) await s.run(() => fero('views', { server: true }))
  await c.settle()
  c.chaos({ leaderChanges: 3, moves: 1, within: 30 })
  c.w.faults([{ at: c.w.time, do: 'drop', p: 0.05 }, { at: c.w.time + 30, do: 'drop', p: 0 }])
  const keys = ['page:/', 'page:/a', 'page:/b', 'page:/c']
  const acks: Record<string, number[]> = {}
  let unknown = 0
  const go = (p: typeof a, n: number) => p.run(async () => {
    const views = await fero<number>('views')
    for (let i = 0; i < n; i++) {
      const k = keys[i % keys.length]
      try { const ack = await views.set(k, op.incr(1)); (acks[k] ??= []).push(ack.value as number) }
      catch (e: any) { if (e.outcome === 'unknown') unknown++; else throw e }
    }
  })
  await Promise.all([go(a, 25), go(b, 25), go(s1, 10)])
  await c.settle()
  const views = await s2.run(() => fero('views'))
  for (const k of keys) {
    const got = acks[k] ?? []
    const final = views.snapshot[k] ?? 0
    // with no unknown outcomes, the count is exactly the acks; each ack saw its own number
    if (unknown === 0) c.eq(final, got.length, `${k}: final count equals acknowledged incrs`)
    else c.ok(final >= got.length && final <= got.length + unknown, `${k}: ${final} within acks ${got.length} + unknown ${unknown}`)
    c.eq(new Set(got).size, got.length, `${k}: no two acks report the same count`)
  }
  c.note(`unknown outcomes: ${unknown}`)
}, { seeds: 200, world: { fsync: [0.1, 3] } })   // a slow leader fsync lets a follower hold an entry the leader has not counted

if (isMain(import.meta.url)) report(await run(), import.meta.url)
