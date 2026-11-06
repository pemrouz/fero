// P-06's check (REQUIREMENTS P-06): three current subscribers, ten messages on one subject under a
// leader change and a move. `persisted` (odd seeds): every subscriber gets every message, in order.
// `none` (even seeds): best effort: what a subscriber gets is in order with no duplicate; losses are
// counted. Not built: `gaps` (API-NOTES A).
import { check, report, isMain, servers, sleep } from './common.ts'
import { open, subscriber, publish } from '../p06-pubsub.ts'

export const lost = { none: 0, persisted: 0, runs: { none: 0, persisted: 0 } }
export const run = () => check('p06-pubsub', async (c) => {
  const dura = c.seed % 2 === 1 ? 'persisted' : 'none'
  await servers(c, 3, () => open(dura))
  const subs = c.procs('x', 'y', 'z')
  const got: unknown[][] = [[], [], []]
  const readers = await Promise.all(subs.map((p, i) => p.run(() => subscriber(got[i]))))
  c.chaos({ leaderChanges: 1, moves: 1, within: 15 })
  const sent: string[] = []
  await c.procs('pub')[0].run(async () => { for (let i = 0; i < 10; i++) { const h = `h${i}`; try { await publish(h); sent.push(h) } catch { /* a none write may time out */ } await sleep(1) } })
  await c.w.advance('5s')
  for (const r of readers) r.close()
  lost.runs[dura]++
  for (const g of got) {
    const hs = g.map((x: any) => x.headline)
    const idx = hs.map((h) => Number(h.slice(1)))
    c.ok(idx.every((v, i) => i === 0 || v > idx[i - 1]), `${dura}: in order, no duplicate (${hs})`)
    if (dura === 'persisted') c.eq(hs, sent, 'persisted: every subscriber gets every message')
    lost[dura] += sent.filter((h) => !hs.includes(h)).length
  }
}, { seeds: 60 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  console.log(`  messages a subscriber missed: none ${lost.none} over ${lost.runs.none} runs (x3 subscribers x10), persisted ${lost.persisted} over ${lost.runs.persisted}`)
}
