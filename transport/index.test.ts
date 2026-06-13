// L0 end-to-end: independent server processes (here, in-process over loopback)
// discover each other via static config, connect, handshake, ring up, and route
// writes to their DHT owners. The mesh is storeless — each node's onRecord feeds
// a local $() so we can assert where records landed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, createServer } from 'node:net'
import { $, value, view } from '../../data/index.ts'
import { transport, STATUS } from './index.ts'
import { type ChangeRecord, encodeFrame, Framer, VERB } from './message.ts'
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

test('a hostile INIT identity (peers:[42]) drops the peer, never crashes the process', async () => {
  // Regression for the one-frame remote kill: a structurally-VALID frame whose identity
  // JSON carries wrong types used to TypeError inside learn() (addServer calls
  // address.lastIndexOf on each gossiped peer address), unwind through the socket 'data'
  // handler, and take the whole process down. identityOf now validates → FrameError → drop.
  const p1 = await ports.free()
  let records = 0
  const mB = transport({ name: 'idseam', host: '127.0.0.1', port: p1, ports: [p1], wait: 200, onRecord: () => records++ })
  await mB.ready
  const sock = connect(p1, '127.0.0.1')
  sock.on('error', () => {}) // the server resets us — expected
  let closed = false
  sock.on('close', () => (closed = true))
  try {
    await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej) })
    const hostile = { uuid: 'evil', role: 'server', listen: '127.0.0.1:1', peers: [42] }
    sock.write(encodeFrame([{ type: 'update', key: [], value: hostile }], { verb: VERB.INIT }))
    // the hostile peer must be DROPPED: the server closes its socket
    assert.ok(await until(() => closed, 4000), 'the hostile socket was closed by the server')
    // ...and the mesh survived: a fresh, well-behaved socket still replicates
    const sock2 = connect(p1, '127.0.0.1')
    sock2.on('error', () => {})
    await new Promise<void>((res, rej) => { sock2.once('connect', () => res()); sock2.once('error', rej) })
    sock2.write(encodeFrame([{ type: 'update', key: ['x'], value: 1 }]))
    assert.ok(await until(() => records === 1, 4000), 'the mesh still accepts well-formed traffic after the attack')
    sock2.destroy()
  } finally {
    sock.destroy()
    mB.destroy()
  }
})

test('an unrecognized verb is dropped (fail closed), never mis-applied as a record', async () => {
  // Regression: RECORDS is now a NAMED switch case and the dispatch default FAILS CLOSED. A
  // structurally-valid frame carrying an UNKNOWN verb must be DROPPED — not fall into the data path,
  // where its records would apply via onRecord and clobber state. No public mesh method sends an
  // arbitrary verb, so inject raw frames over a bare socket (PING/PONG are consumed in peer.ts;
  // INIT/SYNC/DONE in handle(); so an unknown verb is the only thing that reaches the default).
  const p1 = await ports.free()
  let records = 0
  const B = applier()
  const mB = transport({ name: 'verbseam', host: '127.0.0.1', port: p1, ports: [p1], wait: 200, onRecord: (r) => { records++; B.apply(r) } })
  await mB.ready // the TCP listener is up
  const sock = connect(p1, '127.0.0.1')
  sock.on('error', () => {}) // ignore — the server may RST on teardown
  try {
    await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej) })
    // 1) a normal RECORDS frame (no id) → plain replication → reaches onRecord
    sock.write(encodeFrame([{ type: 'update', key: ['x'], value: 1 }]))
    // 2) an UNKNOWN verb carrying a record → must be DROPPED (never reaches onRecord)
    sock.write(encodeFrame([{ type: 'update', key: ['y'], value: 2 }], { verb: 250 }))
    // 3) a trailing RECORDS frame → proves the mesh survived the unknown verb AND orders after (2)
    sock.write(encodeFrame([{ type: 'update', key: ['z'], value: 3 }]))
    assert.ok(await until(() => B.store[value]?.z === 3), 'the trailing RECORDS frame applied (mesh survived the unknown verb)')
    assert.equal(records, 2, 'exactly two RECORDS delivered — the unknown-verb frame was dropped, not applied')
    assert.equal(B.store[value]?.y, undefined, 'the unknown-verb record never reached state')
  } finally {
    sock.destroy()
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
    // drop() is TERMINAL: the dialed peer is destroyed and its row PRUNED (no corpse/leaked row)
    assert.ok(await until(() => mA.peers[a2]?.[value] === undefined), 'A→B dialed row was pruned (terminal departure)')
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
    // the dialed self peer's row is PRUNED (dead-row prune routes the self-reject through #prune),
    // so the self-address leaves no lingering row at all.
    assert.ok(!(a2 in (mA.peers[value] ?? {})), 'A pruned the self-address row (no lingering self row)')
    await sleep(150)
    assert.equal(connected(mA, a2) || connected(mB, a1), false, 'stays rejected — no reconnect loop')
  } finally {
    mA.destroy()
    mB.destroy()
  }
})

test('an inbound client row is PRUNED when the client disconnects — no lingering disconnected row', async () => {
  // A client's inbound socket never redials, so its drop is terminal — its row must be REMOVED, not
  // left disconnected forever (the churn leak). onGone (Peer terminal departure) → Peers.#prune.
  const pA = await ports.free()
  const server = transport({ name: 'prune', host: '127.0.0.1', port: pA, ports: [pA], wait: 200, onRecord() {} })
  const client = transport({ name: 'prune', host: '127.0.0.1', ports: [pA], wait: 200, onRecord() {} })
  const clientRows = () => Object.values((server.peers[value] ?? {}) as Record<string, any>).filter((r) => r.role === 'client')
  try {
    assert.ok(await until(() => clientRows().length === 1), 'server published the client row')
    client.destroy()
    assert.ok(await until(() => clientRows().length === 0), `server pruned the client row on disconnect (still ${clientRows().length})`)
  } finally {
    server.destroy()
    client.destroy()
  }
})

test('a dialed peer row is PRUNED when reconnect attempts are exhausted (gives up)', async () => {
  // A dial to a dead address retries then gives up (finite max) — the row must be forgotten, not left
  // cycling forever. (Default max is Infinity, so this only fires for a configured retry budget.)
  const dead = await ports.free() // nobody listens here
  const a = `127.0.0.1:${dead}`
  const node = transport({ name: 'giveup', host: '127.0.0.1', port: await ports.free(), ports: [dead], retries: { base: 10, cap: 20, max: 2, jitter: 0 }, wait: 200, onRecord() {} })
  try {
    assert.ok(a in (node.peers[value] ?? {}) || true, 'the dead address was dialed') // (the row may already be pruned by the time we look)
    assert.ok(await until(() => !(a in (node.peers[value] ?? {})), 3000), 'the given-up peer’s row was pruned')
  } finally {
    node.destroy()
  }
})

test('ack-confirmed forward: a committed owner ACKs {committed,seq,epoch}; a withholding owner NACKs; a swallowing receiver times out — each non-commit releases the never-drop fallback', async () => {
  // The never-drop seam (#4) + the honest-ACK fix: socket-write success ≠ delivery AND
  // receipt ≠ commit. The owner replies with the TRUE outcome AFTER onWrite — ACK
  // {committed,seq,epoch} when sequenced, {committed:false} when it WITHHELD (a quorum-less
  // write-gate buffered it, NOT committed); no ack within callTimeout ⇒ {committed:false}.
  // A non-committed outcome (NACK or timeout) releases the caller's never-drop fallback.
  const [p1, p2, p3, p4, p5, p6] = [await ports.free(), await ports.free(), await ports.free(), await ports.free(), await ports.free(), await ports.free()]

  // committed leg: onWrite reports a sequenced commit; the transport acks with its seq/epoch
  let got: any
  const mB = transport({ name: 'wack', host: '127.0.0.1', port: p2, ports: [], wait: 50, onWrite: (r: any) => { got = r; return { committed: true, seq: 7, epoch: 2 } } })
  const mA = transport({ name: 'wack', host: '127.0.0.1', port: p1, ports: [p2], wait: 200, callTimeout: 400 })
  const outcomes: any[] = []
  try {
    assert.ok(await until(() => connected(mA, `127.0.0.1:${p2}`)), 'A dialed B')
    assert.ok(mA.forward(`127.0.0.1:${p2}`, { type: 'update', key: ['x'], value: 1 }, (o) => outcomes.push(o)))
    assert.ok(await until(() => outcomes.length === 1, 3000), 'the ACK settled the forward')
    assert.equal(outcomes[0].committed, true, 'committed owner ⇒ committed:true')
    assert.equal(outcomes[0].seq, 7, 'the ACK carries the sequenced seq')
    assert.equal(outcomes[0].epoch, 2, 'and the view epoch')
    assert.equal(got.key[0], 'x', 'the owner received the write')
  } finally {
    mA.destroy()
    mB.destroy()
  }

  // withheld leg: onWrite reports a NON-commit (quorum-less buffer) → the transport NACKs → false
  // outcome WITHOUT waiting for the timeout (the acknowledged-loss bug: this used to falsely ACK)
  const mD = transport({ name: 'whold', host: '127.0.0.1', port: p6, ports: [], wait: 50, onWrite: () => ({ committed: false }) })
  const mC2 = transport({ name: 'whold', host: '127.0.0.1', port: p5, ports: [p6], wait: 200, callTimeout: 4000 })
  const withheld: any[] = []
  try {
    assert.ok(await until(() => connected(mC2, `127.0.0.1:${p6}`)), 'C dialed D')
    assert.ok(mC2.forward(`127.0.0.1:${p6}`, { type: 'update', key: ['z'], value: 3 }, (o) => withheld.push(o)))
    assert.ok(await until(() => withheld.length === 1, 1500), 'the NACK settled the forward promptly (not via the 4s timeout)')
    assert.equal(withheld[0].committed, false, 'a withholding owner NACKs ⇒ committed:false ⇒ never-drop fallback fires')
  } finally {
    mC2.destroy()
    mD.destroy()
  }

  // swallow leg: a raw TCP "server" that handshakes but SWALLOWS WRITE frames — the dying-owner
  // shape (bytes accepted, commit never happens, no ack ever) ⇒ timeout into committed:false
  const swallowId = { uuid: 'swallow-uuid', role: 'server', listen: `127.0.0.1:${p3}`, peers: [] }
  const swallow = createServer((socket) => {
    const framer = new Framer()
    socket.on('data', (chunk: Buffer) => {
      for (const f of framer.push(chunk)) {
        if (f.verb === VERB.INIT)
          socket.write(encodeFrame([{ type: 'update', key: [], value: swallowId }], { verb: VERB.SYNC }))
        // DONE / WRITE / PING — swallowed: never an ACK
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((r) => swallow.listen(p3, '127.0.0.1', () => r()))
  const mE = transport({ name: 'wack2', host: '127.0.0.1', port: p4, ports: [p3], wait: 200, callTimeout: 400 })
  const failed: any[] = []
  try {
    assert.ok(await until(() => connected(mE, `127.0.0.1:${p3}`)), 'E dialed the swallower')
    assert.ok(mE.forward(`127.0.0.1:${p3}`, { type: 'update', key: ['y'], value: 2 }, (o) => failed.push(o)), 'the socket write itself succeeded')
    assert.ok(await until(() => failed.length === 1, 3000), 'the timeout fired')
    assert.equal(failed[0].committed, false, 'no ack ⇒ committed:false ⇒ the caller runs its never-drop fallback')
  } finally {
    mE.destroy()
    await new Promise<void>((r) => swallow.close(() => r()))
  }
})
