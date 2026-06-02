import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { Peers } from './peers.ts'
import { STATUS, type Peer } from './peer.ts'
import { until, apply } from '#utils'

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
