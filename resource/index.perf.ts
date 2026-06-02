// L2 hot path: the per-write cost the resource layer adds on top of a raw `data`
// assignment. Every write on `r.data` fires the write-capture sink → stamp
// provenance (Lamport seq) → record the LWW winner → log.append → mesh.broadcast.
// This runs on every single write, so its overhead is latency every caller
// inherits. We also measure method-dispatch (methods.update) since the default
// verbs are the other write entry point.
//
// No peers (a lone server) — broadcast is a no-op fan-out over zero dialed peers,
// isolating the resource-layer overhead from the network.
//
// Decomposition (10k writes, measured): raw data assign ≈ 9ms → + the FunctionSink
// (which `sclone`s each value) ≈ 32ms → + log.append ≈ 45ms. The replication core
// (Milestone A — provenance + dedup + LWW) adds the Lamport bump, a no-alloc
// versionKey, and a version-map entry mutated IN PLACE (not reallocated — a fresh
// stamp per write tripled GC pressure to ~155ms before that fix), landing the
// steady state around ~80–105ms standalone / ~80–90ms under the full parallel
// suite. The dominant cost remains data's defensive `sclone`; its allocations
// make the path GC-sensitive. Cutting the clone (a non-cloning sink for the
// broadcast path) is the known win — see ../IDEAS.md. Median-of-5 + warmup.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { fero } from './index.ts'
import { ports, bench } from '#utils'

const N = 10_000

test('L2: N assignment writes through the resource layer (sink → log → broadcast)', async () => {
  const r = await fero('perf-write', { port: await ports.free(), wait: 10 })
  const elapsed = bench.time(() => {
    for (let i = 0; i < N; i++) r.data['k' + i] = { score: i, active: (i & 1) === 0 }
  })
  console.log(`  ${N} data writes: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 150, `${N} writes took ${elapsed.toFixed(3)}ms (threshold 150ms)`)
  r.destroy()
})

test('L2: N default-method dispatches (methods.update → norm → setPath)', async () => {
  const r = await fero('perf-method', { port: await ports.free(), wait: 10 })
  const elapsed = bench.time(() => {
    for (let i = 0; i < N; i++) r.methods.update({ key: ['k' + i], value: { score: i } })
  })
  console.log(`  ${N} method updates: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 150, `${N} method updates took ${elapsed.toFixed(3)}ms (threshold 150ms)`)
  r.destroy()
})
