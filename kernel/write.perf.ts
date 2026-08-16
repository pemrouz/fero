//! Perf sibling: the write pipeline's two hot legs — the ISSUER leg (attempt minting + ring resolution
// + forward framing) and the OWNER leg (decode + cid dedup + validation + the stamp site + ACK) — plus
// the M3 deliverable the plan names: the HOT-PARTITION CEILING, measured and printed (one partition has
// ONE sequencer by design; this number is the documented throughput bound for that partition, and the
// mitigation is owner-side batching + partition granularity — plan §7). Absolute numbers are tripwires
// (WSL2 swings 2-3x); the counted invariants are the durable claims.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { VERB, encodeControl } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { bench } from '#utils'
//! fixtures single-sourced with the M8 baseline probes (tools/perf/fixtures.ts) — declaration move
// only; every timed loop body below is byte-identical to its pre-extraction form
import { formedView1, writeFrames } from '../tools/perf/fixtures.ts'

const BATCH = 2_000

test('absolute + THE DOCUMENTED NUMBER: hot-partition ceiling — one owner sequencing forwarded writes', () => {
  const { node } = formedView1()
  node.writes.ring.place('hot', 'aa')
  //! 6 frames × 2k records with advancing cids: bench.time's warmup+5 keeps every timed pass on the
  // fresh-commit path (dedup would otherwise flatter the number)
  const frames = writeFrames(6, BATCH)
  let i = 0
  const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) })
  const perSec = Math.round(BATCH / (ms / 1000))
  console.log(`  hot-partition ceiling on this runner: ~${perSec.toLocaleString()} forwarded records/s through one owner (${ms.toFixed(1)}ms / ${BATCH})`)
  assert.ok(ms < 120, `2k forwarded commits took ${ms.toFixed(1)}ms (tripwire 120ms)`)
})

test('absolute: the ISSUER leg — 2k attempts minted, resolved, and framed for a peer owner', () => {
  const { node } = formedView1()
  node.writes.ring.place('theirs', 'bb')
  const recs: Rec[] = Array.from({ length: BATCH }, (_, i) => ({
    type: REC.update, key: ['theirs', `f${i & 511}`], value: i,
  }))
  //! each timed pass forwards a fresh batch; the WACK clears pending so the queue never accretes
  let base = 0
  const ms = bench.time(() => {
    node.step({ kind: 'write', recs })
    node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: base + 1, n: BATCH, s: 1, e: 1 }) })
    base += BATCH
  })
  assert.ok(ms < 120, `2k-attempt forward leg took ${ms.toFixed(1)}ms (tripwire 120ms)`)
})

test('counted: one batch to one owner = ONE WRITE frame out; the owner answers ONE WACK per run', () => {
  const { node, framesSent } = formedView1()
  node.writes.ring.place('theirs', 'bb')
  const before = framesSent()
  node.step({ kind: 'write', recs: Array.from({ length: 64 }, (_, i) => ({ type: REC.update, key: ['theirs', `k${i}`], value: i })) })
  assert.equal(framesSent() - before, 1, 'contiguous cids to one owner must coalesce into exactly one WRITE frame')
  //! owner side: one inbound run → one WACK + one RECORDS broadcast per synced link (2 links here)
  const owner = formedView1()
  owner.node.writes.ring.place('hot', 'aa')
  const [frame] = writeFrames(1, 64)
  const b2 = owner.framesSent()
  owner.node.step({ kind: 'bytesIn', link: 1, bytes: frame })
  assert.equal(owner.framesSent() - b2, 3, 'one run must answer with exactly 1 WACK + 2 broadcast frames')
})

test('counted: epoch-0 writes pay ZERO write-pipeline overhead (the M0/M1 fast path is byte-identical)', () => {
  //! structural pin for the sweeps' perf posture: below genesis the pipeline adds no frames, no pending
  // entries, no journal rows — the write event goes straight to the M0 stamp site.
  let frames = 0
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: { connect() {}, send() { frames++ }, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  frames = 0
  node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(frames, 1, 'one broadcast frame, nothing else')
  assert.equal(node.writes.pending.size, 0)
  assert.equal(node.journal.read().filter((e) => e.kind >= 37 && e.kind <= 41).length, 0, 'no M3 journal vocabulary below genesis')
})
