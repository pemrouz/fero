// Unit tests for the shared helpers. They're test infrastructure, so the bar is
// "the contract every other suite relies on holds": free ports are real ports,
// median/time measure what they claim, until resolves true-on-pass /
// false-on-timeout, and apply drives the [view].res write contract correctly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { STATUS } from '../transport/peer.ts'
import { ports, bench, until, sleep, connected, apply } from './index.ts'

test('ports.free() yields a usable, bindable port', async () => {
  const p = await ports.free()
  assert.equal(typeof p, 'number')
  assert.ok(p > 0 && p < 65536, `port ${p} in range`)

  // the port is actually free right now — we can bind it
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(p, '127.0.0.1', () => s.close(() => resolve()))
  })
})

test('bench.median picks the middle of a sorted copy, without mutating input', () => {
  const xs = [3, 1, 2, 5, 4]
  assert.equal(bench.median(xs), 3)
  assert.deepEqual(xs, [3, 1, 2, 5, 4], 'input left untouched (slice, not sort-in-place)')
  assert.equal(bench.median([10]), 10)
})

test('bench.time runs warmup + 5 timed iterations and returns a non-negative ms', () => {
  let calls = 0
  const elapsed = bench.time(() => {
    calls++
  })
  assert.equal(calls, 6, '1 warmup + 5 measured runs')
  assert.ok(elapsed >= 0 && Number.isFinite(elapsed), `elapsed ${elapsed}`)
})

test('until resolves true once the condition passes', async () => {
  let flag = false
  setTimeout(() => {
    flag = true
  }, 10)
  assert.equal(await until(() => flag), true)
})

test('until resolves false when the deadline elapses', async () => {
  const t0 = Date.now()
  assert.equal(await until(() => false, 30), false)
  assert.ok(Date.now() - t0 >= 25, 'waited roughly the full budget before giving up')
})

test('sleep resolves after roughly the requested delay', async () => {
  const t0 = Date.now()
  await sleep(20)
  assert.ok(Date.now() - t0 >= 15)
})

test('apply drives update / insert / remove onto a data res', () => {
  const store = $({})
  const res = (store as any)[view].res

  apply(res, { type: 'update', key: ['user42'], value: { name: 'P', active: true } })
  assert.deepEqual(store[value], { user42: { name: 'P', active: true } })

  apply(res, { type: 'update', key: ['user42', 'active'], value: false })
  apply(res, { type: 'insert', key: [], value: { name: 'Q' }, at: 'user99' })
  assert.deepEqual(store[value], { user42: { name: 'P', active: false }, user99: { name: 'Q' } })

  apply(res, { type: 'remove', key: ['user99'] })
  assert.deepEqual(store[value], { user42: { name: 'P', active: false } })
})

test('connected reads a peer status off a .peers surface', () => {
  const mesh = {
    peers: {
      'a:1': { status: { [value]: STATUS.connected } },
      'b:2': { status: { [value]: STATUS.connecting } },
    },
  }
  assert.equal(connected(mesh, 'a:1'), true)
  assert.equal(connected(mesh, 'b:2'), false, 'connecting is not connected')
  assert.equal(connected(mesh, 'missing'), false, 'absent peer is not connected')
})
