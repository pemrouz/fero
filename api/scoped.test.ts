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
import { fero, WriteRejectError, type Fero, type ScopedError } from './index.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { Ring } from '../kernel/ring.ts'
import { TUNE } from '../kernel/tune.ts'
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

//! the STATUS probe as a test (DESIGN-SCALE §11, stage 1): two members, `replicas: 1`, six `methods.update` from
// the member that does not hold the partition. Before the `acked` effect every one timed out: the owner committed
// and WACKed, but a non-holder never folds the record, so the apply join never fired. Red without kernel/write.ts
// onAck's `acked` emit: `timeout after 3000ms` on the first key.
test('ACKED [DESIGN-SCALE stage 1] — methods.update from a member that does not hold the partition resolves committed, named on the owner\'s lane; so does a spoke relayed through it; the holder shows every write', async () => {
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1 })))
  const client = await fero('scoped', { hosts: [addrs[0]], heartbeat: { ms: 50 }, redial: { ms: 30 } })
  const rows = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; origin?: string }>)
  try {
    assert.ok(await formed(nodes), 'formed')
    //! six keys whose one holder is n02 (the same ring every member builds)
    const ring = new Ring()
    ring.build(1, [['n01', addrs[0]], ['n02', addrs[1]]])
    const keys: string[] = []
    for (let i = 0; keys.length < 6; i++) if (ring.holders('q' + i, 1)[0] === 'n02') keys.push('q' + i)
    for (const k of keys) {
      const r = await nodes[0].methods.update({ key: k, value: { k } }, { timeout: 3000 })
      assert.equal(r.origin, 'n02', `${k}: committed on the owner's lane`)
      assert.equal(r.epoch, 1)
    }
    assert.equal(rows(nodes[0]).filter((r) => r.state === 'committed' && r.origin === 'n02').length, 6, 'cluster.writes names the owner on every row')
    //! a spoke relayed through the non-holder: the relay hops the lane, the spoke settles the same way
    const r = await client.methods.update({ key: keys[0], value: { k: keys[0], via: 'spoke' } }, { timeout: 3000 })
    assert.equal(r.origin, 'n02', 'the spoke\'s write names the owner too')
    assert.equal(rows(client).filter((x) => x.state === 'committed' && x.origin === 'n02').length, 1)
    //! the holder shows every write (the gather from either member reads the same)
    const seen = await until(async () => {
      const all = await (nodes[1].methods.read() as Promise<Record<string, { k: string; via?: string }>>).catch(() => ({}))
      return keys.every((k) => all[k]?.k === k) && all[keys[0]]?.via === 'spoke'
    }, 10_000)
    assert.ok(seen, 'n02 holds all six writes and the spoke\'s')
    //! a plain assignment from the non-holder lands the same way (it always did; the await was the gap)
    nodes[0].data[keys[1]] = { k: keys[1], via: 'assign' }
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, { via?: string }>)[keys[1]]?.via === 'assign', 5000))
    //! and a plain DELETE from the non-holder is a real remove, never swallowed as a no-op: its lens shows nothing
    // for the row, but the row lives at the owner (before `acked`, the write above stayed "in flight" for ever,
    // which happened to keep the delete alive; the rule is now explicit — api/data.ts #local)
    delete nodes[0].data[keys[1]]
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, unknown>)[keys[1]] === undefined, 5000), 'the delete reached the owner')
    //! a CLIENT of the non-holder (the stage-1 skeptic's A1): its fold is n01's held shard, so a row it writes
    // through n01 that n02 holds never shows in it. Once `acked` settles that write, the lens no longer sees
    // it as in flight, and a plain delete of it was swallowed as a no-op — the row stayed at n02 for ever.
    // Now a client whose feeder is scoped (its HELLO contract says replicas=1) forwards every such delete.
    client.data[keys[2]] = { k: keys[2], via: 'client' }
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, { via?: string }>)[keys[2]]?.via === 'client', 5000), 'the client write reached the owner')
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify([keys[2]]) && x.state === 'committed'), 5000), 'and settled through acked')
    delete client.data[keys[2]]
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, unknown>)[keys[2]] === undefined, 5000), 'the client delete reached the owner')
  } finally {
    await client.destroy()
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})

//! the stage-1 review's second pass: the client rule above was read LIVE off the primary link, so with no primary
// (every server link down — an outage, not only the first milliseconds) a client of a scoped cluster looked
// unscoped, and a delete issued in the gap was swallowed instead of queued for the reconnect. Now the kernel keeps
// the last primary's contract and the rule fails toward sending. Red without #feederLast: no remove row is issued
// in the gap and the row is still at n02 after the reconnect.
test('OUTAGE DELETE [DESIGN-SCALE stage 1] — a client of a scoped cluster with every server link down still forwards a delete of a row it cannot see; the row is gone at the owner after the reconnect', async () => {
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1 })))
  const client = await fero('scoped', { hosts: [addrs[0]], heartbeat: { ms: 50 }, redial: { ms: 300 } })
  const rows = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; origin?: string }>)
  const primary = () => (snapshot(client.cluster) as { me: { primary: string | null } }).me.primary
  try {
    assert.ok(await formed(nodes), 'formed')
    const ring = new Ring()
    ring.build(1, [['n01', addrs[0]], ['n02', addrs[1]]])
    let k = 'g0'
    for (let i = 0; ring.holders(k, 1)[0] !== 'n02'; i++) k = 'g' + i
    assert.ok(await until(() => primary() !== null, 5000), 'the client has a primary')
    client.data[k] = { k }
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, { k?: string }>)[k]?.k === k, 5000), 'the client write reached the owner')
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify([k]) && x.state === 'committed'), 5000), 'and settled')
    //! the outage: both server links drop; the client has no primary until the redial lands
    const d = diag(client)!
    for (const u of ['n01', 'n02']) d.drop!(u)
    assert.ok(await until(() => primary() === null, 5000), 'no primary')
    delete client.data[k]
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify([k]) && x.state === 'pending'), 2000), 'the delete is issued in the gap, not swallowed')
    assert.ok(await until(() => primary() !== null, 10_000), 'reconnected')
    assert.ok(await until(async () => ((await nodes[1].methods.read()) as Record<string, unknown>)[k] === undefined, 10_000), 'the delete issued in the gap reached the owner')
  } finally {
    await client.destroy()
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})

//! the UNSCOPED control of the outage: the kernel remembers the last primary's contract, so a client of an
// unscoped server keeps its whole fold's judgment while the links are down — a delete of an absent row is still
// a no-op there, and only a real row's delete is queued. Red without #feederLast: the absent delete is issued too.
test('OUTAGE DELETE, unscoped control — a client of an unscoped server with its link down still swallows a delete of an absent row and queues the delete of a real one', async () => {
  const port = await ports.free()
  const server = await fero('scoped', { uuid: 'solo', listen: `127.0.0.1:${port}`, heartbeat: { ms: 50 } })
  const client = await fero('scoped', { hosts: [`127.0.0.1:${port}`], heartbeat: { ms: 50 }, redial: { ms: 300 } })
  const rows = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string }>)
  const primary = () => (snapshot(client.cluster) as { me: { primary: string | null } }).me.primary
  try {
    client.data.real = { v: 1 }
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify(['real']) && x.state === 'committed'), 5000), 'settled')
    assert.ok(diag(client)!.drop!('solo'), 'the link drops')
    assert.ok(await until(() => primary() === null, 5000), 'no primary')
    delete client.data.absent
    delete client.data.real
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify(['real']) && x.state === 'pending'), 2000), 'the real row\'s delete is queued')
    assert.equal(rows(client).filter((x) => x.key === JSON.stringify(['absent'])).length, 0, 'the absent row\'s delete is a no-op: the fold is whole')
    assert.ok(await until(() => (server.snapshot as Record<string, unknown>).real === undefined, 10_000), 'the queued delete lands after the reconnect')
  } finally {
    await client.destroy()
    await server.destroy()
  }
})

//! the other half of the rule: with NO contract known (a client that has never had a primary) the fold is empty and
// says nothing about what the server holds, so a delete is forwarded, never swallowed. Red with the old
// `!SCOPED_FEEDER.test(contract ?? '')`: no row is issued.
test('PRE-HELLO DELETE [DESIGN-SCALE stage 1] — a client that has never reached a server forwards a delete of a row it cannot see; it rides out with the first connection', async () => {
  const port = await ports.free()
  const client = await fero('scoped', { hosts: [`127.0.0.1:${port}`], heartbeat: { ms: 50 }, redial: { ms: 100 } })
  const rows = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string }>)
  let server: Fero | undefined
  try {
    delete client.data.nothing
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify(['nothing']) && x.state === 'pending'), 2000), 'issued, not swallowed')
    server = await fero('scoped', { uuid: 'solo', listen: `127.0.0.1:${port}`, heartbeat: { ms: 50 } })
    assert.ok(await until(() => rows(client).some((x) => x.key === JSON.stringify(['nothing']) && x.state === 'committed'), 5000), 'committed once the server is up')
  } finally {
    await client.destroy()
    await server?.destroy()
  }
})

//! the STATUS array gap (DESIGN-SCALE §11, Q12): a scoped member that does not hold an array row cannot see its
// shape, so its remove of `g[0]` passed its own admit and was forwarded; the owner committed a tombstone that shows
// nothing. Now the owner re-checks the shape (NodeOpts.admit → Bind.hole). Red without the kernel re-check: the
// remove resolves committed instead of rejecting 'sparse-hole'.
test('OWNER RE-CHECK [DESIGN-SCALE §11 Q12] — a non-holder\'s forwarded remove of an array element is refused sparse-hole AT THE OWNER, and the issuer sees the typed reject; a remove under an object row still commits', async () => {
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1 })))
  const rows = (f: Fero) => Object.values(f.cluster.writes.snapshot() as Record<string, { key: string; state: string; reason?: string }>)
  try {
    assert.ok(await formed(nodes), 'formed')
    const ring = new Ring()
    ring.build(1, [['n01', addrs[0]], ['n02', addrs[1]]])
    const held = (prefix: string) => { for (let i = 0; ; i++) if (ring.holders(prefix + i, 1)[0] === 'n02') return prefix + i }
    const g = held('g'), o = held('o')
    //! the holder writes an array row and an object row; n01 holds neither, so it cannot see their shape
    await nodes[1].methods.update({ key: g, value: [1, 2, 3] })
    await nodes[1].methods.update({ key: o, value: { x: 1, y: 2 } })
    const e = await nodes[0].methods.remove({ key: [g, '0'] }, { timeout: 3000 }).then(() => null, (err: unknown) => err) as WriteRejectError | null
    assert.ok(e instanceof WriteRejectError, `refused typed, got ${String(e)}`)
    assert.equal(e.reason, 'sparse-hole')
    assert.equal(e.reached, 'issued')
    assert.ok(await until(() => rows(nodes[0]).some((r) => r.key === JSON.stringify([g, '0']) && r.state === 'rejected' && r.reason === 'sparse-hole'), 2000), 'cluster.writes names the reason')
    //! nothing was stamped: the array is whole at the holder
    assert.deepEqual(((await nodes[1].methods.read()) as Record<string, unknown>)[g], [1, 2, 3])
    //! a CLIENT's relayed remove through the non-holder (the stage-1 skeptic's A2): n01 relays it unseen (its
    // admit cannot see the row either), the owner refuses it, and the spoke sees the same typed reject
    const client = await fero('scoped', { hosts: [addrs[0]], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    try {
      const ce = await client.methods.remove({ key: [g, '0'] }, { timeout: 3000 }).then(() => null, (err: unknown) => err) as WriteRejectError | null
      assert.ok(ce instanceof WriteRejectError, `the spoke's remove refused typed, got ${String(ce)}`)
      assert.equal(ce.reason, 'sparse-hole')
      assert.equal(ce.reached, 'issued')
      assert.deepEqual(((await nodes[1].methods.read()) as Record<string, unknown>)[g], [1, 2, 3], 'still whole')
    } finally { await client.destroy() }
    //! a MIXED batch (A3): four removes/updates issued together from the non-holder travel in one forwarded
    // frame; the owner judges each — the two holes refused, the field remove and the update committed
    const mixed = await Promise.allSettled([
      nodes[0].methods.remove({ key: [g, '0'] }, { timeout: 3000 }),
      nodes[0].methods.remove({ key: [o, 'x'] }, { timeout: 3000 }),
      nodes[0].methods.remove({ key: [g, '1'] }, { timeout: 3000 }),
      nodes[0].methods.update({ key: [o, 'z'], value: 3 }, { timeout: 3000 }),
    ])
    assert.deepEqual(mixed.map((m) => m.status === 'rejected' ? (m.reason as WriteRejectError).reason : (m.value as { origin: string }).origin), ['sparse-hole', 'n02', 'sparse-hole', 'n02'], 'each record judged on its own')
    assert.ok(await until(async () => { const v = ((await nodes[1].methods.read()) as Record<string, { x?: number; y?: number; z?: number }>)[o]; return v?.x === undefined && v?.y === 2 && v?.z === 3 }, 5000), 'the field remove and the update landed at the holder')
    assert.deepEqual(((await nodes[1].methods.read()) as Record<string, unknown>)[g], [1, 2, 3], 'the array is still whole')
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

//! ── M6-review fix-round pins (the api slice) ─────────────────────────────────

test('COVERAGE ATTESTATION [0/28/53] — an answerer that does not ATTEST a partition can never drop its keys: acquiring/post-shed answers park, full attested absence drops', async () => {
  const { Gather } = await import('./fold.ts')
  //! a minimal fake node: self is an armed member holding nothing; h1/h2 are p's holders
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: TUNE,
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

//! V4-51: a member whose claims are bigger than one frame refuses its `rows` answer typed ('too-large'). It is
// reachable, and retrying cannot help, so the gather must never file it as unreachable ('retry when the view heals' —
// wrong), and the live union must never park its old claims silently: the one-shot rejects too-large, the live path
// ends its subscribers (onRefused) and remembers the refusal until a generation gathers every share.
test('TOO-LARGE [V4-51] — the gather names a member whose rows do not fit one frame: one-shot rejects too-large, not unreachable; the live union ends its subscribers; an all-fit generation clears it', async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['x', ''], ['y', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['x', 'y'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const big = { scoped: true, op: 'rows', reason: 'too-large', replicas: 2, hint: 'the answer is bigger than one frame' }
  const fine = { c: {}, att: ['p'] }
  let answer: Record<string, () => Promise<unknown>> = { x: async () => { throw big }, y: async () => fine }
  const refused: ScopedError[] = []
  const g = new Gather({ node: fake } as never, (uuid: string) => answer[uuid]() as never, undefined, (r) => refused.push(r))
  try {
    await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), (e: ScopedError) => {
      assert.deepEqual({ ...e, hint: '' }, { scoped: true, op: 'gather', reason: 'too-large', replicas: 2, missing: ['x'], hint: '' })
      assert.match(e.hint, /^the rows x holds are bigger than one frame \(8 KiB\), so the whole-resource read cannot gather them: read one key at a time/)
      return true
    })
    assert.deepEqual(refused, [], 'a one-shot read rejects; it does not end the live reads')
    //! too-large wins over unreachable when both happen: retrying cannot help the one that is too large
    answer = { x: async () => { throw big }, y: async () => { throw new Error('timeout') } }
    await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), (e: ScopedError) => e.reason === 'too-large' && e.missing!.join() === 'x')
    //! the live path: onRefused once, the refusal remembered for the next live read
    answer = { x: async () => { throw big }, y: async () => fine }
    await g.refresh({ node: fake } as never, { throwOnPartial: false })
    assert.equal(refused.length, 1)
    assert.equal(refused[0].reason, 'too-large')
    assert.equal(g.refused?.reason, 'too-large')
    //! an unreachable member alone is lawful parking on the live path, as before: no refusal
    answer = { x: async () => fine, y: async () => { throw new Error('timeout') } }
    await g.refresh({ node: fake } as never, { throwOnPartial: false })
    assert.equal(g.refused, null, 'every share that answered fit: the refusal clears')
    assert.equal(refused.length, 1)
  } finally { g.destroy() }
})

//! V4-52: the gather's one-shot answer (`await data` and methods.read() on a scoped server) was structuredClone of the
// union, not what a client's whole read decodes from the reply: a value the codec changes came back unchanged, and a
// union a reply could not carry came back all the same. It is copyOf with a reply's limits now. The union's values
// are planted through the members' answers (a fake node, as above).
test("the gather's one-shot answer is what a client's whole read decodes: the codec's copy of the union, refused when a reply could not carry it", async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: TUNE,
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const nest = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = [v]; return v }
  const claim = (v: unknown, seq: number) => ({ v, st: [1, seq, 'h1'] as [number, number, string] })
  let rows: Record<string, unknown> = { a: claim({ when: new Date(0), s: 'x\uD800', m: new Map([[1, 2]]) }, 1) }
  const g = new Gather({ node: fake } as never, async (uuid: string) => (uuid === 'h1' ? { c: Object.fromEntries(Object.entries(rows).map(([k, c]) => [JSON.stringify([k]), c])), att: ['a', 'deep'] } : { c: {}, att: ['a', 'deep'] }) as never)
  const got = await g.refresh({ node: fake } as never, { throwOnPartial: true }) as Record<string, unknown>
  assert.deepStrictEqual(got, { a: { when: {}, s: 'x\uFFFD', m: {} } }, 'the value a client decodes')
  assert.notEqual(got.a, (snapshot(g.proxy) as Record<string, unknown>).a, 'a copy, never the live union')
  //! the row 62 deep sits 63 deep in the answer, the most a reply carries; one level more is refused
  rows = { deep: claim(nest(62), 2) }
  assert.deepStrictEqual(((await g.refresh({ node: fake } as never, { throwOnPartial: true })) as Record<string, unknown>).deep, nest(62))
  rows = { deep: claim(nest(63), 3) }
  await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), /^Error: the result could not be sent: deeper than 63 levels$/)
  g.destroy()
})

//! the V4-51/52 review: the gather judged a reply's size by copyOf's charge, a worst case (3 bytes a character, 8 a
// number) that ran 1.5-4.5x the real reply, so a scoped cluster refused whole reads a client's reply would carry (from
// about 57-90 MiB at the production cap) — and a keyed read during a handover, which reads ONE row of the union, was
// refused because the whole union would not fit. The real encoder decides now, and a keyed answer is its row's copy.
test("TOO-LARGE BY REAL SIZE [V4-51/52] — the gather refuses only a reply that really would not fit one frame; a keyed answer is one row's copy", async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const row = (i: number) => ({ n: Array.from({ length: 16 }, (_, k) => k), s: 'x'.repeat(20), i })
  const claims = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [JSON.stringify([`r${i}`]), { v: row(i), st: [1, i + 1, 'h1'] }]))
  let n = 60
  const parts = () => Array.from({ length: n }, (_, i) => `r${i}`)
  const g = new Gather({ node: fake } as never, async (uuid: string) => (uuid === 'h1' ? { c: claims(n), att: parts() } : { c: {}, att: parts() }) as never)
  try {
    //! 60 rows: charged about 15 KB at the worst case, the real reply about 5 KB — answered
    const got = await g.refresh({ node: fake } as never, { throwOnPartial: true }) as Record<string, unknown>
    assert.equal(Object.keys(got).length, 60)
    assert.deepStrictEqual(got.r7, row(7))
    //! 300 rows: the real reply passes 8 KiB — refused too-large, naming the frame
    n = 300
    await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), (e: ScopedError) =>
      e.reason === 'too-large' && e.op === 'read' && /^the whole resource is bigger than one frame \(8 KiB\)/.test(e.hint))
    //! a keyed answer reads one row of that same union: answered
    assert.deepStrictEqual(await g.keyed('r250'), row(250))
  } finally { g.destroy() }
})

test('OVERLAPPING CELLS (V4-18) — the gather folds claims by depth with the kernel\'s stamp rule: a field remove newer than its row takes the field out, a field at or below an ancestor\'s stamp is hidden, a parked field never tears into a live row', async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: TUNE,
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const g = JSON.stringify(['g']), ga = JSON.stringify(['g', 'a']), gc = JSON.stringify(['g', 'c'])
  const gb = JSON.stringify(['g', 'b']), gax = JSON.stringify(['g', 'a', 'x'])
  const row = { v: { a: 1, b: 2 }, st: [1, 5, 'bb'] as [number, number, string] }
  let phase = 0
  const answers: Record<number, Record<string, { c: Record<string, unknown>; att: string[] }>> = {
    //! gen 0: h1 holds the row, h2 the field remove stamped ABOVE it, both in both orders of answering
    0: { h1: { c: { [g]: row }, att: ['g'] }, h2: { c: { [ga]: { st: [1, 7, 'cc'], t: 1 } }, att: ['g'] } },
    1: { h1: { c: { [ga]: { st: [1, 7, 'cc'], t: 1 } }, att: ['g'] }, h2: { c: { [g]: row }, att: ['g'] } },
    //! gen 2: a field write BELOW the row's stamp (an older fact the row carried) and a field write ABOVE it
    2: { h1: { c: { [g]: row, [ga]: { v: 0, st: [1, 3, 'cc'] } }, att: ['g'] }, h2: { c: { [gc]: { v: 9, st: [1, 9, 'cc'] } }, att: ['g'] } },
    //! gen 3: a row REMOVE above an older field hides it; a field above the row's remove re-makes the row
    3: { h1: { c: { [g]: { st: [1, 8, 'bb'], t: 1 }, [ga]: { v: 0, st: [1, 3, 'cc'] } }, att: ['g'] }, h2: { c: {}, att: ['g'] } },
    4: { h1: { c: { [g]: { st: [1, 8, 'bb'], t: 1 } }, att: ['g'] }, h2: { c: { [gc]: { v: 9, st: [1, 9, 'cc'] } }, att: ['g'] } },
    //! gen 5: the row is back whole; gen 6: nobody claims ['g','c'] any more (attested absence) — the
    // coverage drop of the FIELD cell must not tear `c` out of the row's own value
    5: { h1: { c: { [g]: { v: { a: 1, c: 3 }, st: [1, 11, 'bb'] } }, att: ['g'] }, h2: { c: { [gc]: { v: 9, st: [1, 12, 'cc'] } }, att: ['g'] } },
    6: { h1: { c: { [g]: { v: { a: 1, c: 3 }, st: [1, 11, 'bb'] } }, att: ['g'] }, h2: { c: {}, att: ['g'] } },
    //! gen 7: the TIE — a swept field ships as a tombstone at exactly its row's stamp (the kernel gives a
    // swept cell the parent's stamp): at or below hides it, so the row's own `a` must stay
    7: { h1: { c: { [g]: { v: { a: 1, c: 3 }, st: [1, 13, 'bb'] }, [ga]: { st: [1, 13, 'bb'], t: 1 } }, att: ['g'] }, h2: { c: {}, att: ['g'] } },
    //! gen 8-9: NOBODY claims the row any more (h1 attests its absence — the coverage drop takes it);
    // a field alone makes the row up; then that field's remove — the row the field alone had made up
    // must go too (the kernel's un-vivify), not stay as {} (the reviewer's shape: the base tree and the
    // first fold-by-depth left {g:{}} here, where the node's own screen shows {})
    8: { h1: { c: {}, att: ['g'] }, h2: { c: { [gb]: { v: 1, st: [1, 15, 'cc'] } }, att: ['g'] } },
    9: { h1: { c: {}, att: ['g'] }, h2: { c: { [gb]: { st: [1, 16, 'cc'], t: 1 } }, att: ['g'] } },
    //! gen 10-11: the same two levels deep — both made-up levels go
    10: { h1: { c: {}, att: ['g'] }, h2: { c: { [gax]: { v: 1, st: [1, 17, 'cc'] } }, att: ['g'] } },
    11: { h1: { c: {}, att: ['g'] }, h2: { c: { [gax]: { st: [1, 18, 'cc'], t: 1 } }, att: ['g'] } },
    //! gen 12-13: the control — an empty object the row's OWN value holds was never made up: it stays
    12: { h1: { c: { [g]: { v: { a: {} }, st: [1, 19, 'bb'] } }, att: ['g'] }, h2: { c: { [gax]: { v: 1, st: [1, 20, 'cc'] } }, att: ['g'] } },
    13: { h1: { c: { [g]: { v: { a: {} }, st: [1, 19, 'bb'] } }, att: ['g'] }, h2: { c: { [gax]: { st: [1, 21, 'cc'], t: 1 } }, att: ['g'] } },
    //! gen 14-15: the USER wrote the row as `{}` (its own live claim); a field lands in it, then that
    // field's remove — the row's own `{}` projected whole this generation, so it stays
    14: { h1: { c: { [g]: { v: {}, st: [1, 22, 'bb'] } }, att: ['g'] }, h2: { c: { [gb]: { v: 1, st: [1, 23, 'cc'] } }, att: ['g'] } },
    15: { h1: { c: { [g]: { v: {}, st: [1, 22, 'bb'] } }, att: ['g'] }, h2: { c: { [gb]: { st: [1, 24, 'cc'], t: 1 } }, att: ['g'] } },
    //! gen 16-17: the same one level down — the user wrote the FIELD ['g','a'] as `{}` over the row's a:1
    16: { h1: { c: { [g]: { v: { a: 1 }, st: [1, 25, 'bb'] } }, att: ['g'] }, h2: { c: { [ga]: { v: {}, st: [1, 26, 'cc'] }, [gax]: { v: 1, st: [1, 27, 'cc'] } }, att: ['g'] } },
    17: { h1: { c: { [g]: { v: { a: 1 }, st: [1, 25, 'bb'] } }, att: ['g'] }, h2: { c: { [ga]: { v: {}, st: [1, 26, 'cc'] }, [gax]: { st: [1, 28, 'cc'], t: 1 } }, att: ['g'] } },
    //! gen 18-19: a PARKED level — the row's holder h1 answers without attesting `g` (still acquiring),
    // so nobody claims the row this generation but it is not covered: its last value stands, and the
    // field remove under it takes only the field
    18: { h1: { c: { [g]: { v: {}, st: [1, 30, 'bb'] } }, att: ['g'] }, h2: { c: { [gb]: { v: 1, st: [1, 31, 'cc'] } }, att: ['g'] } },
    19: { h1: { c: {}, att: [] }, h2: { c: { [gb]: { st: [1, 32, 'cc'], t: 1 } }, att: ['g'] } },
  }
  const gather = new Gather({ node: fake } as never, async (uuid: string) => answers[phase][uuid] as never)
  const expect = async (want: unknown, why: string) => {
    await gather.refresh({ node: fake } as never, { throwOnPartial: false })
    assert.deepEqual(snapshot(gather.proxy), want, why)
  }
  await expect({ g: { b: 2 } }, 'gen 0: the field remove above the row takes `a` out of it')
  phase = 1; await expect({ g: { b: 2 } }, 'gen 1: the same with the answers the other way round')
  phase = 2; await expect({ g: { a: 1, b: 2, c: 9 } }, 'gen 2: the older field is hidden by the row, the newer one shows on top')
  phase = 3; await expect({}, 'gen 3: a row remove above the field hides it — the row does not come back as {a:0}')
  phase = 4; await expect({ g: { c: 9 } }, 'gen 4: a field above the row remove re-makes the row with that field')
  phase = 5; await expect({ g: { a: 1, c: 9 } }, 'gen 5: the row is back, the newer field on top')
  phase = 6; await expect({ g: { a: 1, c: 3 } }, 'gen 6: the field cell dropped by coverage — the row\'s own `c` stands')
  phase = 7; await expect({ g: { a: 1, c: 3 } }, 'gen 7: a tombstone at EXACTLY the row\'s stamp is hidden — the row keeps its own `a`')
  phase = 8; await expect({ g: { b: 1 } }, 'gen 8: a field alone makes the row up (nobody claims the row)')
  phase = 9; await expect({}, 'gen 9: that field\'s remove takes the row it alone had made up with it')
  phase = 10; await expect({ g: { a: { x: 1 } } }, 'gen 10: a depth-3 field makes two levels up')
  phase = 11; await expect({}, 'gen 11: its remove takes both made-up levels back')
  phase = 12; await expect({ g: { a: { x: 1 } } }, 'gen 12: the row holds `a` as an empty object itself, the field lands in it')
  phase = 13; await expect({ g: { a: {} } }, 'gen 13: the field\'s remove leaves the row\'s own empty object — it was never made up')
  phase = 14; await expect({ g: { b: 1 } }, 'gen 14: a field lands in the row the user wrote as {}')
  phase = 15; await expect({ g: {} }, 'gen 15: the field\'s remove leaves the user\'s own {} row — its own claim projected')
  phase = 16; await expect({ g: { a: { x: 1 } } }, 'gen 16: a field lands in the field the user wrote as {}')
  phase = 17; await expect({ g: { a: {} } }, 'gen 17: the deeper field\'s remove leaves the user\'s own {} field')
  phase = 18; await expect({ g: { b: 1 } }, 'gen 18: a field lands in the {} row')
  phase = 19; await expect({ g: {} }, 'gen 19: the row is PARKED (its holder attests nothing yet) — its last value stands, only the field goes')
  gather.destroy()
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

//! DRAIN-THEN-GO (DESIGN-SCALE §7 stage 1 (b), 2026-10-10) through the public surface: destroy() on a scoped member
// waits for the new holders to copy what it held, and resolves the verdict — true for a stop that was clean all the
// way, false when there was nobody left to copy to (the last member), with cluster.me.undrained naming the count.
test('DRAIN [DESIGN-SCALE stage 1 (b)] — scaling 2→1 at replicas 1 by destroy(): the leaver\'s rows are all at the survivor when destroy() resolves true; the last member\'s destroy() resolves false and cluster.me.undrained counts its partitions', async () => {
  const nodes = await spawn(2, 1)
  try {
    assert.ok(await formed(nodes))
    for (let i = 0; i < 12; i++) nodes[i % 2].data['row' + i] = { v: i }
    const whole = () => nodes[0].data as PromiseLike<Record<string, { v: number }>>
    assert.ok(await until(async () => Object.keys(await whole()).length === 12), 'every row committed somewhere')
    const me = (f: Fero) => (snapshot(f.cluster) as { me: { undrained: number } }).me
    assert.equal(me(nodes[1]).undrained, 0, 'nothing undrained before the stop')
    const heldBefore = (snapshot(nodes[0].cluster) as { partitions: { held: number } }).partitions.held
    assert.ok(heldBefore > 0 && heldBefore < 12, `the survivor holds its own share before the stop (${heldBefore} of 12)`)
    //! the leaver: the view shrinks by its ballot, then it holds `left` until n01 has attested every partition it held
    assert.equal(await nodes[1].destroy(), true, 'a clean stop all the way: the vote came back AND the rows were copied')
    //! the survivor's OWN count first: the gather below goes on showing rows of a member that has gone, so it alone
    // cannot tell a drained stop from one that took 8 rows with it (the skeptic's probe, 2026-10-10)
    const held = () => (snapshot(nodes[0].cluster) as { partitions: { held: number } }).partitions.held
    assert.equal(held(), 12, 'the survivor itself holds all twelve partitions the instant destroy() resolves true')
    const after = await whole()
    assert.deepEqual(Object.keys(after).sort(), Array.from({ length: 12 }, (_, i) => 'row' + i).sort(), 'the survivor alone holds every row')
    assert.deepEqual(Array.from({ length: 12 }, (_, i) => after['row' + i].v), Array.from({ length: 12 }, (_, i) => i), 'with the right values')
    assert.equal(me(nodes[0]).undrained, 0)
    //! the last member: nobody to copy to — it goes at once and says so (its rows have no other home without a dir)
    assert.equal(await nodes[0].destroy(), false, 'the last member\'s stop is not a clean one')
    assert.equal(me(nodes[0]).undrained, 12, 'all twelve partitions went with it — folded into cluster.me before the teardown')
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

test('DRAIN, the verdict rides destroy(): an UNSCOPED pair resolves true on both stops (the last member simply goes, as V4-6 says) and cluster.me.undrained stays 0', async () => {
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) => fero('plain', { uuid: `u${i}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 } })))
  try {
    assert.ok(await formed(nodes))
    nodes[1].data.k = 1
    assert.ok(await until(() => (snapshot(nodes[0].data) as { k?: number }).k === 1))
    assert.equal(await nodes[1].destroy(), true)
    assert.equal(await nodes[0].destroy(), true)
    assert.equal((snapshot(nodes[0].cluster) as { me: { undrained: number } }).me.undrained, 0)
  } finally { await Promise.all(nodes.map((n) => n.destroy())) }
})

//! the fix check: a keyed refresh read the union with `all[key]`, so an absent 'constructor' row answered (or was
// refused as) Object.prototype's function; a live tick built a whole-union answer nobody reads. Own rows only, no
// answer for `want: false`. (A keyed read refused for a member's WHOLE share was told to retry here; since V4-65 it
// asks for the row's partition only — the KEYED HANDOVER test below.)
test('a keyed gather reads only its own row, a refresh nobody reads builds no answer, and a keyed read is not refused for a member\'s whole share', async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const rows = { c: { [JSON.stringify(['a'])]: { v: { x: 1 }, st: [1, 1, 'h1'] }, [JSON.stringify(['big'])]: { v: { s: 'x'.repeat(9000) }, st: [1, 2, 'h1'] } }, att: ['a', 'big'] }
  let h1: (p?: string) => Promise<unknown> = async () => rows
  const g = new Gather({ node: fake } as never, async (uuid: string, _t: number, p?: string) => (uuid === 'h1' ? h1(p) : { c: {}, att: ['a', 'big'] }) as never)
  try {
    for (const key of ['constructor', 'toString', '__proto__', 'nope'])
      assert.equal(await g.keyed(key), undefined, key)
    assert.deepStrictEqual(await g.keyed('a'), { x: 1 })
    assert.equal(await g.refresh({ node: fake } as never, { throwOnPartial: false, want: false }), undefined, 'no answer is built for nobody')
    //! the last check: one row bigger than one frame, read by its key, is told to read a smaller part of the row
    await assert.rejects(g.keyed('big'), (e: ScopedError) =>
      e.reason === 'too-large' && e.op === 'read' && /^the answer is bigger than one frame \(8 KiB\), so fero cannot send it: read a smaller part of the row with a method that returns it$/.test(e.hint))
    //! h1's WHOLE share no longer fits; one partition of it does: the whole read is refused, the keyed read answers
    h1 = async (p) => { if (p === undefined) throw { scoped: true, op: 'rows', reason: 'too-large', replicas: 2, hint: 'the answer is bigger than one frame' }; return rows }
    await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), (e: ScopedError) => e.reason === 'too-large')
    assert.deepStrictEqual(await g.keyed('a'), { x: 1 })
    //! the last check: the stored refusal, which the next live whole read hears, keeps the whole read's words — a keyed read leaves it
    assert.match(g.refused!.hint, /so the whole-resource read cannot gather them: read one key at a time \(methods\.read\(key\)\)$/)
  } finally { g.destroy() }
})

//! V4-65 (STATUS: "A keyed read during a handover can be refused while a member's whole share is bigger than one
// frame"): a keyed read on the row's owner while it is still taking the row over gathered EVERY member's whole share,
// so one member whose share passed one frame refused its answer 'too-large' and the read was refused until the
// handover ended. It asks each member for that row's partition only now, and folds the answers into the live union
// for that row alone: the row changes there as a whole generation would change it, and every other row stays as it was.
test('KEYED HANDOVER [V4-65] — a keyed read asks each member for its row\'s partition only: a member whose whole share passes one frame answers it; the answers fold into the live union for that row alone, parking included', async () => {
  const { Gather } = await import('./fold.ts')
  //! self owns `a` and is still taking it over (it holds nothing, attests nothing); h1 is the row's old holder, h2 a member
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['self', 'h1'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const A = JSON.stringify(['a']), AY = JSON.stringify(['a', 'y']), B = JSON.stringify(['b'])
  const tooBig = { scoped: true, op: 'rows', reason: 'too-large', replicas: 2, hint: 'the answer is bigger than one frame' }
  type Rows = { c: Record<string, unknown>; att: string[] }
  //! each member answers its WHOLE share (p undefined) or one partition's; h1's whole share no longer fits one frame
  let h1: { whole: Rows | null; a: Rows | 'big' }, h2: { whole: Rows; a: Rows | 'down' | 'ignores' | 'big' }
  const asked: (string | undefined)[] = []
  const g = new Gather({ node: fake } as never, async (uuid: string, _t: number, p?: string) => {
    asked.push(p)
    if (uuid === 'h1') {
      if (p === undefined) { if (h1.whole === null) throw tooBig; return h1.whole as never }
      if (h1.a === 'big') throw tooBig
      return h1.a as never
    }
    if (p !== undefined && h2.a === 'down') throw new Error('timeout')
    if (p !== undefined && h2.a === 'big') throw tooBig
    return (p === undefined || h2.a === 'ignores' ? h2.whole : h2.a) as never
  })
  try {
    //! gen 0: every share fits — the live union has the row
    h1 = { whole: { c: { [A]: { v: { x: 1 }, st: [1, 1, 'h1'] }, [B]: { v: 1, st: [1, 2, 'h1'] } }, att: ['a', 'b'] }, a: 'big' }
    h2 = { whole: { c: {}, att: ['b'] }, a: { c: {}, att: [] } }
    await g.refresh({ node: fake } as never, { throwOnPartial: true })
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 1 }, b: 1 })
    //! h1 now holds more than one frame: the whole read is refused, as V4-51 says…
    h1 = { whole: null, a: { c: { [A]: { v: { x: 5 }, st: [1, 9, 'h1'] } }, att: ['a'] } }
    h2 = { whole: { c: {}, att: ['b'] }, a: { c: { [AY]: { v: 2, st: [1, 10, 'h2'] } }, att: [] } }
    await assert.rejects(g.refresh({ node: fake } as never, { throwOnPartial: true }), (e: ScopedError) => e.reason === 'too-large' && e.missing!.join() === 'h1')
    //! …and the keyed read answers: each member was asked for `a` alone, and the answers fold across depth
    asked.length = 0
    assert.deepStrictEqual(await g.keyed('a'), { x: 5, y: 2 }, 'h1\'s row and h2\'s newer field')
    assert.deepStrictEqual(asked, ['a', 'a'], 'every member was asked for the partition, none for its whole share')
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 5, y: 2 }, b: 1 }, 'the live union takes the row, and only the row')
    //! a member of an older version ignores the argument and sends its whole share, with a NEWER `b`: the fold sees the
    // row alone. The whole share is cut BEFORE the fold (the round-3 review: the answer for the row is the same uncut):
    // uncut, h2's `b` would land in the live union at a keyed read of `a`
    h2 = { whole: { c: { [AY]: { v: 2, st: [1, 10, 'h2'] }, [B]: { v: 7, st: [1, 11, 'h2'] } }, att: ['a', 'b'] }, a: 'ignores' }
    assert.deepStrictEqual(await g.keyed('a'), { x: 5, y: 2 })
    assert.equal(await g.keyed('zz'), undefined, 'a row nobody has')
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 5, y: 2 }, b: 1 }, '`b` is as it was: h2\'s whole share was cut to the row')
    //! PARKING: h1 answers in the skew window (no claim, no attestation for `a`) and nobody else claims the row — not
    // covered, so the last value the row showed stands (KEYED PARKING, below, has more)
    h1 = { whole: null, a: { c: {}, att: [] } }
    h2 = { whole: { c: {}, att: ['b'] }, a: { c: {}, att: [] } }
    assert.deepStrictEqual(await g.keyed('a'), { x: 5, y: 2 }, 'the row parks at its last value')
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 5, y: 2 }, b: 1 })
    //! attested absence by every holder (self is not one of them in this ring) drops it: a real delete, in the live union too
    fake.writes.ring.holders = () => ['h1', 'h2']
    h1 = { whole: null, a: { c: {}, att: ['a'] } }
    h2 = { whole: { c: {}, att: ['a', 'b'] }, a: { c: {}, att: ['a'] } }
    assert.equal(await g.keyed('a'), undefined, 'covered absence: the row is gone')
    assert.deepStrictEqual(snapshot(g.proxy), { b: 1 })
    //! the refusals that stay: the row's own claims at a member pass one frame (retrying cannot help), and a member down
    h1 = { whole: null, a: 'big' }
    await assert.rejects(g.keyed('a'), (e: ScopedError) => {
      assert.deepEqual({ ...e, hint: '' }, { scoped: true, op: 'gather', reason: 'too-large', replicas: 2, partition: 'a', missing: ['h1'], hint: '' })
      assert.equal(e.hint, 'what h1 holds for this row is bigger than one frame (8 KiB), so fero cannot send it: read a smaller part of the row with a method that returns it (if h1 runs an older fero, it sends all its rows, not this row alone: then retry once this key has finished changing owner)')
      return true
    })
    //! two members too large: the hint names both, in the plural (the round-4 review)
    h2 = { whole: { c: {}, att: ['b'] }, a: 'big' }
    await assert.rejects(g.keyed('a'), (e: ScopedError) => {
      assert.deepEqual(e.missing, ['h1', 'h2'])
      assert.equal(e.hint, 'what h1, h2 hold for this row is bigger than one frame (8 KiB), so fero cannot send it: read a smaller part of the row with a method that returns it (if h1, h2 run an older fero, they send all their rows, not this row alone: then retry once this key has finished changing owner)')
      return true
    })
    h1 = { whole: null, a: { c: {}, att: ['a'] } }
    h2 = { whole: { c: {}, att: ['b'] }, a: 'down' }
    await assert.rejects(g.keyed('a'), (e: ScopedError) => e.reason === 'unreachable' && e.partition === 'a' && e.missing!.join() === 'h2')
  } finally { g.destroy() }
})

//! V4-65, the round-2 review: the keyed fold started from a fresh COPY of the live union on every read, so on a node
// whose live union was never read, two keyed reads did not park across each other. The second, in the skew window (the
// old holder has shed: no claim, no attestation; the holders still acquiring), read the row absent, where the one
// registry of the whole-read gather, which base's keyed read wrote as a whole refresh, kept its last value. And a row a
// keyed read had seen deleted came back from the live union's older copy. A keyed read folds into that one registry
// again now (the round-4 review), for its row alone, so the row parks across keyed reads and live generations alike.
test('KEYED PARKING [V4-65] — keyed reads park across each other and across the live generations, in the one registry', async () => {
  const { Gather } = await import('./fold.ts')
  //! self owns `a` and `b` and is taking them over (it holds nothing, attests nothing); h1 is the old holder, h2 a co-holder
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: (): string[] => ['self', 'h2'] } },
    scope: { entries: new Map() },
    versions: new Map(), state: new Map(),
  }
  const A = JSON.stringify(['a']), AY = JSON.stringify(['a', 'y']), B = JSON.stringify(['b'])
  type Rows = { c: Record<string, unknown>; att: string[] }
  const none: Rows = { c: {}, att: [] }
  let h1: Rows = none, h2: Rows = none
  //! each member sends its whole share whatever it is asked (an older member): keyed() cuts it to the row
  const g = new Gather({ node: fake } as never, async (u: string) => structuredClone(u === 'h1' ? h1 : h2) as never)
  const live = () => g.refresh({ node: fake } as never, { throwOnPartial: true, want: false })
  try {
    //! the probe's shape: read 1, h1 claims the row; read 2, h1 has shed and nobody attests `a`
    h1 = { c: { [A]: { v: { x: 1 }, st: [1, 1, 'h1'] } }, att: ['a'] }
    assert.deepStrictEqual(await g.keyed('a'), { x: 1 })
    h1 = none
    assert.deepStrictEqual(await g.keyed('a'), { x: 1 }, 'read 2 parks: the row is not covered, so its last value stands')
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 1 } }, 'the live union holds what the keyed reads saw')
    //! a live generation between two keyed reads: a newer value that only it heard
    h1 = { c: { [A]: { v: { x: 2 }, st: [1, 5, 'h1'] }, [B]: { v: 1, st: [1, 6, 'h1'] } }, att: ['a', 'b'] }
    await live()
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 2 }, b: 1 })
    h1 = none
    assert.deepStrictEqual(await g.keyed('a'), { x: 2 }, 'the last value is the live generation\'s')
    //! a newer field only a keyed read heard: h2 claims it, then sheds it too
    h2 = { c: { [AY]: { v: 3, st: [1, 7, 'h2'] } }, att: [] }
    assert.deepStrictEqual(await g.keyed('a'), { x: 2, y: 3 })
    h2 = none
    assert.deepStrictEqual(await g.keyed('a'), { x: 2, y: 3 }, 'the field parks across keyed reads')
    await live()
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 2, y: 3 }, b: 1 }, 'and across a live generation in the skew window')
    //! a delete a keyed read saw stays deleted: both holders (self not one of them in this ring) attest `b`, none claims it
    fake.writes.ring.holders = () => ['h1', 'h2']
    h1 = { c: {}, att: ['b'] }
    h2 = { c: {}, att: ['b'] }
    assert.equal(await g.keyed('b'), undefined, 'covered: the row is gone')
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 2, y: 3 } }, 'from the live union too')
    h1 = none
    h2 = none
    assert.equal(await g.keyed('b'), undefined, 'and stays gone in the skew window')
    await live()
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 2, y: 3 } }, 'a live generation does not bring it back')
  } finally { g.destroy() }
})

//! V4-65, the round-4 review: rounds 2 to 4 of this lane folded a keyed read onto a keyed state of the row, beside the
// live union, so a WHOLE read on the same node could go back past a keyed read. In the skew window it showed the row
// older than a keyed read had just returned, or showed again a row a keyed read had just read as removed. Base did
// neither on the owner: its keyed read was a whole refresh of the one registry. A keyed read folds into that registry
// again, for its row alone. Self owns `a` and is taking it over (no claim, no attestation); h1 is the old holder, h2 a
// co-holder, also acquiring. Red on the keyed-state fold: `{ a: { x: 1 }, b: 1 }` for `{ a: { x: 5 }, b: 1 }`, and
// `{ a: { x: 1 } }` for `{}`.
test('KEYED THEN WHOLE [V4-65] — on the owner, a whole read after a keyed read never shows the row older than the keyed read returned, nor a row it saw removed', async () => {
  const { Gather } = await import('./fold.ts')
  const mk = () => ({
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['self', 'h2'] } },
    scope: { entries: new Map([['a', { state: 2 }]]) }, versions: new Map(), state: new Map(),
  })
  const A = JSON.stringify(['a']), B = JSON.stringify(['b'])
  type Rows = { c: Record<string, unknown>; att: string[] }
  const whole = (g: InstanceType<typeof Gather>, f: unknown) => g.refresh({ node: f } as never, { throwOnPartial: true })
  {
    //! (1) a newer value of `a` at the old holder: the keyed read returns it; then h1 sheds `a`
    const f = mk()
    let h1: Rows = { c: { [A]: { v: { x: 1 }, st: [1, 1, 'h1'] }, [B]: { v: 1, st: [1, 2, 'h1'] } }, att: ['a', 'b'] }
    const h2: Rows = { c: {}, att: ['b'] }
    const g = new Gather({ node: f } as never, async (u: string) => structuredClone(u === 'h1' ? h1 : h2) as never)
    try {
      assert.deepStrictEqual(await whole(g, f), { a: { x: 1 }, b: 1 })
      h1 = { c: { [A]: { v: { x: 5 }, st: [1, 9, 'h1'] }, [B]: { v: 1, st: [1, 2, 'h1'] } }, att: ['a', 'b'] }
      assert.deepStrictEqual(await g.keyed('a'), { x: 5 })
      h1 = { c: { [B]: { v: 1, st: [1, 2, 'h1'] } }, att: ['b'] }
      assert.deepStrictEqual(await whole(g, f), { a: { x: 5 }, b: 1 }, 'never older than the keyed read returned')
    } finally { g.destroy() }
  }
  {
    //! (2) the row is removed: the old holder claims its tombstone, and the keyed read reads it absent; then h1 sheds `a`
    const f = mk()
    let h1: Rows = { c: { [A]: { v: { x: 1 }, st: [1, 1, 'h1'] } }, att: ['a'] }
    const h2: Rows = { c: {}, att: [] }
    const g = new Gather({ node: f } as never, async (u: string) => structuredClone(u === 'h1' ? h1 : h2) as never)
    try {
      assert.deepStrictEqual(await whole(g, f), { a: { x: 1 } })
      h1 = { c: { [A]: { st: [1, 9, 'h1'], t: 1 } }, att: ['a'] }
      assert.equal(await g.keyed('a'), undefined)
      h1 = { c: {}, att: [] }
      assert.deepStrictEqual(await whole(g, f), {}, 'a row the keyed read saw removed stays removed')
    } finally { g.destroy() }
  }
})

//! the same two shapes through a REAL kernel handover (the round-4 review's probe, on round 3's pin-flip harness): four
// sim nodes, `gx` pinned to n01/n02, written w0 and read once by a whole read on n03, then written w1..w3 (or removed)
// before the pin flips to n03/n04. On n03, while it does not hold `gx`: a keyed read, then a whole read on the same
// Gather. Each answer is taken at a random sim instant (the whole read's up to 400 sim ms apart). 60 seeds, both shapes,
// about 3 s. On the keyed-state fold: 5 of 62 whole reads older than the keyed read (seeds 25, 33, 45, 50, 54) and 4 of
// 62 that showed `gx` after the keyed read read it removed (seeds 16, 25, 38, 50); base 0 of each.
test('KEYED THEN WHOLE, through a real kernel handover [V4-65] — 60 seeds: the whole read never goes back past the keyed read', async () => {
  const { Sim } = await import('../sim/exec.ts')
  const { cluster, formed: simFormed } = await import('../sim/harness.ts')
  const { Gather, rowsPartial } = await import('./fold.ts')
  const { REC } = await import('../kernel/env.ts')
  const idx = (v: unknown): number => typeof v === 'string' && /^w\d+$/.test(v) ? Number(v.slice(1)) : -1
  const run = async (seed: number, remove: boolean) => {
    const sim = new Sim(seed)
    const members = cluster(sim, 4, { heartbeatMs: 50, replicas: 2, fault: { delay: [5, 60] } })
    sim.run({ until: 2000 })
    if (!simFormed(members)) return null
    for (const m of members) m.writes.ring.place('gx', 'n01', 'n02')
    let w = 0
    const write = () => sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['gx', 'v'], value: `w${w++}` }] }, 0)
    write()
    sim.run({ until: 2400 })
    let clock = 2400
    const adv = (dt: number) => { clock += dt; sim.run({ until: clock }) }
    const self = members[2] // n03: the new owner after the flip
    let s = seed * 7919 + 1
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    const pending: { u: string; p?: string; res: (v: unknown) => void; rej: (e: unknown) => void }[] = []
    const call = (u: string, _t: number, p?: string) => new Promise((res, rej) => pending.push({ u, p, res, rej })) as never
    const g = new Gather({ node: self } as never, call)
    //! hand back the answers in a random order, each at a random sim instant up to `most` ms on
    const drive = async <T,>(p: Promise<T>, most: number): Promise<T> => {
      let done = false
      p.then(() => { done = true }, () => { done = true })
      while (!done) {
        await new Promise((r) => setImmediate(r))
        if (pending.length === 0) continue
        const h = pending.splice(Math.floor(rnd() * pending.length), 1)[0]
        adv(Math.floor(rnd() * most))
        const n = sim.nodes.get(h.u)
        if (!n) h.rej(new Error('down')); else h.res(rowsPartial({ node: n } as never, h.p))
      }
      return p
    }
    const whole = () => g.refresh({ node: self } as never, { throwOnPartial: true })
    await drive(whole(), 0) // the live union reads the row once (w0), before the flip
    //! then newer writes the live union never reads, all before the flip (a write after it trips the single-writer
    // monitor: the pin flip moves the ring inside one epoch)
    if (remove) { sim.post('n01', { kind: 'write', recs: [{ type: REC.remove, key: ['gx'] }] }, 0); adv(40) }
    else for (let i = 0; i < 3; i++) { write(); adv(40) }
    adv(200)
    for (const m of members) m.writes.ring.place('gx', 'n03', 'n04')
    for (const m of members) m.scope!.rescope(m)
    let pairs = 0, bad = 0
    const start = clock
    while (clock < start + 3000) {
      adv(1)
      if (self.scope!.held('gx')) continue
      let k: unknown, a: unknown
      try { k = await drive(g.keyed('gx'), 0) } catch { continue }
      try { a = ((await drive(whole(), 400)) as Record<string, any>).gx } catch { continue }
      pairs++
      if (remove ? k === undefined && a !== undefined : idx((a as any)?.v) < idx((k as any)?.v)) bad++
    }
    g.destroy()
    assert.deepEqual(sim.violations, [])
    return { pairs, bad }
  }
  for (const remove of [false, true]) {
    let pairs = 0
    const bad: number[] = []
    for (let seed = 0; seed < 60; seed++) {
      const r = await run(seed, remove)
      if (r === null) continue
      pairs += r.pairs
      if (r.bad) bad.push(seed)
    }
    assert.ok(pairs > 50, `${pairs} keyed-then-whole pairs`)
    assert.deepStrictEqual(bad, [], remove ? 'a whole read showed gx after a keyed read read it removed' : 'a whole read showed gx older than the keyed read')
  }
})

//! V4-65: a keyed fold is LIMITED to its row (fold.ts #fold with `row`): it replaces each answering member's claims for
// the row's cells alone, and reaps only the row's cells. The registry is private, so each claim it must keep is shown by
// what it does next. Row `b`: h1's claim (seq 2) wins over h2's (seq 1). Row `c`: h3's (seq 4) over h1's (seq 3). A
// keyed read of `a` hears h1 say nothing of `b` or `c` (its whole share is cut to `a`), while h3 is out of the view. Then
// h3 is back, and a live generation hears h2 alone (h1 and h3 down): if the keyed fold had dropped h1's claim for `b`,
// `b` would show h2's older value; if it had reaped h3's claim for `c`, `c` would show h1's older value.
test('KEYED ROW ONLY [V4-65] — a keyed read of one row leaves every other row\'s claims and value as they were', async () => {
  const { Gather } = await import('./fold.ts')
  const all = [['self', ''], ['h1', ''], ['h2', ''], ['h3', '']]
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: all } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['h1', 'h2'] } },
    scope: { entries: new Map() }, versions: new Map(), state: new Map(),
  }
  const A = JSON.stringify(['a']), B = JSON.stringify(['b']), C = JSON.stringify(['c'])
  type Rows = { c: Record<string, unknown>; att: string[] }
  const h1b = { v: 'h1', st: [1, 2, 'h1'] }, h1c = { v: 'old', st: [1, 3, 'h1'] }
  let ans: Record<string, Rows> = {
    h1: { c: { [A]: { v: 1, st: [1, 1, 'h1'] }, [B]: h1b, [C]: h1c }, att: ['a', 'b', 'c'] },
    h2: { c: { [B]: { v: 'h2', st: [1, 1, 'h2'] } }, att: ['b'] },
    h3: { c: { [C]: { v: 'h3', st: [1, 4, 'h3'] } }, att: ['c'] },
  }
  const down = new Set<string>()
  const g = new Gather({ node: fake } as never, async (u: string) => { if (down.has(u)) throw new Error('timeout'); return structuredClone(ans[u]) as never })
  try {
    await g.refresh({ node: fake } as never, { throwOnPartial: true, want: false })
    assert.deepStrictEqual(snapshot(g.proxy), { a: 1, b: 'h1', c: 'h3' })
    fake.membership.view.members = all.slice(0, 3)
    ans = { ...ans, h1: { c: { [A]: { v: 2, st: [1, 5, 'h1'] }, [B]: h1b, [C]: h1c }, att: ['a', 'b', 'c'] } }
    assert.equal(await g.keyed('a'), 2)
    assert.deepStrictEqual(snapshot(g.proxy), { a: 2, b: 'h1', c: 'h3' }, 'the other rows\' values are as they were')
    fake.membership.view.members = all
    down.add('h1'); down.add('h3')
    await g.refresh({ node: fake } as never, { throwOnPartial: false, want: false })
    assert.deepStrictEqual(snapshot(g.proxy), { a: 2, b: 'h1', c: 'h3' }, 'and so were their claims: h1\'s for `b` and the departed h3\'s for `c` still win')
  } finally { g.destroy() }
})

//! the exact claim of the one registry (V4-65), as a differential: the live union answers every row as ONE registry
// would that took every fold, each keyed fold limited to its row. The oracle is one whole-fold gather per row, fed every
// live generation and a whole generation at every keyed read of THAT row: a fold limited to a row gives the row what a
// whole fold of the same answers gives it (fold.ts #fold), and a keyed read of another row leaves it alone. So after
// every step every row of the live union equals its oracle's, and a keyed read answers it. The registry is private: its
// entries are checked by what they do next. Members go down (their old claims park), the view loses and regains h3 (a
// departed member's claims are reaped by a fold of their row only, here and in the oracle), holders move, and members of
// an older version send their whole share (keyed cuts it); the others cut it themselves. Random claims (a stamp names
// one value), random self scope. Red on the keyed-state fold of rounds 2 to 4 (a keyed read never wrote the live
// union): seed 1. Red when a keyed fold replaces a member's claims in every row: seed 1; when it reaps every row: seed
// 27; when it reaps no row: seed 1; when it is a whole fold: seed 1.
test('KEYED PARKING, differential [V4-65] — the live union is one registry: every row as if it took every fold, each keyed fold limited to its row, 150 seeds', async () => {
  const { Gather } = await import('./fold.ts')
  let seed = 1
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const one = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const ALL = ['self', 'h1', 'h2', 'h3'], PARTS = ['a', 'b', 'ab', 'a"b']
  const CELLS = [['a'], ['a', 'f'], ['a', 'f', 'g'], ['a', 'h'], ['b'], ['b', 'f'], ['ab'], ['ab', 'f'], ['a"b'], ['a"b', 'x']].map((k) => JSON.stringify(k))
  const VALS: unknown[] = [1, 2, 'x', null, { f: 1 }, { f: { g: 2 } }, { h: 3, f: 0 }, {}, [1, 2]]
  const hash = (str: string) => { let x = 2166136261; for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619) >>> 0; return x }
  const val = (cell: string, st: unknown[]) => structuredClone(VALS[hash(cell + '|' + st.join('|')) % VALS.length])
  const tomb = (cell: string, st: unknown[]) => (hash(cell + '|' + st.join('|')) >>> 8) % 5 === 0
  type Rows = { c: Record<string, unknown>; att: string[] | null }
  const claims = (): Rows => {
    const c: Record<string, unknown> = {}
    for (const cell of CELLS) {
      if (rnd() < 0.55) continue
      const st = [1, 1 + Math.floor(rnd() * 30), one(ALL)]
      c[cell] = tomb(cell, st) ? { st, t: 1 } : { v: val(cell, st), st }
    }
    return { c, att: rnd() < 0.1 ? null : PARTS.filter(() => rnd() < 0.5) }
  }
  //! a member that reads the partition answers that row alone: an independent cut, by parse
  const cut = (r: Rows, p: string): Rows => ({
    c: Object.fromEntries(Object.entries(r.c).filter(([cell]) => (JSON.parse(cell) as string[])[0] === p)),
    att: r.att === null ? null : r.att.includes(p) ? [p] : [],
  })
  //! a row as every read returns it (the codec's copy, replyCopy). The raw projection can differ in one way that is
  // older than this lane: a field cell under an ARRAY row lands as a named field of the array, the substrate keeps only
  // the last one it set, and which is last follows the order the answers came in (a keyed read takes its own answer
  // last, a whole read first). No reply carries an array's named fields.
  const { replyCopy } = await import('./data.ts')
  const rowOf = (px: unknown, p: string): unknown => { const all = snapshot(px) as Record<string, unknown>; return Object.hasOwn(all, p) ? replyCopy(all[p], 1 << 20) : undefined }
  let keyedChecks = 0, rowChecks = 0
  for (let s = 1; s <= 150; s++) {
    seed = s * 104729
    let hold: Record<string, string[]> = { a: ['self', 'h1'], b: ['h1', 'h2'], ab: ['h2', 'h3'], 'a"b': ['self', 'h3'] }
    const fake = {
      uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 1 << 20 },
      membership: { view: { epoch: 1, members: ALL.map((u) => [u, '']) } },
      writes: { ring: { epoch: 1, build: () => {}, holders: (p: string) => hold[p] ?? ['self'] } },
      scope: { entries: new Map<string, { state: number }>() }, versions: new Map<string, unknown>(), state: new Map<string, unknown>(),
    }
    const setSelf = () => {
      fake.versions = new Map(); fake.state = new Map(); fake.scope = { entries: new Map() }
      for (const p of PARTS) { const r = rnd(); if (r < 0.5) fake.scope.entries.set(p, { state: r < 0.3 ? 1 : r < 0.4 ? 3 : 2 }) }
      for (const cell of CELLS) {
        if (rnd() < 0.5) continue
        const st = { epoch: 1, seq: 1 + Math.floor(rnd() * 30), origin: one(ALL) }
        fake.versions.set(cell, st)
        if (!tomb(cell, [1, st.seq, st.origin])) fake.state.set(cell, val(cell, [1, st.seq, st.origin]))
      }
    }
    let gen: Record<string, Rows> = {}
    let older = new Set<string>()
    const down = new Set<string>()
    const call = async (u: string, _t: number, p?: string) => {
      if (down.has(u)) throw new Error('timeout')
      const whole = structuredClone(gen[u])
      return (p === undefined || older.has(u) ? whole : cut(whole, p)) as never
    }
    const g = new Gather({ node: fake } as never, call)
    const ref = Object.fromEntries(PARTS.map((p) => [p, new Gather({ node: fake } as never, call)]))
    try {
      for (let o = 0, ops = 4 + Math.floor(rnd() * 10); o < ops; o++) {
        //! the node moves: the view loses or regains h3, holders move, some members run an older fero
        const view = rnd() < 0.2 ? ALL.slice(0, 3) : ALL
        fake.membership.view.members = view.map((u) => [u, ''])
        if (rnd() < 0.3) hold = Object.fromEntries(PARTS.map((p) => [p, rnd() < 0.5 ? ['self', one(view.slice(1))] : [one(view.slice(1)), one(view.slice(1))]]))
        older = new Set(ALL.slice(1).filter(() => rnd() < 0.3))
        gen = Object.fromEntries(ALL.map((u) => [u, rnd() < 0.3 ? { c: {}, att: [] } : claims()]))
        setSelf()
        down.clear()
        if (rnd() < 0.4) {
          for (const u of view.slice(1)) if (rnd() < 0.25) down.add(u)
          await g.refresh({ node: fake } as never, { throwOnPartial: false, want: false })
          for (const p of PARTS) await ref[p].refresh({ node: fake } as never, { throwOnPartial: false, want: false })
        } else {
          const k = one(PARTS)
          const got = await g.keyed(k)
          const whole = await ref[k].refresh({ node: fake } as never, { throwOnPartial: true }) as Record<string, unknown>
          assert.deepStrictEqual(got, Object.hasOwn(whole, k) ? whole[k] : undefined, `seed ${s} op ${o}: the keyed read of ${k}`)
          keyedChecks++
        }
        for (const p of PARTS) { assert.deepStrictEqual(rowOf(g.proxy, p), rowOf(ref[p].proxy, p), `seed ${s} op ${o}: row ${p} of the live union`); rowChecks++ }
      }
    } finally { g.destroy(); for (const p of PARTS) ref[p].destroy() }
  }
  assert.ok(keyedChecks > 700, `${keyedChecks} keyed reads compared`)
  assert.ok(rowChecks > 4000, `${rowChecks} rows compared`)
})

//! V4-65, the round-3 review: a keyed read takes this node's OWN answer last, after every other member's is in. The
// shape it is for: a handover that ENDS while the read is in flight. This node owns `a` and is still taking it over
// when the read starts; while the answers travel it finishes (it holds `a` now), and the old holder h1 sheds before it
// answers (no claim, no attestation). Taken first, as base's keyed read (a whole refresh) took it, this node's answer
// says nothing of the row and h1's says nothing either: the read answers undefined for a row that exists, the silent
// wrong answer plan §9 bans. Red on base, and red with the own answer moved back to before the fan-out.
test('KEYED MID-READ [V4-65] — a handover that ends while a keyed read is in flight: this node\'s own answer is taken last, so the read sees the row', async () => {
  const { Gather } = await import('./fold.ts')
  const A = JSON.stringify(['a'])
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['self', 'h2'] } },
    scope: { entries: new Map([['a', { state: 2 }]]) }, // acquiring: no claim, no attestation
    versions: new Map<string, unknown>(), state: new Map<string, unknown>(),
  }
  const g = new Gather({ node: fake } as never, async (u: string) => {
    await new Promise((r) => setImmediate(r))
    //! by the time h1 answers, this node holds `a` (the acquire landed) and h1 has shed it
    if (u === 'h1') { fake.scope.entries.set('a', { state: 1 }); fake.versions.set(A, { epoch: 1, seq: 3, origin: 'h1' }); fake.state.set(A, { x: 1 }) }
    return { c: {}, att: [] } as never
  })
  try {
    assert.deepStrictEqual(await g.keyed('a'), { x: 1 }, 'the row, from this node\'s own answer taken after h1\'s')
  } finally { g.destroy() }
})

//! V4-65, the round-3 review: keyed reads ran OFF the refresh chain, so a read whose answers came back after a newer
// read's (or a newer live generation's) folded its older answers last, over the newer ones. A later read in the skew
// window (h1 has shed: no claim, no attestation) then parked the OLDER value, after a read had already returned the
// newer one. Base ran a keyed read as a refresh, on the chain. Here each h1 answer is h1's state when it is ASKED (x=1,
// then a newer write x=2, then shed), and the answers held in flight come back newest first. On a real link a member
// answers in order, so this needs two fan-outs to different member sets (a view install between them); the chain makes
// the order hold whatever the links do. Red off the chain: `{ x: 1 }` for `{ x: 2 }`, and for the live generation's
// newer value too.
test('KEYED ORDER [V4-65] — keyed reads and live generations fold in the order they began, so answers that come back late never fold over newer ones', async () => {
  const { Gather } = await import('./fold.ts')
  const A = JSON.stringify(['a'])
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2, tune: { frame: 8192 },
    membership: { view: { epoch: 1, members: [['self', ''], ['h1', ''], ['h2', '']] } },
    writes: { ring: { epoch: 1, build: () => {}, holders: () => ['self', 'h2'] } },
    scope: { entries: new Map() }, versions: new Map(), state: new Map(),
  }
  const none = { c: {}, att: [] as string[] }
  const at = (x: number, seq: number) => ({ c: { [A]: { v: { x }, st: [1, seq, 'h1'] } }, att: ['a'] })
  //! h1's answers, one per time it is asked, in that order; then nothing (it shed). h2 says nothing of `a`.
  let script: unknown[] = []
  const held: { answer: unknown; resolve: (v: unknown) => void }[] = []
  const g = new Gather({ node: fake } as never, (u: string) => {
    const answer = structuredClone(u === 'h1' ? (script.shift() ?? none) : none)
    return new Promise((resolve) => held.push({ answer, resolve })) as never
  })
  //! hand back the answers in flight newest first, one per turn, until `p` settles
  const lifo = async <T,>(p: Promise<T>): Promise<T> => {
    let done = false
    p.then(() => { done = true }, () => { done = true })
    while (!done) {
      await new Promise((r) => setImmediate(r))
      const h = held.pop()
      if (h !== undefined) h.resolve(h.answer)
    }
    return p
  }
  try {
    //! two keyed reads of `a`, begun one after the other: the first asks h1 at x=1, the second at x=2
    script = [at(1, 1), at(2, 5)]
    assert.deepStrictEqual(await lifo(Promise.all([g.keyed('a'), g.keyed('a')])), [{ x: 1 }, { x: 2 }])
    assert.deepStrictEqual(await lifo(g.keyed('a')), { x: 2 }, 'the skew window parks the newest value a read returned')
    //! a keyed read, then a live generation begun after it (a view install's): the generation's newer value stands
    script = [at(3, 7), at(4, 9)]
    await lifo(Promise.all([g.keyed('a'), g.refresh({ node: fake } as never, { throwOnPartial: false, want: false })]))
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 4 } })
    assert.deepStrictEqual(await lifo(g.keyed('a')), { x: 4 }, 'the skew window parks the live generation\'s newer value')
    //! destroyed while a keyed read's answers travel: the union is not written any more, as a whole read's is not
    script = [at(5, 11)]
    const late = g.keyed('a')
    while (held.length === 0) await new Promise((r) => setImmediate(r))
    g.destroy()
    assert.deepStrictEqual(await lifo(late), { x: 4 })
    assert.deepStrictEqual(snapshot(g.proxy), { a: { x: 4 } }, 'not written after destroy()')
  } finally { g.destroy() }
})

//! the member side of V4-65: `rows` with a partition answers exactly the part of its whole answer for that row — the
// row cell, its fields and their tombstones, a quoted key too — and attests that partition alone, or nothing
test('rowsPartial with a partition is the whole answer\'s part for that row: its cells by their first key, its attestation cut to it', async () => {
  const { rowsPartial } = await import('./fold.ts')
  const st = (seq: number) => ({ epoch: 1, seq, origin: 'n1' })
  const cell = (...k: string[]) => JSON.stringify(k)
  const versions = new Map([
    [cell('a'), st(1)], [cell('a', 'f'), st(2)], [cell('a', 'g'), st(3)], [cell('ab'), st(4)], [cell('a"b'), st(5)],
    [cell('a', 'h', 'i'), st(6)], [cell('c'), st(7)], [cell('o'), st(8)],
  ])
  const state = new Map<string, unknown>([[cell('a'), { f: 1 }], [cell('a', 'f'), 1], [cell('ab'), 2], [cell('a"b'), 3], [cell('a', 'h', 'i'), 4], [cell('c'), 5], [cell('o'), 6]])
  //! a, ab and a"b held; o an orphan (it claims until its shed); c still being taken over (no claim, no attestation)
  const scope = { entries: new Map([['a', { state: 1 }], ['ab', { state: 1 }], ['a"b', { state: 1 }], ['o', { state: 3 }], ['c', { state: 2 }]]) }
  const rt = { node: { armed: true, scope, versions, state } } as never
  const whole = rowsPartial(rt)
  assert.deepEqual(new Set(whole.att), new Set(['a', 'ab', 'a"b', 'o']))
  for (const p of ['a', 'ab', 'a"b', 'o', 'c', 'nope']) {
    const part = rowsPartial(rt, p)
    const want = Object.fromEntries(Object.entries(whole.c).filter(([k]) => (JSON.parse(k) as string[])[0] === p))
    assert.deepStrictEqual(part.c, want, p)
    assert.deepStrictEqual(part.att, whole.att!.includes(p) ? [p] : [], p)
  }
  assert.deepStrictEqual(Object.keys(rowsPartial(rt, 'a').c), [cell('a'), cell('a', 'f'), cell('a', 'g'), cell('a', 'h', 'i')], 'the row, its fields and the field tombstone; never `ab` or `a"b`')
  assert.deepStrictEqual(rowsPartial(rt, 'a').c[cell('a', 'g')], { st: [1, 3, 'n1'], t: 1 })
  //! unscoped: the whole fold is local truth, and so is one partition of it
  const flat = rowsPartial({ node: { armed: false, scope: null, versions, state } } as never, 'c')
  assert.deepStrictEqual(flat, { c: { [cell('c')]: { v: 5, st: [1, 7, 'n1'] } }, att: null })
})

//! the wire of V4-65: the system `rows` call carries the partition, and a real scoped server answers that row alone
test('the system rows call with a partition answers that row alone over a real link', async () => {
  const nodes = await spawn(2, 1)
  let c: Fero | null = null
  try {
    assert.ok(await formed(nodes), 'formed')
    //! replicas 1: each row has one holder. Twelve rows with a field each; read one row's `rows` through a client fed
    // by a member that holds that row and at least one more, so the cut answer and the whole one differ
    for (let i = 0; i < 12; i++) {
      nodes[0].data['k' + i] = { n: i }
      await nodes[0].methods.update({ key: ['k' + i, 'm'], value: i })
    }
    const held = (f: Fero) => (diag(f)!.capture().held ?? []) as string[]
    const cells = (f: Fero) => (diag(f)!.capture().state as [string, unknown][]).map(([k]) => k)
    assert.ok(await until(() => Array.from({ length: 12 }, (_, i) => 'k' + i).every((k) => nodes.some((f) => held(f).includes(k) && cells(f).includes(JSON.stringify([k, 'm'])))), 8000), 'every row and its field are held')
    const holder = nodes.find((f) => held(f).filter((k) => k.startsWith('k')).length >= 2)!
    const k = held(holder).find((p) => p.startsWith('k'))!
    c = await fero('scoped', { uuid: 'zz', hosts: [(snapshot(holder.cluster) as { me: { listen: string } }).me.listen], heartbeat: { ms: 50 }, redial: { ms: 30 } })
    const rows = (c.methods as unknown as Record<string, (a?: unknown) => Promise<{ c: Record<string, unknown>; att: string[] | null }>>)['\u0000rows']
    const whole = await rows()
    assert.ok(whole.att!.filter((p) => p.startsWith('k')).length >= 2 && whole.c[JSON.stringify([k])] !== undefined && whole.c[JSON.stringify([k, 'm'])] !== undefined, JSON.stringify(whole))
    const one = await rows(k)
    assert.deepStrictEqual(Object.keys(one.c).sort(), [JSON.stringify([k]), JSON.stringify([k, 'm'])].sort(), `${k} alone`)
    assert.deepStrictEqual(one.att, [k])
    assert.deepStrictEqual(Object.fromEntries(Object.entries(whole.c).filter(([cell]) => (JSON.parse(cell) as string[])[0] === k)), one.c, 'the whole answer\'s part for the row')
  } finally {
    await c?.destroy()
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})

//! the coordinator's side of V4-65, through the real composer (the round-2 review: the tests above drive a fake call or
// call `rows` straight from a client, so a gather callback that dropped the partition stayed green, and the whole share
// travelled again). A keyed read of a row this node owns but does not hold goes through the gather — an absent row is
// never held. The test records every member `rows` call and the answer that came back BEFORE the coordinator cuts it to
// the row (fold.ts only), because the cut hides a whole share from the read's own answer.
test('a keyed read through the real composer asks the other member for that row only: the partition rides the call, and the answer holds that row alone', async () => {
  const { Caller, SYSTEM } = await import('./methods.ts')
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1 })))
  const real = Caller.prototype.call
  const seen: { a: unknown; to: string | undefined; cells: string[]; att: string[] | null }[] = []
  Caller.prototype.call = function (this: InstanceType<typeof Caller>, m: string, a: unknown, opts?: { timeout?: number; retry?: boolean; to?: string }, pre?: never) {
    const p = real.call(this, m, a, opts, pre)
    if (m !== SYSTEM + 'rows') return p
    return p.then((r) => {
      const rows = r as { c: Record<string, unknown>; att: string[] | null }
      seen.push({ a, to: opts?.to, cells: Object.keys(rows.c), att: rows.att })
      return r
    })
  }
  try {
    assert.ok(await formed(nodes), 'formed')
    //! replicas 1: four rows whose one holder is n02, so its whole share is not empty, and a row n01 owns that nobody wrote
    const ring = new Ring()
    ring.build(1, [['n01', addrs[0]], ['n02', addrs[1]]])
    const theirs: string[] = []
    for (let i = 0; theirs.length < 4; i++) if (ring.holders('w' + i, 1)[0] === 'n02') theirs.push('w' + i)
    let k = ''
    for (let i = 0; k === ''; i++) if (ring.holders('gone' + i, 1)[0] === 'n01') k = 'gone' + i
    for (const w of theirs) await nodes[0].methods.update({ key: w, value: { w } }, { timeout: 3000 })
    const held = (f: Fero) => (diag(f)!.capture().held ?? []) as string[]
    assert.ok(await until(() => theirs.every((w) => held(nodes[1]).includes(w)), 8000), 'n02 holds its four rows')
    seen.length = 0
    assert.equal(await nodes[0].methods.read(k), undefined, 'the absent row reads absent')
    assert.deepStrictEqual(seen, [{ a: k, to: 'n02', cells: [], att: [] }], 'one call, for the row alone: no cell of n02\'s four rows came back')
  } finally {
    Caller.prototype.call = real
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})

//! the one registry through the real composer (V4-65, the round-4 review): the keyed read that gathers and the whole read
// must fold into the SAME Gather, or a whole read on the owner goes back past a keyed read (KEYED THEN WHOLE). The test
// records the Gather each one used: a keyed read of a row this node owns that nobody wrote (it gathers), then
// `methods.read()` and `await data` (the whole read). Red if the composer gave keyed reads a Gather of their own.
test('ONE GATHER through the real composer — the keyed read that gathers and the whole read fold into the same Gather', async () => {
  const { Gather } = await import('./fold.ts')
  const ps = [await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const nodes = await Promise.all(addrs.map((listen, i) =>
    fero('scoped', { uuid: `n${String(i + 1).padStart(2, '0')}`, listen, hosts: addrs.filter((_, j) => j !== i), heartbeat: { ms: 50 }, redial: { ms: 30 }, replicas: 1 })))
  const keyed = Gather.prototype.keyed, refresh = Gather.prototype.refresh
  const used: { how: string; g: InstanceType<typeof Gather> }[] = []
  Gather.prototype.keyed = function (this: InstanceType<typeof Gather>, key: string, t?: number) { used.push({ how: 'keyed', g: this }); return keyed.call(this, key, t) }
  Gather.prototype.refresh = function (this: InstanceType<typeof Gather>, rt: never, opts: never) { used.push({ how: 'whole', g: this }); return refresh.call(this, rt, opts) }
  try {
    assert.ok(await formed(nodes), 'formed')
    const ring = new Ring()
    ring.build(1, [['n01', addrs[0]], ['n02', addrs[1]]])
    let gone = ''
    for (let i = 0; gone === ''; i++) if (ring.holders('gone' + i, 1)[0] === 'n01') gone = 'gone' + i
    used.length = 0
    assert.equal(await nodes[0].methods.read(gone), undefined)
    assert.deepStrictEqual(await nodes[0].methods.read(), {})
    assert.deepStrictEqual(await nodes[0].data, {})
    const whole = used.filter((u) => u.how === 'whole'), byKey = used.filter((u) => u.how === 'keyed')
    assert.equal(byKey.length, 1, 'the keyed read gathered')
    assert.ok(whole.length >= 2, 'both whole reads gathered')
    assert.ok(used.every((u) => u.g === byKey[0].g), 'one Gather for both')
  } finally {
    Gather.prototype.keyed = keyed
    Gather.prototype.refresh = refresh
    await Promise.all(nodes.map((n) => n.destroy()))
  }
})
