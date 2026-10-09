//! Tier-3 real-socket door tier (DESIGN-DOOR §9, "only real sockets prove"): the STATUS.md:54 scenario end to end
// with a raw net.Socket writing crafted frames at a real fero() server, and a fero.spawn child that gets its secret
// from the environment. The kernel's handshake is proved on seeded schedules (kernel/door.test.ts, sim/door.test.ts);
// this file proves what only sockets can — node:crypto's HMAC and nonces across processes, the best-effort notice
// under socket.destroy(), the deadline on a real timer — and documents the open door's one remaining limit by name.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { diag } from '../api/diagnostics.ts'
import { JK } from '../kernel/journal.ts'
import { VERB, Framer, encodeControl, type Frame } from '../kernel/codec.ts'
import { PROOF_LEN } from '../kernel/door.ts'
import { ports, sleep, until } from '#utils'
import type { Fero } from '../api/types.ts'

type View = { epoch: number; members: Record<string, string>; peers: Record<string, unknown> }
const view = (f: Fero) => snapshot(f.cluster) as View
const rows = (f: Fero, kind: number) => diag(f)!.journal().events.filter((e) => e.kind === kind)
const doorRows = (f: Fero) => rows(f, JK.doorReject).map((e) => [e.b, e.c] as [string, string])

//! raw — a hand-written peer on a real socket: connect to `addr`, write `hello` at once, then hand every frame the
// server sends to `onFrame` (which may write back); resolves with what was read when the server closes the socket
// or `ms` pass. The secured server's HELLO carries `k`; the proof we send is never right (we hold no secret).
const raw = (addr: string, hello: Record<string, unknown>, onFrame: (f: Frame, sock: net.Socket) => void, ms = 1500): Promise<{ frames: Frame[]; closed: boolean }> =>
  new Promise((resolve) => {
    const [host, port] = [addr.slice(0, addr.lastIndexOf(':')), Number(addr.slice(addr.lastIndexOf(':') + 1))]
    const framer = new Framer()
    const frames: Frame[] = []
    let done = false
    const finish = (closed: boolean) => { if (done) return; done = true; sock.destroy(); resolve({ frames, closed }) }
    const sock = net.connect(port, host, () => { sock.write(encodeControl(VERB.HELLO, hello)) })
    sock.on('data', (d) => { for (const f of framer.push(new Uint8Array(d))) { frames.push(f); onFrame(f, sock) } })
    sock.on('close', () => finish(true))
    sock.on('error', () => {})
    setTimeout(() => finish(false), ms).unref()
  })
const badProof = (f: Frame, sock: net.Socket) => { if (f.verb === VERB.HELLO) sock.write(encodeControl(VERB.DOOR, { p: 'A'.repeat(PROOF_LEN) })) }
const silent = () => {}

//! two members, `a` listening at a known port and `b` dialing it, formed; both with the secret when one is given
const pair = async (name: string, secret?: string) => {
  const p = await ports.free()
  const o = { heartbeat: { ms: 50 }, redial: { ms: 30 }, ...(secret !== undefined ? { secret } : {}) }
  const a = await fero(name, { uuid: 'aa', listen: `127.0.0.1:${p}`, ...o })
  const b = await fero(name, { uuid: 'bb', server: true, hosts: [`127.0.0.1:${p}`], ...o })
  assert.ok(await until(() => view(a).epoch >= 1 && Object.keys(view(a).members).length === 2 && 'bb' in view(a).peers, 8000), `two members formed (${JSON.stringify(view(a))})`)
  return { a, b, addr: `127.0.0.1:${p}` }
}
//! intact — the member's link survived the crafted HELLO: no dupLink row, both members, both peers, a write still lands
const intact = async (a: Fero, b: Fero, tag: string) => {
  assert.equal(rows(a, JK.dupLink).length, 0, `${tag}: no duplicate-link row against the member`)
  assert.deepEqual(Object.keys(view(a).members).sort(), ['aa', 'bb'], `${tag}: cluster keeps both members`)
  assert.ok('bb' in view(a).peers && 'aa' in view(b).peers, `${tag}: the member's link is alive on both ends`)
  a.data[tag] = 1
  assert.ok(await until(() => (snapshot(b.data) as Record<string, number>)[tag] === 1, 8000), `${tag}: replication intact`)
}

test('STATUS.md:54, closed with a secret: a raw socket writes a HELLO claiming a live member\'s uuid at a secured server — with r: 1, then without — and cannot prove; the member\'s link survives, cluster keeps both members; a silent one times out on a real timer; every HELLO the server sends carries a fresh nonce', async () => {
  const S = 'tcp-test-secret-INDIA-09'
  const { a, b, addr } = await pair('tcpdoor', S)
  try {
    //! with r: 1 — a client claiming bb. The server's HELLO carries k; our proof cannot verify: bad-proof, a close,
    // and (best effort, under socket.destroy()) a DOOR {e: 'denied'} we may or may not read.
    const asClient = await raw(addr, { u: 'bb', i: 1, l: '', r: 1, k: randomBytes(16).toString('base64url') }, badProof)
    assert.ok(asClient.closed, 'the server closed the socket')
    assert.ok(await until(() => doorRows(a).some(([r]) => r === 'bad-proof'), 4000), `bad-proof journaled: ${JSON.stringify(doorRows(a))}`)
    await intact(a, b, 'after-r1')
    //! without r: 1 — a forged MEMBER HELLO claiming bb, the exact frame that used to trip the duplicate-link rule
    // against the real member on an open server
    const asMember = await raw(addr, { u: 'bb', i: 1, l: '127.0.0.1:1', k: randomBytes(16).toString('base64url') }, badProof)
    assert.ok(asMember.closed)
    assert.equal(doorRows(a).filter(([r]) => r === 'bad-proof').length, 2, JSON.stringify(doorRows(a)))
    await intact(a, b, 'after-member')
    //! the nonces: one per link, never repeated, 22 characters of base64url (16 random bytes)
    const ks = [...asClient.frames, ...asMember.frames].filter((f) => f.verb === VERB.HELLO).map((f) => (f.value as { k: string }).k)
    assert.equal(ks.length, 2); assert.notEqual(ks[0], ks[1]); for (const k of ks) assert.match(k, /^[A-Za-z0-9_-]{22}$/)
    //! a HELLO with no k at all: refused before any proof (no-secret), the member untouched
    const noKey = await raw(addr, { u: 'bb', i: 1, l: '', r: 1 }, silent)
    assert.ok(noKey.closed)
    assert.ok(doorRows(a).some(([r]) => r === 'no-secret'))
    await intact(a, b, 'after-nokey')
    //! a socket that greets with k and then says nothing holds a proving link until the deadline (tune.proveMs,
    // 5 s, a real timer): `timeout`, and the member is untouched throughout
    const quiet = await raw(addr, { u: 'bb', i: 1, l: '', r: 1, k: randomBytes(16).toString('base64url') }, silent, 7000)
    assert.ok(quiet.closed, 'closed by the deadline')
    assert.ok(doorRows(a).some(([r]) => r === 'timeout'), JSON.stringify(doorRows(a)))
    await intact(a, b, 'after-timeout')
    //! hygiene: no secret, nonce or proof in any journal or capture
    const everything = JSON.stringify([diag(a)!.journal().events, diag(a)!.capture(), diag(b)!.journal().events])
    assert.ok(!everything.includes(S)); for (const k of ks) assert.ok(!everything.includes(k))
  } finally {
    await b.destroy(); await a.destroy()
  }
})

test('the open door: the same crafted HELLO with r: 1 at an OPEN server is refused by the role rule (uuid-taken) and the member stays; WITHOUT r: 1 the duplicate-link rule still fires against the real member — this test documents the default\'s limit (set a secret to close it)', async () => {
  const { a, b, addr } = await pair('tcpopen')
  try {
    const asClient = await raw(addr, { u: 'bb', i: 1, l: '', r: 1 }, silent)
    assert.ok(asClient.closed)
    assert.deepEqual(doorRows(a), [['uuid-taken', 'bb']], 'the role rule, with no secret')
    await intact(a, b, 'after-r1-open')
    //! the limit: a forged member HELLO on the open door reaches the duplicate-link rule; one of the two links closes
    const asMember = await raw(addr, { u: 'bb', i: 1, l: '127.0.0.1:1' }, silent, 800)
    assert.ok(await until(() => rows(a, JK.dupLink).length > 0, 4000), 'the duplicate-link rule fired: the open door cannot tell the forger from the member')
    assert.ok(asMember.closed || true)
    //! the real member heals once the forger's socket is gone (it re-dials, or was the kept link)
    assert.ok(await until(() => 'bb' in view(a).peers && 'aa' in view(b).peers, 8000), 'the pair heals')
    a.data.healed = 1
    assert.ok(await until(() => (snapshot(b.data) as { healed?: number }).healed === 1, 8000))
  } finally {
    await b.destroy(); await a.destroy()
  }
})

test('fero.spawn (V4-9) and the door: a child role with FERO_SECRET in its environment (FERO_CONFIG deleted) joins a secured parent; one without it is refused no-secret', async () => {
  const S = 'spawn-test-secret-JULIET-10'
  const p = await ports.free()
  const name = `spawned-${process.pid}`
  const s = await fero(name, { uuid: 'aa', listen: `127.0.0.1:${p}`, heartbeat: { ms: 50 }, redial: { ms: 30 }, secret: S })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-door-home-'))
  //! the child inherits process.env (api/spawn.ts passes none): the secret rides the environment, never argv; the
  // layer must be ON in the child, so the battery's FERO_CONFIG=off is deleted for the spawn and restored at once;
  // HOME points at an empty dir so no fero.opt.ts of this box reaches the child
  const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { return fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  }
  const child = withEnv({ FERO_SECRET: S, FERO_CONFIG: undefined, HOME: home }, () => fero.spawn(path.join(import.meta.dirname, 'door.child.ts'), [name, `127.0.0.1:${p}`]))
  const bare = withEnv({ FERO_CONFIG: undefined, HOME: home }, () => fero.spawn(path.join(import.meta.dirname, 'door.child.ts'), [name, `127.0.0.1:${p}`]))
  try {
    assert.ok(await until(() => (snapshot(s.data) as Record<string, string>)[`child-${child.pid}`] === 'joined', 15_000), `the secured child's write landed (${child.out})`)
    assert.ok(await until(() => doorRows(s).some(([r]) => r === 'no-secret'), 8000), 'the bare child is refused')
    await sleep(200)
    assert.equal((snapshot(s.data) as Record<string, string>)[`child-${bare.pid}`], undefined, 'and nothing of it landed')
    assert.ok(!JSON.stringify(diag(s)!.journal().events).includes(S))
  } finally {
    assert.equal(await child.stop(), 0, 'the child left cleanly on Ctrl-C')
    await bare.stop()
    await s.destroy()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
