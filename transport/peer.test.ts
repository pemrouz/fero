// peer.ts is the day-0 spike made binary: one peer round-trips change records
// over a REAL loopback TCP socket, through message.ts framing + outbox batching.
// TCP can split/merge writes arbitrarily — the Framer's straddle handling is
// what makes this safe, exercised here end-to-end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { Peer, STATUS } from './peer.ts'
import { until, apply, sleep } from '#utils'

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
          for (const record of f.records()) apply(res, record)
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

test('a frame larger than one TCP segment reassembles over a real socket', async () => {
  // The Framer's straddle handling is unit-tested by splitting a buffer at every byte
  // boundary; this proves it END-TO-END over real TCP, where the kernel splits a large
  // write into multiple 'data' chunks on its own. A ~300 KB value far exceeds a loopback
  // segment, so reassembly is genuinely exercised (not a single-chunk happy path).
  const srv = await serve()
  const client = new Peer({ host: '127.0.0.1', port: srv.port })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))

  const big = 'x'.repeat(300_000)
  client.send({ type: 'update', key: ['blob'], value: { data: big, n: 42 } })

  assert.ok(
    await until(() => (srv.replica[value]?.blob?.data?.length ?? 0) === big.length, 5000),
    `blob length ${srv.replica[value]?.blob?.data?.length ?? 0} (expected ${big.length})`,
  )
  assert.equal(srv.replica[value].blob.n, 42, 'the rest of the record decoded too')
  assert.equal(srv.frames(), 1, 'one frame, however many TCP chunks it arrived in')

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

test('failure detector: a peer that stops answering is flagged suspect (socket still open)', async () => {
  // A server that ACCEPTS but never answers — no 'data' listener, so the socket
  // stays paused and our PINGs go unanswered: a hung / silently-partitioned peer
  // that TCP `close` would never reveal.
  const sockets: net.Socket[] = []
  const deaf = net.createServer((s) => sockets.push(s))
  await new Promise<void>((r) => deaf.listen(0, '127.0.0.1', () => r()))
  const port = (deaf.address() as net.AddressInfo).port

  const client = new Peer({ host: '127.0.0.1', port, retries: { max: 0 }, heartbeat: { interval: 25, misses: 3 } })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected), 'connects')
  assert.equal(client.suspect, false, 'not suspect on a fresh connection')

  // ~misses × interval later, with no PONGs, the detector flips suspect — but the
  // socket is still open, so status stays connected (suspect is orthogonal).
  assert.ok(await until(() => client.suspect === true, 2000), 'flips suspect when probes go unanswered')
  assert.equal(client.status, STATUS.connected, 'still socket-connected — only suspect, not disconnected')

  client.destroy()
  sockets.forEach((s) => s.destroy())
  await new Promise<void>((r) => deaf.close(() => r()))
})

test('failure detector: a peer that keeps answering is never flagged suspect', async () => {
  const srv = await serve() // serve()'s inbound Peer answers PINGs with PONGs
  const client = new Peer({ host: '127.0.0.1', port: srv.port, retries: { max: 0 }, heartbeat: { interval: 25, misses: 3 } })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))

  await sleep(300) // run well past misses × interval (3 × 25ms); PONGs keep arriving
  assert.equal(client.suspect, false, 'a responsive peer is never flagged suspect')

  client.destroy()
  await srv.close()
})

test('failure detector: a WATCHDOG (non-originating) peer flags suspect on inbound starvation, without probing', async () => {
  // Heartbeat-only dedup: the higher-uuid side WATCHDOGS — it sends no PING but must still detect a
  // silently-dead peer via inbound-frame starvation. Model it with a server that sends NOTHING: the
  // watchdog originates zero bytes yet flips suspect after misses × interval (its originator is "dead").
  let bytes = 0
  const sockets: net.Socket[] = []
  const deaf = net.createServer((s) => { sockets.push(s); s.on('data', (c) => { bytes += c.length }) })
  await new Promise<void>((r) => deaf.listen(0, '127.0.0.1', () => r()))
  const port = (deaf.address() as net.AddressInfo).port

  const client = new Peer({ host: '127.0.0.1', port, retries: { max: 0 }, heartbeat: { interval: 25, misses: 3 } })
  client.setOriginate(false) // watchdog: never PING
  client.connect()
  try {
    assert.ok(await until(() => client.status === STATUS.connected), 'connects')
    assert.ok(await until(() => client.suspect === true, 2000), 'a watchdog flips suspect when no inbound frames arrive (originator presumed dead)')
    assert.equal(bytes, 0, 'a watchdog originates ZERO probe traffic (the halving)')
  } finally {
    client.destroy()
    sockets.forEach((s) => s.destroy())
    await new Promise<void>((r) => deaf.close(() => r()))
  }
})

test('failure detector: a watchdog stays healthy while its originator keeps probing', async () => {
  // The healthy steady state after the election: the originator probes every interval; the watchdog
  // (which tolerates misses × interval) gets proof-of-life each interval and never flips suspect. Both
  // ends MUST share the interval (they do in production) — so the server here probes at the same 25ms.
  const inbound: Peer[] = []
  const srv = net.createServer((s) =>
    inbound.push(new Peer({ host: s.remoteAddress ?? '127.0.0.1', port: s.remotePort ?? 0, socket: s, heartbeat: { interval: 25, misses: 3 }, onFrame: () => {} })),
  )
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port

  const client = new Peer({ host: '127.0.0.1', port, retries: { max: 0 }, heartbeat: { interval: 25, misses: 3 } })
  client.setOriginate(false) // watchdog
  client.connect()
  try {
    assert.ok(await until(() => client.status === STATUS.connected))
    await sleep(300) // 12× the interval; the originator's PINGs (every 25ms) keep resetting the watchdog
    assert.equal(client.suspect, false, 'a watchdog with a live originator at the same interval is never flagged suspect')
  } finally {
    client.destroy()
    inbound.forEach((p) => p.destroy())
    await new Promise<void>((r) => srv.close(() => r()))
  }
})

test('subscription deltas coalesce: one id-tagged frame per sub per tick, order + routing preserved', async () => {
  // Regression for the deltaTo bypass: each delta used to be an immediate encode + socket.write
  // INSIDE the writer's sink chain (M subs ⇒ M syscalls per assignment). sendDelta queues into
  // a per-sub lane flushed once per microtask — same coalescing the replication path always had.
  const got: Array<{ id: number | undefined; keys: string[] }> = []
  const inbound: Peer[] = []
  const server = net.createServer((socket) => {
    inbound.push(new Peer({
      host: socket.remoteAddress ?? '127.0.0.1',
      port: socket.remotePort ?? 0,
      socket,
      onFrame: (f) => got.push({ id: f.id, keys: f.records().map((r) => r.key[0] as string) }),
    }))
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  const client = new Peer({ host: '127.0.0.1', port })
  client.connect()
  assert.ok(await until(() => client.status === STATUS.connected))

  // six same-tick deltas across TWO subs + one plain replication record
  client.sendDelta(7, { type: 'update', key: ['a1'], value: 1 })
  client.sendDelta(9, { type: 'update', key: ['b1'], value: 1 })
  client.sendDelta(7, { type: 'update', key: ['a2'], value: 2 })
  client.sendDelta(9, { type: 'update', key: ['b2'], value: 2 })
  client.sendDelta(7, { type: 'update', key: ['a3'], value: 3 })
  client.send({ type: 'update', key: ['r1'], value: 0 })

  assert.ok(await until(() => got.length === 3, 4000), `3 frames (got ${got.length})`)
  const sub7 = got.find((g) => g.id === 7)!
  const sub9 = got.find((g) => g.id === 9)!
  const repl = got.find((g) => g.id === undefined)!
  assert.deepEqual(sub7.keys, ['a1', 'a2', 'a3'], 'sub 7: one frame, in order')
  assert.deepEqual(sub9.keys, ['b1', 'b2'], 'sub 9: one frame, in order')
  assert.deepEqual(repl.keys, ['r1'], 'replication lane untouched')

  client.destroy()
  inbound.forEach((p) => p.destroy())
  await new Promise<void>((d) => server.close(() => d()))
})
