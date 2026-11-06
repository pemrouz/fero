// A Jepsen-style register workload for Porcupine (TEST-13): the per-partition promise P-14 and P-11
// make, with fresh reads. Four clients and one server do 40 random operations each on six rows
// (spread over the resource's groups): a plain set, an incr with a bound, a check-then-set by
// version, a fresh read. 5% of messages are lost for a while (so acks go missing and attempts are
// resent), and the leader changes and slot move land in the work. This check asserts nothing of its
// own beyond the harness monitors: its history is for the outside checker.
import { check, report, isMain, servers, fero, op } from '../patterns/checks/common.ts'
import { Rng } from '../proto/util.ts'

export const tally: Record<string, number> = {}
const bump = (k: string): void => { tally[k] = (tally[k] ?? 0) + 1 }

export const run = () => check('lin-kv', async (c) => {
  const keys = Array.from({ length: 6 }, (_, i) => `r${i}`)
  const [s1] = await servers(c, 3, async () => { await fero('kv', { server: true }) })
  const kv = await s1.fero('kv')
  for (const k of keys) await kv.set(k, { n: 0 })
  await c.settle()
  c.chaos({ leaderChanges: 2, moves: 1, within: 60 })
  c.w.faults([{ at: c.w.time, do: 'drop', p: 0.05 }, { at: c.w.time + 40, do: 'drop', p: 0 }])
  const procs = [...c.procs('a', 'b', 'd', 'e'), s1]
  await Promise.all(procs.map((p, pi) => p.run(async () => {
    const f = await fero('kv')
    const rng = new Rng(c.seed * 1009 + pi)
    for (let i = 0; i < 40; i++) {
      const k = keys[rng.int(keys.length)]
      const what = rng.int(4)
      try {
        if (what === 0) await f.set(k, { n: rng.int(10) })
        else if (what === 1) await f.set([k, 'n'], op.incr(1, { max: 12 }))
        else if (what === 2) { const g = await f.get(k, { fresh: true, version: true }); await f.set(k, { n: (g?.value.n ?? 0) + 100 }, { if: { version: g?.version ?? '' } }) }
        else await f.get(k, { fresh: true })
        bump(['set', 'incr', 'cas', 'read'][what] + ':ok')
      } catch (e: any) { bump(['set', 'incr', 'cas', 'read'][what] + ':' + (e.code ?? 'threw')) }
    }
  })))
}, { seeds: 100 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  ${JSON.stringify(tally)}`) }
