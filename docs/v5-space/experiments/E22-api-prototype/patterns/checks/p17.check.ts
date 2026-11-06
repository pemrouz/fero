// P-17's check (REQUIREMENTS P-17): two derive members turn 40 orders into per-user totals with
// op.incr (not idempotent: the hard case). Faults: one member killed mid-batch, leader changes, a
// move, 5% message loss. Each order counts exactly once: totals equal the sums. Beside it, the same
// reader without attempt ids on its outputs (what the verbs alone allow, API-NOTES D3) writes to
// `totals2`; how often it double-counts is reported.
import { check, report, isMain, servers, fero, op, sleep } from './common.ts'
import { p17 } from '../p17-derive.ts'
import { group } from '../lib/index.ts'

export const plain = { runs: 0, wrong: 0, extra: 0 }
export const run = () => check('p17-derive', async (c) => {
  await servers(c, 3, async () => { for (const n of ['orders', 'totals', 'totals2']) await fero(n, { server: true }) })
  const ds = c.procs('d1', 'd2')
  const rs = await Promise.all(ds.map((p) => p.run(p17)))
  const ps = c.procs('n1', 'n2')
  await Promise.all(ps.map((p) => p.run(async () => {
    const g = await group(await fero('orders'), 'plain'); const t2 = await fero('totals2')
    return g.run((e) => e.row && t2.set(e.row.user, op.incr(e.row.cents)))          // no ids: at least once
  })))
  await c.w.advance('2s')
  c.chaos({ leaderChanges: 2, moves: 1, within: 300 })
  c.w.faults([{ at: c.w.time, do: 'drop', p: 0.05 }, { at: c.w.time + 3000, do: 'drop', p: 0 },
    { at: c.w.time + 60 + (c.seed % 120), do: 'kill', proc: 'd1' }, { at: c.w.time + 60 + (c.seed % 120), do: 'kill', proc: 'n1' },
    { at: c.w.time + 90 + (c.seed % 150), do: 'leader-change', res: '#groups' }, { at: c.w.time + 120 + (c.seed % 150), do: 'leader-change', res: '#locks' }])
  const want: Record<string, number> = {}
  await c.procs('prod')[0].run(async () => { const o = await fero('orders'); for (let i = 0; i < 40; i++) { const u = `u${i % 4}`; await o.set(`o${i}`, { user: u, cents: i + 1 }); want[u] = (want[u] ?? 0) + i + 1; await sleep(4) } })
  await c.w.advance('40s')
  const s1 = c.procs('s1')[0]
  const totals = await s1.fero('totals'), totals2 = await s1.fero('totals2')
  c.eq(Object.fromEntries(Object.entries(totals.snapshot).sort()), want, 'each order counted exactly once')
  plain.runs++
  const t2 = Object.fromEntries(Object.entries(totals2.snapshot).sort()) as Record<string, number>
  if (JSON.stringify(t2) !== JSON.stringify(want)) { plain.wrong++; plain.extra += Object.keys(want).reduce((n, k) => n + (t2[k] ?? 0) - want[k], 0) }
  for (const [i, r] of rs.entries()) if (ds[i].alive) await r.stop().catch(() => {})
}, { seeds: 40 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  without attempt ids on the outputs: totals wrong in ${plain.wrong} of ${plain.runs} runs (${plain.extra} cents counted twice in all)`) }
