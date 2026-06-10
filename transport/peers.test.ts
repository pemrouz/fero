import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { Peers } from './peers.ts'
import { STATUS, Peer } from './peer.ts'
import { until, sleep, apply } from '#utils'

// a server that applies inbound frames into a replica via the pool's accept()
function serve() {
  const replica = $({})
  const res = (replica as any)[view].res
  const pool = new Peers({ onFrame: (f) => { for (const record of f.records()) apply(res, record) } })
  const server = net.createServer((socket) =>
    pool.accept(socket, { host: socket.remoteAddress ?? '127.0.0.1', port: socket.remotePort ?? 0 }),
  )
  return new Promise<{ port: number; replica: any; pool: Peers; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        replica,
        pool,
        close: () => new Promise<void>((d) => { pool.destroy(); server.close(() => d()) }),
      }),
    )
  })
}

test('add() inserts one row, dedups re-adds, rejects self', () => {
  const pool = new Peers({ me: '127.0.0.1:9999', retries: { max: 0 } })
  const changes = pool.peers.connect([]) // capture change records on cluster.peers

  const a = pool.add({ host: '127.0.0.1', port: 1 })
  const again = pool.add({ host: '127.0.0.1', port: 1 }) // dedup
  const self = pool.add({ host: '127.0.0.1', port: 9999 }) // self → rejected

  assert.equal(again, a, 're-add returns the same peer')
  assert.equal(self, undefined, 'self add rejected')
  // one membership insert for 127.0.0.1:1 (initial snapshot + the insert)
  const inserts = changes.filter((c: any) => c.type === 'insert')
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].at, '127.0.0.1:1')
  assert.deepEqual(Object.keys(pool.peers[value]), ['127.0.0.1:1'])
  pool.destroy()
})

test('peer status mirrors into the proxy and the connected projection', async () => {
  const srv = await serve()
  const client = new Peers({ retries: { max: 0 } })
  client.add({ host: '127.0.0.1', port: srv.port })

  // connected projection picks up the peer once its socket is up
  assert.ok(
    await until(() => Object.keys(client.connected[value] ?? {}).length === 1),
    JSON.stringify(client.connected[value]),
  )
  assert.equal(client.peers[`127.0.0.1:${srv.port}`].status[value], STATUS.connected)

  client.destroy()
  await srv.close()
})

test('isolate severs a dialed link and blocks redial (gossip-revival too); heal restores it', async () => {
  const srv = await serve()
  const addr = `127.0.0.1:${srv.port}`
  // fast, deterministic backoff so any auto-redial would happen well within the sleep window below.
  const client = new Peers({ retries: { base: 20, jitter: 0 } })
  client.add({ host: '127.0.0.1', port: srv.port })
  assert.ok(await until(() => client.peers[addr]?.status?.[value] === STATUS.connected), 'connected first')

  // isolate severs the dial and removes it from the conn map (so heal can dial a fresh Peer —
  // a destroyed one is terminal). The row goes disconnected, which is what #reachable keys off.
  client.isolate(addr)
  assert.ok(await until(() => client.peers[addr]?.status?.[value] === STATUS.disconnected), 'isolate severs')
  assert.equal(client.peer(addr), undefined, 'isolated peer left the conn map')

  // a re-add while blocked is a no-op — this is the gossip-revival path (a third node announces the
  // peer via handshake learn → addServer → add); the block keeps a partitioned link DOWN.
  assert.equal(client.add({ host: '127.0.0.1', port: srv.port }), undefined, 're-add blocked while isolated')
  await sleep(80) // > the 20ms backoff: confirm it stays severed (no auto-redial, no gossip revival)
  assert.equal(client.peers[addr]?.status?.[value], STATUS.disconnected, 'link stays down while isolated')
  assert.equal(client.peer(addr), undefined, 'still no conn while isolated')

  // heal: unblock + re-dial by listen address → reconnect (the rejoin-without-restart path).
  client.heal(addr)
  assert.ok(await until(() => client.peers[addr]?.status?.[value] === STATUS.connected), 'heal reconnects')
  assert.ok(client.peer(addr), 'a fresh peer is back in the conn map')

  client.destroy()
  await srv.close()
})

test('broadcast fans out to connected peers; replica converges', async () => {
  const srv = await serve()
  const client = new Peers({ retries: { max: 0 } })
  client.add({ host: '127.0.0.1', port: srv.port })
  assert.ok(await until(() => Object.keys(client.connected[value] ?? {}).length === 1))

  client.broadcast({ type: 'update', key: ['user42'], value: { name: 'P' } })
  client.broadcast({ type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' })

  const expected = { user42: { name: 'P' }, user99: { name: 'Q' } }
  assert.ok(await until(() => JSON.stringify(srv.replica[value]) === JSON.stringify(expected)), JSON.stringify(srv.replica[value]))

  client.destroy()
  await srv.close()
})

test('heartbeat election: identify() makes the lower-uuid side originate and the higher-uuid side watchdog', () => {
  // Both ends compute the SAME min over the same two uuids, so exactly one side per socket probes.
  const lo = new Peers({ uuid: 'aaa' })
  const hi = new Peers({ uuid: 'bbb' })
  const p1 = new Peer({ host: '127.0.0.1', port: 2, role: 'server' }) // lo's dialed peer to hi
  const p2 = new Peer({ host: '127.0.0.1', port: 1, role: 'server' }) // hi's dialed peer to lo
  lo.identify(p1, { uuid: 'bbb', role: 'server', listen: '127.0.0.1:2' })
  hi.identify(p2, { uuid: 'aaa', role: 'server', listen: '127.0.0.1:1' })
  assert.equal(p1.originate, true, 'lower-uuid node (aaa) originates probes')
  assert.equal(p2.originate, false, 'higher-uuid node (bbb) watchdogs — does not originate')
  // a pool with no uuid (raw Peers in the unit harness) keeps the default — both ends probe
  const anon = new Peers()
  const p3 = new Peer({ host: '127.0.0.1', port: 3, role: 'server' })
  anon.identify(p3, { uuid: 'zzz', role: 'server', listen: '127.0.0.1:3' })
  assert.equal(p3.originate, true, 'no self-uuid ⇒ no election ⇒ default originate (unchanged)')
  lo.destroy()
  hi.destroy()
  anon.destroy()
})

test('a destroy()ed dialed peer is pruned — no corpse blocking redial, no leaked row', async () => {
  // Regression: destroy() (framing fault / FrameError / mesh.drop / self-reject) never fired
  // onGone, and the socket 'close' that follows early-returns on the destroyed latch — so the
  // dead Peer stayed in #conns forever: add() deduped against the corpse (permanently blocking
  // any redial), peer() resolved to it (occluding a live shadow), its row leaked disconnected.
  const srv = await serve()
  const pool = new Peers({ retries: { max: 0 } })
  const addr = `127.0.0.1:${srv.port}`
  const p1 = pool.add({ host: '127.0.0.1', port: srv.port })!
  assert.ok(await until(() => p1.status === STATUS.connected))

  p1.destroy() // the framing-fault / drop() path — NOT a natural close
  assert.ok(await until(() => pool.peers[value]?.[addr] === undefined), 'the row is pruned, not leaked')
  assert.equal(pool.peer(addr), undefined, 'the corpse left #conns')

  const p2 = pool.add({ host: '127.0.0.1', port: srv.port })!
  assert.notEqual(p2, p1, 'a re-add dials a FRESH peer (the corpse no longer dedups it)')
  assert.ok(await until(() => p2.status === STATUS.connected), 'and it connects')

  pool.destroy()
  await srv.close()
})

test('an isolated link KEEPS its row through the destroy — heal() can still re-dial it', async () => {
  // isolate() destroys the dialed peer (which now prunes) but the chaos seam's contract is
  // reversibility: the disconnected row must survive so heal() can read host/port off it.
  const srv = await serve()
  const pool = new Peers({ retries: { max: 0 } })
  const addr = `127.0.0.1:${srv.port}`
  const p1 = pool.add({ host: '127.0.0.1', port: srv.port })!
  assert.ok(await until(() => p1.status === STATUS.connected))

  pool.isolate(addr)
  await sleep(20)
  assert.ok(pool.peers[value]?.[addr], 'the isolated row survives (disconnected)')
  assert.equal(pool.peers[addr].status[value], STATUS.disconnected)

  pool.heal(addr)
  assert.ok(await until(() => pool.peers[addr]?.status?.[value] === STATUS.connected, 4000), 'heal re-dialed off the surviving row')

  pool.destroy()
  await srv.close()
})

test('an unidentified inbound peer destroyed mid-handshake leaves no #conns corpse', async () => {
  // An accepted socket destroyed before identify() (e.g. a hostile INIT → FrameError) owned no
  // row, but its #conns entry (keyed by the undialable ephemeral address) leaked forever.
  const pool = new Peers({ retries: { max: 0 } })
  const fake = new net.Socket() // never connected — enough to exercise accept+destroy bookkeeping
  const peer = pool.accept(fake, { host: '10.0.0.9', port: 54321 })
  assert.equal(pool.peer('10.0.0.9:54321'), peer, 'accepted peer is indexed')
  peer.destroy()
  assert.ok(await until(() => pool.peer('10.0.0.9:54321') === undefined, 2000), 'the ephemeral #conns entry is pruned')
  pool.destroy()
})
