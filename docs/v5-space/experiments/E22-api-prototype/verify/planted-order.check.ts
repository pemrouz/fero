// TEST-12's planted app: an app that leans on order across partitions must fail under the shuffle.
// A writer adds a document, then (after its ack) points `latest` at it. A server's tap reads the
// pointer and then the document it names, synchronously, from its snapshot. Two forms:
//   planted (ORDER_VARIANT=planted, the default): the document and the pointer are different
//            partitions, so nothing promises the document is there when the pointer arrives;
//   fixed   (ORDER_VARIANT=fixed): both rows sit in one partition (`partition: { before: '/' }`),
//            whose order every copy keeps.
// The check counts taps that found the pointer but not its document, and asserts there are none.
import { check, report, isMain, servers, fero } from '../patterns/checks/common.ts'

const variant = process.env.ORDER_VARIANT ?? 'planted'
export const tally = { broken: 0, seedsBroken: 0, taps: 0 }

export const run = () => check(`order-${variant}`, async (c) => {
  const opts = variant === 'fixed' ? { server: true, partition: { before: '/' } } : { server: true }
  const [, , s3] = await servers(c, 3, async () => { await fero('docs', opts) })
  const key = (id: string): string => (variant === 'fixed' ? `feed/${id}` : id)
  let broken = 0
  await s3.run(async () => {
    const docs = await fero('docs')
    docs.data.tap(() => {
      tally.taps++
      const l = docs.snapshot[key('latest')]
      if (l && docs.snapshot[key(l.id)] === undefined) broken++
    })
  })
  c.chaos({ leaderChanges: 1, moves: 1, within: 30 })
  await c.procs('w')[0].run(async () => {
    const docs = await fero('docs')
    for (let i = 0; i < 20; i++) {
      await docs.set(key(`doc${i}`), { body: `text ${i}` })
      await docs.set(key('latest'), { id: `doc${i}` })
    }
  })
  await c.settle()
  tally.broken += broken
  if (broken > 0) tally.seedsBroken++
  c.eq(broken, 0, 'a tap that read the pointer found the document it names')
}, { seeds: 100 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  ${JSON.stringify(tally)}`) }
