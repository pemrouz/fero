// P-02's check (REQUIREMENTS P-02): the writer removes rows by its own time, as records with a
// reason, so every copy agrees; a row goes within one tick plus skew.max of its ttl and never before
// (from the log: the removal's writer time minus the write's); `touch` resets the ttl; `max` holds.
// Faults inside the work: a leader change and a slot move; one server's clock skewed by 200 ms; in
// odd seeds a second leader change lands near the ttl, which delays expiry while no writer exists.
import { check, report, isMain, servers, committed, fero } from './common.ts'
import { p02 } from '../p02-cache.ts'

export const late = { calm: [] as number[], failover: [] as number[] }
export let maxOver = 0
export const run = () => check('p02-cache', async (c) => {
  const open = async () => {
    await fero('cache', { server: true, rows: { ttl: '10m', max: 1e6 } })
    await fero('sessions', { server: true, rows: { ttl: '30m' } })
    await fero('lru', { server: true, rows: { max: 8 } })
  }
  const ss = await servers(c, 3, open)
  const [s1, s2] = ss
  c.w.faults([{ at: c.w.time + 1, do: 'skew', proc: `s${1 + (c.seed % 3)}`, by: (c.seed % 2 ? 1 : -1) * 200 }])
  c.chaos({ leaderChanges: 1, moves: 1, within: 4 })
  const t0 = c.w.time
  const { cache } = await s1.run(p02)
  const failover = c.seed % 2 === 1
  if (failover) c.w.faults([{ at: t0 + 29_000 + (c.seed % 7) * 300, do: 'leader-change', res: 'cache' }])
  await c.w.advance('40s')
  // the ttl row: removed by the writer, with its reason, never before its ttl by writer time
  const es = committed(c, 'cache').filter((e: any) => e.p === 'hot')
  const w = es.find((e: any) => e.k === 'w'), x = es.find((e: any) => e.k === 'x')
  c.ok(w && x && x.why === 'ttl', `the hot row's removal is a 'ttl' record (${es.map((e: any) => e.k + (e.why ?? '')).join(',')})`)
  const dt = x.t - w.t - 30_000
  c.ok(dt >= -1e-6, `never before its ttl by writer time (removed ${dt} ms after it)`)
  ;(failover ? late.failover : late.calm).push(dt)
  if (!failover) c.ok(dt <= 1 + 250, `within one tick + skew.max of its ttl: ${dt} ms late`)
  for (const s of ss) c.eq(s.run(() => cache.snapshot.hot), undefined, 'gone on every copy')
  // touch resets the ttl: touched at 25m, the row lives past 30m, and goes after 55m
  const sessions = await s2.fero('sessions')
  await c.w.advance('25m'); await sessions.touch('sid-9f2'); await c.w.advance('20m')
  c.eq(sessions.snapshot['sid-9f2'], { user: 42 }, 'touch reset the ttl (45 m after the write)')
  await c.w.advance('11m')
  c.eq(sessions.snapshot['sid-9f2'], undefined, 'and the row goes once the touched ttl passes')
  c.eq(cache.snapshot['user:42'], undefined, 'the 10m row went too')
  // rows.max: enforced per group as its share; the newest row stays
  const lru = await s2.fero('lru')
  for (let i = 0; i < 40; i++) await lru.set(`k${i}`, { i })
  await c.settle()
  const held = ss.map((s) => Object.keys(s.run(() => lru.snapshot)).length)
  const groups = c.stack.k.meta('lru')!.groups.length
  // per group as its share, rounded up: the whole can pass max by up to groups - 1 (API-NOTES D13)
  c.ok(held.every((n) => n <= 8 + groups - 1), `rows.max 8 holds on every copy, within groups - 1 (${held})`)
  if (held[0] > 8) maxOver++
  c.eq(lru.snapshot.k39, { i: 39 }, 'the newest row stays')
}, { seeds: 60 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  const mx = (xs: number[]) => (xs.length ? Math.max(...xs).toFixed(1) : '-')
  console.log(`  rows.max 8 over 2 groups: ${maxOver} runs held 9 rows (each group rounds its share up)`)
  console.log(`  ttl lateness by writer time: calm max ${mx(late.calm)} ms over ${late.calm.length} seeds; with a leader change near the ttl max ${mx(late.failover)} ms over ${late.failover.length}`)
}
