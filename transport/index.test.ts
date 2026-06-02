// L0 end-to-end: independent server processes (here, in-process over loopback)
// discover each other via static config, connect, handshake, ring up, and route
// writes to their DHT owners. The mesh is storeless — each node's onRecord feeds
// a local $() so we can assert where records landed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { transport, type Mesh } from './index.ts'
import { STATUS } from './peer.ts'
import type { ChangeRecord } from './message.ts'

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

const applier = () => {
  const store = $({})
  const res = (store as any)[view].res
  return {
    store,
    apply: (record: ChangeRecord) => {
      if (record.type === 'update') res.update(record.value, record.key)
      else if (record.type === 'insert') res.insert(record.value, record.key, record.at)
      else if (record.type === 'remove') res.remove(record.key)
    },
  }
}

const connected = (mesh: Mesh, addr: string) => (mesh.peers[addr]?.status?.[value] ?? -1) === STATUS.connected

test('two servers discover, connect, and route writes to their owners', async () => {
  const [p1, p2] = [await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = applier()
  const B = applier()

  const mA = transport({ name: 't', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord: A.apply })
  const mB = transport({ name: 't', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord: B.apply })

  // both dial each other → both see the other connected
  assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B should connect')

  // rings agree on membership (same owner for any key on both nodes)
  assert.equal(mA.owner('probe'), mB.owner('probe'))

  const N = 30
  for (let i = 0; i < N; i++) mA.send({ type: 'update', key: ['key' + i], value: { n: i } })

  // every record lands somewhere (owner === A delivers locally, else over TCP)
  assert.ok(
    await until(() => Object.keys(A.store[value]).length + Object.keys(B.store[value]).length === N),
    `A=${Object.keys(A.store[value]).length} B=${Object.keys(B.store[value]).length}`,
  )

  // and each lands on EXACTLY its DHT owner
  let onA = 0
  let onB = 0
  for (let i = 0; i < N; i++) {
    const k = 'key' + i
    const owner = mA.owner(k)
    if (owner === mA.me) {
      assert.ok(k in A.store[value], `${k} should be on A (owner ${owner})`)
      assert.ok(!(k in B.store[value]), `${k} should NOT be on B`)
      onA++
    } else {
      assert.ok(k in B.store[value], `${k} should be on B (owner ${owner})`)
      assert.ok(!(k in A.store[value]), `${k} should NOT be on A`)
      onB++
    }
  }
  // both owners actually exercised (sanity — not everything on one node)
  assert.ok(onA > 0 && onB > 0, `distribution onA=${onA} onB=${onB}`)

  mA.destroy()
  mB.destroy()
})

test('membership gossips: a third node that only knows A learns B', async () => {
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = applier()
  const B = applier()
  const C = applier()

  // A and B know each other; C is told ONLY about A — it must learn B via gossip.
  const mA = transport({ name: 't', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord: A.apply })
  const mB = transport({ name: 't', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord: B.apply })
  assert.ok(await until(() => connected(mA, a2)), 'A↔B first')

  const mC = transport({ name: 't', host: '127.0.0.1', port: p3, ports: [p1], wait: 200, onRecord: C.apply })

  // C learns B from A's handshake gossip and dials it
  assert.ok(await until(() => connected(mC, a1) && connected(mC, a2)), `C connected: A=${connected(mC, a1)} B=${connected(mC, a2)}`)

  mA.destroy()
  mB.destroy()
  mC.destroy()
})
