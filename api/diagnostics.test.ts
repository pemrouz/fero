//! ── api/diagnostics.test — the [diagnostics] handle: hygiene, the oracle, honest refusals, the reap ──
// Tier-3 (real sockets): the Symbol stays off every enumeration surface; capture() feeds the model's
// replay oracle directly; compact() is size-gate-free but refuses ARMED and destroyed nodes (DESIGN-M7
// §3 — the panel's shared-defect fix: a forced member-ranged compaction on a scoped holder could drop
// the only real copy); drop() is the ungraceful-peer primitive the served() leak guard is proved with.

//! the directory is OFF in this suite regardless of how it is run: a single-file `node --test` must never
// meet a live box directory (the battery's npm script sets the same default)
process.env.FERO_RENDEZVOUS ??= 'off'

import { test } from 'node:test'
import assert from 'node:assert'
import { fero } from './index.ts'
import { diag, diagnostics } from './diagnostics.ts'
import { snapshot } from './substrate.ts'
import { JK } from '../kernel/journal.ts'
import { verifyReplay } from '../tools/debug/model.mjs'
import { ports, until } from '#utils'

test('hygiene: the handle is Symbol-keyed — absent from keys/for-in, present via diag()', async () => {
  const f = await fero('r', { listen: false })
  try {
    assert.deepEqual(Object.keys(f), ['name', 'data', 'methods', 'cluster', 'snapshot', 'destroy'], 'the typed surface, exactly')
    const seen: string[] = []
    for (const k in f) seen.push(k)
    assert.ok(!seen.some((k) => k.toLowerCase().includes('diag')), 'for-in never sees the handle')
    assert.ok(Object.getOwnPropertySymbols(f).includes(diagnostics), 'the escape hatch exists, by design')
    const d = diag(f)
    assert.ok(d, 'diag() is the sanctioned door')
    assert.equal(typeof d.capture, 'function')
    assert.equal(typeof d.drop, 'function', 'real-TCP backing ⇒ drop present')
  } finally { await f.destroy() }
})

test('capture ⇄ the replay oracle, and the atomic journal cursor with honest truncation', async () => {
  const f = await fero('r', { uuid: 'aa', journalCap: 32, listen: false })
  try {
    for (let i = 0; i < 60; i++) f.data[`k${i % 7}`] = { n: i, deep: [i, `s${i}`] }
    await until(() => (snapshot(f.data) as Record<string, { n: number }>).k3?.n === 59, 4000)
    const d = diag(f)!
    //! the capture IS the live format: the model's replay-refold must reproduce the node's end state
    const cap = { v: 1, kind: 'live', vocab: JK, seed: null, nodes: [d.capture()] }
    for (const r of verifyReplay(cap) as { ok: boolean; uuid: string; reason?: string }[])
      if (d.journal().dropped === 0) assert.ok(r.ok, `refold must match (${r.uuid}: ${r.reason ?? ''})`)
    //! one call carries {n, dropped, events} — gaps computable atomically, the clamp honest
    const j = d.journal()
    assert.ok(j.dropped > 0, 'the 32-cap ring must have overflowed')
    assert.equal(j.events.length, 32, 'read clamps to the retained window')
    assert.equal(j.events[0].t, j.n - 32, 'the window starts where retention starts')
    assert.deepEqual(d.journal(j.n).events, [], 'cursor at head ⇒ empty, never a splice')
  } finally { await f.destroy() }
})

test('compact() forces the real pass; logSize shrinks; state untouched; confirms drain; destroyed refuses', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 50, redialMs: 30 })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50, redialMs: 30 })
  const d = diag(a)!
  try {
    for (let i = 0; i < 80; i++) a.data.hot = { i } // one cell superseded 80× — pure compaction fodder
    await until(() => (snapshot(b.data) as { hot?: { i: number } }).hot?.i === 79, 5000)
    const before = d.logSize()
    assert.ok(before >= 80, `the own log holds the history (${before})`)
    //! the frontier needs the peer's digest floor — keep forcing until the pass actually collapses
    let dropped = 0
    assert.ok(await until(() => (dropped += d.compact()) > 0, 5000), 'the forced pass must collapse the prefix')
    assert.ok(d.logSize() < before, `logSize shrank (${before} → ${d.logSize()})`)
    assert.equal((snapshot(a.data) as { hot: { i: number } }).hot.i, 79, 'compaction never touches state')
    assert.deepEqual(d.confirms(), { api: 0, kernel: 0 }, 'both probe registries drained at rest')
  } finally { await a.destroy(); await b.destroy() }
  //! post-mortem honesty: reads still answer, effects refuse
  assert.equal(d.compact(), 0, 'destroyed ⇒ 0, never a throw')
  assert.equal(d.drop!('bb'), false, 'no live socket ⇒ false')
  assert.deepEqual(d.confirms(), { api: 0, kernel: 0 }, 'nothing leaked through destroy')
})

test('served() + drop(): the v2 leak guard — an ungraceful peer drop reaps its live subscription', async () => {
  const pa = await ports.free()
  const a = await fero('r', {
    uuid: 'aa', listen: `127.0.0.1:${pa}`, heartbeatMs: 50,
    watch: (_: unknown, ctx: { data: unknown }) => ctx.data, // returns a proxy → subscribable
  })
  //! redialMs 500 keeps the client's reconnect+resubscribe OUT of the assertion window (WSL2 timing)
  const c = await fero('r', { uuid: 'zz', hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50, redialMs: 500 })
  const d = diag(a)!
  try {
    const live = c.methods.watch() as { first?: unknown; close?: () => void }
    void live.first // any reactive touch opens the stream
    assert.ok(await until(() => d.served() === 1, 4000), 'the host serves the sub')
    assert.equal(d.drop!('zz'), true, 'an identified peer drops')
    assert.ok(await until(() => d.served() === 0, 2000), 'linkDown reaped the serve — no leak')
  } finally { await c.destroy(); await a.destroy() }
})

test('compact() honest refusal: an ARMED (scoped, committed-view) node answers 0 — the pin, not the pass', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = await fero('r', { uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 50, redialMs: 30, replicas: 1 })
  const b = await fero('r', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], heartbeatMs: 50, redialMs: 30, replicas: 1 })
  const d = diag(a)!
  try {
    assert.ok(await until(() => d.capture().epoch > 0, 6000), 'the view commits — scoping arms')
    for (let i = 0; i < 20; i++) a.data[`k${i}`] = i
    await until(() => d.logSize() >= 10, 4000)
    const size = d.logSize()
    assert.equal(d.compact(), 0, 'armed ⇒ the pin refuses (a forced pass could drop a sole copy)')
    assert.equal(d.logSize(), size, 'nothing moved')
  } finally { await a.destroy(); await b.destroy() }
})
