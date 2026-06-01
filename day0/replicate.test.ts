// Day 0 proof: a $() on side A replicates to a $() on side B over a real TCP
// socket, carrying nothing but `data`'s own change records. We mutate A every
// way the proxy allows (object set, nested set, array insert, delete) and
// assert B converges to byte-identical state — the hypothesis that "change
// records on the wire = change records in memory" holds end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value } from '../../data/index.ts'
import { publish, subscribe } from './replicate.ts'

// Spin up a loopback A→B replication pair over real TCP. A publishes, B subscribes.
// Returns the two proxies plus a teardown. `b` starts empty; the publish handshake
// (FunctionSink's initial snapshot) seeds it with A's current state.
function pair(initialA: any): Promise<{
  a: any
  b: any
  host: object
  close: () => Promise<void>
}> {
  return new Promise((resolve) => {
    const a = $(initialA)
    const b = $(undefined)

    const server = net.createServer((serverSocket) => {
      subscribe(b, serverSocket)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      const clientSocket = net.connect(port, '127.0.0.1', () => {
        const host = publish(a, clientSocket) // retained via the returned object below
        resolve({
          a,
          b,
          host,
          close: () =>
            new Promise<void>((done) => {
              void host // keep the pinned sink alive for the test's duration
              clientSocket.destroy()
              server.close(() => done())
            }),
        })
      })
    })
  })
}

// Poll until `check()` passes or we time out — replication is async (one tick
// per socket round-trip), so assertions wait for convergence rather than guess.
async function until(check: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 5))
  }
  return true
}

const converged = (b: any, expected: unknown) =>
  until(() => {
    try {
      assert.deepEqual(b[value], expected)
      return true
    } catch {
      return false
    }
  })

test('initial snapshot replicates on connect', async () => {
  const { b, close } = await pair({ user42: { name: 'P', active: true } })
  assert.ok(await converged(b, { user42: { name: 'P', active: true } }), JSON.stringify(b[value]))
  await close()
})

test('object set replicates', async () => {
  const { a, b, close } = await pair({})
  a.user42 = { name: 'P', active: true }
  a.user99 = { name: 'Q', active: false }
  assert.ok(
    await converged(b, { user42: { name: 'P', active: true }, user99: { name: 'Q', active: false } }),
    JSON.stringify(b[value]),
  )
  await close()
})

test('nested set replicates', async () => {
  const { a, b, close } = await pair({ user42: { name: 'P', active: true } })
  a.user42.active = false
  assert.ok(await converged(b, { user42: { name: 'P', active: false } }), JSON.stringify(b[value]))
  await close()
})

test('delete replicates', async () => {
  const { a, b, close } = await pair({ user42: { name: 'P' }, user99: { name: 'Q' } })
  delete a.user99
  assert.ok(await converged(b, { user42: { name: 'P' } }), JSON.stringify(b[value]))
  await close()
})

test('array insert (push) replicates with order', async () => {
  const { a, b, close } = await pair([])
  a.insert({ id: 1 })
  a.insert({ id: 2 })
  a.insert({ id: 3 })
  assert.ok(await converged(b, [{ id: 1 }, { id: 2 }, { id: 3 }]), JSON.stringify(b[value]))
  await close()
})

test('mixed stream converges', async () => {
  const { a, b, close } = await pair({})
  a.user42 = { name: 'P', active: true }
  a.user42.active = false
  a.user42.score = 10
  a.user7 = { name: 'Z' }
  delete a.user7
  const expected = { user42: { name: 'P', active: false, score: 10 } }
  assert.ok(await converged(b, expected), JSON.stringify(b[value]))
  await close()
})
