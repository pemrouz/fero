// P-03's check (REQUIREMENTS P-03): a client with `cache.memory` holds only what it reads or
// follows; a miss is one hop and the row is then followed; a follow is a snapshot then deltas with
// no gap and no overlap (the values it sees of a row only move forward, and it ends equal to the
// server); a row not held throws 'shortfall'; memory stays inside the bound. A writer keeps changing
// u42 and u43 under a leader change and a move. Not modelled: a reconnect with the cursor (no links).
import { check, report, isMain, servers, code, fero } from './common.ts'
import { p03 } from '../p03-near-cache.ts'

export const run = () => check('p03-near-cache', async (c) => {
  const ss = await servers(c, 3, () => fero('users', { server: true }))
  const users = await ss[0].fero('users')
  for (let i = 0; i < 60; i++) await users.set(`u${i}`, { name: `n${i}`, v: 0 })
  await c.settle()
  const [a, wr] = c.procs('a', 'wr')
  // the one-hop miss, measured with no faults: one round trip to a server
  const t0 = c.w.time
  const probe = await a.run(async () => { const u = await fero('users', { cache: { memory: '200MB' } }); return u.get('u1') })
  c.ok(c.w.time - t0 <= 1, `a miss is one hop (${(c.w.time - t0).toFixed(2)} ms)`)
  c.eq(probe, { name: 'n1', v: 0 }, 'the miss answers the row')
  c.chaos({ leaderChanges: 1, moves: 1, within: 6 })
  const writes = wr.run(async () => { const u = await fero('users'); for (let v = 1; v <= 12; v++) { await u.set('u42', { name: 'n42', v }); await u.set('u43', { name: 'n43', v }) } })
  const seen: Record<string, number[]> = { u42: [], u43: [] }
  const r = await a.run(() => p03((...x: unknown[]) => { const snap = x[0] as any; if (x.length === 1) for (const k of ['u42', 'u43']) if (snap?.[k]) seen[k].push(snap[k].v) }))
  await writes
  await c.settle()
  c.eq(await code(async () => r.users.snapshot.u7), 'shortfall', 'a row never read throws shortfall')
  c.ok(r.same.v >= r.u.v, 'the sync read is no older than the miss')
  for (const k of ['u42', 'u43']) {
    const xs = seen[k]
    c.ok(xs.every((v, i) => i === 0 || v >= xs[i - 1]), `${k}: the follow's values only move forward (${xs})`)
    c.eq(r.mine.snapshot()[k], { name: `n${k.slice(1)}`, v: 12 }, `${k}: the follow ends equal to the server`)
    c.eq(r.users.snapshot[k], { name: `n${k.slice(1)}`, v: 12 }, `${k}: the read row is followed`)
  }
  c.eq(Object.keys(r.mine.snapshot()).sort(), ['u42', 'u43'], 'the follow holds exactly its partitions')
  // memory: a small cache reads 60 rows and keeps inside its bound
  const small = await c.procs('b')[0].fero('users', { cache: { memory: '1KB' } })
  for (let i = 0; i < 60; i++) await small.get(`u${i}`)
  const rep = c.stack.l3.replicaIf(c.procs('b')[0], 'users')!
  c.ok(rep.bytes <= 1000, `a 1 KB near cache holds ${rep.bytes} bytes after reading 60 rows`)
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
