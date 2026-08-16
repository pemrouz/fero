//! Perf sibling: the api binding sits on BOTH hot paths — every local write crosses capture→issue→
// commit→echo-consume, every inbound record crosses onApply→overlay-check→proxy-projection. The
// non-negotiables this pins: the capture path stays clone-free (bare verbs — the plan §10 tax the
// clone-based sinks would charge is ~30-40%), and the overlay bookkeeping stays O(1) map work per
// record. Absolutes are WSL2 tripwires (swing 2-3x); the structural claim is the design.
// Rep discipline (the data repo's own perf lesson, kept): every bench.time rep must touch FRESH
// values/seqs — re-touching identical ones dedups into the no-op path and the median measures nothing.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { VERB, encodeControl, encodeRuns } from '../kernel/codec.ts'
import { REC, type Rec } from '../kernel/env.ts'
import { bench } from '#utils'

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

test('absolute: 5k inbound records/rep through onApply→overlay→proxy under the tripwire ceiling', async () => {
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
