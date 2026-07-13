//! Tier-3 M6 slice-4 suite: scoped replication through the PUBLIC surface — real sockets, no kernel
// reach-through in the assertions beyond scope/held introspection where the claim IS about scope.
// Pins: the gather (read() with no key IS the download — one-shot union from any server), the §9
// meaning-equivalence rules (typed ScopedError, never a silent shard answer), the non-held remote
// key handle, ScopedError wire rehydration at a spoke, and cluster.partitions.

import { test } from 'node:test'
import assert from 'node:assert'
import { fero, type Fero, type ScopedError } from './index.ts'
import { snapshot } from './substrate.ts'
import { ports, until } from '#utils'

const spawn = async (n: number, replicas: number, extra: Record<string, unknown> = {}): Promise<Fero[]> => {
  const ps: number[] = []
  for (let i = 0; i < n; i++) ps.push(await ports.free())
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  return Promise.all(addrs.map((listen, i) =>
    fero('scoped', {
      uuid: `n${String(i + 1).padStart(2, '0')}`,
      listen,
      hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: 50,
      redialMs: 30,
      replicas,
      ...extra,
    })))
}
const formed = (nodes: Fero[], timeout = 10_000) =>
  until(() => nodes.every((f) => (snapshot(f.cluster) as { epoch: number }).epoch >= 1), timeout)

test('SCOPED end-to-end: the gather IS the whole-resource read — identical union from every server; the shard never masquerades', async () => {
  const nodes = await spawn(3, 2)
  try {
    assert.ok(await formed(nodes), 'formed')
    //! writes via different servers land on their owners' R-sets — no node holds everything (usually)
    for (let i = 0; i < 9; i++) nodes[i % 3].data[`k${i}`] = { v: i }
    //! the union settles: every server's GATHER answers all 9 keys, wherever they live
    const settled = await until(async () => {
      const reads = await Promise.all(nodes.map((f) => f.methods.read() as Promise<Record<string, unknown>>)).catch(() => null)
      return !!reads && reads.every((r) => Object.keys(r).filter((k) => k.startsWith('k')).length === 9)
    }, 15_000)
    assert.ok(settled, 'every server gathers the full 9-key union')
    //! `await data` means the resource — the same union, typed path
    const viaThen = await (nodes[0].data as PromiseLike<Record<string, unknown>>)
    assert.equal(Object.keys(viaThen).filter((k) => k.startsWith('k')).length, 9, 'await data routes through the gather')
    //! cluster.partitions: bounded scalars reflect the scope machine
    const parts = (snapshot(nodes[0].cluster) as { partitions: { replicas: number; held: number } }).partitions
    assert.equal(parts.replicas, 2)
    assert.ok(parts.held >= 1, `n01 holds something (${parts.held})`)
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

test('SCOPED §9 equivalence: operators throw TYPED ScopedError (never a silent shard fold); non-held keys answer via the remote handle', async () => {
  const nodes = await spawn(3, 2)
  try {
    assert.ok(await formed(nodes), 'formed')
    for (let i = 0; i < 6; i++) nodes[i % 3].data[`p${i}`] = { v: i }
    await until(async () => {
      const r = await (nodes[0].methods.read() as Promise<Record<string, unknown>>).catch(() => ({}))
      return Object.keys(r).filter((k) => k.startsWith('p')).length === 6
    }, 15_000)
    //! a holistic operator on the scoped data surface: typed, hinted, NEVER a partial answer
    try {
      ;(nodes[0].data as { filter(f: unknown): unknown }).filter(() => true)
      assert.fail('filter on a scoped shard must throw')
    } catch (e) {
      const se = e as ScopedError
      assert.equal(se.scoped, true)
      assert.equal(se.reason, 'holistic')
      assert.ok(se.hint.includes('methods.read'), 'the hint names the materialize-first path')
    }
    //! key access: a held key is the raw child; a NON-held key is a one-shot remote handle — await
    // gives the owner's value; sync property reads throw typed (undefined would be a wrong answer)
    const node0 = nodes[0]
    const kernel = (node0 as unknown as { data: Record<string, unknown> })
    let held: string | null = null
    let foreign: string | null = null
    //! the probe: a foreign key's handle THROWS typed on sync property access; a held child does not
    const isForeign = (k: string): boolean => {
      try { void (kernel.data[k] as Record<string, unknown>).probe; return false } catch { return true }
    }
    for (let i = 0; i < 6; i++) {
      const k = `p${i}`
      if (isForeign(k)) { if (foreign === null) foreign = k }
      else if (held === null) held = k
    }
    if (foreign) {
      const remote = kernel.data[foreign] as PromiseLike<unknown> & Record<string, unknown>
      const v = await remote
      assert.deepEqual(v, { v: Number(foreign.slice(1)) }, 'await data.<foreign> fetches from the owner')
      try {
        void remote.v
        assert.fail('sync property access on a remote key must throw')
      } catch (e) { assert.equal((e as ScopedError).scoped, true) }
    }
    if (held) assert.deepEqual(snapshot(kernel.data[held]), { v: Number(held.slice(1)) }, 'a held key stays the raw live child')
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

test('SCOPED spoke: a client reads the WHOLE resource through its primary\'s gather, and a thrown ScopedError rehydrates typed across the wire', async () => {
  const boom = () => { throw { scoped: true, op: 'demo', reason: 'holistic', replicas: 2, hint: 'wire-rehydration pin' } satisfies ScopedError }
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', {
      uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i),
      heartbeatMs: 50, redialMs: 30, replicas: 2, boom,
    })))
  const client = await fero('scoped', { hosts: addrs, heartbeatMs: 50, redialMs: 30 })
  try {
    assert.ok(await formed(nodes), 'formed')
    for (let i = 0; i < 6; i++) nodes[i % 3].data[`c${i}`] = i
    //! the spoke's whole-resource read is GATHER-BACKED at the primary — complete, never the
    // primary's held shard (C6's client contract)
    const complete = await until(async () => {
      const r = await (client.methods.read() as Promise<Record<string, unknown>>).catch(() => ({}))
      return Object.keys(r).filter((k) => k.startsWith('c')).length === 6
    }, 15_000)
    assert.ok(complete, 'the spoke sees all 6 keys through one primary')
    //! the typed throw crosses the wire AS a ScopedError (the RESULT error value, rehydrated)
    try {
      await client.methods.boom(null)
      assert.fail('boom must reject')
    } catch (e) {
      const se = e as ScopedError
      assert.equal(se.scoped, true, 'rehydrated typed — not an Error-string wrap')
      assert.equal(se.hint, 'wire-rehydration pin')
    }
  } finally {
    await client.destroy()
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})
