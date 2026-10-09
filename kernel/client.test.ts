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
    invoke: (link, id, mode, m, a) => effects.push(['invoke', link, id, mode, m, a]),
    result: (id, ok, value, local) => effects.push(['result', id, ok, value, local]),
    subRecs: (id, recs) => effects.push(['subRecs', id, recs]),
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

//! DESIGN-SCALE stage 1: a client reads its primary's HELLO contract live off the primary link, the way it
// reads the methods-only hint. The api reads `replicas=` out of it (a scoped feeder shows a spoke only the
// partitions it holds, so a delete of an absent row there must still be sent). An old server, or any peer
// that sends no `c`, reads undefined; so does a client with no primary.
test('feederContract: a client keeps its primary\'s HELLO contract as sent; absent from a server that sends none or with no primary', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  assert.equal(h.node.feederContract, undefined, 'no primary yet')
  const c = 'v1;heartbeat.ms=50;replicas=1;methods=0;validation=none'
  h.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:aa' })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c }) })
  assert.equal(h.node.primary, 1)
  assert.equal(h.node.feederContract, c, 'the primary\'s contract, as sent')
  h.admit(2, 'bb') // an old server: no `c`
  assert.equal(h.node.links.get(2)!.contract, undefined)
  assert.equal(h.node.feederContract, c, 'a non-primary admit does not move it')
  //! an OUTAGE: every server link down, no primary — the last primary's contract still answers (the fold is
  // still that feeder's shard; a delete queued for the reconnect is judged by it, api/data.ts #local)
  h.node.step({ kind: 'linkDown', link: 2, reason: 'test' })
  h.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  assert.equal(h.node.primary, null)
  assert.equal(h.node.feederContract, c, 'no primary: the last primary\'s contract is remembered')
  //! a failover to a server that sent none reads live again: undefined
  h.admit(3, 'bb')
  assert.equal(h.node.primary, 3)
  assert.equal(h.node.feederContract, undefined, 'moved to a server that sent none')
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
  assert.equal(rv.issuer, 'cli9~1', 'attempt identity rides the spoke feed (the write-route join needs it)')
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

test("a spoke never teaches — and a spoke AHEAD of its feeder resyncs to the feeder's truth: fold reset, empty r=1 digest, ghosts removed on the r=0 reply", () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1) // the primary's reply: nothing held yet → nothing to compare
  const lane = (from: number, keys: string[]) =>
    encodeRuns(keys.map((k, i) => ({ rec: { type: REC.update, key: [k], value: k } as Rec, origin: 'bb', seq: from + i, epoch: 1 })))[0]
  //! the feeder ships lane bb 1..3 (cells x, y, z)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane(1, ['x', 'y', 'z']) })
  assert.equal(h.node.state.size, 3)
  const applies0 = h.of('apply').length
  //! the feeder's heartbeat digest (r=1) shows bb at tail 3: we are NOT ahead — no ship, a plain r=0 answer
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 3 }, r: 1 }) })
  assert.equal(h.sentOn(1, VERB.RECORDS).length, 0, 'a spoke ships nothing')
  assert.equal(h.node.resync, null)
  let d = h.sentOn(1, VERB.DIGEST).map((f) => f.value as { d: Record<string, number>; r: number })
  assert.equal(d[d.length - 1].r, 0); assert.equal(d[d.length - 1].d.bb, 3, 'answered with our tails')
  //! now the feeder says bb is at tail 1: the cluster lost 2 and 3 — we are AHEAD of our feeder
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 1 }) })
  assert.equal(h.sentOn(1, VERB.RECORDS).length, 0, 'STILL nothing shipped — a spoke never re-teaches a server')
  assert.notEqual(h.node.resync, null, 'resync begun')
  assert.equal(h.node.state.size, 0, 'the fold reset')
  assert.equal(h.node.logs.size, 0)
  d = h.sentOn(1, VERB.DIGEST).map((f) => f.value as { d: Record<string, number>; r: number })
  assert.deepEqual(d[d.length - 1], { d: {}, r: 1 }, 'an EMPTY r=1 digest: send me everything, then tell me your tails')
  assert.equal(h.of('apply').length, applies0, 'nothing removed downstream yet — the projection waits for the re-download')
  assert.deepEqual(h.jk(JK.resync).map((e) => e.a), [3])
  //! the feeder ships its truth (bb 1 = x) and then replies r=0 → complete: y and z are ghosts
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane(1, ['x']) })
  assert.notEqual(h.node.resync, null, 'a record is not the completion marker — the reply is')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 0 }) })
  assert.equal(h.node.resync, null)
  assert.deepEqual([...h.node.state.keys()], [JSON.stringify(['x'])])
  const removes = h.of('apply').slice(applies0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => r.key[0]).sort()
  assert.deepEqual(removes, ['y', 'z'], 'ghost removes reached the api — exactly the cells that did not come back')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2])
  //! a later digest whose tails cover ours never re-triggers; an r=1 keeps being answered
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 1 }) })
  assert.equal(h.node.resync, null)
  d = h.sentOn(1, VERB.DIGEST).map((f) => f.value as { d: Record<string, number>; r: number })
  assert.deepEqual(d[d.length - 1], { d: { bb: 1 }, r: 0 })
})

//! V4-18 (overlapping cells) at a resync: what the re-download folds downstream, as an object
const resyncing = () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  const lane = (origin: string, seq: number, rec: Rec) => encodeRuns([{ rec, origin, seq, epoch: 1 }])[0]
  const folded = () => {
    const root: Record<string, unknown> = {}
    for (const e of h.of('apply')) {
      const r = e[1] as Rec
      let o = root
      for (let i = 0; i < r.key.length - 1; i++) {
        if (typeof o[r.key[i]] !== 'object' || o[r.key[i]] === null) o[r.key[i]] = {}
        o = o[r.key[i]] as Record<string, unknown>
      }
      if (r.type === REC.remove) delete o[r.key[r.key.length - 1]]
      else o[r.key[r.key.length - 1]] = structuredClone(r.value)
    }
    return root
  }
  return { ...h, lane, folded }
}

test('V4-18 resync — a ghost FIELD under a row the re-download brought back (a row the spoke never held) is covered by that row: no remove tears the field out', () => {
  const h = resyncing()
  //! the spoke holds only a field, from lane xx; its feeder says xx is at tail 0: ahead → resync
  h.node.step({ kind: 'bytesIn', link: 1, bytes: h.lane('xx', 1, { type: REC.update, key: ['g', 'a'], value: 5 }) })
  assert.deepEqual(h.folded(), { g: { a: 5 } })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { xx: 0 }, r: 1 }) })
  assert.notEqual(h.node.resync, null)
  //! the re-download brings the WHOLE row from another lane, nothing on xx, then r=0
  h.node.step({ kind: 'bytesIn', link: 1, bytes: h.lane('bb', 1, { type: REC.update, key: ['g'], value: { a: 1, b: 2 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 0 }) })
  assert.equal(h.node.resync, null)
  assert.deepEqual([...h.node.state], [[JSON.stringify(['g']), { a: 1, b: 2 }]])
  assert.deepEqual(h.folded(), { g: { a: 1, b: 2 } }, 'the row is the truth — the stale field was not removed from it')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [0], 'no ghost: the row covered it')
})

test('V4-18 resync — a ghost ROW whose newer field came back: the row is removed downstream and the field is put back on top', () => {
  const h = resyncing()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: h.lane('bb', 1, { type: REC.update, key: ['g'], value: { a: 1, b: 2 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: h.lane('xx', 1, { type: REC.update, key: ['g', 'a'], value: 9 }) }) // xx > bb at seq 1: newer
  assert.deepEqual(h.folded(), { g: { a: 9, b: 2 } })
  //! the feeder lost lane bb: ahead → resync; the re-download returns only lane xx
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 0, xx: 1 }, r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: h.lane('xx', 1, { type: REC.update, key: ['g', 'a'], value: 9 }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { xx: 1 }, r: 0 }) })
  assert.deepEqual([...h.node.state], [[JSON.stringify(['g', 'a']), 9]])
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [1], 'the row is the one ghost')
  const tail = h.of('apply').slice(-2).map((e) => { const r = e[1] as Rec; return [r.type, r.key] })
  assert.deepEqual(tail, [[REC.remove, ['g']], [REC.update, ['g', 'a']]], 'the ghost remove, then the field re-applied')
  assert.deepEqual(h.folded(), { g: { a: 9 } }, 'the screen shows the field the kernel holds')
})

test('a server drops VIEW/JOIN/PROPOSE/VOTE/LEAVE arriving on a CLIENT link — a spoke never teaches membership: frame dropped, link kept, view untouched; its PULL is still answered', () => {
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.digestFrom(1)
  h.admit(2, 'zz', 1)
  h.digestFrom(2)
  h.tick() // genesis over {aa, bb}; bb's vote commits it
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb' }) })
  assert.equal(h.node.epoch, 1)
  const views = () => h.sentOn(2, VERB.VIEW).length
  const v0 = views() // the install flooded view 1 to the spoke — that direction is right
  //! the I-23 shape: a spoke announcing a HIGHER-epoch view it learned from a cluster that is gone
  const stale: [string, string][] = [['xx', 'sim:xx'], ['yy', 'sim:yy']]
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 7, m: stale }) })
  assert.equal(h.node.epoch, 1, 'a VIEW from a spoke installs nothing')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['aa', 'bb'])
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.JOIN, { u: 'zz', i: 1, l: 'sim:zz' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PROPOSE, { e: 2, m: [...stale, ['zz', 'sim:zz']], p: 'zz' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VOTE, { e: 2, g: 1, ce: 1, h: 'xx,yy,zz' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.LEAVE, {}) })
  assert.deepEqual(h.jk(JK.frameDrop).map((e) => e.b), Array(5).fill('membership from client'), 'every teaching verb dropped, named')
  assert.equal(h.jk(JK.join).length + h.jk(JK.leave).length, 0, 'nothing reached the handlers')
  assert.equal(h.jk(JK.vote).length, 0, 'no ballot was answered')
  assert.equal(h.jk(JK.propose).length, 1, 'no ballot beyond genesis was opened')
  assert.equal(h.sentOn(2, VERB.VOTE).length, 0)
  assert.equal(h.node.links.get(2)!.dead, false, 'the link is kept — a stale spoke is not a wire fault')
  //! a PULL is a question, not a teaching: the spoke asks for the live view and gets it
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PULL, { e: 0 }) })
  assert.equal(views(), v0 + 1, 'answered with the committed view')
  assert.equal(h.jk(JK.frameDrop).length, 5, 'and not dropped')
})

test('a client is a VIEW of the control plane: no view-on-admit, no flood, no PULL answer, no help-a-laggard-up — and it adopts an equal-epoch view whose members differ (the cluster re-formed without it)', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  const view = (m: string[]) => encodeControl(VERB.VIEW, { e: 1, m: m.map((u) => [u, `sim:${u}`]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: view(['aa', 'bb']) })
  assert.equal(h.node.epoch, 1, 'the spoke learned the view')
  assert.equal(h.sentOn(1, VERB.VIEW).length, 0, 'the install flooded nothing back')
  h.admit(2, 'bb') // a second server: a MEMBER would announce its view on this admit
  assert.equal(h.sentOn(2, VERB.VIEW).length, 0, 'no view-on-admit from a spoke')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PULL, { e: 0 }) })
  assert.equal(h.sentOn(2, VERB.VIEW).length, 0, 'a PULL goes unanswered — the view is hearsay here')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 0, m: [['bb', 'sim:bb']] }) })
  assert.equal(h.sentOn(2, VERB.VIEW).length, 0, 'a lower-epoch VIEW is not "helped up" — the reborn-member poison, I-23')
  assert.equal(h.node.epoch, 1)
  //! the cluster re-formed without it under fresh uuids and reused the epoch number: adopt, do not refuse
  h.node.step({ kind: 'bytesIn', link: 1, bytes: view(['cc', 'dd']) })
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['cc', 'dd'], 'the members row heals')
  assert.equal(h.node.epoch, 1)
  assert.deepEqual(h.jk(JK.viewInstall).map((e) => e.a), [1, 1], 'two installs at the one epoch')
  assert.deepEqual(h.jk(JK.evict).map((e) => e.a), ['aa', 'bb'], 'the dead ids left the row')
  assert.deepEqual(h.of('connect').slice(-2).map((e) => e[1]), ['sim:cc', 'sim:dd'], 'and the spoke dials the live members')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: view(['cc', 'dd']) })
  assert.equal(h.jk(JK.viewInstall).length, 2, 'the same view again is a no-op')
  assert.equal(h.sentOn(1, VERB.VIEW).length + h.sentOn(2, VERB.VIEW).length, 0, 'through all of it the spoke sent no VIEW')
  //! a client FOLLOWS ITS FEEDER (I-23, amended 2026-10-08): a LOWER number from the primary with other
  // members is the cluster reborn from scratch — adopt it; `epoch` on a client is the feeder's number
  const at = (e: number, m: string[]) => encodeControl(VERB.VIEW, { e, m: m.map((u) => [u, `sim:${u}`]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: at(3, ['cc', 'dd']) })
  assert.equal(h.node.epoch, 3, 'pushed to 3 by the feeder')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: at(1, ['ee', 'ff']) })
  assert.equal(h.node.epoch, 3, 'a non-primary\'s lower view teaches nothing: "higher only" there')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['cc', 'dd'])
  h.node.step({ kind: 'bytesIn', link: 1, bytes: at(1, ['ee', 'ff']) })
  assert.equal(h.node.epoch, 1, 'the feeder says 1: the spoke follows it down')
  assert.deepEqual(h.node.membership.view.members.map((m) => m[0]), ['ee', 'ff'], 'and shows the reborn cluster')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: at(0, ['gg']) })
  assert.equal(h.node.epoch, 1, 'epoch 0 is open genesis, never a view to adopt — even from the feeder')
  assert.equal(h.sentOn(1, VERB.VIEW).length + h.sentOn(2, VERB.VIEW).length, 0, 'still no VIEW sent')
})

test("a client's writable is its feeder's gate (I-33): the DIGEST reply carries w on client links only, the client reads it off its PRIMARY, and forgets it on failover", () => {
  //! the client side: w on the primary's digest flips feederOpen; a non-primary's w teaches nothing
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  assert.equal(h.node.feederOpen, null, 'no feeder yet: unknown')
  h.admit(1, 'aa')
  h.admit(2, 'bb')
  const digest = (link: number, w?: number) =>
    h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, w === undefined ? { d: {}, r: 0 } : { d: {}, r: 0, w }) })
  digest(1)
  assert.equal(h.node.feederOpen, null, 'a digest without w (an older server) leaves it unknown')
  digest(1, 1)
  assert.equal(h.node.feederOpen, true, "the primary says its gate is open")
  digest(2, 0)
  assert.equal(h.node.feederOpen, true, 'a non-primary says closed: not my feeder, nothing changes')
  digest(1, 0)
  assert.equal(h.node.feederOpen, false, 'the primary says closed')
  digest(1, 1)
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.equal(h.node.feederOpen, null, "failover: the new feeder's gate is unknown until it digests")
  digest(2, 1)
  assert.equal(h.node.feederOpen, true)
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(h.node.primary, null)
  assert.equal(h.node.feederOpen, null, 'no feeder at all: unknown')
  //! the server side: its digests carry w toward a CLIENT link only — member frames are unchanged
  const s = harness('aa')
  s.admit(1, 'bb')
  s.admit(2, 'zz', 1)
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  s.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  const member = s.sentOn(1, VERB.DIGEST).map((f) => f.value as Record<string, unknown>)
  const client = s.sentOn(2, VERB.DIGEST).map((f) => f.value as Record<string, unknown>)
  assert.ok(member.length >= 1 && member.every((v) => !('w' in v)), `member digests carry no w (${JSON.stringify(member)})`)
  assert.deepEqual(client.map((v) => v.w), [1], 'the reply to the client carries the gate: open (epoch 0 is open genesis)')
})

test('a server drops RECORDS arriving on a CLIENT link — a spoke is never a source: frame dropped, link kept, fold untouched', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.digestFrom(1)
  h.admit(2, 'zz', 1)
  h.digestFrom(2)
  const forged = () => encodeRuns([{ rec: { type: REC.update, key: ['forged'], value: 1 } as Rec, origin: 'bb', seq: 9, epoch: 1 }])[0]
  h.node.step({ kind: 'bytesIn', link: 2, bytes: forged() })
  assert.equal(h.node.state.size, 0, 'nothing folded from a spoke')
  assert.deepEqual(h.jk(JK.frameDrop).map((e) => e.b), ['records from client'])
  assert.equal(h.node.links.get(2)!.dead, false, 'the link is kept — stale, not a wire fault')
  //! the same bytes on the MEMBER link are ordinary replication
  h.node.step({ kind: 'bytesIn', link: 1, bytes: forged() })
  assert.equal(h.node.state.size, 1)
})
