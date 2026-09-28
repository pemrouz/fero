//! Tier-3 M6 slice-4 suite: scoped replication through the PUBLIC surface — real sockets, no kernel
// reach-through in the assertions beyond scope/held introspection where the claim IS about scope.
// Pins: the gather (read() with no key IS the download — one-shot union from any server), the §9
// meaning-equivalence rules (typed ScopedError, never a silent shard answer), the non-held remote
// key handle, ScopedError wire rehydration at a spoke, and cluster.partitions.

//! the battery pins (utils/battery.ts), whichever way this suite is run: the directory OFF (a single-file
// `node --test` must never meet a live box directory) and the config layer OFF (no flag, variable or file reaches a test)
import '../utils/battery.ts'

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
      heartbeat: { ms: 50 },
      redial: { ms: 30 },
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
      //! the hint is a recipe that RUNS (I-26): read() is a plain object, the rows are Object.values(…)
      assert.ok(se.hint.includes('Object.values(await methods.read()).filter('), `a true recipe, not (await methods.read()).filter: ${se.hint}`)
    }
    const evens = Object.values(await (nodes[0].methods.read() as Promise<Record<string, { v: number }>>)).filter((r) => r.v % 2 === 0)
    assert.deepEqual(evens.map((r) => r.v).sort(), [0, 2, 4], 'the recipe from the hint folds the WHOLE resource\'s rows')
    //! v4.1 f.snapshot on an ARMED scoped node: a sync local read could only be the shard — same rule, typed
    try {
      void nodes[0].snapshot
      assert.fail('snapshot on a scoped shard must throw')
    } catch (e) {
      const se = e as ScopedError
      assert.equal(se.scoped, true)
      assert.equal(se.op, 'snapshot')
    }
    //! coercing the root (I-25) is the same sync shard read — typed, never '[object Object]' of a partial
    assert.throws(() => `${nodes[0].data}`, (e: ScopedError) => e.scoped === true && e.op === 'toPrimitive' && e.reason === 'holistic')
    assert.throws(() => (nodes[0].data as { valueOf(): unknown }).valueOf(), (e: ScopedError) => e.scoped === true && e.op === 'valueOf')
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
      heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 2, methods: { boom },
    })))
  const client = await fero('scoped', { hosts: addrs, heartbeat: { ms: 50 }, redial: { ms: 30 } })
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

//! ── M6-review fix-round pins (the api slice) ─────────────────────────────────

test('COVERAGE ATTESTATION [0/28/53] — an answerer that does not ATTEST a partition can never drop its keys: acquiring/post-shed answers park, full attested absence drops', async () => {
  const { Gather } = await import('./fold.ts')
  //! a minimal fake node: self is an armed member holding nothing; h1/h2 are p's holders
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2,
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  //! a TOP-LEVEL cell: a nested leaf's remove lawfully leaves an empty parent object in the union —
  // the pin's claim is about the coverage sweep, not the substrate's parent materialization
  const cell = JSON.stringify(['p'])
  let phase = 0
  const answers: Record<number, Record<string, { c: Record<string, unknown>; att: string[] }>> = {
    //! gen 0: h2 (held) claims the cell; h1 mid-latch attests nothing
    0: { h1: { c: {}, att: [] }, h2: { c: { [cell]: { v: 7, st: [1, 3, 'o'] } }, att: ['p'] } },
    //! gen 1: THE SKEW WINDOW — h2 now mid-latch (claims nothing, attests nothing), h1 held but
    // empty. Under the pre-fix rule "answered ⇒ attests" this generation DROPPED the key (the P4
    // blink, findings 0/28: both answered, zero claims). The attestation qualifier parks it.
    1: { h1: { c: {}, att: ['p'] }, h2: { c: {}, att: [] } },
    //! gen 2: both holders attest p and neither claims — real absence, the coverage sweep drops
    2: { h1: { c: {}, att: ['p'] }, h2: { c: {}, att: ['p'] } },
  }
  const g = new Gather({ node: fake } as never, async (uuid: string) => answers[phase][uuid] as never)
  await g.refresh({ node: fake } as never, { throwOnPartial: false })
  assert.equal((snapshot(g.proxy) as Record<string, unknown>).p !== undefined, true, 'gen 0: the union holds the claimed key')
  phase = 1
  await g.refresh({ node: fake } as never, { throwOnPartial: false })
  assert.equal((snapshot(g.proxy) as Record<string, unknown>).p !== undefined, true, 'gen 1 (the skew window): PARKED — an un-attesting answerer is not absence evidence')
  phase = 2
  await g.refresh({ node: fake } as never, { throwOnPartial: false })
  assert.equal((snapshot(g.proxy) as Record<string, unknown>).p, undefined, 'gen 2: attested absence from the full holder set drops the key')
  g.destroy()
})

test('SYSTEM PLANE [5] — a user method named `read` owns the public name but never intercepts the internal keyed hop', async () => {
  const nodes = await spawn(3, 2, { methods: { read: () => 'USER-READ-SENTINEL' } })
  try {
    assert.ok(await formed(nodes), 'formed')
    for (let i = 0; i < 6; i++) nodes[i % 3].data[`u${i}`] = { v: i }
    //! the public name is the user's (methods may be named anything — the M6 rulebook)
    assert.equal(await nodes[0].methods.read(), 'USER-READ-SENTINEL', 'the user read wins the public dispatch')
    //! settle first: the union sees all 6 keys (the gather rides `await data`, never the user method)
    const settled = await until(async () => {
      const r = await (nodes[0].data as PromiseLike<Record<string, unknown>>).then((x) => x, () => ({}))
      return Object.keys(r).filter((k) => k.startsWith('u')).length === 6
    }, 15_000)
    assert.ok(settled, 'the union settled')
    //! the remote-key handle rides the SYSTEM plane: a foreign key still answers the CELL value
    const kernel = nodes[0] as unknown as { data: Record<string, unknown> }
    const isForeign = (k: string): boolean => {
      try { void (kernel.data[k] as Record<string, unknown>).probe; return false } catch { return true }
    }
    const fetched: [string, unknown][] = []
    for (let i = 0; i < 6; i++) {
      const k = `u${i}`
      if (!isForeign(k)) continue
      fetched.push([k, await (kernel.data[k] as PromiseLike<unknown>)])
    }
    assert.ok(fetched.length >= 1, 'at least one foreign key exercised the system hop')
    for (const [k, v] of fetched)
      assert.deepEqual(v, { v: Number(k.slice(1)) }, `await data.${k} fetched the true cell — not the user read's answer`)
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

test('TO-ROUTED FAIL-FAST [6] — a keyed read whose owner link is down rejects TYPED and quickly, never the silent full timeout', async () => {
  const nodes = await spawn(3, 2)
  try {
    assert.ok(await formed(nodes), 'formed')
    for (let i = 0; i < 9; i++) nodes[i % 3].data[`f${i}`] = i
    const kernel = nodes[0] as unknown as { data: Record<string, unknown> }
    const isForeign = (k: string): boolean => {
      try { void (kernel.data[k] as Record<string, unknown>); return typeof kernel.data[k] !== 'number' } catch { return true }
    }
    //! find a key owned NEITHER by n01 (so the hop is remote) — then kill every other member and
    // ask immediately, inside the pre-eviction window (the link is gone; the view has not moved)
    const foreign: string[] = []
    await until(() => { foreign.length = 0; for (let i = 0; i < 9; i++) if (isForeign(`f${i}`)) foreign.push(`f${i}`); return foreign.length > 0 }, 15_000)
    await nodes[1].destroy()
    await nodes[2].destroy()
    const t0 = Date.now()
    let outcome: 'value' | 'typed' | 'other' = 'other'
    try {
      await (kernel.data[foreign[0]] as PromiseLike<unknown>)
      outcome = 'value'
    } catch (e) {
      outcome = (e as ScopedError).scoped === true ? 'typed' : 'other'
    }
    const elapsed = Date.now() - t0
    //! either the ring already re-homed the key locally (a late view) — a value is lawful — or the
    // hop failed FAST and TYPED; what is banned is the untyped 8-second stall
    assert.notEqual(outcome, 'other', 'a failed hop is a typed ScopedError, never a generic timeout')
    assert.ok(elapsed < 5000, `answered in ${elapsed}ms — the dead-link hop must not ride the full rpc timeout`)
  } finally { await nodes[0].destroy() }
})

test('SNAPSHOT CLONE [8] — mutating an awaited whole-resource read never corrupts the union', async () => {
  const nodes = await spawn(3, 2)
  try {
    assert.ok(await formed(nodes), 'formed')
    nodes[0].data.orig = { keep: 1 }
    await until(async () => {
      const r = await (nodes[0].data as PromiseLike<Record<string, { keep: number }>>).then((x) => x, () => null)
      return !!r && r.orig?.keep === 1
    }, 15_000)
    const first = await (nodes[0].data as PromiseLike<Record<string, { keep: number }>>)
    first.orig.keep = 999 // a caller scribbling on its copy
    ;(first as Record<string, unknown>).injected = true
    const second = await (nodes[0].data as PromiseLike<Record<string, { keep: number }>>)
    assert.equal(second.orig.keep, 1, 'the union is unmoved by caller-side mutation — the return was a copy')
    assert.equal((second as Record<string, unknown>).injected, undefined, 'no injected key leaked into the shared state')
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})
