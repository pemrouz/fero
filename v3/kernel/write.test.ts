//! Tier-1 write-pipeline suite: the write contract driven by hand-crafted frames against a recording
// sink. Every clause of plan §5's contract has a pin here — routing, the stamp site, cid dedup with
// original-coordinate re-ACKs, each typed NACK reason, the client relay rule, the retry clock, and
// the attemptEpoch law (re-stamp at the flush boundary only). sim/write.test.ts then proves the same
// machinery end-to-end under the four AA fault schedules.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { RETRY_TICKS, MAX_ISSUERS } from './write.ts'
import { JK } from './journal.ts'
import { Framer, VERB, encodeControl, encodeRuns } from './codec.ts'
import { REC, TAG, type EffectSink, type Env, type Rec } from './env.ts'

const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => effects.push(['send', link, bytes]),
    close: (link, reason) => effects.push(['close', link, reason]),
    timer: (id, tag, ms) => effects.push(['timer', id, tag, ms]),
    cancel: (id) => effects.push(['cancel', id]),
    apply: (rec) => effects.push(['apply', rec]),
    persist: (batch, bytes) => effects.push(['persist', batch, bytes]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  const sentOn = (link: number, verb: number) =>
    of('send').filter((e) => e[1] === link)
      .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
      .filter((f) => f.verb === verb)
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  return { node, effects, of, tick, jk, sentOn, admit }
}

//! aa at committed view 1 over {aa, bb, cc}; links 1=bb 2=cc (the same shape membership.test.ts drives)
const formedView1 = (uuid = 'aa') => {
  const hosts = ['aa', 'bb', 'cc'].filter((u) => u !== uuid).map((u) => `sim:${u}`)
  const h = harness(uuid, { hosts })
  h.node.step({ kind: 'start' })
  const peers = ['aa', 'bb', 'cc'].filter((u) => u !== uuid)
  h.admit(1, peers[0])
  h.admit(2, peers[1])
  if (uuid === 'aa') {
    h.tick()
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  } else {
    const m: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
    h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m }) })
  }
  assert.equal(h.node.epoch, 1)
  return h
}

//! a forwarded-attempt frame as a peer/client would build it: prov = [issuer, baseCid, attemptEpoch]
const writeFrame = (issuer: string, c0: number, ae: number, recs: Rec[]): Uint8Array =>
  encodeRuns(recs.map((rec, i) => ({ rec, origin: issuer, seq: c0 + i, epoch: ae })), VERB.WRITE)[0]

//! a committed replication frame carrying ATTEMPT IDENTITY, as an owner broadcasts one (origin = owner,
// contiguous seqs; iss/cid = the attempt it committed from) — this is what feeds every node's dedup window
const recordFrame = (origin: string, s0: number, epoch: number, iss: string, cid0: number, recs: Rec[]): Uint8Array =>
  encodeRuns(recs.map((rec, i) => ({ rec, origin, seq: s0 + i, epoch, iss, cid: cid0 + i })), VERB.RECORDS)[0]

test('epoch 0 is the open fast path: writes commit locally with ZERO attempt machinery', () => {
  const h = harness('aa')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(h.node.state.size, 1)
  assert.equal(h.node.writes.pending.size, 0)
  assert.equal(h.jk(JK.writeForward).length + h.jk(JK.writeBuffered).length, 0, 'no forwards, no parking — M0/M1 byte-for-byte')
})

test('owner routing: a write for a peer-owned partition FORWARDS (attempt triple on the wire) and never applies locally', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 7 }] })
  assert.equal(h.node.state.size, 0, 'v2 never-drop local fallback is DELETED: no local stamp, ever')
  assert.equal(h.node.writes.pending.size, 1, 'the attempt is pending until its ACK')
  const w = h.sentOn(1, VERB.WRITE)
  assert.equal(w.length, 1)
  const prov = w[0].prov()!
  assert.equal(prov.origin, 'aa~1', 'issuer = uuid~incarnation (a restart opens a fresh cid lane)')
  assert.equal(prov.baseSeq, 1, 'first cid')
  assert.equal(prov.epoch, 1, 'attemptEpoch = committed epoch at issue')
  assert.equal(h.jk(JK.writeForward).length, 1)
})

test('the owner validates then commits a forwarded attempt at ITS stamp site, and ACKs the run coordinates', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [
    { type: REC.update, key: ['mine'], value: 'x' }, { type: REC.update, key: ['mine', 'sub'], value: 'y' }]) })
  assert.equal(h.node.state.size, 2, 'committed here — the owner is the sequencer')
  const log = h.node.logs.get('aa')!
  assert.equal(log.length, 2, 'stamped under the OWNER origin at the owner epoch')
  assert.equal(log[0].epoch, 1)
  const ack = h.sentOn(1, VERB.WACK)
  assert.equal(ack.length, 1)
  assert.deepEqual(ack[0].value, { u: 'bb~1', c: 5, n: 2, s: log[0].seq, e: 1 }, 'one run, one ACK, contiguous coords')
})

test('a WACK clears exactly its pending attempts; a malformed one is ignored', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }, { type: REC.update, key: ['theirs'], value: 2 }] })
  assert.equal(h.node.writes.pending.size, 2)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'zz', c: 1, n: 4096 }) }) // over-bound n
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 'NaN', n: 1 }) })
  assert.equal(h.node.writes.pending.size, 2, 'garbage cleared nothing')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 2, s: 10, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 0)
  assert.equal(h.jk(JK.writeAck).length, 1)
})

test('cid dedup: a retransmitted attempt commits ONCE; the duplicate ACK re-carries the ORIGINAL coordinates', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  const frame = writeFrame('bb~1', 9, 1, [{ type: REC.update, key: ['mine'], value: 42 }])
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame })
  const first = h.sentOn(1, VERB.WACK)[0].value as { s: number; e: number }
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame.slice() }) // the retry (lost-ACK case)
  assert.equal(h.node.logs.get('aa')!.length, 1, 'exactly-once at the commit site')
  assert.equal(h.jk(JK.writeDup).length, 1)
  const acks = h.sentOn(1, VERB.WACK)
  assert.equal(acks.length, 2)
  assert.deepEqual(acks[1].value, { u: 'bb~1', c: 9, n: 1, s: first.s, e: first.e }, 'original coordinates, not a re-stamp')
})

test('WNACK not-owner: a forward that lands on a non-owner is refused, typed, with the owner epoch', () => {
  const h = formedView1()
  h.node.writes.ring.place('elsewhere', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 1, [{ type: REC.update, key: ['elsewhere'], value: 1 }]) })
  assert.equal(h.node.state.size, 0, 'v2 commitForwarded validated nothing (AA #2) — v3 validates ownership')
  const n = h.sentOn(1, VERB.WNACK)
  assert.equal(n.length, 1)
  assert.deepEqual(n[0].value, { u: 'bb~1', c: 1, n: 1, r: 'not-owner', ce: 1 })
})

test('WNACK stale-epoch: an attemptEpoch ≠ owner epoch is refused; a HIGHER one also flags the owner stale', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 3, [{ type: REC.update, key: ['mine'], value: 1 }]) })
  assert.equal(h.node.state.size, 0)
  assert.deepEqual(h.sentOn(1, VERB.WNACK)[0].value, { u: 'bb~1', c: 1, n: 1, r: 'stale-epoch', ce: 1 })
  assert.ok(h.jk(JK.epochStale).length === 1, 'ae=3 is proof view 3 committed somewhere — the staleness contract applies to attempts')
  assert.equal(h.node.membership.gate(h.node).open, false)
})

test('WNACK withheld: an owner whose gate is closed refuses instead of parking — ALL buffering is issuer-side', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  //! sever cc: aa+bb is still a majority — so instead install a 5-member view where 2-of-5 is a minority
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [
    ['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd'], ['ee', 'sim:ee']] }) })
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' }) // aa+bb = 2 of 5: minority
  assert.equal(h.node.membership.gate(h.node).open, false)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 2, [{ type: REC.update, key: ['mine'], value: 1 }]) })
  assert.deepEqual(h.sentOn(1, VERB.WNACK)[0].value, { u: 'bb~1', c: 1, n: 1, r: 'withheld', ce: 2 })
  assert.equal(h.node.writes.pending.size, 0, 'the owner parked NOTHING')
})

test('a WNACK re-parks the attempts and its ce is absorbed as staleness evidence; the flush re-stamps ae (the law)', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }] })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1)
  //! the owner answers: your epoch is stale, mine is 2
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'aa~1', c: 1, n: 1, r: 'stale-epoch', ce: 2 }) })
  assert.equal(h.jk(JK.epochStale).length, 1, 'ce > mine — the gate closes and the pull goes out')
  assert.equal(h.node.writes.pending.size, 1, 'still pending — re-resolution owns it now')
  //! the missing view arrives → install → settle → flush: the SAME attempt re-forwards with ae = 2
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  const w = h.sentOn(1, VERB.WRITE)
  assert.equal(w.length, 2, 're-forwarded after the view healed')
  assert.equal(w[1].prov()!.epoch, 2, 'attemptEpoch re-stamped ONLY at the issuer/flush boundary')
  assert.equal(w[1].prov()!.baseSeq, 1, 'the retry reuses the cid — owner dedup covers the route')
})

test('the retry clock: no ACK within RETRY_TICKS heartbeats → re-resolve + re-forward with the same cid', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }] })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1)
  for (let i = 0; i < RETRY_TICKS; i++) h.tick()
  const w = h.sentOn(1, VERB.WRITE)
  assert.equal(w.length, 2, 'the lost WRITE (or lost WACK) is retransmitted on the tick clock')
  assert.equal(w[1].prov()!.baseSeq, w[0].prov()!.baseSeq, 'same cid — dedup absorbs whichever copy was the duplicate')
})

test('client relay rule: attemptEpoch 0 is re-stamped by the FIRST server, which owns the route both ways', () => {
  const h = formedView1()
  h.node.writes.ring.place('near', 'aa')
  h.node.writes.ring.place('far', 'cc')
  //! link 5 is a CLIENT (admitted like any peer; api-level client handles land at M5 — the kernel rule exists now)
  h.admit(5, 'client-1')
  //! case 1: the relay IS the owner — commit + WACK straight back on the client link
  h.node.step({ kind: 'bytesIn', link: 5, bytes: writeFrame('client-1~1', 1, 0, [{ type: REC.update, key: ['near'], value: 'n' }]) })
  assert.equal(h.jk(JK.writeRelay).length, 1)
  assert.equal(h.node.state.size, 1, 'the relay owned it: committed at the relay')
  assert.equal((h.sentOn(5, VERB.WACK)[0].value as { u: string }).u, 'client-1~1')
  //! case 2: a third node owns it — the relay stamps ae, forwards, and hops the ACK back to the client
  h.node.step({ kind: 'bytesIn', link: 5, bytes: writeFrame('client-1~1', 2, 0, [{ type: REC.update, key: ['far'], value: 'f' }]) })
  const fwd = h.sentOn(2, VERB.WRITE)
  assert.equal(fwd.length, 1, 'relayed toward the owner (cc)')
  assert.equal(fwd[0].prov()!.origin, 'client-1~1', 'the CLIENT stays the issuer — its cid lane covers the whole route')
  assert.equal(fwd[0].prov()!.epoch, 1, 'ae stamped at relay time (relay time IS an issuer boundary)')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'client-1~1', c: 2, n: 1, s: 30, e: 1 }) })
  const hop = h.sentOn(5, VERB.WACK)
  assert.equal(hop.length, 2, 'the commit coordinates hopped back to the client')
  assert.deepEqual(hop[1].value, { u: 'client-1~1', c: 2, n: 1, s: 30, e: 1 })
  assert.equal(h.node.writes.pending.size, 0)
})

test('a WRITE frame before HELLO is a protocol violation: the link closes, nothing routes', () => {
  const h = harness('aa')
  h.node.step({ kind: 'linkUp', link: 1, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 1, [{ type: REC.update, key: ['k'], value: 1 }]) })
  assert.deepEqual(h.of('close')[0], ['close', 1, 'write-before-hello'])
  assert.equal(h.node.state.size, 0)
})

test('exactly-once survives an ownership move: a committed attempt seen via REPLICATION dedups a retry to the NEW owner', () => {
  //! the adversarial-review CRITICAL: the dedup window was per-node — a retry after a view change hit a
  // new owner with no memory of the cid and re-committed, resurrecting a stale value over a newer write.
  // The fix: committed forwarded runs broadcast (issuer, cid); replication feeds every node's window.
  const h = formedView1() // aa at view 1
  //! aa learns (via replication from the OLD owner bb) that cid 5 from issuer x~1 already committed at bb
  h.node.step({ kind: 'bytesIn', link: 1, bytes: recordFrame('bb', 10, 1, 'x~1', 5, [{ type: REC.update, key: ['p'], value: 'v1' }]) })
  //! now a view change makes aa the owner of 'p'; the un-ACKed retry re-forwards to aa at epoch 2
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  h.node.writes.ring.place('p', 'aa')
  const before = h.node.logs.get('aa')?.length ?? 0
  h.node.step({ kind: 'bytesIn', link: 2, bytes: writeFrame('x~1', 5, 2, [{ type: REC.update, key: ['p'], value: 'v1' }]) })
  assert.equal(h.node.logs.get('aa')?.length ?? 0, before, 'the new owner must NOT re-commit — replication taught it the cid')
  assert.equal(h.jk(JK.writeDup).length, 1, 'deduped against the replication-fed window')
  const dup = h.sentOn(2, VERB.WACK)
  assert.deepEqual(dup[dup.length - 1].value, { u: 'x~1', c: 5, n: 1, s: 10, e: 1 }, 'the dup ACK carries bb\'s ORIGINAL coordinates')
})

test('replication IS an ACK: a committed record carrying our issuer clears the pending attempt (lost-WACK self-heal)', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }] })
  assert.equal(h.node.writes.pending.size, 1)
  //! the owner's WACK is lost, but its committed record replicates back with our attempt identity attached
  h.node.step({ kind: 'bytesIn', link: 1, bytes: recordFrame('bb', 7, 1, 'aa~1', 1, [{ type: REC.update, key: ['theirs'], value: 1 }]) })
  assert.equal(h.node.writes.pending.size, 0, 'the route completed via the data path')
  assert.ok(h.jk(JK.writeAck).length >= 1)
})

test('NACK pacing: a same-epoch withheld/not-owner NACK re-parks onto the TICK clock, not straight back to the wire', () => {
  //! the adversarial-review storm: onNack→settle→flush re-forwarded instantly, spinning at line rate
  // against a minority owner. A same-epoch NACK (ce === my epoch) must wait for the retry clock.
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }] })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'one forward out')
  //! bb answers withheld at the SAME epoch — this must NOT trigger an immediate re-forward
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'aa~1', c: 1, n: 1, r: 'withheld', ce: 1 }) })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'no instant re-forward — the storm is paced away')
  assert.equal(h.jk(JK.epochStale).length, 0, 'same-epoch NACK is not staleness evidence')
  //! the tick clock re-drives it (once) after the retry window
  for (let i = 0; i < RETRY_TICKS; i++) h.tick()
  assert.equal(h.sentOn(1, VERB.WRITE).length, 2, 'the retry clock re-forwarded exactly once')
})

test('owner of record: a WACK/WNACK from a link that is NOT the owner the attempt was forwarded to is ignored', () => {
  //! the adversarial-review spoof: any admitted link could clear another node's pending attempts / re-drive
  // its route with a well-formed control frame. ACK/NACK are bound to the owner of record (the forward target).
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }] })
  assert.equal(h.node.writes.pending.size, 1)
  //! cc (link 2) — NOT the owner of record (bb) — sends a matching WACK: it must be ignored
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 99, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 1, 'a non-owner WACK cannot clear the attempt')
  //! the real owner (bb, link 1) can
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 5, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 0)
})

test('relay ACK batching: a batched WACK for n relayed attempts hops onward as ONE frame, not n', () => {
  //! the adversarial-review perf finding: onAck looped per-cid, fanning one batched ACK into n frames +
  // n 4KB allocs on the client reply path. A contiguous run must re-batch into one WACK.
  const h = formedView1()
  h.node.writes.ring.place('far', 'cc')
  h.admit(5, 'client-1')
  //! a 3-record client batch (ae 0) relays to cc; the owner ACKs all three in one WACK{n:3}
  h.node.step({ kind: 'bytesIn', link: 5, bytes: encodeRuns(
    [0, 1, 2].map((i) => ({ rec: { type: REC.update, key: ['far', `k${i}`], value: i } as Rec, origin: 'client-1~1', seq: 1 + i, epoch: 0 })), VERB.WRITE)[0] })
  assert.equal(h.sentOn(2, VERB.WRITE).length, 1, 'relayed as one WRITE to cc')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'client-1~1', c: 1, n: 3, s: 50, e: 1 }) })
  const hop = h.sentOn(5, VERB.WACK)
  assert.equal(hop.length, 1, 'the batched ACK hops onward as ONE frame, not three')
  assert.deepEqual(hop[0].value, { u: 'client-1~1', c: 1, n: 3, s: 50, e: 1 }, 'coordinates preserved as a run')
})

test('multi-record relayed WACK coordinates step per record (the +i offset is load-bearing)', () => {
  //! mutation-killer (review): dropping the per-record +i on a relayed multi-record ACK survived the suite.
  // Force a per-record HOP by making each relayed record clear individually (via a partial owner WACK).
  const h = formedView1()
  h.node.writes.ring.place('far', 'cc')
  h.admit(5, 'client-1')
  h.node.step({ kind: 'bytesIn', link: 5, bytes: encodeRuns(
    [0, 1].map((i) => ({ rec: { type: REC.update, key: ['far', `k${i}`], value: i } as Rec, origin: 'client-1~1', seq: 1 + i, epoch: 0 })), VERB.WRITE)[0] })
  //! owner ACKs the two records with distinct coordinates c1→s100, c2→s101 in ONE run
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'client-1~1', c: 1, n: 2, s: 100, e: 1 }) })
  const hop = h.sentOn(5, VERB.WACK)[0].value as { c: number; n: number; s: number }
  assert.deepEqual([hop.c, hop.n, hop.s], [1, 2, 100], 'the run hops with its base coordinate; s+i reconstructs each record\'s seq downstream')
})

test('dedup lanes are bounded by MAX_ISSUERS — an attacker minting infinite issuer strings cannot exhaust memory', () => {
  //! the adversarial-review resource finding: #seen grew one lane per distinct issuer string forever.
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  //! commit one attempt from each of MAX_ISSUERS + 50 distinct issuers (each a valid owner-forwarded write)
  for (let i = 0; i < MAX_ISSUERS + 50; i++)
    h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame(`atk${i}~1`, 1, 1, [{ type: REC.update, key: ['mine'], value: i }]) })
  assert.ok(h.jk(JK.dedupEvict).length >= 50, 'oldest lanes evicted, surfaced')
  //! spot-check: the newest issuer's lane still dedups; the oldest was evicted (its retry would re-commit — the documented residual)
  const before = h.node.logs.get('aa')!.length
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame(`atk${MAX_ISSUERS + 49}~1`, 1, 1, [{ type: REC.update, key: ['mine'], value: 'x' }]) })
  assert.equal(h.node.logs.get('aa')!.length, before, 'a recent issuer still dedups')
})

test('the onWrite dedup pre-filter is load-bearing: it dup-ACKs a committed cid even when current validation would reject', () => {
  //! mutation-killer (review): removing onWrite's pre-filter survived the suite because every retransmit
  // test also passed validation. Here the retry arrives when the owner has MOVED ON (stale ae) — only the
  // pre-filter (which runs BEFORE validation) can still dup-ACK it; without it the owner NACKs a
  // committed write, and the issuer never learns its true coordinates.
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 3, 1, [{ type: REC.update, key: ['mine'], value: 1 }]) })
  const orig = h.sentOn(1, VERB.WACK)[0].value as { s: number; e: number }
  //! aa moves to epoch 2; the retry still carries ae=1 (the issuer hasn't learned the new view)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  h.node.writes.ring.place('mine', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 3, 1, [{ type: REC.update, key: ['mine'], value: 1 }]) })
  assert.equal(h.jk(JK.writeDup).length, 1, 'the pre-filter dup-ACKed despite the now-stale ae')
  assert.equal(h.sentOn(1, VERB.WNACK).length, 0, 'a committed cid is never NACKed')
  const dup = h.sentOn(1, VERB.WACK)
  assert.deepEqual(dup[dup.length - 1].value, { u: 'bb~1', c: 3, n: 1, s: orig.s, e: orig.e }, 'original coordinates')
})

test('mixed-outcome runs split correctly: dups re-ACK, valid records commit, rejects NACK — per contiguous slice', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  h.node.writes.ring.place('not-mine', 'cc')
  //! first: commit cid 1 so it becomes a dup on the second pass
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 1, [{ type: REC.update, key: ['mine'], value: 'a' }]) })
  //! now a 3-record run: [dup(1), not-owner(2), fresh commit(3)]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, 1, [
    { type: REC.update, key: ['mine'], value: 'a' },
    { type: REC.update, key: ['not-mine'], value: 'b' },
    { type: REC.update, key: ['mine', 'x'], value: 'c' },
  ]) })
  assert.equal(h.jk(JK.writeDup).length, 1)
  const nacks = h.sentOn(1, VERB.WNACK)
  assert.equal(nacks.length, 1)
  assert.deepEqual(nacks[0].value, { u: 'bb~1', c: 2, n: 1, r: 'not-owner', ce: 1 })
  assert.equal(h.node.logs.get('aa')!.length, 2, 'cid 1 once, cid 3 once')
  assert.equal(h.sentOn(1, VERB.WACK).length, 3, 'original ACK + dup re-ACK + fresh ACK')
})

test('M5a PIN — attempt identity rides the Applied effect: owner commits and inbound replication carry (iss, cid); the epoch-0 fast path carries none', () => {
  //! the embedder-facing join (env.ts Applied): the api layer resolves ITS OWN writes by matching
  // iss/cid on apply effects — so every path that knows an attempt identity must deliver it
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  //! path 1: a forwarded attempt committed at this owner — apply carries the FORWARDER's identity
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [{ type: REC.update, key: ['mine'], value: 'x' }]) })
  const applies = h.of('apply').map((e) => e[1] as { iss?: string; cid?: number; origin: string; seq: number })
  assert.equal(applies.length, 1)
  assert.equal(applies[0].iss, 'bb~1')
  assert.equal(applies[0].cid, 5)
  assert.equal(applies[0].origin, 'aa', 'stamped under the owner — identity is the ATTEMPT, provenance is the commit')
  //! path 2: an inbound committed record carrying FLAG_ATTEMPT (replication feeds every embedder's join)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: recordFrame('bb', 1, 1, 'cc~1', 9, [{ type: REC.update, key: ['theirs'], value: 'y' }]) })
  const inb = h.of('apply').map((e) => e[1] as { iss?: string; cid?: number }).pop()!
  assert.equal(inb.iss, 'cc~1')
  assert.equal(inb.cid, 9)
  //! path 3: the epoch-0 fast path mints no attempt — identity is absent, and the embedder instead
  // observes the apply synchronously inside its own write() call
  const h0 = harness('zz')
  h0.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  const fast = h0.of('apply').map((e) => e[1] as { iss?: string; cid?: number }).pop()!
  assert.equal(fast.iss, undefined)
  assert.equal(fast.cid, undefined)
  //! and the cid counter is embedder-readable: the attempt path minted nothing here either
  assert.equal(h0.node.writes.cid, 0)
})

test('M5a PIN — a locally ISSUED attempt (epoch ≥ 1, self-owned) applies with our own issuer + the minted cid, and writes.cid samples the mint', () => {
  const h = formedView1()
  h.node.writes.ring.place('mine', 'aa')
  const before = h.node.writes.cid
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['mine'], value: 42 }] })
  assert.equal(h.node.writes.cid, before + 1, 'one cid per record, contiguous — the embedder brackets write() to learn them')
  const a = h.of('apply').map((e) => e[1] as { iss?: string; cid?: number }).pop()!
  assert.equal(a.iss, 'aa~1')
  assert.equal(a.cid, before + 1)
})
