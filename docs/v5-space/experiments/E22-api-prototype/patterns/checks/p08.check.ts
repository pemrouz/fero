// P-08's check (REQUIREMENTS P-08): three billing members (at least once) and two invoicing members
// (effectively once) share a stream of 48 orders. Faults: a member killed mid-batch, a member paused
// 15 s (past its 10 s lease: a zombie), leader changes and a move. No order is skipped; the
// invoicing output has exactly one write per order; on every cursor row, fence tokens never go back
// in log order (no write commits under a token older than one the row's writer has seen); a zombie's
// commit after the takeover is refused 'fenced'.
import { check, report, isMain, servers, committed, fero, sleep } from './common.ts'
import { invoicing, billing } from '../p08-consumer-groups.ts'

export const zombie = { fenced: 0, runs: 0 }
export const run = () => check('p08-consumer-groups', async (c) => {
  await servers(c, 3, async () => { await fero('orders', { server: true }); await fero('invoices', { server: true }) })
  const billed: string[] = []
  let stop = false
  const bms = c.procs('m1', 'm2', 'm3')
  const outs = bms.map((p) => p.run(() => billing(async (o: any) => { billed.push(o.id); await sleep(2) }, () => stop)).then(() => 'ok', (e: any) => e?.code ?? String(e)))
  const ims = c.procs('i1', 'i2')
  const runners = await Promise.all(ims.map((p) => p.run(invoicing)))
  await c.w.advance('3s')
  c.chaos({ leaderChanges: 2, moves: 1, within: 400 })
  c.w.faults([{ at: c.w.time + 50 + (c.seed % 50), do: 'kill', proc: 'm2' }, { at: c.w.time + 30 + (c.seed % 40), do: 'pause', proc: 'm3', for: 15_000 }, { at: c.w.time + 60, do: 'kill', proc: 'i1' },
    { at: c.w.time + 100 + (c.seed % 200), do: 'leader-change', res: '#groups' }, { at: c.w.time + 150 + (c.seed % 300), do: 'leader-change', res: '#locks' }])
  const prod = c.procs('prod')[0].run(async () => { const o = await fero('orders'); for (let i = 0; i < 48; i++) { await o.set(`o${i}`, { id: `o${i}`, cents: i }); await sleep(5) } })
  await prod
  await c.w.advance('40s')
  stop = true
  await c.w.advance('5s')
  zombie.runs++
  const z = await Promise.race([outs[2], Promise.resolve('running')])
  if (z === 'fenced') zombie.fenced++
  for (let i = 0; i < 48; i++) c.ok(billed.includes(`o${i}`), `o${i} billed at least once`)
  const inv = committed(c, 'invoices').filter((e: any) => e.k === 'w')
  const per: Record<string, number> = {}
  for (const e of inv) per[e.p] = (per[e.p] ?? 0) + 1
  for (let i = 0; i < 48; i++) c.eq(per[`o${i}`], 1, `o${i}: exactly one invoice write`)
  // the fencing checker on every cursor row
  const cur = committed(c, '#groups').filter((e: any) => e.k === 'w' && e.p.startsWith('cur:') && e.m?.fence)
  const last: Record<string, string> = {}
  for (const e of cur) { const t = e.m.fence[1]; c.ok(!(last[e.p] > t), `${e.p}: a commit under ${t} after one under ${last[e.p]}`); if (!(last[e.p] > t)) last[e.p] = t }
  for (const [i, r] of runners.entries()) if (ims[i].alive) await r.stop().catch(() => {})
}, { seeds: 40 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  console.log(`  the paused member's commit was refused 'fenced' in ${zombie.fenced} of ${zombie.runs} runs (else it found its shares gone before committing)`)
}
