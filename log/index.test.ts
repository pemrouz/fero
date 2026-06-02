import { test } from 'node:test'
import assert from 'node:assert/strict'
import { value } from '../../data/index.ts'
import { log, view, distribute } from './index.ts'
import { ports, until, connected, sleep } from '../utils/index.ts'

test('view projects a log: replay of existing records + live appends', () => {
  const l = log()
  l.append({ type: 'update', key: ['user42'], value: { name: 'P', active: true } })

  const data = view(l) // replays what's already there
  assert.deepEqual(data[value], { user42: { name: 'P', active: true } })

  l.append({ type: 'update', key: ['user42', 'active'], value: false })
  l.append({ type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' })
  assert.deepEqual(data[value], { user42: { name: 'P', active: false }, user99: { name: 'Q' } })

  l.append({ type: 'remove', key: ['user99'] })
  assert.deepEqual(data[value], { user42: { name: 'P', active: false } })
})

test('the view is itself reactive — connect/tap sees each applied record', () => {
  const l = log()
  const data = view(l)
  const changes = data.connect([]) // capture the view's change stream
  l.append({ type: 'update', key: ['a'], value: 1 })
  l.append({ type: 'update', key: ['b'], value: 2 })
  // initial snapshot + two updates
  assert.equal(changes.length, 3)
  assert.deepEqual(changes.at(-1), { type: 'insert', key: [], value: 2, at: 'b' }) // new key → insert
})

test('2-node: append on A replicates to B’s view (log → mesh → view)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = distribute({ name: 'r', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = distribute({ name: 'r', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })

  assert.ok(await until(() => connected(A.mesh, a2) && connected(B.mesh, a1)), 'A↔B connect')

  A.log.append({ type: 'update', key: ['user42'], value: { name: 'P' } })
  A.log.append({ type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' })

  const expected = { user42: { name: 'P' }, user99: { name: 'Q' } }
  assert.ok(
    await until(() => JSON.stringify(B.data[value]) === JSON.stringify(expected)),
    `B view = ${JSON.stringify(B.data[value])}`,
  )
  // A's own view projects its appends too (full replication: both converge)
  assert.deepEqual(A.data[value], expected)
  // and B's log mirrors the records
  assert.equal(B.log.size, 2)

  A.mesh.destroy()
  B.mesh.destroy()
})

test('2-node: replication does not echo (inbound records are not re-broadcast)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A = distribute({ name: 'r2', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = distribute({ name: 'r2', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.mesh, a2)))

  for (let i = 0; i < 10; i++) A.log.append({ type: 'update', key: ['k' + i], value: i })
  assert.ok(await until(() => B.log.size === 10))
  await sleep(50) // give any echo a chance to arrive

  // exactly 10 on each — no duplicates from echo or dual-connection double-send
  assert.equal(A.log.size, 10)
  assert.equal(B.log.size, 10)

  A.mesh.destroy()
  B.mesh.destroy()
})
