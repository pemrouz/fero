//! Tier-3 directory suite (V4-3, DESIGN-DIRECTORY.md): the per-box rendezvous directory over REAL
// sockets, the way a consumer meets it — zero addresses, zero identities, zero hashing. Every test
// opts in with its OWN free rendezvous port (the battery runs FERO_RENDEZVOUS=off, and a fixed port
// would collide across concurrent checkouts on one box) and pid-suffixed names.

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import { fero, RENDEZVOUS } from './index.ts'
import { rendezvousDefault } from './directory.ts'
import { snapshot } from './substrate.ts'
import { diag } from './diagnostics.ts'
import { ports, until } from '#utils'
import type { Fero } from './types.ts'

const fast = async () => ({ heartbeatMs: 50, redialMs: 30, rendezvous: `127.0.0.1:${await ports.free()}` })
type Me = { uuid: string; listen: string; role: string; hosts: string[]; rendezvous: false | { addr: string; hosting: boolean; up: boolean } }
const me = (f: Fero): Me => (snapshot(f.cluster) as { me: Me }).me
const members = (f: Fero): number => Object.keys((snapshot(f.cluster) as { members: Record<string, string> }).members ?? {}).length
const peers = (f: Fero): number => Object.keys((snapshot(f.cluster) as { peers: Record<string, unknown> }).peers ?? {}).length
const data = (f: Fero) => snapshot(f.data) as Record<string, unknown>

test('directory config: # names are reserved, a user resource may not listen on the rendezvous, a client with no directory and no hosts refuses, bad values refuse', async () => {
  const o = await fast()
  await assert.rejects(fero('#anything', { ...o, server: true }), /reserved for system resources/)
  await assert.rejects(fero(`r-${process.pid}`, { ...o, listen: o.rendezvous }), /is the rendezvous address/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: false }), /needs something to dial.*omitted/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: false, hosts: [] }), /needs something to dial.*empty/)
  await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0, rendezvous: 'nope' as never }), /rendezvous must be/)
  await assert.rejects(fero('', { heartbeatMs: 0 }), /name must be a non-empty string/)
  //! rendezvous: false is the pure-static shape — a server meets no directory, and says so
  const solo = await fero(`r-${process.pid}`, { server: true, heartbeatMs: 0, rendezvous: false })
  assert.equal(me(solo).rendezvous, false)
  assert.equal(diag(solo)!.rendezvous(), null, 'no directory nodes')
  assert.match(me(solo).listen, /^127\.0\.0\.1:[1-9]\d*$/, 'still a free loopback port')
  await solo.destroy()
  //! the process default: FERO_RENDEZVOUS=off (the battery) ⇒ false; unset ⇒ the constant; an address ⇒ itself
  const saved = process.env.FERO_RENDEZVOUS
  try {
    process.env.FERO_RENDEZVOUS = 'off'; assert.equal(rendezvousDefault(), false)
    delete process.env.FERO_RENDEZVOUS; assert.equal(rendezvousDefault(), RENDEZVOUS)
    process.env.FERO_RENDEZVOUS = '127.0.0.1:4000'; assert.equal(rendezvousDefault(), '127.0.0.1:4000')
    process.env.FERO_RENDEZVOUS = 'off'
    await assert.rejects(fero(`r-${process.pid}`, { heartbeatMs: 0 }), /needs something to dial/)
  } finally { if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved }
})

test('N bare servers form a view with NO addresses and NO uuid pins — the genesis coin-flip is closed (three rounds)', async () => {
  for (let round = 0; round < 3; round++) {
    const o = await fast()
    const name = `form-${round}-${process.pid}`
    const ss = [await fero(name, { server: true, ...o }), await fero(name, { server: true, ...o }), await fero(name, { server: true, ...o })]
    try {
      assert.ok(await until(() => ss.every((s) => members(s) === 3), 10_000), `round ${round}: 3-member view through the directory alone`)
      assert.equal(ss.filter((s) => (me(s).rendezvous as { hosting: boolean }).hosting).length, 1, 'exactly one hosts the directory')
      for (const s of ss) {
        const m = me(s)
        assert.match(m.listen, /^127\.0\.0\.1:[1-9]\d*$/)
        assert.equal(m.hosts.length, 2, 'the two OTHER servers, discovered')
        assert.ok(!m.hosts.includes(m.listen), 'own listen excluded')
        assert.equal((m.rendezvous as { up: boolean }).up, true)
      }
      ss[1].data.k = 'v'
      assert.ok(await until(() => ss.every((s) => data(s).k === 'v')), 'replicates')
    } finally { for (const s of ss) await s.destroy() }
  }
})

test('a bare client finds explicit-listen servers through the directory; the discovered set and the rendezvous state ride cluster.me', async () => {
  const o = await fast()
  const name = `find-${process.pid}`
  const a1 = `127.0.0.1:${await ports.free()}`, a2 = `127.0.0.1:${await ports.free()}`
  const s1 = await fero(name, { listen: a1, hosts: [a2], ...o })
  const s2 = await fero(name, { listen: a2, hosts: [a1], ...o })
  const c = await fero(name, o)
  try {
    assert.equal(me(c).role, 'client')
    s1.data.k = 1
    assert.ok(await until(() => data(c).k === 1), 'found through the directory — zero addresses on the client')
    assert.ok(await until(() => me(c).hosts.length === 2 && peers(c) === 2))
    assert.deepEqual([...me(c).hosts].sort(), [a1, a2].sort(), 'discovered = the registered listens')
    assert.deepEqual(me(c).rendezvous, { addr: o.rendezvous, hosting: false, up: true }, 'a client never hosts')
    //! static ∪ discovered: a client with one explicit host still learns the other
    const c2 = await fero(name, { ...o, hosts: [a1] })
    assert.ok(await until(() => me(c2).hosts.length === 2))
    await c2.destroy()
  } finally { await c.destroy(); await s1.destroy(); await s2.destroy() }
})

test('directory host death: a survivor takes the port over, the client fails over, a NEW client finds the survivors, a bare restart joins as a new member', async () => {
  const o = await fast()
  const name = `take-${process.pid}`
  const s1 = await fero(name, { server: true, ...o })
  const s2 = await fero(name, { server: true, ...o })
  const s3 = await fero(name, { server: true, ...o })
  const c = await fero(name, o)
  let late: Fero | null = null, s4: Fero | null = null
  try {
    assert.ok(await until(() => [s1, s2, s3].every((s) => members(s) === 3), 10_000))
    assert.ok((me(s1).rendezvous as { hosting: boolean }).hosting, 'the first server hosts')
    s1.data.k = 'v1'
    assert.ok(await until(() => data(c).k === 'v1' && peers(c) === 3))
    await s1.destroy()
    assert.ok(await until(() => (me(s2).rendezvous as { hosting: boolean }).hosting || (me(s3).rendezvous as { hosting: boolean }).hosting, 5000), 'a survivor re-hosts')
    assert.ok(await until(() => members(s2) === 2 && members(s3) === 2, 10_000), 'the survivors evicted the dead host')
    s2.data.k = 'v2'
    assert.ok(await until(() => data(c).k === 'v2'), 'the client failed over')
    assert.ok(await until(() => me(c).hosts.length === 2), 'the dead server left every lookup')
    late = await fero(name, o)
    assert.ok(await until(() => data(late!).k === 'v2'), 'a NEW client after the host died still finds the survivors — the gap the derived port had')
    s4 = await fero(name, { server: true, ...o })
    assert.ok(await until(() => members(s4!) === 3 && members(s2) === 3, 10_000), 'a bare restart joins as a NEW member')
    s4.data.k = 'v3'
    assert.ok(await until(() => [s2, s3, c, late!].every((f) => data(f).k === 'v3')))
    assert.ok(await until(() => me(c).hosts.length === 3), 'the client re-folded to three')
  } finally { for (const f of [c, late, s4, s2, s3]) await f?.destroy(); await s1.destroy().catch(() => {}) }
})

test('entries die with their registrant: destroying a server removes it from every live lookup', async () => {
  const o = await fast()
  const name = `die-${process.pid}`
  const s1 = await fero(name, { server: true, ...o })
  const s2 = await fero(name, { server: true, ...o })
  const c = await fero(name, o)
  try {
    assert.ok(await until(() => me(c).hosts.length === 2))
    const gone = me(s2).listen
    await s2.destroy()
    assert.ok(await until(() => me(c).hosts.length === 1 && !me(c).hosts.includes(gone)), 'the closed link forgot its entry — no unregister call needed')
    assert.ok(await until(() => me(s1).hosts.length === 0))
  } finally { await c.destroy(); await s1.destroy() }
})

test('two names on one box never collide, never cross-talk, and the diagnostics seam exposes the directory nodes as real instances', async () => {
  const o = await fast()
  const a = await fero(`alpha-${process.pid}`, { server: true, ...o })
  const b = await fero(`beta-${process.pid}`, { server: true, ...o })
  const ca = await fero(`alpha-${process.pid}`, o)
  const cb = await fero(`beta-${process.pid}`, o)
  try {
    a.data.x = 1; b.data.y = 2
    assert.ok(await until(() => data(ca).x === 1 && data(cb).y === 2))
    assert.equal(data(ca).y, undefined); assert.equal(data(cb).x, undefined)
    assert.deepEqual(me(ca).hosts, [me(a).listen]); assert.deepEqual(me(cb).hosts, [me(b).listen])
    const d = diag(a)!.rendezvous()!
    assert.equal(d.host?.name, '#directory', 'the first server hosts the system resource')
    assert.equal(d.client?.name, '#directory')
    assert.equal(diag(b)!.rendezvous()!.host, null, 'the second does not')
    assert.equal(diag(ca)!.rendezvous()!.client?.name, '#directory')
  } finally { for (const f of [ca, cb, a, b]) await f.destroy() }
})

test('Context.peer: a wire call carries the caller uuid, a local invoke carries none', async () => {
  const addr = `127.0.0.1:${await ports.free()}`
  const s = await fero(`peer-${process.pid}`, { listen: addr, heartbeatMs: 50, redialMs: 30, rendezvous: false, who: (_: unknown, ctx: { peer?: string }) => ctx.peer ?? null })
  const c = await fero(`peer-${process.pid}`, { hosts: [addr], heartbeatMs: 50, redialMs: 30, rendezvous: false })
  try {
    assert.ok(await until(() => peers(c) === 1))
    assert.equal(await c.methods.who(), me(c).uuid)
    assert.equal(await s.methods.who(), null)
  } finally { await c.destroy(); await s.destroy() }
})

test('a non-fero squatter on the rendezvous port: the resource itself is unaffected, discovery reports down, and recovers when the port frees', async () => {
  const port = await ports.free()
  const rendezvous = `127.0.0.1:${port}`
  //! the squatter answers with junk and hangs up — a real foreign service; its sockets must not pin
  // server.close() open (net.Server.close waits for every connection)
  const squatter = net.createServer((sock) => { sock.write('not fero\n'); sock.destroy() })
  await new Promise<void>((res) => squatter.listen(port, '127.0.0.1', res))
  const name = `squat-${process.pid}`
  const s = await fero(name, { server: true, heartbeatMs: 50, redialMs: 30, rendezvous })
  const c = await fero(name, { heartbeatMs: 50, redialMs: 30, rendezvous })
  try {
    assert.deepEqual(me(s).rendezvous, { addr: rendezvous, hosting: false, up: false })
    assert.match(me(s).listen, /^127\.0\.0\.1:[1-9]\d*$/, 'the server serves regardless')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((me(c).rendezvous as { up: boolean }).up, false)
    await new Promise<void>((r) => squatter.close(() => r()))
    //! the port frees: the server's retry loop binds it, the client's redial/revival finds it, discovery heals
    assert.ok(await until(() => (me(s).rendezvous as { hosting: boolean }).hosting, 8000), 'the server hosts once the squatter leaves')
    s.data.k = 1
    assert.ok(await until(() => data(c).k === 1, 8000), 'the client discovered the server after the heal')
  } finally { await c.destroy(); await s.destroy(); squatter.close() }
})
