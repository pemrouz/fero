// L0 end-to-end: independent server processes (here, in-process over loopback)
// discover each other via static config, connect, handshake, ring up, and route
// writes to their DHT owners. The mesh is storeless — each node's onRecord feeds
// a local $() so we can assert where records landed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { $, value, view } from '../../data/index.ts'
import { transport, STATUS } from './index.ts'
import { type ChangeRecord } from './message.ts'
import { ports, until, connected, apply, sleep } from '#utils'

// A storeless mesh needs somewhere to land records so the test can assert where
// they went: a $() plus an apply bound to its res.
const applier = () => {
  const store = $({})
  const res = (store as any)[view].res
  return { store, apply: (record: ChangeRecord) => apply(res, record) }
}

test('two servers discover, connect, and route writes to their owners', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = applier()
  const B = applier()

  const mA = transport({ name: 't', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord: A.apply })
  const mB = transport({ name: 't', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord: B.apply })

  // both dial each other → both see the other connected
  assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B should connect')

  // The ring is driven by a committed view (Milestone V), not raw connections —
  // L0 used standalone installs it directly (L2's ViewManager does this in a real
  // cluster). Both nodes adopt the same view → identical rings.
  mA.installView([a1, a2])
  mB.installView([a1, a2])

  // rings agree on membership (same owner for any key on both nodes)
  assert.equal(mA.owner('probe'), mB.owner('probe'))

  const N = 30
  for (let i = 0; i < N; i++) mA.send({ type: 'update', key: ['key' + i], value: { n: i } })

  // every record lands somewhere (owner === A delivers locally, else over TCP)
  assert.ok(
    await until(() => Object.keys(A.store[value]).length + Object.keys(B.store[value]).length === N),
    `A=${Object.keys(A.store[value]).length} B=${Object.keys(B.store[value]).length}`,
  )

  // and each lands on EXACTLY its DHT owner
  let onA = 0
  let onB = 0
  for (let i = 0; i < N; i++) {
    const k = 'key' + i
    const owner = mA.owner(k)
    if (owner === mA.me) {
      assert.ok(k in A.store[value], `${k} should be on A (owner ${owner})`)
      assert.ok(!(k in B.store[value]), `${k} should NOT be on B`)
      onA++
    } else {
      assert.ok(k in B.store[value], `${k} should be on B (owner ${owner})`)
      assert.ok(!(k in A.store[value]), `${k} should NOT be on A`)
      onB++
    }
  }
  // both owners actually exercised (sanity — not everything on one node)
  assert.ok(onA > 0 && onB > 0, `distribution onA=${onA} onB=${onB}`)

  mA.destroy()
  mB.destroy()
})

test('membership gossips: a third node that only knows A learns B', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = applier()
  const B = applier()
  const C = applier()

  // A and B know each other; C is told ONLY about A — it must learn B via gossip.
  const mA = transport({ name: 't', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord: A.apply })
  const mB = transport({ name: 't', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord: B.apply })
  assert.ok(await until(() => connected(mA, a2)), 'A↔B first')

  const mC = transport({ name: 't', host: '127.0.0.1', port: p3, ports: [p1], wait: 200, onRecord: C.apply })

  // C learns B from A's handshake gossip and dials it
  assert.ok(await until(() => connected(mC, a1) && connected(mC, a2)), `C connected: A=${connected(mC, a1)} B=${connected(mC, a2)}`)

  mA.destroy()
  mB.destroy()
  mC.destroy()
})

test('view-change frames route to their own hook, never to onRecord (Milestone V seam)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  let prepared: { value: unknown; address: string } | undefined
  let dataRecords = 0
  let aHandshook = false
  const mA = transport({ name: 'vseam', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord: () => {}, onConnect: (addr) => { if (addr === a2) aHandshook = true } })
  const mB = transport({
    name: 'vseam',
    host: '127.0.0.1',
    port: p2,
    ports: [p1, p2],
    wait: 200,
    onRecord: () => {
      dataRecords++
    },
    onViewPrepare: (value, address) => {
      prepared = { value, address }
    },
  })
  try {
    assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B connect')
    // Wait for A's handshake to B to COMPLETE (onConnect fires after A sends DONE; connected() only
    // means the TCP socket is up) so B has re-keyed its inbound peer before the view frame arrives.
    assert.ok(await until(() => aHandshook), 'A finished its handshake to B (DONE sent)')

    const payload = { epoch: 2, members: [a1, a2], proposer: a1 }
    assert.ok(mA.viewPrepare(a2, payload), 'viewPrepare reaches the connected peer')

    assert.ok(await until(() => prepared !== undefined), 'onViewPrepare fires on B')
    assert.deepEqual(prepared!.value, payload, 'the view payload arrives intact')
    // The inbound peer is re-keyed to A's LISTEN address on handshake DONE (Peers.identify),
    // and DONE precedes this post-handshake view frame on the shared socket, so a frame arriving
    // over it is tagged with A's dialable address — the sender is identifiable from peer.address.
    assert.equal(prepared!.address, a1, 'tagged with the sender’s listen address (re-keyed inbound peer)')
    assert.equal(dataRecords, 0, 'the view frame never reached onRecord (the data path)')
  } finally {
    mA.destroy()
    mB.destroy()
  }
})

test('a peer drop fires onPeerGone (the subscription-reap signal) for the SAME address a sub was keyed under, not onUnsubscribe', async () => {
  // The L2 subscription-hygiene fix relies on onPeerGone firing on a socket close (which never
  // delivers an UNSUBSCRIBE frame) — and firing for the SAME address onSubscribe saw, so a
  // reverse-index reap finds the sub. The inbound server socket is re-keyed to its listen address
  // on handshake DONE, so both onSubscribe and the reap key under that stable address (a2 below).
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const subs: string[] = []
  const unsubbed: string[] = []
  const gone: string[] = []
  const mA = transport({
    name: 'pg',
    host: '127.0.0.1',
    port: p1,
    ports: [p1, p2],
    wait: 200,
    onRecord() {},
    onSubscribe: (id, _m, _a, address) => subs.push(address), // address = the re-keyed inbound peer (mB's listen addr)
    onUnsubscribe: (_id, address) => unsubbed.push(address),
    onPeerGone: (address) => gone.push(address),
  })
  let bHandshook = false
  const mB = transport({ name: 'pg', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord() {}, onConnect: (addr) => { if (addr === a1) bHandshook = true } })
  try {
    assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B connected')
    // Wait for B's handshake to A to COMPLETE (onConnect fires after B sends DONE) so A has re-keyed
    // its inbound peer to mB's listen address BEFORE the SUBSCRIBE — onSubscribe then sees a2, the
    // same address onPeerGone will fire on drop (the reap-key alignment this test pins).
    assert.ok(await until(() => bHandshook), 'B finished its handshake to A (DONE sent)')
    // mB opens a subscription to mA — so a leaked sub WOULD matter.
    mB.subscribe('read', undefined, () => {}, a1)
    assert.ok(await until(() => subs.length === 1), 'mA served the subscription')
    const subAddr = subs[0] // the address mA keyed the sub under — the re-keyed inbound peer
    assert.equal(subAddr, a2, 'the sub is keyed under mB’s listen address (re-keyed inbound peer), not an ephemeral port')

    // mB drops ungracefully (transport destroy = socket close, NO UNSUBSCRIBE frame).
    mB.destroy()

    assert.ok(await until(() => gone.includes(subAddr)), `onPeerGone fired for the sub's address (${subAddr}); gone=${JSON.stringify(gone)}`)
    assert.equal(unsubbed.length, 0, 'onUnsubscribe did NOT fire — the drop was ungraceful (no UNSUBSCRIBE frame)')
  } finally {
    mA.destroy()
  }
})

test('a one-directional drop of the DIALED socket does NOT reap subs served over the still-alive inbound shadow', async () => {
  // A server pair holds two sockets: A→B dialed + B→A inbound shadow. A SERVES B's subscription over
  // the inbound shadow (keyed by B's listen address a2). Dropping ONLY A's dialed socket to B must NOT
  // fire onPeerGone(a2): the dialed peer carries no served subs, and post-re-key its listen address
  // COLLIDES with the shadow's sub key — firing would FALSE-reap a still-live subscription. Only the
  // shadow's own drop reaps.
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const gone: string[] = []
  let bHandshook = false
  const mA = transport({ name: 'odrop', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord() {}, onSubscribe: () => {}, onPeerGone: (address) => gone.push(address) })
  const mB = transport({ name: 'odrop', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord() {}, onConnect: (addr) => { if (addr === a1) bHandshook = true } })
  try {
    assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B connected')
    assert.ok(await until(() => bHandshook), 'B handshook to A (A re-keyed the inbound shadow to a2)')
    mB.subscribe('read', undefined, () => {}, a1) // served over A's inbound shadow, keyed a2
    // drop ONLY A's dialed socket to B (peer() prefers the dialed peer); A's inbound shadow stays alive
    assert.ok(mA.drop(a2), 'dropped A→B dialed socket')
    assert.ok(await until(() => mA.peers[a2]?.status?.[value] === STATUS.disconnected), 'A→B dialed row went disconnected')
    await sleep(40) // give any (wrongly) deferred onPeerGone a chance to fire
    assert.equal(gone.includes(a2), false, `a dialed-only drop must NOT reap the shadow's live subs (gone=${JSON.stringify(gone)})`)
  } finally {
    mA.destroy()
    mB.destroy()
  }
})

test('an inbound-only server link (no dial back) still serves deltas via the shadow send-fallback', async () => {
  // After A loses its DIALED socket to B but keeps B's inbound shadow, A must still push a served delta
  // to B over that shadow — peer() falls back to #shadows when #conns has no dialed peer. Without the
  // fallback the shadow is send-invisible and the delta is silently dropped (the regression this pins).
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  let subId = -1
  let bHandshook = false
  const got: ChangeRecord[] = []
  const mA = transport({ name: 'inonly', host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, onRecord() {}, onSubscribe: (id) => { subId = id } })
  const mB = transport({ name: 'inonly', host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200, onRecord() {}, onConnect: (addr) => { if (addr === a1) bHandshook = true } })
  try {
    assert.ok(await until(() => connected(mA, a2) && connected(mB, a1)), 'A↔B connected')
    assert.ok(await until(() => bHandshook), 'B handshook to A')
    mB.subscribe('read', undefined, (rec) => got.push(rec), a1)
    assert.ok(await until(() => subId >= 0), 'A served B’s subscription (over the inbound shadow)')
    // sever A's DIALED link to B (and block redial) — A keeps ONLY B's inbound shadow
    mA.isolate(a2)
    assert.ok(await until(() => mA.peers[a2]?.status?.[value] === STATUS.disconnected), 'A→B dialed link severed')
    mA.deltaTo(a2, subId, { type: 'update', key: ['x'], value: 7 })
    assert.ok(
      await until(() => got.some((r) => r.key?.[0] === 'x' && (r.value as number) === 7)),
      `B received the served delta over the shadow fallback (got=${got.length})`,
    )
  } finally {
    mA.destroy()
    mB.destroy()
  }
})

test('a peer presenting our OWN uuid is rejected — no self-loop (alternate-address self / uuid collision)', async () => {
  // add()'s self-guard compares host:port STRINGS, so a self reached via a DIFFERENT address string
  // (multi-NIC, localhost vs 127.0.0.1) slips through; the handshake reveals the peer's uuid === ours
  // and we reject it. Two nodes sharing a uuid deterministically drive the same code path: each
  // refuses the other and remembers the address, so no mesh forms and no reconnect loop runs.
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const mA = transport({ name: 'dup', host: '127.0.0.1', port: p1, ports: [p1, p2], uuid: 'shared-uuid', wait: 200, onRecord() {} })
  const mB = transport({ name: 'dup', host: '127.0.0.1', port: p2, ports: [p1, p2], uuid: 'shared-uuid', wait: 200, onRecord() {} })
  try {
    // let both dial, handshake, and reject; then assert the steady state is NO connection — and that
    // it STAYS that way (the self alternate-address is blocked from redial, so no reconnect loop).
    await sleep(250)
    assert.equal(connected(mA, a2), false, 'A rejected B (shared uuid → self-reject)')
    assert.equal(connected(mB, a1), false, 'B rejected A (shared uuid → self-reject)')
    // the dialed self peer leaves a row that LINGERS disconnected (the dead-row prune item), never
    // connected — locks DECISIONS T's stated consequence against regression.
    assert.equal(mA.peers[a2]?.status?.[value], STATUS.disconnected, 'A’s row for the self-address lingers disconnected')
    await sleep(150)
    assert.equal(connected(mA, a2) || connected(mB, a1), false, 'stays rejected — no reconnect loop')
  } finally {
    mA.destroy()
    mB.destroy()
  }
})
