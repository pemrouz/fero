//! Perf sibling (M5c): the subscription stream path — server-side FunctionSink → subOut step →
// SUBREC encode, per record. This is the method plane's only per-delta hot path (calls are cold);
// the clone in data's record interface and the control-codec value encode are its known costs —
// this tripwire keeps them bounded per record. Absolutes swing 2-3x on WSL2; the structural claim
// is one sink dispatch + one control frame per delta, no hidden fan-out.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { records } from './substrate.ts'
import { VERB, encodeControl } from '../kernel/codec.ts'
import { bench } from '#utils'

test('absolute: 5k streamed sub deltas/rep (sink → subOut → SUBREC encode) under the tripwire ceiling', async () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const bind = new Bind(rt)
  //! a fake admitted caller link so subOut has a live route (the frames go to a nonexistent socket —
  // this measures the api+kernel encode path, not TCP)
  rt.node.step({ kind: 'linkUp', link: 1, dialed: false })
  rt.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '' }) })
  let streamed = 0
  const stream = records(bind.data, (rec) => {
    streamed++
    rt.node.step({ kind: 'subOut', link: 1, id: 7, recs: [rec as never] })
  })
  const N = 5000
  let v = 0
  const ms = bench.time(() => {
    for (let i = 0; i < N; i++) bind.data['k' + (i & 511)] = ++v
  })
  assert.ok(streamed >= N * 6, 'every rep streamed for real')
  assert.ok(ms < 500, `5k streamed deltas took ${ms.toFixed(1)}ms (ceiling 500ms)`)
  stream.stop()
  bind.destroy()
  await rt.destroy()
})
