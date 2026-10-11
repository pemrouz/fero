//! Perf sibling: the api binding sits on BOTH hot paths — every local write crosses capture→issue→
// commit→echo-consume, every inbound record crosses onApply→join-check→proxy-projection. The
// non-negotiables this pins: the capture path stays clone-free (bare verbs — the plan §10 tax the
// clone-based sinks would charge is ~30-40%), and the settlement bookkeeping stays O(1) map work per
// record. Absolutes are WSL2 tripwires (swing 2-3x); the structural claim is the design.
// Rep discipline (the data repo's own perf lesson, kept): every bench.time rep must touch FRESH
// values/seqs — re-touching identical ones dedups into the no-op path and the median measures nothing.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind, unsendable } from './data.ts'
import { VERB, encodeControl, encodeRuns } from '../kernel/codec.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { bench, ratio } from '#utils'

const harness = () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  return { rt, bind: new Bind(rt) }
}

test('absolute: 5k assignments/rep through capture→issue→commit→echo-consume under the tripwire ceiling', async () => {
  const { rt, bind } = harness()
  const N = 5000
  let v = 0 // fresh value every assignment, every rep — never the dedup'd no-op path
  const ms = bench.time(() => {
    for (let i = 0; i < N; i++) bind.data['k' + (i & 1023)] = ++v
  })
  assert.equal(rt.node.state.size, 1024)
  assert.equal(rt.node.seq, N * 6, 'all six reps (warmup + 5) committed for real')
  assert.ok(ms < 400, `5k captured writes took ${ms.toFixed(1)}ms (ceiling 400ms)`)
  bind.destroy()
  await rt.destroy()
})

//! RATIO (V4-48): every local write's record is walked once before its stamp (api/data.ts unsendable →
// kernel/codec.ts encodable). On a small object (four fields, a list, a nested object) the walk read about
// 3% of the whole write in a profile here, a quarter more while it used vtOf and Object.entries. The pin:
// checking such records costs under a tenth of writing them (about 0.02x here), so a walk that turns
// quadratic or starts copying shows here. Numbers cost a type test and are not pinned apart.
test('ratio: the check a local write runs before its stamp (V4-48) costs under a tenth of the write itself on a small object', async () => {
  const { rt, bind } = harness()
  const N = 1000
  let v = 0 // fresh values every rep — never the dedup'd no-op path
  const value = () => ({ mood: 'hungry', n: ++v, toys: ['ball', 'mouse'], at: { x: 1, y: 2 } })
  const recs: Rec[] = Array.from({ length: N }, (_, i) => ({ type: REC.update, key: ['k' + i], value: value() }))
  let refused = 0
  const r = ratio.interleaved(
    () => { for (let i = 0; i < N; i++) bind.data['k' + i] = value() },
    () => { for (let i = 0; i < N; i++) if (unsendable(recs[i]) !== null) refused++ },
  )
  assert.equal(refused, 0)
  assert.ok(r < 0.1, `checking a small object / writing it = ${r.toFixed(3)}x (budget 0.1x; about 0.02x here)`)
  bind.destroy()
  await rt.destroy()
})

test('absolute: 5k inbound records/rep through onApply→join→proxy under the tripwire ceiling', async () => {
  const { rt, bind } = harness()
  rt.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  rt.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  rt.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  const N = 5000
  //! pre-encode outside the timed region (the codec has its own perf sibling): six rep-sets with
  // ADVANCING seqs, so no rep ever hits the dup-drop path
  const sets: Uint8Array[][] = []
  let seq = 0
  for (let rep = 0; rep < 6; rep++) {
    const frames: Uint8Array[] = []
    for (let i = 0; i < N; i += 50) {
      const recs: { rec: Rec; origin: string; seq: number; epoch: number }[] = []
      for (let k = 0; k < 50; k++) recs.push({ rec: { type: REC.update, key: ['r' + ((i + k) & 1023)], value: seq }, origin: 'bb', seq: ++seq, epoch: 0 })
      frames.push(encodeRuns(recs)[0])
    }
    sets.push(frames)
  }
  let rep = 0
  const ms = bench.time(() => {
    for (const f of sets[rep]) rt.node.step({ kind: 'bytesIn', link: 1, bytes: f })
    rep++
  })
  assert.equal(rt.node.streams.get('bb')!.applied, N * 6, 'all six reps applied for real')
  assert.ok(ms < 400, `5k inbound applies took ${ms.toFixed(1)}ms (ceiling 400ms)`)
  bind.destroy()
  await rt.destroy()
})

//! RATIO (V4-18, overlapping cells): a foreign apply pays for the in-flight writes of ours UNDER ITS
// OWN CELL only. With 1k of our field writes in flight on a row (forwarded to the owner, no answer
// yet), a foreign FIELD apply on that row must cost what it costs with none in flight: the #fields
// index is keyed by ancestor, so the lookup under a depth-2 cell finds nothing and walks nothing.
// Keyed by row alone it copied and scanned the row's whole set on every apply — about 8x. Both sides
// are inbound frames with advancing seqs on their own node (the fresh-record path, never dupDrop).
//! formed — a node at view e1 with `cart` owned by bb and `inflight` of our ['cart','fN'] writes
// forwarded there, no answer yet (the kernel still holds every one)
const formed = (inflight: number) => {
  const { rt, bind } = harness()
  const node = rt.node
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  node.writes.ring.place('cart', 'bb')
  for (let i = 0; i < inflight; i++) bind.issue([{ type: REC.update, key: ['cart', 'f' + i], value: i }])
  assert.equal(node.writes.pending.size, inflight)
  return { rt, bind, node }
}

test('ratio: a foreign field apply with 1k of our field writes in flight on that row costs the same as with none', async () => {
  const none = formed(0), many = formed(1000)
  //! 8 rounds (warmup + 7) of 500 foreign field applies each, the same bytes to both nodes
  const BATCH = 500
  const frames: Uint8Array[] = []
  for (let r = 0; r < 8; r++) {
    const recs: { rec: Rec; origin: string; seq: number; epoch: number }[] = []
    for (let k = 0; k < BATCH; k++) recs.push({ rec: { type: REC.update, key: ['cart', 'theirs' + (k % 10)], value: r * BATCH + k }, origin: 'bb', seq: 1 + r * BATCH + k, epoch: 1 })
    frames.push(encodeRuns(recs)[0])
  }
  let i = 0, j = 0
  const r = ratio.interleaved(
    () => { none.node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) },
    () => { many.node.step({ kind: 'bytesIn', link: 1, bytes: frames[j++] }) },
  )
  assert.equal(many.node.writes.pending.size, 1000, 'ours are still in flight — none settled, none dropped')
  assert.ok(r < 1.6, `foreign field apply with 1k of ours in flight / with none = ${r.toFixed(2)}x — the probe is walking the row's whole set (budget 1.6x; keyed by row it read 2.3-2.5x here, keyed by ancestor 1.0x)`)
  none.bind.destroy(); many.bind.destroy()
  await none.rt.destroy(); await many.rt.destroy()
})

//! RATIO (V4-18): a foreign WHOLE-ROW apply is the parent of every field write of ours in that row, so
// the probe must ask about them — but only about the ones the kernel no longer holds (a held attempt
// settles through its own echo, or the `lost` effect when the echo is refused). With 1k of ours in
// flight and none answered, a row apply must cost what it costs with none: walking all 1k on every row
// apply read about 30x here (0.2 µs per in-flight field).
test('ratio: a foreign ROW apply with 1k of our field writes in flight in that row costs the same as with none', async () => {
  const none = formed(0), many = formed(1000)
  const BATCH = 500
  const frames: Uint8Array[] = []
  for (let r = 0; r < 8; r++) {
    const recs: { rec: Rec; origin: string; seq: number; epoch: number }[] = []
    for (let k = 0; k < BATCH; k++) recs.push({ rec: { type: REC.update, key: ['cart'], value: { theirs: r * BATCH + k } }, origin: 'bb', seq: 1 + r * BATCH + k, epoch: 1 })
    frames.push(encodeRuns(recs)[0])
  }
  let i = 0, j = 0
  const r = ratio.interleaved(
    () => { none.node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) },
    () => { many.node.step({ kind: 'bytesIn', link: 1, bytes: frames[j++] }) },
  )
  assert.equal(many.node.writes.pending.size, 1000, 'ours are still in flight — none settled, none dropped')
  assert.deepEqual(many.node.state.get(JSON.stringify(['cart'])), { theirs: 8 * BATCH - 1 }, 'every row applied for real')
  assert.ok(r < 1.6, `foreign row apply with 1k of ours in flight / with none = ${r.toFixed(2)}x — the probe walks every field of ours in the row (budget 1.6x)`)
  none.bind.destroy(); many.bind.destroy()
  await none.rt.destroy(); await many.rt.destroy()
})
