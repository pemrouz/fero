// peer.ts is the day-0 spike made binary: one peer round-trips change records
// over a REAL loopback TCP socket, through message.ts framing + outbox batching.
// TCP can split/merge writes arbitrarily — the Framer's straddle handling is
// what makes this safe, exercised here end-to-end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { Peer, STATUS } from './peer.ts'
import type { Frame, ChangeRecord } from './message.ts'

// apply a decoded frame's records to a $() replica via the day-0 res contract
function applyFrame(res: any, frame: Frame) {
  for (const record of frame.records()) {
    if (record.type === 'update') res.update(record.value, record.key)
    else if (record.type === 'insert') res.insert(record.value, record.key, record.at)
    else if (record.type === 'remove') res.remove(record.key)
  }
}

const until = async (check: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 5))
  }
  return true
}

// Start a server that wraps each accepted socket in an inbound Peer; returns the
// replica proxy it applies frames into, plus a frame counter and teardown.
function serve(): Promise<{ port: number; replica: any; frames: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const replica = $({})
    const res = (replica as any)[view].res
    let frames = 0
    const inbound: Peer[] = []
    const server = net.createServer((socket) => {
      const peer = new Peer({
        host: socket.remoteAddress ?? '127.0.0.1',
        port: socket.remotePort ?? 0,
        socket,
        onFrame: (f) => {
          frames++
          applyFrame(res, f)
        },
      })
      inbound.push(peer)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        replica,
        frames: () => frames,
        close: () =>
          new Promise<void>((done) => {
            inbound.forEach((p) => p.destroy())
            server.close(() => done())
          }),
      })
    })
  })
}

test('records round-trip over real TCP, replica converges', async () => {
  const srv = await serve()
  const client = new Peer({ host: '127.0.0.1', port: srv.port })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected), 'client should connect')

  client.send({ type: 'update', key: ['user42'], value: { name: 'P', active: true } })
  client.send({ type: 'update', key: ['user42', 'active'], value: false })
  client.send({ type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' })
  client.send({ type: 'remove', key: ['user99'], value: undefined })

  const expected = { user42: { name: 'P', active: false } }
  assert.ok(await until(() => JSON.stringify(srv.replica[value]) === JSON.stringify(expected)), JSON.stringify(srv.replica[value]))

  client.destroy()
  await srv.close()
})

test('multiple sends in one tick coalesce into a single frame', async () => {
  const srv = await serve()
  const client = new Peer({ host: '127.0.0.1', port: srv.port })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))

  // five synchronous sends → one microtask flush → one frame
  for (let i = 0; i < 5; i++) client.send({ type: 'update', key: ['k' + i], value: i })

  const expected = { k0: 0, k1: 1, k2: 2, k3: 3, k4: 4 }
  assert.ok(await until(() => JSON.stringify(srv.replica[value]) === JSON.stringify(expected)), JSON.stringify(srv.replica[value]))
  assert.equal(srv.frames(), 1, 'one coalesced frame for five same-tick sends')

  client.destroy()
  await srv.close()
})

test('status: connecting → connected → disconnected on close', async () => {
  const srv = await serve()
  const seen: number[] = []
  const client = new Peer({
    host: '127.0.0.1',
    port: srv.port,
    retries: { max: 0 }, // don't redial — we want to observe the disconnect settle
    onStatus: (p) => seen.push(p.status),
  })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))
  await srv.close() // server gone → client socket closes

  assert.ok(await until(() => client.status === STATUS.disconnected), 'should settle disconnected')
  assert.deepEqual(seen.slice(0, 2), [STATUS.connecting, STATUS.connected])
  assert.equal(seen.at(-1), STATUS.disconnected)
  client.destroy()
})

test('dialed peer schedules a reconnect (→ throttled) after a drop', async () => {
  const srv = await serve()
  const client = new Peer({
    host: '127.0.0.1',
    port: srv.port,
    retries: { base: 50, jitter: 0 }, // small, deterministic backoff
  })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))
  await srv.close()
  // after the socket closes, a dialed peer backs off → throttled
  assert.ok(await until(() => client.status === STATUS.throttled), `status=${client.status}`)
  client.destroy()
})
