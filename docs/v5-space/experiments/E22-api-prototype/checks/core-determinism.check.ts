// TEST-02 on the prototype: a run is a function of its seed. The same scenario (three servers, two
// clients, writes, a read, a leader change, a slot move, the shuffle on) runs twice per seed: the
// event trace hash and the client history must be byte-identical. Different seeds must differ.
import { runOne, isMain } from '../proto/check.ts'
import { fero, op } from '../proto/index.ts'
import type { Ctx } from '../proto/check.ts'

const body = async (c: Ctx): Promise<void> => {
  const [s1, s2, s3, a, b] = c.procs('s1', 's2', 's3', 'a', 'b')
  for (const s of [s1, s2, s3]) await s.run(() => fero('shop', { server: true }))
  c.chaos({ leaderChanges: 2, moves: 1, within: 20 })
  await Promise.all([a, b].map((p) => p.run(async () => {
    const shop = await fero('shop')
    for (let i = 0; i < 10; i++) await shop.set(`k${i % 3}`, op.incr(1))
    await shop.get('k0', { fresh: true })
  })))
}
export const run = async (seeds = 30): Promise<{ same: number; distinct: number; seeds: number }> => {
  let same = 0
  const traces = new Set<string>()
  for (let seed = 1; seed <= seeds; seed++) {
    const hist: string[] = []
    const wrap = async (c: Ctx) => { await body(c); hist.push(JSON.stringify(c.w.history)) }
    const x = await runOne('det', wrap, seed, {})
    const y = await runOne('det', wrap, seed, {})
    if (x.error || y.error) throw new Error(`seed ${seed}: ${x.error ?? y.error}`)
    if (x.trace === y.trace && hist[0] === hist[1]) same++
    traces.add(x.trace)
  }
  return { same, distinct: traces.size, seeds }
}

if (isMain(import.meta.url)) {
  const r = await run()
  if (r.same === r.seeds && r.distinct === r.seeds) console.log(`ok core-determinism (${r.seeds} seeds run twice: traces and histories identical; ${r.distinct} distinct traces)`)
  else { console.log(`FAILED core-determinism: ${r.same}/${r.seeds} identical, ${r.distinct} distinct`); process.exitCode = 1 }
}
