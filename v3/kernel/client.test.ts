//! Tier-1 client-role suite (M5b): the SPOKE contract driven with hand-crafted frames. Pins: the
// HELLO role byte, genesis invisibility (client links never count, never sweep, never win the
// lowest-uuid race), the single-feeder rule (digest only the primary; non-primary digests are
// consumed for evidence but never answered), ae=0 client writes relayed via the primary, the
// tap-forward spoke feed with attempt identity intact, primary failover with immediate repark,
// and that a client node runs none of the member machinery.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
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
    persist: (batch, bytes, prev) => effects.push(['persist', batch, bytes, prev]),
    boot: (record) => effects.push(['boot', record]),
    confirm: (id, ok, count) => effects.push(['confirm', id, ok, count]),
    snapshot: (batch, rows) => effects.push(['snapshot', batch, rows]),
  }
  const env: Env = { now: () => 0, rng: () => 0, sink }
  const node = new Node({ uuid, listen: `sim:${uuid}`, heartbeatMs: 50, ...opts }, env)
  const of = (kind: string) => effects.filter((e) => e[0] === kind)
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const sentOn = (link: number, verb: number) =>
    of('send').filter((e) => e[1] === link)
      .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
      .filter((f) => f.verb === verb)
  const admit = (link: number, u: string, role?: number) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, role === 1 ? { u, i: 1, l: `sim:${u}`, r: 1 } : { u, i: 1, l: `sim:${u}` }) })
  }
  const digestFrom = (link: number) => node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  return { node, effects, of, jk, tick, sentOn, admit, digestFrom }
}

test('a client announces its role in HELLO; a server marks the link and keeps it OUT of genesis', () => {
  //! server aa with one configured host (bb) — a pre-genesis client zz also connects
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'zz', 1) // the client (uuid sorts LAST — but role, not uuid, is what excludes it)
  h.admit(2, 'bb')
  h.digestFrom(1)
  h.digestFrom(2)
  assert.equal([...h.node.clientLinks][0].uuid, 'zz', 'the role byte marked the link')
  h.tick()
  const p = h.jk(JK.propose)
  assert.equal(p.length, 1, 'genesis proposed — the client did not block or join the count')
  assert.equal(p[0].b, 2, 'TWO members: aa + bb — the client is not swept in')
  //! and a client with the LOWEST uuid must not wedge genesis by winning the lowest-uuid race
  const h2 = harness('bb', { hosts: ['sim:cc'] })
  h2.node.step({ kind: 'start' })
  h2.admit(1, 'aa', 1) // client 'aa' sorts lowest
  h2.admit(2, 'cc')
  h2.tick()
  assert.equal(h2.jk(JK.propose).length, 1, 'bb still proposes — the client uuid is invisible to the race')
})

test('the single-feeder rule: a client digests ONLY its primary; non-primary digests are consumed for evidence but never answered', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  assert.equal(h.node.primary, 1, 'first admit elects the primary')
  assert.equal(h.sentOn(1, VERB.DIGEST).length, 1, 'digest-on-admit to the primary')
  h.admit(2, 'bb')
  assert.equal(h.sentOn(2, VERB.DIGEST).length, 0, 'NO digest to a non-primary admit')
  //! bb asks with r=1 — a member would answer; the client must not (answering syncs a second feeder)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { aa: 5 }, r: 1 }) })
  assert.equal(h.sentOn(2, VERB.DIGEST).length, 0, 'unanswered')
  //! the heartbeat floor stays primary-only too ('cl' > 'aa'/'bb' means no pings, but assert digests)
  h.tick()
  assert.equal(h.sentOn(2, VERB.DIGEST).length, 0)
})

test('client writes: ae=0 attempts relayed via the primary; WACK clears; a member never hears JOIN/PROPOSE from a client', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  //! the client learns the committed view (VIEW floods reach spokes) — its writes STILL carry ae=0
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 3, m: [['aa', 'sim:aa'], ['bb', 'sim:bb']] }) })
  assert.equal(h.node.epoch, 3)
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }, { type: REC.update, key: ['k2'], value: 2 }] })
  assert.equal(h.node.state.size, 0, 'a client NEVER stamps or commits locally')
  const w = h.sentOn(1, VERB.WRITE)
  assert.equal(w.length, 1, 'one run frame to the primary')
  const prov = w[0].prov()!
  assert.equal(prov.origin, 'cl~1', 'issuer lane')
  assert.equal(prov.epoch, 0, 'ae=0 — the client marker, regardless of the known view')
  assert.equal(h.node.writes.pending.size, 2)
  //! WACK with commit coordinates clears the route
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 2, s: 7, e: 3 }) })
  assert.equal(h.node.writes.pending.size, 0)
  //! ticks never produce member machinery from a client
  h.tick()
  h.tick()
  assert.equal(h.jk(JK.propose).length + h.jk(JK.join).length + h.jk(JK.vote).length, 0)
})

test('the spoke feed: a server tap-forwards fresh inbound records to synced client links, attempt identity intact', () => {
  const h = harness('aa')
  h.admit(1, 'bb')      // a member peer
  h.digestFrom(1)
  h.admit(2, 'zz', 1)   // a client spoke
  h.digestFrom(2)       // the client's digest = this node is its primary; the link syncs
  //! an inbound committed record from bb, carrying attempt identity — the spoke must hear BOTH
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['x'], value: 9 } as Rec, origin: 'bb', seq: 4, epoch: 1, iss: 'cli9~1', cid: 3 }])[0] })
  const fwd = h.sentOn(2, VERB.RECORDS)
  //! frame 0 may be the digest-triggered suffix ship; the tap-forward is the LAST records frame
  const f = fwd[fwd.length - 1]
  assert.ok(f, 'the spoke heard the record')
  const p = f.prov()!
  assert.equal(p.origin, 'bb')
  assert.equal(p.baseSeq, 4)
  const rv = [...f.records()][0]
  assert.equal(rv.issuer, 'cli9~1', 'attempt identity rides the spoke feed (the overlay join needs it)')
  assert.equal(rv.cid, 3)
  //! a duplicate of the same record is NOT re-forwarded (only FRESH records feed the spoke)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['x'], value: 9 } as Rec, origin: 'bb', seq: 4, epoch: 1 }])[0] })
  assert.equal(h.sentOn(2, VERB.RECORDS).length, fwd.length, 'dup dropped, nothing re-shipped')
  //! and an UNSYNCED client link (no digest yet) hears nothing
  h.admit(3, 'zy', 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns(
    [{ rec: { type: REC.update, key: ['y'], value: 1 } as Rec, origin: 'bb', seq: 5, epoch: 1 }])[0] })
  assert.equal(h.sentOn(3, VERB.RECORDS).length, 0, 'unsynced spoke: withheld (the suffix ship will cover it)')
})

test('primary failover: the feeder dies — next admitted server becomes primary, gets the digest, and in-flight attempts repark + re-send NOW', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  h.admit(2, 'bb')
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'issued via the primary')
  //! the primary dies with the attempt in flight
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2, 'failover elected the next admitted server')
  assert.equal(h.sentOn(2, VERB.DIGEST).length, 1, 'the new feeder is digested (suffix ship resumes the lanes)')
  const re = h.sentOn(2, VERB.WRITE)
  assert.equal(re.length, 1, 'the in-flight attempt re-sent to the new relay immediately')
  assert.equal(re[0].prov()!.epoch, 0, 'still ae=0 — dedup at the owner absorbs any duplicate')
})
