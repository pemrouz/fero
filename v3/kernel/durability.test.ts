//! Tier-1 durability suite (M4b): the storage seam driven with hand-crafted echoes against a recording
// sink. Pins: the durable-off mode emits NOTHING (the sweeps' byte-identical contract), the persist →
// persisted → durable-watermark chain, persistFail as a surfaced alarm, the boot record's contents and
// its write sites (start / view install / vote grant / self-vote), THE M2-debt pin (a restart cannot
// double-vote — votedFor rides the boot record), replay as the same-ingest path (state, logs, ladder,
// clock, dedup windows all rebuild), torn-tail surfacing, and the Lamport floor + own-echo merge-up
// that stop a reborn clock re-issuing lost seqs.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { Framer, VERB, encodeControl, encodeFrame, encodeRuns } from './codec.ts'
import { REC, TAG, type BootRecord, type EffectSink, type Env, type Rec } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (rec) => effects.push(['apply', rec]),
    persist: (batch, bytes, prev) => effects.push(['persist', batch, bytes, prev]),
    boot: (record) => effects.push(['boot', record]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, durable: true, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  return { node, effects, of, jk, tick, admit }
}

test('durable OFF is the M0-M3 kernel byte-for-byte: zero persist effects, zero boot effects, zero new journal rows', () => {
  const h = harness('aa', { durable: false })
  h.node.step({ kind: 'start' })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(h.of('persist').length + h.of('boot').length, 0)
  assert.equal(h.node.journal.read().filter((e) => e.kind >= 43 && e.kind <= 47).length, 0)
})

test('a committed run is WAL\'d as ONE frame; the persisted echo advances durable exactly to the run tail', () => {
  const h = harness('aa')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }] })
  const p = h.of('persist')
  assert.equal(p.length, 1, 'one contiguous run, one WAL row')
  //! the row IS a wire-shaped frame: the same Framer that reads a socket decodes it
  const f = new Framer().push((p[0][2] as Uint8Array).slice())[0]
  assert.equal(f.verb, VERB.RECORDS)
  assert.deepEqual(f.prov(), { origin: 'aa', baseSeq: 1, epoch: 0, end: f.prov()!.end })
  const d = h.node.streams.get('aa')!
  assert.equal(d.durable, 0, 'durable advances on RESOLUTION, never on emit')
  h.node.step({ kind: 'persisted', batch: p[0][1] as number })
  assert.equal(d.durable, 2)
  assert.ok(h.jk(JK.persisted).length === 1)
})

test('a fresh inbound frame is WAL\'d; its echo advances that origin\'s durable; persistFail is a surfaced alarm', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 9 }], { origin: 'bb', baseSeq: 7, epoch: 0 }) })
  const p = h.of('persist')
  assert.equal(p.length, 1)
  h.node.step({ kind: 'persistFail', batch: p[0][1] as number, reason: 'io' })
  assert.equal(h.node.streams.get('bb')!.durable, 0, 'a failed batch advances nothing')
  assert.ok(h.jk(JK.persistFail).some((e) => e.b === 'io'), 'surfaced, never silent')
  //! a duplicate of the same frame is NOT re-WAL'd (nothing fresh in it)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 9 }], { origin: 'bb', baseSeq: 7, epoch: 0 }) })
  assert.equal(h.of('persist').length, 1)
})

test('the boot record carries the durable facts and is rewritten at start, view install, and both vote-spend sites', () => {
  const h = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  assert.equal(h.of('boot').length, 1, 'the incarnation is durable from the first instant')
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.tick() // genesis: aa proposes view 1 — the SELF-VOTE is spent and must be durable before PROPOSE ships
  const afterPropose = h.of('boot')
  assert.ok(afterPropose.length >= 2, 'the self-vote wrote the boot record')
  assert.equal((afterPropose[afterPropose.length - 1][1] as BootRecord).votedFor.e, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  const b = h.of('boot').pop()![1] as BootRecord
  assert.equal(b.epoch, 1, 'the committed view is a durable fact from the instant it installs')
  assert.deepEqual(b.members.map((m) => m[0]), ['aa', 'bb', 'cc'])
  assert.equal(b.incarnation, 1)
  assert.equal(typeof b.lamport, 'number')
})

test('THE M2-debt pin: a crash between granting a vote and anything else cannot double-vote after restart', () => {
  //! bb grants epoch-1 to proposer aa; the boot record captures the spent ballot; bb restarts FROM it
  const h = harness('bb', { hosts: ['sim:aa', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.admit(2, 'cc')
  const m3: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: m3, p: 'aa' }) })
  const rec = h.of('boot').pop()![1] as BootRecord
  assert.equal(rec.votedFor.e, 1, 'the grant hit the boot record BEFORE the VOTE frame left')
  //! the crash: a NEW bb boots from that record (epoch 0 view + restored votedFor) and a RIVAL proposes epoch 1
  const reborn = harness('bb', { incarnation: 2, boot: { epoch: rec.epoch, members: rec.members, lamport: rec.lamport, votedFor: rec.votedFor } })
  reborn.node.step({ kind: 'start' })
  reborn.admit(2, 'cc')
  reborn.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PROPOSE, { e: 1, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']], p: 'cc' }) })
  const votes = reborn.effects.filter((e) => e[0] === 'send' && e[1] === 2)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
    .filter((f) => f.verb === VERB.VOTE)
    .map((f) => (f.value as { g: number }).g)
  assert.deepEqual(votes, [0], 'the restored ballot identity refuses the rival — the double-vote window is closed')
})

test('replay IS the ingest path: state, logs, the full ladder, the clock, and the dedup window all rebuild', () => {
  //! build a WAL from a live node's persist effects, then boot a twin from it — the twin must be
  // indistinguishable (same state hash, same logs, durable === shippable: the rows came from disk)
  const a = harness('aa')
  a.admit(1, 'bb')
  a.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['own'], value: 'mine' }] })
  a.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['theirs'], value: 'x' } as Rec, origin: 'bb', seq: 5, epoch: 0, iss: 'cli~1', cid: 9 }])[0] })
  const wal = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  assert.equal(wal.length, 2)

  const b = harness('aa', { incarnation: 2 })
  for (const row of wal) b.node.step({ kind: 'replay', bytes: row.bytes, prev: row.prev })
  assert.equal(b.node.stateHash, a.node.stateHash, 'the twin folded to the same state')
  assert.equal(b.node.logs.get('aa')!.length, 1)
  assert.equal(b.node.logs.get('bb')!.length, 1)
  assert.equal(b.node.logs.get('bb')![0].iss, 'cli~1', 'attempt identity survives the WAL round-trip')
  for (const origin of ['aa', 'bb']) {
    const d = b.node.streams.get(origin)!
    assert.ok(d.applied === d.shippable && d.shippable === d.durable, `${origin}: replayed rows are durable by definition`)
  }
  assert.equal(b.node.seq, a.node.seq, 'the Lamport clock rebuilt from the replayed stamps')
  assert.equal(b.jk(JK.replayed).length, 2)
  //! and the dedup window re-fed: a retry of cli~1 cid 9 to this node (as owner) must dup-ACK, not re-commit
  b.admit(1, 'bb')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  b.node.writes.ring.place('theirs', 'aa')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['theirs'], value: 'x' } as Rec, origin: 'cli~1', seq: 9, epoch: 1 }], VERB.WRITE)[0] })
  assert.equal(b.jk(JK.writeDup).length, 1, 'a pre-crash commit still dedups after the restart')
})

test('a torn WAL tail surfaces as a journaled drop at the tear; everything before it replays intact', () => {
  const a = harness('aa')
  a.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k1'], value: 1 }] })
  a.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k2'], value: 2 }] })
  const rows = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  const torn = rows[1].bytes.slice(0, rows[1].bytes.length - 3) // the crash mid-append
  const b = harness('aa', { incarnation: 2 })
  b.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: rows[0].prev })
  b.node.step({ kind: 'replay', bytes: torn, prev: rows[1].prev })
  assert.equal(b.node.state.size, 1, 'the intact prefix replayed')
  assert.equal(b.node.state.get(JSON.stringify(['k1'])), 1)
  //! a torn tail is a TRUNCATED frame — the boot framer simply never completes it; a CORRUPTED tail
  // (flipped bytes with a valid length) is the crc's job and surfaces as a journaled drop
  const corrupt = rows[1].bytes.slice()
  corrupt[corrupt.length - 2] ^= 0xff
  const c = harness('aa', { incarnation: 3 })
  c.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: rows[0].prev })
  c.node.step({ kind: 'replay', bytes: corrupt, prev: rows[1].prev })
  assert.ok(c.jk(JK.frameDrop).some((e) => String(e.b).startsWith('wal:')), 'a corrupt row is surfaced, never guessed at')
})

test('an INTERIOR hole (a lying disk) breaks the chain: later rows skip until a re-link — never a silent gap', () => {
  //! Lamport streams are legitimately gappy, so seqs cannot reveal a lied-away middle batch — the chain
  // link can. Three writes → three rows; drop the MIDDLE one; the third must be skipped (walHole), the
  // restored stream ends at the first row's tail, and AE owns the rest as ordinary tail loss.
  const a = harness('aa')
  for (const k of ['k1', 'k2', 'k3']) a.node.step({ kind: 'write', recs: [{ type: REC.update, key: [k], value: k }] })
  const rows = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  assert.equal(rows.length, 3)
  const b = harness('aa', { incarnation: 2 })
  b.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: rows[0].prev })
  b.node.step({ kind: 'replay', bytes: rows[2].bytes, prev: rows[2].prev }) // the middle row lied away
  assert.equal(b.node.state.size, 1, 'only the pre-hole prefix restored')
  assert.ok(b.jk(JK.walHole).length === 1, 'the hole is surfaced at the exact row')
  assert.equal(b.node.streams.get('aa')!.applied, 1, 'the stream ends at the tear — pure tail loss for AE')
  //! the re-link: a row chained from the restored tail (an AE re-ship persisted post-restart) resumes the walk
  b.node.step({ kind: 'replay', bytes: rows[1].bytes, prev: rows[1].prev })
  assert.equal(b.node.state.size, 2, 'a row that re-links the chain is accepted')
})

test('the reborn clock and lane cannot collide with a lost life: the ceiling floor + old-lane recovery', () => {
  //! lamport CEILING: boot says no stamp beyond 40 ever existed — the reborn stamps 41+ from its own
  // NEW LANE (aa~2): the old life's stream is a foreign, immutable lane it can re-learn in full
  const h = harness('aa', { incarnation: 2, boot: { epoch: 0, members: [], lamport: 40 } })
  assert.equal(h.node.origin, 'aa~2', 'a reborn life stamps under its own provenance lane')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(h.node.logs.get('aa~2')![0].seq, 41, 'first post-restore stamp resumes past the ceiling')
  //! the OLD lane comes back from a peer as an ordinary foreign stream — appended, applied, clock merged
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['lost'], value: 'old' }], { origin: 'aa', baseSeq: 90, epoch: 0 }) })
  assert.equal(h.node.logs.get('aa')!.length, 1, 'the previous life re-learned — no own-guard in the way')
  assert.ok(h.node.seq >= 90, 'and the clock merged past it')
  //! a duplicate of the old lane stays dead (ordinary stream dedup — the seed-79 class per lane)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['lost'], value: 'old' }], { origin: 'aa', baseSeq: 90, epoch: 0 }) })
  assert.equal(h.node.logs.get('aa')!.length, 1, 'an under-tail echo never appends')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k2'], value: 2 }] })
  assert.equal(h.node.logs.get('aa~2')!.pop()!.seq, 91, 'the next write can never collide with a lost stamp')
})
