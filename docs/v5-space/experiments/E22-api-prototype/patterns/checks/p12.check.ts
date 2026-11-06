// P-12's check (REQUIREMENTS P-12): three servers hold `scores` over two groups; a screen client opens
// the server's live top-10 view. Scores are written and changed under a leader change and a move.
// After each wave: every server's top10 and every screen equal the query over the committed rows
// (sort by points, highest first, ten), and the per-room groups equal a direct grouping. A
// whole-resource view on a near-cache client throws 'holistic'.
import { check, report, isMain, servers, code, fero, sleep } from './common.ts'
import { server, screen } from '../p12-leaderboard.ts'

const top = (rows: Record<string, any>) => Object.values(rows).sort((a: any, b: any) => b.points - a.points).slice(0, 10)
export const run = () => check('p12-leaderboard', async (c) => {
  const outs: any[] = []
  for (const p of c.procs('s1', 's2', 's3')) outs.push(await p.run(() => server(() => {})))
  await c.settle()
  const scr = c.procs('screen')[0]
  const views = await scr.run(() => screen(() => {}))
  await views.fan.methods.top(10)                               // the first answer lands; the mirror is live from here
  c.chaos({ leaderChanges: 1, moves: 1, within: 40 })
  const w = await c.procs('s1')[0].fero('scores')
  for (let wave = 0; wave < 3; wave++) {
    for (let i = 0; i < 24; i++) { await w.set(`p${(i * 7 + wave * 5) % 30}`, { player: `p${i}`, room: `r${i % 3}`, points: ((i + 1) * (wave + 3) * 37) % 101 }); await sleep(1) }
    await c.w.advance('3s')
    const rows = outs[0].scores.snapshot
    const want = top(rows).map((r: any) => r.points)
    for (const o of outs) c.eq(o.top10.snapshot().map((r: any) => r.points), want, `wave ${wave}: a server's top10 equals the query`)
    c.eq(views.live.snapshot()?.map((r: any) => r.points), want, `wave ${wave}: the screen's live view equals the query`)
    const g: Record<string, string[]> = {}
    for (const [k, r] of Object.entries(rows) as [string, any][]) (g[r.room] ??= []).push(k)
    const got = Object.fromEntries(Object.entries(outs[1].perRoom.snapshot()).map(([room, m]: any) => [room, Object.keys(m).sort()]).sort())
    c.eq(got, Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.sort()]).sort()), `wave ${wave}: per-room groups`)
  }
  const near = await c.procs('n')[0].fero('scores', { cache: { memory: '1MB' } })
  c.eq(await code(async () => near.data.za('points', 10)), 'holistic', 'a whole-resource view on a near cache throws holistic')
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
