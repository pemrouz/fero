// resource/observe.ts — the L4 PUSH channel. Three layers of coverage:
//   • makeObserve() unit: the controller in isolation — refcounted attach/detach (clamped,
//     idempotent), the bounded drop-oldest ring buffer, and that every emit-site kind maps
//     through to a flat ProvRecord on the streamed proxy.
//   • a REAL observe server: the provenance kinds that ARE deterministic — `local` (an owned
//     write), `won` (a replicated record applied on a peer), `forwarded` (a scoped write routed
//     to its owner), and the `view`/`writable` membership transitions — plus the observing()
//     gate arming/disarming.
//   • the LEAK GUARD: a wire subscriber dropped UNGRACEFULLY must reap AND disarm the gate
//     (observing() ⇒ false), single- and multi-observer.
//
// NB on `lost`/`dropped`: a live cluster makes them rare by construction (the write-gate stops
// a minority diverging, so there is no conflicting write to lose; single-sequencer ordering
// stops re-delivery). They're covered at the controller level here; a deterministic split-brain
// loser is a Slice-5 war-game scenario (see tools/observe/IDEAS.md / plan §3.5).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { value } from '../../data/index.ts'
import { makeObserve } from './observe.ts'
import { fero, diagnostics } from './index.ts'
import { cluster } from '../tests/chaos/harness.ts'
import { ports, sleep, until } from '#utils'

//! a fake ChangeRecord — enough provenance for the controller to flatten.
const rec = (over: Record<string, unknown> = {}) => ({ type: 'update', key: ['k'], origin: 'O', seq: 1, epoch: 1, ...over }) as any

// ── makeObserve() unit ─────────────────────────────────────────────────────────

test('makeObserve(): refcount attach/detach — clamps at 0, TRUE only on the last detach', () => {
  const o = makeObserve()
  assert.equal(o.refCount(), 0)
  o.attach()
  o.attach()
  assert.equal(o.refCount(), 2)
  assert.equal(o.detach(), false) // 2 → 1, still armed
  assert.equal(o.detach(), true) // 1 → 0, last one out
  assert.equal(o.refCount(), 0)
  assert.equal(o.detach(), true) // idempotent: clamps at 0, still reports "empty"
  assert.equal(o.refCount(), 0)
})

test('makeObserve(): onRecord flattens provenance into the streamed proxy (kind + origin/seq/epoch/key, no value)', () => {
  const o = makeObserve()
  o.onRecord(rec({ key: ['user', '42'], origin: 'U', seq: 7, epoch: 3 }), 'won')
  const buf = (o.proxy as any)[value]
  const e = buf['0']
  assert.equal(e.kind, 'won')
  assert.equal(e.origin, 'U')
  assert.equal(e.seq, 7)
  assert.equal(e.epoch, 3)
  assert.equal(e.key, 'user.42') // dotted path
  assert.equal(e.t, 1) // monotonic
  assert.equal('value' in e, false) // never the payload
})

test('makeObserve(): every emit-site kind maps through, and `at` folds into the key path', () => {
  const o = makeObserve()
  o.onRecord(rec({}), 'local')
  o.onRecord(rec({}), 'lost')
  o.onRecord(rec({}), 'forwarded')
  o.onRecord(rec({}), 'dropped')
  o.onRecord(rec({ key: ['list'], at: 'id9' }), 'won') // insert → `at` folded in
  o.onView(5, 4)
  o.onWritable(false)
  const buf = (o.proxy as any)[value]
  const kinds = Object.keys(buf)
    .sort()
    .map((k) => buf[k].kind)
  assert.deepEqual(kinds, ['local', 'lost', 'forwarded', 'dropped', 'won', 'view', 'writable'])
  assert.equal(buf['4'].key, 'list.id9')
  assert.equal(buf['5'].members, 4) // view event
  assert.equal(buf['6'].writable, false) // writable event
})

test('makeObserve(): bounded drop-oldest ring — slot reused past cap, t keeps climbing', () => {
  const o = makeObserve({ buffer: 4 })
  for (let i = 0; i < 6; i++) o.onRecord(rec({ seq: i }), 'won')
  const buf = (o.proxy as any)[value]
  assert.equal(Object.keys(buf).length, 4) // only `cap` slots ever exist
  // slots 0 and 1 were overwritten by events 5 and 6 (t = 5, 6); 2 and 3 still hold t = 3, 4
  assert.equal(buf['0'].t, 5)
  assert.equal(buf['1'].t, 6)
  assert.equal(buf['2'].t, 3)
  assert.equal(buf['3'].t, 4)
})

// ── real observe server: deterministic provenance kinds + the gate ──────────────

test('observe server: an owned write surfaces a `local` event; observing() arms then disarms', async () => {
  const r: any = await fero('obs-local', { port: await ports.free(), wait: 10, observe: true })
  assert.equal(r[diagnostics].observing(), false)
  const got: any[] = []
  const close = r[diagnostics].observe((d: any) => {
    const v = d.value
    if (v && typeof v === 'object' && 'kind' in v) got.push(v)
    else if (v) for (const s in v) got.push(v[s])
  })
  assert.equal(r[diagnostics].observing(), true)
  r.data.user1 = { name: 'a' }
  r.data.user2 = { name: 'b' }
  await sleep(20)
  const locals = got.filter((e) => e.kind === 'local')
  assert.ok(locals.length >= 2, `two owned writes ⇒ two local events (got ${JSON.stringify(got.map((e) => e.kind))})`)
  assert.equal(locals[0].origin, r.cluster.uuid) // stamped under our provenance
  assert.deepEqual(locals.map((e) => e.key).sort(), ['user1', 'user2'])
  close()
  assert.equal(r[diagnostics].observing(), false)
  const n = got.length
  r.data.user3 = { name: 'c' } // disarmed ⇒ no further events
  await sleep(20)
  assert.equal(got.length, n)
  r.destroy()
})

// collect provenance kinds across EVERY node of a cluster via the in-process seam
const watchCluster = (c: any) => {
  const got: any[] = []
  const closers = c.all().map((n: any) =>
    n[diagnostics].observe((d: any) => {
      const v = d.value
      if (v && typeof v === 'object' && 'kind' in v) got.push({ ...v, by: n.cluster.me })
      else if (v) for (const s in v) got.push({ ...v[s], by: n.cluster.me })
    }),
  )
  return { got, close: () => closers.forEach((f: any) => f()) }
}

test('observe cluster: a replicated record surfaces `won` on the peers that applied it', async () => {
  const c = await cluster({ n: 3, wait: 250, extra: { observe: true } }) // full replication
  await c.formed()
  const w = watchCluster(c)
  const k = 'k1'
  const owner = c.node(c.owner(k)!)
  owner.data[k] = { v: 1 }
  await until(() => w.got.filter((e) => e.kind === 'won').length >= 2, 4000) // the 2 non-owner replicas
  const won = w.got.filter((e) => e.kind === 'won' && e.key === k)
  assert.ok(won.length >= 2, `full-rep write ⇒ won on the other replicas (got ${won.length})`)
  assert.ok(
    w.got.some((e) => e.kind === 'local' && e.key === k && e.by === owner.cluster.me),
    'the owner reports it as local',
  )
  w.close()
  c.destroy()
})

test('observe cluster: a scoped write to a non-owner surfaces `forwarded` on the owner', async () => {
  const c = await cluster({ n: 4, replicas: 2, antiEntropy: 300, wait: 300, extra: { observe: true } })
  await c.formed()
  const w = watchCluster(c)
  // find a key whose owner is NOT some chosen writer, and write it there → it forwards
  const k = 'fwd-key'
  const ownerAddr = c.owner(k)!
  const writer = c.all().find((n: any) => n.cluster.me !== ownerAddr)!
  writer.data[k] = { v: 1 }
  await until(() => w.got.some((e) => e.kind === 'forwarded' && e.key === k), 5000)
  const fwd = w.got.filter((e) => e.kind === 'forwarded' && e.key === k)
  assert.ok(fwd.length >= 1, 'a write to a non-owner is committed as forwarded on the owner')
  assert.equal(fwd[0].by, ownerAddr, 'the OWNER is the one that reports the forward (it is the sequencer)')
  w.close()
  c.destroy()
})

test('observe cluster: a membership change surfaces `view`/`writable` transitions', async () => {
  const c = await cluster({
    n: 3,
    wait: 300,
    heartbeat: { interval: 60, misses: 2 },
    evictAfter: 200,
    extra: { observe: true },
  })
  await c.formed()
  const w = watchCluster(c)
  c.kill(c.all()[2]) // drop a node → the survivors re-form a new view (epoch bumps)
  await until(() => w.got.some((e) => e.kind === 'view'), 6000)
  assert.ok(
    w.got.some((e) => e.kind === 'view'),
    'a view commit surfaces a `view` event with the new member count',
  )
  w.close()
  c.destroy()
})

test('observe: dedup-drops stay OFF the stream by default — verbose gates them (steady-state guarantee)', async () => {
  // The dedup high-water is a defensive guard: anti-entropy is DIGEST-driven (recordsSince
  // ships only what a peer lacks), so re-delivery — and thus a dedup-drop — essentially never
  // happens in normal operation, even under kill/restart churn (measured: 0 drops). The plan
  // keeps the (rare-but-highest-frequency-IF-they-happen) drops behind `verbose`; this asserts
  // the steady-state guarantee — with verbose OFF (the default) NO `dropped` ever surfaces,
  // even while the cluster replicates + runs anti-entropy. (The `dropped` KIND itself is covered
  // by the controller unit test above; a deterministic positive needs a forced re-delivery race,
  // which is a Slice-5 war-game concern.)
  const c = await cluster({ n: 4, wait: 250, antiEntropy: 120, extra: { observe: true } }) // verbose OFF
  await c.formed()
  const w = watchCluster(c)
  await c.place(['a', 'b', 'c', 'd', 'e', 'f'])
  await sleep(300)
  w.close()
  assert.equal(w.got.filter((e) => e.kind === 'dropped').length, 0, 'verbose off ⇒ never any `dropped` events')
  assert.ok(w.got.length > 0, 'the cluster did produce other provenance (sanity)')
  c.destroy()
})

// ── the leak guard: ungraceful drop must reap AND disarm ────────────────────────

//! the address a connected read-only client is known by on the server (role 'client'); used to drop it abruptly.
const clientAddrOn = (server: any): string | undefined => {
  const peers = (server.cluster.peers as any)[value] ?? {}
  return Object.keys(peers).find((a) => peers[a]?.role === 'client')
}

test('leak guard: a wire __observe subscriber dropped UNGRACEFULLY reaps the sub AND disarms observing()', async () => {
  const server: any = await fero('obs-leak', { port: await ports.free(), wait: 10, observe: true })
  const port = +server.cluster.me.split(':')[1]
  const client: any = await fero('obs-leak', { ports: [port], wait: 10 })
  // subscribe to the wire __observe stream (a live ViewProxy subscription; the held [] keeps the sink alive)
  client.methods.__observe().connect([], () => {})
  await until(() => server[diagnostics].servedSubscriptions() >= 1, 3000)
  assert.equal(server[diagnostics].observing(), true, 'armed while a subscriber is attached')
  // ungraceful drop: the server abruptly closes the client's socket — NO UNSUBSCRIBE (the real network-drop shape)
  const addr = clientAddrOn(server)
  assert.ok(addr, 'the client is a connected peer on the server')
  server[diagnostics].drop(addr!)
  assert.ok(await until(() => server[diagnostics].servedSubscriptions() === 0, 4000), 'the served sub is reaped via reapPeer')
  assert.ok(await until(() => server[diagnostics].observing() === false, 4000), 'and the gate disarms (THE leak-fix assert)')
  client.destroy()
  server.destroy()
})

// ── review fixes: fractional buffer, idempotent/stale closers, __observe shadowing ──

test('makeObserve(): a fractional 0<buffer<1 falls back to the default cap (no NaN slot)', () => {
  const o = makeObserve({ buffer: 0.5 }) // would floor to 0 → `count % 0` = NaN without the guard
  o.onRecord(rec({ seq: 1 }), 'won')
  o.onRecord(rec({ seq: 2 }), 'won')
  const buf = (o.proxy as any)[value]
  assert.equal('NaN' in buf, false, 'no NaN slot')
  assert.equal(buf['0'].t, 1)
  assert.equal(buf['1'].t, 2)
})

test('closer idempotency: double-closing one in-process observer cannot disarm a live one', async () => {
  const r: any = await fero('obs-idem', { port: await ports.free(), wait: 10, observe: true })
  const closeA = r[diagnostics].observe(() => {})
  const closeB = r[diagnostics].observe(() => {})
  closeA()
  closeA() // the double-close must NOT steal B's refcount
  assert.equal(r[diagnostics].observing(), true, 'B is still armed after A double-closed')
  closeB()
  assert.equal(r[diagnostics].observing(), false)
  r.destroy()
})

test('closer staleness: a closer from a PREVIOUS gate instance cannot disarm the current one', async () => {
  const r: any = await fero('obs-stale', { port: await ports.free(), wait: 10, observe: true })
  const closeA = r[diagnostics].observe(() => {})
  closeA() // gate disarmed, instance discarded
  assert.equal(r[diagnostics].observing(), false)
  const closeB = r[diagnostics].observe(() => {}) // a NEW makeObserve instance re-arms
  assert.equal(r[diagnostics].observing(), true)
  closeA() // stale closer — idempotent AND instance-guarded
  assert.equal(r[diagnostics].observing(), true, 'the stale closer cannot null the new gate')
  closeB()
  assert.equal(r[diagnostics].observing(), false)
  r.destroy()
})

test('a closed in-process observer stops receiving even while ANOTHER keeps the gate armed', async () => {
  const r: any = await fero('obs-detach', { port: await ports.free(), wait: 10, observe: true })
  const gotA: any[] = []
  const closeA = r[diagnostics].observe((d: any) => gotA.push(d))
  const closeB = r[diagnostics].observe(() => {})
  closeA()
  const n = gotA.length
  r.data.x = 1 // the gate is still armed by B — A must not hear this
  await sleep(20)
  assert.equal(gotA.length, n, 'A received nothing after its close')
  closeB()
  r.destroy()
})

test('__observe does not shadow a user-defined method of that name when observe is OFF', async () => {
  const server: any = await fero('obs-shadow', {
    port: await ports.free(),
    wait: 10,
    // observe NOT configured — the name must fall through to normal dispatch
    __observe: (_: unknown, c: any) => c.data.things,
  })
  server.data.things = { a: 1 }
  const port = +server.cluster.me.split(':')[1]
  const client: any = await fero('obs-shadow', { ports: [port], wait: 10 })
  const events: any[] = []
  client.methods.__observe().connect(events) // SUBSCRIBE path — the one the built-in used to swallow
  assert.ok(await until(() => events.length >= 1, 3000), 'the user-defined __observe streamed its ViewProxy')
  client.destroy()
  server.destroy()
})

test('leak guard: multi-observer — dropping ONE keeps the gate armed; the last drop disarms', async () => {
  const server: any = await fero('obs-multi', { port: await ports.free(), wait: 10, observe: true })
  const port = +server.cluster.me.split(':')[1]
  const a: any = await fero('obs-multi', { ports: [port], wait: 10 })
  const b: any = await fero('obs-multi', { ports: [port], wait: 10 })
  a.methods.__observe().connect([], () => {})
  b.methods.__observe().connect([], () => {})
  await until(() => server[diagnostics].servedSubscriptions() >= 2, 3000)
  assert.equal(server[diagnostics].observing(), true)
  a.destroy() // one observer gone
  assert.ok(await until(() => server[diagnostics].servedSubscriptions() === 1, 4000))
  assert.equal(server[diagnostics].observing(), true, 'still armed — b is watching')
  b.destroy() // last observer gone
  assert.ok(await until(() => server[diagnostics].observing() === false, 4000), 'now disarmed')
  server.destroy()
})
