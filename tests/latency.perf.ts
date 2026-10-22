//! ── tests/latency.perf — two round trips on real loopback sockets (V4-NN, the Nagle stall) ──────────
// Two calls that each send two small frames in a row on one link: a client's method call that writes a row
// (the server answers with the record and the RESULT) and a server's update forwarded to the row's owner (the
// owner answers with the record and the WACK). With Nagle's algorithm on, the OS held the second frame back
// until the first was acknowledged, and the other side held that acknowledgement for about 40 ms (delayed ACK):
// each call took about 43-44 ms on loopback. shell/runtime.ts #wire turns Nagle off on every link socket, and
// each call now takes about 0.4-1 ms here.
//! The bound is 10 ms on the MEDIAN of many calls. It holds both ways on this noisy WSL2 box: a slow run here is
// 2-3x the usual (about 3 ms), and Linux never acknowledges a lone segment later than its 40 ms delayed-ACK floor
// (TCP_DELACK_MIN), so a stall cannot shrink below the bound. Never widen it: a median over 10 ms means a frame
// waits for something again. What each pin catches, measured (medians of 60 calls, two runs each):
//   method call that writes   43.71 / 43.57 ms with Nagle on   0.40 / 0.43 ms with it off
//   forwarded update          43.66 / 43.22 ms                 0.79 / 0.59 ms
// With the setNoDelay line removed both go red (44.17 and 43.65 ms on the run that checked it).

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { bench, ports, until } from '#utils'
import type { Context } from '../api/methods.ts'

const BOUND_MS = 10
const base = { rendezvous: false, signals: false } as const

test('absolute: a client\'s method call that writes one row — median of 60 calls on real loopback sockets under 10 ms (about 43 ms with Nagle on)', async () => {
  const port = await ports.free()
  const s = await fero(`lat-m-${process.pid}`, {
    ...base, listen: `127.0.0.1:${port}`,
    methods: { put(i: number, ctx: Context) { (ctx.data as Record<string, unknown>)['p' + i] = { i }; return i } },
  })
  const k = await fero(`lat-m-${process.pid}`, { ...base, hosts: [`127.0.0.1:${port}`] })
  try {
    const put = k.methods.put as (i: number) => Promise<number>
    for (let i = 0; i < 5; i++) await put(-1 - i) // warm: the link, the handler, the JIT
    const xs: number[] = []
    for (let i = 0; i < 60; i++) {
      const t = performance.now()
      assert.equal(await put(i), i)
      xs.push(performance.now() - t)
    }
    const rows = snapshot(s.data) as Record<string, { i: number }>
    for (let i = 0; i < 60; i++) assert.deepEqual(rows['p' + i], { i }, `the call wrote p${i} on the server`)
    const ms = bench.median(xs)
    console.log(`  method call that writes one row: median ${ms.toFixed(2)} ms over 60 calls (bound ${BOUND_MS} ms)`)
    assert.ok(ms < BOUND_MS, `a writing method call took a median ${ms.toFixed(2)} ms (bound ${BOUND_MS} ms; about 43 ms is Nagle's stall)`)
  } finally {
    await k.destroy()
    await s.destroy()
  }
})

test('absolute: a server\'s update forwarded to the row\'s owner — median of 40 forwarded calls on real loopback sockets under 10 ms (about 43 ms with Nagle on)', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const name = `lat-f-${process.pid}`
  const a = await fero(name, { ...base, listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`] })
  const b = await fero(name, { ...base, listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`] })
  try {
    const members = (f: typeof a) => Object.keys((snapshot(f.cluster) as { members: Record<string, string> }).members ?? {}).length
    assert.ok(await until(() => members(a) === 2 && members(b) === 2, 10_000), 'the two servers formed one view')
    const me = (snapshot(a.cluster) as { me: { origin: string } }).me.origin
    const update = a.methods.update as (r: unknown, o: unknown) => Promise<{ origin: string }>
    //! the ring splits the keys between the two owners: keep calling until 40 calls went to b, the owner that is
    // not a (each call's answer names the origin that stamped it); a's own rows are timed apart, as a control
    const fwd: number[] = [], own: number[] = []
    let warm = 0
    for (let i = 0; fwd.length < 40 && i < 1000; i++) {
      const t = performance.now()
      const r = await update({ key: `f${i}`, value: { n: i } }, { confirm: 'committed', timeout: 20_000 })
      const ms = performance.now() - t
      if (r.origin === me) own.push(ms)
      else if (warm < 3) warm++ // the first forwarded calls warm the path
      else fwd.push(ms)
    }
    assert.equal(fwd.length, 40, 'forty updates went to the other owner')
    const ms = bench.median(fwd)
    console.log(`  forwarded update: median ${ms.toFixed(2)} ms over ${fwd.length} calls; a's own rows ${bench.median(own).toFixed(2)} ms over ${own.length} (bound ${BOUND_MS} ms)`)
    assert.ok(ms < BOUND_MS, `a forwarded update took a median ${ms.toFixed(2)} ms (bound ${BOUND_MS} ms; about 43 ms is Nagle's stall)`)
  } finally {
    await a.destroy()
    await b.destroy()
  }
})
