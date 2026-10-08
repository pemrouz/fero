//! Tier-3 directory suite (V4-3, docs/DESIGN-DIRECTORY.md): the per-box rendezvous directory over REAL
// sockets, the way a consumer meets it — zero addresses, zero identities, zero hashing — plus the
// host table driven WITHOUT sockets (the fold-order defect and the ownership rules are pinned
// deterministically). Every socket test opts in with its OWN free rendezvous port (the battery runs
// FERO_RENDEZVOUS=off — pinned below at import time too, so a single-file run never meets a live
// box directory — and a fixed port would collide across concurrent checkouts) and pid-suffixed names.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fero, RENDEZVOUS } from './index.ts'
import { Directory, GRACE, MAX_PER_CALLER, boxDirectory, fromBox, hostMethods, isAddr, isBox, leavesBox, rendezvousDefault, sameDirectory, sameSocket } from './directory.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { MEMBER_REDIALS } from '../kernel/node.ts'
import { ports, sleep, until } from '#utils'
import type { Fero } from './types.ts'
import type { Context } from './methods.ts'

const fast = async () => ({ heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous: `127.0.0.1:${await ports.free()}` })
type Rz = false | { addr: string; hosting: boolean; up: boolean; error?: string; boxes?: Record<string, { up: boolean; error?: string }> }
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
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, rendezvous: false, listen: RENDEZVOUS }), /would take the directory's socket/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, rendezvous: false }), /needs something to dial.*omitted/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, rendezvous: false, hosts: [] }), /needs something to dial.*empty/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, rendezvous: 'nope' as never }), /rendezvous must be/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, rendezvous: '127.0.0.1:0' as never }), /rendezvous must be/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 }, listen: ':5' }), /listen must be/)
  await assert.rejects(fero('', { heartbeat: { ms: 0 } }), /name must be a non-empty string/)
  //! rendezvous: false is the pure-static shape — a server meets no directory, and says so; so does a
  // socketless solo even WITH a rendezvous (it meets none: `false`, never "down")
  const solo = await fero(`r-${process.pid}`, { server: true, heartbeat: { ms: 0 }, rendezvous: false })
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
    await assert.rejects(fero(`r-${process.pid}`, { heartbeat: { ms: 0 } }), /needs something to dial/)
    const s = await fero(`r-${process.pid}`, { server: true, ...o })
    assert.equal(rz(s).addr, o.rendezvous, 'config beats the env')
    await s.destroy()
    process.env.FERO_RENDEZVOUS = 'garbage'
    await assert.rejects(fero(`r-${process.pid}`, { server: true, heartbeat: { ms: 0 } }), /FERO_RENDEZVOUS='garbage' is not/)
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
  // still being dialed), not SUSPECT_TICKS. A dead MEMBER runs the short chain (MEMBER_REDIALS, kernel/tune.ts):
  // ≈ redial.ms·(1+2+4+…, capped at 32) plus up to one base of jitter per try — derive the bound from that
  const chain = Array.from({ length: MEMBER_REDIALS }, (_, i) => Math.min(2 ** i, 32) + 1).reduce((a, b) => a + b, 0) * o.redial.ms
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

test('I-34 — two servers and NOTHING else: a clean leave drops the leaver\'s entry at once, so no lookup hands out the dead address meanwhile', async () => {
  const o = await fast()
  const name = `leave2-${process.pid}`
  let a: Fero | undefined, b: Fero | undefined
  try {
    a = await fero(name, { server: true, ...o })
    b = await fero(name, { server: true, ...o })
    assert.ok(await until(() => members(a!) === 2 && me(a!).hosts.length === 1, 10_000), 'a found b through the directory alone')
    const gone = me(b).listen
    assert.deepEqual(me(a).hosts, [gone])
    await b.destroy()
    //! the host's table folds ONLY on the host's own link events. A registrant is `seen` when a pass finds
    // its peer up — and with two servers and nothing else no pass ever ran after b's register, so b sat in
    // the GRACE budget: its link-down fold counted one pass and nothing else ever folded (the smoke tier
    // has a client as a third instance, whose link events supplied the passes). ~a second is the whole
    // close → fold → drop path, with slack for a loaded box.
    assert.ok(await until(() => me(a!).hosts.length === 0, 1500), `b's address left the lookup at once (hosts: ${JSON.stringify(me(a).hosts)})`)
  } finally { await settle([b, a]) }
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
    //! the host's register refuses a local invoke (its ctx.peer is the host itself) — the wire is the only way in
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
    mis = await fero(`mis-${process.pid}`, { hosts: [o.rendezvous], heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous: false })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(peers(mis), 0, 'never admitted — the HELLO name echo refuses')
    const j = diag(mis)!.journal(0).events
    const rejects = j.filter((e) => e.kind === 71 /* JK.nameReject */).length
    assert.ok(rejects >= 2, `re-dialed and refused again at heartbeat cadence (${rejects} rejects) — a squat is a bounded nuisance, not a strand`)
  } finally { await settle([mis, s]) }
})

test("Context.peer: a wire call carries the caller uuid, a local invoke carries the server's own", async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  let s: Fero | undefined, c: Fero | undefined
  try {
    s = await fero(`peer-${process.pid}`, { listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous: false, methods: { who: (_: unknown, ctx: { peer?: string }) => ctx.peer ?? null } })
    c = await fero(`peer-${process.pid}`, { hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous: false })
    assert.ok(await until(() => peers(c!) === 1))
    assert.equal(await c.methods.who(), me(c).uuid)
    assert.equal(await s.methods.who(), me(s).uuid, 'the server IS the caller of its own call')
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
    s = await fero(name, { server: true, heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous })
    c = await fero(name, { heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous })
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

//! routableHere — an IPv4 address this machine owns that is not spelled as loopback: one on the loopback
// interface first (WSL's 10.255.255.254 — routable-looking, reachable from nowhere else), else a real
// interface's; undefined when there is none (the test that needs it skips)
const routableHere = (): string | undefined => {
  const all = Object.values(os.networkInterfaces()).flat().filter((a) => a !== undefined && a.family === 'IPv4' && !a.address.startsWith('127.'))
  return (all.find((a) => a!.internal) ?? all.find((a) => !a!.internal))?.address
}

test('a rendezvous this box cannot bind at all (an interface that is not here) surfaces the errno on cluster.me.rendezvous.error', async (t) => {
  const rendezvous = `192.0.2.1:${await ports.free()}` // TEST-NET-1: never a local interface
  //! a directory on a routable address answers other boxes, so the explicit-listen rule (§11) wants a
  // routable listen beside it — one this machine owns
  const ip = routableHere()
  if (ip === undefined) return t.skip('no non-loopback IPv4 address on this machine')
  let s: Fero | undefined
  try {
    s = await fero(`nobind-${process.pid}`, { listen: `${ip}:0`, heartbeat: { ms: 50 }, redial: { ms: 30 }, rendezvous })
    assert.ok(await until(() => typeof rz(s!).error === 'string' && rz(s!).error!.startsWith('bind '), 5000), `the errno is on me.rendezvous: ${JSON.stringify(rz(s).error)}`)
    assert.equal(rz(s).hosting, false)
    assert.ok(me(s).listen.startsWith(`${ip}:`) && !me(s).listen.endsWith(':0'), 'the resource itself serves')
  } finally { await settle([s]) }
})

test("a lookup the directory host FAILS shows on rendezvous.error — it is not an unhandled `ready` rejection that exits the server", async () => {
  //! a stand-in host whose lookup throws, under a user name (a `#` name is the composer's alone); the
  // Directory is the real one, composing its client through the same seam the composer hands it
  const name = `dirx${process.pid}`
  const addr = `127.0.0.1:${await ports.free()}`
  const host = await fero(name, { listen: addr, heartbeat: { ms: 50 }, redial: { ms: 30 }, methods: { lookup: () => { throw new Error('lookup exploded') }, register: () => true } })
  const d = new Directory({
    compose: (_n, o) => fero(name, o), addr, name: 'r', uuid: 'u1', listen: () => undefined, serve: false,
    heartbeatMs: 50, redialMs: 30, onHosts: () => {}, onState: () => {},
  })
  try {
    await d.start()
    //! before: the subscribe leg's failure was dropped at the caller — the lookup mirror stayed {} and
    // nothing said why. With an eager `ready` and no catch here, it would exit the server instead.
    assert.ok(await until(() => d.error?.includes('lookup exploded') === true, 8000), `the failure is on the state (${d.error})`)
  } finally {
    await d.destroy(); await host.destroy()
  }
})

test("I-19 guard: a directory client that composes as anything but a client fails start() NAMING the role, not with `c.methods.lookup is not a function`", async () => {
  //! the one way `lookup` is not a function: the compose handed back a SERVER (its methods are its own
  // table). Forced here through the compose seam; the guard turns a bare TypeError into the cause.
  const d = new Directory({
    compose: (_n, o) => fero(`i19g${process.pid}`, { ...o, hosts: undefined, listen: false }), addr: '127.0.0.1:1', name: 'r', uuid: 'u1',
    listen: () => undefined, serve: false, heartbeatMs: 50, redialMs: 30, onHosts: () => {}, onState: () => {},
  })
  try {
    await assert.rejects(d.start(), /#directory: the directory client composed as a server/)
  } finally {
    await d.destroy()
  }
})

test("I-19 — the directory host is SIGKILLed and a new server boots 0-500 ms later: its fero() resolves and it takes the directory over (the race the one sighting came from)", async () => {
  //! the host is a real process (`node host.ts`), killed the hard way; the newcomer is in-process. Each
  // round its own private rendezvous port, so a slow socket close in one round cannot leak into the next.
  const name = `i19${process.pid}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-i19-'))
  const script = path.join(dir, 'host.ts')
  fs.writeFileSync(script, `import { fero } from ${JSON.stringify(path.join(import.meta.dirname, 'index.ts'))}
import { snapshot } from ${JSON.stringify(path.join(import.meta.dirname, 'substrate.ts'))}
const f = await fero(process.argv[2], { server: true, rendezvous: process.argv[3], heartbeat: { ms: 50 }, redial: { ms: 30 } })
console.log('hosting ' + (snapshot(f.cluster) as { me: { rendezvous: { hosting: boolean } } }).me.rendezvous.hosting)
setInterval(() => {}, 1000)
`)
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    for (const gap of [0, 50, 200, 500]) {
      const addr = `127.0.0.1:${await ports.free()}`
      const host = fero.spawn(script, [name, addr]); kids.push(host)
      assert.ok(await until(() => /hosting true/.test(host.out), 15_000), `gap ${gap}: the spawned server hosts the directory (${host.out})`)
      host.child.kill('SIGKILL')
      await host.exited
      await sleep(gap)
      const b = await fero(name, { server: true, rendezvous: addr, heartbeat: { ms: 50 }, redial: { ms: 30 } })
      try {
        assert.ok(await until(() => rz(b).hosting, 10_000), `gap ${gap}: the newcomer took the directory over (${JSON.stringify(rz(b))})`)
      } finally {
        await b.destroy()
      }
    }
  } finally {
    for (const k of kids) if (k.child.exitCode === null && k.child.signalCode === null) { k.child.kill('SIGKILL'); await k.exited }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

//! ── cross-box discovery (docs/DESIGN-DIRECTORY.md §11): a bare host asks that box's directory ──

test('cross-box helpers: a bare host (isBox) names a box, its directory sits at the rendezvous port, the same directory is spotted under either spelling, another box may not add loopback addresses, and leavesBox says exactly when a listen leaves this box', () => {
  for (const ok of ['10.0.0.5', 'box-b', 'box-b.lan', '127.0.0.2', '[fe80::1]', 'a']) assert.ok(isBox(ok), ok)
  for (const bad of ['', '50', '--fero.heartbeat.ms', '-box', 'box-', 'a b', '10.0.0.5:4000', '::1', 7, undefined]) assert.equal(isBox(bad), false, String(bad))
  assert.equal(boxDirectory('10.0.0.5', '127.0.0.1:3376'), '10.0.0.5:3376', "the port is this instance's rendezvous port")
  assert.equal(boxDirectory('[fe80::1]', '127.0.0.1:4100'), '[fe80::1]:4100')
  assert.ok(sameDirectory('localhost:3376', '127.0.0.1:3376'), "'localhost' is this box's own directory")
  //! every spelling that DIALS this box's directory is this box: names are case-blind, and a wildcard
  // dialed reaches loopback (a wildcard directory answers on loopback too). '[::1]' is a different socket
  // from 127.0.0.1 — nothing answers there, so it is honestly another (down) box.
  for (const own of ['LOCALHOST:3376', 'LocalHost:3376', '0.0.0.0:3376'])
    assert.ok(sameDirectory(own, '127.0.0.1:3376'), `${own} dials this box's own directory`)
  assert.ok(sameDirectory('127.0.0.1:3376', '0.0.0.0:3376'), 'a wildcard directory answers on loopback')
  assert.ok(sameDirectory('[::]:3376', '[::1]:3376'))
  assert.equal(sameDirectory('[::1]:3376', '127.0.0.1:3376'), false, '::1 and 127.0.0.1 are two sockets')
  assert.equal(sameDirectory('127.0.0.2:3376', '127.0.0.1:3376'), false, 'another loopback IP stands for another box')
  assert.equal(sameDirectory('10.0.0.5:3377', '10.0.0.5:3376'), false)
  //! fromBox: a loopback or wildcard address from ANOTHER box's directory would dial THIS box — dropped,
  // unless it is the very host the directory was reached on
  assert.deepEqual(fromBox('10.0.0.5:3376', { a: '10.0.0.5:4000', b: '127.0.0.1:4001', c: '0.0.0.0:4002', d: 'localhost:4003', e: '10.0.0.9:4004', f: 7 }), ['10.0.0.5:4000', '10.0.0.9:4004'])
  assert.deepEqual(fromBox('127.0.0.2:3376', { a: '127.0.0.2:4000', b: '127.0.0.1:4001' }), ['127.0.0.2:4000'], 'the loopback IP the directory answered on is that box')
  //! leavesBox — the explicit-listen rule's trigger, every case
  assert.equal(leavesBox('127.0.0.1:3376', []), null, 'nothing set: the one-box shape, no rule')
  assert.equal(leavesBox(false, ['127.0.0.1:4801', 'localhost:4802', '127.0.0.2']), null, 'every host on this box')
  assert.equal(leavesBox('localhost:3376', ['[::1]:4801']), null)
  assert.equal(leavesBox('LOCALHOST:3376', ['LocalHost:4801', 'LOCALHOST']), null, 'host names are case-blind: LOCALHOST is this box')
  assert.ok(sameSocket('LOCALHOST:3376', '127.0.0.1:3376'), 'LOCALHOST cannot squat the directory either')
  assert.match(leavesBox('127.0.0.1:3376', ['10.0.0.5'])!, /hosts names 10\.0\.0\.5, another box/, 'a bare host naming another box')
  assert.match(leavesBox(false, ['10.0.0.5:4800'])!, /hosts names 10\.0\.0\.5:4800, another box/, 'a ported host on another box: HELLO carries the listen there')
  assert.match(leavesBox('10.0.0.5:3376', [])!, /its directory 10\.0\.0\.5:3376 answers other boxes/, 'a routable directory')
  assert.match(leavesBox('0.0.0.0:3376', [])!, /answers other boxes/, 'a wildcard directory answers other boxes too')
})

test('the explicit-listen rule: a server whose listen is loopback (or a wildcard, or the default) is refused at fero() whenever it would leave this box; a routable listen passes; a bare host with the directory off is refused; nothing set is untouched', async () => {
  const o = await fast()
  const rule = /fero\('r'\): to be reachable from another box, listen on a routable address — /
  //! a bare host naming another box: the default listen, an explicit loopback, a wildcard
  await assert.rejects(fero('r', { ...o, server: true, hosts: ['10.0.0.5'] }), (e: Error) => rule.test(e.message) && /hosts names 10\.0\.0\.5, another box, but listen 127\.0\.0\.1:0 \(the default, a free loopback port\) only reaches this box$/.test(e.message))
  await assert.rejects(fero('r', { ...o, listen: '127.0.0.1:0', hosts: ['box-b'] }), (e: Error) => rule.test(e.message) && /but listen 127\.0\.0\.1:0 only reaches this box$/.test(e.message))
  await assert.rejects(fero('r', { ...o, listen: '0.0.0.0:0', hosts: ['10.0.0.5'] }), /listen 0\.0\.0\.0:0 is a wildcard, not an address another box can dial/)
  await assert.rejects(fero('r', { ...o, listen: 'LOCALHOST:0', hosts: ['10.0.0.5'] }), /but listen LOCALHOST:0 only reaches this box$/, 'a loopback name in capitals is still loopback')
  //! a ported host on another box with an EXPLICIT loopback listen — V4-2's guard caught only the default
  await assert.rejects(fero('r', { heartbeat: { ms: 0 }, rendezvous: false, listen: 'localhost:0', hosts: ['10.0.0.5:4800'] }), rule)
  //! a directory other boxes can ask: a server registering a loopback listen there is refused; its clients are not servers
  for (const rv of ['192.0.2.1:3376', '0.0.0.0:3376'])
    await assert.rejects(fero('r', { heartbeat: { ms: 0 }, rendezvous: rv, server: true }), /its directory .* answers other boxes/, rv)
  //! a ROUTABLE listen passes the rule: it gets as far as the bind, which fails here only because
  // 192.0.2.1 (TEST-NET-1, never assigned) is not this box's address
  await assert.rejects(fero('r', { ...o, listen: '192.0.2.1:0', hosts: ['192.0.2.2'] }), (e: Error) => !/routable/.test(e.message) && /EADDRNOTAVAIL|EINVAL|bind|listen/i.test(e.message))
  //! a bare host and the directory off: no port to ask at — refused, naming the layer
  await assert.rejects(fero('r', { heartbeat: { ms: 0 }, rendezvous: false, hosts: ['10.0.0.5'] }), /hosts entry '10\.0\.0\.5' has no port, which means "ask that box's directory" — but the directory is off \(rendezvous: false\): give the entry its port, or turn the directory on/)
  //! nothing set, or every address on this box: no rule, as before
  const s = await fero(`r-${process.pid}`, { ...o, server: true, hosts: ['127.0.0.2', 'localhost'] })
  try {
    assert.match(me(s).listen, /^127\.0\.0\.1:[1-9]\d*$/)
    assert.deepEqual(Object.keys(rz(s).boxes ?? {}), [`127.0.0.2:${o.rendezvous.split(':')[1]}`], "'localhost' is this box's own directory: not asked twice")
    assert.deepEqual(me(s).hosts, [], 'a bare host is never a dial target itself')
  } finally { await s.destroy() }
})

//! a second "box" on this machine: 127.0.0.2 is loopback on Linux and Windows (macOS needs an alias — skipped there)
const bindable = (host: string, port = 0): Promise<boolean> => new Promise((res) => {
  const s = net.createServer()
  s.once('error', () => res(false))
  s.listen(port, host, () => s.close(() => res(true)))
})
//! one rendezvous port free on BOTH boxes — every box runs its directory on the same port
const boxPort = async (): Promise<number> => {
  for (let i = 0; i < 20; i++) { const p = await ports.free(); if (await bindable('127.0.0.2', p)) return p }
  throw new Error('no port free on both 127.0.0.1 and 127.0.0.2')
}

test('two boxes on one machine (127.0.0.1 and 127.0.0.2, one rendezvous port, a directory each): a server on box A told the bare host 127.0.0.2 asks box B\'s directory, the two servers form ONE view, a bare client on either box reads it, and box A\'s directory never learns box B\'s server', async (t) => {
  if (!(await bindable('127.0.0.2'))) return t.skip('127.0.0.2 is not a loopback address on this machine')
  const port = await boxPort()
  const A = `127.0.0.1:${port}`, B = `127.0.0.2:${port}`
  const name = `xbox-${process.pid}`
  const base = { heartbeat: { ms: 50 }, redial: { ms: 30 } }
  let sb: Fero | undefined, sa: Fero | undefined, ca: Fero | undefined, cb: Fero | undefined, cx: Fero | undefined, sa2: Fero | undefined
  try {
    //! box B: a server on 127.0.0.2, with box B's directory — it is told nothing about box A
    sb = await fero(name, { ...base, rendezvous: B, listen: '127.0.0.2:0' })
    assert.ok(await until(() => rz(sb!).hosting && rz(sb!).up, 5000), 'box B hosts its own directory')
    //! box A: a server whose hosts names box B with no port
    sa = await fero(name, { ...base, rendezvous: A, server: true, hosts: ['127.0.0.2'] })
    assert.ok(await until(() => members(sa!) === 2 && members(sb!) === 2, 10_000), `one view across the boxes (${members(sa)}, ${members(sb)})`)
    assert.ok(rz(sa).hosting, 'box A hosts its own directory: asking another box hosts nothing there')
    assert.deepEqual(rz(sa).boxes, { [B]: { up: true } }, "box B's directory, asked and up, on cluster.me.rendezvous.boxes")
    assert.ok(me(sa).hosts.includes(me(sb).listen), "box B's server, found through box B's directory")
    assert.equal(rz(sb).boxes, undefined, 'box B was told nothing: no boxes row')
    //! a bare client on each box, told nothing but its own box's directory, finds the one cluster
    ca = await fero(name, { ...base, rendezvous: A })
    cb = await fero(name, { ...base, rendezvous: B })
    assert.ok(await until(() => me(ca!).hosts.length === 1, 5000), 'the client on box A found its box\'s server')
    assert.deepEqual(me(ca).hosts, [me(sa).listen], "box A's directory lists only box A's server — asking registers nothing")
    sb.data.k = 'from-b'
    sa.data.j = 'from-a'
    assert.ok(await until(() => data(ca!).k === 'from-b' && data(cb!).j === 'from-a', 10_000), 'a write on either box reaches a client on the other')
    //! a client on box A that asks box B ALONE (its own box's server is not in its hosts) still reads the cluster
    cx = await fero(name, { ...base, rendezvous: A, hosts: ['127.0.0.2'] })
    assert.ok(await until(() => me(cx!).hosts.includes(me(sb!).listen) && data(cx!).k === 'from-b', 10_000), 'a client asking box B finds box B\'s server')
    assert.equal(me(cx).role, 'client', 'a bare host is not a server marker')
    //! the union over sources: a second server on box A changes box A's OWN row, so box A's source
    // re-publishes — box B's server must stay in the dial set (the kernel's discover replaces the set
    // wholesale; publishing only the latest source would drop box B until its row changed again)
    sa2 = await fero(name, { ...base, rendezvous: A, server: true })
    assert.ok(await until(() => me(sa!).hosts.includes(me(sa2!).listen), 10_000), "box A's second server reaches sa through box A's directory")
    assert.ok(me(sa).hosts.includes(me(sb).listen), `box B's server is still in sa's dial set after box A's row changed (${me(sa).hosts})`)
  } finally { await settle([sa2, cx, cb, ca, sa, sb]) }
})

test("a misdial: a bare host whose rendezvous port holds a user resource, not a directory, is refused by the HELLO name echo — the box reads down, nothing links, the resource is untouched", async (t) => {
  if (!(await bindable('127.0.0.2'))) return t.skip('127.0.0.2 is not a loopback address on this machine')
  const port = await boxPort()
  const base = { heartbeat: { ms: 50 }, redial: { ms: 30 } }
  let other: Fero | undefined, c: Fero | undefined
  try {
    //! box B's rendezvous port is held by a user resource named 'other' (its own directory off)
    other = await fero(`other-${process.pid}`, { ...base, rendezvous: false, listen: `127.0.0.2:${port}` })
    c = await fero(`shop-${process.pid}`, { ...base, rendezvous: `127.0.0.1:${port}`, hosts: ['127.0.0.2'] })
    await sleep(400)
    assert.deepEqual(rz(c).boxes, { [`127.0.0.2:${port}`]: { up: false } }, 'the box reads down')
    assert.equal(peers(other), 0, "the resource admitted nobody: '#directory' is not its name")
    assert.deepEqual(me(c).hosts, [], 'nothing discovered')
    //! the box's directory client dialed and was name-rejected, again at heartbeat cadence — a bounded nuisance, not a strand
    const bc = diag(c)!.rendezvous()!.boxes[`127.0.0.2:${port}`]
    const rejects = diag(bc)!.journal(0).events.filter((e) => e.kind === 71 /* JK.nameReject */).length
    assert.ok(rejects >= 2, `re-dialed and refused again (${rejects} rejects)`)
  } finally { await settle([c, other]) }
})
