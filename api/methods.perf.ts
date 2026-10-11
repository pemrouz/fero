//! Perf sibling (M5c): the subscription stream path — server-side FunctionSink → subOut step →
// SUBREC encode, per record. This is the method plane's only per-delta hot path (calls are cold);
// the clone in data's record interface and the control-codec value encode are its known costs —
// this tripwire keeps them bounded per record. Absolutes swing 2-3x on WSL2; the structural claim
// is one sink dispatch + one control frame per delta, no hidden fan-out.

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../shell/runtime.ts'
import { Bind } from './data.ts'
import { derived, handlerScope, records, unwrap } from './substrate.ts'
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

//! RATIO (I-29 skeptic): a child read off a wrapped view (view.r1 inside a handler) goes through the
// wrapper's trap and then data's own, so it costs about 2x a raw read; there is no way under one extra
// Proxy layer. What the pin guards is the cheap road: data caches each child handle, and `adopt` reuses
// the live wrapper for a raw handle it has seen, so a repeated read makes no new wrapper. A new wrapper
// per read (no cache) reads about 15x and fails it. The pin does NOT tell apart WHERE adopt asks the
// cache: first (now) reads 2.3-2.9x here, last (the first cut) 3.2-3.9x, and on this box the two ranges
// nearly touch, so a budget between them would flake. Read 20k times over 2000 rows.
test('ratio: child reads off a view made through the handler scope cost about 2x a raw read', async () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const bind = new Bind(rt)
  for (let i = 0; i < 2000; i++) bind.data['r' + i] = { n: i }
  const raw = (bind.data as any).filter((r: { n: number }) => r.n >= 0)
  const wrapped = handlerScope(bind.data).filter((r: { n: number }) => r.n >= 0)
  let seen = 0
  const read = (v: any) => () => { for (let i = 0; i < 20000; i++) if (v['r' + (i % 2000)] !== undefined) seen++ }
  const r = ratio.interleaved(read(raw), read(wrapped))
  assert.equal(seen, 20000 * 16, 'every read found its row')
  assert.ok(r < 4, `child reads through the handler scope / raw = ${r.toFixed(2)}x (budget 4x; about 2.3-2.9x here, about 15x with no wrapper cache)`)
  raw[NODE].dispose()
  bind.destroy()
  await rt.destroy()
})

//! RATIO (I-29 second skeptic): every operator call through the public lens (f.data.sum('n') in module
// code) now marks the view it hands out as ESCAPED, so the collector never releases a view module code
// holds (substrate `escaping`): one more closure, a node read through data's trap and a WeakSet add per
// call. A view build dwarfs that; a deduped HIT (data hands back the view it already has) does not. 50k
// deduped sum('n') hits over 100 rows, through the lens vs through data's own handle: about 1.15x before
// I-29, about 1.45x with the mark (about 0.2-0.3 µs a call here). The pin is a coarse tripwire: a scan
// of the graph per call (what `mark` does once per invocation) reads 3.0x and fails it; a smaller extra
// (a registry cell per call, about 1.6x) passes.
test('ratio: a deduped operator hit through the lens costs under 2x the same hit on the raw handle', async () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
  const bind = new Bind(rt)
  for (let i = 0; i < 100; i++) bind.data['r' + i] = { n: i }
  const lens: any = bind.data
  const raw = unwrap(bind.data)
  const kept = lens.sum('n')
  let hits = 0
  const hit = (d: any) => () => { for (let i = 0; i < 50000; i++) if (d.sum('n') === kept) hits++ }
  const r = ratio.interleaved(hit(raw), hit(lens))
  assert.equal(hits, 50000 * 16, 'every call was a dedup hit on the same view')
  assert.ok(r < 2, `deduped sum('n') hits through the lens / raw = ${r.toFixed(2)}x (budget 2x; about 1.45x here, 1.15x before the escape mark)`)
  kept[NODE].dispose()
  bind.destroy()
  await rt.destroy()
})
