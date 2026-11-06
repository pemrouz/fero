// P-15's check (REQUIREMENTS P-15 MUST): sagas between alice and bob. tx-1: its holder is killed at a
// seeded point; a later process calls the same id and finishes or undoes it. tx-2: its holder is
// paused 25 s mid-way (past the 10 s lease); a later process recovers it; the paused one wakes and
// must change nothing. tx-3: its second step breaks a bound, so its first is undone. Leader changes
// and a move on accounts and #locks. Money is conserved; no intent is left running; each saga is all
// applied or all undone (bob's balance tells which).
import { check, report, isMain, servers, committed, fero, op, sleep } from './common.ts'
import { transfer } from '../p15-saga.ts'
import { saga } from '../lib/index.ts'

export const outcomes: Record<string, number> = {}
export const run = () => check('p15-saga', async (c) => {
  const [s1] = await servers(c, 3, () => fero('accounts', { server: true }))
  const acc = await s1.fero('accounts')
  await acc.set('alice', { cents: 20_000 }); await acc.set('bob', { cents: 0 })
  c.chaos({ leaderChanges: 2, moves: 1, within: 300 })
  c.w.faults([{ at: c.w.time + 40 + (c.seed % 80), do: 'leader-change', res: '#locks' }, { at: c.w.time + 5 + (c.seed % 30) * 3, do: 'kill', proc: 'h1' }])
  const [h1, h2, r1, r2, h3] = c.procs('h1', 'h2', 'r1', 'r2', 'h3')
  const t1 = h1.run(() => transfer('tx-1', 5000)).catch((e: any) => e.code)
  const t2 = h2.run(async () => { const p = transfer('tx-2', 5000); await sleep(3 + (c.seed % 20)); c.w.pause('h2', 25_000); return p }).then((p) => p).catch((e: any) => e.code)
  await c.w.advance('1s')
  const rec1 = r1.run(() => transfer('tx-1', 5000)).then(() => 'ok', (e: any) => e.code)
  const rec2 = r2.run(async () => { await sleep(12_000); return transfer('tx-2', 5000) }).then(() => 'ok', (e: any) => e.code)
  const bad = h3.run(async () => {
    const a = await fero('accounts')
    return saga([{ to: a, key: ['bob', 'cents'], value: op.incr(100) }, { to: a, key: ['alice', 'cents'], value: op.incr(-1e9, { min: 0 }) }], { id: 'tx-3' })
  }).then(() => 'ok', (e: any) => e.code)
  const res = { rec1: await rec1, rec2: await rec2, bad: await bad }
  await c.w.advance('40s')
  void t1; void t2
  for (const [k, v] of Object.entries(res)) outcomes[`${k}:${v}`] = (outcomes[`${k}:${v}`] ?? 0) + 1
  c.eq(res.bad, 'conflict', 'tx-3 is undone and reports its step\'s refusal')
  const a = await s1.fero('accounts')
  const got = await a.get('alice', { fresh: true }), bob = await a.get('bob', { fresh: true })
  c.eq(got.cents + bob.cents, 20_000, `money is conserved (alice ${got.cents}, bob ${bob.cents})`)
  c.ok([0, 5000, 10_000].includes(bob.cents), `each saga all applied or all undone (bob ${bob.cents})`)
  const sagas = await s1.fero('#sagas')
  const left = Object.entries(sagas.snapshot).filter(([, v]: any) => v.state !== 'done' && v.state !== 'undone')
  c.eq(left, [], 'no saga left half done')
  // each step applied at most once: one commit per step attempt id
  const stepWrites = committed(c, 'accounts').filter((e: any) => e.a?.startsWith('saga:'))
  const per: Record<string, number> = {}
  for (const e of stepWrites) per[e.a] = (per[e.a] ?? 0) + 1
  c.ok(Object.values(per).every((n) => n === 1), `each step committed once (${JSON.stringify(per)})`)
  // how often a later holder really took a saga over: its intent row was written under two tokens
  for (const id of ['tx-1', 'tx-2']) {
    const toks = new Set(committed(c, '#sagas').filter((e: any) => e.p === id && e.m?.fence).map((e: any) => e.m.fence[1]))
    if (toks.size > 1) outcomes[`${id} taken over`] = (outcomes[`${id} taken over`] ?? 0) + 1
  }
}, { seeds: 40 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  outcomes: ${JSON.stringify(outcomes)}`) }
