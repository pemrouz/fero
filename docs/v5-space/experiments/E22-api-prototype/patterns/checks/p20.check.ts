// P-20's check (REQUIREMENTS P-20, three versions): rows written at v1, the shape bumped to v2 and
// more written, then to v3 (name becomes { first, last }) with a schema checked at the writer and a
// paced migration that a crash interrupts in odd seeds (another server re-runs it). Every replica
// equals a rebuild of the log through the upcasters (the harness's monitor, after every bump); a log
// reader on new code sees old records upcast; the schema refuses with the path; each row is
// rewritten by the migration exactly once; pacing holds. Leader changes and a move land in the work.
import { check, report, isMain, servers, committed, code, fero, sleep } from './common.ts'
import { v1, v2, v3, up } from '../p20-shape.ts'
import { migrate } from '../lib/index.ts'

const UserV3 = { '~standard': { version: 1 as const, vendor: 'check', validate: (v: any) =>
  typeof v?.name?.first === 'string' && typeof v?.name?.last === 'string' ? { value: v } : { issues: [{ message: 'name must be { first, last }', path: ['name'] }] } } }
export const run = () => check('p20-shape', async (c) => {
  const ss = await servers(c, 3, v1)
  const [s1, s2, s3] = ss
  const users = await s1.fero('users')
  c.chaos({ leaderChanges: 2, moves: 1, within: 120 })
  for (let i = 0; i < 10; i++) { await users.set(`u${i}`, { name: `Ada${i}` }); await sleep(1) }
  await s1.run(v2)
  for (let i = 10; i < 20; i++) { await users.set(`u${i}`, { name: `Bo${i}` }); await sleep(1) }
  await c.settle()
  for (const s of ss) await s.run(() => fero('users', { schema: UserV3 }))   // the v3 code rolls first: its schema is registered
  const crash = c.seed % 2 === 1
  if (crash) c.w.faults([{ at: c.w.time + 8 + (c.seed % 20), do: 'kill', proc: 's2' }])
  const t0 = c.w.time
  const first = s2.run(() => v3(UserV3, 500)).then(() => 'done', (e: any) => e?.code ?? String(e))
  if (crash) { await c.w.advance('3s'); await s3.run(async () => (await migrate(await fero('users'), { to: 3, fn: (r: any) => r, perSec: 500 })).done) }
  else c.eq(await first, 'done', 'the migration finishes')
  await c.settle()
  if (!crash) c.ok(c.w.time - t0 >= 19 * 2, `paced at 500 rows a second (${(c.w.time - t0).toFixed(0)} ms for 20 rows)`)
  const want = (i: number) => ({ name: { first: i < 10 ? `Ada${i}` : `Bo${i}`, last: '' } })
  for (const s of ss.filter((p) => p.alive)) for (let i = 0; i < 20; i++) c.eq(s.run(() => users.snapshot[`u${i}`]), want(i), `${s.id} u${i} at v3`)
  // the migration wrote each row exactly once
  const mig = committed(c, 'users').filter((e: any) => e.a?.startsWith('mig:'))
  const per: Record<string, number> = {}
  for (const e of mig) per[e.p] = (per[e.p] ?? 0) + 1
  c.eq(Object.keys(per).length, 20, 'every row migrated')
  c.ok(Object.values(per).every((n) => n === 1), `each row migrated exactly once (${JSON.stringify(per)})`)
  // old records, read on new code, come out at v3
  const r = (await s1.fero('users')).read({ from: 'earliest' })
  const firstRows: any[] = []
  for await (const e of r) { if (e.row && e.partition === 'u0') firstRows.push(e.row); if (firstRows.length >= 1) break }
  c.eq(firstRows[0], want(0), 'a v1 record replays upcast to v3')
  c.eq(await code(() => users.set('bad', { name: 'flat' })), 'schema', 'the schema refuses a v1-shaped row at the writer')
  void up
}, { seeds: 40 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
