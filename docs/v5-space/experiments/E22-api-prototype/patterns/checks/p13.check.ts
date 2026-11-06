// P-13's check (REQUIREMENTS P-13): three clients are present (the example: one row in `online`, one
// in `here`). One is killed, one paused 5 s (shorter than session.ms 10 s), one stays; a leader
// change and a move land while they write. The killed one's rows go on every copy within session.ms
// plus one tick of its last renewal (from the log: the removal's writer time minus the kill); the
// others' rows stay.
import { check, report, isMain, servers, committed, fero } from './common.ts'
import { p13 } from '../p13-presence.ts'

export const late = { calm: [] as number[], failover: [] as number[] }
export const run = () => check('p13-presence', async (c) => {
  const ss = await servers(c, 3, async () => { await fero('online', { server: true, rows: { while: 'session' } }); await fero('here', { server: true, partition: { before: '/' } }) })
  c.chaos({ leaderChanges: 1, moves: 1, within: 6 })
  const [a, b, d] = c.procs('a', 'b', 'd')
  await Promise.all([a.run(() => p13('ada')), b.run(() => p13('bo')), d.run(() => p13('dee'))])
  await c.w.advance(`${1 + (c.seed % 5)}s`)
  const tk = c.w.time
  c.w.kill('a')
  c.w.pause('b', 5_000)
  if (c.seed % 2) c.w.faults([{ at: c.w.time + 1000 + (c.seed % 8) * 1000, do: 'leader-change', res: '#sessions' }])
  await c.w.advance('15s')
  for (const s of ss) {
    const online = await s.fero('online'), here = await s.fero('here')
    c.eq(Object.keys(online.snapshot).sort(), ['bo', 'dee'], `${s.id}: online without the killed one`)
    c.eq(Object.keys(here.snapshot).sort(), ['room1/bo', 'room1/dee'], `${s.id}: here without the killed one`)
  }
  // a #sessions failover near the lapse moves it by up to one election window (the new writer gives
  // every lease that long to be renewed, as etcd does); otherwise within session.ms of the kill
  const sesFail = c.w.faultLog.some((f) => f.includes('#sessions'))
  for (const res of ['online', 'here']) {
    const x = committed(c, res).filter((e: any) => e.k === 'x' && e.why === 'session')
    c.ok(x.length === 1, `${res}: one session removal (${x.length})`)
    ;(sesFail ? late.failover : late.calm).push(x[0].t - tk)
    const bound = 10_000 + 1 + (sesFail ? c.w.keys['election.ms'] + c.w.keys['election.jitter'] : 0)
    c.ok(x[0].t - tk <= bound, `${res}: removed ${(x[0].t - tk).toFixed(0)} ms after the kill (bound ${bound})`)
  }
}, { seeds: 60 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  const mx = (xs: number[]) => (xs.length ? Math.max(...xs).toFixed(0) : '-')
  console.log(`  removal after a kill: max ${mx(late.calm)} ms with no #sessions failover (${late.calm.length / 2} runs), ${mx(late.failover)} ms with one (${late.failover.length / 2} runs); session.ms 10000`)
}
