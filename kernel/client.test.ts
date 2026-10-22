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
import { SCOPE } from './scope.ts'
import { Framer, VERB, encodeControl, encodeRuns } from './codec.ts'
import { REC, TAG, type EffectSink, type Env, type Rec } from './env.ts'
import { tornFeeder } from '../tools/perf/fixtures.ts'

//! onSend (the torn-ship tests): called after every send, so a test can step `pause` from INSIDE a send — the way the
// shell does when the socket says its buffer is full (shell/runtime.ts).
const harness = (uuid: string, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}, onSend?: (link: number) => void) => {
  const effects: unknown[][] = []
  const sink: EffectSink = {
    connect: (to) => effects.push(['connect', to]),
    send: (link, bytes) => { effects.push(['send', link, bytes]); onSend?.(link) },
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
    acked: (iss, cid, origin, seq, epoch) => effects.push(['acked', iss, cid, origin, seq, epoch]),
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
// what a stale reply shipped stays in the fold. (2) A client in resync announces d = {} on every digest, sends no
// heartbeat floor, and re-asks only on the feeder's drain digest (h: 1) — one ship per resync on any link (the
// paused-feeder late end, and the second review's ship-per-heartbeat on a slow link). (3) A client of a SCOPED
// feeder resyncs at every failover (its tails say nothing about what the next feeder holds below them).
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
// the debt and does not reply; after the drain it asks the spoke with its own r=1, which says h: 1 (this link dropped
// frames — the ask swallowed, or its reply dropped with the ship). A spoke in resync answers THAT r=1 with an r=1 of
// its own (a fresh q), at any age of the ask: the feeder ships everything and replies with that q — the end, one
// exchange after the drain. Every other r=1 from the feeder in resync (its heartbeat floor, sent before it handled
// the ask) gets no answer, and the spoke sends no floor of its own while in resync. The second review of stage 2
// measured the tick-age proxy that stood here (a floor every tick; a feeder's r=1 answered once the ask was a tick
// old): one ship on a normal link, 5 and 9 ships on a link slower than one heartbeat. Red on that kernel at the first
// assertion after the drain digest (the drain r=1 inside the first tick got no answer) and at the tick (a floor).
test('kernel probe B — the resync ask reached a paused feeder: the spoke answers the drain digest (h: 1) with an r=1 of its own at once, the feeder ships everything and its reply ends the resync — nothing lost; a heartbeat r=1 gets no answer and the spoke sends no floor while in resync', () => {
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
  //! the resync's r=1 (#1) reached dd on a paused link: no reply. dd drains inside the ask's first tick and asks with its
  // drain digest (h: 1): answered at once with a request of the spoke's own
  const sent = digests(h, 2).length
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1, h: 1 }) })
  assert.deepEqual(digests(h, 2).slice(sent), [{ d: {}, r: 1, q: 4 }], 'the drain digest is answered with a request: everything, with a fresh q — whatever the age of the ask')
  //! a heartbeat passes: cl sorts below dd, so out of resync it floors dd — in resync it sends nothing
  h.tick()
  assert.equal(digests(h, 2).length, sent + 1, 'no heartbeat floor in resync: the ask is the floor')
  //! dd's heartbeat r=1 (no h) lands before its reply: sent before dd handled the ask, so it gets no answer
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.equal(digests(h, 2).length, sent + 1, 'a feeder r=1 without h in resync: no answer (an r=0 would say d = {} and buy a second ship)')
  //! dd ships everything and replies to the answer-request (q=4): the end, with u and v back
  serve(h, 2, { bb: ['x'], cc: ['u', 'v', 'w1', 'w2'] })
  assert.equal(h.node.resync, null, 'ended on the reply to the spoke\'s answer-request')
  assert.deepEqual(cells(h), ['u', 'v', 'w1', 'w2', 'x'], 'nothing is lost: u and v arrived')
  assert.deepEqual(screenOf(h), ['u', 'v', 'w1', 'w2', 'x'], 'the screen shows the same: y and z swept, nothing else')
  assert.deepEqual(h.jk(JK.resynced).map((e) => e.a), [2])
  //! out of resync, a feeder's r=1 is answered r=0 with the real tails again — a drain digest too
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2).slice(-1), [{ d: { bb: 1, cc: 4 }, r: 0 }])
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1, cc: 4 }, r: 1, w: 1, h: 1 }) })
  assert.deepEqual(digests(h, 2).slice(-1), [{ d: { bb: 1, cc: 4 }, r: 0 }], 'a drain digest out of resync: the tails, as any r=1')
  //! and the heartbeat floor is back once the resync is over
  const before = digests(h, 2).length
  h.tick()
  assert.deepEqual(digests(h, 2).slice(before), [{ d: { bb: 1, cc: 4 }, r: 1, q: 5 }], 'out of resync the floor runs again (cl sorts below dd)')
})

//! the drain digest's `h` (the second review of stage 2): a server whose link dropped frames while paused asks after the
// drain with r=1 — toward a CLIENT that r=1 says h: 1, the one signal a spoke in resync re-asks on. A member's drain
// digest is unchanged (no h, no q: member bytes are the golden's).
test('a drain digest toward a CLIENT carries h: 1; toward a member it does not (member bytes unchanged)', () => {
  const h = harness('aa')
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  h.admit(2, 'zz', 1)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  for (const l of [1, 2]) h.node.step({ kind: 'pause', link: l })
  //! each peer's digest arrives mid-pause: the suffix is deferred, the debt marked
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 2 }) })
  assert.ok(h.node.links.get(1)!.droppedWhilePaused && h.node.links.get(2)!.droppedWhilePaused, 'both debts marked')
  const m0 = digests(h, 1).length, c0 = digests(h, 2).length
  for (const l of [1, 2]) h.node.step({ kind: 'drain', link: l })
  assert.deepEqual(digests(h, 1).slice(m0), [{ d: {}, r: 1 }], 'the member\'s drain digest: no h, no q')
  const c = digests(h, 2).slice(c0) as { r: number; h?: number; q?: number }[]
  assert.equal(c.length, 1, 'one drain digest to the client')
  assert.equal(c[0].r, 1)
  assert.equal(c[0].h, 1, 'the client\'s drain digest says h: 1')
  assert.equal('q' in c[0], false, 'a server mints no q')
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
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2, f: 1 }], 'the failover digest asks for EVERYTHING, not for what is above tail 6; `f: 1` asks which partitions are in flight (wave 6c)')
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
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2, f: 1 }], 'the ask, at the failover')
  //! oo's heartbeat r=1 crosses it (ticks 0): read for its gate, answered with nothing
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { tt: 3 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(h, 2), [{ d: {}, r: 1, q: 2, f: 1 }], 'the crossing r=1 got no answer: the ask is on its way and its reply is the end (an r=0 with d = {} would re-ship everything)')
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
  assert.deepEqual(digests(h, 3), [{ d: {}, r: 1, q: 3, f: 1 }], 'the ask asks for everything, not for what is above tail 3')
  assert.deepEqual(h.jk(JK.resync).map((e) => e.a), [2, 3], 'the two resets remembered their cells (a1-a2, then b1-b3)')
  //! a tick passes: in resync the spoke sends NO heartbeat floor (cl sorts below oo; out of resync it floors oo), and oo's
  // heartbeat r=1 gets no answer whatever the ask's age. oo's DRAIN digest (h: 1) is what re-asks: q=4 (kernel probe B)
  const sent = digests(h, 3).length
  h.tick()
  assert.equal(digests(h, 3).length, sent, 'no floor in resync')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { tt: 1 }, r: 1, w: 1 }) })
  assert.equal(digests(h, 3).length, sent, 'a tick old or not, a heartbeat r=1 in resync gets no answer')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { tt: 1 }, r: 1, w: 1, h: 1 }) })
  assert.deepEqual(digests(h, 3).slice(sent), [{ d: {}, r: 1, q: 4, f: 1 }], 'the drain digest: answered with a request of the spoke\'s own')
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

//! wave 5e — the feeder dies between the WACK and the tap (the one residual of V4-33's `acked`). A scoped feeder that
// will tap the record WACKs its spoke with the lane under `l`; the spoke clears the attempt (nothing is re-sent) and
// keeps the coordinates while the record is unseen. At a failover it marks them (strand), and the resync onto the next
// feeder settles each one still unseen at its end, through `acked`, committed on the owner's lane. One whose record
// the next feeder's ship brings folds first and settles through the join (V4-7: the value shows, then the promise).
// Red without the fix: `acked` stays [] after the resync's end and the write waits for ever.
const tapRec = (origin: string, seq: number, key: string, cid: number) =>
  encodeRuns([{ rec: { type: REC.update, key: [key], value: key } as Rec, origin, seq, epoch: 1, iss: 'cl~1', cid }])[0]
test('wave 5e — a spoke whose feeder dies between the WACK (`l`: the lane, the tap will follow) and the tap settles the write at the failover\'s resync end from the WACK\'s coordinates; one the next feeder holds settles through the join; a write the NEW feeder WACKed is not touched; no `l`, nothing kept', () => {
  const h = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  h.node.step({ kind: 'start' })
  admitScoped(h, 1, 'pp')
  h.digestFrom(1)
  admitScoped(h, 2, 'oo')
  //! three writes through pp: px (oo will not hold it), py (oo will), pz (the tap lands before the death)
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['px'], value: 'px' }, { type: REC.update, key: ['py'], value: 'py' }, { type: REC.update, key: ['pz'], value: 'pz' }] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 3, s: 7, e: 1, l: 'tt' }) })
  assert.equal(h.node.writes.pending.size, 0, 'cleared: nothing will be re-sent')
  assert.deepEqual(h.of('acked'), [], 'the WACK with `l` is not the settlement: the tap is')
  assert.deepEqual(h.node.writes.committed('cl~1', 1), { s: 7, e: 1, o: 'tt' }, 'the window names the lane too')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: tapRec('tt', 9, 'pz', 3) })
  assert.ok(h.of('apply').some((e) => (e[1] as { iss?: string; cid?: number }).iss === 'cl~1' && (e[1] as { cid?: number }).cid === 3), 'pz settles through the join')
  //! pp dies before the px and py taps: the failover onto oo is a resync; nothing settles before its end
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 2)
  assert.notEqual(h.node.resync, null)
  assert.deepEqual(h.of('acked'), [], 'not at the failover: oo may hold the record')
  assert.equal(h.sentOn(2, VERB.WRITE).length, 0, 'nothing is re-sent to oo: the WACKed attempts left the queue')
  //! a write after the failover, WACKed by oo with `l`: not stranded, it waits for oo's tap
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['pw'], value: 'pw' }] })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 4, n: 1, s: 12, e: 1, l: 'tt' }) })
  //! oo's ship: it holds py (lane tt seq 8) and not px; the reply ends the resync
  h.node.step({ kind: 'bytesIn', link: 2, bytes: tapRec('tt', 8, 'py', 2) })
  const ds = digests(h, 2)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { tt: 8 }, r: 0, q: ds[ds.length - 1].q, w: 1 }) })
  assert.equal(h.node.resync, null, 'the resync ended')
  assert.ok(h.of('apply').some((e) => (e[1] as { iss?: string; cid?: number }).iss === 'cl~1' && (e[1] as { cid?: number }).cid === 2), 'py: the value showed (the join)')
  assert.deepEqual(h.of('acked'), [['acked', 'cl~1', 1, 'tt', 7, 1]], 'px — and only px — settles from its WACK: committed on the owner\'s lane; py folded, pw is oo\'s to tap')
  //! a second failover later: nothing is left marked from the first, and pw (oo's) is marked now
  admitScoped(h, 3, 'qq')
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(h.node.primary, 3)
  const ds3 = digests(h, 3)
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0, q: ds3[ds3.length - 1].q, w: 1 }) })
  assert.deepEqual(h.of('acked').slice(1), [['acked', 'cl~1', 4, 'tt', 12, 1]], 'pw settles at the second resync\'s end, once')
  //! no `l` (an unscoped feeder never sends one): nothing is kept, a failover settles nothing — the old bytes
  const u = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  u.node.step({ kind: 'start' })
  u.admit(1, 'pp')
  u.digestFrom(1)
  u.admit(2, 'oo')
  u.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  u.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 7, e: 1 }) })
  u.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  u.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0, q: 2, w: 1 }) })
  assert.equal(u.node.writes.stranded, false)
  assert.deepEqual(u.of('acked'), [], 'unscoped: no `l`, nothing kept, nothing settled by the kernel')
})

//! the failover's SECOND path (node.ts onHello): the feeder dies with no other link up, and the spoke holds NOTHING in
// its fold (its only write was never tapped). A scoped spoke that holds nothing asks its next feeder as before — no
// resync — so there would be no end to settle at. A stranded write makes it resync anyway. And the bound: a spoke
// past dedupKeep writes WACKed and untapped settles the evicted one from its coordinates instead of forgetting it.
test('wave 5e — the second failover path (no other link up, an empty fold): a stranded write makes the admit a resync, and its end settles it; past the bound an evicted attempt settles at once', () => {
  const h = harness('cl', { client: true, hosts: ['sim:pp', 'sim:oo'] })
  h.node.step({ kind: 'start' })
  admitScoped(h, 1, 'pp')
  h.digestFrom(1)
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['px'], value: 'px' }] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 7, e: 1, l: 'tt' }) })
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, null)
  assert.equal(h.node.logs.size, 0, 'the fold is empty')
  assert.equal(h.node.writes.stranded, true)
  admitScoped(h, 2, 'oo')
  assert.notEqual(h.node.resync, null, 'the admit is a resync: a stranded write needs its end')
  const ds = digests(h, 2)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0, q: ds[ds.length - 1].q, w: 1 }) })
  assert.deepEqual(h.of('acked'), [['acked', 'cl~1', 1, 'tt', 7, 1]])
  assert.equal(h.node.writes.stranded, false)
  //! a kept attempt that a relay's SECOND WACK (with `o`: the partition moved off the relay) settles leaves the map:
  // the next failover's resync end does not settle it again
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['pv'], value: 'pv' }] })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 2, n: 1, s: 9, e: 1, l: 'tt' }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 2, n: 1, s: 9, e: 1, o: 'tt' }) })
  assert.deepEqual(h.of('acked').slice(1), [['acked', 'cl~1', 2, 'tt', 9, 1]], 'settled by the second WACK')
  admitScoped(h, 3, 'qq')
  h.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  const d3 = digests(h, 3)
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0, q: d3[d3.length - 1].q, w: 1 }) })
  assert.equal(h.of('acked').length, 2, 'and never again at the next resync\'s end')
  //! the bound (dedupKeep 2): the third untapped WACK evicts the first, which settles from its coordinates
  const b = harness('cl', { client: true, hosts: ['sim:pp'], tune: { dedupKeep: 2 } })
  b.node.step({ kind: 'start' })
  admitScoped(b, 1, 'pp')
  b.digestFrom(1)
  b.node.step({ kind: 'write', recs: [1, 2, 3].map((i) => ({ type: REC.update, key: ['k' + i], value: i })) })
  b.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 3, s: 7, e: 1, l: 'tt' }) })
  assert.deepEqual(b.of('acked'), [['acked', 'cl~1', 1, 'tt', 7, 1]], 'the oldest settles when the bound evicts it')
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

test("a client's writable is its feeder's gate (I-33): the DIGEST reply carries w on client links only, the client reads it off its PRIMARY, and keeps every server's last word on its link across a failover (wave 6b)", () => {
  //! the client side: w on the primary's digest flips feederOpen; a non-primary's w does not change feederOpen but is
  // kept on its link (wave 6b: the word that drives the move, and what a failover to that link reads at once)
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
  assert.equal(h.node.feederOpen, false, "failover: the new feeder's gate is what it last said (wave 6b: every server's word is kept on its link) — bb said closed")
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

//! ── the third re-check of stage 2 (2026-10-10): a TORN answer. The shell steps `pause` inside a send, so a feeder's
// link can pause partway through the suffix ship that answers a digest, and its bounded queue overflow before the ship
// ends (kernel/link.ts ship clears the WHOLE queue). Before: the ship loop ran on past the clear, the r=0 reply went
// out with the ship's last frames, the spoke ended its resync on it and swept the hole's rows as ghosts, and its tails
// — above the hole — made the drain's h: 1 exchange ship nothing: 5 of 10 rows lost for good with a queue of 4, 257
// of 600 at the default bound. Now the ship stops at the clear, the link stays unsynced, no reply goes out, and the
// drain resumes the answer from the first frame the socket did not take; the reply follows the whole ship (node.ts
// #answer). These tests drive a REAL feeder Node against a client Node and step `pause` from inside a send, as the
// shell does — the sim cannot (it posts pause and drain between steps), which is why nothing had seen this.
//! Reshaped 2026-10-11 (the resume costs the third re-check recorded): the ship no longer overflows the queue on
// purpose — when the link is paused and the queue full it STOPS before the next frame, so nothing it queued is
// cleared, the drain delivers the queue and then resumes past it, and no drain digest follows (nothing was dropped).
// `torn.d` is the cover the resume answers: the peer's tails raised to what the answer already handed the link.
type H = ReturnType<typeof harness>
//! a lane with Lamport gaps: one frame per record, the shape a held-filtered scoped lane has
const sparse = (origin: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ rec: { type: REC.update, key: [`r${i + 1}`], value: i + 1 } as Rec, origin, seq: 2 * i + 1, epoch: 1 }))
const ROWS = Array.from({ length: 10 }, (_, i) => `r${i + 1}`).sort()
const kinds = (bytes: Uint8Array) => new Framer().push(bytes.slice()).map((f) => (f.verb === VERB.DIGEST ? `DIGEST${JSON.stringify(f.value)}` : f.verb === VERB.RECORDS ? 'RECORDS' : `verb${f.verb}`))
//! a feeder that pauses its link `l` from INSIDE its n-th send after each arm (the socket's "buffer full"), holding
// `rows` sparse records of lane `bb` learned from a member
const feeder = (uuid: string, l: number, opts: Partial<ConstructorParameters<typeof Node>[0]> = {}, seed = sparse('bb', 10)) => {
  let armed = false, count = 0, at = 2
  const F = harness(uuid, opts, (link) => {
    if (link === l && armed && ++count === at) { armed = false; count = 0; F.node.step({ kind: 'pause', link: l }) }
  })
  F.admit(1, 'bb')
  F.digestFrom(1)
  for (const b of encodeRuns(seed)) F.node.step({ kind: 'bytesIn', link: 1, bytes: b })
  assert.equal(cells(F).length, seed.length)
  return { ...F, arm: (n = 2) => { armed = true; count = 0; at = n } }
}
//! a two-way pump between A (its link al) and B (its link bl): every frame sent since the last pump lands on the other
// side, HELLOs excepted (the tests say those by hand); `wire` reads A's frames to B since a mark
const pump = (A: H, al: number, B: H, bl: number) => {
  const sends = (h: H, l: number) => h.of('send').filter((e) => e[1] === l).map((e) => e[2] as Uint8Array)
  const move = (from: H, fl: number, to: H, tl: number, cur: number) => {
    const s = sends(from, fl)
    for (; cur < s.length; cur++) if (new Framer().push(s[cur].slice())[0]?.verb !== VERB.HELLO) to.node.step({ kind: 'bytesIn', link: tl, bytes: s[cur] })
    return cur
  }
  let a = 0, b = 0
  return {
    toB: () => { a = move(A, al, B, bl, a) },
    toA: () => { b = move(B, bl, A, al, b) },
    settle: () => { for (let i = 0; i < 6; i++) { b = move(B, bl, A, al, b); a = move(A, al, B, bl, a) } },
    mark: () => sends(A, al).length,
    wire: (from: number) => sends(A, al).slice(from).flatMap(kinds),
  }
}
const RESHIP = Array(8).fill('RECORDS') // seqs 5..19: the four frames the queue held, then the four the ship stopped before

//! the finding: a scoped failover's resync ask reaches a feeder whose queue (4) overflows at the ship's 7th frame
test('a torn answer (the third re-check): the feeder\'s queue fills partway through its ship to a scoped failover\'s resync ask — the ship stops before the frame that would overflow it, no reply goes out, the drain delivers the queue and resumes past it, the reply ends the resync, every row arrives and nothing is swept', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  //! the spoke: the same ten rows from feeder pp (scoped), ff as the standby; pp dies — a scoped failover is a resync
  const S = harness('cl', { client: true, hosts: ['sim:pp', 'sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
  S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
  S.digestFrom(1)
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  for (const b of encodeRuns(sparse('bb', 10))) S.node.step({ kind: 'bytesIn', link: 1, bytes: b })
  assert.deepEqual(cells(S), ROWS)
  const p = pump(F, 7, S, 2)
  const s0 = digests(S, 2).length
  S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.notEqual(S.node.resync, null, 'a scoped failover is a resync')
  assert.deepEqual(digests(S, 2).slice(s0), [{ d: {}, r: 1, q: 2, f: 1 }], 'the ask')
  //! the ask lands: ff ships, pauses inside its 2nd frame, queues the next four, and stops before the 7th — the tear
  F.arm(2)
  const m0 = p.mark()
  p.toA()
  const link = F.node.links.get(7)!
  assert.equal(link.paused, true)
  assert.deepEqual(p.wire(m0), ['RECORDS', 'RECORDS'], 'two frames reached the socket before the pause — and NO reply')
  assert.equal(link.queued.length, 4, 'the ship stopped at the full queue: seqs 5-11 wait in it, nothing was cleared')
  assert.deepEqual(F.jk(JK.dropOldest).length, 0, 'no overflow')
  assert.equal(link.synced, false, 'the link stays unsynced')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [12, 1, 2], 'the answer is kept on the link: resume past seq 11, the last frame the link holds, then reply to q 2')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6], 'the journal counts what the link took: two frames sent, four queued')
  assert.notEqual(S.node.resync, null, 'the spoke is still in resync: nothing to end it on')
  //! the drain: the queue goes out, the answer resumes at seq 13, and its reply follows — no drain digest: nothing dropped
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.equal(link.torn, null)
  assert.equal(link.synced, true)
  assert.deepEqual(p.wire(m1), [...RESHIP, 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":2}'], 'the queue, the rest of the ship, then the reply to the ask')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4])
  p.settle()
  assert.equal(S.node.resync, null, 'the resync ended on the reply to its own ask')
  assert.deepEqual(S.jk(JK.resynced).map((e) => e.a), [0], 'nothing swept: every row came back')
  assert.deepEqual(cells(S), ROWS, 'the kernel holds all ten')
  assert.deepEqual(screenOf(S), ROWS, 'the screen shows all ten')
  assert.deepEqual(digests(S, 2).slice(s0), [{ d: {}, r: 1, q: 2, f: 1 }], 'one ask, one ship: no drain digest, so nothing more is asked')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4], 'ten records shipped once')
})

//! the resume can stop too: the socket fills again inside it and the queue (2 here) fills behind it. The second drain
// finishes the answer — every drain round delivers the queue plus what the socket takes, so a ship larger than the
// socket plus the queue still ends.
test('a torn answer that stops again at the resume: the second drain ships the rest and the reply, the spoke ends its resync with every row', () => {
  const F = feeder('ff', 7, { tune: { queued: 2 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:pp', 'sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
  S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
  S.digestFrom(1)
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  for (const b of encodeRuns(sparse('bb', 10))) S.node.step({ kind: 'bytesIn', link: 1, bytes: b })
  const p = pump(F, 7, S, 2)
  S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  F.arm(2)
  p.toA()
  const link = F.node.links.get(7)!
  assert.deepEqual(link.torn && link.torn.d.bb, 8, 'seqs 1 and 3 sent, 5 and 7 queued: stopped before 9')
  //! the first drain: the queue (5, 7) goes out, the resume ships 9 and pauses inside it, queues 11 and 13, and stops
  // before 15 — torn again, further on
  F.arm(3)
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), ['RECORDS', 'RECORDS', 'RECORDS'], 'three more frames reached the socket; no reply yet')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.q], [14, 2], 'torn again, further on')
  assert.equal(link.queued.length, 2)
  //! the second drain: the queue, the rest, the reply
  const m2 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m2), [...Array(5).fill('RECORDS'), 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":2}'])
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [4, 3, 3], 'ten records shipped once')
  assert.equal(F.jk(JK.dropOldest).length, 0)
  p.settle()
  assert.equal(S.node.resync, null)
  assert.deepEqual(S.jk(JK.resynced).map((e) => e.a), [0])
  assert.deepEqual(cells(S), ROWS)
  assert.deepEqual(screenOf(S), ROWS)
})

//! the byte bound stops the ship the same way (tune row queuedBytes, Link.full): with queuedBytes 1 the queue is full
// as soon as it holds one frame, whatever the count bound says — the ship stops before the next frame instead of
// clearing the queue, and each drain delivers the queue and resumes past it until the reply goes out.
test('a torn answer at the BYTE bound: the ship stops when the queue holds queuedBytes (one frame here, the count bound 256 far off), nothing is cleared, and the drains finish the answer with every row', () => {
  const F = feeder('ff', 7, { tune: { queuedBytes: 1 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:pp', 'sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
  S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
  S.digestFrom(1)
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  for (const b of encodeRuns(sparse('bb', 10))) S.node.step({ kind: 'bytesIn', link: 1, bytes: b })
  const p = pump(F, 7, S, 2)
  S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  F.arm(2)
  p.toA()
  const link = F.node.links.get(7)!
  assert.equal(link.queued.length, 1, 'one frame queued: the queue holds queuedBytes, so it is full')
  assert.deepEqual(link.torn && link.torn.d.bb, 6, 'seqs 1 and 3 sent, 5 queued: stopped before 7')
  for (let i = 0; i < 10 && (link.torn !== null || link.queued.length); i++) { F.arm(2); F.node.step({ kind: 'drain', link: 7 }) }
  assert.equal(link.torn, null, 'the drains finished the answer')
  assert.equal(F.jk(JK.dropOldest).length, 0, 'never cleared')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b).reduce((a, b) => a + b, 0), 10, 'ten records shipped once')
  p.settle()
  assert.equal(S.node.resync, null)
  assert.deepEqual(cells(S), ROWS)
  assert.deepEqual(screenOf(S), ROWS)
})

//! the older case the re-check named: a spoke's FIRST connect (it holds nothing, its ask is d = {} and no resync is
// on) tore the same way on base and lost the same rows. The spoke is out of resync, so it answers the drain digest
// with its real tails — which sit at the tear, because the ship stopped there — and the resume had already brought
// the rest. Covered by the same rule, with no spoke-side change.
test('a torn answer at a spoke\'s FIRST connect (no resync, d = {}): the resume brings every row; the spoke\'s tails sit at the tear, never above it', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  const p = pump(F, 7, S, 2)
  F.arm(2)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  assert.equal(S.node.resync, null, 'a first connect is no resync')
  assert.deepEqual(digests(S, 2), [{ d: {}, r: 1, q: 1 }])
  const m0 = p.mark()
  p.toA()
  const link = F.node.links.get(7)!
  assert.deepEqual(p.wire(m0), ['RECORDS', 'RECORDS'])
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.q], [12, 1])
  p.toB()
  assert.deepEqual(cells(S), ['r1', 'r2'], 'the spoke holds the frames the socket took — a pure prefix')
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), [...RESHIP, 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":1}'])
  p.settle()
  assert.deepEqual(cells(S), ROWS)
  assert.deepEqual(screenOf(S), ROWS)
  assert.equal(S.node.resync, null)
  assert.deepEqual(digests(S, 2).slice(1), [], 'no drain digest, nothing more asked')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4], 'ten records shipped once')
})

//! the same answer on an UNSCOPED member link: two servers, the lower uuid opens the digest exchange at admit, the
// peer's ship tears the same way. The resume brings the rest and the reply; the drain digest (no h toward a member —
// bytes unchanged) is answered with whole tails. Before: the ship ran past the tear, the link re-synced over a hole
// (live records then flowed above it), and the peer held 5 of 10 for good.
test('a torn answer on an unscoped MEMBER link: the ship stops at the tear, the link stays unsynced, the resume at the drain brings the rest and the reply, the peer holds everything', () => {
  const F = feeder('nn', 7, { tune: { queued: 4 } })
  //! aa dials nn: aa < nn, so aa opens the exchange with r=1 (HELLOs said by hand on both sides)
  const A = harness('aa')
  A.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:nn' })
  A.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'nn', i: 1, l: 'sim:nn' }) })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa' }) })
  assert.deepEqual(digests(A, 2), [{ d: {}, r: 1 }], 'aa opened the exchange (no q: a member)')
  const p = pump(F, 7, A, 2)
  F.arm(2)
  const m0 = p.mark()
  p.toA()
  const link = F.node.links.get(7)!
  assert.deepEqual(p.wire(m0), ['RECORDS', 'RECORDS'], 'two frames, no reply')
  assert.equal(link.synced, false, 'the link stays unsynced over the tear')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [12, 1, undefined])
  p.toB()
  assert.deepEqual(cells(A), ['r1', 'r2'])
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), [...RESHIP, 'DIGEST{"d":{"bb":19},"r":0}'], 'the queue, the rest, the reply — no q: member bytes')
  assert.equal(link.synced, true)
  p.settle()
  assert.deepEqual(cells(A), ROWS, 'the member holds all ten')
  assert.deepEqual(digests(A, 2).slice(1), [], 'no drain digest: nothing was dropped')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4])
})

//! ── the resume costs (2026-10-11): the third re-check of stage 2 recorded two, and these pin their fix. (1) An answer
// stays resumable until its reply has left the queue: a clear that takes a queued frame or the reply moves the resume
// point back to the answer's FIRST queued frame (Link.inQueue), so the spoke gets what the clear took and the reply —
// before, a spoke in resync re-asked on the drain digest (h: 1) and downloaded the feeder's whole held subset again.
// (2) No deliberate overflow: the ship stops at a full queue, and the drain digest waits rather than fill one.
// (3) A torn answer costs what it ships: every record encoded once (the cost pin is kernel/node.perf.ts).
const R11 = { rec: { type: REC.update, key: ['r11'], value: 11 } as Rec, origin: 'bb', seq: 21, epoch: 1 }
const ROWS11 = [...ROWS, 'r11'].sort()
//! the scoped failover of the first torn-answer test: a client on ff's link 7, a spoke on pp (primary) and ff holding
// the same ten rows; pp dies, so the spoke's resync ask (q 2) is out to ff — not yet delivered
const failover = (F: H) => {
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:pp', 'sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
  S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
  S.digestFrom(1)
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  for (const b of encodeRuns(sparse('bb', 10))) S.node.step({ kind: 'bytesIn', link: 1, bytes: b })
  const p = pump(F, 7, S, 2)
  const s0 = digests(S, 2).length
  S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.notEqual(S.node.resync, null)
  return { S, p, s0, link: F.node.links.get(7)! }
}
//! the end every one of these must reach: the resync ended on the reply to its one ask, nothing swept, all rows shown
const whole = (S: H, s0: number, rows: string[]) => {
  assert.equal(S.node.resync, null, 'the resync ended')
  assert.deepEqual(S.jk(JK.resynced).map((e) => e.a), [0], 'nothing swept')
  assert.deepEqual(cells(S), rows)
  assert.deepEqual(screenOf(S), rows)
  assert.equal(digests(S, 2).slice(s0).filter((d) => d.r === 1).length, 1, 'ONE ask: no re-download from zero')
}

//! C0: no tear at all — the answer completes with its last frames and its reply in the paused queue, and one live
// tap-forward overflows the queue. Before: the reply went with the clear, the spoke stayed in resync, and its h: 1
// re-ask downloaded everything again (aeShip [10, 11]).
test('a cleared reply (the third re-check\'s C0): an untorn answer whose last frames and reply sit in the paused queue, cleared by one live tap-forward, resumes from its first queued frame — the spoke ends its resync on ONE ship', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  const { S, p, s0, link } = failover(F)
  F.arm(7) // pause inside the 7th of 10 frames: 15, 17, 19 and the reply queued — 4 of 4, nothing stops
  const m0 = p.mark()
  p.toA()
  assert.deepEqual(p.wire(m0), Array(7).fill('RECORDS'))
  assert.equal(link.torn, null)
  assert.equal(link.queued.length, 4)
  assert.equal(link.synced, true, 'the answer is complete: live records flow')
  assert.deepEqual(link.inQueue && [link.inQueue.d.bb, link.inQueue.r, link.inQueue.q], [14, 1, 2], 'its first queued frame is seq 15')
  //! one live write from bb: the tap-forward overflows the queue — the clear takes 15, 17, 19 and the reply
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([R11])[0] })
  assert.equal(F.jk(JK.dropOldest).length, 1)
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [14, 1, 2], 'the answer is torn at its first queued frame')
  assert.equal(link.inQueue, null)
  p.toB()
  assert.notEqual(S.node.resync, null, 'the reply never reached the spoke')
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), [...Array(4).fill('RECORDS'), 'DIGEST{"d":{"bb":21},"r":0,"w":0,"q":2}', 'DIGEST{"d":{"bb":21},"r":1,"w":0,"h":1}'],
    'what the clear took and the live record, the reply, then the drain digest')
  p.settle()
  whole(S, s0, ROWS11)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [10, 4], 'the ten, then the three the clear took and the live one — never a second download')
})

//! C0 with ONLY the reply queued (the review of the resume-cost fix): the last record frame pauses inside its send, so
// the queue holds the reply alone and no record frame ever set inQueue. The reply branch sets it (the cover at the
// reply: every lane walked), so a clear that takes the reply still resumes — it re-sends the live record and the reply.
// Without that line the clear left nothing torn, and the drain digest's h: 1 bought a second download ([10, 11]).
test('a cleared reply with nothing else queued (C0, the reply alone): the answer resumes at its reply — the drain re-sends the live record and the reply, ONE ask, no second download', () => {
  const F = feeder('ff', 7, { tune: { queued: 1 } })
  const { S, p, s0, link } = failover(F)
  F.arm(10) // pause inside the last of 10 frames: the reply alone is queued, 1 of 1
  p.toA()
  assert.equal(link.torn, null)
  assert.equal(link.queued.length, 1)
  assert.equal(link.synced, true)
  assert.deepEqual(link.inQueue && [link.inQueue.d.bb, link.inQueue.r, link.inQueue.q], [19, 1, 2], 'the cover at the reply: every lane walked')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([R11])[0] }) // the tap-forward overflows: the clear takes the reply
  assert.equal(F.jk(JK.dropOldest).length, 1)
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.q], [19, 2], 'the answer is torn at its reply')
  p.toB()
  assert.notEqual(S.node.resync, null, 'the reply never reached the spoke')
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), ['RECORDS', 'DIGEST{"d":{"bb":21},"r":0,"w":0,"q":2}', 'DIGEST{"d":{"bb":21},"r":1,"w":0,"h":1}'],
    'the live record the clear took, the reply, then the drain digest')
  p.settle()
  whole(S, s0, ROWS11)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [10, 1], 'the ten, then the live one — never a second download')
})

//! a stop on a link that is ALREADY synced (the review of the resume-cost fix): a client's floor below its tails reaches
// a flowing link, the suffix ship pauses inside its 2nd frame and stops at the full queue. The stop unsyncs the link, so
// a live record committed while stopped waits for the resume instead of overflowing the full queue (which would clear
// the four queued frames, buy an h: 1 drain digest, and re-send them).
test('a torn answer on an already-synced link unsyncs it: a live record committed while stopped waits for the resume — no clear, no drain digest, every record once', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: { bb: 19 }, r: 0 }) })
  const link = F.node.links.get(7)!
  assert.equal(link.synced, true, 'the link is synced before the floor arrives')
  const sent = () => F.of('send').filter((e) => e[1] === 7).length
  const m0 = sent()
  F.arm(2)
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: { bb: 1 }, r: 0 }) }) // nine frames owed: 3..19
  assert.equal(sent() - m0, 2, '3 and 5 reached the socket')
  assert.equal(link.queued.length, 4, '7-13 queued')
  assert.deepEqual(link.torn && link.torn.d.bb, 14, 'stopped before 15')
  assert.equal(link.synced, false, 'the stop unsynced the link')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([R11])[0] }) // a live record while stopped
  assert.equal(F.jk(JK.dropOldest).length, 0, 'it waited: nothing cleared')
  assert.equal(link.droppedWhilePaused, false)
  F.node.step({ kind: 'drain', link: 7 })
  const wire = F.of('send').filter((e) => e[1] === 7).slice(m0).flatMap((e) => new Framer().push((e[2] as Uint8Array).slice()))
  assert.deepEqual(wire.map((fr) => (fr.verb === VERB.RECORDS ? fr.records()[0].seq : -fr.verb)), [3, 5, 7, 9, 11, 13, 15, 17, 19, 21], 'every record once, in order, the live one in the resume; no drain digest')
  assert.equal(link.torn, null)
  assert.equal(link.synced, true)
})

//! C: the clear lands after a RESUME that completed with its tail and reply in the queue (the resume set synced, so
// one live tap-forward reaches the same queue). Before: aeShip [2, 8, 11], a second download.
test('a cleared reply after a resume (the third re-check\'s C): the resume ends with its tail and reply filling the queue, one live tap-forward clears it — the drain re-sends only what the clear took, ONE ask', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  const { S, p, s0, link } = failover(F)
  F.arm(2)
  p.toA()
  assert.deepEqual(link.torn && link.torn.d.bb, 12)
  //! the resume: the queue (5-11) goes out, 13 pauses inside its send, 15, 17, 19 and the reply fill the queue
  F.arm(5)
  F.node.step({ kind: 'drain', link: 7 })
  assert.equal(link.torn, null)
  assert.equal(link.queued.length, 4)
  assert.deepEqual(link.inQueue && link.inQueue.d.bb, 14)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([R11])[0] })
  assert.equal(F.jk(JK.dropOldest).length, 1)
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.q], [14, 2])
  p.toB()
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), [...Array(4).fill('RECORDS'), 'DIGEST{"d":{"bb":21},"r":0,"w":0,"q":2}', 'DIGEST{"d":{"bb":21},"r":1,"w":0,"h":1}'])
  p.settle()
  whole(S, s0, ROWS11)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4, 4])
})

//! B: the drain digest itself would clear the reply — a resume ends with its tail and reply filling the queue while the
// link owes a drain digest (here: the spoke's heartbeat floor crossed the stop and was swallowed). Before, the digest
// went into the full queue and cleared the reply (aeShip [2, 8, 10]); now it waits for the next drain, after the reply.
test('the drain digest never fills a full queue (the third re-check\'s B): a resume ends with its reply as the queue\'s last slot and a digest owed — the digest waits for the next drain, nothing is cleared', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  const p = pump(F, 7, S, 2)
  F.arm(2)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  p.toA()
  const link = F.node.links.get(7)!
  assert.deepEqual(link.torn && link.torn.d.bb, 12)
  p.toB()
  //! the spoke's heartbeat floor reaches the paused feeder: swallowed, and the drain digest is owed
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: { bb: 3 }, r: 0 }) })
  assert.equal(link.droppedWhilePaused, true)
  F.arm(5)
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), Array(5).fill('RECORDS'), 'the queue and seq 13 reached the socket')
  assert.equal(link.queued.length, 4, '15, 17, 19 and the reply')
  assert.equal(F.jk(JK.dropOldest).length, 0, 'the drain digest did not overflow the queue')
  assert.equal(link.droppedWhilePaused, true, 'it is still owed')
  const m2 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m2), ['RECORDS', 'RECORDS', 'RECORDS', 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":1}', 'DIGEST{"d":{"bb":19},"r":1,"w":0,"h":1}'], 'the reply, THEN the drain digest')
  p.settle()
  assert.deepEqual(cells(S), ROWS)
  assert.deepEqual(screenOf(S), ROWS)
  assert.deepEqual(digests(S, 2).slice(1), [{ d: { bb: 19 }, r: 0 }], 'the drain digest answered with whole tails')
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4], 'ten records shipped once')
  assert.equal(F.jk(JK.dropOldest).length, 0)
})

//! the same at the BYTE bound: the resume ends with its reply alone in a queue whose queuedBytes is 1, and the drain
// digest is owed. Read with the drain digest's guard counting frames only, the digest went into the byte-full queue
// and its ship cleared the reply.
test('the drain digest never fills a byte-full queue: a resume ends with its reply alone holding queuedBytes and a digest owed — the digest waits for the next drain, nothing is cleared', () => {
  const F = feeder('ff', 7, { tune: { queuedBytes: 1 } })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:ff'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
  const p = pump(F, 7, S, 2)
  F.arm(2)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
  p.toA()
  const link = F.node.links.get(7)!
  assert.deepEqual(link.torn && link.torn.d.bb, 6, 'seqs 1 and 3 sent, 5 queued: stopped before 7')
  p.toB()
  //! the spoke's heartbeat floor reaches the paused feeder: swallowed, and the drain digest is owed
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: { bb: 3 }, r: 0 }) })
  assert.equal(link.droppedWhilePaused, true)
  F.arm(8) // the drain sends 5, then the resume 7..19: the socket fills on 19, and the reply alone is queued
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), Array(8).fill('RECORDS'), 'the queue and the rest of the lane reached the socket')
  assert.equal(link.queued.length, 1, 'the reply alone, which holds queuedBytes')
  assert.equal(link.torn, null)
  assert.equal(F.jk(JK.dropOldest).length, 0, 'the drain digest did not overflow the queue')
  assert.equal(link.droppedWhilePaused, true, 'it is still owed')
  const m2 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m2), ['DIGEST{"d":{"bb":19},"r":0,"w":0,"q":1}', 'DIGEST{"d":{"bb":19},"r":1,"w":0,"h":1}'], 'the reply, THEN the drain digest')
  p.settle()
  assert.deepEqual(cells(S), ROWS)
  assert.deepEqual(screenOf(S), ROWS)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [3, 7], 'ten records shipped once')
  assert.equal(F.jk(JK.dropOldest).length, 0)
})

//! the reply is one more frame: when the ship's last frame fills the queue, the answer stops before its reply rather
// than overflow the queue with it (which would clear the four frames it just queued and re-send them)
test('the reply never overflows the queue: a ship whose last frame fills the paused queue stops before its reply — the drain sends the queue, then the reply alone', () => {
  const F = feeder('ff', 7, { tune: { queued: 4 } })
  const { S, p, s0, link } = failover(F)
  F.arm(6) // pause inside the 6th of 10 frames: 13, 15, 17, 19 fill the queue — no room for the reply
  p.toA()
  assert.equal(link.queued.length, 4)
  assert.equal(F.jk(JK.dropOldest).length, 0, 'no overflow')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [19, 1, 2], 'every lane shipped: only the reply waits')
  assert.equal(link.synced, false, 'unsynced until the reply goes')
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), [...Array(4).fill('RECORDS'), 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":2}'])
  p.settle()
  whole(S, s0, ROWS)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [10], 'one ship; the resume had nothing left to ship')
})

//! the same at the BYTE bound: the last frame of the ship alone fills a queue whose queuedBytes is 1, so the reply waits
// for the drain. Read with the reply's stop counting frames only, the reply went into the byte-full queue: its ship
// cleared the queue, the last frame and the reply with it.
test('the reply never overflows the queue at the BYTE bound: a ship whose last frame alone holds queuedBytes stops before its reply — nothing is cleared, the drain sends the frame, then the reply', () => {
  const F = feeder('ff', 7, { tune: { queuedBytes: 1 } })
  const { S, p, s0, link } = failover(F)
  F.arm(9) // pause inside the 9th of 10 frames: 19 alone fills the queue — no room for the reply
  p.toA()
  assert.equal(link.queued.length, 1)
  assert.equal(F.jk(JK.dropOldest).length, 0, 'no overflow')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [19, 1, 2], 'every lane shipped: only the reply waits')
  assert.equal(link.synced, false, 'unsynced until the reply goes')
  const m1 = p.mark()
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(p.wire(m1), ['RECORDS', 'DIGEST{"d":{"bb":19},"r":0,"w":0,"q":2}'])
  p.settle()
  whole(S, s0, ROWS)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [10], 'one ship')
  assert.equal(F.jk(JK.dropOldest).length, 0)
})

//! E: two lanes; the ship stops in the SECOND, and between the stop and the drain the FIRST (already walked) gains a
// record and a remove. The resume's cover holds the first lane at its tail when the ship stopped, so the resume
// ships what came after — no drain exchange needed. After the resume a live record of the first lane flows.
const laneOf = (origin: string, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ rec: { type: REC.update, key: [`${origin}${from + i}`], value: from + i } as Rec, origin, seq: 2 * (from + i) - 1, epoch: 1 }))
for (const mode of ['first connect', 'resync'] as const)
  test(`a torn answer's resume covers a lane it walked before the stop (${mode}): a record and a remove committed there while stopped arrive in the resume`, () => {
    const A = laneOf('aa', 3), B = laneOf('bb', 10)
    const F = feeder('ff', 7, { tune: { queued: 4 } }, [...A, ...B])
    F.node.step({ kind: 'linkUp', link: 7, dialed: false })
    F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
    const S = harness('cl', { client: true, hosts: mode === 'resync' ? ['sim:pp', 'sim:ff'] : ['sim:ff'] })
    S.node.step({ kind: 'start' })
    let p: ReturnType<typeof pump>
    if (mode === 'resync') {
      S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
      S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
      S.digestFrom(1)
      S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
      S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
      for (const b of encodeRuns([...A, ...B])) S.node.step({ kind: 'bytesIn', link: 1, bytes: b })
      p = pump(F, 7, S, 2)
      S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
      assert.notEqual(S.node.resync, null)
      F.arm(5)
    } else {
      S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:ff' })
      p = pump(F, 7, S, 2)
      F.arm(5)
      S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'ff', i: 1, l: 'sim:ff', c: SCOPED }) })
    }
    p.toA() // aa's three frames and bb 1, 3 reach the socket; bb 5-11 queued; stopped before bb 13
    const link = F.node.links.get(7)!
    assert.deepEqual(link.torn && link.torn.d, { aa: 5, bb: 12 }, 'the cover: aa walked to its tail, bb up to the stop')
    //! while stopped: aa gains aa4 (seq 7) and a remove of aa1 (seq 9) — the link is unsynced, so nothing goes live
    for (const b of encodeRuns([...laneOf('aa', 1, 4), { rec: { type: REC.remove, key: ['aa1'] } as Rec, origin: 'aa', seq: 9, epoch: 1 }]))
      F.node.step({ kind: 'bytesIn', link: 1, bytes: b })
    assert.equal(link.queued.length, 4)
    p.toB()
    F.node.step({ kind: 'drain', link: 7 })
    assert.equal(link.torn, null)
    //! a live aa record AFTER the resume, before the spoke's answer lands at the feeder
    for (const b of encodeRuns(laneOf('aa', 1, 6))) F.node.step({ kind: 'bytesIn', link: 1, bytes: b })
    p.settle()
    assert.deepEqual(cells(S), cells(F))
    assert.deepEqual(screenOf(S), cells(F))
    assert.equal(S.node.resync, null)
    assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [9, 6], 'aa 1-5 and bb 1-11, then aa 7, 9 and bb 13-19: each once')
    assert.equal(F.jk(JK.dropOldest).length, 0)
  })

//! the reviewer's cost probe as a kernel test (small N; the CPU ratio is the perf pin): a first connect's ask to a feeder
// holding 3,000 sparse records, through a socket that pauses at 16 KiB, a queue of 256. Every record reaches the socket
// once and in order, each is encoded once (handed = sent: nothing queued is ever cleared), and the reply is last.
test('a big torn answer costs what it ships: 3,000 sparse records through a socket that pauses at 16 KiB — each encoded once, sent once and in order, the reply last', () => {
  const f = tornFeeder(3000, 16384)
  const wire: number[] = []
  const send = f.node.env.sink.send
  f.node.env.sink.send = (l, b) => {
    if (l === 7) for (const fr of new Framer().push(b.slice())) wire.push(fr.verb === VERB.RECORDS ? fr.records()[0].seq : -fr.verb)
    send(l, b)
  }
  f.ask()
  assert.notEqual(f.link.torn, null, 'the answer stopped at the full queue')
  let rounds = 0
  while (f.link.torn !== null || f.link.queued.length) { f.drain(); rounds++; assert.ok(rounds < 100, 'it ends') }
  assert.deepEqual(wire, [...Array.from({ length: 3000 }, (_, i) => 2 * i + 1), -VERB.DIGEST], 'every seq once, ascending, then the reply')
  assert.equal(f.c.handed, 3001, 'every frame handed to the link once: nothing encoded was wasted')
  assert.equal(f.c.sent, 3001)
  assert.equal(f.link.droppedWhilePaused, false, 'no overflow, no drain digest')
  assert.equal(f.link.synced, true)
})

//! a SPLICE under a stopped or queued answer (the review of the resume-cost fix, 2026-10-11). An armed feeder aa holds
// bb's partition p1 at seqs 10, 12, ..., 28 but not 11 (that one reaches it later from cc: a cross-link interleave).
// A spoke that held all eleven rows fails over to aa — a resync. The answer pauses inside frame 2 (the ship stops: the
// cover sits above 11), 7 (it completes with three frames and its reply queued) or 10 (only the reply queued). Then 11
// arrives and splices into the lane's interior; live records follow until the queue overflows. A cover is a map of
// tails, so it cannot hold a record below it: the splice lowers it (Node.indexInsert). Before: the resume started at
// the cover, 11 was never shipped (again), the spoke ended its resync without r11 and swept it.
const P1 = (k: string, v: number): Rec => ({ type: REC.update, key: ['p1', k], value: v })
const p1frame = (seq: number, pp?: number) => encodeRuns([{ rec: P1(`r${seq}`, seq), origin: 'bb', seq, epoch: 1, pp }], VERB.RECORDS, pp !== undefined)[0]
for (const pauseAt of [2, 7, 10])
  test(`a record spliced under a torn answer's cover reaches the spoke (pause inside frame ${pauseAt}): the splice lowers the cover, the resync ends on ONE ask with every row`, () => {
    let armed = false, count = 0
    const SEQS = Array.from({ length: 10 }, (_, i) => 10 + 2 * i)
    const members = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
    const F = harness('aa', { replicas: 2, boot: { epoch: 1, members }, tune: { queued: 4 } }, (link) => {
      if (link === 7 && armed && ++count === pauseAt) { armed = false; F.node.step({ kind: 'pause', link: 7 }) }
    })
    F.node.step({ kind: 'start' })
    F.admit(1, 'bb'); F.digestFrom(1)
    F.admit(2, 'cc'); F.digestFrom(2)
    F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: members }) })
    assert.equal(F.node.armed, true)
    F.node.writes.ring.place('p1', 'bb', 'aa')
    let prev = 0
    for (const s of SEQS) { F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(s, s === 10 ? 0 : s === 12 ? 11 : prev) }); prev = s }
    F.node.step({ kind: 'linkUp', link: 7, dialed: false })
    F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
    const S = harness('cl', { client: true, hosts: ['sim:pp', 'sim:aa'] })
    S.node.step({ kind: 'start' })
    S.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:pp' })
    S.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'pp', i: 1, l: 'sim:pp', c: SCOPED }) })
    S.digestFrom(1)
    S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
    S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) })
    for (const s of [10, 11, ...SEQS.slice(1)]) S.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(s) })
    assert.equal(S.node.state.size, 11, 'the spoke shows all eleven')
    const p = pump(F, 7, S, 2)
    const s0 = digests(S, 2).length
    S.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
    assert.notEqual(S.node.resync, null)
    armed = true
    p.toA()
    const link = F.node.links.get(7)!
    const cover = (link.torn ?? link.inQueue)!.d.bb
    assert.ok(cover > 11, `the answer's cover sits above 11 (${cover})`)
    //! 11 reaches aa from cc: it splices; live records follow until the queue overflows (or, stopped, nothing goes live)
    F.node.step({ kind: 'bytesIn', link: 2, bytes: p1frame(11, 10) })
    assert.ok(F.node.logs.get('bb')!.some((e) => e.seq === 11), 'aa spliced 11')
    assert.equal((link.torn ?? link.inQueue)!.d.bb, 10, 'the splice lowered the cover to just under 11')
    for (let k = 1; k <= 3 && F.jk(JK.dropOldest).length === 0 && link.synced; k++) F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(28 + 2 * k, 26 + 2 * k) })
    if (pauseAt !== 2) assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear took the queued answer')
    p.toB()
    for (let d = 0; d < 4 && (link.paused || link.torn !== null); d++) { F.node.step({ kind: 'drain', link: 7 }); p.settle() }
    p.settle()
    assert.equal(S.node.resync, null, 'the resync ended')
    assert.deepEqual([...S.node.state.keys()].sort(), [...F.node.state.keys()].sort(), 'the spoke holds every row its feeder holds, r11 included')
    assert.ok(S.node.state.has(JSON.stringify(['p1', 'r11'])))
    assert.deepEqual(S.jk(JK.resynced).map((e) => e.a), [0], 'nothing swept')
    assert.equal(digests(S, 2).slice(s0).filter((d) => d.r === 1).length, 1, 'ONE ask')
  })

//! ── a clear in STEADY state (wave 5f; filed by the review of the resume-cost fix, 2026-10-11). No answer is in flight:
// the spoke made its first connect long ago and its link is synced, so its feeder tap-forwards every record it folds.
// A record SPLICED into a lane's interior is tap-forwarded too, below the spoke's tails. If the link pauses and a clear
// takes that frame, the drain digest cannot see the hole (the spoke's tails already sit above it), so the record was
// never sent again. Now the clear turns what it took into the link's cover (Link.torn, node.ts #clearCover): each lane
// is lowered to just under the lowest record the clear took, the rest stand at the feeder's tails (a ceiling, `c`),
// and the spoke's reply to the drain digest is answered from the lower of its tails and that ceiling. An armed feeder aa holds bb's partition p1 at seqs 10, 12, ..., `top`
// (not 11); a spoke connects to it first (d = {}) and holds every row; then the link pauses.
const steady = (Q: number, top = 20) => {
  const F = harness('aa', { replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }, tune: { queued: Q } })
  F.node.step({ kind: 'start' })
  F.admit(1, 'bb'); F.digestFrom(1)
  F.admit(2, 'cc'); F.digestFrom(2)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(F.node.armed, true)
  F.node.writes.ring.place('p1', 'bb', 'aa')
  for (let s = 10, prev = 0; s <= top; prev = s, s += 2) F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(s, s === 10 ? 0 : s === 12 ? 11 : prev) })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:aa'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  const p = pump(F, 7, S, 2)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) })
  p.settle()
  const link = F.node.links.get(7)!
  assert.equal(link.synced, true, 'steady state: the link is synced')
  assert.equal(S.node.state.size, (top - 10) / 2 + 1, 'the spoke holds every row')
  assert.equal(S.node.resync, null)
  F.node.step({ kind: 'pause', link: 7 })
  const rows = (h: H) => [...h.node.state.keys()].sort()
  const drainAll = () => { for (let d = 0; d < 8 && (link.paused || link.torn !== null); d++) { F.node.step({ kind: 'drain', link: 7 }); p.settle() } p.settle() }
  return { F, S, p, link, rows, drainAll }
}

test('a record spliced in steady state, tap-forwarded and cleared from the paused queue reaches the spoke: the clear lowers that lane in the link\'s cover and the drain re-sends from just under it', () => {
  const { F, S, p, link, rows, drainAll } = steady(2)
  //! 11 reaches aa from cc: it splices below the spoke's tail (20) and is tap-forwarded into the paused queue
  F.node.step({ kind: 'bytesIn', link: 2, bytes: p1frame(11, 10) })
  assert.ok(F.node.logs.get('bb')!.some((e) => e.seq === 11), 'aa spliced 11')
  assert.equal(link.queued.length, 1, 'its tap-forward waits in the queue')
  //! two live records from bb: the second overflows the queue — the clear takes 11 and 22
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(22, 20) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(24, 22) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear')
  assert.equal(link.synced, false)
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [10, undefined, undefined], 'the cover: bb lowered to just under 11, no reply owed')
  //! a record committed between the clear and the drain (the link is unsynced: nothing goes live) is above the cover
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(26, 24) })
  drainAll()
  assert.equal(link.torn, null)
  assert.equal(link.synced, true)
  assert.ok(S.node.state.has(JSON.stringify(['p1', 'r11'])), 'r11 reached the spoke')
  assert.deepEqual(rows(S), rows(F), 'the spoke holds every row its feeder holds')
  assert.equal(S.node.resync, null)
  //! after the drain a live record flows again
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(28, 26) })
  p.settle()
  assert.deepEqual(rows(S), rows(F))
})

//! a run of bb's records in ONE inbound frame, where the odd seqs are partition p2, which aa does not hold (placed on
// bb and cc): aa folds and taps only the p1 records, so the tap is gappy and the spoke's outbox rotates — one flush
// ships several frames, and a clear can land in the middle of it
const gappy = (from: number, to: number) => {
  const run = []
  for (let s = from; s <= to; s++) run.push({ rec: s % 2 ? { type: REC.update, key: ['p2', `x${s}`], value: s } as Rec : P1(`r${s}`, s), origin: 'bb', seq: s, epoch: 1, pp: s - 1 })
  return encodeRuns(run, VERB.RECORDS, true)[0]
}

test('a clear in the middle of one flush: the frame shipped after it survives and would raise the spoke\'s tail above what the clear took; the cover re-sends from just under the lowest lost record', () => {
  const { F, S, link, rows, drainAll } = steady(1, 30)
  F.node.writes.ring.place('p2', 'bb', 'cc')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(32, 30) })
  assert.equal(link.queued.length, 1, '32 fills the queue')
  //! 34 and 36 in one flush: 34 overflows the queue — the clear takes 32 and 34 — and 36 is queued after it
  F.node.step({ kind: 'bytesIn', link: 1, bytes: gappy(34, 36) })
  assert.equal(F.jk(JK.dropOldest).length, 1)
  assert.equal(link.queued.length, 1, '36 survived the clear')
  assert.deepEqual(link.torn && link.torn.d.bb, 31, 'bb lowered to just under 32')
  drainAll()
  assert.deepEqual(rows(S), rows(F), 'r32 and r34 reached the spoke although 36 landed first')
  assert.equal(link.torn, null)
})

test('two clears in a row lower one cover and never raise it; a splice between the clear and the drain (nothing tapped: the link is unsynced) lowers it too', () => {
  const { F, S, link, rows, drainAll } = steady(1, 30)
  F.node.writes.ring.place('p2', 'bb', 'cc')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(32, 30) })
  //! 34, 36, 38 in one flush: 34 clears (32, 34), 36 is queued, 38 clears again (36, 38)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: gappy(34, 38) })
  assert.equal(F.jk(JK.dropOldest).length, 2, 'two clears')
  assert.equal(link.queued.length, 0)
  assert.deepEqual(link.torn && link.torn.d.bb, 31, 'the second clear (lowest 36) kept the first one\'s cover')
  //! while unsynced: 11 splices (no tap) and 40 commits (no tap)
  F.node.step({ kind: 'bytesIn', link: 2, bytes: p1frame(11, 10) })
  assert.deepEqual(link.torn && link.torn.d.bb, 10, 'the splice lowered the cover')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(40, 38) })
  assert.equal(link.queued.length, 0, 'nothing tapped while unsynced')
  drainAll()
  assert.ok(S.node.state.has(JSON.stringify(['p1', 'r11'])))
  assert.deepEqual(rows(S), rows(F))
})

//! a clear that takes only CONTROL frames (method replies, SUBREC deltas) on a synced link (the review of wave 5f). The
// link is unsynced from that clear on, so a later splice is not tapped. Before: no cover, the link was not in #covered,
// and the drain digest answers above the spoke's tails, so the splice was never sent (on the base tree too). Now every
// clear on a synced link leaves a cover at the feeder's tails, and the splice lowers it.
for (const [what, fill] of [
  ['method replies', (F: H) => { for (let i = 0; i < 3; i++) F.node.step({ kind: 'reply', link: 7, id: i + 1, ok: true, value: i }) }],
  ['SUBREC deltas', (F: H) => { for (let i = 0; i < 3; i++) F.node.step({ kind: 'subOut', link: 7, id: 1, recs: [{ type: REC.update, key: ['x'], value: i }] }) }],
] as const)
  test(`a clear of control frames only (${what}) leaves a cover at the feeder's tails; a splice before the drain lowers it and reaches the spoke`, () => {
    const { F, S, p, link, rows, drainAll } = steady(2)
    fill(F)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear that took no record frame')
    assert.equal(link.synced, false)
    assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [20, undefined, undefined], 'the cover: the feeder\'s tails, no reply owed')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: p1frame(11, 10) })
    assert.equal(link.queued.length, 0, '11 is not tapped: the link is unsynced')
    assert.deepEqual(link.torn && link.torn.d.bb, 10, 'the splice lowered the cover')
    F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(22, 20) })
    drainAll()
    assert.equal(link.torn, null)
    assert.equal(link.synced, true)
    assert.ok(S.node.state.has(JSON.stringify(['p1', 'r11'])), 'r11 reached the spoke')
    assert.deepEqual(rows(S), rows(F))
    F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(24, 22) })
    p.settle()
    assert.deepEqual(rows(S), rows(F), 'live records flow again')
  })

//! the review's P9 (wave 5f): a relayed write's record reaches the feeder and clears its attempt mid-frame, so the WACK
// hop goes out BEFORE the tap flush (wave 5e's common order). The queue holds only control frames, so that WACK makes a
// clear that takes no record frame, and the tap frame (22) is flushed after it and survives. cc's 25 folds while the
// link is unsynced (not tapped). A second clear takes 22. Before: the first clear left no cover, the second set it at
// the feeder's tails, above 25 — then 27 was resumed and 25 was lost for good (the base heals it through the drain
// digest; the first wave-5f fix lost it). Now the first clear leaves the cover at the tails of that moment (below 25),
// and the second only lowers bb.
const wframe = (issuer: string, c0: number, recs: Rec[]) => encodeRuns(recs.map((r, i) => ({ rec: r, origin: issuer, seq: c0 + i, epoch: 0 })), VERB.WRITE)[0]
const ccframe = (seq: number, pp: number) => encodeRuns([{ rec: { type: REC.update, key: ['p3', `c${seq}`], value: seq }, origin: 'cc', seq, epoch: 1, pp }], VERB.RECORDS, true)[0]
test('a control-only clear (a relay\'s WACK hop) then a second clear that takes a surviving tap frame: a record on another lane folded between the clears still reaches the spoke', () => {
  const { F, S, link, rows, drainAll } = steady(2)
  F.node.membership.rejoinFloor = 0
  F.node.writes.ring.place('p3', 'cc', 'aa')
  for (let i = 0; i < 2; i++) F.node.step({ kind: 'reply', link: 7, id: i + 1, ok: true, value: i })
  assert.equal(link.queued.length, 2, 'the queue is full of control frames')
  F.node.step({ kind: 'bytesIn', link: 7, bytes: wframe('cl~1', 1, [P1('w1', 1)]) }) // the spoke relays a write; aa forwards it to bb
  //! bb's commit reaches aa with the attempt identity: the tap waits in the outbox, the WACK hop ships at once and clears
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: P1('w1', 1), origin: 'bb', seq: 22, epoch: 1, iss: 'cl~1', cid: 1, pp: 20 }], VERB.RECORDS, true)[0] })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'the WACK hop cleared a queue of control frames')
  assert.equal(link.queued.length, 1, 'tap frame 22 was flushed after the clear and survived it')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.d.cc], [22, undefined], 'the cover: the tails at the first clear')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: ccframe(25, 0) }) // folds; not tapped (unsynced)
  assert.ok(F.node.logs.get('cc')!.some((e) => e.seq === 25))
  for (let i = 0; i < 2; i++) F.node.step({ kind: 'reply', link: 7, id: 10 + i, ok: true, value: i })
  assert.equal(F.jk(JK.dropOldest).length, 2, 'a second clear takes tap frame 22')
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.d.cc], [21, undefined], 'bb lowered under 22; cc stays under 25')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: ccframe(27, 25) })
  drainAll()
  assert.ok(S.node.state.has(JSON.stringify(['p3', 'c25'])), 'c25 reached the spoke')
  assert.ok(S.node.state.has(JSON.stringify(['p1', 'w1'])), 'w1 reached the spoke')
  assert.deepEqual(rows(S), rows(F))
})

//! the guard on the rule above: a clear on a link that was NOT synced, with no cover, leaves none. The spoke's first
// connect digest reaches a paused feeder (swallowed: the drain digest is owed), and control frames clear the queue
// before the link was ever synced. A cover at the feeder's tails would say the spoke holds everything: the drain would
// resume it, ship nothing and mark the link synced, so a live record would go out ahead of the spoke's first download.
test('a clear on a link that was never synced leaves no cover: the drain digest heals it as before, and nothing goes live ahead of the first download', () => {
  const members = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  const F = harness('aa', { replicas: 2, boot: { epoch: 1, members }, tune: { queued: 2 } })
  F.node.step({ kind: 'start' })
  F.admit(1, 'bb'); F.digestFrom(1)
  F.admit(2, 'cc'); F.digestFrom(2)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: members }) })
  F.node.writes.ring.place('p1', 'bb', 'aa')
  for (let s = 10, prev = 0; s <= 20; prev = s, s += 2) F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(s, prev) })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:aa'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  const p = pump(F, 7, S, 2)
  const link = F.node.links.get(7)!
  F.node.step({ kind: 'pause', link: 7 })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) })
  p.toA() // the first-connect digest reaches the paused feeder: swallowed, the drain digest is owed
  assert.equal(link.synced, false)
  for (let i = 0; i < 3; i++) F.node.step({ kind: 'reply', link: 7, id: i + 1, ok: true, value: i })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear of control frames on a never-synced link')
  assert.equal(link.torn, null, 'no cover: nothing was ever tapped to this link')
  F.node.step({ kind: 'drain', link: 7 })
  assert.equal(link.synced, false, 'still unsynced: only a real exchange syncs it')
  const at = p.mark()
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(22, 20) })
  assert.deepEqual(p.wire(at), [], 'the live record is withheld')
  p.settle()
  assert.equal(link.synced, true)
  assert.deepEqual([...S.node.state.keys()].sort(), [...F.node.state.keys()].sort())
})

//! the review of the wave-5f fix found this shape: a scoped feeder folded a record through the LATCH (scope.ts
// onAcqDone) and tapped nothing (the STATUS latch bug, closed by wave 6a), so the spoke lacked it; a control-only clear
// then set a cover at the feeder's tails, ABOVE the latch row, and a drain that RESUMED that cover shipped a later
// record alone, so the spoke's tail rose past the latch row and it never arrived while the feeder lived (7 of 8 rows;
// the base tree healed it through the drain digest). V4-49's answer: a cover the clear SETS is a ceiling (`c`) — the
// drain does not resume it; the spoke's reply to the drain digest is answered from the lower of its own tail and the
// ceiling. RE-RECORDED for wave 6a (2026-10-12): the fold now taps the latch row onto the client link as the live tap
// would (here: into the paused queue), so the clear that follows takes a RECORD frame and lowers the ceiling to just
// under it (bb: 22, where the feeder's tail is 23); the rule's steps are the same — not resumed at the drain, used up
// by the spoke's reply — and the row arrives. With the forward in place a cover at a synced link's feeder tails would
// be a sound claim about the spoke (every record it folds is tapped to a synced link or lies above those tails), so
// the ceiling is belt and braces now; it stays as V4-49 recorded it.
const PX = (k: string, v: number): Rec => ({ type: REC.update, key: ['px', k], value: v })
test('a clear\'s cover is a ceiling, never a claim: a latch-folded record (tapped onto the paused link since wave 6a), a clear that takes its frame and lowers the ceiling to just under it, and a later record on its lane before the drain — the ceiling is not resumed, the spoke\'s reply uses it up, the latch row arrives', () => {
  //! a queue of four (two until wave 6c): the fold's forward is a GROUP now — FEED {b}, the tap frame, FEED {e} — three
  // frames, which overflowed a queue of two at the fold itself (a clear there heals the same way; the shape this test
  // pins is the clear that takes the latch row later, with the replies)
  const { F, S, p, link, rows } = steady(4)
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 23 } } }) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: PX('a', 23), origin: 'bb', seq: 23, epoch: 1, pp: 0 }], VERB.ACQ, true)[0] })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 23 }, n: 1 }) })
  assert.equal(F.node.scope!.held('px'), true, 'the latch folded px')
  assert.equal(link.queued.length, 3, 'the latch fold tapped the row onto the paused link, inside its group (wave 6a; it tapped nothing before)')
  for (let i = 0; i < 3; i++) F.node.step({ kind: 'reply', link: 7, id: i + 1, ok: true, value: i })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear: it took the group (the tap frame and its two markers) and two replies')
  assert.deepEqual(link.torn, { d: { bb: 22 }, r: undefined, q: undefined, c: true }, 'the cover: the feeder\'s tails lowered to just under the latch row the clear took, a ceiling')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(24, 20) }) // folds; not tapped (unsynced); above the ceiling
  F.node.step({ kind: 'drain', link: 7 })
  assert.equal(link.torn?.c, true, 'the drain does not resume a ceiling: it waits for the spoke\'s reply to the drain digest')
  p.settle()
  assert.equal(link.torn, null, 'the spoke\'s reply used it up')
  assert.equal(link.synced, true)
  assert.ok(S.node.state.has(JSON.stringify(['px', 'a'])), 'the latch row reached the spoke')
  assert.deepEqual(rows(S), rows(F))
})

//! the mixed clear: an answer's frames and its reply are still queued (the spoke's first connect paused inside frame 4)
// when a gappy tap lands; the clear takes the answer's frames, its reply and a tap frame, and the frame after it
// survives. The torn answer keeps its own cover (no record the clear took sits below it) and its reply.
test('a clear that takes an answer\'s queued frames, its reply and a tap-forward together: the torn answer keeps its cover and its reply, the spoke gets every row on ONE ask', () => {
  let armed = false, count = 0
  const members = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  const F = harness('aa', { replicas: 2, boot: { epoch: 1, members }, tune: { queued: 3 } }, (l) => {
    if (l === 7 && armed && ++count === 4) { armed = false; F.node.step({ kind: 'pause', link: 7 }) }
  })
  F.node.step({ kind: 'start' })
  F.admit(1, 'bb'); F.digestFrom(1)
  F.admit(2, 'cc'); F.digestFrom(2)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: members }) })
  F.node.writes.ring.place('p1', 'bb', 'aa')
  F.node.writes.ring.place('p2', 'bb', 'cc')
  for (let s = 10, prev = 0; s <= 20; prev = s, s += 2) F.node.step({ kind: 'bytesIn', link: 1, bytes: p1frame(s, prev) })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:aa'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  const p = pump(F, 7, S, 2)
  armed = true
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) })
  p.toA() // six frames: 10-16 reach the socket, 18 and 20 and the reply fill the queue (3 of 3)
  const link = F.node.links.get(7)!
  assert.equal(link.queued.length, 3)
  assert.equal(link.synced, true)
  assert.deepEqual(link.inQueue && [link.inQueue.d.bb, link.inQueue.q], [17, 1])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: gappy(22, 24) }) // 22 clears (18, 20, the reply, 22), 24 survives
  assert.equal(F.jk(JK.dropOldest).length, 1)
  assert.equal(link.queued.length, 1)
  assert.deepEqual(link.torn && [link.torn.d.bb, link.torn.r, link.torn.q], [17, 1, 1], 'the answer\'s cover and reply, not lowered further')
  p.toB()
  for (let d = 0; d < 4 && (link.paused || link.torn !== null); d++) { F.node.step({ kind: 'drain', link: 7 }); p.settle() }
  p.settle()
  assert.deepEqual([...S.node.state.keys()].sort(), [...F.node.state.keys()].sort())
  assert.equal(digests(S, 2).filter((d) => d.r === 1).length, 1, 'ONE ask')
})

//! a MEMBER link is unchanged: its clear calls no onClear and leaves no cover; the drain digest is its heal, as before
test('a clear on an unscoped MEMBER link is unchanged: no onClear, no cover — the drain digest heals it', () => {
  const F = harness('nn', { tune: { queued: 1 } })
  F.admit(1, 'zz'); F.digestFrom(1)
  const link = F.node.links.get(1)!
  assert.equal(link.synced, true)
  assert.equal(link.onClear, null)
  F.node.step({ kind: 'pause', link: 1 })
  for (let i = 0; i < 3; i++) F.node.step({ kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear on the member link')
  assert.equal(link.torn, null, 'no cover')
  assert.equal(link.droppedWhilePaused, true, 'the drain digest is owed, as before')
  F.node.step({ kind: 'drain', link: 1 })
  assert.deepEqual(digests(F, 1).slice(-1), [{ d: { nn: F.node.seq }, r: 1 }], 'the drain digest, member bytes (no h)')
})

//! ── V4-51: a digest answer whose run passes the frame cap leaves in cuts ──────────
// A server whose rows outgrow one frame TOGETHER (each row small, the run big) answers a late client frame by frame at
// its cap. Before V4-51 the answer was one frame per run, so at full scale a run past 256 MiB threw a FrameError in the
// DIGEST handler and the client's link was dropped for good; the tune row `frame` makes that reachable at 4 KiB.
const bigRows = (n: number): Rec[] => Array.from({ length: n }, (_, i) => ({ type: REC.update, key: [`r${i + 1}`], value: new Uint8Array(1500).fill(i + 1) }))
//! a feeder that wrote one run of ten 1.5 KB rows (one commit, its own lane), with a client admitted on link 7
const bigFeeder = (tune: Record<string, number>, onSend?: (link: number) => void) => {
  const F = harness('ff', { tune }, onSend)
  F.node.step({ kind: 'write', recs: bigRows(10) })
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: '', r: 1 }) })
  return F
}
//! the frames sent on a link from `from`, each as its seqs ('1+2') or its verb
const wireOf = (h: H, link: number, from = 0) =>
  h.of('send').filter((e) => e[1] === link).slice(from).flatMap((e) => new Framer().push((e[2] as Uint8Array).slice()))
    .map((f) => f.verb === VERB.RECORDS ? f.records().map((rv) => rv.seq).join('+') : f.verb === VERB.DIGEST ? 'DIGEST' : `verb${f.verb}`)

test('a late client of a server whose rows outgrow one frame together gets every row: the catch-up run leaves in cuts, the reply last', () => {
  const F = bigFeeder({ frame: 4096 })
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  assert.deepEqual(wireOf(F, 7, m), ['1+2', '3+4', '5+6', '7+8', '9+10', 'DIGEST'], 'five cuts of one run, every seq once, the reply last')
  const sent = F.of('send').filter((e) => e[1] === 7).slice(m).map((e) => e[2] as Uint8Array)
  assert.ok(sent.every((b) => b.length - 11 <= 4096), `every frame within the cap (${sent.map((b) => b.length - 11)})`)
  assert.deepEqual(F.jk(JK.frameDrop), [])
  assert.equal(F.node.links.get(7)!.dead, false, 'the link stays up')
  assert.equal(F.node.links.get(7)!.synced, true)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [10])
  //! the same answer at the default cap: one frame, as before
  const G = bigFeeder({})
  const g = G.of('send').filter((e) => e[1] === 7).length
  G.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  assert.deepEqual(wireOf(G, 7, g), ['1+2+3+4+5+6+7+8+9+10', 'DIGEST'])
})

test('a torn answer between two cuts of one run: the cover names the first record not handed over, the drain resumes there, every row once, the reply last', () => {
  let armed = false, count = 0
  const F: H = bigFeeder({ frame: 4096, queued: 2 }, (link) => { if (link === 7 && armed && ++count === 2) { armed = false; F.node.step({ kind: 'pause', link: 7 }) } })
  const link = F.node.links.get(7)!
  const m = F.of('send').filter((e) => e[1] === 7).length
  armed = true
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  assert.deepEqual(wireOf(F, 7, m), ['1+2', '3+4'], 'the socket took two cuts, then said it was full')
  assert.deepEqual(link.queued.map((b) => new Framer().push(b.slice())[0].records().map((rv) => rv.seq).join('+')), ['5+6', '7+8'], 'two more wait in the queue')
  assert.deepEqual(link.torn && [link.torn.d.ff, link.torn.r, link.torn.q], [8, 1, 1], 'the ship stopped INSIDE the run, before 9: the cover is 8')
  assert.equal(link.synced, false)
  assert.deepEqual(F.jk(JK.dropOldest), [], 'never a deliberate overflow')
  const d = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(wireOf(F, 7, d), ['5+6', '7+8', '9+10', 'DIGEST'], 'the queue, the rest of the run from 9, then the reply')
  assert.deepEqual(wireOf(F, 7, m).filter((x) => x !== 'DIGEST').flatMap((x) => x.split('+').map(Number)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every row once')
  assert.equal(link.synced, true)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [8, 2], 'the records each round handed over')
})

//! the same stop at the BYTE bound (Link.full, tune row queuedBytes): with queuedBytes 1 one queued cut fills the queue,
// whatever the count bound says, so the ship stops between two cuts of the run instead of queuing the rest. Read with
// the stop between cuts counting frames only, the run went on into the queue and stopped only before the reply.
test('a torn answer between two cuts of one run at the BYTE bound: one queued cut fills the queue, the ship stops inside the run, the drain resumes there, every row once, the reply last', () => {
  let armed = false, count = 0
  const F: H = bigFeeder({ frame: 4096, queuedBytes: 1 }, (link) => { if (link === 7 && armed && ++count === 2) { armed = false; F.node.step({ kind: 'pause', link: 7 }) } })
  const link = F.node.links.get(7)!
  const m = F.of('send').filter((e) => e[1] === 7).length
  armed = true
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  assert.deepEqual(wireOf(F, 7, m), ['1+2', '3+4'], 'the socket took two cuts, then said it was full')
  assert.deepEqual(link.queued.map((b) => new Framer().push(b.slice())[0].records().map((rv) => rv.seq).join('+')), ['5+6'], 'one cut waits: it holds queuedBytes')
  assert.deepEqual(link.torn && [link.torn.d.ff, link.torn.r, link.torn.q], [6, 1, 1], 'the ship stopped INSIDE the run, before 7: the cover is 6')
  assert.deepEqual(F.jk(JK.dropOldest), [], 'never cleared')
  const d = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(wireOf(F, 7, d), ['5+6', '7+8', '9+10', 'DIGEST'], 'the queue, the rest of the run from 7, then the reply')
  assert.deepEqual(wireOf(F, 7, m).filter((x) => x !== 'DIGEST').flatMap((x) => x.split('+').map(Number)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every row once')
  assert.equal(link.synced, true)
  assert.deepEqual(F.jk(JK.aeShip).map((e) => e.b), [6, 4])
})

//! ── the review of wave 6a (2026-10-12): a spoke that SYNCS while its feeder is not holding a partition it has rows of.
// The digest answer shipped the HELD subset only, so a spoke synced while px was acquiring (a repair: held-found-lagging,
// the shape of STATUS's first sighting) or an orphan got nothing of px, and the fold then forwarded only the records the
// lane lacked: the base stayed missing while the feeder lived (the heartbeat floor exchange ships above the spoke's
// tail only), and a forwarded delta OLDER than a base record the spoke never got showed an overwritten value as current.
// Now the answer ships every partition the feeder FEEDS (Scope.feeds: all but an orphan's frozen copy and a latch
// re-entering from one), so a spoke synced mid-repair has the base at once and the fold's delta completes it; a fold
// that re-enters from an orphan forwards the whole partition, and lowers a stopped or queued answer's cover under it.
// Red on the tree as first landed (`feeds` = held, the delta alone): S = [px.c] where F = [px.a, px.b, px.c]; px.a = 1
// where F shows 2.
const QX = (k: string, v: number): Rec => ({ type: REC.update, key: ['qx', k], value: v })
const one = (origin: string, rec: Rec, seq: number, pp: number, verb: number) => encodeRuns([{ rec, origin, seq, epoch: 1, pp }], verb, true)[0]
//! an armed feeder aa (bb and cc its peers; px and qx owned by bb, held by aa) and a spoke cl admitted on link 7 whose
// first digest is sent when the test calls connect(): the test chooses what px is at aa at that moment
const latching = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}, onSend?: (link: number) => void) => {
  const members = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  const F = harness('aa', { replicas: 2, boot: { epoch: 1, members }, ...opts }, onSend)
  F.node.step({ kind: 'start' })
  F.admit(1, 'bb'); F.digestFrom(1)
  F.admit(2, 'cc'); F.digestFrom(2)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: members }) })
  assert.equal(F.node.armed, true)
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.writes.ring.place('qx', 'bb', 'aa')
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:aa'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  const p = pump(F, 7, S, 2)
  const link = F.node.links.get(7)!
  const connect = () => { S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) }); p.settle() }
  const cells = (h: H) => [...h.node.state].map(([k, v]) => k + '=' + JSON.stringify(v)).sort()
  const laneAt = (h: H, origin: string) => h.node.logs.get(origin)?.map((e) => e.seq) ?? []
  const beat = (n: number) => { for (let i = 0; i < n; i++) { F.tick(); p.settle(); S.tick(); p.settle() } }
  //! the teacher on `from` ships rows of px (ACQ) and ACQDONE with the cut
  const teach = (from: number, rows: { seq: number; rec: Rec; pp: number; iss?: string; cid?: number }[], cut: number) => {
    for (const r of rows) F.node.step({ kind: 'bytesIn', link: from, bytes: encodeRuns([{ rec: r.rec, origin: 'bb', seq: r.seq, epoch: 1, pp: r.pp, iss: r.iss, cid: r.cid }], VERB.ACQ, true)[0] })
    F.node.step({ kind: 'bytesIn', link: from, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: cut }, n: rows.length }) })
  }
  return { F, S, p, link, connect, cells, laneAt, beat, teach }
}

for (const other of [false, true])
  test(`wave 6a review — a spoke that syncs while its feeder RE-LATCHES a partition it held (a repair) gets the base from the answer and the delta from the fold, and nothing is left for the heartbeats (another partition on the lane: ${other})`, () => {
    const { F, S, p, link, connect, cells, laneAt, beat, teach } = latching()
    //! px held at aa with bb#3, bb#5 (a chained base); qx on the same lane when `other`
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
    if (other) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    assert.equal(F.node.scope!.held('px'), true)
    //! cc announces px with bb at 7: aa is behind and re-latches px — its base stays in the lane, not held, still FED
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
    assert.equal(F.node.scope!.held('px'), false, 'px is acquiring')
    assert.equal(F.node.scope!.feeds('px'), true, 'a repair of a held base is still a spoke feed')
    //! the spoke connects NOW (a fresh connect; a failover's resync asks the same d = {})
    connect()
    assert.equal(link.synced, true, 'the spoke link synced mid-latch')
    assert.deepEqual(laneAt(S, 'bb'), other ? [3, 5, 6] : [3, 5], 'the answer shipped the base of the partition under repair (it shipped nothing of it before)')
    teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }], 7)
    assert.equal(F.node.scope!.held('px'), true, 'the fold')
    assert.deepEqual(laneAt(S, 'bb'), other ? [3, 5, 6] : [3, 5], 'before the pump: the delta is on the wire, sent in the fold\'s own step')
    p.settle()
    assert.deepEqual(cells(S), cells(F), 'the spoke mirrors its feeder right after the fold')
    assert.deepEqual(laneAt(S, 'bb'), other ? [3, 5, 6, 7] : [3, 5, 7], 'lane bb at the spoke is whole')
    beat(3)
    assert.deepEqual(cells(S), cells(F), 'and stays so through the heartbeats')
  })

test('wave 6a review — a spoke that syncs while its feeder holds a partition as an ORPHAN gets nothing of it (a frozen copy is no spoke feed); the fold that re-enters it from the orphan forwards the WHOLE partition, base and delta', () => {
  const { F, S, p, link, connect, cells, laneAt, teach } = latching()
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  F.node.step({ kind: 'linkDown', link: 2, reason: 'close' }) // the teacher dies: the latch aborts with residue, px is an orphan
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan)
  assert.equal(F.node.scope!.feeds('px'), false, 'an orphan is never a spoke feed')
  connect()
  assert.equal(link.synced, true)
  assert.deepEqual(laneAt(S, 'bb'), [], 'nothing of px: its copy at aa is frozen')
  //! cc comes back and announces px: the orphan re-enters through the latch (preState orphan)
  F.admit(5, 'cc'); F.digestFrom(5)
  F.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring)
  assert.equal(F.node.scope!.feeds('px'), false, 'a latch re-entering from an orphan is not fed until its fold')
  teach(5, [{ seq: 7, rec: PX('c', 3), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true, 'the re-entry fold')
  p.settle()
  assert.deepEqual(laneAt(S, 'bb'), [3, 5, 7], 'the whole of px: the base the answer withheld and the delta')
  assert.deepEqual(cells(S), cells(F), 'the spoke mirrors its feeder')
})

test('wave 6a review — a spoke that syncs mid-repair never shows an OVERWRITTEN value as current: the base record that supersedes a forwarded delta record came with the answer, so the older one loses the election at the spoke', () => {
  const { F, S, p, connect, cells, teach } = latching()
  //! bb#3 (px.a = 1) is lost on the way to aa; bb#5 (px.a = 2, pp 3) arrives and folds with a gapped floor
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  assert.equal(F.node.scope!.held('px'), true)
  assert.equal(F.node.streams.get('bb')!.parts!.get('px')!.s, 0, 'the floor waits for the chain')
  //! cc, a co-holder with the whole chain, announces px: aa re-latches
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  connect()
  assert.equal(S.node.state.get(JSON.stringify(['px', 'a'])), 2, 'the answer brought px.a = 2 (bb#5)')
  //! the teacher ships 3, 5 and 7: the fold adds 3 and 7 (5 is in the lane) and forwards those two
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('a', 2), pp: 3 }, { seq: 7, rec: PX('b', 3), pp: 5 }], 7)
  p.settle()
  assert.deepEqual(cells(S), cells(F), 'the spoke mirrors its feeder')
  assert.equal(S.node.state.get(JSON.stringify(['px', 'a'])), 2, 'px.a = 2: bb#3 lost the election at the spoke (it showed 1 as current, for good, before)')
  assert.deepEqual(S.of('apply').filter((e) => JSON.stringify((e[1] as Rec).key) === JSON.stringify(['px', 'a'])).map((e) => (e[1] as Rec).value), [2], 'the spoke never showed 1')
})

//! a stopped answer across a re-entry: the spoke's first-connect answer tears (the link pauses inside its first frame and
// the queue holds one) while px is an orphan at aa, so the ship skipped px and the cover sits at lane bb's tail. Then px
// re-enters through the latch and folds. The fold lowers the cover under px's rows (indexInsert lowers it only under the
// one row the fold ADDS, 7: a resume from there ships 7 and misses the base), and the resumed answer ships px whole.
test('wave 6a review — a spoke whose first answer STOPPED while a partition was an orphan at its feeder: the re-entry fold lowers the stopped answer\'s cover under that partition\'s rows, and the resume ships it whole', () => {
  let armed = false, count = 0
  const h = latching({ tune: { queued: 1 } }, (link) => { if (link === 7 && armed && ++count === 1) { armed = false; h.F.node.step({ kind: 'pause', link: 7 }) } })
  const { F, S, p, link, connect, cells, laneAt, teach } = h
  //! qx at bb 10, 12, 14, 16 (gappy: four frames); px at bb 3, 5, then frozen by its teacher's death
  for (let s = 10, prev = 0; s <= 16; prev = s, s += 2) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX(`q${s}`, s), s, prev, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  F.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan)
  armed = true
  connect()
  assert.equal(link.paused, true, 'the link paused inside the answer\'s first frame')
  assert.equal(link.synced, false, 'the ship stopped: the link is not synced')
  assert.ok(link.torn !== null && link.torn.d.bb >= 11, `the cover sits above px's rows (bb ${link.torn?.d.bb}): the ship skipped the orphan`)
  //! cc comes back: the re-entry latch and its fold
  F.admit(5, 'cc'); F.digestFrom(5)
  F.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  teach(5, [{ seq: 7, rec: PX('c', 3), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  assert.equal(link.torn!.d.bb, 2, 'the fold lowered the cover to just under px\'s lowest row (3), not only under the row it added (7)')
  for (let d = 0; d < 8 && (link.paused || link.torn !== null); d++) { F.node.step({ kind: 'drain', link: 7 }); p.settle() }
  p.settle()
  assert.equal(link.synced, true)
  assert.deepEqual(laneAt(S, 'bb'), [3, 5, 7, 10, 12, 14, 16], 'the resumed answer shipped px whole')
  assert.deepEqual(cells(S), cells(F))
})

//! the same stopped answer, with a CLEAR between the re-entry fold and the drain (the review's review: the inQueue
// lowering had no test). Two covers sit on the link: `inQueue`, the answer's cover at its one QUEUED frame (bb: 11, the
// frame is bb#12), and `torn`, at the tear (bb: 13). The fold lowers both to 2. A method reply shipped on the paused
// link overflows the queue of one: the clear takes the queued frame and the reply, and makes the queued answer the torn
// one (Link.ship: torn = inQueue), so it is inQueue's cover the drain resumes from. Without the fold's lowering of
// inQueue, indexInsert alone leaves it at 6 (under the one row the fold ADDED), the resume ships 7, 10, 12, 14, 16 and
// the spoke never gets px's base (its lane reads [7, 10, 12, 14, 16]); red that way.
test('wave 6a review — the same, with a clear between the re-entry fold and the drain: the clear promotes the queued answer\'s cover, which the fold lowered too, and the resume ships the partition whole', () => {
  let armed = false, count = 0
  const h = latching({ tune: { queued: 1 } }, (link) => { if (link === 7 && armed && ++count === 1) { armed = false; h.F.node.step({ kind: 'pause', link: 7 }) } })
  const { F, S, p, link, connect, cells, laneAt, teach } = h
  for (let s = 10, prev = 0; s <= 16; prev = s, s += 2) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX(`q${s}`, s), s, prev, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  F.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan)
  armed = true
  connect()
  assert.equal(link.paused, true)
  assert.deepEqual([link.inQueue!.d.bb, link.torn!.d.bb], [11, 13], 'the queued answer\'s cover (bb#12 waits in the queue) and the tear\'s')
  F.admit(5, 'cc'); F.digestFrom(5)
  F.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  teach(5, [{ seq: 7, rec: PX('c', 3), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  assert.deepEqual([link.inQueue!.d.bb, link.torn!.d.bb], [2, 2], 'the fold lowered BOTH covers under px\'s lowest row (indexInsert alone leaves inQueue at 6, under the one row the fold added)')
  //! a method reply on the paused link: the queue of one overflows — a clear
  F.node.step({ kind: 'reply', link: 7, id: 1, ok: true, value: 0 })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'the clear took the queued frame and the reply')
  assert.equal(link.inQueue, null)
  assert.equal(link.torn!.d.bb, 2, 'the queued answer is the torn one now, with its lowered cover (6 without the inQueue lowering)')
  for (let d = 0; d < 8 && (link.paused || link.torn !== null); d++) { F.node.step({ kind: 'drain', link: 7 }); p.settle() }
  p.settle()
  assert.equal(link.synced, true)
  assert.deepEqual(laneAt(S, 'bb'), [3, 5, 7, 10, 12, 14, 16], 'the resumed answer shipped px whole, and re-sent the frame the clear took')
  assert.deepEqual(cells(S), cells(F))
})

//! V4-7 through the latch (the review of wave 6a asked for the end-to-end): a spoke's write relayed by a feeder that is
// ACQUIRING the partition. The owner's WACK reaches the relay, which expects to fold the record (scope.expects: an open
// latch), so it hops the WACK to the spoke with `l` (wave 5e: wait for my tap) and the spoke keeps the coordinates; the
// record reaches the relay only through the teacher's ACQ (the owner's live fan-out of it staged and was discarded under
// the cut), and the fold's forward carries it to the spoke with its attempt identity, so the spoke's write-route join
// settles it: the value shows, then the promise, once, never through `acked`. Before wave 6a the record was never
// forwarded and the write hung while that feeder lived (the "or never" clause of the api's STATUS line).
test('wave 6a — a spoke\'s write relayed through a feeder that is ACQUIRING the partition: the WACK hops with `l`, the record comes to the feeder through the teacher alone, the fold\'s forward carries its attempt identity, and the spoke settles through the join — value first, once, no `acked`', () => {
  const { F, S, p, connect, teach } = latching()
  connect()
  //! cc announces px with bb at 6: aa, assigned and empty, latches from zero (the hand-off shape)
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 6 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring)
  //! the spoke writes px.k: aa relays it to the owner bb
  S.node.step({ kind: 'write', recs: [PX('k', 1)] })
  p.toA()
  assert.equal(F.sentOn(1, VERB.WRITE).length, 1, 'aa relayed the write to bb')
  assert.equal(F.node.writes.pending.size, 1)
  //! bb's WACK: committed at bb#7. aa expects to fold px (the latch is open), so the hop names the lane as `l`
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 7, e: 1, o: 'bb' }) })
  assert.equal(F.node.writes.pending.size, 0, 'the relay cleared its attempt')
  const hop = F.sentOn(7, VERB.WACK).map((f) => f.value as { l?: string; o?: string })
  assert.deepEqual(hop.map((v) => [v.l, v.o]), [['bb', undefined]], 'the hop carries `l`: wait for the tap, here is where it committed')
  p.toB()
  assert.equal(S.node.writes.pending.size, 0, 'the spoke cleared the attempt: nothing is re-sent')
  assert.deepEqual(S.of('acked'), [], 'the WACK with `l` is not the settlement')
  const joins = () => S.of('apply').filter((e) => (e[1] as { iss?: string; cid?: number }).iss === 'cl~1' && (e[1] as { cid?: number }).cid === 1)
  assert.equal(joins().length, 0, 'the value has not shown: the record is not at the feeder')
  //! the owner's live fan-out of bb#7 reaches aa mid-latch: it stages; the teacher ships it as ACQ with the identity
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: PX('k', 1), origin: 'bb', seq: 7, epoch: 1, iss: 'cl~1', cid: 1, pp: 6 }], VERB.RECORDS, true)[0] })
  assert.equal(joins().length, 0, 'staged, not folded, not forwarded')
  teach(2, [{ seq: 6, rec: PX('j', 0), pp: 0 }, { seq: 7, rec: PX('k', 1), pp: 6, iss: 'cl~1', cid: 1 }], 7)
  assert.equal(F.node.scope!.held('px'), true, 'the fold (the staged live copy of 7 is under the cut and discarded)')
  p.settle()
  assert.equal(S.node.state.get(JSON.stringify(['px', 'k'])), 1, 'the value shows at the spoke')
  assert.equal(joins().length, 1, 'the apply carries the attempt identity exactly once: the join settles the write (V4-7: value, then promise)')
  assert.deepEqual(S.of('acked'), [], 'never `acked`: the join was the settlement')
  assert.equal(S.node.writes.stranded, false)
})

//! the re-entry twin (the review's review, 2026-10-12): the same write, relayed while px RE-ENTERS from an orphan at the
// relay. The fold's forward is then the whole of px (#forwardWhole), and it must carry each lane entry's attempt
// identity too. With it dropped the value still shows (the record arrives), but no join settles the write, no `acked`
// comes (the WACK hopped with `l`: wait for my tap), and the attempt is gone from the spoke's table — the promise never
// settles, while every other suite stays green. Red with the identity dropped from #forwardWhole: joins 0.
test('wave 6a — the same write relayed while px RE-ENTERS from an orphan at the relay: the whole-partition forward carries the attempt identity, and the spoke settles through the join once', () => {
  const { F, S, p, connect, cells, beat, teach } = latching()
  //! px held at aa (bb#3, bb#5); cc announces bb at 6 and dies mid-latch: px freezes into an orphan
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 6 } } }) })
  F.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan)
  //! the spoke connects while px is frozen (it gets nothing of px); cc comes back and re-announces: the re-entry latch
  connect()
  F.admit(5, 'cc'); F.digestFrom(5)
  F.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 6 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring)
  assert.equal(F.node.scope!.entries.get('px')!.preState, SCOPE.orphan, 'a re-entry')
  //! the spoke writes px.k; aa relays it; bb's WACK says bb#7; aa expects to fold px, so the hop carries `l`
  S.node.step({ kind: 'write', recs: [PX('k', 1)] })
  p.toA()
  assert.equal(F.sentOn(1, VERB.WRITE).length, 1, 'aa relayed the write to bb')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 7, e: 1, o: 'bb' }) })
  assert.deepEqual(F.sentOn(7, VERB.WACK).map((f) => (f.value as { l?: string }).l), ['bb'], 'the hop carries `l`')
  p.toB()
  assert.equal(S.node.writes.pending.size, 0, 'the spoke cleared the attempt: nothing is re-sent')
  const joins = () => S.of('apply').filter((e) => (e[1] as { iss?: string; cid?: number }).iss === 'cl~1' && (e[1] as { cid?: number }).cid === 1)
  assert.equal(joins().length, 0, 'the value has not shown: the record is not at the feeder')
  //! bb's live fan-out of #7 stages at aa; the teacher ships 6 and 7 (7 with the identity) and the fold re-enters px
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: PX('k', 1), origin: 'bb', seq: 7, epoch: 1, iss: 'cl~1', cid: 1, pp: 6 }], VERB.RECORDS, true)[0] })
  teach(5, [{ seq: 6, rec: PX('j', 0), pp: 5 }, { seq: 7, rec: PX('k', 1), pp: 6, iss: 'cl~1', cid: 1 }], 7)
  assert.equal(F.node.scope!.held('px'), true, 'the re-entry fold')
  p.settle()
  beat(2)
  assert.deepEqual(cells(S), cells(F), 'the whole of px reached the spoke')
  assert.equal(S.node.state.get(JSON.stringify(['px', 'k'])), 1, 'the value shows at the spoke')
  assert.equal(joins().length, 1, 'the whole-partition forward carried the attempt identity: the join settled the write once (0 with it dropped: the promise never settles)')
  assert.deepEqual(S.of('acked'), [], 'never `acked`: the join was the settlement')
  assert.equal(S.node.writes.stranded, false)
})

//! ── wave 6b: a client leaves a feeder whose gate is shut (DECISIONS V4-NN) ──
test('wave 6b — a client leaves a feeder whose gate is SHUT for a linked server whose gate is OPEN: the words come on digests and PONGs, the feeder link is closed on purpose (journal refeed), its linkDown elects the open one and reparks the in-flight attempt; with no open server known it stays; the shut feeder comes back as a spare and is moved to when the roles flip', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb', 'sim:cc'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa'); h.admit(2, 'bb'); h.admit(3, 'cc')
  assert.equal(h.node.primary, 1, 'the first admitted server feeds')
  const digest = (link: number, w: number) => h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0, w }) })
  const pong = (link: number, w?: number) => h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.PONG, w === undefined ? undefined : { w }) })
  const gate = (link: number) => h.node.links.get(link)?.gateOpen
  const closes = () => h.of('close').map((e) => [e[1], e[2]])
  h.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['k'], value: 1 }] })
  assert.equal(h.sentOn(1, VERB.WRITE).length, 1, 'the attempt went to the feeder')
  //! the feeder says shut; nothing is known of the others: stay (its writes wait, as before)
  digest(1, 0)
  assert.equal(h.node.feederOpen, false)
  assert.equal(h.node.primary, 1, 'no open server known: the client stays')
  assert.deepEqual(closes(), [], 'nothing closed')
  //! a bare PONG (an old server) teaches nothing; a shut server is no reason to move
  pong(2)
  assert.equal(gate(2), null, 'a PONG without w leaves the gate unknown')
  pong(3, 0)
  assert.equal(gate(3), false)
  assert.equal(h.node.primary, 1, 'two shut servers: stay')
  //! bb says open on its PONG (a server this client does not follow: no digest flows there when the client is the lower uuid): MOVE
  pong(2, 1)
  assert.equal(gate(2), true)
  assert.deepEqual(closes(), [[1, 'feeder-shut']], 'the feeder link is closed on purpose')
  assert.deepEqual(h.jk(JK.refeed).map((e) => [e.a, e.b]), [[1, 2]], 'journaled: from link 1 to link 2')
  assert.equal(h.node.links.get(1)!.dead, true, 'dead until its linkDown echo: the drain parks, nothing is sent to it')
  //! the linkDown echo is the ordinary failover: the OPEN server is elected (not the first admitted), digested, the attempt reparked onto it
  h.node.step({ kind: 'linkDown', link: 1, reason: 'feeder-shut' })
  assert.equal(h.node.primary, 2, 'the open server feeds now')
  assert.equal(h.node.feederOpen, true, "its word was kept: writable at once, no wait for a digest")
  assert.equal(h.sentOn(2, VERB.DIGEST).length, 1, 'the failover digest asks the new feeder for the suffixes')
  assert.equal(h.sentOn(2, VERB.WRITE).length, 1, 'the in-flight attempt re-sent to the new relay now')
  assert.ok(h.of('timer').some((t) => t[2] === TAG.redial), 'the shut feeder is redialed like any lost link (it stays a candidate)')
  //! aa comes back: a spare, not the feeder; its gate unknown again (a fresh link)
  h.admit(4, 'aa')
  assert.equal(h.node.primary, 2)
  assert.equal(gate(4), null)
  //! the roles flip: bb (the feeder) shuts — aa unknown, cc shut: stay; then aa says open on a digest the client does not answer: move
  digest(2, 0)
  assert.equal(h.node.primary, 2, 'nothing open known: stay')
  assert.equal(closes().length, 1)
  digest(4, 1)
  assert.deepEqual(closes()[1], [2, 'feeder-shut'])
  assert.equal(h.sentOn(4, VERB.DIGEST).length, 0, 'the non-primary digest was not answered (the single-feeder rule)')
  h.node.step({ kind: 'linkDown', link: 2, reason: 'feeder-shut' })
  assert.equal(h.node.primary, 4, 'back on aa')
  //! every server shut: the client stays on its feeder (its writes wait for the gate)
  digest(4, 0); pong(3, 0)
  assert.equal(h.node.primary, 4)
  assert.equal(closes().length, 2, 'no third close')
  assert.equal(h.jk(JK.refeed).length, 2)
})

test('wave 6b — a feeder that DIES is replaced by a linked server whose gate is known open before the first admitted one; a server whose gate is unknown is taken when none is known open', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa', 'sim:bb', 'sim:cc', 'sim:dd'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa'); h.admit(2, 'bb'); h.admit(3, 'cc'); h.admit(4, 'dd')
  const pong = (link: number, w: number) => h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.PONG, { w }) })
  pong(2, 0); pong(3, 1)
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.primary, 3, 'cc: the first whose gate is known open (bb said shut, dd never said)')
  pong(2, 0)
  h.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  assert.equal(h.node.primary, 2, 'none known open: the first admitted (bb, shut) — the client would rather wait on a known gate than on nothing; dd says open next:')
  pong(4, 1)
  assert.deepEqual(h.of('close').map((e) => [e[1], e[2]]), [[2, 'feeder-shut']], 'and the move rule takes it there')
})

test("wave 6b — a server's PONG toward a CLIENT link carries its gate (w); toward a member it is the bare frame it always was; a client's PONG is bare; a member reads no w off a PONG", () => {
  const s = harness('aa')
  s.node.step({ kind: 'start' })
  s.admit(1, 'bb')
  s.admit(2, 'zz', 1)
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PING) })
  s.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.PING) })
  assert.deepEqual(s.sentOn(1, VERB.PONG).map((f) => f.value), [undefined], 'member bytes unchanged')
  assert.deepEqual(s.sentOn(2, VERB.PONG).map((f) => f.value), [{ w: 1 }], 'the gate rides the PONG to the client (epoch 0: open genesis)')
  //! a member that is handed a PONG with w keeps no gate for it: the word is a client's to read
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PONG, { w: 0 }) })
  assert.equal(s.node.links.get(1)!.gateOpen, null)
  const c = harness('cl', { client: true, hosts: ['sim:aa'] })
  c.node.step({ kind: 'start' })
  c.admit(1, 'aa')
  c.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.PING) })
  assert.deepEqual(c.sentOn(1, VERB.PONG).map((f) => f.value), [undefined], "a client's PONG is bare: it has no gate")
})

test('wave 6b — a relay forgets what it held for a client whose link died: a write parked behind the shut gate leaves the queue at the linkDown (the client re-sends it to its next relay; a kept copy committed a second time after the heal); the client back on this relay re-sends and it is queued afresh', () => {
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  //! a four-member view with one member linked: two of four is no majority — the gate is shut, every relayed attempt parks
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc'], ['dd', 'sim:dd']] }) })
  assert.equal(h.node.membership.gate(h.node).open, false, 'minority: the gate is shut')
  h.admit(2, 'zz', 1)
  const write = (link: number) => h.node.step({ kind: 'bytesIn', link, bytes: encodeRuns([{ rec: { type: REC.update, key: ['k'], value: 1 }, origin: 'zz~1', seq: 1, epoch: 0 }], VERB.WRITE, false)[0] })
  write(2)
  assert.equal(h.node.writes.pending.size, 1, 'parked behind the gate')
  assert.equal(h.jk(JK.writeBuffered).length, 1)
  h.node.step({ kind: 'linkDown', link: 2, reason: 'feeder-shut' })
  assert.equal(h.node.writes.pending.size, 0, 'the client is gone: nothing is held for it')
  //! the client is back (a redial, a re-election of this relay): its re-send is queued afresh, under the new link
  h.admit(3, 'zz', 1)
  write(3)
  assert.equal(h.node.writes.pending.size, 1)
  assert.equal([...h.node.writes.pending.values()][0].via, 3)
  //! a MEMBER link's death drops nothing: an attempt a member forwarded is its own to retry
  h.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  assert.equal(h.node.writes.pending.size, 1, "the member's linkDown left the client's attempt in place")
})

//! ── wave 6c: the spoke edge cases the M12 oracle found (DECISIONS V4-NN) ──

//! the shed's word (STATUS "a spoke keeps showing the rows of a partition that moved off its feeder"): a join moved px
// off aa — the install's rescope froze aa's copy into an orphan, and once every current holder attested its frozen
// tails the data left aa (scope.ts #shed). Nothing told the spoke: it kept px.a and px.b on its screen, frozen, until
// a failover's resync wiped them (spokeStale counted them in the scoped sweep). Now the shed ships FEED {x: [px]} to
// every client link, and the spoke drops px with its feeder — its cells, its lane entries and its screen cells. The
// lane entries matter: a kept one makes the spoke's dual fence drop a later re-feed of the same record as present, so
// when aa re-acquires px (the from-zero latch; the fold forwards it whole) the rows must come back. Red on the tree
// before at "the spoke dropped px with its feeder": the spoke still showed px.a and px.b.
//! screenRows — the downstream object's top-level keys (every apply effect folded in order), for a spoke harness
const screenRows = (h: H): string[] => {
  const root: Record<string, unknown> = {}
  for (const e of h.of('apply')) {
    const r = e[1] as Rec
    const k = r.key.length ? r.key : [r.at ?? '']
    if (k.length === 1) { if (r.type === REC.remove) delete root[k[0]]; else root[k[0]] = r.value; continue }
    if (r.type === REC.remove) { const o = root[k[0]]; if (typeof o === 'object' && o !== null) delete (o as Record<string, unknown>)[k[1]]; continue }
    if (typeof root[k[0]] !== 'object' || root[k[0]] === null) root[k[0]] = {}
    ;(root[k[0]] as Record<string, unknown>)[k[1]] = r.value
  }
  return Object.keys(root).filter((k) => typeof root[k] !== 'object' || Object.keys(root[k] as object).length > 0).sort()
}
//! screenCells — the same fold, two levels deep ('row.field' per live field, 'row' for a scalar row), for a spoke harness
const screenCells = (h: H): string[] => {
  const root: Record<string, unknown> = {}
  for (const e of h.of('apply')) {
    const r = e[1] as Rec
    const k = r.key
    if (k.length === 1) { if (r.type === REC.remove) delete root[k[0]]; else root[k[0]] = r.value; continue }
    if (r.type === REC.remove) { const o = root[k[0]]; if (typeof o === 'object' && o !== null) delete (o as Record<string, unknown>)[k[1]]; continue }
    if (typeof root[k[0]] !== 'object' || root[k[0]] === null) root[k[0]] = {}
    ;(root[k[0]] as Record<string, unknown>)[k[1]] = r.value
  }
  const out: string[] = []
  for (const [a, v] of Object.entries(root)) if (typeof v === 'object' && v !== null) for (const b of Object.keys(v)) out.push(a + '.' + b); else out.push(a)
  return out.sort()
}
//! kernelCells — the kernel's cells as 'row.field', for a screen comparison
const kernelCells = (h: H): string[] => [...h.node.state.keys()].map((k) => (JSON.parse(k) as string[]).join('.')).sort()
//! fedCells — the feeder's cells of the partitions it FEEDS (scope.ts `feeds`: an orphan's frozen rows are no spoke's):
// what a spoke equals at the end of every heal exchange (the rule's clause 3)
const fedCells = (h: H): string[] => [...h.node.state.keys()].map((k) => JSON.parse(k) as string[]).filter((k) => h.node.scope === null || h.node.scope.feeds(k[0])).map((k) => k.join('.')).sort()
//! onQQ — a spoke first fed by qq (hand-driven on link 3, admitted first so it is the primary) holding the given px cells
// ([field, value, seq, pp] on lane bb) and qx.z at bb#qxSeq, its first download ended; aa admitted as the spare
const onQQ = (L: ReturnType<typeof latching>, px: [string, number, number, number][], qxSeq = 8) => {
  const { S } = L
  S.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:qq' })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'qq', i: 1, l: 'sim:qq', c: SCOPED }) })
  for (const [k, v, seq, pp] of px) S.node.step({ kind: 'bytesIn', link: 3, bytes: one('bb', PX(k, v), seq, pp, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: one('bb', QX('z', 9), qxSeq, 0, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { bb: Math.max(qxSeq, ...px.map((x) => x[2])) }, r: 0, q: 1, w: 1 }) })
  L.connect()
  assert.equal(S.node.primary, 3, 'still fed by qq')
}
test('wave 6c — a shed tells the spokes: a partition that moved off the feeder (an orphan at the install, shed once every holder attested it) leaves the spoke with it — its cells, lane entries and screen rows go; a FEED from a spare link is dropped; a later re-acquire brings the partition back whole', () => {
  const { F, S, p, link, connect, cells, laneAt, teach } = latching()
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  connect()
  assert.deepEqual(cells(S), cells(F), 'the spoke holds px and qx')
  assert.deepEqual(screenRows(S), ['px', 'qx'])
  //! a join took px: the ring places it on bb and cc, and the install's rescope freezes aa's copy into an orphan
  F.node.writes.ring.place('px', 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan, 'px is an orphan at aa')
  p.settle()
  assert.deepEqual(cells(S), cells(F), 'frozen, not gone: the feeder still holds the frozen copy, and so does the spoke')
  //! both current holders attest px up to bb#5 (the shed poll's answers): the bar is met, the data leaves aa
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px'], 'aa shed px')
  assert.equal(F.node.scope!.entries.has('px'), false)
  p.settle()
  assert.deepEqual(cells(S), cells(F), 'the spoke dropped px with its feeder (it kept px.a and px.b for good before)')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the shed told the spoke in one FEED frame')
  assert.deepEqual(laneAt(S, 'bb'), [6], 'the lane entries of px left the spoke; qx\'s stays')
  assert.deepEqual(screenRows(S), ['qx'], 'and the screen shows qx alone')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]], 'the journal says what left: two lane entries of px')
  assert.equal(S.node.versions.has(JSON.stringify(['px', 'a'])), false, 'the versions of px\'s cells left too (a kept stamp would refuse the same record as not newer)')
  //! a FEED on a link that is not the primary (a spare feeder shedding a partition the real feeder holds) is dropped
  S.node.step({ kind: 'linkUp', link: 9, dialed: true, to: 'sim:zz' })
  S.node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', c: SCOPED }) })
  S.node.step({ kind: 'bytesIn', link: 9, bytes: encodeControl(VERB.FEED, { x: ['qx'] }) })
  assert.deepEqual(cells(S), cells(F), 'a spare\'s shed says nothing about what the feeder holds: qx stays')
  assert.ok(S.jk(JK.frameDrop).some((e) => e.a === 9 && e.b === 'feed from a spare'), 'dropped, journaled')
  //! a server drops a FEED: a spoke is never a feeder
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.FEED, { x: ['qx'] }) })
  assert.ok(F.jk(JK.frameDrop).some((e) => e.a === 7 && e.b === 'feed at a server'))
  assert.equal(F.node.scope!.held('qx'), true)
  //! px comes back to aa (the ring places it here again): the from-zero latch, and the fold forwards it whole
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'absent and assigned: the from-zero latch')
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }], 5)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  assert.deepEqual(cells(S), cells(F), 'px is back at the spoke (a kept lane entry would have made the dual fence drop the re-feed as present)')
  assert.deepEqual(laneAt(S, 'bb'), [3, 5, 6])
  assert.deepEqual(screenRows(S), ['px', 'qx'])
  assert.equal(link.synced, true)
})

//! the ceiling across a failover (STATUS "on an unscoped feeder, a row can still be lost when a spoke fails over between
// the drain and the capped answer"; the last review of V4-49). An UNSCOPED feeder aa, a spoke synced in steady state,
// the socket says full; six wide rows from bb arrive in one inbound frame and the tap cuts them at aa's frame cap
// (V4-51) into three frames of two, in ONE flush: 1+2 waits in the queue of one, 3+4 overflows it (the clear takes
// both), 5+6 survives — delivered at the drain, it raises the spoke's bb tail to 6 above the hole 1-4. V4-49's ceiling
// (aa's tails lowered to just under 1) capped the spoke's reply to the drain digest, so aa re-sent 1-4 — unless the spoke
// failed over after the drain digest and before that answer: the ceiling stayed on the dead link, the next feeder
// answered the spoke's own tail (6), and 1-4 were lost for good. Now the drain digest CARRIES the ceiling (`c`), the
// spoke keeps it, asks every feeder with the lower of its tails and the ceiling until a reply at or above its first
// capped ask lands (so it answers the drain digest with an r=1 of its own, which buys that reply), and the failover's
// digest to oo says bb: 0. Red on the tree before at "the hole is filled by the next feeder": the spoke held w5, w6.
const wide = (origin: string, from: number, keys: string[]) =>
  encodeRuns(keys.map((k, i) => ({ rec: { type: REC.update, key: [k], value: 'x'.repeat(1500) + k } as Rec, origin, seq: from + i, epoch: 1 })))[0]
const seqsOf = (b: Uint8Array) => new Framer().push(b.slice())[0].records().map((rv) => rv.seq).join('+')
const ceilingShape = () => {
  const F = harness('aa', { tune: { frame: 4096, queued: 1 } })
  F.admit(1, 'bb'); F.digestFrom(1)
  F.node.step({ kind: 'linkUp', link: 7, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 7, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const S = harness('cl', { client: true, hosts: ['sim:aa', 'sim:oo'] })
  S.node.step({ kind: 'start' })
  S.node.step({ kind: 'linkUp', link: 2, dialed: true, to: 'sim:aa' })
  const p = pump(F, 7, S, 2)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa' }) }) // no contract: unscoped
  p.settle()
  const link = F.node.links.get(7)!
  assert.equal(link.synced, true, 'steady state')
  assert.equal(S.node.feederScoped, false)
  //! the spare oo, admitted but never digested (the single-feeder rule)
  S.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:oo' })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'oo', i: 1, l: 'sim:oo' }) })
  assert.equal(S.node.primary, 2)
  F.node.step({ kind: 'pause', link: 7 })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: wide('bb', 1, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear, in the middle of one flush')
  assert.deepEqual(link.queued.map(seqsOf), ['5+6'], 'the last cut survived it')
  assert.deepEqual(link.torn, { d: { bb: 0 }, r: undefined, q: undefined, c: true }, 'the ceiling: bb lowered to just under 1, the lowest record the clear took')
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(wireOf(F, 7, m), ['5+6', 'DIGEST'], 'the drain: the surviving cut, then the drain digest (a ceiling is never resumed)')
  const drainDigest = F.sentOn(7, VERB.DIGEST).at(-1)!.value as { h?: number; c?: Record<string, number> }
  assert.equal(drainDigest.h, 1)
  p.toB()
  assert.deepEqual(cells(S).sort(), ['w5', 'w6'], 'the surviving cut raised the spoke\'s tail above the hole')
  assert.equal(S.node.streams.get('bb')!.applied, 6)
  const answer = digests(S, 2).at(-1)
  return { F, S, p, link, drainDigest, answer }
}
test('wave 6c — the ceiling crosses a failover: a clear mid-flush on an UNSCOPED feeder, the spoke fails over after the drain digest and before the capped answer — its ask to the next feeder is the lower of its tails and the ceiling the drain digest carried, and the hole is filled (lost for good before)', () => {
  const { S, drainDigest, answer } = ceilingShape()
  //! aa dies before the spoke's answer reaches it: the failover onto oo
  S.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(S.node.primary, 3, 'fed by oo')
  assert.equal(S.node.resync, null, 'unscoped: no resync, a digest with tails')
  const ask = digests(S, 3).at(-1)
  serve(S, 3, { bb: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'] })
  assert.deepEqual(cells(S).sort(), ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'], 'the hole is filled by the next feeder (w1-w4 were lost for good before)')
  assert.deepEqual(ask, { d: { bb: 0 }, r: 1, q: 3 }, 'the failover digest asked with the ceiling (bb: 0), not the tail of 6')
  assert.deepEqual(drainDigest.c, { bb: 0 }, 'the drain digest carried the ceiling')
  assert.deepEqual(answer, { d: { bb: 0 }, r: 1, q: 2 }, 'the spoke answered the ceiling-carrying drain digest with an r=1 of its own, capped (an r=0 at the real tails before)')
  assert.equal(S.node.resync, null)
  //! oo's reply (q=3 ≥ the first capped ask's q=2) used the ceiling up: a heartbeat r=1 is answered with the real tails
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { bb: 6 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(S, 3).at(-1), { d: { bb: 6 }, r: 0 }, 'the ceiling is gone: the real tails again')
  assert.deepEqual(S.jk(JK.resync), [], 'never a resync')
})
test('wave 6c — the same clear with no failover: the spoke\'s capped r=1 reaches the feeder, which re-sends the hole and replies; the reply drops the ceiling, every row once at the spoke, one exchange', () => {
  const { F, S, p, link, answer } = ceilingShape()
  assert.deepEqual(answer, { d: { bb: 0 }, r: 1, q: 2 })
  const m = F.of('send').filter((e) => e[1] === 7).length
  p.toA()
  assert.deepEqual(wireOf(F, 7, m), ['1+2', '3+4', '5+6', 'DIGEST'], 'the capped answer: the hole, the cut the spoke holds (its lane drops it), the reply')
  assert.equal(link.torn, null, 'the feeder\'s ceiling is used up')
  assert.equal(link.synced, true)
  p.settle()
  assert.deepEqual(cells(S).sort(), ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'])
  assert.deepEqual(S.jk(JK.dupDrop).map((e) => e.b), [5, 6], 'the surviving cut came twice; the lane dropped the copy')
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 6 }, r: 1, w: 1 }) })
  assert.deepEqual(digests(S, 2).at(-1), { d: { bb: 6 }, r: 0 }, 'the reply dropped the ceiling: the real tails again')
  assert.equal(digests(S, 2).filter((d) => d.r === 1).length, 2, 'two asks in all: the connect and the drain exchange')
})

//! the fold group (STATUS "a spoke can show a removed row for a few events when its feeder acquires that partition"):
// the forward of a latch fold ships a partition's history in lane order, one frame per contiguous run, so an older
// value of a row and its later remove on one lane arrived in separate events — the spoke showed the row between them
// (A12 seed 4: p27 at two older stamps in two events). Now the feeder brackets the fold's forward with FEED {b: p} and
// FEED {e: p} on every synced client link, and the spoke buffers the RECORDS frames between them (a copy of each) and
// lands them as ONE apply at the end: no event shows the removed row. A lost end is closed by the next frame that
// proves the feeder's step ended (its digest, a PING or PONG); a failover drops the buffer (the resync covers it). Red
// on the tree before at "px.c never shows between the fold's frames": it showed after the first frame.
//! oneByOne — feed B every frame A sent on `al` since `from`, one step each, running `check` after each step
const oneByOne = (A: H, al: number, B: H, bl: number, from: number, check: (i: number) => void) => {
  const s = A.of('send').filter((e) => e[1] === al).slice(from).map((e) => e[2] as Uint8Array)
  s.forEach((b, i) => { B.node.step({ kind: 'bytesIn', link: bl, bytes: b }); check(i) })
  return s.length
}
test('wave 6c — the fold group: a write and its later remove forwarded in separate frames land as ONE apply at the spoke — the removed row never shows; the frames are bracketed by FEED {b} and FEED {e}; a lost end is closed by the feeder\'s next digest; a failover drops an open group', () => {
  const { F, S, p, link, connect, cells, laneAt, teach } = latching()
  //! px held at aa with bb#3 (px.a = 1); qx on the same lane at bb#8, tapped live: the spoke's bb fence sits at 8
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  connect()
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  p.settle()
  assert.deepEqual(laneAt(S, 'bb'), [3, 8])
  //! cc announces px with bb at 9: aa re-latches px; the teacher ships bb#7 (px.c = 3) and bb#9 (REMOVE px.c) — a gap at 8
  // (qx's record, not px's), so the forward leaves in two frames
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  const m = F.of('send').filter((e) => e[1] === 7).length
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 3 }, { seq: 9, rec: { type: REC.remove, key: ['px', 'c'] }, pp: 7 }], 9)
  assert.equal(F.node.scope!.held('px'), true)
  const pxc = JSON.stringify(['px', 'c'])
  const n = oneByOne(F, 7, S, 2, m, (i) => {
    assert.equal(S.node.state.has(pxc), false, `px.c never shows between the fold's frames (after frame ${i})`)
    if (i < 3) assert.notEqual(S.node.group, null, `the group is open (after frame ${i})`)
  })
  assert.equal(n, 4)
  assert.deepEqual(wireOf(F, 7, m), ['verb28', '7', '9', 'verb28'], 'FEED {b}, the two frames of the forward, FEED {e}')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ b: 'px' }, { e: 'px' }])
  assert.equal(S.node.group, null, 'the end landed the group')
  assert.deepEqual(laneAt(S, 'bb'), [3, 7, 8, 9], 'both records are in the spoke\'s lane')
  assert.deepEqual(cells(S), cells(F), 'the spoke mirrors its feeder')
  assert.deepEqual(S.of('apply').filter((e) => JSON.stringify((e[1] as Rec).key) === pxc).map((e) => (e[1] as Rec).type), [REC.update, REC.remove], 'the write and the remove reached the screen in one step, in order')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 2, 0]], 'the journal: two frames landed as one for px, nothing kept back')
  //! a lost end: the feeder's next frame that proves its step ended (a heartbeat digest) lands the group
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 11 } } }) })
  const m2 = F.of('send').filter((e) => e[1] === 7).length
  teach(2, [{ seq: 11, rec: PX('d', 4), pp: 9 }], 11)
  const sent = F.of('send').filter((e) => e[1] === 7).slice(m2).map((e) => e[2] as Uint8Array)
  assert.equal(sent.length, 3)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: sent[0] }) // {b}
  S.node.step({ kind: 'bytesIn', link: 2, bytes: sent[1] }) // bb#11, buffered
  assert.notEqual(S.node.group, null)
  assert.equal(S.node.state.has(JSON.stringify(['px', 'd'])), false, 'buffered: the end has not come')
  S.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.DIGEST, { d: { bb: 11 }, r: 1, w: 1 }) }) // the end was lost; the heartbeat digest follows
  assert.equal(S.node.group, null, 'the digest closed the group')
  assert.equal(S.node.state.get(JSON.stringify(['px', 'd'])), 4, 'and its frame landed')
  //! a failover drops an open group: the resync onto the next feeder covers it
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 13 } } }) })
  const m3 = F.of('send').filter((e) => e[1] === 7).length
  teach(2, [{ seq: 13, rec: PX('e', 5), pp: 11 }], 13)
  const sent3 = F.of('send').filter((e) => e[1] === 7).slice(m3).map((e) => e[2] as Uint8Array)
  S.node.step({ kind: 'bytesIn', link: 2, bytes: sent3[0] })
  S.node.step({ kind: 'bytesIn', link: 2, bytes: sent3[1] })
  assert.notEqual(S.node.group, null)
  S.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(S.node.group, null, 'the failover dropped the open group')
  assert.equal(S.node.state.has(JSON.stringify(['px', 'e'])), false, 'its frame never landed here: the resync onto the next feeder brings px whole')
  assert.equal(link.dead, false)
})

//! the rule's clause 2 (the review's PROBE1): every way out of in flight sends a word. A from-zero latch the resync reply
// named in flight is aborted CLEAN by an install that moves px off aa — nothing of px in any lane, so the entry goes:
// no orphan, no shed, no fold, and on the first build no word either, so the two kept cells stayed on the spoke's
// screen for good (the base swept them at the resync end). Now the drop leg of scope.ts #abort says FEED {x: [px]}:
// px LEFT this feeder, and the spoke drops it, kept cells included. Red on the first build at "the spoke screen shows
// what its feeder holds": actual [px.a, px.b, qx.z], expected [qx.z].
test('wave 6c — a clean latch abort says FEED {x}: a from-zero latch the reply named in flight, aborted by an install that moves the partition off the feeder (no residue, so no orphan, shed or fold follows) — the feeder says the partition left, and its kept cells leave the spoke\'s screen', () => {
  const L = latching()
  const { F, S, p, beat } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3]])
  //! aa holds qx alone; px is assigned to it, and cc's announcement opens the from-zero latch
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  assert.equal(F.node.scope!.entries.get('px')?.state, SCOPE.acquiring, 'the from-zero latch')
  assert.deepEqual(F.node.scope!.inFlight(F.node), ['px'])
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  assert.equal(S.node.resync, null, 'the resync ended')
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 2]], 'the end kept px.a and px.b: the reply named px in flight')
  assert.deepEqual(screenCells(S), ['px.a', 'px.b', 'qx.z'], 'kept on the screen; the kernel holds qx.z alone')
  assert.deepEqual(kernelCells(S), ['qx.z'])
  //! a join moves px off aa: the install's rescope aborts the latch clean — no entry of px in any lane, the entry goes
  F.node.writes.ring.place('px', 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  assert.equal(F.node.scope!.entries.has('px'), false, 'aa has nothing of px: no orphan, no shed and no fold will come')
  assert.deepEqual(F.jk(JK.acquireAbort).map((e) => [e.a, e.b]), [['px', 'epoch']])
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the abort said px left (the shed\'s word)')
  p.settle()
  beat(10)
  assert.deepEqual(screenCells(S), kernelCells(F), 'the spoke screen shows what its feeder holds')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 0]], 'the word dropped the two kept cells; the kernel had no lane entry of px to drop')
  assert.deepEqual(cells(S), cells(F))
})

//! the rule's clause 3 (the review's PROBE4): nothing a clear can take is the only thing that ends a kept cell. The
// vanish-and-return shape with a queue of one; the link pauses before the fold, so the clear takes FEED {b} and the
// forward's first frame (bb#7), the second (bb#9) survives, and no {e} goes out (the link is unsynced). On the first
// build nothing judged the three kept cells: px.z (a record aa never gets) stayed on the screen for good. Now the fold's
// end is OWED on the unsynced link and said right after the drain exchange's answer (the ceiling re-ships bb#7) and
// reply: px.c and px.d are back, px.z is judged gone. Red on the first build at "the screen mirrors the feeder".
test('wave 6c — the fold\'s end is owed when a clear takes it: a fold whose FEED {b}, first frame and end a clear took (a queue of one, the link paused before the fold) — the drain exchange re-ships the frame, the feeder says the end after its reply, and the kept cells are judged then: two back, the third gone', () => {
  const L = latching({ tune: { queued: 1 } })
  const { F, S, p, link, beat, teach } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7], ['z', 5, 11, 9]])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  const a0 = S.of('apply').length
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  assert.equal(S.node.resync, null)
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 3]], 'the end kept px.c, px.d and px.z')
  //! the socket is full before the fold: {b} and bb#7 overflow the queue of one, bb#9 survives it, no end goes out
  F.node.step({ kind: 'pause', link: 7 })
  const m = F.of('send').filter((e) => e[1] === 7).length
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear')
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'nothing reached the socket: {b} and bb#7 went with the clear, and no {e} goes out on an unsynced link')
  assert.equal(link.synced, false)
  assert.deepEqual(link.torn, { d: { bb: 6 }, r: undefined, q: undefined, c: true }, 'the ceiling sits under bb#7, the record the clear took')
  //! the lane moves on at aa (qx at bb#13): nothing reaches the unsynced link
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('w', 7), 13, 8, VERB.RECORDS) })
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  beat(10)
  assert.deepEqual(wireOf(F, 7, m).slice(0, 6), ['9', 'DIGEST', '7+8+9', '13', 'DIGEST', 'verb28'], 'the drain: the surviving frame, the drain digest; the answer to the capped reply: bb#7 again (with 8 and 9, which the spoke drops), bb#13, the reply — then the owed end (the heartbeats follow)')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ e: 'px' }], 'the owed end, said after the answer')
  const removes = S.of('apply').slice(a0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => JSON.stringify(r.key))
  assert.deepEqual(removes, [JSON.stringify(['px', 'z'])], 'px.z judged gone at the owed end; px.c and px.d came back')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 0, 1]], 'the end with no group open: one ghost judged')
  assert.deepEqual(screenCells(S), kernelCells(F), 'the screen mirrors the feeder')
  assert.deepEqual(cells(S), cells(F))
  assert.equal(link.synced, true)
})

//! the other way an end is lost: the fold ran on a SYNCED paused link and queued whole ({b}, two frames, {e}: a queue of
// four holds them), and a later tap overflowed the queue — the clear took the end from the queue. #clearCover reads the
// dropped frames and owes it; the drain exchange re-ships the frames and the end is said after its reply.
test('wave 6c — a fold queued whole on a paused link, cleared by a later tap: the end a clear took from the queue is owed and said after the drain exchange; the kept cells are judged then', () => {
  const L = latching({ tune: { queued: 4 } })
  const { F, S, p, link, beat, teach } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7], ['z', 5, 11, 9]])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  const a0 = S.of('apply').length
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 3]], 'the end kept px.c, px.d and px.z')
  F.node.step({ kind: 'pause', link: 7 })
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.jk(JK.dropOldest).length, 0, 'the whole group waits in the queue')
  assert.deepEqual(link.queued.map((b) => new Framer().push(b.slice())[0].verb), [VERB.FEED, VERB.RECORDS, VERB.RECORDS, VERB.FEED], '{b}, bb#7, bb#9, {e}')
  assert.equal(link.synced, true)
  //! a later tap overflows the queue: the clear takes the group, end included
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('w', 7), 13, 8, VERB.RECORDS) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'the clear')
  assert.deepEqual(link.torn, { d: { bb: 6 }, r: undefined, q: undefined, c: true }, 'the ceiling sits under bb#7')
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  beat(10)
  assert.deepEqual(wireOf(F, 7, m).slice(0, 5), ['DIGEST', '7+8+9', '13', 'DIGEST', 'verb28'], 'the drain digest; the capped answer, the reply; the owed end')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ e: 'px' }])
  const removes = S.of('apply').slice(a0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => JSON.stringify(r.key))
  assert.deepEqual(removes, [JSON.stringify(['px', 'z'])], 'px.z judged gone at the owed end; px.c and px.d came back')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 0, 1]])
  assert.deepEqual(screenCells(S), kernelCells(F))
})

//! an owed end is said only while the partition is HELD: a latch open for it again says its own end. The owed-end shape
// (a queue of one; the clear takes {b} and bb#7, the end is owed), then cc announces bb at 13 and aa re-latches px (a
// repair from the held base) BEFORE the drain exchange heals the link. The heal's answer brings px.c and px.d (fed: a
// repair feeds its base); no stray end follows it (with the loose `held()` filter one did: JK.fed [px, 0, 0]); the second
// fold's end (bb#13) is the one that judges, and it finds every kept cell back.
test('wave 6c — an owed end is not said while the partition is being acquired again: the second latch\'s own end judges the kept cells', () => {
  const L = latching({ tune: { queued: 1 } })
  const { F, S, p, link, beat, teach } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7]])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  const a0 = S.of('apply').length
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 2]], 'the end kept px.c and px.d')
  F.node.step({ kind: 'pause', link: 7 })
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.jk(JK.dropOldest).length, 1, 'the clear took {b} and bb#7; the end is owed')
  assert.equal(link.synced, false)
  //! cc announces bb at 13 for px: aa is behind on its held base and re-latches (a repair) before the link heals
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 13 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'px is being acquired again')
  assert.equal(F.node.scope!.entries.get('px')!.preState, SCOPE.held, 'a repair from the held base')
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(wireOf(F, 7, m).slice(0, 4), ['9', 'DIGEST', '7+8+9', 'DIGEST'], 'the heal: the surviving frame, the drain digest, the capped answer, the reply — and no end after it')
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'no stray end: a latch is open for px again, and its own end will judge')
  assert.deepEqual(S.jk(JK.fed), [], 'nothing judged yet')
  assert.equal(link.synced, true)
  //! the second fold: bb#13 (px.e) forwarded in a group on the synced link; its end judges the kept cells: all back
  teach(2, [{ seq: 13, rec: PX('e', 5), pp: 9 }], 13)
  p.settle()
  beat(5)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ b: 'px' }, { e: 'px' }], 'the second fold\'s own markers, nothing else')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 1, 0]], 'one end, one frame, no ghost: px.c and px.d were back since the heal')
  const removes = S.of('apply').slice(a0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => JSON.stringify(r.key))
  assert.deepEqual(removes, [], 'nothing ever left the screen')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(kernelCells(S), ['px.a', 'px.b', 'px.c', 'px.d', 'px.e', 'qx.z'])
})

//! the same clause for the shed's word (the review's PROBE3): a FEED {x} queued on a paused client link that a clear
// takes was never said again on the first build, and the spoke kept the shed partition in its kernel and on its screen
// for good. Now #clearCover owes it and the feeder says it after the drain exchange's answer and reply.
test('wave 6c — the shed\'s word is owed when a clear takes it: FEED {x} queued on a paused link, cleared by live taps, said again at the drain exchange, before its answer — the spoke drops the partition', () => {
  const L = latching({ tune: { queued: 2 } })
  const { F, S, p, link, connect, beat } = L
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  connect()
  assert.deepEqual(kernelCells(S), kernelCells(F))
  F.node.step({ kind: 'pause', link: 7 })
  F.node.writes.ring.place('px', 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px'], 'aa shed px')
  assert.deepEqual(link.queued.map((b) => new Framer().push(b.slice())[0].verb), [VERB.FEED], 'the word waits in the paused queue')
  //! live qx records tapped onto the paused link overflow it: the clear takes the word
  for (let s = 7; s < 12 && F.jk(JK.dropOldest).length === 0; s++) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y' + s, s), s, s - 1, VERB.RECORDS) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear')
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'the word went with the clear: nothing reached the socket')
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  beat(10)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'said again at the drain exchange')
  //! the word at its own place in the order (clause 3): BEFORE the answer's ship, where it stood when the clear took it,
  // so the answer that follows re-sends whatever of px the feeder feeds now (nothing: px is gone). The first three
  // rounds said it after the reply, and a word for a partition the answer had just re-sent dropped it for good (SK1).
  assert.deepEqual(wireOf(F, 7, m).slice(0, 4), ['DIGEST', 'verb28', '7+8', 'DIGEST'], 'the drain digest, the owed word, the capped answer (the two taps the clear took), the reply')
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke dropped px with its feeder (it kept px.a and px.b for good on the first build)')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
})

//! the second review's SK1 (a regression of the rework): the owed words left AFTER the heal's answer, out of their
// original order. A shed's {x} the clear took was said after px had come BACK to aa (placed back, latched from zero and
// folded on the unsynced link) and after the answer had re-sent px's rows: the spoke dropped a partition its feeder
// holds, and its tails equalled the feeder's, so no exchange ever re-sent them. Three rounds then held the word back
// by a "stale" test, wrong each time ('no entry': R3-2, R3-6; 'feeds and byPart': R4-1, R4-2; '!held': R4-3), and a
// held-back word leaves a removed row for good once a fold carries no remove (R4-4, stage 4's release). Now the word
// is said AT ITS OWN PLACE: before the answer's ship, unfiltered (clause 3, the order rule); the owed end stays after
// the reply. The cost, pinned here: px.a and px.b leave with the word and come back with the same answer, one
// vanish-and-return inside the heal exchange. Red on the rework at the FEED line ([{e: px}, {x: [px]}], px gone from
// the spoke for good); red on the third round's filter at the same line ([{e: px}]: the word withheld, JK.unfed []).
//! shedPx — px (or the partition named) moves off aa (a join placed it on bb and cc) and both holders attest it to
// bb#t: aa sheds it, FEED {x}
const shedPx = (F: H, t: number, part = 'px') => {
  F.node.writes.ring.place(part, 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: { bb: t } } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: { bb: t } } }) })
}
//! owedShed — the shape the four tests below share: aa feeds px (bb#3, bb#5) and qx (bb#6) to a synced spoke; the link
// pauses, px is shed (its {x} queued), and live taps of qx overflow the queue of two: the clear takes the word, it is
// owed. `from` is the first qx seq after the shed (the lane leaves room at bb#7 for px.b's remove when the test wants it)
const owedShed = (from: number) => {
  const L = latching({ tune: { queued: 2 } })
  const { F, S, connect } = L
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  connect()
  assert.deepEqual(kernelCells(S), kernelCells(F))
  F.node.step({ kind: 'pause', link: 7 })
  shedPx(F, 5)
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px'], 'aa shed px')
  for (let s = from; s < from + 5 && F.jk(JK.dropOldest).length === 0; s++) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y' + s, s), s, s === from ? 6 : s - 1, VERB.RECORDS) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear took the word: it is owed')
  return L
}
const RMX = (k: string): Rec => ({ type: REC.remove, key: ['px', k] } as Rec)
test('wave 6c — an owed shed word is said at its own place, BEFORE the heal answer\'s ship, even once the partition is back and HELD at the feeder (folded on the unsynced link before the heal): its rows leave with the word and come back with the same answer; the owed end follows the reply', () => {
  const L = owedShed(7)
  const { F, S, p, beat, teach } = L
  //! px comes back to aa before the link heals: cc's announcement opens a from-zero latch, and the fold runs on the
  // unsynced link (the cover is lowered under px's rows; the end is owed)
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'the from-zero latch')
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }], 5)
  assert.equal(F.node.scope!.held('px'), true, 'aa holds px again; its end is owed too (the link is unsynced)')
  const m = F.of('send').filter((e) => e[1] === 7).length
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(10)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'the word at its place before the ship, the owed end after the reply')
  assert.deepEqual(wireOf(F, 7, m).slice(0, 2), ['DIGEST', 'verb28'], 'the drain digest, then the word ahead of the first record')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]], 'the cost: px.a and px.b left the spoke with the word')
  assert.deepEqual(kernelCells(F), ['px.a', 'px.b', 'qx.y7', 'qx.y8', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'and came back with the same answer: the spoke holds what its feeder holds')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 0, 0]], 'the end judged nothing (nothing was kept)')
})

//! the third review's R3-6 and R3-2, and the fourth's R4-1 to R4-4: the states px can be in at the heal. The second
// fix round said the owed {x} only while px had NO ENTRY at aa, the third only while aa fed px AND a lane held a row of
// it; each held the word back in a state where the answer shipped nothing of px's base (a latch from zero; an orphan;
// the owner's own commit in a from-zero latch; one minted record), so the spoke kept its rows from before the shed —
// px.b among them, which the cluster removed while px lived on bb and cc — until the fold or the repair; and a
// held-back word leaves such a row for good once the fold carries no remove (R4-4). Now the word is said at its own
// place, before the answer's ship, in every state: the spoke drops px at the heal, the answer re-sends what aa feeds of
// px now, and what follows brings the rest (the fold's group, a re-entry's whole forward) or says the word again (the
// shed, a no-op). Each shape asserts the spoke equal to what its feeder feeds, on kernel and screen, at the exchange's
// end (right after the heal's settle, before any beat: a row that comes back a heartbeat late fails there) and at the
// end. Red on the second round at "mid-latch the spoke shows nothing of px" (it showed px.a and px.b) and at
// "between the heal and the shed"; R4-1 and R4-2 red on the third round's filter at "between the heal and the fold"
// and "... the repair"; R4-4 red there at "the spoke holds what its feeder holds" (px.b for good).
test('wave 6c — an owed shed word IS said while the partition is a latch from zero at the heal: the answer shipped nothing of it, the spoke drops its rows from before the shed (a removed one among them), and the fold brings it whole', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! px comes back to aa before the heal: the from-zero latch opens on cc's announcement (bb#7: px.b's remove, made while
  // px lived elsewhere), and the teacher has not shipped yet
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'the from-zero latch')
  assert.equal(F.node.scope!.feeds('px'), true, 'fed: a latch from nothing')
  assert.equal(F.node.byPart!.has('px'), false, 'but no row of px here yet')
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(screenCells(S), ['qx.y8', 'qx.y9', 'qx.z'], 'mid-latch the spoke shows nothing of px (it showed px.a and px.b, px.b removed at the cluster, on the second round)')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the owed word, said after the heal: the answer shipped nothing of px')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]], 'the spoke dropped its two rows of px from before the shed')
  assert.deepEqual(kernelCells(S), kernelCells(F))
  //! the fold: the group brings px whole — px.a, and px.b with its remove in one apply
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }, { seq: 7, rec: RMX('b'), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  beat(5)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'then the fold\'s own group')
  assert.deepEqual(kernelCells(F), ['px.a', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds')
  assert.deepEqual(screenCells(S), kernelCells(F))
})

test('wave 6c — an owed shed word IS said while the partition is an orphan the ring no longer assigns at the heal: a frozen copy is no spoke\'s, the spoke drops its rows from before the shed, and the orphan\'s own shed says the word again to no effect', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! px comes back from zero and folds on the unsynced link (bb#7 is px.b's remove), then moves off aa again: an orphan
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }, { seq: 7, rec: RMX('b'), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  assert.deepEqual(kernelCells(F), ['px.a', 'qx.y8', 'qx.y9', 'qx.z'], 'the feeder: px.b is removed')
  F.node.writes.ring.place('px', 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan, 'frozen, not assigned')
  assert.equal(F.node.scope!.feeds('px'), false)
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(screenCells(S), ['qx.y8', 'qx.y9', 'qx.z'], 'between the heal and the shed the spoke shows nothing of px (it showed px.a and px.b, px.b removed at the cluster, on the second round)')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the owed word alone: the owed end is not said (px is not held), the {x} is (the answer shipped nothing of a frozen copy)')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
  assert.deepEqual(kernelCells(S), ['qx.y8', 'qx.y9', 'qx.z'])
  //! the orphan sheds (both holders attest bb#7): its own word, the second time, drops nothing
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px', 'px'], 'shed twice')
  p.settle()
  beat(3)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { x: ['px'] }], 'the shed says the word again')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2], ['px', 0]], 'the second word drops nothing')
  assert.deepEqual(kernelCells(F), ['qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F))
  assert.deepEqual(screenCells(S), kernelCells(F))
})

test('wave 6c — an owed shed word IS said while the partition is an orphan the ring still assigns at the heal (a repair whose teacher died): the spoke drops its rows from before the shed, and the re-entry fold forwards the partition whole', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! px comes back from zero and folds on the unsynced link; then a repair (cc announces bb#11) whose teacher dies: the
  // latch aborts with residue, px is an orphan the ring still assigns to aa — in flight (a re-entry in waiting)
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5 } } }) })
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }], 5)
  assert.equal(F.node.scope!.held('px'), true)
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 11 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.preState, SCOPE.held, 'a repair of the held base')
  F.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.orphan, 'the teacher died: an orphan with residue')
  assert.deepEqual(F.node.scope!.inFlight(F.node), ['px'], 'still assigned: in flight')
  assert.equal(F.node.scope!.feeds('px'), false)
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(screenCells(S), ['qx.y8', 'qx.y9', 'qx.z'], 'nothing of px at the spoke while aa holds it frozen (px.a and px.b from before the shed on the second round)')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the owed word: the answer shipped nothing of px')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
  //! cc comes back and announces px: the re-entry latch (preState orphan), and its fold forwards px WHOLE in a group
  F.admit(5, 'cc'); F.digestFrom(5)
  F.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 11 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.preState, SCOPE.orphan, 'the re-entry latch')
  teach(5, [{ seq: 11, rec: PX('c', 3), pp: 5 }], 11)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  beat(3)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'the re-entry\'s group')
  assert.deepEqual(kernelCells(F), ['px.a', 'px.b', 'px.c', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'px whole at the spoke: the base the answer withheld and the delta')
  assert.deepEqual(screenCells(S), kernelCells(F))
})

test('wave 6c — an owed shed word said at its place while the partition is a from-zero latch at its OWNER with one own mid-latch commit (an entry with a row but no base): the answer ships that commit alone, the spoke shows it alone, and the fold brings the base', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! px comes back to aa as its owner (a from-zero latch on bb's announcement; bb#7 is px.b's remove), and aa commits
  // one own-lane write of px mid-latch (lawful: write.ts "Acquiring commits stay lawful"): a lane holds a row of px,
  // but the base is not here yet. The third round's filter (feeds && byPart) read that row as "the answer shipped
  // px's base" and held the word back: the spoke showed px.a and px.b, px.b removed at the cluster, next to px.c.
  F.node.writes.ring.place('px', 'aa', 'bb')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'the from-zero latch')
  F.node.step({ kind: 'write', recs: [{ type: REC.update, key: ['px', 'c'], value: 3 }] })
  assert.equal(F.node.byPart!.has('px'), true, 'a lane holds the own commit')
  assert.deepEqual(kernelCells(F), ['px.c', 'qx.y8', 'qx.y9', 'qx.z'])
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(screenCells(S), ['px.c', 'qx.y8', 'qx.y9', 'qx.z'], 'between the heal and the fold the spoke never shows a row its feeder does not hold (px.b, removed at the cluster)')
  assert.deepEqual(kernelCells(S), kernelCells(F), 'after three beats: the spoke holds what its feeder holds')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the word at its place')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
  teach(1, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }, { seq: 7, rec: RMX('b'), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  beat(3)
  assert.deepEqual(kernelCells(F), ['px.a', 'px.c', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'then the fold\'s own group')
})

test('wave 6c — an owed shed word said at its place while the partition is HELD again by one minted first record (no latch, no base): the answer ships that row alone, the spoke shows it alone, and the repair latch\'s fold brings the base', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! bb's next live record of px reaches aa first (bb#13, chained on bb#7): a first-ever record to its lawful holder
  // mints held (scope.ts), one row and no base. The third round's filter read that row as the base and held the word
  // back: the spoke showed px.a and px.b, px.b removed at the cluster, next to px.d.
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('d', 4), 13, 7, VERB.RECORDS) })
  assert.equal(F.node.scope!.held('px'), true, 'held from one record')
  assert.deepEqual(kernelCells(F), ['px.d', 'qx.y8', 'qx.y9', 'qx.z'])
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(screenCells(S), ['px.d', 'qx.y8', 'qx.y9', 'qx.z'], 'between the heal and the repair the spoke never shows a row its feeder does not hold (px.b, removed at the cluster)')
  assert.deepEqual(kernelCells(S), kernelCells(F), 'after three beats: the spoke holds what its feeder holds')
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the word at its place')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
  //! the round finds aa behind on px: a repair latch on the held base, the teacher ships the chain
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 13 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.preState, SCOPE.held, 'a repair of the held base')
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }, { seq: 7, rec: RMX('b'), pp: 5 }, { seq: 13, rec: PX('d', 4), pp: 7 }], 13)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  beat(3)
  assert.deepEqual(kernelCells(F), ['px.a', 'px.d', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'then the repair\'s group')
})

test('wave 6c — an owed shed word said at its place while a REPAIR latch is open on a held base at the heal: the answer re-sends the base behind the word, the repair\'s fold brings the delta, nothing is lost (said after the reply, the word dropped the base for good)', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! px back from zero and folded on the unsynced link (the cover under its rows); then cc announces bb#11: a repair
  // latch on the held base, open at the heal. The old order (the word after the reply) dropped the base the answer had
  // just re-sent, and the repair's delta-only forward never brought it back; a `!held` filter does the same.
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }, { seq: 5, rec: PX('b', 2), pp: 3 }, { seq: 7, rec: RMX('b'), pp: 5 }], 7)
  assert.equal(F.node.scope!.held('px'), true, 'px held again (its end is owed: the link is unsynced)')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 11 } } }) })
  const st = F.node.scope!.entries.get('px')!
  assert.equal(st.state, SCOPE.acquiring); assert.equal(st.preState, SCOPE.held, 'a repair of the held base')
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(3)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the word at its place (no owed end: px is acquiring, and that fold says its own)')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]], 'px.a and px.b left with the word')
  assert.deepEqual(kernelCells(F), ['px.a', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'after three beats: the base came back behind the word')
  assert.deepEqual(screenCells(S), kernelCells(F))
  teach(2, [{ seq: 11, rec: PX('c', 3), pp: 7 }], 11)
  assert.equal(F.node.scope!.held('px'), true, 'the repair folded')
  p.settle()
  beat(5)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'the repair\'s own group; no stray end')
  assert.deepEqual(kernelCells(F), ['px.a', 'px.c', 'qx.y8', 'qx.y9', 'qx.z'])
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds')
  assert.deepEqual(screenCells(S), kernelCells(F))
})

test('wave 6c — the stage-4 shape: an owed shed word said at its place while the partition is held again and the fold carried NO remove of a row the spoke kept (the holders released its tombstone while the partition was off this feeder): the word drops it, the answer re-sends what the feeder holds, nothing stays for good', () => {
  const L = owedShed(8)
  const { F, S, p, beat, teach } = L
  //! the held shape, but the teacher's fold ships px.a alone at cut 7: no trace of px.b's insert or remove, as after a
  // tombstone release at bb and cc (stage 4's gcRow). A word held back here (every filter of the earlier rounds: px is
  // held, fed, and a lane holds its row) left px.b on the spoke for good, past every exchange, until a resync; the
  // release census sees holders, never spokes.
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 7 } } }) })
  teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }], 7)
  assert.equal(F.node.scope!.held('px'), true)
  assert.deepEqual(kernelCells(F), ['px.a', 'qx.y8', 'qx.y9', 'qx.z'], 'the feeder: px.a alone')
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
  assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
  beat(10)
  assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds (px.b stayed for good on every filter)')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'the word at its place, the owed end after the reply')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]])
})

//! the fifth review's R5-1 and R5-2, THE LEAPFROG. The fourth round's argument for the order rule said a record of px
// tapped behind the shed's word "was taken by the same clear". On a client link a flush ships ON after a clear
// (kernel/link.ts flush), so: px is shed on the paused SYNCED link (its {x} queued, nothing clears it), comes back from
// zero and folds across two lanes (bb#3, bb#5, cc#2); the fold's flush clears the queue on bb#3 (the word, {b} and bb#3
// go; the cover lowers bb to 2), and bb#5 and cc#2 survive in the fresh queue. At the drain they reach the spoke first
// (cc#2 splices in: px.c), its reply to the drain digest says cc: 2, or cc: 4 when qx.w at cc#4 holds the lane's tail;
// then the owed {x} drops px, px.c included, and an answer from the lower of the reply and the cover (both at lane cc's
// tail) never re-sent cc#2: px.c came back one heartbeat late when the unfeed had emptied lane cc at the spoke (R5-1),
// and was lost for good when qx.w kept the tail at 4 (R5-2). Now the answer's start is lowered under px's lowest entry
// on every lane (#payOwed), so the same answer brings px back whole. Red on 0a6572e at "the exchange's end: the spoke
// shows what its feeder holds" (R5-1: [px.a, px.b, qx.z] against [px.a, px.b, px.c, qx.z]; R5-2 the same with qx.w,
// and still at the end after twenty beats).
//! teachLanes — the teacher on `from` ships rows of px (or the partition named) from any lane, then ACQDONE with a cut
// per lane
const teachLanes = (F: H, from: number, rows: { origin: string; seq: number; rec: Rec; pp: number }[], cut: Record<string, number>, part = 'px') => {
  for (const r of rows) F.node.step({ kind: 'bytesIn', link: from, bytes: encodeRuns([{ rec: r.rec, origin: r.origin, seq: r.seq, epoch: 1, pp: r.pp }], VERB.ACQ, true)[0] })
  F.node.step({ kind: 'bytesIn', link: from, bytes: encodeControl(VERB.ACQDONE, { p: part, e: 1, t: cut, n: rows.length }) })
}
const frameName = (b: Uint8Array) => { const f = new Framer().push(b.slice())[0]; return f.verb === VERB.RECORDS ? f.records().map((rv) => rv.origin + '#' + rv.seq).join('+') : f.verb === VERB.FEED ? 'FEED' + JSON.stringify(f.value) : 'verb' + f.verb }
for (const later of [false, true])
  for (const queued of [2, 3])
    test(`wave 6c — the leapfrog (a queue of ${queued}${later ? '; a later row of another partition holds the surviving lane\'s tail at the spoke' : ''}): a frame of the shed partition queued behind its owed word survives the clear and reaches the spoke before the re-said word drops it; the answer's start is lowered under the partition's lowest entry on every lane, so the same answer brings it back whole${later ? ' (lost for good before)' : ' (a heartbeat late before)'}`, () => {
      const L = latching({ tune: { queued } })
      const { F, S, p, link, connect, beat, laneAt } = L
      F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
      F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
      F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
      if (later) F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
      connect()
      assert.deepEqual(kernelCells(S), kernelCells(F))
      F.node.step({ kind: 'pause', link: 7 })
      shedPx(F, 5)
      assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px'], 'aa shed px')
      //! a queue of three: one live tap first, so the fold's flush overflows on its first frame as with a queue of two
      if (queued === 3) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y7', 7), 7, 6, VERB.RECORDS) })
      assert.deepEqual(link.queued.map(frameName), queued === 3 ? ['FEED{"x":["px"]}', 'bb#7'] : ['FEED{"x":["px"]}'], 'the word waits in the paused queue, uncleared')
      //! px back to aa from zero (cc's announcement), the teacher ships it on two lanes
      F.node.writes.ring.place('px', 'bb', 'aa')
      F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5, cc: 2 } } }) })
      assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'the from-zero latch')
      teachLanes(F, 2, [{ origin: 'bb', seq: 3, rec: PX('a', 1), pp: 0 }, { origin: 'bb', seq: 5, rec: PX('b', 2), pp: 3 }, { origin: 'cc', seq: 2, rec: PX('c', 3), pp: 0 }], { bb: 5, cc: 2 })
      assert.equal(F.node.scope!.held('px'), true)
      assert.equal(F.jk(JK.dropOldest).length, 1, 'the fold\'s flush cleared the queue on its first frame: the word, {b} and bb#3 went')
      assert.deepEqual(link.queued.map(frameName), ['bb#5', 'cc#2'], 'and the frames behind it survived the clear (Link.flush ships on after a clear on a client link)')
      assert.deepEqual(link.torn?.d, { bb: 2, cc: later ? 4 : 2 }, 'the cover: bb lowered under the lost bb#3, cc at its tail, above the survivor')
      assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'the word went with the clear')
      const m = F.of('send').filter((e) => e[1] === 7).length
      F.node.step({ kind: 'drain', link: 7 })
      p.settle()
      //! the exchange's end: the drain delivered bb#5 and cc#2 (px.c spliced in at the spoke), the drain digest, the
      // spoke's capped reply, the word (px.a, px.b and px.c dropped), the answer with px whole, the reply, the owed end
      assert.deepEqual(screenCells(S), kernelCells(F), 'the exchange\'s end: the spoke shows what its feeder holds (px.c, the leapfrogged cc#2, was dropped by the word and never re-sent)')
      assert.deepEqual(kernelCells(S), kernelCells(F), 'the exchange\'s end: and holds it')
      assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'the word before the ship, the owed end after the reply')
      assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 3]], 'the word dropped px.a, px.b and the leapfrogged px.c')
      const wire = wireOf(F, 7, m)
      assert.deepEqual(wire.slice(0, 4), ['5', '2', 'DIGEST', 'verb28'], 'the drained survivors, the drain digest, the word ahead of the first record')
      assert.ok(wire.slice(4).includes('2'), 'the answer re-sends cc#2 under the spoke\'s tail on that lane (the lowered start)')
      assert.equal(wire[wire.length - 2], 'DIGEST', 'the reply, then the owed end')
      beat(20)
      assert.deepEqual(kernelCells(S), kernelCells(F), 'the spoke holds what its feeder holds')
      assert.deepEqual(screenCells(S), kernelCells(F))
      assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc at the spoke equals the feeder\'s (it kept [4] for good before)')
      assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'no later word, no later end')
    })

//! the sixth review's R6-7, R6-3 and R6-6: the lowering's two halves. The start goes under the LOWEST entry of a named
// partition on each lane, and under the entries of EVERY partition the word names. Lowered under the highest entry
// instead (`arr[arr.length - 1]`), the answer re-sent cc#3 and not cc#2: px.c was lost for good (the spoke's lane cc
// [3, 4] against the feeder's [2, 3, 4]). Lowered for the first named partition only, a second one taken back lost
// its leapfrogged row for good (rx.c; the spoke's lane cc [4] against [2, 4]). The leapfrog tests above and every
// other test in this file stayed green on both mutants: one entry of one named partition on the surviving lane. Red
// on them at "the exchange's end, before any beat: the spoke shows what its feeder feeds": [px.a, px.b, px.d, qx.w,
// qx.z] against the same with px.c (both queues), and [qx.w, qx.z, rx.a, rx.b] against the same with rx.c.
for (const queued of [2, 3])
  test(`wave 6c — the leapfrog with TWO entries of the shed partition on the surviving lane (cc#2 and cc#3, one frame; a queue of ${queued}): the answer's start goes under the partition's LOWEST entry on that lane, so both come back with the same answer (lowered under the highest, px.c was lost for good)`, () => {
    const L = latching({ tune: { queued } })
    const { F, S, p, link, connect, beat, laneAt } = L
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
    connect()
    assert.deepEqual(kernelCells(S), kernelCells(F))
    F.node.step({ kind: 'pause', link: 7 })
    shedPx(F, 5)
    if (queued === 3) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y7', 7), 7, 6, VERB.RECORDS) })
    //! px back to aa from zero; the teacher ships it on two lanes, two chained entries on cc (px.c at cc#2, px.d at cc#3)
    F.node.writes.ring.place('px', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5, cc: 3 } } }) })
    teachLanes(F, 2, [{ origin: 'bb', seq: 3, rec: PX('a', 1), pp: 0 }, { origin: 'bb', seq: 5, rec: PX('b', 2), pp: 3 }, { origin: 'cc', seq: 2, rec: PX('c', 3), pp: 0 }, { origin: 'cc', seq: 3, rec: PX('d', 4), pp: 2 }], { bb: 5, cc: 3 })
    assert.equal(F.node.scope!.held('px'), true)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'the fold\'s flush cleared the queue on its first frame: the word went')
    assert.deepEqual(link.queued.map(frameName), ['bb#5', 'cc#2+cc#3'], 'both entries of px on cc survived the clear, in one frame')
    const m = F.of('send').filter((e) => e[1] === 7).length
    F.node.step({ kind: 'drain', link: 7 })
    p.settle()
    assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds (px.c, the lower of the two leapfrogged entries on cc, was dropped by the word and never re-sent)')
    assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'the word before the ship, the owed end after the reply')
    assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 4]], 'the word dropped px.a, px.b and both leapfrogged entries')
    const wire = wireOf(F, 7, m)
    assert.deepEqual(wire.slice(0, 4), ['5', '2+3', 'DIGEST', 'verb28'], 'the drained survivors, the drain digest, the word ahead of the first record')
    assert.ok(wire.slice(4).some((w) => w.split('+').includes('2')), 'the answer re-sends cc#2, the lowest entry of px on cc')
    beat(20)
    assert.deepEqual(kernelCells(S), fedCells(F), 'after twenty beats: the spoke holds what its feeder feeds')
    assert.deepEqual(screenCells(S), fedCells(F))
    assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc at the spoke equals the feeder\'s (it kept [3, 4] for good on the mutant)')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { e: 'px' }], 'no later word, no later end')
  })

//! two partitions shed in one pause: px, then rx (two words in the paused queue of three); the clear takes both, so one
// owed word names both, in that order. `back` says which come back from zero across two lanes, in fold order: the
// first named (px), the SECOND named (rx: R6-3, the shape that catches the first-named-only lowering), or both (R6-6).
// A is the partition laid out on bb#3, bb#5 and cc#2; B holds bb#4 and, when it comes back too, cc#3.
const RX = (k: string, v: number): Rec => ({ type: REC.update, key: ['rx', k], value: v })
//! namesOn — what a node sent on a link from `from`: each record as origin#seq, each control frame as its verb's name
const namesOn = (h: H, link: number, from: number) => h.of('send').filter((e) => e[1] === link).slice(from).flatMap((e) => new Framer().push((e[2] as Uint8Array).slice()))
  .flatMap((f) => f.verb === VERB.RECORDS ? f.records().map((rv) => rv.origin + '#' + rv.seq) : [f.verb === VERB.DIGEST ? 'DIGEST' : f.verb === VERB.FEED ? 'FEED' : 'verb' + f.verb])
for (const back of [['px'], ['rx'], ['rx', 'px']])
  test(`wave 6c — two partitions shed in one pause (one owed word names px and rx), ${back.length === 2 ? 'both' : back[0] === 'rx' ? 'the SECOND named' : 'the first named'} taken back across two lanes and leapfrogged (a queue of three): the start is lowered under the entries of EVERY partition the word names, so ${back.length === 2 ? 'both come' : back[0] + ' comes'} back whole with the same answer${back.length === 1 ? ' and the other stays gone' : ''}${back[0] === 'rx' && back.length === 1 ? ' (lowered for the first named only, rx.c was lost for good)' : ''}`, () => {
    const L = latching({ tune: { queued: 3 } })
    const { F, S, p, link, connect, beat, laneAt } = L
    const A = back.length === 1 ? back[0] : 'px', B = A === 'px' ? 'rx' : 'px'
    const R = (part: string, k: string, v: number) => part === 'px' ? PX(k, v) : RX(k, v)
    F.node.writes.ring.place('rx', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', R(A, 'a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', R(B, 'o', 7), 4, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', R(A, 'b', 2), 5, 3, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
    connect()
    assert.deepEqual(kernelCells(S), kernelCells(F))
    F.node.step({ kind: 'pause', link: 7 })
    shedPx(F, 5, 'px')
    shedPx(F, 5, 'rx')
    assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px', 'rx'], 'aa shed px, then rx')
    assert.deepEqual(link.queued.map(frameName), ['FEED{"x":["px"]}', 'FEED{"x":["rx"]}'], 'two words wait in the paused queue, uncleared')
    const taught: Record<string, { rows: { origin: string; seq: number; rec: Rec; pp: number }[]; cut: Record<string, number> }> = {
      [A]: { rows: [{ origin: 'bb', seq: 3, rec: R(A, 'a', 1), pp: 0 }, { origin: 'bb', seq: 5, rec: R(A, 'b', 2), pp: 3 }, { origin: 'cc', seq: 2, rec: R(A, 'c', 3), pp: 0 }], cut: { bb: 5, cc: 2 } },
      [B]: { rows: [{ origin: 'bb', seq: 4, rec: R(B, 'o', 7), pp: 0 }, { origin: 'cc', seq: 3, rec: R(B, 'c', 8), pp: 0 }], cut: { bb: 4, cc: 3 } },
    }
    for (const part of back) {
      F.node.writes.ring.place(part, 'bb', 'aa')
      F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: taught[part].cut } }) })
      teachLanes(F, 2, taught[part].rows, taught[part].cut, part)
      assert.equal(F.node.scope!.held(part), true)
    }
    if (back.length === 1) assert.equal(F.node.scope!.entries.has(B), false, 'the other has no entry at aa')
    assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear: both words went')
    //! the survivors: A's bb#5 and cc#2 behind the clear on A's fold; with both back, rx's cc#3 behind the clear on rx's
    // fold (px then folds on the torn link, its cover lowered under px's rows, its end owed)
    const drained = link.queued.flatMap((b) => new Framer().push(b.slice())[0].records().map((rv) => rv.origin + '#' + rv.seq))
    assert.deepEqual(drained, back.length === 2 ? ['cc#3'] : ['bb#5', 'cc#2'], 'the frames that leapfrogged the clear')
    const m = F.of('send').filter((e) => e[1] === 7).length
    F.node.step({ kind: 'drain', link: 7 })
    p.settle()
    assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds')
    assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
    if (back.length === 1) assert.ok(!kernelCells(S).some((c) => c.startsWith(B + '.')), 'the other is gone at the spoke')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px', 'rx'] }, ...back.map((q) => ({ e: q }))], 'one word names both, before the ship; the owed ends after the reply, in fold order')
    //! the word dropped all the spoke held of each: A's two rows and its leapfrogged row, B's one row (both back: px's
    // two rows, rx's row and its leapfrogged row)
    assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), back.length === 2 ? [['px', 2], ['rx', 2]] : A === 'px' ? [['px', 3], ['rx', 1]] : [['px', 1], ['rx', 3]])
    const sent = namesOn(F, 7, m)
    assert.deepEqual(sent.slice(0, drained.length + 2), [...drained, 'DIGEST', 'FEED'], 'the drained survivors, the drain digest, the word ahead of the first record')
    assert.deepEqual(drained.filter((r) => !sent.slice(drained.length + 2).includes(r)), [], 'every frame that leapfrogged the clear is re-sent after the word')
    beat(20)
    assert.deepEqual(kernelCells(S), fedCells(F), 'after twenty beats: the spoke holds what its feeder feeds')
    assert.deepEqual(screenCells(S), fedCells(F))
    assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc at the spoke equals the feeder\'s')
  })

//! the seventh review's R7-1 and R7-2: two more slips of the one lowering line. Lowered only for a partition HELD at
// the word (the held-for-feeds slip wave 6a once made in #answer's head), a repair latch open on px at the heal skips
// it: px is fed but not held, the leapfrogged cc#2 is dropped by the word and never re-sent, and the repair's forward
// carries only its delta (px.c lost for good; the spoke's lane cc [4] against the feeder's [2, 4]). Stopped after the
// first named partition that has entries, the word [px, rx] lowers bb for px's one row and never reaches rx, whose
// leapfrogged row sits on cc, a lane px has no entry on (rx.c lost for good, the same lane cc). Every other test in
// this file stayed green on both mutants. Red on them at "the exchange's end, before any beat: the spoke shows what
// its feeder feeds": [px.a, px.b, qx.w, qx.z] against the same with px.c (at a queue of 3 both with qx.y7), and
// [px.o, qx.w, qx.z, rx.a, rx.b] against the same with rx.c (at a queue of 4 both with qx.y7).
for (const queued of [2, 3])
  test(`wave 6c — the leapfrog, then a REPAIR latch opens on the shed partition before the heal (a queue of ${queued}): px is fed but not held at the word, and the start is still lowered under its entries, so the same answer brings it back whole (lowered for held partitions only, px.c was lost for good: the repair's forward is delta-only)`, () => {
    const L = latching({ tune: { queued } })
    const { F, S, p, link, connect, beat, laneAt } = L
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
    connect()
    assert.deepEqual(kernelCells(S), kernelCells(F))
    F.node.step({ kind: 'pause', link: 7 })
    shedPx(F, 5)
    if (queued === 3) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y7', 7), 7, 6, VERB.RECORDS) })
    //! px back to aa from zero across bb and cc; the fold's flush clears the queue on bb#3, bb#5 and cc#2 leapfrog it
    F.node.writes.ring.place('px', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 5, cc: 2 } } }) })
    teachLanes(F, 2, [{ origin: 'bb', seq: 3, rec: PX('a', 1), pp: 0 }, { origin: 'bb', seq: 5, rec: PX('b', 2), pp: 3 }, { origin: 'cc', seq: 2, rec: PX('c', 3), pp: 0 }], { bb: 5, cc: 2 })
    assert.equal(F.node.scope!.held('px'), true)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'the fold\'s flush cleared the queue on its first frame: the word went')
    assert.deepEqual(link.queued.map(frameName), ['bb#5', 'cc#2'], 'the leapfrog: bb#5 and cc#2 survived the clear')
    //! cc announces px at bb#9: a repair latch on the held base, open at the heal
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9, cc: 2 } } }) })
    const st = F.node.scope!.entries.get('px')!
    assert.equal(st.state, SCOPE.acquiring); assert.equal(st.preState, SCOPE.held, 'a repair of the held base')
    assert.equal(F.node.scope!.held('px'), false, 'px is not held at the word')
    assert.equal(F.node.scope!.feeds('px'), true, 'but this feeder feeds it')
    const m = F.of('send').filter((e) => e[1] === 7).length
    F.node.step({ kind: 'drain', link: 7 })
    p.settle()
    assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds (px.c, the leapfrogged cc#2, was dropped by the word and never re-sent)')
    assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }], 'the word before the ship; no owed end (px is acquiring, and that fold says its own)')
    assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 3]], 'the word dropped px.a, px.b and the leapfrogged px.c')
    const sent = namesOn(F, 7, m)
    assert.deepEqual(sent.slice(0, 4), ['bb#5', 'cc#2', 'DIGEST', 'FEED'], 'the drained survivors, the drain digest, the word ahead of the first record')
    assert.ok(sent.slice(4).includes('cc#2'), 'the answer re-sends cc#2 under the spoke\'s tail on that lane (the lowered start)')
    //! three beats only: the repair latch times out at about the eighth (px is then an assigned orphan, in flight)
    beat(3)
    assert.deepEqual(kernelCells(S), fedCells(F), 'after three beats, the repair still open: the spoke holds what its feeder feeds')
    assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc at the spoke equals the feeder\'s (it kept [4] for good on the mutant)')
    //! the repair folds: the delta bb#9 alone
    teachLanes(F, 2, [{ origin: 'bb', seq: 9, rec: PX('e', 5), pp: 5 }], { bb: 9, cc: 2 })
    assert.equal(F.node.scope!.held('px'), true, 'the repair folded')
    p.settle()
    beat(20)
    assert.deepEqual(kernelCells(F), queued === 3 ? ['px.a', 'px.b', 'px.c', 'px.e', 'qx.w', 'qx.y7', 'qx.z'] : ['px.a', 'px.b', 'px.c', 'px.e', 'qx.w', 'qx.z'])
    assert.deepEqual(kernelCells(S), kernelCells(F), 'after the repair and twenty beats: the spoke holds what its feeder holds')
    assert.deepEqual(screenCells(S), kernelCells(F))
    assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc equal at the end')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px'] }, { b: 'px' }, { e: 'px' }], 'then the repair\'s own group; no stray word')
  })

for (const queued of [3, 4])
  test(`wave 6c — two partitions in one owed word, the SECOND named back first and leapfrogged on a lane the first has no entry on (a queue of ${queued}): the lowering goes on past the first named partition with entries, so rx comes back whole with the same answer (stopped after it, rx.c was lost for good)`, () => {
    const L = latching({ tune: { queued } })
    const { F, S, p, link, connect, beat, laneAt } = L
    F.node.writes.ring.place('rx', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', RX('a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('o', 7), 4, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', RX('b', 2), 5, 3, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
    connect()
    assert.deepEqual(kernelCells(S), kernelCells(F))
    F.node.step({ kind: 'pause', link: 7 })
    shedPx(F, 5, 'px')
    shedPx(F, 5, 'rx')
    assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px', 'rx'], 'aa shed px, then rx')
    if (queued === 4) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y7', 7), 7, 6, VERB.RECORDS) })
    //! rx back first, across bb and cc: its fold's flush clears the queue (both words go), its cc#2 leapfrogs the clear
    F.node.writes.ring.place('rx', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { rx: { bb: 5, cc: 2 } } }) })
    teachLanes(F, 2, [{ origin: 'bb', seq: 3, rec: RX('a', 1), pp: 0 }, { origin: 'bb', seq: 5, rec: RX('b', 2), pp: 3 }, { origin: 'cc', seq: 2, rec: RX('c', 3), pp: 0 }], { bb: 5, cc: 2 }, 'rx')
    assert.equal(F.node.scope!.held('rx'), true)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'rx\'s fold cleared the queue')
    const drained = link.queued.flatMap((b) => new Framer().push(b.slice())[0].records().map((rv) => rv.origin + '#' + rv.seq))
    assert.ok(drained.includes('cc#2'), 'rx\'s cc#2 leapfrogged the clear: ' + drained.join(','))
    //! px back second, on the torn link: one row, on bb only (px has no entry on cc)
    F.node.writes.ring.place('px', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 4 } } }) })
    teachLanes(F, 2, [{ origin: 'bb', seq: 4, rec: PX('o', 7), pp: 0 }], { bb: 4 }, 'px')
    assert.equal(F.node.scope!.held('px'), true)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'still one clear')
    const m = F.of('send').filter((e) => e[1] === 7).length
    F.node.step({ kind: 'drain', link: 7 })
    p.settle()
    assert.deepEqual(screenCells(S), fedCells(F), 'the exchange\'s end, before any beat: the spoke shows what its feeder feeds (rx.c, the leapfrogged cc#2, was dropped by the word and never re-sent)')
    assert.deepEqual(kernelCells(S), fedCells(F), 'the exchange\'s end, before any beat: and holds it')
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px', 'rx'] }, { e: 'rx' }, { e: 'px' }], 'one word names both, px first, before the ship; the owed ends after the reply, in fold order')
    const sent = namesOn(F, 7, m)
    assert.deepEqual(sent.slice(0, drained.length + 2), [...drained, 'DIGEST', 'FEED'], 'the drained survivors, the drain digest, the word ahead of the first record')
    assert.ok(sent.slice(drained.length + 2).includes('cc#2'), 'the answer re-sends rx\'s cc#2 on a lane px has no entry on')
    beat(20)
    assert.deepEqual(kernelCells(S), fedCells(F), 'after twenty beats: the spoke holds what its feeder feeds')
    assert.deepEqual(screenCells(S), fedCells(F))
    assert.deepEqual(laneAt(S, 'cc'), laneAt(F, 'cc'), 'lane cc at the spoke equals the feeder\'s (it kept [4] for good on the mutant)')
  })

//! the eighth review's R8-1, added at the merge: the lowering compares each lane with the start AS LOWERED SO FAR, not
// with the answer's own start `d`. The note once called the second form harmless, on the claim that every flush on a
// client link holds one lane or one partition, so one clear leaves at most one named partition at or under the start on
// a lane. A relayed write breaks that claim: the WACK hops of a spoke's own relayed attempts are shipped STRAIGHT to the
// spoke's link inside the tap (write.ts #ack), after the tap's add and before the RECORDS handler's per-frame flush. With
// the paused queue full, the third hop clears it; the clear takes no record of lane bb, so the cover stays at bb's tail,
// and the flush then ships the whole tap frame [bb#10 px, bb#11 qx, bb#12 rx] into the emptied queue. Two named
// partitions now sit at or under the start on ONE lane. Compared with `d`, bb is lowered under rx's entry, not under
// px's lower one, and the spoke loses its own settled write px.n for good: red on that mutant at "the exchange's end,
// before any beat" ([px.c, qx.w, qx.y, qx.z, rx.c, rx.k] against the same with px.n; lane bb [6, 11, 12] against
// [6, 10, 11, 12]). Every other test in this file stays green on it.
const shedPart = (F: H, part: string, t: Record<string, number>) => {
  F.node.writes.ring.place(part, 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: t } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: t } }) })
}
test('wave 6c — a relayed write\'s third WACK clears the paused queue in the middle of the tap: px and rx both survive on lane bb, and the start is lowered under px, the lower of the two (a queue of 10)', () => {
  const L = latching({ tune: { queued: 10 } })
  const { F, S, p, link, connect, beat, laneAt } = L
  F.node.writes.ring.place('rx', 'bb', 'aa')
  //! px and rx hold one row each, on cc only; qx holds bb#6 and cc#4
  F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', PX('c', 3), 2, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', RX('c', 8), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: one('cc', QX('w', 4), 4, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  assert.equal(F.node.scope!.held('px') && F.node.scope!.held('rx'), true)
  connect()
  assert.deepEqual(kernelCells(S), kernelCells(F))
  F.node.step({ kind: 'pause', link: 7 })
  shedPart(F, 'px', { cc: 2 })
  shedPart(F, 'rx', { cc: 3 })
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px', 'rx'], 'aa shed px, then rx')
  //! both back from zero, each through a fold that teaches its cc row (synced and paused: {b}, the row, {e} queue up)
  for (const [part, rec, seq] of [['px', PX('c', 3), 2], ['rx', RX('c', 8), 3]] as [string, Rec, number][]) {
    F.node.writes.ring.place(part, 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [part]: { cc: seq } } }) })
    teachLanes(F, 2, [{ origin: 'cc', seq, rec, pp: 0 }], { cc: seq }, part)
    assert.equal(F.node.scope!.held(part), true)
  }
  assert.equal(F.jk(JK.dropOldest).length, 0, 'no clear yet')
  const before = link.queued.map(frameName)
  //! the spoke writes px.n, qx.y and rx.k in ONE write: aa relays three attempts to bb (keyed per record)
  S.node.step({ kind: 'write', recs: [PX('n', 10), QX('y', 11), RX('k', 12)] })
  p.toA()
  const keys = [...F.node.writes.pending.keys()]
  assert.equal(keys.length, 3, 'three relayed attempts: ' + keys.join(','))
  const [iss] = keys[0].split('|')
  const cids = keys.map((k) => Number(k.split('|')[1]))
  //! bb commits them as ONE run bb#10..12 and its fan-out reaches aa before its WACK (replication IS an ack): aa's tap
  // adds each record to the spoke's outbox and hops a WACK straight to the spoke's link per record
  const recs = [{ rec: PX('n', 10), pp: 0 }, { rec: QX('y', 11), pp: 6 }, { rec: RX('k', 12), pp: 0 }]
  const fr = encodeRuns(recs.map((r, i) => ({ rec: r.rec, origin: 'bb', seq: 10 + i, epoch: 1, pp: r.pp, iss, cid: cids[i] })), VERB.RECORDS, true)
  assert.equal(fr.length, 1, 'one inbound frame')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: fr[0] })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a WACK hop cleared the queue: queue before the write ' + before.join(' '))
  assert.deepEqual(link.queued.map(frameName), ['bb#10+bb#11+bb#12'], 'the whole tap frame left the outbox after the clear and survived')
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  assert.deepEqual(screenCells(S), fedCells(F), "the exchange's end, before any beat: the spoke shows what its feeder feeds (px.n, its own settled write, kept)")
  assert.deepEqual(kernelCells(S), fedCells(F), "the exchange's end, before any beat: and holds it")
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ x: ['px', 'rx'] }, { e: 'px' }, { e: 'rx' }], 'one word for both, then the two ends')
  beat(20)
  assert.deepEqual(kernelCells(S), fedCells(F), 'after twenty beats: the spoke holds what its feeder feeds')
  assert.deepEqual(screenCells(S), fedCells(F), 'after twenty beats: and shows it')
  assert.deepEqual(laneAt(S, 'bb'), laneAt(F, 'bb'), "lane bb at the spoke equals the feeder's")
})

//! the spoke's link to aa blips: both ends see the close, the spoke re-dials aa (its only host) on link 4, aa admits it on
// link 8; the pump is re-made on the new pair
const reAdmit = (L: ReturnType<typeof latching>) => {
  const { F, S } = L
  S.node.step({ kind: 'linkUp', link: 4, dialed: true, to: 'sim:aa' })
  F.node.step({ kind: 'linkUp', link: 8, dialed: false })
  F.node.step({ kind: 'bytesIn', link: 8, bytes: encodeControl(VERB.HELLO, { u: 'cl', i: 1, l: 'sim:cl', r: 1 }) })
  const p2 = pump(F, 8, S, 4)
  S.node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.HELLO, { u: 'aa', i: 1, l: 'sim:aa', c: SCOPED }) })
  p2.settle()
  const beat2 = (n: number) => { for (let i = 0; i < n; i++) { F.tick(); p2.settle(); S.tick(); p2.settle() } }
  return { p2, beat2 }
}
//! the second review's SK2 and SK3, the rule's link-loss exit (clause 2): the spoke's link to its feeder blips and it
// re-dials the SAME feeder. The admit arm resynced only on a non-empty kernel (or stranded writes, or a resync open),
// and a spoke whose only fed rows were in flight has an EMPTY kernel: it asked plainly, no sweep ran, and the fold's end
// (or the clean abort's word) said during the blip had gone to the dead link — the kept ghosts stayed for good. Now a
// spoke with kept cells resyncs at the admit arm too: the cells join the sweep set and the reply says which to keep.
// Red on the rework at "the screen mirrors the feeder": [px.a, px.b] against [px.a] (and against []); JK.resync 1.
for (const during of ['the fold completes', 'the latch aborts clean'])
  test(`wave 6c — a link blip onto the same feeder with an empty spoke kernel: ${during} while the link is down, and the re-admit resyncs because kept cells exist — the sweep judges them against the next reply`, () => {
    const L = latching()
    const { F, S, p, teach } = L
    onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3]])
    //! aa holds nothing; px is assigned to it and cc's announcement (px to bb#3: px.b died with bb and qq) opens the from-zero latch
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 3 } } }) })
    assert.equal(F.node.scope!.entries.get('px')?.state, SCOPE.acquiring, 'the from-zero latch')
    S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
    p.settle()
    assert.equal(S.node.resync, null, 'the failover\'s resync ended')
    assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[1, 2]], 'qx.z swept; px.a and px.b kept (px in flight)')
    assert.deepEqual(kernelCells(S), [], 'the kernel is empty: every fed row is in flight')
    assert.equal(S.node.logs.size, 0)
    //! the link blips; while it is down px leaves the in-flight set and the word goes to no admitted link
    S.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
    F.node.step({ kind: 'linkDown', link: 7, reason: 'close' })
    if (during === 'the fold completes') { teach(2, [{ seq: 3, rec: PX('a', 1), pp: 0 }], 3); assert.equal(F.node.scope!.held('px'), true) }
    else { F.node.writes.ring.place('px', 'bb', 'cc'); F.node.scope!.rescope(F.node); assert.equal(F.node.scope!.entries.has('px'), false, 'the clean abort') }
    assert.equal(F.node.clientLinks.size, 0, 'nobody heard the word')
    const { beat2 } = reAdmit(L)
    beat2(10)
    assert.equal(S.jk(JK.resync).length, 2, 'the re-admit resynced (the kept cells joined the sweep set)')
    assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[1, 2], [during === 'the fold completes' ? 1 : 2, undefined]], 'the second end swept the ghosts and kept nothing')
    assert.deepEqual(kernelCells(F), during === 'the fold completes' ? ['px.a'] : [])
    assert.deepEqual(screenCells(S), kernelCells(F), 'the screen mirrors the feeder')
    assert.deepEqual(kernelCells(S), kernelCells(F))
  })

//! clause 2's failover exit, pinned (the second review's SK8): the kept cells join the next resync's sweep set. aa dies
// with the fold still to come, a spare rr is elected, and rr's answer has px.a, px.b and qx.z (px.c and px.d died with
// bb, qq and aa): the second end sweeps the two kept cells. Without the fold into the sweep set (#resyncBegin) every
// test was green and the screen read [px.a, px.b, px.c, px.d, qx.z] for good.
test('wave 6c — clause 2\'s failover exit: kept cells, then the feeder dies with a spare linked — the next resync sweeps them when its feeder holds them not and folds nothing', () => {
  const L = latching()
  const { F, S, p } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7]])
  //! a third server rr, hand-driven on link 5, linked as a spare
  S.node.step({ kind: 'linkUp', link: 5, dialed: true, to: 'sim:rr' })
  S.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.HELLO, { u: 'rr', i: 1, l: 'sim:rr', c: SCOPED }) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  assert.equal(S.node.primary, 2)
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 2]], 'px.c and px.d kept: px is in flight at aa')
  //! aa dies before its fold; rr is elected and holds px.a, px.b and qx.z
  S.node.step({ kind: 'linkDown', link: 2, reason: 'close' })
  assert.equal(S.node.primary, 5)
  const ask = S.sentOn(5, VERB.DIGEST).pop()!.value as { d: Record<string, number>; q: number; f?: number }
  assert.deepEqual([ask.d, ask.f], [{}, 1], 'the failover\'s resync ask')
  S.node.step({ kind: 'bytesIn', link: 5, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 5, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 5, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 5, bytes: encodeControl(VERB.DIGEST, { d: { bb: 8 }, r: 0, q: ask.q, w: 1 }) })
  assert.equal(S.node.resync, null)
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 2], [2, undefined]], 'the second end swept the two kept cells and kept nothing')
  assert.deepEqual(screenCells(S), ['px.a', 'px.b', 'qx.z'], 'the kept cells joined the sweep and left')
  assert.deepEqual(kernelCells(S), screenCells(S))
})

//! the second review's SK9: a word is owed only to a link the spoke has been ANSWERED on (a cover or a torn answer).
// aa is a spare of the spoke (link 7 admitted, never synced) and folds px while the spoke is fed by qq: the rework owed
// that link the end, one per fold, never paid while it stayed a spare, and said them as a burst of stray ends after the
// failover's answer. Red on the rework at "no end is owed": FEED [{e: px}], JK.fed [[px, 0, 0]].
test('wave 6c — no end is owed to a link the spoke was never answered on: a spare link gets nothing for a fold at that server, and the failover\'s resync onto it says no stray end', () => {
  const L = latching()
  const { F, S, p, link, teach } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7]])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.node.scope!.held('px'), true, 'the fold')
  assert.equal(link.synced, false, 'the spare link was never answered')
  assert.equal(link.torn, null)
  p.settle()
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'nothing on the spare')
  //! later qq dies: the spoke resyncs onto aa, whose answer carries px whole
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  L.beat(5)
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'no end is owed to a spoke that was never answered on this link')
  assert.deepEqual(S.jk(JK.fed), [])
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, undefined]], 'the end swept nothing: aa holds every cell')
  assert.deepEqual(kernelCells(S), kernelCells(F))
  assert.deepEqual(screenCells(S), kernelCells(F))
})

//! the same for a shed's word (the branch the rework had: #clearCover read the dropped FEED frames even where it left no
// cover). aa, a spare of the spoke, sheds px and then qx while link 7 is paused with a queue of one: the second word
// clears the first, and #clearCover leaves no cover on a link never synced and owes nothing. When qq dies, the resync
// onto aa sweeps both partitions by its own end. Red on the rework at "no stray word": FEED [{x: [px, qx]}] after the
// answer, JK.unfed [[px, 0], [qx, 0]].
test('wave 6c — a shed\'s word cleared from a never-answered client link is not owed: the spoke holds nothing of this feeder, and its first answer is a resync whose end sweeps', () => {
  const L = latching({ tune: { queued: 1 } })
  const { F, S, p, link } = L
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3]], 6)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
  assert.equal(link.synced, false, 'the spare link was never answered')
  F.node.step({ kind: 'pause', link: 7 })
  for (const [q, tail] of [['px', 5], ['qx', 6]] as const) {
    F.node.writes.ring.place(q, 'bb', 'cc')
    F.node.scope!.rescope(F.node)
    F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [q]: { bb: tail } } }) })
    F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [q]: { bb: tail } } }) })
  }
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px', 'qx'])
  assert.equal(F.jk(JK.dropOldest).length, 1, 'the second word cleared the queue of one: both words went')
  assert.equal(link.torn, null, 'no cover on a link never synced')
  assert.deepEqual(link.queued, [])
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  //! qq dies: the spoke resyncs onto aa, which holds nothing now; the end sweeps every cell
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  p.settle()
  L.beat(5)
  assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'no stray word after the answer: nothing was owed to the never-answered link')
  assert.deepEqual(S.jk(JK.unfed), [])
  assert.deepEqual(kernelCells(F), [])
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[3, undefined]], 'the end swept px.a, px.b and qx.z')
  assert.deepEqual(screenCells(S), [])
  assert.deepEqual(kernelCells(S), [])
})

//! the debt is paid into a paused queue (clause 3; the second review's M12 and M13). Three folds at aa while its spoke's
// link is paused and, from the first clear on, unsynced with a cover: three ends owed (px, qx, rx). The drain exchange's
// capped ask is answered live until the hook pauses the link after the one frame (bb#7, 8, 9): the reply queues. With a
// queue of one the reply fills it and no word is pushed in (a word there would clear the reply it follows): the drain
// sends the reply, and the next heartbeat answer pays all three. With a queue of two the first word fits, the second
// overflows — the clear takes the reply and both words, owed again by #clearCover — and the third was never taken out of
// the debt: the drain resumes the torn answer and its reply pays all three. Red with the whole debt taken out before the
// first word ships (the rework's shape, queue of two): rx's end is never said; red without the full-queue guard (queue of
// one): a second clear, forced by the word.
// The third shape is the queue of one at the BYTE bound (tune row queuedBytes 1, the count bound far off; V4-61): the
// reply alone holds the queue's bytes, so the queue is full and no word is pushed in. Red with the guard counting
// frames only, as the lane wrote it before the merge with V4-61: the first word is pushed into the byte-full queue and
// clears the reply it follows (a second clear).
for (const shape of [1, 2, 'bytes'] as const)
  test(`wave 6c — three owed ends paid into a paused queue of ${shape === 'bytes' ? 'one, full by BYTES' : shape}: ${shape !== 2 ? 'the reply fills it, no word forces a clear, the next heartbeat answer pays' : 'the second word overflows and the clear takes it with the reply, the third stays owed, the resumed answer pays all three'}`, () => {
    const queued = shape === 2 ? 2 : 1
    let armed = false
    let Fh: H | null = null
    const L = latching({ tune: shape === 'bytes' ? { queuedBytes: 1 } : { queued: shape } }, (l) => { if (l === 7 && armed && Fh) { armed = false; Fh.node.step({ kind: 'pause', link: 7 }) } })
    const { F, S, p, link, connect, beat } = L
    Fh = F
    F.node.writes.ring.place('rx', 'bb', 'aa')
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
    F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 6, 0, VERB.RECORDS) })
    connect()
    assert.deepEqual(kernelCells(S), ['px.a', 'px.b', 'qx.z'])
    F.node.step({ kind: 'pause', link: 7 })
    //! three latches from cc's announcements: px and qx repaired on their held bases, rx from zero; every end is owed
    const fold = (q: string, rec: Rec, seq: number, pp: number) => {
      F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { [q]: { bb: seq } } }) })
      assert.equal(F.node.scope!.entries.get(q)!.state, SCOPE.acquiring, `${q} latched`)
      F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeRuns([{ rec, origin: 'bb', seq, epoch: 1, pp }], VERB.ACQ, true)[0] })
      F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: q, e: 1, t: { bb: seq }, n: 1 }) })
      assert.equal(F.node.scope!.held(q), true, `${q} folded`)
    }
    fold('px', PX('c', 3), 7, 5)
    fold('qx', QX('w', 7), 8, 6)
    fold('rx', { type: REC.update, key: ['rx', 'a'], value: 1 }, 9, 0)
    assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear: the first group overflowed the queue')
    assert.equal(link.synced, false)
    assert.deepEqual(link.torn, { d: { bb: 6 }, r: undefined, q: undefined, c: true }, 'the cover sits under bb#7')
    assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'no end reached the socket')
    //! the heal: the drain digest carries the cover, the spoke asks capped, and the answer pauses after its one frame
    F.node.step({ kind: 'drain', link: 7 })
    p.toB()
    armed = true
    p.toA()
    const kinds = () => link.queued.map((b) => new Framer().push(b.slice())[0].verb)
    if (queued === 1) {
      assert.deepEqual(kinds(), [VERB.DIGEST], 'the reply fills the queue; no owed word is pushed into it')
      assert.equal(F.jk(JK.dropOldest).length, 1, 'no clear forced by a word')
    } else {
      assert.deepEqual(kinds(), [], 'the second word overflowed: the clear took the reply and both words')
      assert.equal(F.jk(JK.dropOldest).length, 2)
      assert.equal(link.torn?.r, 1, 'the answer is torn at its reply, resumed at the drain')
    }
    assert.deepEqual(F.sentOn(7, VERB.FEED), [], 'nothing on the socket yet')
    F.node.step({ kind: 'drain', link: 7 })
    p.settle()
    beat(5)
    assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => (f.value as { e: string }).e).sort(), ['px', 'qx', 'rx'], 'every owed end said, once each')
    assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]).sort(), [['px', 0, 0], ['qx', 0, 0], ['rx', 0, 0]])
    assert.deepEqual(kernelCells(F), ['px.a', 'px.b', 'px.c', 'qx.w', 'qx.z', 'rx.a'])
    assert.deepEqual(kernelCells(S), kernelCells(F))
    assert.deepEqual(screenCells(S), kernelCells(F))
    assert.equal(F.jk(JK.dropOldest).length, queued === 1 ? 1 : 2, 'no clear beyond the designed ones')
  })

//! the ask flag (the review's PROBE2): a scoped spoke's resync ask says `f: 1` and the reply names the partitions in
// flight. The first build used the flag up at the first reply (#askF deleted there), so a reply a clear took from the
// paused queue resumed at the drain WITHOUT `f`, and the end swept the partition under repair: the vanish-and-return
// came back through the clear. Now the flag lives until the spoke's next digest on the link. Red on the first build at
// "no px cell left the screen at the resync end": actual [px.c, px.d] removed (and back at the fold).
test('wave 6c — the in-flight list survives a cleared reply: the feeder pauses inside the answer, live taps overflow the queue and the clear takes the queued reply with its `f`; the resumed reply at the drain carries the list again and the end keeps the partition under repair', () => {
  let armed = false
  let Fh: H | null = null
  const L = latching({ tune: { queued: 4 } }, (link) => { if (link === 7 && armed && Fh) { armed = false; Fh.node.step({ kind: 'pause', link: 7 }) } })
  const { F, S, p, link, cells, teach } = L
  Fh = F
  onQQ(L, [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7]])
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'aa is repairing px')
  //! the failover: the ask lands while the link flows, and the socket fills inside the answer's first send
  const a0 = S.of('apply').length
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  armed = true
  p.toA()
  assert.equal(link.paused, true, 'paused inside the answer')
  const queued = () => link.queued.map((b) => new Framer().push(b.slice())[0]).filter((f) => f.verb === VERB.DIGEST).map((f) => f.value)
  assert.deepEqual(queued(), [{ d: { bb: 8 }, r: 0, w: 1, q: 2, f: ['px'] }], 'the reply waits in the queue, with the list')
  //! live qx records tapped onto the paused link (synced now) overflow the queue: the clear takes the reply
  for (let s = 10; s < 16 && F.jk(JK.dropOldest).length === 0; s++) F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('y' + s, s), s, s === 10 ? 8 : s - 1, VERB.RECORDS) })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'a clear took the queued reply')
  assert.deepEqual(link.torn && [link.torn.r, link.torn.q], [1, 2], 'the answer is torn at its first queued frame: resumed at the drain')
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'still repairing px at the drain')
  F.node.step({ kind: 'drain', link: 7 })
  p.settle()
  const replies = F.sentOn(7, VERB.DIGEST).map((f) => f.value as { r: number; q?: number; f?: string[] })
  assert.deepEqual(replies.filter((r) => r.r === 0).map((r) => [r.q, r.f]), [[2, ['px']]], 'the resumed reply carries the list (it had none on the first build)')
  assert.equal(S.node.resync, null, 'the resync ended')
  const removes = () => S.of('apply').slice(a0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => JSON.stringify(r.key))
  assert.deepEqual(removes(), [], 'no px cell left the screen at the resync end (the reply named px in flight)')
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 2]], 'px.c and px.d kept')
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  p.settle()
  assert.deepEqual(cells(S), cells(F), 'the fold brought them back into the kernel')
  assert.deepEqual(removes(), [], 'and nothing ever left the screen')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 2, 0]])
  assert.deepEqual(screenCells(S), kernelCells(F))
})

//! a shed word racing an open fold group (the review's PROBE6): the socket fills inside the fold's forward, so the
// clear takes bb#9 and the end, and the spoke's group for px stays open with bb#7 in it; then px moves off aa and is
// shed, and FEED {x} waits in the queue. At the drain the {x} landed at the spoke while the group was open: on the
// first build #unfeed dropped px, then the next digest closed the group and put px.c back, for good. Now a FEED {x}
// closes an open group first (a frame of a later step, as a digest is) and the unfeed runs on the landed kernel in the
// same step. Red on the first build at "the spoke holds what its feeder holds": actual [px.c, qx.z], expected [qx.z].
test('wave 6c — a shed word closes an open fold group first: the fold\'s end cleared, the partition shed and FEED {x} delivered while the group is open — the group lands, then the partition leaves, in one step; nothing of it comes back', () => {
  let armAt = 0, count = 0
  let Fh: H | null = null
  const L = latching({ tune: { queued: 1 } }, (link) => { if (link === 7 && armAt && ++count === armAt && Fh) { armAt = 0; Fh.node.step({ kind: 'pause', link: 7 }) } })
  const { F, S, p, link, connect, cells, beat, teach } = L
  Fh = F
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  connect()
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  p.settle()
  assert.equal(link.synced, true)
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  const m = F.of('send').filter((e) => e[1] === 7).length
  //! the socket fills inside the 2nd send of the fold's forward (bb#7): bb#9 and the end overflow the queue of one
  armAt = 2; count = 0
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 3 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.node.scope!.held('px'), true)
  assert.deepEqual(wireOf(F, 7, m), ['verb28', '7'], 'the {b} and bb#7 reached the socket; the clear took bb#9 and the end')
  assert.equal(F.jk(JK.dropOldest).length, 1)
  p.toB()
  assert.notEqual(S.node.group, null, 'the group is open at the spoke, bb#7 in it, its end lost')
  //! a join moves px off aa; both holders attest it; aa sheds px, and FEED {x} waits in the paused queue
  F.node.writes.ring.place('px', 'bb', 'cc')
  F.node.scope!.rescope(F.node)
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  assert.deepEqual(F.jk(JK.shed).map((e) => e.a), ['px'])
  F.node.step({ kind: 'drain', link: 7 })
  assert.deepEqual(wireOf(F, 7, m), ['verb28', '7', 'verb28', 'DIGEST'], 'the drain: the shed\'s word, then the drain digest')
  p.settle()
  beat(5)
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 1, undefined]], 'the word closed the group: one frame landed, nothing judged')
  assert.deepEqual(S.jk(JK.unfed).map((e) => [e.a, e.b]), [['px', 2]], 'then px left: bb#3 and the landed bb#7')
  assert.deepEqual(cells(S), cells(F), 'the spoke holds what its feeder holds')
  assert.deepEqual(kernelCells(S), ['qx.z'])
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.equal(S.node.group, null)
  assert.deepEqual(F.sentOn(7, VERB.FEED).map((f) => f.value), [{ b: 'px' }, { x: ['px'] }], 'no owed end was said: px is not held here any more (the shed\'s word is its exit)')
})

//! the vanish-and-return (STATUS "a spoke that fails over onto a feeder that is repairing a partition ... loses that
// partition's rows from its screen at the resync's end, until the fold forwards them back"): a spoke first fed by qq holds
// px whole (bb#3, 5, 7, 9, 11) and qx; qq dies while aa, its next feeder, is RE-LATCHING px (its base bb#3, bb#5 in the
// lane; the teacher's delta still to come). The resync's answer ships what aa holds of px; the end used to sweep px.c,
// px.d and px.z from the screen, and the fold's forward brought px.c and px.d back. Now the ask says `f: 1`, aa's reply
// names px in flight, the end KEEPS the three cells on the screen (JK.resynced c=3), the fold's group lands px.c and
// px.d (back in the kernel, done) and judges px.z gone at once: the fold did not bring it — qq had a record aa never
// gets. (The first build kept px.z waiting until lane bb moved past 11; the review's PROBE5 killed bb instead, and the
// cell stayed for good. Clause 1 of the rule: the end judges every kept cell.) Red on the tree before at "no cell left
// the screen at the resync's end": three removes; red on the first build at "px.z left the screen at the fold's end".
test('wave 6c — the vanish-and-return: a spoke failing over onto a feeder mid-repair keeps the partition\'s cells on its screen across the resync end (the reply names the partition in flight), the fold\'s end confirms what it brought and judges the rest gone at once — nothing waits on a lane that may never move again', () => {
  const { F, S, p, connect, cells, laneAt, beat, teach } = latching()
  //! the first feeder qq, hand-driven on link 3: admitted first, so it is the primary; it serves px whole and qx
  S.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:qq' })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'qq', i: 1, l: 'sim:qq', c: SCOPED }) })
  assert.equal(S.node.primary, 3)
  assert.deepEqual(digests(S, 3), [{ d: {}, r: 1, q: 1 }], 'a first ask: not a resync, no f')
  for (const [k, v, seq, pp] of [['a', 1, 3, 0], ['b', 2, 5, 3], ['c', 3, 7, 5], ['d', 4, 9, 7], ['z', 5, 11, 9]] as const) S.node.step({ kind: 'bytesIn', link: 3, bytes: one('bb', PX(k, v), seq, pp, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  S.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { bb: 11 }, r: 0, q: 1, w: 1 }) })
  assert.equal(S.node.state.size, 6)
  //! aa admitted as the spare (no digest: the single-feeder rule); at aa px is held with bb#3, bb#5, qx with bb#8, and cc's
  // announcement (bb at 9) opens the repair latch for px
  connect()
  assert.equal(S.node.primary, 3, 'still fed by qq')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('a', 1), 3, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', PX('b', 2), 5, 3, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: one('bb', QX('z', 9), 8, 0, VERB.RECORDS) })
  F.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 9 } } }) })
  assert.equal(F.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'aa is repairing px')
  assert.deepEqual(F.node.scope!.inFlight(F.node), ['px'])
  //! qq dies: the failover onto aa is a resync — the ask asks for the in-flight list
  const a0 = S.of('apply').length
  S.node.step({ kind: 'linkDown', link: 3, reason: 'close' })
  assert.equal(S.node.primary, 2)
  const ask = digests(S, 2).at(-1)
  p.settle()
  assert.equal(S.node.resync, null, 'the resync ended')
  const removes = () => S.of('apply').slice(a0).map((e) => e[1] as Rec).filter((r) => r.type === REC.remove).map((r) => JSON.stringify(r.key))
  assert.deepEqual(removes(), [], 'no cell left the screen at the resync\'s end (px.c, px.d and px.z were swept before, and two came back at the fold)')
  assert.deepEqual(ask, { d: {}, r: 1, q: 2, f: 1 }, 'the resync\'s ask asked which partitions are in flight')
  const reply = F.sentOn(7, VERB.DIGEST).at(-1)!.value as { r: number; f?: string[] }
  assert.deepEqual([reply.r, reply.f], [0, ['px']], 'the reply named px in flight')
  assert.deepEqual(cells(S), ['["px","a"]=1', '["px","b"]=2', '["qx","z"]=9'], 'the kernel holds what the answer brought')
  assert.deepEqual(S.jk(JK.resynced).map((e) => [e.a, e.c]), [[0, 3]], 'the journal: no ghost, three cells kept back')
  //! the teacher's delta: bb#7 and bb#9 (a gap at 8: two frames) — the fold's group lands them and judges the kept cells
  teach(2, [{ seq: 7, rec: PX('c', 3), pp: 5 }, { seq: 9, rec: PX('d', 4), pp: 7 }], 9)
  assert.equal(F.node.scope!.held('px'), true)
  p.settle()
  assert.deepEqual(laneAt(S, 'bb'), [3, 5, 7, 8, 9])
  assert.deepEqual(cells(S), cells(F), 'px.c and px.d are back in the kernel: the group brought them')
  assert.deepEqual(removes(), [JSON.stringify(['px', 'z'])], 'px.z left the screen at the fold\'s end: the fold did not bring it (it waited for lane bb to pass 11 before, and a lane can stop for good)')
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 2, 1]], 'the fold\'s end: two frames landed, one kept cell judged a ghost')
  assert.deepEqual(screenCells(S), kernelCells(F), 'the screen mirrors the feeder')
  //! the review's PROBE5: the owner of lane bb dies — the lane never moves again — and nothing is left waiting on it
  F.node.step({ kind: 'linkDown', link: 1, reason: 'close' })
  p.settle()
  beat(10)
  assert.deepEqual(S.jk(JK.fed).map((e) => [e.a, e.b, e.c]), [['px', 2, 1]], 'no later judgement: there was nothing left to judge')
  assert.deepEqual(cells(S), cells(F), 'the spoke mirrors its feeder')
  assert.deepEqual(screenCells(S), kernelCells(F))
  assert.deepEqual(screenRows(S), ['px', 'qx'])
})
