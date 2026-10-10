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
  assert.deepEqual(d[d.length - 1], { d: {}, r: 1, q: 2 }, 'an EMPTY r=1 digest: send me everything, then tell me your tails (q: the ask the end must answer — DESIGN-SCALE stage 2)')
  assert.equal(h.of('apply').length, applies0, 'nothing removed downstream yet — the projection waits for the re-download')
  assert.deepEqual(h.jk(JK.resync).map((e) => e.a), [3])
  //! the feeder ships its truth (bb 1 = x) and then replies r=0 → complete: y and z are ghosts. The reply carries no
  // q here: an OLDER server's reply, which still ends the resync (V4-14, the compatibility path)
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

//! ── DESIGN-SCALE stage 2 (2026-10-10): the spoke's resync across a failover — the three STATUS lines the parked
// branch w5b/a11 probed, rebuilt here as tests on the design that landed. (1) A resync ends only on the reply to a
// digest sent after it began: every r=1 a client sends carries `q`, a server's r=0 toward a client echoes it, and
// what a stale reply shipped stays in the fold. (2) A client in resync announces d = {} on every digest, and
// answers a feeder's r=1 with an r=1 of its own once its ask is a tick old (the paused-feeder late end). (3) A client
// of a SCOPED feeder resyncs at every failover (its tails say nothing about what the next feeder holds below them).
const lane = (origin: string, from: number, keys: string[]) =>
  encodeRuns(keys.map((k, i) => ({ rec: { type: REC.update, key: [k], value: k } as Rec, origin, seq: from + i, epoch: 1 })))[0]
const digests = (h: ReturnType<typeof harness>, link: number) => h.sentOn(link, VERB.DIGEST).map((f) => f.value as { d: Record<string, number>; r: number; q?: number })
//! screenOf — the downstream object: every `apply` effect folded in order (what the api's proxy would show)
const screenOf = (h: ReturnType<typeof harness>): string[] => {
  const root: Record<string, unknown> = {}
  for (const e of h.of('apply')) { const r = e[1] as Rec; if (r.type === REC.remove) delete root[r.key[0]]; else root[r.key[0]] = r.value }
  return Object.keys(root).sort()
}
const cells = (h: ReturnType<typeof harness>): string[] => [...h.node.state.keys()].map((c) => (JSON.parse(c) as string[])[0]).sort()
//! serve — a feeder answering the spoke's digest number `which` on `link` (default: the last one sent) the way node.ts's
// server arm does: for every lane it holds, the entries above the tail the spoke announced, then the r=0 reply with the
// asker's q echoed. The test decides what the feeder holds; the kernel under test decides what it asks for.
type Held = Record<string, string[]> // lane → keys at seq 1..n (the value is the key)
const serve = (h: ReturnType<typeof harness>, link: number, held: Held, which = -1) => {
  const ds = digests(h, link)
  const ask = ds[which < 0 ? ds.length - 1 : which]
  const d: Record<string, number> = {}
  for (const [origin, keys] of Object.entries(held)) {
    d[origin] = keys.length
    const from = ask.d[origin] ?? 0
    if (from < keys.length) h.node.step({ kind: 'bytesIn', link, bytes: lane(origin, from + 1, keys.slice(from)) })
  }
  h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d, r: 0, q: ask.q, w: 1 }) })
}
//! a SCOPED server's HELLO: the api's contract with replicas=2 and the kernel's ring label
const SCOPED = 'v1;heartbeat.ms=50;replicas=2;methods=0;validation=none;ring=fmix32'
const admitScoped = (h: ReturnType<typeof harness>, link: number, u: string) => {
  h.node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
  h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}`, c: SCOPED }) })
}

test("two digests crossing at a failover: the reply to the OLDER digest is not the resync's end (what it shipped stays); the end is the reply that echoes the resync's own q, after the re-download", () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  assert.deepEqual(digests(h, 1), [{ d: {}, r: 1, q: 1 }], 'every r=1 a client sends carries a fresh q')
  h.digestFrom(1)
  h.admit(2, 'bb')
  //! feeder aa ships lane bb 1..3 (x, y, z); the cluster then loses 2 and 3 with aa
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('bb', 1, ['x', 'y', 'z']) })
  assert.equal(h.node.state.size, 3)
  const applies0 = h.of('apply').length
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2, 'failover to bb')
  assert.deepEqual(digests(h, 2), [{ d: { bb: 3 }, r: 1, q: 2 }], 'the failover digest #0, q=2 (an unscoped feeder: the real tails)')
  //! bb's own r=1 crosses #0: bb is at bb:1 and holds lane cc:1 the spoke never had → the spoke is AHEAD → resync
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 1 }, r: 1, w: 1 }) })
  assert.notEqual(h.node.resync, null, 'resync begun')
  assert.equal(h.node.resync!.q, 3)
  assert.equal(h.node.state.size, 0, 'the fold reset')
  assert.deepEqual(digests(h, 2)[1], { d: {}, r: 1, q: 3 }, 'the resync asks with its own q (#1)')
  //! bb answers #0 first: its ship for #0 (what the spoke's d={bb:3} lacked: cc:1 = w), then the r=0 echoing q=2
  h.node.step({ kind: 'bytesIn', link: 2, bytes: lane('cc', 1, ['w']) })
  assert.deepEqual([...h.node.state.keys()], [JSON.stringify(['w'])], "the stale ship's record lands like any record (the spoke cannot tell whose ask it answers yet)")
  assert.equal(h.node.streams.get('cc')!.applied, 1, 'and lifts the lane watermark')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 1 }, r: 0, q: 2, w: 1 }) })
  assert.notEqual(h.node.resync, null, 'a reply to a digest sent BEFORE the resync began is not its end')
  assert.equal(h.node.resync!.q, 3, 'the ask the end must answer is unchanged')
  assert.deepEqual([...h.node.state.keys()], [JSON.stringify(['w'])], "the stale ship's record stays: the feeder's committed truth, which the re-download re-sends")
  assert.equal(h.of('apply').slice(applies0).filter((e) => (e[1] as Rec).type === REC.remove).length, 0, 'no ghost sweep yet: nothing removed downstream')
  //! the re-download for #1: everything bb holds (bb:1 = x, and cc:1 = w again — a duplicate the lane drops), then the r=0 echoing q=3
  const applies1 = h.of('apply').length
  h.node.step({ kind: 'bytesIn', link: 2, bytes: lane('bb', 1, ['x']) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: lane('cc', 1, ['w']) })
  assert.deepEqual(h.of('apply').slice(applies1).map((e) => (e[1] as Rec).key[0]), ['x'], 'w is not applied twice: the lane already holds cc:1')
  assert.deepEqual(h.jk(JK.dupDrop).map((e) => [e.a, e.b]), [['cc', 1]], 'the duplicate dropped at the fence')
  assert.notEqual(h.node.resync, null, 'a record is not the completion marker')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 1 }, r: 0, q: 3, w: 1 }) })
  assert.equal(h.node.resync, null, 'ended on the reply to its own ask')
  assert.deepEqual([...h.node.state.keys()].sort(), [JSON.stringify(['w']), JSON.stringify(['x'])])
  const removes = h.of('apply').slice(applies0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => r.key[0]).sort()
  assert.deepEqual(removes, ['y', 'z'], 'the ghost sweep ran once, after the re-download: exactly the cells that did not come back')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2])
  assert.deepEqual(screenOf(h), cells(h), 'the screen shows exactly what the kernel holds')
})

test('a resync whose reply never comes (the feeder dies) ends on the reply to the failover\'s new digest — no hang', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  h.admit(2, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('bb', 1, ['x', 'y']) })
  //! aa says bb is at tail 1 → resync (q=2) asked of aa … which dies before it answers
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 1 }) })
  assert.equal(h.node.resync!.q, 2)
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.notEqual(h.node.resync, null, 'the resync survives the failover')
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 3 }], 'the failover digest asks for everything (in resync) with a newer q')
  //! bb re-downloads (bb:1 = x) and answers the failover digest: q=3 ≥ 2 — the end
  h.node.step({ kind: 'bytesIn', link: 2, bytes: lane('bb', 1, ['x']) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 0, q: 3 }) })
  assert.equal(h.node.resync, null)
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [1], 'one ghost: y')
})

test('the echo: a server\'s r=0 toward a client carries the q of the r=1 it answers; a member\'s digest has none, and its reply none (member bytes unchanged)', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  const toMember = digests(h, 1)
  assert.deepEqual(toMember.map((x) => x.r), [1, 0], "aa's opener (aa < bb) and its reply to bb's r=1")
  assert.ok(toMember.every((x) => !('q' in x)), 'no q toward a member, either way')
  h.admit(2, 'zz', 1)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 7 }) })
  const toClient = digests(h, 2)
  assert.equal(toClient.length, 1)
  assert.equal(toClient[0].q, 7, 'the asker\'s q, echoed')
  assert.equal(toClient[0].r, 0)
  //! an older client that sends no q gets no q back — and a spoke that gets none ends its resync as before
  h.admit(3, 'zy', 1)
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  assert.equal('q' in digests(h, 3)[0], false)
})

//! the second review of the parked fix (kernel probe A): the stale ship's records RAISE the lane tail the spoke holds.
// A spoke in resync must not announce them: a digest it sends before the re-download has landed would ask only for
// what is ABOVE that raised tail, and a feeder that holds the lane in full would never send the rows below it. So
// every digest a client sends while in resync announces d = {}. Here: the spoke holds lane bb = x,y,z and lane
// cc = u,v from aa; it fails over to bb, whose own r=1 crosses (bb is behind on lane bb, ahead on cc: cc:3-4 =
// w1,w2) → resync (q=3). bb's stale ship for the failover digest brings cc:3-4 and raises cc to 4. bb dies before
// the re-download; dd holds everything. Before the fix the failover digest said {cc: 4}, dd shipped only x, its
// reply ended the resync, and the ghost sweep removed u and v — rows dd holds live, lost for good.
test('kernel probe A — a second failover during the re-download onto a feeder that holds every lane: the spoke in resync asks for EVERYTHING (d = {}), so nothing the stale ship raised the tail over is lost', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb', 'sim:dd'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  h.admit(2, 'bb')
  h.admit(3, 'dd')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('bb', 1, ['x', 'y', 'z']) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('cc', 1, ['u', 'v']) })
  assert.deepEqual(cells(h), ['u', 'v', 'x', 'y', 'z'])
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2, 'failover to bb')
  assert.deepEqual(digests(h, 2), [{ d: { bb: 3, cc: 2 }, r: 1, q: 2 }], 'the failover digest #0 announces the real tails: not in resync yet')
  //! bb's own r=1 crosses #0: behind on bb (1 < 3), ahead on cc (4) → resync, q=3
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.equal(h.node.resync!.q, 3)
  assert.deepEqual(digests(h, 2)[1], { d: {}, r: 1, q: 3 })
  //! bb answers #0 first: the stale ship (cc above 2 = w1, w2) and the stale reply (q=2), which is not the end
  serve(h, 2, { bb: ['x'], cc: ['u', 'v', 'w1', 'w2'] }, 0)
  assert.notEqual(h.node.resync, null, 'the stale reply is not the end')
  assert.deepEqual(cells(h), ['w1', 'w2'], "the stale ship's records are in the fold")
  assert.equal(h.node.streams.get('cc')!.applied, 4, 'and the lane tail is raised to 4 with nothing under it')
  //! bb dies before the re-download; dd holds everything. The failover digest must ask for everything.
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(h.node.primary, 3, 'failover to dd')
  serve(h, 3, { bb: ['x'], cc: ['u', 'v', 'w1', 'w2'] })
  assert.equal(h.node.resync, null, "ended on the reply to the failover's digest (q=4 ≥ 3)")
  assert.deepEqual(cells(h), ['u', 'v', 'w1', 'w2', 'x'], 'the truth: everything dd holds (u and v are live at dd and must not be lost)')
  assert.deepEqual(screenOf(h), ['u', 'v', 'w1', 'w2', 'x'], 'the screen shows the same')
  assert.deepEqual(digests(h, 3), [{ d: {}, r: 1, q: 4 }], 'how: a spoke in resync announces NO tails — the raised cc tail would have hidden u and v')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2], 'ghosts: y and z only')
  assert.deepEqual(h.jk(JK.dupDrop).map((e) => [e.a, e.b]), [['cc', 3], ['cc', 4]], 'the re-download re-sent w1 and w2; the lane dropped them')
  //! dd's next digest shows nothing the spoke is ahead on: no second resync, and none is needed
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.equal(h.node.resync, null)
  const ds = digests(h, 3)
  assert.deepEqual(ds[ds.length - 1], { d: { bb: 1, cc: 4 }, r: 0 }, 'out of resync, the spoke announces its real tails again')
})

//! the paused feeder (STATUS: "A spoke in resync whose ask reached a paused feeder ends it late"): the feeder marks
// the debt and does not reply; after the drain it asks the spoke with its own r=1. A spoke whose ask is a tick old
// answers that r=1 with an r=1 of its own (a fresh q): the feeder ships everything and replies with that q — the end,
// one exchange after the drain, never waiting for a heartbeat floor the spoke may not own. Inside the ask's first tick
// a feeder's r=1 gets no answer at all (the crossing test below): an r=0 with d = {} made the feeder ship twice.
test('kernel probe B — the resync ask reached a paused feeder: once the ask is a tick old the spoke answers the drain r=1 with an r=1 of its own, the feeder ships everything and its reply ends the resync — nothing lost, the sweep one tick late at most', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:dd'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.digestFrom(1)
  h.admit(2, 'dd')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('bb', 1, ['x', 'y', 'z']) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('cc', 1, ['u', 'v']) })
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2, 'failover to dd')
  //! dd's own r=1 crosses the failover digest #0 → resync (q=3); dd answers #0 first: cc:3-4, then the stale reply
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.equal(h.node.resync!.q, 3)
  assert.deepEqual(digests(h, 2).slice(-1), [{ d: {}, r: 1, q: 3 }], 'the r=1 that began the resync is answered by the resync\'s own ask (one frame, no separate r=0)')
  serve(h, 2, { bb: ['x'], cc: ['u', 'v', 'w1', 'w2'] }, 0)
  assert.notEqual(h.node.resync, null)
  assert.equal(h.node.streams.get('cc')!.applied, 4, 'the stale ship raised the cc tail')
  //! the resync's r=1 (#1) reached dd on a paused link: no reply. A tick passes; after the drain dd asks with its own r=1.
  h.tick()
  assert.equal(h.node.resync!.ticks, 1)
  const sent = digests(h, 2).length
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2).slice(sent), [{ d: {}, r: 1, q: 5 }], 'an ask a tick old: the feeder\'s request is answered with a request — everything, with a fresh q')
  //! dd ships everything and replies with that q: the end, with u and v back
  serve(h, 2, { bb: ['x'], cc: ['u', 'v', 'w1', 'w2'] })
  assert.equal(h.node.resync, null, 'ended on the reply to the spoke\'s answer-request')
  assert.deepEqual(cells(h), ['u', 'v', 'w1', 'w2', 'x'], 'nothing is lost: u and v arrived')
  assert.deepEqual(screenOf(h), ['u', 'v', 'w1', 'w2', 'x'], 'the screen shows the same: y and z swept, nothing else')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2])
  //! out of resync, a feeder's r=1 is answered r=0 with the real tails again
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2).slice(-1), [{ d: { bb: 1, cc: 4 }, r: 0 }])
})

//! STATUS: "A scoped spoke that fails over never receives the rows its new feeder holds below a lane tail it learned
// from the old feeder." Under scoping each holder's copy of a lane is sparse: the old feeder P gave the spoke lane
// T's HIGH rows (partition A); the new feeder O holds lane T's LOW rows (partition B, which P did not hold). The
// failover digest's tail {T: high} asked O for nothing below it: B never arrived, and A stayed on the screen though O
// does not hold it. Now a client of a SCOPED feeder (feederScoped: `replicas=` in the feeder's HELLO contract)
// RESYNCS at every failover: wipe, d = {}, the new feeder's held subset comes back, the rest is swept.
test('a client of a SCOPED feeder resyncs at every failover: the new feeder\'s rows below the old tail arrive, the old feeder\'s rows the new one does not hold are swept, the screen equals the kernel; an UNSCOPED feeder\'s failover still asks with the real tails', () => {
  const h = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  h.node.step({ kind: 'start' })
  admitScoped(h, 1, 'pp')
  assert.equal(h.node.feederScoped, true, 'the feeder\'s contract says replicas=2')
  h.digestFrom(1)
  admitScoped(h, 2, 'oo')
  //! P ships lane T's high rows: partition A at seqs 5-6 (P holds A, not B)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('tt', 5, ['a1', 'a2']) })
  assert.deepEqual(cells(h), ['a1', 'a2'])
  assert.equal(h.node.streams.get('tt')!.applied, 6, 'the spoke\'s lane T tail is 6')
  //! P dies: the failover onto O is a RESYNC — wipe, d = {}, a fresh q
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.notEqual(h.node.resync, null, 'a scoped failover begins a resync')
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2 }], 'the failover digest asks for EVERYTHING, not for what is above tail 6')
  assert.deepEqual(h.jk(JK.resync).map((e) => e.a), [2], 'two cells held at the reset')
  //! O holds lane T's LOW rows (partition B at seqs 1-3) and nothing of A: they come back, A is swept
  serve(h, 2, { tt: ['b1', 'b2', 'b3'] })
  assert.equal(h.node.resync, null, 'ended on the reply to the failover\'s own ask')
  assert.deepEqual(cells(h), ['b1', 'b2', 'b3'], 'B: the rows below the old tail that O holds (0 of them arrived before)')
  assert.deepEqual(screenOf(h), ['b1', 'b2', 'b3'], 'A swept from the screen: O does not hold it; the screen equals the kernel')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2], 'two ghosts: a1, a2')
  //! the UNSCOPED control: no contract on the feeder — the failover digest carries the real tails, as before
  const u = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  u.node.step({ kind: 'start' })
  u.admit(1, 'pp')
  assert.equal(u.node.feederScoped, false)
  u.digestFrom(1)
  u.admit(2, 'oo')
  u.node.step({ kind: 'bytesIn', link: 1, bytes: lane('tt', 5, ['a1', 'a2']) })
  u.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(u.node.resync, null, 'unscoped: no resync at a failover')
  assert.deepEqual(digests(u, 2), [{ d: { tt: 6 }, r: 1, q: 2 }], 'the real tails: the new feeder holds every lane in full and ships what is above')
})

//! the review of stage 2 (2026-10-10): at a scoped failover the new feeder's heartbeat r=1 is often already in flight
// when the ask leaves (the feeder floors the spoke every tick when its uuid sorts below), so it crosses the ask. The
// spoke answered it r=0 — and in resync a spoke says d = {} — so the feeder shipped its WHOLE held subset a second
// time, on 30 of 30 tick-aligned seeds (the lane dropped the duplicates; the cost was a second download). Now a
// crossing inside the ask's first tick gets no answer: the ask's reply is the end. Red on the old kernel at the first
// assertion below (a second digest {d: {}, r: 0} on the link).
test('a feeder\'s r=1 that crosses the resync\'s ask inside its first tick gets NO answer (the ask\'s reply is the end; an r=0 with d = {} made the feeder re-ship its held subset); out of resync it is answered as before; a scoped feeder elected at an ADMIT (the last one died with no other link up) is a resync too — the failover bug\'s second path', () => {
  const h = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  h.node.step({ kind: 'start' })
  admitScoped(h, 1, 'pp')
  h.digestFrom(1)
  admitScoped(h, 2, 'oo')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('tt', 5, ['a1', 'a2']) })
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2 }], 'the ask, at the failover')
  //! oo's heartbeat r=1 crosses it (ticks 0): read for its gate, answered with nothing
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { tt: 3 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2 }], 'the crossing r=1 got no answer: the ask is on its way and its reply is the end (an r=0 with d = {} would re-ship everything)')
  assert.notEqual(h.node.resync, null, 'still in resync')
  assert.equal(h.node.feederOpen, true, 'the crossing digest was still read: the gate rides it')
  //! oo serves the ask: the end, after exactly one ship
  serve(h, 2, { tt: ['b1', 'b2', 'b3'] })
  assert.equal(h.node.resync, null)
  assert.deepEqual(cells(h), ['b1', 'b2', 'b3'])
  //! out of resync, a feeder's r=1 is answered r=0 with the real tails
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { tt: 3 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2).slice(-1), [{ d: { tt: 3 }, r: 0 }])
  //! the SECOND path of the scoped-failover bug (this test's first run found it): the feeder dies with no other link
  // up, and a feeder is admitted later — the admit elected it and asked with the REAL tails (d = {tt: 3}), so the
  // rows it holds below tail 3 would never have come and b1-b3 would have stayed on the screen. A scoped spoke that
  // holds anything resyncs here too.
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(h.node.primary, null, 'no other link up: no primary')
  admitScoped(h, 3, 'oo')
  assert.equal(h.node.primary, 3)
  assert.notEqual(h.node.resync, null, 'a scoped feeder elected at the admit: the spoke resyncs onto it (it held three rows from the last one)')
  assert.deepEqual(digests(h, 3), [{ d: {}, r: 1, q: 3 }], 'the ask asks for everything, not for what is above tail 3')
  assert.deepEqual(h.jk(JK.resync).map((e) => e.a), [2, 3], 'the two resets remembered their cells (a1-a2, then b1-b3)')
  //! a tick-old ask (kernel probe B's rule, unchanged): the feeder's r=1 is answered with an r=1 of the spoke's own.
  // The tick itself floors the primary (cl sorts below oo): that r=1 is q=4, in resync d = {}; the answer-request is q=5
  h.tick()
  assert.equal(h.node.resync!.ticks, 1)
  assert.deepEqual(digests(h, 3).slice(-1), [{ d: {}, r: 1, q: 4 }], 'the tick\'s own heartbeat floor, in resync: d = {}')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { tt: 1 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 3).slice(-1), [{ d: {}, r: 1, q: 5 }], 'a tick old: answered with a request of its own, as before')
  serve(h, 3, { tt: ['c1'] })
  assert.equal(h.node.resync, null)
  assert.deepEqual(cells(h), ['c1'], 'the new feeder\'s subset; b1-b3 swept')
  assert.deepEqual(screenOf(h), ['c1'], 'kernel and screen agree')
  //! a spoke that holds NOTHING yet asks its first feeder as before: no wipe, no journal row, the same bytes
  const f = harness('cl', { client: true, hosts: ['sim:pp'] })
  f.node.step({ kind: 'start' })
  admitScoped(f, 1, 'pp')
  assert.equal(f.node.resync, null, 'a first feeder: nothing to resync')
  assert.deepEqual(digests(f, 1), [{ d: {}, r: 1, q: 1 }])
  assert.deepEqual(f.jk(JK.resync), [])
  //! the UNSCOPED control on this path: the real tails at the re-admit, as before
  const u = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  u.node.step({ kind: 'start' })
  u.admit(1, 'pp')
  u.digestFrom(1)
  u.node.step({ kind: 'bytesIn', link: 1, bytes: lane('tt', 5, ['a1', 'a2']) })
  u.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(u.node.primary, null)
  u.admit(2, 'oo')
  assert.equal(u.node.resync, null, 'unscoped: no resync at a re-admit')
  assert.deepEqual(digests(u, 2), [{ d: { tt: 6 }, r: 1, q: 2 }], 'the real tails: an unscoped feeder holds every lane in full')
})

test('a scoped failover MID-RESYNC keeps every cell of the first reset in the sweep set (the screen still shows them) and wipes the partial re-download: the end sweeps exactly what the third feeder does not hold — no screen-only ghost', () => {
  const h = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo', 'sim:tt'] })
  h.node.step({ kind: 'start' })
  admitScoped(h, 1, 'pp')
  h.digestFrom(1)
  admitScoped(h, 2, 'oo')
  admitScoped(h, 3, 'tt')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: lane('bb', 1, ['x', 'y', 'z']) })
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.equal(h.node.resync!.q, 2, 'resync onto oo')
  //! oo's re-download is landing (w arrives) when oo dies too: the failover onto tt begins the resync again
  h.node.step({ kind: 'bytesIn', link: 2, bytes: lane('cc', 1, ['w']) })
  assert.deepEqual(cells(h), ['w'])
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(h.node.primary, 3)
  assert.equal(h.node.resync!.q, 3, 'a new ask')
  assert.deepEqual([...h.node.resync!.old].map((c) => (JSON.parse(c) as string[])[0]).sort(), ['w', 'x', 'y', 'z'], 'the sweep set is the union: the first reset\'s cells and the partial re-download\'s')
  assert.deepEqual(cells(h), [], 'the fold is wiped again: tt\'s held subset is the truth')
  //! tt holds x only: the end sweeps y, z and w — from the screen too
  serve(h, 3, { bb: ['x'] })
  assert.equal(h.node.resync, null)
  assert.deepEqual(cells(h), ['x'])
  assert.deepEqual(screenOf(h), ['x'], 'w, y and z are gone from the screen: no screen-only ghost')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [3])
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
