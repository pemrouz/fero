// P-18's check (REQUIREMENTS P-18 = TEST-05 to TEST-07, and TEST-02). The fork is not built in the
// prototype: try.ts is refused 'config' (counted as a gap, not a pass). The test run: the same seed
// twice gives the same result (ids, time, rows, the tape's answer); another seed gives other ids.
// A tape records inputs and answers, finds one by match key, and replays them in order.
// This check makes its own worlds (the example does), so it runs outside the per-seed harness.
import './common.ts'
import { fero } from '../../proto/index.ts'
import { tryFork, testRun } from '../p18-tapes.ts'
import { tape } from '../lib/index.ts'

const fails: string[] = []
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`) }
const t0 = performance.now()
// try.ts: the fork
{
  const w = fero.world({ seed: 1 })
  await fero('shop', { server: true })
  let code = 'ok'
  try { await tryFork() } catch (e: any) { code = e.code }
  eq(code, 'config', 'fero.fork is not built (TEST-06 open)')
  await w.close()
}
// a test run is a function of its seed (TEST-02)
const seeds = Array.from({ length: 30 }, (_, i) => i + 1)
const runs: any[] = []
for (const s of seeds) { const a = await testRun(s), b = await testRun(s); eq(a, b, `seed ${s} twice`); runs.push(a) }
eq(new Set(runs.map((r) => r.id)).size, seeds.length, 'other seeds, other ids')
eq(runs[0].found, { ok: true }, 'the tape finds an answer by its match key')
eq(runs[0].now >= 3_600_000 && runs[0].now < 3_600_000 + 50, true, `advance(1h) moved virtual time by one hour (${runs[0].now} ms)`)
// the tape: record then replay, in order (TEST-05)
for (let seed = 1; seed <= 20; seed++) {
  const w = fero.world({ seed })
  await fero('x', { listen: false })
  const t = await tape<{ n: number }, { ok: boolean }>('pay')
  for (let i = 0; i < 5; i++) await t.record(`charge:${i}`, { n: i }, { ok: i % 2 === 0 })
  const got: unknown[] = []
  for await (const r of t.replay()) { got.push([r.match, r.input.n, r.answer.ok]); if (got.length === 5) break }
  eq(got, [0, 1, 2, 3, 4].map((i) => [`charge:${i}`, i, i % 2 === 0]), 'replay gives every recording in order')
  eq(t.find('charge:3'), { ok: false }, 'find by match key')
  await w.advance('15d')
  eq(t.find('charge:3'), undefined, 'past the window a recording is gone')
  await w.close()
}
const ms = (performance.now() - t0) / 1000
if (fails.length) { for (const f of fails) console.log(`FAIL p18-tapes: ${f}`); console.log('FAILED p18-tapes'); process.exitCode = 1 }
else console.log(`ok p18-tapes (${seeds.length} seeds run twice, identical; tape record/find/replay/window over 20 shuffled seeds; fork refused 'config': not built; ${ms.toFixed(2)} s)`)
