// A refusal must not answer from state that is not committed yet (P-14: conditions are judged at the
// one writer "so they are linearizable per partition"; TEST-13). Found by Porcupine on lin-kv's
// calm seed 77: a check-then-set was refused 'conflict' because of an incr still in the writer's
// uncommitted tail, and a fresh read that started after the refusal still saw the old version.
//
// The race, made likely: client A sends an incr of row x and dies at once; client B, a moment later,
// sends a check-then-set on x's version as it read it; then x's group changes leader, which can drop
// A's incr if no follower stored it. If the writer answered B 'conflict' from the uncommitted incr
// and the incr is then lost, B was refused because of a write that never happened (a phantom
// conflict): B's fresh read afterwards finds the version B asked for, unchanged.
import { check, report, isMain, servers, fero, op, code } from '../patterns/checks/common.ts'

export const tally = { races: 0, phantom: 0, conflict: 0, ok: 0 }

export const run = () => check('phantom-conflict', async (c) => {
  const [s1] = await servers(c, 3, async () => { await fero('kv', { server: true }) })
  const kv = await s1.fero('kv')
  await kv.set('x', { n: 0 })
  await c.settle()
  const [A, B] = c.procs('A', 'B')
  const v0 = (await B.run(async () => (await fero('kv')).get('x', { fresh: true, version: true }))).version
  const meta = c.stack.k.meta('kv')!
  const g = c.stack.k.groupOf(meta, c.stack.k.slotOf('x'))
  void A.run(async () => { await (await fero('kv')).set(['x', 'n'], op.incr(1)) }).catch(() => {})
  await c.w.advance(0.02 + (c.seed % 10) * 0.03)
  c.w.kill('A')
  const res = B.run(async () => code(() => (async () => (await fero('kv')).set('x', { n: 100 }, { if: { version: v0 } }))()))
  c.w.faults([{ at: c.w.time + 0.3 + ((c.seed * 7) % 13) * 0.08, do: 'leader-change', res: 'kv', group: g.n }])
  const got = await res
  await c.settle()
  const after = await B.run(async () => (await fero('kv')).get('x', { fresh: true, version: true }))
  tally.races++
  if (got === 'conflict') tally.conflict++; else if (got === 'ok') tally.ok++
  const phantom = got === 'conflict' && after.version === v0
  if (phantom) tally.phantom++
  c.ok(!phantom, `B was refused 'conflict' on version ${v0}, and the row is still at ${after.version}: a refusal answered from a write that never committed`)
}, { seeds: 100, chaos: false })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  ${JSON.stringify(tally)}`) }
