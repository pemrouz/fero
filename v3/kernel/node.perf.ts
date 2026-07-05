//! Perf sibling: the kernel step tax — the event/effect architecture's cost, measured against a direct-call strawman.
// This is the M0 go/no-go measurement from plan-v3.md §11 (and a PERMANENT
// tracked ratio thereafter, per the judge grafts): if events-in/effects-out
// costs multiples of the direct approach on the hot path, the architecture
// claim fails HERE, in week one, not at M5. The strawman does the irreducible
// work (state-map set + frame encode); the kernel adds ingest bookkeeping, the
// journal, the state-hash mirror, and effect dispatch.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { Framer, VERB, encodeControl, Outbox } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { bench, ratio } from '#utils'

const BATCH = 2_000
const recs: Rec[] = Array.from({ length: BATCH }, (_, i) => ({
  type: REC.update, key: [`k${i % 256}`], value: { n: i, s: `v${i}` },
}))

//! a formed 1-peer node with a swallow-everything sink — measures kernel work, not I/O
const formedNode = () => {
  const env: Env = {
    now: () => 0,
    rng: () => 0.5,
    sink: { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.journal.armed = false // perf posture: unwatched journal must cost ~nothing (predicted-false emit gates)
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) }) // sync — live records flow
  return node
}

test('ratio: full kernel write path vs direct-call strawman stays within budget', () => {
  const node = formedNode()
  const state = new Map<string, unknown>()
  const outbox = new Outbox()
  const r = ratio.interleaved(
    () => { // strawman: the irreducible work — set state, encode one frame
      outbox.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 0 })
      for (const rec of recs) { state.set(rec.key[0], rec.value); outbox.add(rec) }
      outbox.finish()
    },
    () => { node.step({ kind: 'write', recs }) }, // the whole kernel: ingest + hash mirror + effects
  )
  //! budget 6x: the M0 kernel carries a per-apply state-hash mirror (the sim's convergence oracle) that
  // moves behind the api-layer seam at M5 — the ratio is tracked so that migration must show up HERE as a drop.
  assert.ok(r < 6, `kernel/strawman ratio ${r.toFixed(2)} exceeds 6x — the event/effect tax grew`)
})

//! COUNTED: one write event with one admitted peer emits exactly ONE frame (coalescing), and a
// 3-peer mesh emits exactly three — frame counts are deterministic on any machine.
test('counted: frames per write burst = admitted peers, exactly', () => {
  let frames = 0
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: { connect() {}, send() { frames++ }, close() {}, timer() {}, cancel() {}, apply() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  for (let p = 0; p < 3; p++) {
    node.step({ kind: 'linkUp', link: p + 1, dialed: true, to: `x:${p + 2}` })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.HELLO, { u: `p${p}`, i: 1, l: `x:${p + 2}` }) })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  frames = 0
  node.step({ kind: 'write', recs })
  assert.equal(frames, 3, `write burst produced ${frames} frames for 3 peers — coalescing broke`)
})

//! ABSOLUTE (tripwire): steady-state inbound apply — decode+dedup+LWW+apply for 2k records.
// Frames are pre-encoded OUTSIDE the timed region (the review caught encode
// riding inside the measurement, diluting the receive-path gate by ~half);
// bench.time runs the fn 6x (warmup + 5), so 6 frames with advancing seqs keep
// every timed pass on the genuinely-new path instead of the dupDrop path.
test('absolute: 2k-record inbound apply under the tripwire ceiling', () => {
  const node = formedNode()
  const o = new Outbox()
  const frames: Uint8Array[] = []
  for (let i = 0; i < 6; i++) {
    o.begin(VERB.RECORDS, { origin: 'bb', baseSeq: 1 + i * BATCH, epoch: 0 })
    for (const rec of recs) o.add(rec)
    frames.push(o.finish()!)
  }
  let i = 0
  const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) })
  assert.ok(ms < 100, `2k inbound apply took ${ms.toFixed(1)}ms (ceiling 100ms)`)
})
