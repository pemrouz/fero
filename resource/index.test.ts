// L2 end-to-end: fero(name, opts) as the whole public API. A single node proves
// the three surfaces compose (data writes, default + custom methods, cluster);
// a 2-node cluster proves assignment-writes and custom-method writes replicate
// and that cluster.peers reflects membership. v1 is server / full-replication.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { value } from '../../data/index.ts'
import { fero, fileStorage } from './index.ts'
import { STATUS } from '../transport/peer.ts'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 5))
  }
  return true
}

const connected = (c: any, addr: string) => (c.peers[addr]?.status?.[value] ?? -1) === STATUS.connected

test('single node: data writes, default methods, and read() compose', async () => {
  const r = await fero('solo', { port: await freePort(), wait: 50 })

  // assignment write → readable on the same proxy
  r.data.user42 = { name: 'P', active: true }
  assert.deepEqual(r.data.user42[value], { name: 'P', active: true })

  // default methods mutate data
  r.methods.update({ key: ['user42', 'active'], value: false })
  assert.equal(r.data.user42.active[value], false)
  r.methods.insert({ value: { name: 'Q' }, at: 'user99' })
  assert.equal(r.data.user99.name[value], 'Q')
  r.methods.remove({ key: ['user99'] })
  assert.equal(r.data.user99[value], undefined)

  // read() returns the live view proxy (a subscription handle, not a copy)
  const live = r.methods.read()
  assert.equal(live, r.data)
  assert.deepEqual(live[value], { user42: { name: 'P', active: false } })

  r.destroy()
})

test('custom methods are recognized by value type; config keys are not methods', async () => {
  const calls: any[] = []
  const r = await fero('rec', {
    port: await freePort(),
    wait: 50,
    region: 'eu-west', // config (non-function) — must NOT become a method
    login: (arg: any, context: any) => {
      calls.push(arg)
      context.data[arg.id] = { online: true }
      return { ok: true, id: arg.id }
    },
  })

  assert.equal(typeof r.methods.login, 'function')
  assert.equal((r.methods as any).region, undefined) // config didn't leak in as a method
  assert.ok(r.methods.update && r.methods.read) // defaults still present alongside custom

  const reply = r.methods.login({ id: 'u1' })
  assert.deepEqual(reply, { ok: true, id: 'u1' })
  assert.deepEqual(calls, [{ id: 'u1' }])
  assert.deepEqual(r.data.u1[value], { online: true }) // handler's context.data write landed

  r.destroy()
})

test('2-node: assignment write on A replicates to B; cluster.peers reflects membership', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('shared', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('shared', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })

  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // plain assignment on A's data surface
  A.data.user42 = { name: 'P' }
  A.data.user99 = { name: 'Q' }

  const expected = { user42: { name: 'P' }, user99: { name: 'Q' } }
  assert.ok(
    await until(() => JSON.stringify(B.data[value]) === JSON.stringify(expected)),
    `B.data = ${JSON.stringify(B.data[value])}`,
  )
  assert.deepEqual(A.data[value], expected) // A converges too (full replication)

  // cluster.me is each server's own listen address; peers ViewProxy is queryable
  assert.equal(A.cluster.me, a1)
  assert.equal(B.cluster.me, a2)

  A.destroy()
  B.destroy()
})

test('2-node: a custom method that writes context.data replicates to the peer', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('m', {
    host: '127.0.0.1',
    port: p1,
    ports: [p1, p2],
    wait: 200,
    setScore: (arg: any, context: any) => {
      context.data[arg.id] = { score: arg.score }
      return context.data[arg.id]
    },
  })
  const B = await fero('m', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)))

  A.methods.setScore({ id: 'p1', score: 10 })
  A.methods.setScore({ id: 'p2', score: 20 })

  const expected = { p1: { score: 10 }, p2: { score: 20 } }
  assert.ok(
    await until(() => JSON.stringify(B.data[value]) === JSON.stringify(expected)),
    `B.data = ${JSON.stringify(B.data[value])}`,
  )

  A.destroy()
  B.destroy()
})

test('2-node: many writes converge to exactly the written keys (no echo storm)', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('noecho', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('noecho', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)))

  for (let i = 0; i < 10; i++) A.data['k' + i] = i
  assert.ok(await until(() => Object.keys(B.data[value]).length === 10))
  await new Promise((r) => setTimeout(r, 50)) // give any echo a chance to land

  // both sides hold exactly the 10 written keys — an echo storm or dual-connection
  // double-send would surface as divergence or extra activity; convergence holds.
  // (No-echo is proven at the record level in log/index.test.ts; the same guard
  // relocates to the proxy here.)
  assert.deepEqual(A.data[value], B.data[value])
  assert.equal(Object.keys(A.data[value]).length, 10)

  A.destroy()
  B.destroy()
})

test('2-node: concurrent same-key writes converge (last-writer-wins, deterministic)', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('lww', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('lww', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // Both write the SAME key before either has seen the other's write — a genuine
  // concurrent conflict (each is that node's first write → seq 1 on both, broken
  // by origin uuid). Whichever wins, BOTH must converge to it (no permanent split).
  A.data.k = 'from-A'
  B.data.k = 'from-B'

  assert.ok(
    await until(() => A.data.k[value] !== undefined && B.data.k[value] !== undefined && A.data.k[value] === B.data.k[value]),
    `A.k=${A.data.k[value]} B.k=${B.data.k[value]}`,
  )
  const winner = A.data.k[value]
  assert.ok(winner === 'from-A' || winner === 'from-B', `winner ${winner} is one of the two writes`)

  A.destroy()
  B.destroy()
})

test('2-node: a peer that joins AFTER writes catches up (anti-entropy)', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('cu', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 150 })

  // A writes while it is ALONE — these records are broadcast to nobody; without
  // catch-up a later joiner would never see them.
  A.data.a = 1
  A.data.b = 2
  A.data.c = 3

  // B joins now and must converge to A's pre-existing state via the digest exchange.
  const B = await fero('cu', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 150 })
  assert.ok(await until(() => connected(A.cluster, a2)), 'A↔B connect')

  const expected = { a: 1, b: 2, c: 3 }
  assert.ok(
    await until(() => JSON.stringify(B.data[value]) === JSON.stringify(expected)),
    `B caught up to ${JSON.stringify(B.data[value])}`,
  )

  // and live replication still works after catch-up
  A.data.d = 4
  assert.ok(await until(() => B.data.d[value] === 4), 'live write after catch-up')

  A.destroy()
  B.destroy()
})

test('3-node: a late joiner catches up to BOTH peers’ writes via one connection', async () => {
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('cu3', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 150 })
  const B = await fero('cu3', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 150 })
  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // A and B each write; full replication means both logs hold both writes.
  A.data.fromA = 1
  B.data.fromB = 2
  const expected = { fromA: 1, fromB: 2 }
  assert.ok(await until(() => JSON.stringify(A.data[value]) === JSON.stringify(expected)), 'A,B converge first')

  // C joins knowing ONLY A (ports:[p1]); it must end up with B's write too —
  // A's log carries B's records (it received them), so one catch-up suffices.
  const C = await fero('cu3', { host: '127.0.0.1', port: p3, ports: [p1], wait: 150 })
  assert.ok(
    await until(() => JSON.stringify(C.data[value]) === JSON.stringify(expected)),
    `C caught up to ${JSON.stringify(C.data[value])}`,
  )

  A.destroy()
  B.destroy()
  C.destroy()
})

test('persistence: state survives a restart via the storage seam (WAL)', async () => {
  const path = join(os.tmpdir(), `fero-wal-${randomUUID()}.log`)
  try {
    // first instance: write some state, then tear down
    const A1 = await fero('persist', { port: await freePort(), wait: 30, storage: fileStorage(path) })
    A1.data.user42 = { name: 'P', active: true }
    A1.methods.update({ key: ['user42', 'active'], value: false })
    A1.data.user99 = { name: 'Q' }
    A1.methods.remove({ key: ['user99'] })
    assert.deepEqual(A1.data[value], { user42: { name: 'P', active: false } })
    A1.destroy()

    // a fresh instance over the same WAL restores the materialized state
    const A2 = await fero('persist', { port: await freePort(), wait: 30, storage: fileStorage(path) })
    assert.deepEqual(A2.data[value], { user42: { name: 'P', active: false } })

    // and writes continue cleanly on top of the restored log
    A2.data.user1 = { name: 'R' }
    assert.deepEqual(A2.data[value], { user42: { name: 'P', active: false }, user1: { name: 'R' } })
    A2.destroy()
  } finally {
    rmSync(path, { force: true })
  }
})

test('client RPC: a read-only client dispatches method calls to its server', async () => {
  const p1 = await freePort()
  const seenPeers: string[] = []
  const A = await fero('rpc', {
    host: '127.0.0.1',
    port: p1,
    wait: 50,
    greet: (arg: any, context: any) => {
      seenPeers.push(context.peer) // the caller — set for remote calls
      return { hello: arg.name, from: context.cluster.me }
    },
  })
  A.data.score = 42 // server-side state

  // a read-only client: no port → all method calls are RPC'd to the server
  const C = await fero('rpc', { host: '127.0.0.1', ports: [p1], wait: 200 })
  assert.equal(C.cluster.me, undefined) // it's a client

  // custom method runs on the server, value comes back over the wire
  const reply = await C.methods.greet({ name: 'world' })
  assert.deepEqual(reply, { hello: 'world', from: `127.0.0.1:${p1}` })
  assert.equal(seenPeers.length, 1) // handler ran once, on the server
  assert.ok(typeof seenPeers[0] === 'string') // context.peer was the caller's address

  // default read() returns the server's data as a snapshot (await → value)
  const snap = await C.methods.read()
  assert.deepEqual(snap, { score: 42 })

  C.destroy()
  A.destroy()
})

test('client RPC: a client write routes to the server and replicates', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('rpcw', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('rpcw', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)), 'A↔B connect')

  const C = await fero('rpcw', { host: '127.0.0.1', ports: [p1], wait: 200 })
  // client write via the default update method → runs on A → replicates to B
  await C.methods.update({ key: ['k'], value: 99 })

  assert.ok(await until(() => A.data.k[value] === 99), 'write landed on the server A')
  assert.ok(await until(() => B.data.k[value] === 99), 'and replicated to B')

  C.destroy()
  A.destroy()
  B.destroy()
})

test('client RPC: an unknown method rejects', async () => {
  const p1 = await freePort()
  const A = await fero('rpcerr', { host: '127.0.0.1', port: p1, wait: 50 })
  const C = await fero('rpcerr', { host: '127.0.0.1', ports: [p1], wait: 200 })

  await assert.rejects(() => C.methods.nope({}), /unknown method/)

  C.destroy()
  A.destroy()
})

test('2-node: a write that causally follows a remote write wins (Lamport order)', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('lamport', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('lamport', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // A writes first; B waits to SEE it, then overwrites. B's write causally
  // follows A's, so B's Lamport seq is higher → B wins on BOTH nodes, regardless
  // of which uuid sorts higher. (Without the Lamport merge, B's per-node counter
  // could be ≤ A's and B would lose to its own predecessor → permanent divergence.)
  A.data.k = 'first'
  assert.ok(await until(() => B.data.k[value] === 'first'), 'B sees A’s write')
  B.data.k = 'second'

  assert.ok(
    await until(() => A.data.k[value] === 'second' && B.data.k[value] === 'second'),
    `A.k=${A.data.k[value]} B.k=${B.data.k[value]}`,
  )

  A.destroy()
  B.destroy()
})
