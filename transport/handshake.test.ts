// The join protocol — INIT → SYNC → DONE (handshake.ts). It carries identity as a
// change record through the same message.ts codec the data path uses, under its own
// verbs. These tests pin the ≤3-message state machine, prove a control frame
// straddled across TCP segments reassembles and routes (the data path's straddle is
// tested in message.test.ts — this confirms control frames are no different), and
// that a malformed identity payload degrades gracefully instead of crashing the
// dispatcher. (handshake.test.ts did not exist — IDEAS "Handshake" backlog.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initiate, handle, type Identity, type HandshakeHooks } from './handshake.ts'
import { encodeFrame, decodeFrame, Framer, VERB } from './message.ts'
import type { Peer } from './peer.ts'

// A mock peer that just records the frames written to it (handshake only ever calls
// peer.write); decode the last one to inspect what was sent.
const mockPeer = () => {
  const writes: Buffer[] = []
  const peer = { write: (buf: Buffer) => (writes.push(buf), true) } as unknown as Peer
  return { peer, writes, last: () => decodeFrame(writes[writes.length - 1]) }
}

// Hooks that capture what the handshake learned / completed, over a fixed identity.
const spyHooks = (over: Partial<HandshakeHooks> = {}) => {
  const learned: Identity[] = []
  const done: Identity[] = []
  const hooks: HandshakeHooks = {
    identity: () => ({ uuid: 'me', role: 'server', listen: '127.0.0.1:1', peers: ['127.0.0.1:2'] }),
    learn: (id) => learned.push(id),
    done: (_p, id) => done.push(id),
    ...over,
  }
  return { hooks, learned, done }
}

// Build a control frame carrying an arbitrary identity value under a verb.
const control = (verb: number, id: unknown) => encodeFrame([{ type: 'update', key: [], value: id }], { verb })
// …decoded to the Frame handle() expects (the receive side always sees a decoded frame).
const recv = (verb: number, id: unknown) => decodeFrame(control(verb, id))

test('initiate writes an INIT carrying our identity', () => {
  const { peer, last } = mockPeer()
  const { hooks } = spyHooks()
  initiate(peer, hooks)
  const f = last()
  assert.equal(f.verb, VERB.INIT)
  assert.deepEqual(f.records()[0].value, { uuid: 'me', role: 'server', listen: '127.0.0.1:1', peers: ['127.0.0.1:2'] })
})

test('the accepter answers an INIT with a SYNC and learns the dialer', () => {
  const { peer, last } = mockPeer()
  const { hooks, learned, done } = spyHooks()
  const dialer: Identity = { uuid: 'them', role: 'server', listen: '127.0.0.1:9', peers: ['127.0.0.1:8'] }
  const consumed = handle(recv(VERB.INIT, dialer), peer, hooks)
  assert.equal(consumed, true, 'INIT is a handshake frame')
  assert.equal(last().verb, VERB.SYNC, 'accepter replies SYNC')
  assert.deepEqual(learned, [dialer], 'learned the dialer’s identity')
  assert.deepEqual(done, [], 'accepter is not "done" until DONE arrives')
})

test('the dialer answers a SYNC with a DONE and completes', () => {
  const { peer, last } = mockPeer()
  const { hooks, learned, done } = spyHooks()
  const accepter: Identity = { uuid: 'srv', role: 'server', listen: '127.0.0.1:7', peers: [] }
  const consumed = handle(recv(VERB.SYNC, accepter), peer, hooks)
  assert.equal(consumed, true)
  assert.equal(last().verb, VERB.DONE, 'dialer replies DONE')
  assert.deepEqual(learned, [accepter])
  assert.deepEqual(done, [accepter], 'relationship established on SYNC')
})

test('DONE completes without a further write', () => {
  const { peer, writes } = mockPeer()
  const { hooks, learned, done } = spyHooks()
  const id: Identity = { uuid: 'x', role: 'server', listen: '127.0.0.1:5', peers: [] }
  const consumed = handle(recv(VERB.DONE, id), peer, hooks)
  assert.equal(consumed, true)
  assert.equal(writes.length, 0, 'DONE is terminal — no reply frame')
  assert.deepEqual(learned, [id])
  assert.deepEqual(done, [id])
})

test('a non-handshake verb is not consumed and triggers no reply', () => {
  const { peer, writes } = mockPeer()
  const { hooks, learned } = spyHooks()
  const consumed = handle(decodeFrame(encodeFrame([{ type: 'update', key: ['x'], value: 1 }])), peer, hooks)
  assert.equal(consumed, false, 'a RECORDS frame falls through to the data path')
  assert.equal(writes.length, 0)
  assert.deepEqual(learned, [])
})

test('a control frame straddled across TCP segments reassembles and routes', () => {
  // INIT carrying a chunky identity (so it spans several bytes), split at EVERY byte
  // boundary through the Framer — each reassembly must drive handle() identically.
  const dialer: Identity = { uuid: 'a'.repeat(40), role: 'server', listen: '127.0.0.1:6001', peers: ['127.0.0.1:6002', '127.0.0.1:6003'] }
  const buf = control(VERB.INIT, dialer)
  for (let cut = 1; cut < buf.length; cut++) {
    const framer = new Framer()
    const frames = [...framer.push(buf.subarray(0, cut)), ...framer.push(buf.subarray(cut))]
    assert.equal(frames.length, 1, `cut at ${cut}: one reassembled control frame`)
    const { peer, last } = mockPeer()
    const { hooks, learned } = spyHooks()
    assert.equal(handle(frames[0], peer, hooks), true, `cut at ${cut}`)
    assert.equal(last().verb, VERB.SYNC, `cut at ${cut}: answered SYNC`)
    assert.deepEqual(learned, [dialer], `cut at ${cut}: learned the full identity`)
  }
})

test('a malformed identity payload degrades gracefully (no crash, protocol still advances)', () => {
  // identityOf falls back to a default for a null/absent value; a non-object value
  // (a hostile/garbage payload) must not crash handle(), and a realistic learn() that
  // reaches into id.listen / id.peers must be null-safe on it.
  const transportLikeLearn = (id: Identity) => {
    if (id.listen) void id.listen // would dial
    for (const a of id.peers ?? []) void a // would gossip
  }
  for (const bad of [null, 'garbage', 42, [], { role: 'server' } /* missing peers */]) {
    const { peer, last } = mockPeer()
    const { hooks } = spyHooks({ learn: transportLikeLearn })
    assert.doesNotThrow(() => {
      const consumed = handle(recv(VERB.INIT, bad), peer, hooks)
      assert.equal(consumed, true)
      assert.equal(last().verb, VERB.SYNC, 'still answers SYNC despite the bad payload')
    }, `payload ${JSON.stringify(bad)}`)
  }
})
