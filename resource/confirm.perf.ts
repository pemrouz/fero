// The confirm-tier LATENCY LADDER: how long each write guarantee costs, the headline
// the tiered-confirm API is about. Fire-and-forget and confirm:'accepted' are LOCAL (no
// network); confirm:'committed' on an OWNED key resolves on a microtask (the owner
// sequences synchronously); confirm:'committed' on a FORWARDED key costs one owner
// round-trip; confirm:'replicated' adds a W-quorum probe RTT; confirm:'persisted' adds the
// storage.append durable-probe on top. The ladder must be a real slope — committed-forwarded
// > committed-local ≈ accepted ≈ fire-and-forget, and replicated/persisted > committed-local.
// Thresholds are measured loopback floors + headroom, NOT guesses; never widen one to pass —
// investigate the regression. Median-of-5 + warmup via bench.timeAsync.

import { test } from 'node:test'
import { ok } from 'node:assert'
import os from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fero, fileStorage } from './index.ts'
import { ports, bench, until, connected } from '#utils'

const M = 200 // local-tier ops per sample (no network)
const F = 100 // forwarded ops per sample (each ≈ one owner round-trip)

test('confirm ladder: accepted + committed-owner stay local (sub-ms/op), at the fire-and-forget floor', async () => {
  const A: any = await fero('cperf-local', { port: await ports.free(), wait: 10 })
  let n = 0
  const ff = bench.time(() => {
    for (let i = 0; i < M; i++) A.data['ff' + i] = ++n // fire-and-forget (synchronous sink → log → broadcast)
  })
  const accepted = await bench.timeAsync(async () => {
    for (let i = 0; i < M; i++) await A.methods.update({ key: ['ac' + i], value: ++n, confirm: 'accepted' })
  })
  const committed = await bench.timeAsync(async () => {
    for (let i = 0; i < M; i++) await A.methods.update({ key: ['co' + i], value: ++n, confirm: 'committed' })
  })
  console.log(`  fire-and-forget : ${(ff / M).toFixed(4)} ms/op`)
  console.log(`  accepted        : ${(accepted / M).toFixed(4)} ms/op`)
  console.log(`  committed-owner : ${(committed / M).toFixed(4)} ms/op`)
  ok(accepted / M < 1, `accepted ${(accepted / M).toFixed(4)}ms/op (threshold 1ms — a local apply, no network)`)
  ok(committed / M < 1, `committed-owner ${(committed / M).toFixed(4)}ms/op (threshold 1ms — a synchronous sequence + microtask)`)
  A.destroy()
})

test('confirm ladder: committed-FORWARDED costs an owner round-trip (the real network tier) and exceeds committed-local', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A: any = await fero('cperf-fwd', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B: any = await fero('cperf-fwd', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    // wait for the committed 2-member VIEW (not just a socket) — that's what drives the ring owner(k)
    ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2 && connected(A.cluster, B.cluster.me), 8000), 'A↔B committed a 2-member view')
    const keys = Array.from({ length: 500 }, (_, i) => 'k' + i)
    const owned = keys.filter((k) => A.cluster.owner(k) === A.cluster.me)
    const foreign = keys.filter((k) => A.cluster.owner(k) !== A.cluster.me)
    ok(owned.length > 0 && foreign.length > 0, 'both owned and foreign keys exist')
    let n = 0
    const local = await bench.timeAsync(async () => {
      for (let i = 0; i < F; i++) await A.methods.update({ key: [owned[i % owned.length]], value: ++n, confirm: 'committed' })
    })
    const fwd = await bench.timeAsync(async () => {
      for (let i = 0; i < F; i++) await A.methods.update({ key: [foreign[i % foreign.length]], value: ++n, confirm: 'committed' })
    })
    const repl = await bench.timeAsync(async () => {
      for (let i = 0; i < F; i++) await A.methods.update({ key: [owned[i % owned.length]], value: ++n, confirm: 'replicated' })
    })
    console.log(`  committed-local     : ${(local / F).toFixed(4)} ms/op`)
    console.log(`  committed-forwarded : ${(fwd / F).toFixed(4)} ms/op (one owner round-trip)`)
    console.log(`  replicated (owned)  : ${(repl / F).toFixed(4)} ms/op (committed + a W-quorum probe RTT)`)
    ok(fwd / F < 5, `committed-forwarded ${(fwd / F).toFixed(4)}ms/op (threshold 5ms — a loopback owner round-trip)`)
    ok(repl / F < 8, `replicated ${(repl / F).toFixed(4)}ms/op (threshold 8ms — committed + a probe RTT)`)
    ok(fwd > local, `the ladder is a real slope: forwarded (${(fwd / F).toFixed(4)}) > local (${(local / F).toFixed(4)}) ms/op`)
    ok(repl > local, `replicated (${(repl / F).toFixed(4)}) > committed-local (${(local / F).toFixed(4)}) ms/op — the probe RTT is real`)
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('confirm ladder: persisted (durable W-quorum) exceeds committed-local in the SAME storage-backed cluster', async () => {
  // persisted needs storage, and the built-in fileStorage does real file I/O, so measure it in a
  // dedicated storage-backed cluster where committed and persisted both pay that I/O — isolating the
  // durable-probe RTT as the delta. (Numbers here aren't comparable to the I/O-free ladder above.)
  const [p1, p2] = [await ports.free(), await ports.free()]
  const wals = [join(os.tmpdir(), `cperf-p-${randomUUID().slice(0, 8)}.log`), join(os.tmpdir(), `cperf-p-${randomUUID().slice(0, 8)}.log`)]
  const A: any = await fero('cperf-pers', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, storage: fileStorage(wals[0]) })
  const B: any = await fero('cperf-pers', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, storage: fileStorage(wals[1]) })
  try {
    ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2 && connected(A.cluster, B.cluster.me), 8000), 'A↔B committed a 2-member view')
    const owned = Array.from({ length: 500 }, (_, i) => 'k' + i).filter((k) => A.cluster.owner(k) === A.cluster.me)
    ok(owned.length > 0, 'A owns some keys')
    let n = 0
    const committed = await bench.timeAsync(async () => {
      for (let i = 0; i < F; i++) await A.methods.update({ key: [owned[i % owned.length]], value: ++n, confirm: 'committed' })
    })
    const persisted = await bench.timeAsync(async () => {
      for (let i = 0; i < F; i++) await A.methods.update({ key: [owned[i % owned.length]], value: ++n, confirm: 'persisted' })
    })
    console.log(`  committed-local (storage) : ${(committed / F).toFixed(4)} ms/op`)
    console.log(`  persisted (durable W)     : ${(persisted / F).toFixed(4)} ms/op (committed + a durable-probe RTT)`)
    ok(persisted / F < 12, `persisted ${(persisted / F).toFixed(4)}ms/op (threshold 12ms — committed + a durable-probe RTT over loopback + file I/O)`)
    ok(persisted > committed, `persisted (${(persisted / F).toFixed(4)}) > committed-local (${(committed / F).toFixed(4)}) ms/op — the durable-probe RTT is real`)
  } finally {
    A.destroy()
    B.destroy()
    wals.forEach((w) => rmSync(w, { force: true }))
  }
})
