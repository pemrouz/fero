// P-10's check (REQUIREMENTS P-10, TEST-13's fencing checker). Two processes run payroll at once:
// one gets the lock, the other waits. The holder is paused 15 s (past its 10 s lease) between taking
// the lock and its protected write, with its clock skewed; the other takes over, writes, releases.
// The zombie then writes: refused 'fenced'. It also writes a row the new holder never touched (a
// partition that may sit in another group): refused too, because every writer follows #locks.
// Tokens strictly rise. Leader election: three candidates, one leader at a time; the leader killed,
// another leads within one lease plus 1 s; a paused leader's `lost` fires. Leader changes and a
// move land in the work. The checker: in every ledger log, no write commits under a token older than
// one already committed for that lock.
import { check, report, isMain, servers, committed, code, fero, sleep } from './common.ts'
import { payroll, elect } from '../p10-locks.ts'

export const tally = { otherRowFenced: 0, runs: 0 }
export const run = () => check('p10-locks', async (c) => {
  await servers(c, 3, () => fero('ledger', { server: true }))
  const [A, B] = c.procs('A', 'B')
  c.w.faults([{ at: c.w.time + 1, do: 'skew', proc: 'A', by: (c.seed % 2 ? -1 : 1) * 3000 }])
  c.chaos({ leaderChanges: 2, moves: 1, within: 12_000 })
  c.w.faults([{ at: c.w.time + 3000 + (c.seed % 9) * 1000, do: 'leader-change', res: '#locks' }])
  let first = ''
  const work = (me: string) => async () => { if (!first) { first = me; c.w.pause(me, 15_000) } await sleep(1) }
  const ra = A.run(() => payroll('A', work('A'))).then((l) => ({ ok: true, l }), (e) => ({ ok: false, code: e.code }))
  const rb = B.run(() => payroll('B', work('B'))).then((l) => ({ ok: true, l }), (e) => ({ ok: false, code: e.code }))
  const [xa, xb] = await Promise.all([ra, rb]) as any[]
  const [zombie, holder] = first === 'A' ? [xa, xb] : [xb, xa]
  c.eq(zombie, { ok: false, code: 'fenced' }, 'the paused holder\'s protected write is refused fenced')
  c.ok(holder.ok, `the second holder wrote (${JSON.stringify(holder)})`)
  const ledger = await c.procs('s1')[0].fero('ledger')
  c.eq(ledger.snapshot['run-42'].by, first === 'A' ? 'B' : 'A', 'the row holds the current holder\'s write')
  // the zombie, again, on a row the new holder never wrote
  const zp = first === 'A' ? A : B
  const zl = await zp.run(async () => { const locks = await fero('#locks'); return locks })
  void zl
  const ztoken = committed(c, '#locks').filter((e: any) => e.p === 'payroll' && e.m?.born)[0]?.v
  const ntoken = committed(c, '#locks').filter((e: any) => e.p === 'payroll' && e.m?.born)[1]?.v
  c.ok(ztoken && ntoken && ztoken < ntoken, `tokens strictly rise (${ztoken} < ${ntoken})`)
  tally.runs++
  const other = await code(() => zp.run(async () => (await fero('ledger')).set(`other-${c.seed}`, { by: 'zombie' }, { if: { fence: { lock: 'payroll', token: ztoken } } })))
  if (other === 'fenced') tally.otherRowFenced++
  c.eq(other, 'fenced', 'a stale token is fenced on a row the new holder never wrote (writers remember tokens they saw in #locks)')
  // the checker: per ledger group, fence tokens never go back in log order
  const k = c.stack.k
  for (const g of k.meta('ledger')!.groups) {
    let hi = ''
    for (const e of (k.read(g, g.base, g.commit) as any[])) if (e.m?.fence) { c.ok(e.m.fence[1] >= hi, `${g.id}: a write under ${e.m.fence[1]} after one under ${hi}`); if (e.m.fence[1] > hi) hi = e.m.fence[1] }
  }
  // leader election
  const cands = c.procs('e1', 'e2', 'e3')
  const exits: string[] = []
  const leaders: string[] = []
  const elections = cands.map((p) => p.run(() => elect(() => exits.push(p.id))).then(() => leaders.push(p.id)))
  void elections
  await c.w.advance('2s')
  c.eq(leaders.length, 1, `one leader at a time (${leaders})`)
  const t1 = c.w.time
  c.w.kill(leaders[0])
  while (leaders.length < 2 && c.w.time < t1 + 30_000) await c.w.advance('100ms')
  c.ok(leaders.length === 2 && c.w.time - t1 <= 11_000, `a new leader within one lease plus 1 s (${(c.w.time - t1).toFixed(0)} ms)`)
  c.w.pause(leaders[1], 15_000)
  while (leaders.length < 3 && c.w.time < t1 + 60_000) await c.w.advance('100ms')
  await c.w.advance('20s')
  c.ok(exits.includes(leaders[1]), `the paused leader's lost fired (${exits})`)
  c.eq(leaders.length, 3, 'and the third took over')
}, { seeds: 40 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  console.log(`  a stale token on a row the new holder never wrote: fenced in ${tally.otherRowFenced} of ${tally.runs} runs`)
}
