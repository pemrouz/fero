// P-15 as Elle list-append histories (REQUIREMENTS P-15, TEST-13). Twelve units, each a saga that
// pushes its unit number onto the lists of 2 or 3 rows (partitions spread over the resource's
// groups), in a seeded step order. Four holders run three units each; holder h1 is killed and h2
// paused 25 s (past its 10 s lease) at seeded points; two recoverers later call the same saga ids,
// so a dead or paused holder's unit is finished by a later one. Three readers keep reading 2 or 3
// rows each with fresh reads, one after another (a reader's "transaction" is not atomic: P-15's
// SHOULD is not built). At the end one reader reads every row.
//
// The unit and reader records become an Elle list-append history (one EDN file per seed, in
// $ELLE_OUT). The MUST, checked here directly: no unit is left running, and every unit's number is
// in each of its rows exactly once and in no other row. Elle then checks the history: under read
// committed (no G0, G1a, G1b, G1c, no lost or doubled element) for the MUST, and under serializable
// for the SHOULD (a fractured read shows as G-single).
//
// ELLE_VARIANT:
//   saga    (default) as above
//   undo    every third unit's last step carries a condition that fails, so the saga undoes the steps
//           it did: the library undoes an op it has no inverse for (push) by removing the key
//   nolock  a planted bad app: no saga, each unit pushes to its rows one at a time with no locks, in
//           seeded order (two units can order their writes differently on two rows: G0)
//   owned   as saga, with saga-owned.ts: step 2's saga plus two rules (locks belong to the unit: an
//           unfinished unit that lost a lock is finished before another writes where it wrote)
import { writeFileSync, mkdirSync } from 'node:fs'
import { check, report, isMain, servers, fero, op, sleep } from '../patterns/checks/common.ts'
import { saga } from '../patterns/lib/index.ts'
import { sagaOwned } from './saga-owned.ts'
import { Rng } from '../proto/util.ts'

const variant = process.env.ELLE_VARIANT ?? 'saga'
const outDir = process.env.ELLE_OUT
const mode = process.env.E22_MODE ?? 'plain'
const ROWS = 6, UNITS = 12, HOLDERS = 4
export const tally: Record<string, number> = {}
const bump = (k: string): void => { tally[k] = (tally[k] ?? 0) + 1 }

export const run = () => check(`elle-${variant}`, async (c) => {
  const keys = Array.from({ length: ROWS }, (_, i) => `k${i}`)
  const [s1] = await servers(c, 3, async () => { await fero('lists', { server: true }) })
  const lists = await s1.fero('lists')
  for (const k of keys) await lists.set(k, { xs: [] })
  await c.settle()
  const rng = new Rng(c.seed * 104729 + 7)
  // each unit: 2 or 3 distinct rows, in a seeded order
  const units = Array.from({ length: UNITS }, (_, i) => {
    const n = 2 + rng.int(2)
    const ks = [...keys]
    for (let j = ks.length - 1; j > 0; j--) { const x = rng.int(j + 1); [ks[j], ks[x]] = [ks[x], ks[j]] }
    return { u: i + 1, ks: ks.slice(0, n), bad: variant === 'undo' && (i + 1) % 3 === 0 }
  })
  const stepsOf = (L: any, x: (typeof units)[number]) => x.ks.map((k, j) => ({ to: L, key: [k, 'xs'], value: op.push(x.u), ...(x.bad && j === x.ks.length - 1 ? { if: { equals: 'never' } } : {}) }))
  const recs: { type: 'ok' | 'fail' | 'info'; value: string; proc: number }[] = []
  c.chaos({ leaderChanges: 2, moves: 1, within: 200 })
  c.w.faults([{ at: c.w.time + 10 + (c.seed % 60), do: 'kill', proc: 'h1' }, { at: c.w.time + 5 + (c.seed % 40), do: 'pause', proc: 'h2', for: 25_000 }])
  const holders = c.procs(...Array.from({ length: HOLDERS }, (_, i) => `h${i + 1}`))
  const mine = (h: number) => units.filter((x) => (x.u - 1) % HOLDERS === h)
  const runUnit = async (x: (typeof units)[number]) => {
    const L = await fero('lists')
    if (variant === 'nolock') { try { for (const s of stepsOf(L, x)) await L.set(s.key, s.value); return 'ok' } catch (e: any) { return e.code } }
    return (variant === 'owned' ? sagaOwned : saga)(stepsOf(L, x), { id: `unit-${x.u}`, lease: '10s' }).then(() => 'ok', (e: any) => e.code)
  }
  const work = holders.map((h, i) => h.run(async () => { for (const x of mine(i)) await runUnit(x) }))
  void work
  // readers: fresh reads of 2 or 3 rows, one after another
  const readers = c.procs('r1', 'r2', 'r3')
  const reads = readers.map((r, ri) => r.run(async () => {
    const L = await fero('lists')
    const rr = new Rng(c.seed * 31 + ri)
    for (let i = 0; i < 30; i++) {
      const n = 2 + rr.int(2), ks = [...keys]
      for (let j = ks.length - 1; j > 0; j--) { const x = rr.int(j + 1); [ks[j], ks[x]] = [ks[x], ks[j]] }
      const mops: string[] = []
      try {
        for (const k of ks.slice(0, n)) { const xs = await L.get([k, 'xs'], { fresh: true }); mops.push(`[:r ${k} ${xs === undefined ? 'nil' : `[${xs.join(' ')}]`}]`) }
        recs.push({ type: 'ok', value: mops.join(' '), proc: 100 + ri })
      } catch { /* a read that timed out: no record */ }
      await sleep(2 + rr.int(5))
    }
  }))
  await Promise.all(reads)
  // recoverers finish (or find done) every unit of the killed and the paused holder
  await c.w.advance('12s')
  const recov = c.procs('q1', 'q2')
  await Promise.all([recov[0].run(async () => { for (const x of mine(0)) await runUnit(x) }), recov[1].run(async () => { for (const x of mine(1)) await runUnit(x) })])
  await c.w.advance('40s')
  await c.settle()
  // the final read of every row
  const fin = await c.procs('r9')[0].run(async () => { const L = await fero('lists'); const o: Record<string, number[]> = {}; for (const k of keys) o[k] = (await L.get([k, 'xs'], { fresh: true })) ?? []; return o })
  recs.push({ type: 'ok', value: keys.map((k) => `[:r ${k} [${fin[k].join(' ')}]]`).join(' '), proc: 199 })
  // unit outcomes, from the intent rows (nolock: every unit counts as committed)
  const intents = variant === 'nolock' ? {} : (await s1.fero('#sagas')).snapshot
  for (const x of units) {
    const st = variant === 'nolock' ? 'done' : intents[`unit-${x.u}`]?.state
    const type = st === 'done' ? 'ok' : st === 'undone' ? 'fail' : 'info'
    bump(`unit:${type}`)
    recs.push({ type, value: x.ks.map((k) => `[:append ${k} ${x.u}]`).join(' '), proc: (x.u - 1) % HOLDERS })
  }
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(`${outDir}/${variant}-${mode}-seed${c.seed}.edn`, recs.map((r) => `{:type :${r.type}, :value [${r.value}], :process ${r.proc}}`).join('\n') + '\n')
  }
  // the MUST, directly
  const left = Object.entries(intents).filter(([, v]: any) => v.state !== 'done' && v.state !== 'undone')
  c.eq(left.map(([k]) => k), [], 'no unit left running')
  for (const x of units) {
    const st = variant === 'nolock' ? 'done' : intents[`unit-${x.u}`]?.state
    for (const k of keys) {
      const n = fin[k].filter((v) => v === x.u).length
      const want = st === 'done' && x.ks.includes(k) ? 1 : 0
      if (n !== want) bump('must:broken')
      c.eq(n, want, `unit ${x.u} (${st}) appears ${n} times in ${k}`)
    }
  }
}, { seeds: 100 })

if (isMain(import.meta.url)) { report(await run(), import.meta.url); console.log(`  ${JSON.stringify(tally)}`) }
