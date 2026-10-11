//! Tier-1 durability suite (M4b): the storage seam driven with hand-crafted echoes against a recording
// sink. Pins: the durable-off mode emits NOTHING (the sweeps' byte-identical contract), the persist →
// persisted → durable-watermark chain, persistFail as a surfaced alarm, the boot record's contents and
// its write sites (start / view install / vote grant / self-vote), THE M2-debt pin (a restart cannot
// double-vote — votedFor rides the boot record), replay as the same-ingest path (state, logs, ladder,
// clock, dedup windows all rebuild), torn-tail surfacing, and the Lamport floor + own-echo merge-up
// that stop a reborn clock re-issuing lost seqs.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node, SNAPSHOT_AT } from './node.ts'
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
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
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
  //! M5a: the replayed apply EFFECT carries it too — a restored embedder's proxy refills from replay
  // through the same (iss, cid)-bearing join as live ingest (env.ts Applied)
  const rb = b.of('apply').map((e) => e[1] as { iss?: string; cid?: number; origin: string }).find((r) => r.origin === 'bb')!
  assert.equal(rb.iss, 'cli~1')
  assert.equal(rb.cid, 9)
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

test('an INTERIOR hole (a lying disk) CONDEMNS the restore: the fold resets, the WAL swaps clean, the cluster re-teaches (fsyncgate)', () => {
  //! honest crashes tear TAILS (the shell's ordered io-queue and the sim's FIFO fsync clock make
  // resolution order = append order), so a surviving row past a missing one PROVES the disk lied — and
  // a liar's prefix is not evidence: kept alive, it can resurrect cells whose removes were compacted
  // away cluster-wide on this very disk's durable claims (the M4e sweep's seed-27 divergence). The
  // verdict is total, mirroring persistFail's fsyncgate posture on the write side.
  const a = harness('aa')
  for (const k of ['k1', 'k2', 'k3']) a.node.step({ kind: 'write', recs: [{ type: REC.update, key: [k], value: k }] })
  const rows = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  assert.equal(rows.length, 3)
  const b = harness('aa', { incarnation: 2 })
  b.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: rows[0].prev })
  b.node.step({ kind: 'replay', bytes: rows[2].bytes, prev: rows[2].prev }) // the middle row lied away
  assert.ok(b.jk(JK.walHole).length === 1, 'the hole is surfaced at the exact row')
  assert.ok(b.jk(JK.walTaint).length === 1, 'and the verdict is journaled, never silent')
  assert.equal(b.node.tainted, true)
  assert.equal(b.node.state.size, 0, 'the fold reset — a liar\'s prefix is not evidence')
  assert.equal(b.node.logs.size, 0)
  const swap = b.of('snapshot').pop()!
  assert.deepEqual(swap[2], [], 'the WAL swapped CLEAN — the next restart replays a consistent (empty) file, not the same hole')
  b.node.step({ kind: 'replay', bytes: rows[1].bytes, prev: rows[1].prev })
  assert.equal(b.node.state.size, 0, 'nothing further from this disk is evidence')
  //! the cluster re-teaches: ordinary inbound ingest refolds the node — the proven wiped-disk path
  b.admit(1, 'bb')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([
    { rec: { type: REC.update, key: ['k1'], value: 'k1' } as Rec, origin: 'aa', seq: 1, epoch: 0 },
    { rec: { type: REC.update, key: ['k2'], value: 'k2' } as Rec, origin: 'aa', seq: 2, epoch: 0 },
    { rec: { type: REC.update, key: ['k3'], value: 'k3' } as Rec, origin: 'aa', seq: 3, epoch: 0 }])[0] })
  assert.equal(b.node.state.size, 3, 'refolded from the wire — convergence owes nothing to the liar')
})

test('the WAL snapshot (M4e): the swap re-encodes the whole log under fresh chains; the echo advances durable to the tails', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['x'], value: 9 }], { origin: 'bb', baseSeq: 7, epoch: 0 }) })
  h.node.snapshot()
  const snaps = h.of('snapshot')
  assert.equal(snaps.length, 1)
  const rows = snaps[0][2] as { bytes: Uint8Array; prev: number }[]
  //! one contiguous own run + one bb row — and every origin's chain RESTARTS at prev=0 in the swap
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.prev === 0), 'fresh chains: the swapped file has no history to link to')
  assert.deepEqual(rows.map((r) => new Framer().push(r.bytes.slice())[0].prov()!.origin), ['aa', 'bb'])
  assert.equal(h.node.streams.get('aa')!.durable, 0, 'durable advances on the swap RESOLUTION, never on emit')
  h.node.step({ kind: 'persisted', batch: snaps[0][1] as number })
  assert.equal(h.node.streams.get('aa')!.durable, 2, 'everything in the log is on disk from the echo')
  assert.equal(h.node.streams.get('bb')!.durable, 7)
  assert.ok(h.jk(JK.snapshot).length === 1)
  //! an append AFTER the swap chains onto the snapshot tail, not the pre-swap history
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['c'], value: 3 }] })
  const p = h.of('persist').pop()!
  assert.equal(p[3], 2, 'post-swap rows link from the snapshot tail')
})

test('snapshot arming: SNAPSHOT_AT appended rows trigger the swap on the tick, AFTER compaction — and the counter re-arms from zero', () => {
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.tick() // genesis: aa (lowest) proposes view 1 over {aa, bb}
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb' }) })
  for (const k of ['k0', 'k1', 'k2', 'k3']) h.node.writes.ring.place(k, 'aa')
  for (let i = 0; i < SNAPSHOT_AT + 8; i++)
    h.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i % 4}`], value: i }] })
  //! license the frontier on CRASH-STABLE evidence only (the M4-review fix): every fsync batch must
  // resolve (own durable) AND the peer must acknowledge the tail WITH a durable map (markD, not the
  // volatile shippable mark — sawP flags bb as a durable peer)
  for (const p of h.of('persist')) h.node.step({ kind: 'persisted', batch: p[1] as number })
  const tail = h.node.seq
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: tail }, r: 0, p: { aa: tail } }) })
  assert.equal(h.of('snapshot').length, 0, 'nothing swaps between ticks')
  h.tick()
  const snaps = h.of('snapshot')
  assert.equal(snaps.length, 1, 'the tick armed the swap')
  //! compaction ran first (same tick, frontier = the durably-acknowledged tail): thousands of churned
  // rows leave a HANDFUL of snapshot records on disk — the whole point of the composition
  const rows = snaps[0][2] as { bytes: Uint8Array; prev: number }[]
  assert.ok(rows.length <= 4, `the swapped WAL holds ${rows.length} rows for ${SNAPSHOT_AT + 8}+ writes of history`)
  h.tick()
  assert.equal(h.of('snapshot').length, 1, 'the counter reset — no re-arm until SNAPSHOT_AT fresh rows')
})

test('restore from a swapped WAL is the same fold; a LIED swap degrades to pure tail loss — the swap is chain-transparent', () => {
  const a = harness('aa')
  a.admit(1, 'bb')
  a.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['own'], value: 'mine' }] })
  a.node.step({ kind: 'bytesIn', link: 1, bytes: encodeFrame([{ type: REC.update, key: ['theirs'], value: 'x' }], { origin: 'bb', baseSeq: 5, epoch: 0 }) })
  const preSwap = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  const preSwapHash = a.node.stateHash
  a.node.snapshot()
  const rows = (a.of('snapshot')[0][2] as { bytes: Uint8Array; prev: number }[]).slice()
  a.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['after'], value: 'the swap' }] })
  const post = a.of('persist').slice(preSwap.length).map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  assert.equal(post.length, 1)
  //! the honest disk: swapped rows + the post-swap append — the twin folds to the live state exactly
  const b = harness('aa', { incarnation: 2 })
  for (const r of [...rows, ...post]) b.node.step({ kind: 'replay', bytes: r.bytes, prev: r.prev })
  assert.equal(b.node.stateHash, a.node.stateHash, 'the swapped file IS the history')
  assert.equal(b.node.seq, a.node.seq)
  for (const [, d] of b.node.streams) assert.ok(d.applied === d.durable, 'replayed rows are durable by definition')
  //! chain-transparency: per origin the snapshot tail EQUALS the old chain tail (both are the log
  // tail), so a swap whose RENAME evaporated at crash leaves the OLD file — a self-consistent
  // SUPERSET of the snapshot (the swap only removes redundancy) — while appends after the swap died
  // in the phantom new file. Replaying the old rows folds cleanly: no hole, no corruption; the lost
  // append is ordinary TAIL loss for suffix anti-entropy. Pinned here so no future chain change can
  // silently turn a lied rename into an interior hole.
  const c = harness('aa', { incarnation: 2 })
  for (const r of preSwap) c.node.step({ kind: 'replay', bytes: r.bytes, prev: r.prev })
  assert.equal(c.jk(JK.walHole).length, 0, 'the old file is self-consistent — the swap never re-chains live history')
  assert.equal(c.node.stateHash, preSwapHash, 'the pre-swap fold restored intact')
  assert.equal(c.node.walTail.get('aa'), 1, 'and the chain tail matches where the phantom appends would have linked')
})

test('M4-REVIEW PIN — durable FREEZES at a persistFail: batches already in flight are voided, their late echoes advance nothing', () => {
  //! the false-evidence shape four independent finders converged on: batch 1 fails, batch 2 (issued
  // before the failure, sitting PAST the hole on disk) resolves after — durable must NOT advance to
  // it, or confirm:'persisted' certifies rows a restore will drop at the tear
  const h = harness('aa')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['a'], value: 1 }] })
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['b'], value: 2 }] })
  const [b1, b2] = h.of('persist').map((p) => p[1] as number)
  h.node.step({ kind: 'persistFail', batch: b1, reason: 'io' })
  h.node.step({ kind: 'persisted', batch: b2 }) // the in-flight successor resolves AFTER the failure
  assert.equal(h.node.streams.get('aa')!.durable, 0, 'frozen means frozen — nothing past the hole is evidence')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['c'], value: 3 }] })
  assert.equal(h.of('persist').length, 2, 'the WAL is dead — no new batches leave')
})

test('M4-REVIEW PIN — a reborn peer\'s evidence is void: a HELLO with a higher incarnation forgets every mark it announced', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { aa: 5 }, r: 0, p: { aa: 5 } }) })
  assert.equal(h.node.confirm.mark('bb', 'aa'), 5)
  assert.equal(h.node.confirm.markD('bb', 'aa'), 5)
  //! bb crashes and returns as incarnation 2 — everything its first life claimed may have regressed
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  h.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:bb' })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 2, l: 'sim:bb' }) })
  assert.equal(h.node.confirm.mark('bb', 'aa'), 0, 'shippable marks forgotten — a dead life proves nothing')
  assert.equal(h.node.confirm.markD('bb', 'aa'), 0, 'durable marks too (a lied/condemned disk regresses even those)')
})

test('M4-REVIEW PIN — condemn resets the cid-dedup window: no ghost dup-ACKs for records that exist nowhere', () => {
  //! replay row 1 feeds the window (iss cli~1 cid 9); the hole then condemns the restore — a retry of
  // that cid must RE-COMMIT (at-least-once until replication re-feeds), never answer with the stamp
  // of a record the condemned fold no longer holds anywhere
  const a = harness('aa')
  a.admit(1, 'bb')
  a.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['x'], value: 1 } as Rec, origin: 'bb', seq: 3, epoch: 0, iss: 'cli~1', cid: 9 }])[0] })
  const rows = a.of('persist').map((p) => ({ bytes: p[2] as Uint8Array, prev: p[3] as number }))
  const b = harness('aa', { incarnation: 2 })
  b.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: rows[0].prev })
  b.node.step({ kind: 'replay', bytes: rows[0].bytes, prev: 999 }) // impossible link — the disk lied
  assert.equal(b.node.tainted, true)
  b.admit(1, 'bb')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  b.node.writes.ring.place('x', 'aa')
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['x'], value: 1 } as Rec, origin: 'cli~1', seq: 9, epoch: 1 }], VERB.WRITE)[0] })
  assert.equal(b.jk(JK.writeDup).length, 0, 'the condemned window answers nothing')
  assert.equal(b.node.logs.get('aa~2')!.length, 1, 'the retry re-committed — honest at-least-once, never a ghost ACK')
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

//! ── V4-51: WAL rows and the snapshot are cut by size ───────────────────────────
// A commit, or a snapshot chunk, bigger than one frame is one ROW PER FRAME: each row its own batch, chained by prev,
// covering only its own records. The rows are the frames the wire would carry, so replay reads them unchanged — and a
// file written with one big row (before the cut existed) replays on a node that cuts. Driven at the tune row's 4 KiB.
const bigRows = (n: number, from = 1): Rec[] => Array.from({ length: n }, (_, i) => ({ type: REC.update, key: [`r${from + i}`], value: new Uint8Array(1500).fill((from + i) & 255) }))
const rowsOf = (h: ReturnType<typeof harness>) => h.of('persist').map((p) => ({ batch: p[1] as number, bytes: p[2] as Uint8Array, prev: p[3] as number }))
const seqsOf = (bytes: Uint8Array) => new Framer().push(bytes.slice())[0].records().map((rv) => rv.seq)
//! an ARMED durable aa at committed view 1 over {aa, bb, cc} that owns r1..r10 (the scoped suite's idiom: the boot
// record installs epoch 1, a live peer's VIEW confirms it, the ring is placed by hand)
const armedDurable = (tune: Record<string, number>) => {
  const h = harness('aa', { replicas: 2, tune, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.armed, true)
  h.node.membership.rejoinFloor = 0
  for (let i = 1; i <= 10; i++) h.node.writes.ring.place(`r${i}`, 'aa', 'bb')
  return h
}

test('a durable commit bigger than one frame is one WAL row per frame, chained by prev, each covering only its own partitions; replay restores every record', () => {
  for (const armed of [false, true]) {
    const h = armed ? armedDurable({ frame: 4096 }) : harness('aa', { tune: { frame: 4096 } })
    const before = rowsOf(h).length
    h.node.step({ kind: 'write', recs: bigRows(10) })
    const rows = rowsOf(h).slice(before)
    const seqs = rows.map((r) => seqsOf(r.bytes))
    const s0 = h.node.logs.get('aa')![0].seq
    assert.deepEqual(seqs, [0, 2, 4, 6, 8].map((k) => [s0 + k, s0 + k + 1]), `${armed ? 'armed' : 'unscoped'}: five rows of two`)
    assert.deepEqual(rows.map((r) => r.prev), [0, ...seqs.slice(0, -1).map((x) => x[1])], 'each row chains onto the one before it')
    assert.ok(rows.every((r) => r.bytes.length - 11 <= 4096), 'every row within the cap')
    //! the echo of the FIRST row advances durable to that row's tail, and (armed) raises the durable floors of its own
    // two partitions only: a cover over the whole commit would have raised all ten
    const d = h.node.streams.get('aa')!
    h.node.step({ kind: 'persisted', batch: rows[0].batch })
    assert.equal(d.durable, s0 + 1, 'durable stops at the first row\'s tail')
    const floors = () => Array.from({ length: 10 }, (_, i) => d.parts!.get(`r${i + 1}`)!.d)
    if (armed) assert.deepEqual(floors(), [s0, s0 + 1, 0, 0, 0, 0, 0, 0, 0, 0], 'a row\'s cover holds only its own records')
    for (const r of rows.slice(1)) h.node.step({ kind: 'persisted', batch: r.batch })
    assert.equal(d.durable, s0 + 9)
    if (armed) assert.deepEqual(floors(), Array.from({ length: 10 }, (_, i) => s0 + i))
    //! replay the rows into a fresh node: every record, no taint
    const r = harness('aa', { tune: { frame: 4096 } })
    for (const row of rows) r.node.step({ kind: 'replay', bytes: row.bytes, prev: row.prev })
    assert.equal(r.node.state.size, 10)
    assert.equal(r.node.tainted, false)
    assert.deepEqual(r.jk(JK.frameDrop), [])
  }
})

test('the snapshot cuts a chunk by size; its rows chain; a one-row file written at the full cap replays on a node that cuts', () => {
  const h = harness('aa', { tune: { frame: 4096 } })
  for (let b = 0; b < 3; b++) h.node.step({ kind: 'write', recs: bigRows(10, 1 + b * 10) })
  h.node.snapshot()
  const rows = h.of('snapshot').pop()![2] as { bytes: Uint8Array; prev: number }[]
  assert.equal(rows.length, 15, 'one chunk of 30 contiguous records, fifteen rows of two')
  assert.ok(rows.every((r) => r.bytes.length - 11 <= 4096))
  assert.deepEqual(rows.map((r) => r.prev), [0, ...rows.slice(0, -1).map((r) => seqsOf(r.bytes).pop()!)], 'each row chains onto the last seq before it')
  assert.deepEqual(rows.flatMap((r) => seqsOf(r.bytes)), Array.from({ length: 30 }, (_, i) => i + 1))
  const r = harness('aa', { tune: { frame: 4096 } })
  for (const row of rows) r.node.step({ kind: 'replay', bytes: row.bytes, prev: row.prev })
  assert.equal(r.node.state.size, 30)
  assert.equal(r.node.tainted, false)
  //! a chunk under the cap is one row, as before: the same history at the full cap snapshots to ONE row
  const full = harness('aa')
  for (let b = 0; b < 3; b++) full.node.step({ kind: 'write', recs: bigRows(10, 1 + b * 10) })
  full.node.snapshot()
  assert.equal((full.of('snapshot').pop()![2] as unknown[]).length, 1)
  //! a file written before the cut existed: one row of ten records (a 15 KB body), replayed on a 4 KiB node
  const old = harness('aa')
  old.node.step({ kind: 'write', recs: bigRows(10) })
  const [row] = rowsOf(old)
  assert.ok(row.bytes.length - 11 > 4096, 'the old shape: one row past the small cap')
  const n = harness('aa', { tune: { frame: 4096 } })
  n.node.step({ kind: 'replay', bytes: row.bytes, prev: row.prev })
  assert.equal(n.node.state.size, 10)
  assert.equal(n.node.tainted, false)
})
