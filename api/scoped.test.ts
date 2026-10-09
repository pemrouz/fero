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

test('OVERLAPPING CELLS (V4-18) — the gather folds claims by depth with the kernel\'s stamp rule: a field remove newer than its row takes the field out, a field at or below an ancestor\'s stamp is hidden, a parked field never tears into a live row', async () => {
  const { Gather } = await import('./fold.ts')
  const fake = {
    uuid: 'self', epoch: 1, armed: true, replicas: 2,
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
