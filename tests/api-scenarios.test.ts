//! Tier-3 scenario library over the PUBLIC surface (M5d, plan §11 M5): v2's chaos vocabulary —
// formation, concurrent-writer convergence, kill/restart-from-WAL, full-cluster kill — exercised
// through fero() alone (no kernel reach-through in the scenario bodies; assertions read snapshots
// and cluster surfaces the way a consumer would). The PROTOCOL under faults is Tier-2's job (sim
// sweeps, deterministic seeds); THIS file proves the composition end-to-end on real sockets and
// real disks. Partition/heal stays sim-only by design: real-TCP partition injection needs a proxy
// layer that would test the harness, not fero.

//! the directory is OFF in this suite regardless of how it is run: a single-file `node --test` must never
// meet a live box directory (the battery's npm script sets the same default)
process.env.FERO_RENDEZVOUS ??= 'off'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fero, type Fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { ports, until } from '#utils'

//! the scenario vocabulary, public-surface edition
const spawn = async (n: number, opts: { dirs?: string[] } = {}): Promise<{ nodes: Fero[]; addrs: string[] }> => {
  const ps: number[] = []
  for (let i = 0; i < n; i++) ps.push(await ports.free())
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scenario', {
      uuid: `n${String(i + 1).padStart(2, '0')}`,
      listen,
      hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: 50,
      redialMs: 30,
      ...(opts.dirs ? { dir: opts.dirs[i] } : {}),
    })))
  return { nodes, addrs }
}
const formed = (nodes: Fero[], timeout = 10_000) =>
  until(() => nodes.every((f) => (snapshot(f.cluster) as { epoch: number }).epoch >= 1), timeout)
//! canon — order-insensitive structural stringify: replicas fold identical VALUES but key insertion
// order differs by arrival order (the sim's converged() is order-insensitive for the same reason)
const canon = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
    : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : JSON.stringify(v)
const converged = (nodes: Fero[], timeout = 10_000) =>
  until(() => {
    const first = canon(snapshot(nodes[0].data))
    return nodes.every((f) => canon(snapshot(f.data)) === first) && first !== '{}'
  }, timeout)

test('SCENARIO formation + concurrent writers: five servers form one view and converge on a mixed workload', async () => {
  const { nodes } = await spawn(5)
  try {
    assert.ok(await formed(nodes), 'one committed view across five nodes')
    //! every node writes concurrently — updates, nested updates, removes
    nodes.forEach((f, i) => {
      f.data[`row${i}`] = { by: i }
      f.data.shared = { last: i }
    })
    nodes[0].data.row0.nested = true
    delete nodes[1].data.row1
    assert.ok(await converged(nodes), 'all five snapshots identical')
    const s = snapshot(nodes[0].data) as Record<string, unknown>
    assert.equal(s.row1, undefined, 'the remove won everywhere')
    assert.deepEqual((s.row0 as Record<string, unknown>).nested, true)
  } finally {
    for (const f of nodes) await f.destroy()
  }
})

test('SCENARIO kill/restart: a durable member dies, its heir restores from the WAL through fero(name, {dir}) and reconverges', async () => {
  const dirs = Array.from({ length: 3 }, (_, i) => fs.mkdtempSync(path.join(os.tmpdir(), `fero-sc-${i}-`)))
  const { nodes, addrs } = await spawn(3, { dirs })
  let heir: Fero | null = null
  try {
    assert.ok(await formed(nodes))
    const r = await nodes[0].methods.update({ key: 'durable-fact', value: 42 }, { confirm: 'persisted', timeout: 10_000 })
    assert.equal(r.guarantee, 'persisted', 'a real fsync quorum answered')
    assert.ok(await converged(nodes))
    //! kill n03 and resurrect it from its dir alone — same uuid, same fero() call shape
    await nodes[2].destroy()
    heir = await fero('scenario', { uuid: 'n03', listen: addrs[2], hosts: addrs.filter((_, j) => j !== 2), heartbeatMs: 50, redialMs: 30, dir: dirs[2] })
    assert.equal((snapshot(heir.data) as Record<string, unknown>)['durable-fact'], 42, 'the heir folded its WAL BEFORE the network')
    assert.equal((snapshot(heir.cluster) as { me: { origin: string } }).me.origin, 'n03~2', 'a reborn lane')
    //! and it is alive, not a museum: fresh writes flow both ways
    heir.data.fresh = 'from-heir'
    assert.ok(await until(() => (snapshot(nodes[0].data) as Record<string, unknown>).fresh === 'from-heir', 10_000))
  } finally {
    for (const f of nodes.slice(0, 2)) await f.destroy()
    await heir?.destroy()
    await nodes[2].destroy().catch(() => {})
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('SCENARIO full-cluster kill: every member dies at once; the cluster restores from WALs alone (the M4e proof, public edition)', async () => {
  const dirs = Array.from({ length: 3 }, (_, i) => fs.mkdtempSync(path.join(os.tmpdir(), `fero-fc-${i}-`)))
  const { nodes, addrs } = await spawn(3, { dirs })
  let reborn: Fero[] = []
  try {
    assert.ok(await formed(nodes))
    for (let i = 0; i < 6; i++) nodes[i % 3].data[`k${i}`] = { v: i }
    const r = await nodes[0].methods.update({ key: 'sealed', value: true }, { confirm: 'persisted', timeout: 10_000 })
    assert.equal(r.guarantee, 'persisted')
    assert.ok(await converged(nodes))
    const before = canon(snapshot(nodes[0].data))
    //! the whole-cluster kill — nothing survives but three directories
    for (const f of nodes) await f.destroy()
    reborn = await Promise.all(addrs.map((listen, i) =>
      fero('scenario', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeatMs: 50, redialMs: 30, dir: dirs[i] })))
    //! every persisted-confirmed fact is back BEFORE the mesh re-forms; then the cluster relives
    assert.equal((snapshot(reborn[0].data) as Record<string, unknown>).sealed, true, 'the persisted-confirmed write survived the apocalypse')
    assert.equal(canon(snapshot(reborn[0].data)), before, 'the full fold restored')
    assert.ok(await formed(reborn, 15_000), 'the reborn cluster formed a view')
    reborn[1].data.postApocalypse = 1
    assert.ok(await until(() => (snapshot(reborn[0].data) as Record<string, unknown>).postApocalypse === 1, 10_000), 'and it writes')
  } finally {
    for (const f of reborn) await f.destroy().catch(() => {})
    for (const f of nodes) await f.destroy().catch(() => {})
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
})

test('SCENARIO observability: cluster.writes shows a write pending → committed (plan Q4: the ring, not data, carries write state)', async () => {
  const { nodes, addrs } = await spawn(2)
  const c = await fero('scenario', { uuid: 'zz', hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    assert.ok(await formed(nodes))
    await c.methods.update({ key: 'observed', value: 1 }, { timeout: 8000 })
    const rows = () => Object.values(snapshot(c.cluster.writes) as Record<string, { key: string; state: string; origin?: string }>)
    assert.ok(await until(() => rows().some((w) => w.key.includes('observed') && w.state === 'committed'), 8000),
      'the ring folded the route: pending at issue, committed at the ack join')
    const row = rows().find((w) => w.key.includes('observed'))!
    assert.notEqual(row.origin, 'zz', 'with its server-stamped coordinates')
  } finally {
    await c.destroy()
    for (const f of nodes) await f.destroy()
  }
})
