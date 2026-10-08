//! Tier-3 real-socket smoke: the SAME kernel bytes over real TCP through shell/runtime.
// This tier exists to validate the SHELL (the ~150 lines of adapter), not the
// protocol — the protocol's coverage is the seed sweeps. It is the only tier
// allowed wall-clock waits, and it is deliberately thin (plan §6). The M0
// centerpiece requirement it discharges: one kernel, two environments — a
// thousand simulated trajectories AND a real localhost round-trip.

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../shell/runtime.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { ports, until } from '#utils'

const converged = (a: Runtime, b: Runtime) =>
  a.node.stateHash === b.node.stateHash && a.node.state.size === b.node.state.size

test('two nodes over real TCP: dual-dial dedup, mixed-type replication both ways, clean teardown', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const addrA = `127.0.0.1:${pa}`, addrB = `127.0.0.1:${pb}`
  //! BOTH dial each other — the one-link-per-pair dedup must hold over real sockets too
  const a = new Runtime({ uuid: 'aa', listen: addrA, hosts: [addrB], redialMs: 50 })
  const b = new Runtime({ uuid: 'bb', listen: addrB, hosts: [addrA], redialMs: 50 })
  await a.start()
  await b.start()

  assert.ok(await until(() => a.node.admitted().length === 1 && b.node.admitted().length === 1), 'mesh formed')

  //! the full value zoo crosses real sockets: nested, unicode, NaN, bytes, removes, root inserts
  const recs: Rec[] = [
    { type: REC.update, key: ['user42'], value: { name: 'P', active: true, score: 3.14 } },
    { type: REC.update, key: ['user42', 'active'], value: false },
    { type: REC.update, key: ['uni'], value: 'é中文🎉' },
    { type: REC.update, key: ['nan'], value: NaN },
    { type: REC.update, key: ['bytes'], value: new Uint8Array([1, 2, 3]) },
    { type: REC.insert, key: [], at: 'rooted', value: [1, 'two', { three: 3 }] },
    { type: REC.update, key: ['gone'], value: 'temp' },
    { type: REC.remove, key: ['gone'] },
  ]
  a.write(recs)
  b.write([{ type: REC.update, key: ['from-b'], value: 'both directions' }])

  assert.ok(await until(() => converged(a, b)), 'replicated both ways over real TCP')
  assert.deepEqual(b.node.state.get(JSON.stringify(['user42'])), { name: 'P', active: true, score: 3.14 })
  assert.equal(b.node.state.has(JSON.stringify(['gone'])), false)
  assert.equal(a.node.state.get(JSON.stringify(['from-b'])), 'both directions')

  await a.destroy()
  await b.destroy()
})

test('a 5k-record burst coalesces and survives socket backpressure', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], redialMs: 50 })
  const b = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [], redialMs: 50 })
  await a.start()
  await b.start()
  assert.ok(await until(() => a.node.admitted().length === 1))

  //! one write() call = one synchronous batch = ONE frame on the wire (the counted coalescing invariant, at real-socket scale)
  const burst: Rec[] = Array.from({ length: 5000 }, (_, i) => ({
    type: REC.update, key: [`k${i % 512}`, 'v'], value: { i, pad: 'x'.repeat(64) },
  }))
  a.write(burst)
  assert.ok(await until(() => converged(a, b), 10_000), 'burst fully replicated')
  await a.destroy()
  await b.destroy()
})

test('three nodes, full dial mesh: exactly one link per pair; writes from every node converge everywhere', async () => {
  const ps = [await ports.free(), await ports.free(), await ports.free()]
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const rts = ['aa', 'bb', 'cc'].map((uuid, i) =>
    new Runtime({ uuid, listen: addrs[i], hosts: addrs.filter((_, j) => j !== i), redialMs: 50 }),
  )
  for (const r of rts) await r.start()

  assert.ok(await until(() => rts.every((r) => r.node.admitted().length === 2)), '3-node mesh formed')
  //! dedup settled: each node holds exactly 2 live links (the dial race's losers are closed and reaped)
  assert.ok(await until(() => rts.every((r) => r.node.links.size === 2)), 'one logical link per pair')

  rts.forEach((r, i) => r.write([{ type: REC.update, key: [`from-${i}`], value: i }]))
  assert.ok(
    await until(() => rts.every((r) => r.node.stateHash === rts[0].node.stateHash && r.node.state.size === 3)),
    'all three converged',
  )
  for (const r of rts) await r.destroy()
})

test('port 0 (V4-3): the shell publishes the OS-chosen address to the kernel before start — a peer dials it, admits, and gossips the REAL listen', async () => {
  const a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', redialMs: 50 })
  await a.start()
  assert.match(a.node.listen, /^127\.0\.0\.1:[1-9]\d*$/, 'the kernel holds the real address, never :0')
  const b = new Runtime({ uuid: 'bb', listen: '127.0.0.1:0', hosts: [a.node.listen], redialMs: 50 })
  await b.start()
  assert.ok(await until(() => a.node.admitted().length === 1 && b.node.admitted().length === 1), 'admitted over the ephemeral ports')
  const link = [...a.node.links.values()].find((l) => l.uuid === 'bb')!
  assert.equal(link.listen, b.node.listen, 'HELLO carried the resolved address, not the configured :0')
  await a.destroy()
  await b.destroy()
})

test('destroy() stops accepting before its WAL flush: a dial that lands mid-stop is refused, and the stop settles (I-21)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-stop-'))
  let sock: net.Socket | undefined
  try {
    const a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir, redialMs: 50 })
    await a.start()
    const [host, port] = a.node.listen.split(':')
    //! a fat append keeps the WAL queue busy: the window in which the old destroy() left the listener open,
    // so a peer's redial was accepted after the socket loop and server.close() waited on it forever
    a.write(Array.from({ length: 4096 }, (_, i) => ({ type: REC.update, key: [`k${i}`], value: 'x'.repeat(4096) })))
    const stopping = a.destroy()
    sock = net.connect(Number(port), host)
    const dial = await new Promise<string>((resolve) => {
      sock.once('connect', () => resolve('connected'))
      sock.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
    })
    const stop = await Promise.race([stopping.then(() => 'stopped'), new Promise<string>((r) => setTimeout(r, 5000, 'hung').unref())])
    assert.equal(stop, 'stopped', `destroy() must settle although a dial (${dial}) landed during its WAL flush`)
    if (dial === 'connected') assert.ok(await until(() => sock!.destroyed, 2000), 'a socket accepted mid-stop is torn down by the stopping runtime')
  } finally {
    //! the client end goes in every case — with the bug, this is what lets the hung close() finish and the run end
    sock?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

//! settle a promise or name it 'hung' after ms — the bounded race both start() tests below need
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => 'resolved', (e: NodeJS.ErrnoException) => `rejected ${e?.code ?? e?.message}`), new Promise<string>((r) => setTimeout(r, ms, 'hung').unref())])

test('a stop before the listen socket is up settles start() with a typed reject (code stopped) and frees the port', async () => {
  const port = await ports.free()
  const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${port}` })
  const starting = a.start()
  await a.destroy()
  //! the bug: destroy()'s server.close() runs before 'listening', Node never fires it, and start() hung for ever
  assert.equal(await settled(starting, 2000), 'rejected stopped', 'start() settles when the runtime stops before it listened')
  assert.equal(await settled(starting, 0), 'rejected stopped')
  const refused = await new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(true))
  })
  assert.ok(refused, 'the port is not held by the stopped runtime')
})

test('start() after destroy() neither binds nor hangs', async () => {
  const port = await ports.free()
  const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${port}` })
  await a.destroy()
  const starting = a.start()
  assert.equal(await settled(starting, 2000), 'rejected stopped', 'a start() on a stopped runtime is refused, typed')
  const refused = await new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(true))
  })
  //! the bug: the late start() bound a server that nothing would ever close
  assert.ok(refused, 'nothing listens on the port after a start() on a destroyed runtime')
})
