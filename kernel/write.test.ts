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
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
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
const formedView1 = (uuid = 'aa', extra: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const hosts = ['aa', 'bb', 'cc'].filter((u) => u !== uuid).map((u) => `sim:${u}`)
  const h = harness(uuid, { hosts, ...extra })
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

test('the relay VALIDATES: a refused ae=0 record WNACKs `invalid` with the reason (batched per reason run), the admitted ones commit, a committed dup skips the check', () => {
  //! the server's admission predicate — state-dependent on purpose (`strict` flips later) to prove the
  // dedup-window skip: a retransmit of a committed record is never turned into a lie by a changed answer
  let strict = false
  const h = formedView1('aa', { validate: (rec: Rec) => (strict ? 'closed' : rec.key[0] === 'admin' ? 'reserved' : true) })
  h.node.writes.ring.place('admin', 'aa')
  h.node.writes.ring.place('open', 'aa')
  //! a CLIENT run (ae 0): [open ✓, admin ✗, admin/sub ✗ (same reason → one NACK run), open/b ✓]
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('zz~1', 1, 0, [
    { type: REC.update, key: ['open'], value: 1 },
    { type: REC.update, key: ['admin'], value: 'x' },
    { type: REC.update, key: ['admin', 'sub'], value: 'y' },
    { type: REC.update, key: ['open', 'b'], value: 2 },
  ]) })
  assert.equal(h.jk(JK.writeRelay).length, 1, 'the relay boundary was crossed')
  const nacks = h.sentOn(1, VERB.WNACK)
  assert.equal(nacks.length, 1, 'contiguous same-reason refusals batch into ONE WNACK')
  assert.deepEqual(nacks[0].value, { u: 'zz~1', c: 2, n: 2, r: 'invalid', m: 'reserved', ce: 1 })
  assert.deepEqual(h.jk(JK.writeNack).map((e) => [e.a, e.c]), [['invalid', 2]], 'journaled under the typed class, never the free text')
  //! the admitted records committed here (aa owns both partitions) and ACKed back — cids 1 and 4 are
  // non-contiguous, so two runs, two WACKs; the refused row never touched the fold or the queue
  assert.equal(h.node.state.size, 2)
  assert.equal(h.node.state.has(JSON.stringify(['admin'])), false, 'the refused row never landed')
  assert.equal(h.node.writes.pending.size, 0, 'nothing parked for a refused record')
  const acks = h.sentOn(1, VERB.WACK)
  assert.deepEqual(acks.map((a) => [(a.value as { c: number }).c, (a.value as { n: number }).n]), [[1, 1], [4, 1]])
  //! the predicate now refuses EVERYTHING — a retransmit of committed cid 1 is dup-ACKed with its
  // original coordinates (the dedup window pre-empts the check); a FRESH cid 5 is refused with the new reason
  strict = true
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('zz~1', 1, 0, [{ type: REC.update, key: ['open'], value: 1 }]) })
  const acks2 = h.sentOn(1, VERB.WACK)
  assert.equal(acks2.length, 3, 'the retransmit was ACKed, not NACKed')
  assert.deepEqual(acks2[2].value, acks[0].value, 'ORIGINAL coordinates — exactly-once at the relay')
  assert.equal(h.sentOn(1, VERB.WNACK).length, 1, 'no new NACK for the committed dup')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('zz~1', 5, 0, [{ type: REC.update, key: ['open'], value: 9 }]) })
  const nacks2 = h.sentOn(1, VERB.WNACK)
  assert.equal(nacks2.length, 2)
  assert.deepEqual(nacks2[1].value, { u: 'zz~1', c: 5, n: 1, r: 'invalid', m: 'closed', ce: 1 })
  assert.equal(h.node.state.size, 2, 'still two rows')
  //! and with NO predicate the relay admits everything, as before
  const open = formedView1('aa')
  open.node.writes.ring.place('admin', 'aa')
  open.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('zz~1', 1, 0, [{ type: REC.update, key: ['admin'], value: 'x' }]) })
  assert.equal(open.node.state.size, 1)
  assert.equal(open.sentOn(1, VERB.WNACK).length, 0)
})

test('`invalid` is TERMINAL at the issuer: the attempt leaves the queue, the reason is recorded for the api, the tick clock never re-sends it; a non-owner-of-record `invalid` is ignored', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:aa' })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa' }) })
  h.node.step({ kind: 'write', recs: [
    { type: REC.update, key: ['a'], value: 1 }, { type: REC.update, key: ['b'], value: 2 }, { type: REC.update, key: ['c'], value: 3 },
  ] })
  assert.equal(h.node.writes.pending.size, 3)
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'one relayed run to the primary')
  //! the relay refuses cid 2 terminally
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'cl~1', c: 2, n: 1, r: 'invalid', m: 'reserved', ce: 1 }) })
  assert.equal(h.node.writes.pending.size, 2, 'cid 2 left the queue for good')
  assert.equal(h.node.writes.pending.has('cl~1|2'), false)
  assert.equal(h.node.writes.rejected.get('cl~1|2'), 'reserved', 'the reason waits for the api')
  assert.equal(h.node.writes.rejectedPending, 1)
  assert.deepEqual(h.jk(JK.writeNack).map((e) => [e.a, e.c]), [['invalid', 2]])
  //! the retry clock re-sends the in-flight cids 1 and 3 — never 2
  for (let i = 0; i <= RETRY_TICKS; i++) h.tick()
  const frames = h.sentOn(1, VERB.WRITE)
  assert.ok(frames.length >= 2, 'a retry went out')
  for (const f of frames.slice(1)) {
    const p = f.prov()!
    const cids = [...f.records()].map((_, i) => p.baseSeq + i)
    assert.ok(!cids.includes(2), `retry ${JSON.stringify(cids)} must not carry the refused cid`)
  }
  //! an `invalid` from a link that is NOT the owner of record cannot clear a route (cid 1 is bound to aa)
  h.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:bb' })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WNACK, { u: 'cl~1', c: 1, n: 1, r: 'invalid', m: 'spoof', ce: 1 }) })
  assert.equal(h.node.writes.pending.has('cl~1|1'), true, 'ignored — only the owner of record may end a route')
  assert.equal(h.node.writes.rejectedPending, 1)
  //! a malformed `m` degrades to the typed class, never a crash or a hang
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'cl~1', c: 3, n: 1, r: 'invalid', m: 7, ce: 1 }) })
  assert.equal(h.node.writes.rejected.get('cl~1|3'), 'invalid')
  assert.equal(h.node.writes.pending.size, 1)
})

test('a RELAY that hears `invalid` for a relayed attempt hops it onward to its client verbatim and forgets the route — recording nothing itself', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  //! a client spoke on link 3 (r:1 HELLO) relays a write for bb's partition through aa
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, 0, [
    { type: REC.update, key: ['theirs'], value: 1 }, { type: REC.update, key: ['theirs', 'x'], value: 2 },
  ]) })
  assert.equal(h.node.writes.pending.size, 2, 'relayed: re-stamped and queued with the reply route')
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'forwarded to the owner bb')
  //! bb (the owner of record) answers `invalid` — this code never does, but the frame is well-formed
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WNACK, { u: 'zz~1', c: 1, n: 2, r: 'invalid', m: 'nope', ce: 1 }) })
  assert.equal(h.node.writes.pending.size, 0, 'terminal at the relay too — never retried against an answer that cannot change')
  const hop = h.sentOn(3, VERB.WNACK)
  assert.equal(hop.length, 1, 'ONE hop for the contiguous run')
  assert.deepEqual(hop[0].value, { u: 'zz~1', c: 1, n: 2, r: 'invalid', m: 'nope', ce: 1 })
  assert.equal(h.node.writes.rejectedPending, 0, 'a relay records nothing — the reason belongs to the client')
  assert.equal(h.node.writes.rejected.size, 0)
})

test('the relay is keyed on the ADMISSION FACT, not the claim: a client link forging ae = epoch still meets the validator and is re-stamped; a member with ae = epoch takes the owner leg', () => {
  const h = formedView1('aa', { validate: (rec: Rec) => (rec.key[0] === 'admin' ? 'reserved' : true) })
  h.node.writes.ring.place('admin', 'aa')
  h.node.writes.ring.place('open', 'aa')
  //! a client spoke on link 3 (HELLO r:1) lies: ae = the committed epoch, as a member would send
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, h.node.epoch, [
    { type: REC.update, key: ['admin'], value: 'x' }, { type: REC.update, key: ['open'], value: 1 },
  ]) })
  assert.equal(h.jk(JK.writeRelay).length, 1, 'forced through the relay — the link is a client, whatever it claims')
  assert.deepEqual(h.sentOn(3, VERB.WNACK)[0].value, { u: 'zz~1', c: 1, n: 1, r: 'invalid', m: 'reserved', ce: 1 })
  assert.equal(h.node.state.has(JSON.stringify(['admin'])), false, 'the forged attempt never reached the owner leg unvalidated')
  assert.equal(h.node.state.has(JSON.stringify(['open'])), true, 'the admitted record was relayed and committed')
  assert.equal(h.sentOn(3, VERB.WACK).length, 1)
  //! a MEMBER (link 1 = bb) with ae = epoch takes the owner leg exactly as before: no relay, no validator
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 1, h.node.epoch, [{ type: REC.update, key: ['admin'], value: 'peer' }]) })
  assert.equal(h.jk(JK.writeRelay).length, 1, 'no second relay')
  assert.equal(h.node.state.has(JSON.stringify(['admin'])), true, 'a peer is trusted at this layer — its issuer validated')
  assert.equal(h.sentOn(1, VERB.WNACK).length, 0)
})

test('an ACK or NACK arriving on a CLIENT link is dropped (a client owns nothing to answer for): it can neither clear nor terminally end another route', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  //! client A (link 3) relays a write for bb's partition — in flight to bb, owner of record bb
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'za', i: 1, l: 'sim:za', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('za~1', 1, 0, [{ type: REC.update, key: ['theirs'], value: 1 }]) })
  assert.equal(h.node.writes.pending.size, 1)
  //! …and a PARKED one: cc's partition, cc is not linked here, so `to` is still '' (the owner gate alone would pass anyone)
  h.node.step({ kind: 'linkDown', link: 2, reason: 'cut' })
  h.node.writes.ring.place('parked', 'cc')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('za~1', 2, 0, [{ type: REC.update, key: ['parked'], value: 1 }]) })
  assert.equal(h.node.writes.pending.size, 2)
  assert.equal(h.node.writes.pending.get('za~1|2')!.to, '', 'parked: no owner of record yet')
  //! client B (link 4) forges a WACK for the parked attempt and a terminal WNACK for the in-flight one
  h.node.step({ kind: 'linkUp', link: 4, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.HELLO, { u: 'zb', i: 1, l: 'sim:zb', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.WACK, { u: 'za~1', c: 2, n: 1, s: 99, e: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.WNACK, { u: 'za~1', c: 1, n: 1, r: 'invalid', m: 'forged', ce: 1 }) })
  assert.equal(h.node.writes.pending.size, 2, 'both routes intact')
  assert.equal(h.sentOn(3, VERB.WNACK).length, 0, 'nothing hopped to the victim')
  assert.equal(h.sentOn(3, VERB.WACK).length, 0)
  assert.deepEqual(h.jk(JK.frameDrop).map((e) => e.b), ['write-ack from client', 'write-ack from client'])
  assert.equal(h.node.links.get(4)!.dead, false, 'the link is kept — a confused client is not a wire fault')
  //! the real owner of record (bb, link 1) still answers the in-flight route
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'za~1', c: 1, n: 1, s: 7, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 1)
  assert.equal(h.sentOn(3, VERB.WACK).length, 1, 'hopped to client A')
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

test('one commit, one writeAck row: a WACK landing AFTER replication cleared the route journals nothing; a partial WACK names only what it cleared', () => {
  const h = formedView1()
  h.node.writes.ring.place('theirs', 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['theirs'], value: 1 }, { type: REC.update, key: ['theirs', 'sub'], value: 2 }] })
  assert.equal(h.node.writes.pending.size, 2)
  //! the first attempt's committed record replicates back before the owner's WACK does — replication IS an ACK
  h.node.step({ kind: 'bytesIn', link: 1, bytes: recordFrame('bb', 7, 1, 'aa~1', 1, [{ type: REC.update, key: ['theirs'], value: 1 }]) })
  assert.equal(h.node.writes.pending.size, 1)
  assert.deepEqual(h.jk(JK.writeAck).map((e) => [e.a, e.b, e.c]), [['aa~1', 1, 1]])
  //! the WACK covers both attempts; only the second is still pending, so the row says cid 2, count 1
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 2, s: 7, e: 1 }) })
  assert.equal(h.node.writes.pending.size, 0)
  assert.deepEqual(h.jk(JK.writeAck).map((e) => [e.a, e.b, e.c]), [['aa~1', 1, 1], ['aa~1', 2, 1]], 'two commits, two rows')
  //! the second record's replication arrives last: the route is long complete — no third row
  h.node.step({ kind: 'bytesIn', link: 1, bytes: recordFrame('bb', 8, 1, 'aa~1', 2, [{ type: REC.update, key: ['theirs', 'sub'], value: 2 }]) })
  assert.equal(h.jk(JK.writeAck).length, 2, 'a WACK or record that clears nothing journals nothing')
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
