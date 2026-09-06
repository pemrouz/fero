//! Tier-3 directory suite (V4-3, DESIGN-DIRECTORY.md): the per-box rendezvous directory over REAL
// sockets, the way a consumer meets it — zero addresses, zero identities, zero hashing — plus the
// host table driven WITHOUT sockets (the fold-order defect and the ownership rules are pinned
// deterministically). Every socket test opts in with its OWN free rendezvous port (the battery runs
// FERO_RENDEZVOUS=off — pinned below at import time too, so a single-file run never meets a live
// box directory — and a fixed port would collide across concurrent checkouts) and pid-suffixed names.

process.env.FERO_RENDEZVOUS ??= 'off'

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import { fero, RENDEZVOUS } from './index.ts'
import { GRACE, MAX_PER_CALLER, hostMethods, isAddr, rendezvousDefault, sameSocket } from './directory.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { MAX_REDIALS } from '../kernel/node.ts'
import { ports, until } from '#utils'
import type { Fero } from './types.ts'
import type { Context } from './methods.ts'

const fast = async () => ({ heartbeatMs: 50, redialMs: 30, rendezvous: `127.0.0.1:${await ports.free()}` })
type Rz = false | { addr: string; hosting: boolean; up: boolean; error?: string }
type Me = { uuid: string; listen: string; role: string; hosts: string[]; rendezvous: Rz }
const me = (f: Fero): Me => (snapshot(f.cluster) as { me: Me }).me
const rz = (f: Fero) => me(f).rendezvous as Exclude<Rz, false>
const members = (f: Fero): number => Object.keys((snapshot(f.cluster) as { members: Record<string, string> }).members ?? {}).length
const peers = (f: Fero): number => Object.keys((snapshot(f.cluster) as { peers: Record<string, unknown> }).peers ?? {}).length
const data = (f: Fero) => snapshot(f.data) as Record<string, unknown>
const settle = async (all: (Fero | null | undefined)[]) => { await Promise.allSettled(all.map((f) => f?.destroy())) }
const tick = () => new Promise<void>((r) => queueMicrotask(r))

//! ── the host table without sockets: the fold-order defect, GRACE, ownership, odd names, the cap ──

test('host table: a registration folded BEFORE its caller is published survives (afterFold + GRACE) — the mid-fold read that dropped it is pinned', async () => {
  let peers: Record<string, { up: boolean }> = {}
  const { methods, onPeers } = hostMethods(() => peers)
  const ctx = (peer: string) => ({ peer } as unknown as Context)
  const row = () => snapshot(methods.lookup('r', ctx('x')) as never) as Record<string, string> | undefined
  assert.equal(methods.register({ name: 'r', uuid: 'u1', listen: '127.0.0.1:1' }, ctx('p1')), true)
  //! the defect's exact shape: the tap fires with the pre-fold peers ({}) and the fold publishes p1 only
  // AFTER — a synchronous reaction would have dropped u1 here
  onPeers()
  peers = { p1: { up: true } }
  await tick()
  assert.deepEqual(row(), { u1: '127.0.0.1:1' }, 'read after the fold: p1 is up, the entry stays')
  //! GRACE: a caller that is never published survives GRACE-1 passes and goes on the GRACE-th
  peers = {}
  assert.equal(methods.register({ name: 'r', uuid: 'u2', listen: '127.0.0.1:2' }, ctx('p2')), true)
  for (let i = 1; i < GRACE; i++) { onPeers(); await tick(); assert.equal(row()!.u2, '127.0.0.1:2', `pass ${i}: still in grace`) }
  assert.equal(row()!.u1, undefined, 'p1 WAS published up and is gone now — dropped at once, no grace')
  onPeers(); await tick()
  assert.equal(row()!.u2, undefined, `pass ${GRACE}: a never-published caller's entry is dropped — no leak`)
})

test('host table: the LATER registrant of a (name, uuid) owns the cell — a wedged predecessor\'s death no longer deletes a live replacement; a name with a space is cleaned up', async () => {
  let peers: Record<string, { up: boolean }> = { old: { up: true }, fresh: { up: true }, sp: { up: true } }
  const { methods, onPeers } = hostMethods(() => peers)
  const ctx = (peer: string) => ({ peer } as unknown as Context)
  const row = (n: string) => snapshot(methods.lookup(n, ctx('x')) as never) as Record<string, string> | undefined
  methods.register({ name: 'r', uuid: 'same', listen: '127.0.0.1:1' }, ctx('old'))
  onPeers(); await tick()
  //! the dir-restored identity restarts while its hung predecessor's socket is still open
  methods.register({ name: 'r', uuid: 'same', listen: '127.0.0.1:2' }, ctx('fresh'))
  assert.deepEqual(row('r'), { same: '127.0.0.1:2' }, 'the later registrant is authoritative')
  peers = { fresh: { up: true }, sp: { up: true } } // the predecessor finally dies
  onPeers(); await tick()
  assert.deepEqual(row('r'), { same: '127.0.0.1:2' }, 'its death does not take the replacement\'s cell')
  peers = { sp: { up: true } }
  onPeers(); await tick()
  assert.equal(row('r')!.same, undefined, 'the owner\'s death does')
  //! a name with a space (the panel: a space-delimited owner key split it wrong)
  methods.register({ name: 'my inventory', uuid: 'u', listen: '127.0.0.1:3' }, ctx('sp'))
  onPeers(); await tick()
  assert.deepEqual(row('my inventory'), { u: '127.0.0.1:3' })
  peers = {}
  onPeers(); await tick()
  assert.equal(row('my inventory')!.u, undefined, 'cleaned up by (name, uuid), not by a split on the first space')
})

test('host table: refusals are typed — bad name / uuid / listen, no caller identity, the per-caller cap', () => {
  const { methods } = hostMethods(() => ({}))
  const ctx = (peer?: string) => ({ peer } as unknown as Context)
  assert.throws(() => methods.register({ name: '#x', uuid: 'u', listen: '127.0.0.1:1' }, ctx('p')), /no # prefix/)
  assert.throws(() => methods.register({ name: '', uuid: 'u', listen: '127.0.0.1:1' }, ctx('p')), /non-empty/)
  assert.throws(() => methods.register({ name: 'r', uuid: 'a~1', listen: '127.0.0.1:1' }, ctx('p')), /without ~/)
  assert.throws(() => methods.register({ name: 'r', uuid: 'u', listen: '127.0.0.1:0' }, ctx('p')), /host:port/)
  assert.throws(() => methods.register({ name: 'r', uuid: 'u', listen: ':5' }, ctx('p')), /host:port/)
  assert.throws(() => methods.register({ name: 'r', uuid: 'u', listen: '127.0.0.1:1' }, ctx(undefined)), /no caller identity/, 'a local invoke has no caller')
  assert.throws(() => methods.lookup(7, ctx('p')), /non-empty string/)
  for (let i = 0; i < MAX_PER_CALLER; i++) methods.register({ name: 'r', uuid: 'u' + i, listen: '127.0.0.1:1' }, ctx('p'))
  assert.throws(() => methods.register({ name: 'r', uuid: 'one-more', listen: '127.0.0.1:1' }, ctx('p')), /already holds/)
  assert.equal(methods.register({ name: 'r', uuid: 'u0', listen: '127.0.0.1:9' }, ctx('p')), true, 're-registering an owned entry is not a new one')
})

test('address helpers: isAddr (digits, 1–65535, port 0 only for listen), sameSocket (wildcard/localhost/loopback spellings land on one socket), the env default', () => {
  for (const ok of ['127.0.0.1:1', 'localhost:65535', '[::1]:3376']) assert.ok(isAddr(ok), ok)
  for (const bad of ['nope', ':5', '127.0.0.1:', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:1e3', 7, '']) assert.equal(isAddr(bad), false, String(bad))
  assert.ok(isAddr('127.0.0.1:0', true), 'port 0 is a legal LISTEN (the free-port default)')
  for (const squat of ['0.0.0.0:3376', 'localhost:3376', '[::]:3376', '[::1]:3376', '127.0.0.2:3376', '127.0.0.1:3376'])
    assert.ok(sameSocket(squat, '127.0.0.1:3376'), `${squat} takes the directory's socket`)
  assert.equal(sameSocket('127.0.0.1:3377', '127.0.0.1:3376'), false)
  assert.equal(sameSocket('10.0.0.5:3376', '127.0.0.1:3376'), false, 'a routable interface is a different socket')
  const saved = process.env.FERO_RENDEZVOUS
  try {
    for (const off of ['off', 'false', '0', ' off ']) { process.env.FERO_RENDEZVOUS = off; assert.equal(rendezvousDefault(), false, off) }
    delete process.env.FERO_RENDEZVOUS; assert.equal(rendezvousDefault(), RENDEZVOUS)
    process.env.FERO_RENDEZVOUS = '127.0.0.1:4000'; assert.equal(rendezvousDefault(), '127.0.0.1:4000')
  } finally { if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved }
})

//! ── the composer's refusals and the config surface ──

test('directory config: # names are reserved; a user resource may not take a rendezvous socket under ANY spelling; a client with no directory and no hosts refuses; bad values refuse loudly', async () => {
  const o = await fast()
  const port = o.rendezvous.slice(o.rendezvous.lastIndexOf(':') + 1)
  await assert.rejects(fero('#anything', { ...o, server: true }), /reserved for system resources/)
  for (const squat of [o.rendezvous, `0.0.0.0:${port}`, `localhost:${port}`, `[::]:${port}`])
    await assert.rejects(fero(`r-${process.pid}`, { ...o, listen: squat }), /would take the directory's socket/, squat)
  //! the CONSTANT's socket is refused even with the directory off — a later process on this box will dial it
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: false, listen: RENDEZVOUS }), /would take the directory's socket/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: false }), /needs something to dial.*omitted/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: false, hosts: [] }), /needs something to dial.*empty/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: 'nope' as never }), /rendezvous must be/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: '127.0.0.1:0' as never }), /rendezvous must be/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, listen: ':5' }), /listen must be/)
  await assert.rejects(fero('', { heartbeatMs: 0 }), /name must be a non-empty string/)
  //! rendezvous: false is the pure-static shape — a server meets no directory, and says so; so does a
  // socketless solo even WITH a rendezvous (it meets none: `false`, never "down")
  const solo = await fero(`r-${process.pid}`, { server: true, heartbeatMs: 0, rendezvous: false })
  assert.equal(me(solo).rendezvous, false)
  assert.equal(diag(solo)!.rendezvous(), null, 'no directory nodes')
  assert.match(me(solo).listen, /^127\.0\.0\.1:[1-9]\d*$/, 'still a free loopback port')
  await solo.destroy()
  const socketless = await fero(`r-${process.pid}`, { listen: false, ...o })
  assert.equal(me(socketless).rendezvous, false, 'listen: false meets no directory — reported as absent, not down')
  assert.equal(diag(socketless)!.rendezvous(), null)
  await socketless.destroy()
  //! precedence: an explicit rendezvous beats FERO_RENDEZVOUS=off (the battery's env) — every socket
  // test here relies on it; a malformed env value is refused at fero() time with the variable named
  const saved = process.env.FERO_RENDEZVOUS
  try {
    process.env.FERO_RENDEZVOUS = 'off'
    await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0 }), /needs something to dial/)
    const s = await fero(`r-${process.pid}`, { server: true, ...o })
    assert.equal(rz(s).addr, o.rendezvous, 'config beats the env')
    await s.destroy()
    process.env.FERO_RENDEZVOUS = 'garbage'
    await assert.rejects(fero(`r-${process.pid}`, { server: true, heartbeatMs: 0 }), /FERO_RENDEZVOUS='garbage' is not/)
  } finally { if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved }
})

//! ── over real sockets ──

test('N bare servers form a view with NO addresses and NO uuid pins — the genesis coin-flip is closed (three rounds)', async () => {
  for (let round = 0; round < 3; round++) {
    const o = await fast()
    const name = `form-${round}-${process.pid}`
    const ss: Fero[] = []
    try {
      for (let i = 0; i < 3; i++) ss.push(await fero(name, { server: true, ...o }))
      assert.ok(await until(() => ss.every((s) => members(s) === 3), 10_000), `round ${round}: 3-member view through the directory alone`)
      assert.equal(ss.filter((s) => rz(s).hosting).length, 1, 'exactly one hosts the directory')
      for (const s of ss) {
        const m = me(s)
        assert.match(m.listen, /^127\.0\.0\.1:[1-9]\d*$/)
        assert.equal(m.hosts.length, 2, 'the two OTHER servers, discovered')
        assert.ok(!m.hosts.includes(m.listen), 'own listen excluded')
        assert.equal(rz(s).up, true)
        assert.equal(rz(s).error, undefined)
      }
      ss[1].data.k = 'v'
      assert.ok(await until(() => ss.every((s) => data(s).k === 'v')), 'replicates')
    } finally { await settle(ss) }
  }
})

test('a bare client finds explicit-listen servers through the directory — in EITHER start order (the demo\'s watcher-first path too); the discovered set and the rendezvous state ride cluster.me', async () => {
  const o = await fast()
  const name = `find-${process.pid}`
  const a1 = `127.0.0.1:${await ports.free()}`, a2 = `127.0.0.1:${await ports.free()}`
  let early: Fero | undefined, s1: Fero | undefined, s2: Fero | undefined, c: Fero | undefined, c2: Fero | undefined
  try {
    //! the watcher before any server or directory: nothing to dial yet, and it says so
    early = await fero(name, o)
    assert.equal(me(early).role, 'client')
    assert.deepEqual(me(early).rendezvous, { addr: o.rendezvous, hosting: false, up: false }, 'no directory on this box yet')
    s1 = await fero(name, { listen: a1, hosts: [a2], ...o })
    s2 = await fero(name, { listen: a2, hosts: [a1], ...o })
    s1.data.k = 1
    assert.ok(await until(() => data(early!).k === 1, 8000), 'the early client found the servers once they appeared — zero addresses on the client')
    c = await fero(name, o)
    assert.ok(await until(() => data(c!).k === 1), 'a later client too')
    assert.ok(await until(() => me(c!).hosts.length === 2 && peers(c!) === 2))
    assert.deepEqual([...me(c).hosts].sort(), [a1, a2].sort(), 'discovered = the registered listens')
    assert.deepEqual(me(c).rendezvous, { addr: o.rendezvous, hosting: false, up: true }, 'a client never hosts')
    //! static ∪ discovered: a client with one explicit host still learns the other
    c2 = await fero(name, { ...o, hosts: [a1] })
    assert.ok(await until(() => me(c2!).hosts.length === 2))
  } finally { await settle([early, c, c2, s1, s2]) }
})

test('directory host death: a survivor takes the port over, the client fails over, a NEW client finds the survivors, a bare restart joins as a new member', async () => {
  const o = await fast()
  const name = `take-${process.pid}`
  //! the eviction wait is the dead host's redial chain giving up (eviction is HELD while a member is
  // still being dialed), not SUSPECT_TICKS: ≈ redialMs·(1+2+…+32·k) — derive the bound from that
  const chain = o.redialMs * (1 + 2 + 4 + 8 + 16 + 32 * (MAX_REDIALS - 5)) + MAX_REDIALS * o.redialMs
  let s1: Fero | undefined, s2: Fero | undefined, s3: Fero | undefined, c: Fero | undefined, late: Fero | undefined, s4: Fero | undefined
  try {
    s1 = await fero(name, { server: true, ...o })
    s2 = await fero(name, { server: true, ...o })
    s3 = await fero(name, { server: true, ...o })
    c = await fero(name, o)
    assert.ok(await until(() => [s1!, s2!, s3!].every((s) => members(s) === 3), 10_000))
    assert.ok(rz(s1).hosting, 'the first server hosts')
    s1.data.k = 'v1'
    assert.ok(await until(() => data(c!).k === 'v1' && peers(c!) === 3))
    await s1.destroy()
    assert.ok(await until(() => rz(s2!).hosting || rz(s3!).hosting, 5000), 'a survivor re-hosts')
    assert.ok(await until(() => members(s2!) === 2 && members(s3!) === 2, 3 * chain), `the survivors evicted the dead host once its redial chain gave up (~${chain}ms)`)
    s2.data.k = 'v2'
    assert.ok(await until(() => data(c!).k === 'v2'), 'the client failed over')
    assert.ok(await until(() => me(c!).hosts.length === 2), 'the dead server left every lookup')
    late = await fero(name, o)
    assert.ok(await until(() => data(late!).k === 'v2'), 'a NEW client after the host died still finds the survivors — the gap the derived port had')
    s4 = await fero(name, { server: true, ...o })
    assert.ok(await until(() => members(s4!) === 3 && members(s2!) === 3, 10_000), 'a bare restart joins as a NEW member')
    s4.data.k = 'v3'
    assert.ok(await until(() => [s2!, s3!, c!, late!].every((f) => data(f).k === 'v3')))
    assert.ok(await until(() => me(c!).hosts.length === 3), 'the client re-folded to three')
  } finally { await settle([c, late, s4, s2, s3, s1]) }
})

test('entries die with their registrant: destroying a server removes it from every live lookup', async () => {
  const o = await fast()
  const name = `die-${process.pid}`
  let s1: Fero | undefined, s2: Fero | undefined, c: Fero | undefined
  try {
    s1 = await fero(name, { server: true, ...o })
    s2 = await fero(name, { server: true, ...o })
    c = await fero(name, o)
    assert.ok(await until(() => me(c!).hosts.length === 2))
    const gone = me(s2).listen
    await s2.destroy()
    assert.ok(await until(() => me(c!).hosts.length === 1 && !me(c!).hosts.includes(gone)), 'the closed link forgot its entry — no unregister call needed')
    assert.ok(await until(() => me(s1!).hosts.length === 0))
  } finally { await settle([c, s1, s2]) }
})

test('two names on one box never collide, never cross-talk, and the diagnostics seam exposes the directory nodes as real instances', async () => {
  const o = await fast()
  let a: Fero | undefined, b: Fero | undefined, ca: Fero | undefined, cb: Fero | undefined
  try {
    a = await fero(`alpha-${process.pid}`, { server: true, ...o })
    b = await fero(`beta-${process.pid}`, { server: true, ...o })
    ca = await fero(`alpha-${process.pid}`, o)
    cb = await fero(`beta-${process.pid}`, o)
    a.data.x = 1; b.data.y = 2
    assert.ok(await until(() => data(ca!).x === 1 && data(cb!).y === 2))
    assert.equal(data(ca).y, undefined); assert.equal(data(cb).x, undefined)
    assert.deepEqual(me(ca).hosts, [me(a).listen]); assert.deepEqual(me(cb).hosts, [me(b).listen])
    const d = diag(a)!.rendezvous()!
    assert.equal(d.host?.name, '#directory', 'the first server hosts the system resource')
    assert.equal(d.client?.name, '#directory')
    assert.equal(diag(b)!.rendezvous()!.host, null, 'the second does not')
    assert.equal(diag(ca)!.rendezvous()!.client?.name, '#directory')
    //! the host's register refuses a local invoke (no caller identity) — the wire is the only way in
    await assert.rejects(d.host!.methods.register({ name: 'x', uuid: 'u', listen: '127.0.0.1:9' }), /no caller identity/)
  } finally { await settle([ca, cb, a, b]) }
})

test('a user resource misdialing the rendezvous is refused by the name echo and never admitted — and keeps re-trying at heartbeat cadence rather than stranding', async () => {
  const o = await fast()
  let s: Fero | undefined, mis: Fero | undefined
  try {
    s = await fero(`host-${process.pid}`, { server: true, ...o })
    assert.ok(await until(() => rz(s!).hosting && rz(s!).up))
    //! a client of some resource pointed at the directory's socket by hand
    mis = await fero(`mis-${process.pid}`, { hosts: [o.rendezvous], heartbeatMs: 50, redialMs: 30, rendezvous: false })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(peers(mis), 0, 'never admitted — the HELLO name echo refuses')
    const j = diag(mis)!.journal(0).events
    const rejects = j.filter((e) => e.kind === 71 /* JK.nameReject */).length
    assert.ok(rejects >= 2, `re-dialed and refused again at heartbeat cadence (${rejects} rejects) — a squat is a bounded nuisance, not a strand`)
  } finally { await settle([mis, s]) }
})

test('Context.peer: a wire call carries the caller uuid, a local invoke carries none', async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  let s: Fero | undefined, c: Fero | undefined
  try {
    s = await fero(`peer-${process.pid}`, { listen: addr, heartbeatMs: 50, redialMs: 30, rendezvous: false, methods: { who: (_: unknown, ctx: { peer?: string }) => ctx.peer ?? null } })
    c = await fero(`peer-${process.pid}`, { hosts: [addr], heartbeatMs: 50, redialMs: 30, rendezvous: false })
    assert.ok(await until(() => peers(c!) === 1))
    assert.equal(await c.methods.who(), me(c).uuid)
    assert.equal(await s.methods.who(), null)
  } finally { await settle([c, s]) }
})

test('a non-fero squatter on the rendezvous port: the resource itself is unaffected, discovery reports down, the bind retry backs off, and it recovers when the port frees', async () => {
  const port = await ports.free()
  const rendezvous = `127.0.0.1:${port}`
  //! the squatter answers with junk and hangs up — a real foreign service; its sockets must not pin
  // server.close() open (net.Server.close waits for every connection)
  const squatter = net.createServer((sock) => { sock.write('not fero\n'); sock.destroy() })
  await new Promise<void>((res) => squatter.listen(port, '127.0.0.1', res))
  const name = `squat-${process.pid}`
  let s: Fero | undefined, c: Fero | undefined
  try {
    s = await fero(name, { server: true, heartbeatMs: 50, redialMs: 30, rendezvous })
    c = await fero(name, { heartbeatMs: 50, redialMs: 30, rendezvous })
    assert.deepEqual(me(s).rendezvous, { addr: rendezvous, hosting: false, up: false }, 'EADDRINUSE is the ordinary outcome — no error surfaced for it')
    assert.match(me(s).listen, /^127\.0\.0\.1:[1-9]\d*$/, 'the server serves regardless')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(rz(c).up, false)
    await new Promise<void>((r) => squatter.close(() => r()))
    //! the port frees: the server's (backed-off) retry loop binds it, the client's redial/revival finds it, discovery heals
    assert.ok(await until(() => rz(s!).hosting, 12_000), 'the server hosts once the squatter leaves')
    s.data.k = 1
    assert.ok(await until(() => data(c!).k === 1, 8000), 'the client discovered the server after the heal')
  } finally { await settle([c, s]); squatter.close() }
})

test('a rendezvous this box cannot bind at all (an interface that is not here) surfaces the errno on cluster.me.rendezvous.error', async () => {
  const rendezvous = `192.0.2.1:${await ports.free()}` // TEST-NET-1: never a local interface
  let s: Fero | undefined
  try {
    s = await fero(`nobind-${process.pid}`, { server: true, heartbeatMs: 50, redialMs: 30, rendezvous })
    assert.ok(await until(() => typeof rz(s!).error === 'string' && rz(s!).error!.startsWith('bind '), 5000), `the errno is on me.rendezvous: ${JSON.stringify(rz(s).error)}`)
    assert.equal(rz(s).hosting, false)
    assert.match(me(s).listen, /^127\.0\.0\.1:[1-9]\d*$/, 'the resource itself serves')
  } finally { await settle([s]) }
})
