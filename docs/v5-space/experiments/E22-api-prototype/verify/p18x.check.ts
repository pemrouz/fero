// P-18 (TEST-05, TEST-02) at 100 seeds, for step 3's matrix. Step 2's p18 check runs its own worlds
// (30 seeds twice, 20 tape runs); this one runs the tape on three servers inside the harness, so the
// faults land in the work: five recordings, a leader change and a slot move while they are written,
// then a replay in order, a find by match key, and the window passing. Then TEST-02: the example's
// test run, each of 100 seeds twice, must give the same answer, and different seeds other ids.
// The fork (TEST-06) is not built in the prototype: not checked here (step 2's p18 shows the refusal).
import { check, report, isMain, servers, fero } from '../patterns/checks/common.ts'
import { testRun } from '../patterns/p18-tapes.ts'
import { tape } from '../patterns/lib/index.ts'

export const run = async () => {
  const r = await check('p18-tapes', async (c) => {
    await servers(c, 3, async () => { await tape('pay') })
    const t = await c.procs('a')[0].run(() => tape<{ n: number }, { ok: boolean }>('pay'))
    c.chaos({ leaderChanges: 1, moves: 1, within: 8 })
    await c.procs('a')[0].run(async () => { for (let i = 0; i < 5; i++) await t.record(`charge:${i}`, { n: i }, { ok: i % 2 === 0 }) })
    await c.settle()
    const got: unknown[] = await c.procs('a')[0].run(async () => {
      const xs: unknown[] = []
      for await (const x of t.replay()) { xs.push([x.match, x.input.n, x.answer.ok]); if (xs.length === 5) break }
      return xs
    })
    c.eq(got, [0, 1, 2, 3, 4].map((i) => [`charge:${i}`, i, i % 2 === 0]), 'replay gives every recording once, in order')
    c.eq(t.find('charge:3'), { ok: false }, 'find by match key')
    await c.w.advance('15d')
    c.eq(t.find('charge:3'), undefined, 'past the window a recording is gone')
  }, { seeds: 100 })
  // TEST-02: a test run is a function of its seed
  const n = Number(process.argv.includes('--seed') ? 1 : (process.argv[process.argv.indexOf('--seeds') + 1] ?? 100))
  const ids = new Set<string>()
  for (let s = 1; s <= n; s++) {
    const a = await testRun(s), b = await testRun(s)
    ids.add(a.id)
    if (JSON.stringify(a) !== JSON.stringify(b)) r.failed.push({ seed: s, error: `TEST-02: seed ${s} run twice differs`, faults: [], notes: [] })
  }
  if (ids.size !== n) r.failed.push({ seed: 0, error: `TEST-02: ${n} seeds gave ${ids.size} distinct ids`, faults: [], notes: [] })
  return r
}

if (isMain(import.meta.url)) report(await run(), import.meta.url)
