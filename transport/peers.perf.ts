// Regression guard for the headline L0 rethink: flipping ONE peer's status in a
// pool of N must cost O(delta) — one change record on the `connected`
// projection — NOT an O(n) rebuild of six imperative lists (the fero-old shape,
// peer.js:99,114). The delta-count assertion is the real guard; the timing
// assertion confirms it stays flat as N grows.

import { test } from 'node:test'
import { ok, equal } from 'node:assert'
import { value } from '../../data/index.ts'
import { Peers } from './peers.ts'
import { STATUS, Peer } from './peer.ts'
import { bench } from '#utils'

const N = 2000

// Populate N disconnected rows directly (no sockets — isolating projection cost).
function pool() {
  const p = new Peers()
  for (let i = 0; i < N; i++) p.peers['10.0.0.' + i + ':3000'] = { address: '10.0.0.' + i + ':3000', host: '10.0.0.' + i, port: 3000, role: 'server', status: STATUS.disconnected }
  return p
}

test(`one status transition emits exactly one delta on connected (N=${N})`, () => {
  const p = pool()
  const changes = p.connected.connect([]) // initial snapshot (connected is empty)
  const base = changes.length

  p.peers['10.0.0.500:3000'].status = STATUS.connected
  equal(changes.length - base, 1, 'connect → exactly one insert on the projection')
  equal(changes.at(-1).type, 'insert')

  p.peers['10.0.0.500:3000'].status = STATUS.disconnected
  equal(changes.length - base, 2, 'disconnect → exactly one remove on the projection')
  equal(changes.at(-1).type, 'remove')

  p.destroy()
})

test(`status transition cost is flat in N (N=${N})`, () => {
  const p = pool()
  p.connected.connect([]) // attach the projection so the delta path runs
  let on = true
  const flips = () => {
    for (let i = 0; i < 1000; i++) {
      p.peers['10.0.0.' + (i % N) + ':3000'].status = on ? STATUS.connected : STATUS.disconnected
      on = !on
    }
  }
  const elapsed = bench.time(flips) // one untimed warmup + median-of-5
  console.log(`  ${1000} transitions over N=${N} pool: ${elapsed.toFixed(3)}ms`)
  // ~2.5× headroom over the loaded-box median; the O(1)-delta guard above is the
  // real correctness check — this just catches an O(N)-per-transition regression.
  ok(elapsed < 25, `1000 transitions took ${elapsed.toFixed(3)}ms (threshold 25ms) — should be ~O(transitions), not O(transitions·N)`)
  p.destroy()
})

test('sendDelta: 10k same-tick subscription deltas queue in O(records) — the cost a writer pays inline', () => {
  // Regression guard for the deltaTo outbox bypass: each served-subscription delta used to be
  // an immediate encodeFrame + socket.write INSIDE the writer's sink chain (M subs ⇒ M frame
  // encodes + M syscalls per assignment, inline). sendDelta makes the inline cost a queue push;
  // the encode + ONE write per sub happens once per microtask flush (frame-count pinned in
  // peer.test.ts). Measured disconnected so ONLY the synchronous queue cost is on the clock.
  const peer = new Peer({ host: '10.255.0.1', port: 1, retries: { max: 0 } })
  const elapsed = bench.time(() => {
    for (let i = 0; i < 10_000; i++) peer.sendDelta(i & 7, { type: 'update', key: ['k'], value: i })
  })
  console.log(`  10k sendDelta queue: ${elapsed.toFixed(3)}ms`)
  ok(elapsed < 10, `10k delta queues took ${elapsed.toFixed(3)}ms (threshold 10ms) — must stay a push, never an inline encode+write`)
  peer.destroy()
})
