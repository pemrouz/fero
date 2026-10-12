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
  //! a tick passes: in resync the spoke sends NO heartbeat floor (cl sorts below oo; out of resync it floors oo), and oo's
  // heartbeat r=1 gets no answer whatever the ask's age. oo's DRAIN digest (h: 1) is what re-asks: q=4 (kernel probe B)
  const sent = digests(h, 3).length
  h.tick()
  assert.equal(digests(h, 3).length, sent, 'no floor in resync')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { tt: 1 }, r: 1, w: 1 }) })
  assert.equal(digests(h, 3).length, sent, 'a tick old or not, a heartbeat r=1 in resync gets no answer')
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: { tt: 1 }, r: 1, w: 1, h: 1 }) })
  assert.deepEqual(digests(h, 3).slice(sent), [{ d: {}, r: 1, q: 4 }], 'the drain digest: answered with a request of the spoke\'s own')
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
  assert.deepEqual(digests(S, 2).slice(s0), [{ d: {}, r: 1, q: 2 }], 'the ask')
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
  assert.deepEqual(digests(S, 2).slice(s0), [{ d: {}, r: 1, q: 2 }], 'one ask, one ship: no drain digest, so nothing more is asked')
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
  const { F, S, p, link, rows } = steady(2)
  F.node.writes.ring.place('px', 'bb', 'aa')
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { px: { bb: 23 } } }) })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: PX('a', 23), origin: 'bb', seq: 23, epoch: 1, pp: 0 }], VERB.ACQ, true)[0] })
  F.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 23 }, n: 1 }) })
  assert.equal(F.node.scope!.held('px'), true, 'the latch folded px')
  assert.equal(link.queued.length, 1, 'the latch fold tapped the row onto the paused link (wave 6a; it tapped nothing before)')
  for (let i = 0; i < 3; i++) F.node.step({ kind: 'reply', link: 7, id: i + 1, ok: true, value: i })
  assert.equal(F.jk(JK.dropOldest).length, 1, 'one clear: it took the tap frame and two replies')
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
