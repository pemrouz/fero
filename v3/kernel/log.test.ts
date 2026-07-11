//! Tier-1 compaction suite (M4d): the plan's two equivalences as PROPERTY tests — replay-from-0 ≡ live
// and compacted catch-up ≡ uncompacted — plus the safety pins: the frontier (a lagging member blocks
// compaction), tombstone GC's quiescence condition (a straggler that could still resurrect holds the
// stamp), and the boundedness the M0 debt demanded (churn on few keys stays O(live cells), not O(history)).

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { frontier, compact, gcTombstones, COMPACT_AT } from './log.ts'
import { JK } from './journal.ts'
import { Framer, VERB, encodeControl, encodeRuns } from './codec.ts'
import { REC, TAG, type EffectSink, type Env } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: () => {}, send: () => {}, close: () => {}, cancel: () => {}, apply: () => {},
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    persist: () => {}, boot: () => {}, confirm: () => {},
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  return { node, of, tick, admit }
}

//! aa at view 1 over {aa, bb, cc}, owning everything (every key pinned) — churn then compaction happen HERE
const churned = () => {
  const h = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.tick()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  for (const k of ['k0', 'k1', 'k2', 'k3', 'gone']) h.node.writes.ring.place(k, 'aa')
  //! churn: every key overwritten many times; one key removed at the end — history >> live cells
  for (let i = 0; i < 20; i++)
    h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i % 4}`], value: `v${i}` }] })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['gone'], value: 'doomed' }] })
  h.node.step({ kind: 'write', recs: [{ type: REC.remove, key: ['gone'] }] })
  return h
}

//! announce both peers fully caught up (their digests carry aa's tail) — the frontier unlocks
const caughtUp = (h: ReturnType<typeof harness>) => {
  const tail = h.node.seq
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: tail }, r: 0 }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: tail }, r: 0 }) })
}

//! fold a node's CURRENT log for `origin` into a fresh twin over the wire — the catch-up a lagging peer gets
const catchUpTwin = (src: Node, origin: string): Node => {
  const t = harness('zz')
  t.admit(1, origin)
  const entries = src.logs.get(origin)!
  const frames = encodeRuns(entries.map((e) => ({ rec: e.rec, origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid })))
  for (const bytes of frames) t.node.step({ kind: 'bytesIn', link: 1, bytes })
  return t.node
}

test('the frontier: a lagging member PINS compaction; full acknowledgement unlocks it', () => {
  const h = churned()
  assert.equal(frontier(h.node, 'aa'), 0, 'no digests yet — nothing may compact')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: 5 }, r: 0 }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: h.node.seq }, r: 0 }) })
  assert.equal(frontier(h.node, 'aa'), 5, 'the slowest member IS the frontier')
  const before = h.node.logs.get('aa')!.length
  compact(h.node, 'aa', frontier(h.node, 'aa'))
  assert.ok(h.node.logs.get('aa')!.length >= before - 5, 'only the acknowledged prefix (5 entries) was touchable')
  assert.ok(h.node.logs.get('aa')!.some((e) => e.seq > 5), 'everything past the frontier untouched')
  caughtUp(h)
  assert.equal(frontier(h.node, 'aa'), h.node.seq)
})

test('PROPERTY replay-from-0 ≡ live: a fresh twin folding the COMPACTED log reaches the live state exactly', () => {
  const h = churned()
  caughtUp(h)
  const dropped = compact(h.node, 'aa', frontier(h.node, 'aa'))
  assert.ok(dropped >= 16, `churn history collapsed (dropped ${dropped})`)
  assert.ok(h.node.journal.read().some((e) => e.kind === JK.compacted))
  const twin = catchUpTwin(h.node, 'aa')
  assert.equal(twin.stateHash, h.node.stateHash, 'same fold, same state')
  assert.equal(twin.state.size, h.node.state.size)
  //! and the surviving snapshot records carry ORIGINAL stamps: the twin's versions match for live cells
  for (const [k, v] of h.node.versions) if (h.node.state.has(k)) assert.deepEqual(twin.versions.get(k), v, k)
})

test('PROPERTY compacted catch-up ≡ uncompacted: two lagging peers, one served each way, converge identically', () => {
  const h = churned()
  const full = h.node.logs.get('aa')!.map((e) => ({ ...e })) // clone the uncompacted history first
  caughtUp(h)
  compact(h.node, 'aa', frontier(h.node, 'aa'))
  const viaCompacted = catchUpTwin(h.node, 'aa')
  const t2 = harness('zz')
  t2.admit(1, 'aa')
  for (const bytes of encodeRuns(full.map((e) => ({ rec: e.rec, origin: 'aa', seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid }))))
    t2.node.step({ kind: 'bytesIn', link: 1, bytes })
  assert.equal(viaCompacted.stateHash, t2.node.stateHash, 'the snapshot records ARE the history, LWW-wise')
})

test('tombstone GC: the stamp survives while a straggler could resurrect, and is released once every lane quiesces', () => {
  const h = churned()
  const k = JSON.stringify(['gone'])
  //! bb is fully caught up; cc lags BELOW the remove — a stale resurrect from anywhere must still fence
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: h.node.seq }, r: 0 }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: 3 }, r: 0 }) })
  gcTombstones(h.node)
  assert.ok(h.node.versions.has(k), 'a lagging lane holds every tombstone')
  //! cc catches up — every lane quiesced: the tombstone releases, and the next compaction drops the remove record
  caughtUp(h)
  gcTombstones(h.node)
  assert.ok(!h.node.versions.has(k), 'released once nothing can contest it')
  compact(h.node, 'aa', frontier(h.node, 'aa'))
  assert.ok(!h.node.logs.get('aa')!.some((e) => e.rec.key[0] === 'gone'), 'the remove record followed its stamp out')
  //! the LIVE cells keep their stamps — they are the LWW guard for the value itself
  assert.ok(h.node.versions.has(JSON.stringify(['k0'])))
})

test('boundedness (the M0 debt): sustained churn with periodic compaction stays O(live cells), not O(history)', () => {
  const h = churned()
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < 40; i++)
      h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i % 4}`], value: `r${round}-${i}` }] })
    caughtUp(h)
    compact(h.node, 'aa', frontier(h.node, 'aa'))
  }
  const entries = h.node.logs.get('aa')!.length
  assert.ok(entries <= 8, `1200+ writes of history live in ${entries} entries`)
  assert.ok(entries < COMPACT_AT, 'never near the arm threshold with a live frontier')
  //! and the fold is still exact
  const twin = catchUpTwin(h.node, 'aa')
  assert.equal(twin.stateHash, h.node.stateHash)
})
