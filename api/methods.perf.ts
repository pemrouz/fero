//! Perf sibling (M5c): the subscription stream path — server-side FunctionSink → subOut step →
// SUBREC encode, per record. This is the method plane's only per-delta hot path (calls are cold);
// the clone in data's record interface and the control-codec value encode are its known costs —
// this tripwire keeps them bounded per record. Absolutes swing 2-3x on WSL2; the structural claim
// is one sink dispatch + one control frame per delta, no hidden fan-out.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { derived, handlerScope, records } from './substrate.ts'
import { VERB, encodeControl } from '../kernel/codec.ts'
import { bench, ratio } from '#utils'

const NODE = Symbol.for('data.v4.node')

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

//! RATIO (I-29): a view a handler makes through ctx.data comes back wrapped and registered with the
// collector (substrate.handlerScope), so it can be released once the handler lets go of it. That costs
// a Proxy, a WeakRef and a registry cell per view — a few µs — next to the view itself, which reads
// every row of its source. 1000 filters over a 200-row source, made through the handler scope vs made
// raw through the lens (both disposed by hand inside the rep, so release work is equal). Measured about
// 1.1x here. The pin catches the trap the wrapper's design avoids: a wrapper whose Proxy target is the
// data handle itself makes the engine ask that handle for its own property on every read, and data
// answers by materializing the whole view — that read about 3x.
test('ratio: 1000 views made through the handler scope cost about what they cost made raw', async () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const bind = new Bind(rt)
  for (let i = 0; i < 200; i++) bind.data['r' + i] = { n: i }
  const scope = handlerScope(bind.data)
  const make = (d: any) => () => {
    const vs: any[] = []
    for (let i = 0; i < 1000; i++) { const v = d.filter((r: { n: number }) => r.n > i % 7); v.rowCount(); vs.push(v) }
    for (const v of vs) v[NODE].dispose()
  }
  const r = ratio.interleaved(make(bind.data), make(scope))
  assert.equal(derived(bind.data), 0, 'every view was disposed')
  assert.ok(r < 1.5, `1000 views through the handler scope / raw = ${r.toFixed(2)}x (budget 1.5x; about 1.1x here, about 3x with the handle as the Proxy target)`)
  bind.destroy()
  await rt.destroy()
})
