//! Tier-1 M6 slice-2 suite: the scoped EVIDENCE plane — possession floors, the dual-fence ingest law,
// the no-interior-rows WAL discipline, the boot dirty ledger, the replay held-gate, scoped confirm
// thresholds, and the armed compaction pin. Everything here drives the kernel by hand-crafted events
// against a recording sink (the write.test.ts idiom); the companion guarantee is INERTNESS — the
// unscoped control cases pin that none of this machinery is reachable at R=∞.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { compact, compactScoped, maybeCompact } from './log.ts'
import { SCOPE } from './scope.ts'
import { Framer, VERB, encodeControl, encodeRuns } from './codec.ts'
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
    persist: (batch, bytes) => effects.push(['persist', batch, bytes]),
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
  const tick = () => {
    const t = of('timer').filter((x) => x[2] === TAG.heartbeat).pop()!
    node.step({ kind: 'timer', id: t[1] as number, tag: TAG.heartbeat })
  }
  const jk = (kind: number) => node.journal.read().filter((e) => e.kind === kind)
  const admit = (link: number, u: string) => {
    node.step({ kind: 'linkUp', link, dialed: true, to: `sim:${u}` })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}` }) })
    node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  return { node, effects, of, tick, jk, admit }
}

//! an ARMED aa at committed view 1 over {aa, bb, cc}: replicas set + the boot record installs epoch 1
// directly (the M4 restored-view idiom), so the arming predicate flips without driving a live ballot.
const armedView1 = (opts: Partial<ConstructorParameters<typeof Node>[0]> = {}) => {
  const h = harness('aa', {
    replicas: 2,
    boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] },
    ...opts,
  })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.admit(2, 'cc')
  //! a live peer confirms the restored view — releases the rejoin read-only floor (plan boot modes)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.armed, true)
  assert.equal(h.node.membership.gate(h.node).open, true)
  return h
}

const rec = (key: string[], value: unknown): Rec => ({ type: REC.update, key, value })
//! one frame per call — encodeRuns splits NON-CONTIGUOUS seqs into several frames (gappy Lamport
// lanes are the norm here), so the helper asserts the rows encoded to exactly one. Rows may carry
// pp (the M6-review floor law): a row WITHOUT pp decodes as UNKNOWN and every floor-advance site
// fails closed on it — armed-path pins that assert floor movement must stamp the chain.
const frame = (origin: string, rows: { seq: number; rec: Rec; pp?: number }[], epoch = 1): Uint8Array => {
  const withPp = rows.some((r) => r.pp !== undefined)
  const out = encodeRuns(rows.map((r) => ({ rec: r.rec, origin, seq: r.seq, epoch, pp: r.pp })), VERB.RECORDS, withPp)
  assert.equal(out.length, 1, 'test rows must be one contiguous run — send gappy seqs as separate frames')
  return out[0]
}

test('DUAL FENCE — an under-fence interior SPLICES in (lane ascending, floor chains); dups above and below the floor still drop', () => {
  const h = armedView1()
  //! pin the partitions onto aa's R-set — the inbound gate must ADMIT them by placement, not hash luck
  h.node.writes.ring.place('p1', 'bb', 'aa')
  h.node.writes.ring.place('p2', 'bb', 'aa')
  //! cross-link interleave: seqs 10 then 12 arrive first (applied runs to 12), the interior 11 later.
  // Every row carries its sub-stream pp — the floor law admits only chain-verified advances.
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2), pp: 0 }]) })
  const d = h.node.streams.get('bb')!
  assert.equal(d.applied, 12)
  assert.deepEqual([d.parts!.get('p1')!.s, d.parts!.get('p2')!.s], [10, 12], 'chained fast-path floors track per-partition sub-streams')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3), pp: 10 }]) })
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [10, 11, 12], 'the splice lands at its seq position — ascending preserved')
  assert.equal(h.node.state.get(JSON.stringify(['p1', 'b'])), 3, 'the interior record folded through the one LWW election')
  assert.equal(d.parts!.get('p1')!.s, 11, 'the possession floor advanced with the CHAINED splice')
  assert.equal(d.applied, 12, 'the scalar fence never regresses or fragments')
  //! a genuine duplicate of the splice drops on lane presence; a below-floor absentee drops as covered
  const dups = () => h.jk(JK.dupDrop).length
  const before = dups()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3), pp: 10 }]) })
  assert.equal(dups(), before + 1, 'present-in-lane ⇒ dup')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 9, rec: rec(['p1', 'z'], 9), pp: 0 }]) })
  assert.equal(dups(), before + 2, 'absent but ≤ floor ⇒ effect-covered, dropped')
  assert.equal(h.node.state.has(JSON.stringify(['p1', 'z'])), false)
})

test('FLOOR LAW — a gapped or unknown pp FOLDS but never advances the floor; the gap-fill chain-walk trues it up (M6-review findings 10/18/25)', () => {
  const h = armedView1()
  h.node.writes.ring.place('p1', 'bb', 'aa')
  const d = () => h.node.streams.get('bb')!
  //! a MID-LANE first arrival (pp 20 over an interior aa never received): folds, mints held — and
  // claims NOTHING (the v2-era eager advance forged coverage of 1..20 and orphans shed on it)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 21, rec: rec(['p1', 'x'], 1), pp: 20 }]) })
  assert.equal(h.node.scope!.held('p1'), true, 'the record folded (availability preserved)')
  assert.equal(h.node.state.get(JSON.stringify(['p1', 'x'])), 1)
  assert.equal(d().parts?.get('p1')?.s ?? 0, 0, 'the floor made NO claim over the unpossessed interior')
  //! an UNKNOWN pp (flag-less frame — pre-pp history, epoch-0 rows) fails closed the same way
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 25, rec: rec(['p1', 'y'], 2) }]) })
  assert.equal(d().parts?.get('p1')?.s ?? 0, 0, 'unknown predecessor ⇒ fold, never advance')
  //! the AE-shaped heal: the missing prefix arrives (chained from 0) — the splice chain-walk trues
  // the floor THROUGH the previously-gapped 21 but stops at the unknown-pp 25
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 20, rec: rec(['p1', 'base'], 0), pp: 0 }]) })
  assert.equal(d().parts!.get('p1')!.s, 21, 'gap filled ⇒ the walk chained 20 then 21; the unknown 25 stays unclaimed')
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [20, 21, 25], 'every record is in the lane regardless of floor claims')
})

test('INERTNESS — the same interleave at an UNSCOPED node dup-drops the interior (the M1 scalar fence, byte-for-byte)', () => {
  const h = harness('aa', { hosts: ['sim:bb'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }], 0) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2) }], 0) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3) }], 0) })
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [10, 12], 'no splice — the under-fence arrival dropped')
  assert.equal(h.node.streams.get('bb')!.parts, undefined, 'no floors ever allocate unscoped')
})

test('CLIENT — a spoke accepts its feeder\'s interior re-forwards through the same dual fence, floors stay unallocated', () => {
  const h = harness('cl', { client: true, hosts: ['sim:aa'] })
  h.node.step({ kind: 'start' })
  h.admit(1, 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2) }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3) }]) })
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [10, 11, 12], 'the spoke spliced the interior — no permanent gap behind a scoped feeder')
  assert.equal(h.node.streams.get('bb')!.parts, undefined, 'a client attests nothing — floors never allocate')
  //! and a genuine dup still drops (unscoped-trajectory equivalence: found-in-lane ⇒ drop)
  const before = h.jk(JK.dupDrop).length
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }]) })
  assert.equal(h.jk(JK.dupDrop).length, before + 1)
})

test('STAMP SITE — an armed owner\'s own-lane floor advances with every local commit', () => {
  const h = armedView1()
  h.node.writes.ring.place('mine', 'aa')
  h.node.step({ kind: 'write', recs: [rec(['mine', 'x'], 1), rec(['mine', 'y'], 2)] })
  const d = h.node.streams.get('aa')!
  assert.ok(d.parts!.get('mine')!.s >= 2, 'the minting owner\'s floor is its own tail — trivially sound')
})

test('WAL DISCIPLINE — a splice never rides persistRun: splice-only frames persist nothing, the partition goes dirty (boot ledger), the snapshot swap captures it and its echo clears', () => {
  const h = armedView1({ durable: true })
  h.node.writes.ring.place('p1', 'bb', 'aa')
  h.node.writes.ring.place('p2', 'bb', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2), pp: 0 }]) })
  const persists = () => h.of('persist').length
  const afterFast = persists()
  assert.ok(afterFast >= 1, 'the fast-path frame persisted (the received bytes are the row)')
  //! the persisted echoes advance the per-(origin, partition) DURABLE floors each batch covered
  for (const p of h.of('persist')) h.node.step({ kind: 'persisted', batch: p[1] as number })
  const d = h.node.streams.get('bb')!
  assert.deepEqual([d.parts!.get('p1')!.d, d.parts!.get('p2')!.d], [10, 12], 'durable floors advanced per the batch cover')
  //! the interior arrives: memory-only — NO persist effect, the partition is dirty in the boot record
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3), pp: 10 }]) })
  assert.equal(persists(), afterFast, 'a splice-only frame persisted NOTHING (an interior row would condemn the chain on replay)')
  const boot = h.of('boot').pop()![1] as BootRecord
  assert.deepEqual(boot.dirtyParts, ['p1'], 'the dirty ledger is durable BEFORE the splice can be lost to a crash')
  assert.equal(d.parts!.get('p1')!.d, 10, 'the durable floor does NOT cover the splice yet')
  //! the armed snapshot swap captures the whole fold; its echo advances the floor and clears dirty
  h.tick()
  const snap = h.of('snapshot').pop()!
  assert.ok(snap, 'the splice armed the snapshot swap')
  h.node.step({ kind: 'persisted', batch: snap[1] as number })
  assert.equal(d.parts!.get('p1')!.d, 11, 'the swap\'s echo covers the splice')
  const boot2 = h.of('boot').pop()![1] as BootRecord
  assert.equal(boot2.dirtyParts, undefined, 'dirty cleared — the disk restores the splice now')
})

test('REPLAY — the boot held-gate skips non-held rows (applied/chain advance, no fold), floors rebuild through the pp chain EXCEPT boot-dirty partitions', () => {
  const h = harness('aa', {
    replicas: 2,
    boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']], heldPartitions: ['p1', 'p3'], dirtyParts: ['p3'] },
  })
  //! pin p2 away from aa so the ring agrees with the boot record's silence about it
  h.node.writes.ring.place('p2', 'bb', 'cc')
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1), pp: 0 }]), prev: 0 })
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2), pp: 0 }]), prev: 10 })
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 14, rec: rec(['p3', 'a'], 3), pp: 0 }]), prev: 12 })
  const d = h.node.streams.get('bb')!
  assert.equal(d.applied, 14, 'applied advanced over every row — held or not (the chain stays whole)')
  assert.equal(h.node.walTail.get('bb'), 14)
  assert.equal(h.node.state.has(JSON.stringify(['p2', 'a'])), false, 'the non-held row did not fold')
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [10, 14], 'the non-held row is not in the lane')
  assert.equal(h.node.state.get(JSON.stringify(['p3', 'a'])), 3, 'a DIRTY partition still folds (data is data)')
  assert.deepEqual([d.parts!.get('p1')!.s, d.parts!.get('p1')!.d], [10, 10], 'held floors rebuild from disk — possession AND durability')
  assert.equal(d.parts!.get('p3'), undefined, 'boot-dirty floors stay ZERO — row maxes would overclaim the lost interior; the handshake re-heals')
  assert.equal(h.node.tainted, false)
})

test('SCOPED CONFIRM — the threshold is W of the R-set: a solo armed owner self-proves, a 3-member R=2 probe waits for attested peer marks (none until the handshake lands) and cancels honestly', () => {
  //! solo: R_eff = min(2, 1) = 1 ⇒ W = 1 — own floors suffice
  const solo = harness('aa', { replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa']] } })
  solo.node.membership.rejoinFloor = 0 // the release protocol is membership.test.ts's concern
  solo.node.step({ kind: 'write', recs: [rec(['k', 'x'], 1)] })
  const seq = solo.node.streams.get('aa')!.applied
  solo.node.step({ kind: 'confirm', id: 7, origin: 'aa', seq, level: 0, part: 'k' })
  const ans = solo.of('confirm').pop()!
  assert.deepEqual([ans[1], ans[2], ans[3]], [7, true, 1], 'self possession floor is W=1 evidence')
  //! formed 3-member view, R=2 ⇒ W=2: peers attest nothing yet (slice 3b feeds marks) — the probe
  // can only wait; cancel answers false with the honest count of 1 (never an overclaim off digests)
  const h = armedView1()
  h.node.writes.ring.place('mine', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [rec(['mine', 'x'], 1)] })
  const s2 = h.node.streams.get('aa')!.applied
  h.node.step({ kind: 'confirm', id: 9, origin: 'aa', seq: s2, level: 0, part: 'mine' })
  assert.equal(h.of('confirm').length, 0, 'no digest shortcut: a peer lane tail is NOT scoped possession evidence')
  h.node.step({ kind: 'confirmCancel', id: 9 })
  const c = h.of('confirm').pop()!
  assert.deepEqual([c[1], c[2], c[3]], [9, false, 1])
})

//! ── slice 3a: the scope machine — inbound gate, orphan freeze, fan-out filter, AE filter ──

test('INBOUND GATE — a record for a non-assigned partition gate-drops (no fold, no floors, applied untouched); an assigned partition mints a held entry', () => {
  const h = armedView1()
  h.node.writes.ring.place('theirs', 'bb', 'cc')
  h.node.writes.ring.place('ours', 'aa', 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 5, rec: rec(['theirs', 'x'], 1) }]) })
  assert.equal(h.jk(JK.gateDrop).length, 1, 'the epoch-skew window: dropped, journaled')
  assert.equal(h.node.state.size, 0)
  assert.equal(h.node.streams.get('bb')?.applied ?? 0, 0, 'a gate-drop advances NOTHING — the dropper never attests')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 6, rec: rec(['ours', 'x'], 2) }]) })
  assert.equal(h.node.state.size, 1, 'the assigned partition folded')
  assert.equal(h.node.scope!.held('ours'), true, 'first-ever record minted a held entry (complete by construction)')
  assert.equal(h.node.scope!.held('theirs'), false)
})

test('ORPHAN FREEZE — an install that moves a held partition off the R-set freezes it: new records gate-drop, floors never advance, JK.orphaned fires', () => {
  const h = armedView1()
  h.node.writes.ring.place('p', 'bb', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1) }]) })
  assert.equal(h.node.scope!.held('p'), true)
  const floorBefore = h.node.streams.get('bb')!.parts!.get('p')!.s
  //! epoch 2 re-pins p away from aa — the install's rescope must freeze aa's copy
  h.node.writes.ring.place('p', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.epoch, 2)
  assert.equal(h.jk(JK.orphaned).length, 1, 'the freeze is journaled at the install')
  assert.equal(h.node.scope!.held('p'), false)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 6, rec: rec(['p', 'y'], 2) }], 2) })
  assert.equal(h.jk(JK.gateDrop).length, 1, 'orphans are HARD-frozen — feeding them would move the shed bar')
  assert.equal(h.node.streams.get('bb')!.parts!.get('p')!.s, floorBefore, 'frozen floors never advance (the shed predicate reads these)')
  assert.equal(h.node.state.get(JSON.stringify(['p', 'x'])), 1, 'the frozen copy itself survives until shed (3b)')
})

test('FAN-OUT FILTER — an armed owner ships a commit only to the partition\'s OTHER holders (plus client links); non-holders hear nothing live', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('mine', 'aa', 'cc') // holder set {aa, cc} — bb (link 1) is OUT
  h.node.step({ kind: 'write', recs: [rec(['mine', 'x'], 1)] })
  const records = (link: number) => h.of('send').filter((e) => e[1] === link)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
    .filter((f) => f && f.verb === VERB.RECORDS)
  assert.equal(records(2).length, 1, 'the co-holder heard the commit live')
  assert.equal(records(1).length, 0, 'the non-holder heard NOTHING — the R-set is the wire scope')
})

//! a forwarded-attempt frame as a peer or a client builds it: prov = [issuer, baseCid, attemptEpoch]
const writeFrame = (issuer: string, c0: number, ae: number, recs: Rec[]): Uint8Array =>
  encodeRuns(recs.map((r, i) => ({ rec: r, origin: issuer, seq: c0 + i, epoch: ae })), VERB.WRITE)[0]
const framesOn = (h: ReturnType<typeof harness>, link: number, verb: number) => h.of('send').filter((e) => e[1] === link)
  .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === verb)

test('ACKED (DESIGN-SCALE stage 1) — an armed owner names its lane in the WACK; an issuer that will never fold the record hears `acked`; a holder issuer waits for the join; a relay hops the lane only for a partition it will not tap', () => {
  //! the OWNER side: aa (armed, incarnation 2 — the lane is aa~2) commits bb's forwarded attempt and answers with `o`
  const o = armedView1({ incarnation: 2 })
  o.node.membership.rejoinFloor = 0
  o.node.writes.ring.place('mine', 'aa', 'cc')
  o.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [rec(['mine'], 1)]) })
  const owned = framesOn(o, 1, VERB.WACK)
  assert.equal(owned.length, 1)
  assert.deepEqual(owned[0].value, { u: 'bb~1', c: 5, n: 1, s: o.node.logs.get('aa~2')![0].seq, e: 1, o: 'aa~2' }, 'the WACK names the lane, with its incarnation')
  //! a retransmit of the same cid dup-ACKs with the lane too (the window kept it)
  o.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [rec(['mine'], 1)]) })
  assert.equal((framesOn(o, 1, VERB.WACK)[1].value as { o?: string }).o, 'aa~2', 'the dup answer carries the lane')
  //! the ISSUER side: aa does not hold 'theirs' (bb, cc) — the record will never fold here: `acked` settles
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('theirs', 'bb', 'cc')
  h.node.step({ kind: 'write', recs: [rec(['theirs'], 7)] })
  assert.equal(h.node.writes.pending.size, 1, 'forwarded to bb, pending')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 9, e: 1, o: 'bb~3' }) })
  assert.deepEqual(h.of('acked'), [['acked', 'aa~1', 1, 'bb~3', 9, 1]], 'the WACK is the settlement: committed on the owner lane')
  assert.deepEqual(h.node.writes.committed('aa~1', 1), { s: 9, e: 1, o: 'bb~3', p: 'theirs' }, 'the window names the lane, not the link (and the partition, since stage 3: the ACQDONE `w` body selects by it)')
  //! a partition aa HOLDS as a co-holder: the record follows the WACK on the same link — the join settles, never `acked`
  h.node.writes.ring.place('ours', 'bb', 'aa')
  h.node.step({ kind: 'write', recs: [rec(['ours'], 8)] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 2, n: 1, s: 10, e: 1, o: 'bb' }) })
  assert.equal(h.of('acked').length, 1, 'no acked for a partition this node will fold')
  assert.equal(h.node.writes.pending.size, 0, 'cleared all the same')
  //! a WACK without a lane (an unscoped owner would send one) clears but never settles through `acked`
  h.node.step({ kind: 'write', recs: [rec(['theirs'], 9)] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 3, n: 1, s: 11, e: 1 }) })
  assert.equal(h.of('acked').length, 1)
  assert.equal(h.node.writes.pending.size, 0)
  //! the RELAY side: a spoke zz on link 3 writes 'theirs' (aa will not tap it) and 'ours' (aa will): the hop
  // to the spoke carries the lane only for 'theirs'
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, 0, [rec(['theirs'], 1), rec(['ours'], 2)]) })
  assert.equal(framesOn(h, 1, VERB.WRITE).length, 4, 'both relayed to bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'zz~1', c: 1, n: 2, s: 20, e: 1, o: 'bb' }) })
  const hops = framesOn(h, 3, VERB.WACK).map((f) => f.value)
  assert.deepEqual(hops, [{ u: 'zz~1', c: 1, n: 1, s: 20, e: 1, o: 'bb' }, { u: 'zz~1', c: 2, n: 1, s: 21, e: 1, l: 'bb' }], 'the lane hops as `o` only where the tap will stay silent; where it will tap, as `l` (wave 5e: the spoke keeps it in case the tap dies)')
  assert.equal(h.of('acked').length, 1, 'a relayed attempt never settles here')
})

//! wave 5e: where an armed relay WILL tap the record, it now names the lane to its spoke as `l` — on BOTH hop sites:
// the owner's WACK (above) and the replicated record clearing the relayed attempt first (the common order: the owner
// flushes its fan-out before its WACK, so the record reaches a co-holder relay first). The hop goes out at once and
// the tap rides the frame's flush behind it, on the same link: that gap is where a link death strands the spoke.
// Red without the inbound site: the hop reads {u, c, n, s, e} with no `l`.
test('wave 5e — an armed relay that folds a relayed record before the owner\'s WACK hops the WACK to its spoke with `l` (the lane), and the tap follows it on the same link', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('ours', 'bb', 'aa')
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, 0, [rec(['ours'], 2)]) })
  assert.equal(framesOn(h, 1, VERB.WRITE).length, 1, 'relayed to the owner bb')
  const before = h.of('send').length
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['ours'], 2), origin: 'bb', seq: 20, epoch: 1, iss: 'zz~1', cid: 1, pp: 0 }], VERB.RECORDS, true)[0] })
  assert.equal(h.node.writes.pending.size, 0, 'replication is the ACK')
  const out = h.of('send').slice(before).filter((e) => e[1] === 3).map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
  assert.deepEqual(out.map((f) => f.verb), [VERB.WACK, VERB.RECORDS], 'the WACK first, the tap behind it')
  assert.deepEqual(out[0].value, { u: 'zz~1', c: 1, n: 1, s: 20, e: 1, l: 'bb' }, 'the hop names the lane the tap will carry')
  //! the owner's own WACK lands after: nothing left to clear, nothing hopped twice
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'zz~1', c: 1, n: 1, s: 20, e: 1, o: 'bb' }) })
  assert.equal(framesOn(h, 3, VERB.WACK).length, 1)
})

//! the third hop site (wave 5e's review): the relayed record lands BELOW a lane tail this relay already holds (a later
// record on the same owner lane, for another row, arrived first), so it is an interior record and folds through
// #splice, not the in-order path. The splice clears the relayed attempt the same way and must name the lane too.
// Red without the #splice site: the hop reads {u, c, n, s, e} with no `l`.
test('wave 5e — an armed relay whose relayed record lands as an interior record (#splice) hops the WACK to its spoke with `l`, and the tap follows it', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('ours', 'bb', 'aa')
  h.node.writes.ring.place('other', 'bb', 'aa')
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, 0, [rec(['ours'], 2)]) })
  assert.equal(framesOn(h, 1, VERB.WRITE).length, 1, 'relayed to the owner bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['other'], 3), origin: 'bb', seq: 30, epoch: 1, pp: 0 }], VERB.RECORDS, true)[0] })
  assert.equal(h.node.writes.pending.size, 1, 'a later record for another row clears nothing')
  const before = h.of('send').length
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['ours'], 2), origin: 'bb', seq: 20, epoch: 1, iss: 'zz~1', cid: 1, pp: 0 }], VERB.RECORDS, true)[0] })
  assert.equal(h.node.writes.pending.size, 0, 'the interior record is the ACK')
  const out = h.of('send').slice(before).filter((e) => e[1] === 3).map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
  assert.deepEqual(out.map((f) => f.verb), [VERB.WACK, VERB.RECORDS], 'the WACK first, the tap behind it')
  assert.deepEqual(out[0].value, { u: 'zz~1', c: 1, n: 1, s: 20, e: 1, l: 'bb' }, 'the splice hop names the lane the tap will carry')
})

//! a commit can enter the owner's dedup window WITHOUT passing #commit: through an ACQ fold (the partition
// moved to this node after the commit) or through WAL replay (the owner restarted). A write re-sent to such
// an owner after a lost WACK is answered from that window, and the answer must still name the lane, or a
// non-holder issuer clears its attempt and never hears `acked` (the stage-1 skeptic's K1: the STATUS bug
// stayed open on exactly the recovery path it was about). Red without the lane at those sites: the dup
// WACK reads `{u, c, n, s, e}` with no `o`.
test('ACKED after a lost WACK — a commit learned by an ACQ fold or by WAL replay answers a re-sent write WITH the lane', () => {
  //! the FOLD leg: aa is assigned px from zero; bb teaches it one record that carries cc~1's attempt identity
  const h = armedView1()
  h.node.writes.ring.place('px', 'bb', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['px', 'a'], 1), origin: 'bb', seq: 5, epoch: 1, iss: 'cc~1', cid: 7, pp: 0 }], VERB.ACQ, true)[0] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 1 }) })
  assert.equal(h.node.scope!.held('px'), true, 'the fold committed')
  assert.deepEqual(h.node.writes.committed('cc~1', 7), { s: 5, e: 1, o: 'bb', p: 'px' }, 'the window names the lane the fold put the record on (and the partition, stage 3)')
  //! cc re-sends cid 7 (its first WACK was lost): answered from the window, with the lane
  h.node.step({ kind: 'bytesIn', link: 2, bytes: writeFrame('cc~1', 7, 1, [rec(['px', 'a'], 1)]) })
  assert.deepEqual(framesOn(h, 2, VERB.WACK).map((f) => f.value), [{ u: 'cc~1', c: 7, n: 1, s: 5, e: 1, o: 'bb' }], 'the dup answer after a fold carries the lane')
  //! the REPLAY leg, armed: a restored owner replays a held row with attempt identity, then meets the re-send
  const r = harness('aa', { replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']], heldPartitions: ['p1'] } })
  r.node.step({ kind: 'replay', bytes: encodeRuns([{ rec: rec(['p1', 'a'], 1), origin: 'bb', seq: 10, epoch: 1, iss: 'cc~1', cid: 3, pp: 0 }], VERB.RECORDS, true)[0], prev: 0 })
  assert.deepEqual(r.node.writes.committed('cc~1', 3), { s: 10, e: 1, o: 'bb', p: 'p1' }, 'replay names the lane (and the partition, stage 3)')
  r.node.step({ kind: 'start' }); r.admit(1, 'bb'); r.admit(2, 'cc')
  r.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  r.node.step({ kind: 'bytesIn', link: 2, bytes: writeFrame('cc~1', 3, 1, [rec(['p1', 'a'], 1)]) })
  assert.deepEqual(framesOn(r, 2, VERB.WACK).map((f) => f.value), [{ u: 'cc~1', c: 3, n: 1, s: 10, e: 1, o: 'bb' }], 'the dup answer after a restart carries the lane')
  //! the REPLAY leg, epoch 0 (a scoped life restored before any view): the window names the lane too
  const z = harness('aa', { replicas: 2 })
  z.node.step({ kind: 'replay', bytes: encodeRuns([{ rec: rec(['p1', 'a'], 1), origin: 'aa', seq: 1, epoch: 0, iss: 'cc~1', cid: 4 }], VERB.RECORDS)[0], prev: 0 })
  assert.deepEqual(z.node.writes.committed('cc~1', 4), { s: 1, e: 0, o: 'aa' })
})

//! the `acked` decision is made once, at the WACK (scope.expects). The stage-1 skeptic's K2/K3: a co-holder
// (acquiring, or assigned with no entry yet) is WACKed silently because the record is expected to fold here —
// then a view change moves the partition off this node before it does. Nothing would ever settle the write:
// no join, no `acked`, and the api's sweep runs only on drops. Now the kernel keeps such cleared attempts
// (write.ts #awaiting) and settles them at the rescope from the WACK's coordinates. Red without rescoped():
// `acked` stays [] after the VIEW; red without the spoke leg: the second WACK clears nothing on the client.
const VIEW2 = encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] })
test('ACKED after a view change — a cleared attempt whose record was expected here settles when the partition moves off before it folds (acquiring, and assigned with no entry); the control folds through the join; a relay re-answers its spoke with the lane', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  //! K3: aa is ACQUIRING px from bb (the owner) when its own write to px is WACKed with the lane
  h.node.writes.ring.place('px', 'bb', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  assert.equal(h.jk(JK.acquireStart).length, 1, 'the latch opened')
  h.node.step({ kind: 'write', recs: [rec(['px', 'mine'], 1)] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 6, e: 1, o: 'bb' }) })
  //! K2: aa is ASSIGNED py (a co-holder) but holds no entry yet; the same WACK shape
  h.node.writes.ring.place('py', 'bb', 'aa')
  h.node.step({ kind: 'write', recs: [rec(['py', 'mine'], 2)] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 2, n: 1, s: 7, e: 1, o: 'bb' }) })
  //! a spoke zz relayed through aa writes px too: aa expects the record, so the hop carries no lane
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: '', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: writeFrame('zz~1', 1, 0, [rec(['px', 'theirs'], 3)]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'zz~1', c: 1, n: 1, s: 8, e: 1, o: 'bb' }) })
  assert.equal(h.node.writes.pending.size, 0, 'all three cleared')
  assert.deepEqual(h.of('acked'), [], 'expected to fold here: every WACK stays silent')
  assert.deepEqual(framesOn(h, 3, VERB.WACK).map((f) => f.value), [{ u: 'zz~1', c: 1, n: 1, s: 8, e: 1, l: 'bb' }], 'the hop carries no `o`: only `l`, the lane to keep while waiting for the tap')
  //! the live record for px arrives mid-latch and is STAGED; then the view moves px and py to bb, cc: the
  // latch aborts (epoch), the staged record drops, py is no longer assigned — neither record will ever fold here
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['px', 'mine'], 1), origin: 'bb', seq: 6, epoch: 1, iss: 'aa~1', cid: 1, pp: 5 }], VERB.RECORDS, true)[0] })
  h.node.writes.ring.place('px', 'bb', 'cc')
  h.node.writes.ring.place('py', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: VIEW2 })
  assert.equal(h.jk(JK.acquireAbort).filter((e) => e.b === 'epoch').length, 1, 'the machine is epoch-scoped')
  assert.equal(h.node.state.size, 0, 'nothing folded')
  assert.deepEqual(h.of('acked'), [['acked', 'aa~1', 1, 'bb', 6, 1], ['acked', 'aa~1', 2, 'bb', 7, 1]], 'both own attempts settle from their WACKs at the view change')
  assert.deepEqual(framesOn(h, 3, VERB.WACK).map((f) => f.value)[1], { u: 'zz~1', c: 1, n: 1, s: 8, e: 1, o: 'bb' }, 'the spoke is answered again, with the lane')
  //! the CONTROL: the same K3 shape where the latch completes instead — the staged record replays and folds,
  // the join is the settlement and `acked` never fires
  const c = armedView1()
  c.node.membership.rejoinFloor = 0
  c.node.writes.ring.place('px', 'bb', 'aa')
  c.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  c.node.step({ kind: 'write', recs: [rec(['px', 'mine'], 1)] })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: 1, n: 1, s: 6, e: 1, o: 'bb' }) })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['px', 'mine'], 1), origin: 'bb', seq: 6, epoch: 1, iss: 'aa~1', cid: 1, pp: 5 }], VERB.RECORDS, true)[0] })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['px', 'a'], 1), pp: 0 }]) })
  c.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 1 }) })
  assert.equal(c.node.state.get(JSON.stringify(['px', 'mine'])), 1, 'the staged record folded after the latch')
  assert.deepEqual(c.of('acked'), [], 'the join settles the control, never acked')
  c.node.writes.ring.place('px', 'bb', 'cc')
  c.node.step({ kind: 'bytesIn', link: 1, bytes: VIEW2 })
  assert.deepEqual(c.of('acked'), [], 'and a later view change has nothing left to settle')
  //! the SPOKE side: a client whose first WACK cleared the attempt reads the second one, with the lane, as `acked`
  const s = harness('cl', { client: true, hosts: ['sim:aa'] })
  s.node.step({ kind: 'start' })
  s.admit(1, 'aa')
  s.node.step({ kind: 'write', recs: [rec(['px', 'theirs'], 3)] })
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 8, e: 1 }) })
  assert.equal(s.node.writes.pending.size, 0)
  assert.deepEqual(s.of('acked'), [], 'the first WACK: cleared, waiting on the tap')
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'cl~1', c: 1, n: 1, s: 8, e: 1, o: 'bb' }) })
  assert.deepEqual(s.of('acked'), [['acked', 'cl~1', 1, 'bb', 8, 1]], 'the second WACK, with the lane, is the settlement')
  s.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'xx~1', c: 1, n: 1, s: 8, e: 1, o: 'bb' }) })
  assert.equal(s.of('acked').length, 1, 'another issuer\'s cid is not ours to settle')
})

test('OWNER RE-CHECK (DESIGN-SCALE §11 Q12) — an armed owner asks NodeOpts.admit about a forwarded remove under a row: refused ⇒ WNACK invalid with the reason; admitted, an update or a row remove ⇒ commits unasked; staged ⇒ withheld; unscoped ⇒ never asked', () => {
  let asked: string[][] = []
  const admit = (r: Rec) => { asked.push(r.key); return r.key[1] === '0' ? 'sparse-hole' : true }
  const h = armedView1({ admit })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('mine', 'aa', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [
    { type: REC.remove, key: ['mine', '0'] }, { type: REC.remove, key: ['mine', '1'] },
    { type: REC.update, key: ['mine', '0'], value: 1 }, { type: REC.remove, key: ['mine'] }]) })
  assert.deepEqual(asked, [['mine', '0'], ['mine', '1']], 'only removes below the row are asked')
  const nacks = framesOn(h, 1, VERB.WNACK).map((f) => f.value)
  assert.deepEqual(nacks, [{ u: 'bb~1', c: 5, n: 1, r: 'invalid', m: 'sparse-hole', ce: 1 }], 'the refused one: invalid, with the reason, never stamped')
  assert.deepEqual(framesOn(h, 1, VERB.WACK).map((f) => (f.value as { c: number; n: number }).c), [6], 'the other three committed as one run')
  assert.equal(h.node.logs.get('aa')!.length, 3, 'no tombstone for the hole')
  //! a STAGED partition (an open latch) cannot read its shape: withheld, not refused
  h.node.writes.ring.place('px', 'aa', 'bb')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  assert.equal(h.jk(JK.acquireStart).length, 1, 'the latch opened')
  asked = []
  h.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 9, 1, [{ type: REC.remove, key: ['px', '0'] }]) })
  assert.deepEqual(asked, [], 'not asked while staged')
  assert.deepEqual(framesOn(h, 1, VERB.WNACK).map((f) => f.value).at(-1), { u: 'bb~1', c: 9, n: 1, r: 'withheld', ce: 1 })
  //! the UNSCOPED control: the hook is never consulted; the forwarded remove commits as before
  const u = harness('aa', { admit, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } })
  u.node.step({ kind: 'start' }); u.admit(1, 'bb'); u.admit(2, 'cc')
  u.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  u.node.membership.rejoinFloor = 0
  u.node.writes.ring.place('mine', 'aa')
  asked = []
  u.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('bb~1', 5, 1, [{ type: REC.remove, key: ['mine', '0'] }]) })
  assert.deepEqual(asked, [])
  assert.equal(framesOn(u, 1, VERB.WACK).length, 1, 'committed unasked')
})

//! RETIRED 2026-10-10 (DESIGN-SCALE stage 2): 'AE FILTER — a digest answer ships a member only the partitions ITS
// R-set covers'. The ring-filtered suffix to a member is gone: on a scoped cluster a member learns history only
// through the one-teacher latch (a suffix from a ring-filtered walk was the second teacher the H3 resurrection needs
// once compaction runs). The three tests below pin what replaced it.

//! recordsOn — the partitions of every RECORDS frame this node shipped on `link` after `from` sends, in order
const recordsOn = (h: ReturnType<typeof harness>, link: number, from = 0): string[] => {
  const out: string[] = []
  for (const f of h.of('send').filter((e) => e[1] === link).slice(from).map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === VERB.RECORDS))
    for (const rv of f.records()) out.push((rv.rec() as Rec).key[0])
  return out
}

test('NO MEMBER DIGEST (DESIGN-SCALE stage 2) — an armed node\'s heartbeat PINGs its member links and floors none of them; a client link still gets its digest; the unscoped control floors every member', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  //! a client (HELLO r:1) with a uuid above aa's: aa is the lower side of that pair, the side that floors it
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  const before = h.of('send').length
  h.tick()
  const sent = h.of('send').slice(before).map((e) => [e[1] as number, new Framer().push((e[2] as Uint8Array).slice())[0]?.verb] as [number, number])
  assert.deepEqual(sent.filter(([, v]) => v === VERB.PING).map(([l]) => l).sort(), [1, 2, 3], 'PING to every admitted link (liveness is membership\'s)')
  assert.deepEqual(sent.filter(([, v]) => v === VERB.DIGEST).map(([l]) => l), [3], 'a DIGEST to the client only — no member floor on a scoped cluster')
  //! the unscoped control: the same tick floors both members (the digest law, sim/scale.perf.ts)
  const u = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  u.node.step({ kind: 'start' })
  u.admit(1, 'bb'); u.admit(2, 'cc')
  const ub = u.of('send').length
  u.tick()
  const usent = u.of('send').slice(ub).map((e) => [e[1] as number, new Framer().push((e[2] as Uint8Array).slice())[0]?.verb] as [number, number])
  assert.deepEqual(usent.filter(([, v]) => v === VERB.DIGEST).map(([l]) => l).sort(), [1, 2], 'unscoped: a DIGEST to every member — byte-identical with before')
})

test('CLIENT DIGESTS UNCHANGED (DESIGN-SCALE stage 2) — a spoke\'s r=1 digest at an armed server still ships the HELD subset (never an orphan\'s frozen copy) and gets its r=0 reply with the gate', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('held', 'aa', 'bb')
  h.node.writes.ring.place('gone', 'aa', 'cc')
  h.node.step({ kind: 'write', recs: [rec(['held', 'x'], 1), rec(['gone', 'x'], 2)] })
  //! the R-set of `gone` moves off aa: a frozen orphan — a teacher for holders, never a spoke feed
  h.node.writes.ring.place('gone', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.jk(JK.orphaned).length, 1)
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  const from = h.of('send').filter((e) => e[1] === 3).length
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  assert.deepEqual(recordsOn(h, 3, from), ['held'], 'the held subset ships; the orphan does not')
  assert.equal(h.jk(JK.aeShip).length, 1, 'journaled as an AE ship, as before')
  const reply = sentOn(h, 3, VERB.DIGEST).pop()!.value as { d: Record<string, number>; r: number; w?: number }
  assert.deepEqual(reply, { d: { aa: 2 }, r: 0, w: 1 }, 'the r=0 reply with the lane tails and the gate (I-33)')
})

test('ADMIT SHIPS NOTHING TO A MEMBER (DESIGN-SCALE stage 2) — a member\'s r=1 digest at an armed node syncs the link and gets its r=0 reply, but no RECORDS; the admit round then offers what the two share, and the peer\'s need is taught through the latch', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('shared', 'aa', 'bb')
  h.node.writes.ring.place('private', 'aa', 'cc')
  h.node.step({ kind: 'write', recs: [rec(['shared', 'x'], 1)] })
  h.node.step({ kind: 'write', recs: [rec(['private', 'x'], 2)] })
  //! bb's link dies and comes back: HELLO (the admit round fires here), then bb's r=1 digest with empty tails
  h.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  h.node.step({ kind: 'linkUp', link: 3, dialed: true, to: 'sim:bb' })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
  const link = h.node.links.get(3)!
  assert.equal(link.synced, false, 'not synced until bb\'s digest lands')
  assert.deepEqual(haveqs(h, 3).map((v) => v.q), [{ shared: { aa: 1 } }], 'the admit round: the one shared partition, to bb alone')
  const from = h.of('send').filter((e) => e[1] === 3).length
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1 }) })
  assert.deepEqual(recordsOn(h, 3, from), [], 'the admit answer ships NOTHING to a member — history reaches a member only through the latch')
  assert.equal(h.jk(JK.aeShip).length, 0)
  assert.equal(link.synced, true, 'the digest still syncs the link: live records flow from here')
  assert.deepEqual(sentOn(h, 3, VERB.DIGEST).map((f) => (f.value as { r: number }).r), [1, 0], 'aa\'s own admit opener (aa < bb), then the r=0 reply that answers bb\'s r=1 (one exchange, never a loop)')
  //! the round repairs it: bb answers need for `shared` (it has nothing) — aa teaches it through the latch
  h.node.step({ kind: 'bytesIn', link: 3, bytes: havea(1, { shared: { ok: 0, need: 1, m: {} } }) })
  const acq = sentOn(h, 3, VERB.ACQ)
  assert.equal(acq.length, 1, 'one ACQ transfer')
  assert.deepEqual([...acq[0].records()].map((rv) => (rv.rec() as Rec).key[0]), ['shared'], 'exactly the shared partition')
  assert.deepEqual(sentOn(h, 3, VERB.ACQDONE).map((f) => (f.value as { p: string; n: number }).p), ['shared'], 'with its attested cut')
  assert.equal(h.jk(JK.teachShip).length, 1)
})

test('DRAIN ROUND (DESIGN-SCALE stage 2) — a paused member link is skipped by every announcement; its drain brings one scoped round to that peer for what the two share (its queue dropped or not), beside the re-sync digest when it did drop', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('shared', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [rec(['shared', 'x'], 1)] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { shared: { ok: 1, need: 0, m: { aa: 1 } } }) })
  h.tick()
  const q0 = haveqs(h, 1).length
  h.node.step({ kind: 'pause', link: 1 })
  h.node.step({ kind: 'write', recs: [rec(['shared', 'y'], 2)] })
  h.tick()
  assert.equal(haveqs(h, 1).length, q0, 'paused: the dirty announcement for bb was skipped, not queued')
  assert.deepEqual(h.node.links.get(1)!.queued.map((b) => new Framer().push(b.slice())[0]?.verb), [VERB.RECORDS], 'the live fan-out queues as always; no HAVEQ sits in the drop-oldest queue')
  //! the drain (no drop): one scoped round to bb — the announcement it missed
  const d0 = sentOn(h, 1, VERB.DIGEST).length // aa's admit opener (aa < bb) is already there
  h.node.step({ kind: 'drain', link: 1 })
  assert.deepEqual(haveqs(h, 1).slice(q0).map((v) => v.q), [{ shared: { aa: 2 } }], 'the drain round carries the floor bb missed')
  assert.equal(sentOn(h, 1, VERB.DIGEST).length, d0, 'no digest: the queue never dropped')
  //! a drain AFTER a drop: the re-sync digest (ships nothing to a member) and the round
  h.node.step({ kind: 'pause', link: 1 })
  const link = h.node.links.get(1)!
  link.droppedWhilePaused = true; link.synced = false // what an overflow does (kernel/link.ts ship)
  const q1 = haveqs(h, 1).length, d1 = sentOn(h, 1, VERB.DIGEST).length
  h.node.step({ kind: 'drain', link: 1 })
  assert.equal(sentOn(h, 1, VERB.DIGEST).length - d1, 1, 'the re-sync digest (r=1) follows a drop')
  assert.equal(haveqs(h, 1).length - q1, 1, 'and the round')
  assert.equal(h.jk(JK.aeShip).length, 0, 'no suffix was ever shipped to bb (its RECORDS are the live fan-out): a member is repaired by the latch, never by a digest')
})

//! ── slice 3b: the one-teacher latch — every leg driven deterministically ──

const haveq = (e: number, q: Record<string, Record<string, number>>) => encodeControl(VERB.HAVEQ, { e, q })
const havea = (e: number, a: Record<string, { ok: number; need: number; m?: Record<string, number>; md?: Record<string, number> }>) => encodeControl(VERB.HAVEA, { e, a })
const acqFrame = (origin: string, rows: { seq: number; rec: Rec; pp?: number }[], epoch = 1): Uint8Array => {
  const withPp = rows.some((r) => r.pp !== undefined)
  const out = encodeRuns(rows.map((r) => ({ rec: r.rec, origin, seq: r.seq, epoch, pp: r.pp })), VERB.ACQ, withPp)
  assert.equal(out.length, 1)
  return out[0]
}

test('ACQUISITION — a co-holder\'s HAVEQ announce latches the from-zero assignee: need → ACQ → ACQDONE folds atomically; staged live replays above the cut, below-cut discards', () => {
  const h = armedView1()
  h.node.writes.ring.place('px', 'bb', 'aa')
  //! bb announces px (floors: lane bb up to 5) — aa is assigned but has nothing: latch + need
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  assert.equal(h.jk(JK.acquireStart).length, 1, 'the latch opened')
  const needFrames = h.of('send').filter((e) => e[1] === 1)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === VERB.HAVEA)
  assert.equal(needFrames.length, 1)
  assert.deepEqual((needFrames[0].value as { a: Record<string, unknown> }).a.px, { ok: 0, need: 1, m: {} }, 'from-zero: empty marks')
  //! live records for px arrive MID-LATCH: staged, nothing folds (the §0 law row 2)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 4, rec: rec(['px', 'stale'], 'covered'), pp: 3 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 6, rec: rec(['px', 'fresh'], 'live'), pp: 5 }]) })
  assert.equal(h.node.state.size, 0, 'nothing folds during the latch')
  assert.equal(h.node.streams.get('bb')?.applied ?? 0, 0, 'the fence is untouched during the latch')
  //! the teacher's transfer + DONE: the fold is ONE synchronous step
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 3, rec: rec(['px', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['px', 'b'], 2), pp: 3 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 2 }) })
  assert.equal(h.jk(JK.acquire).length, 1, 'the fold committed')
  assert.equal(h.node.scope!.held('px'), true)
  assert.equal(h.node.state.get(JSON.stringify(['px', 'a'])), 1)
  assert.equal(h.node.state.get(JSON.stringify(['px', 'b'])), 2)
  const d = h.node.streams.get('bb')!
  assert.equal(d.parts!.get('px')!.s, 6, 'floors: cut (5) then the replayed live 6')
  assert.equal(h.node.state.get(JSON.stringify(['px', 'fresh'])), 'live', 'staged live ABOVE the cut replayed through the normal ingest')
  assert.equal(h.node.state.has(JSON.stringify(['px', 'stale'])), false, 'staged live ≤ cut DISCARDED — its effect is in the fold or was lawfully compacted (the completeness floor)')
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [3, 5, 6], 'the lane: teacher records at their seqs + the live tail')
})

//! wave 6a (2026-10-12): the fold's SPOKE FORWARD (kernel/scope.ts onAcqDone). A feeder used to fold the teacher's
// records through node.apply alone, so a spoke never heard them; its floor exchange ships only what is above its own
// tail per lane, so once a later record had been tapped live the latch's rows were below the tail for good (STATUS,
// two sightings; sim/scale-probes.test.ts pins both). Red on the base at "the synced spoke heard the fold" (got []).
test('ACQUISITION forwards to spokes — the teacher records the fold takes in reach a SYNCED client link in one flush, attempt identity intact, with the replayed live span behind them; an UNSYNCED client link hears nothing and its first answer brings them; a record already in the lane is not re-sent', () => {
  const h = armedView1()
  h.node.writes.ring.place('px', 'bb', 'aa')
  const spoke = (link: number, u: string, sync: boolean) => {
    h.node.step({ kind: 'linkUp', link, dialed: false })
    h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}`, r: 1 }) })
    if (sync) h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  }
  spoke(3, 'zz', true)
  spoke(4, 'zy', false)
  const sent = (link: number) => h.of('send').filter((e) => e[1] === link)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === VERB.RECORDS)
    .flatMap((f) => [...f.records()].map((r) => ({ origin: r.origin, seq: r.seq, iss: r.issuer, cid: r.cid })))
  assert.deepEqual(sent(3), [], 'nothing shipped yet: aa holds nothing of px')
  //! the latch opens; a live record for px stages (nothing folds, nothing is forwarded)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 6, rec: rec(['px', 'fresh'], 'live'), pp: 5 }]) })
  assert.deepEqual(sent(3), [], 'a staged live record is not forwarded: nothing has folded')
  //! the teacher's transfer: seq 3 carries an attempt identity (a client's write the owner committed), seq 5 none
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: rec(['px', 'a'], 1), origin: 'bb', seq: 3, epoch: 1, iss: 'cli~1', cid: 7, pp: 0 }], VERB.ACQ, true)[0] })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['px', 'b'], 2), pp: 3 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 2 }) })
  assert.equal(h.jk(JK.acquire).length, 1, 'the fold committed')
  assert.deepEqual(sent(3), [{ origin: 'bb', seq: 3, iss: 'cli~1', cid: 7 }, { origin: 'bb', seq: 5, iss: '', cid: 0 }, { origin: 'bb', seq: 6, iss: '', cid: 0 }],
    'the synced spoke heard the fold: the two teacher records (attempt identity intact — the spoke\'s write-route join reads it) and the replayed live record behind them, in this step')
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [3, 5, 6], 'the records are in the lane the forward was sent from (the feeder committed them first: V4-7)')
  assert.deepEqual(sent(4), [], 'the unsynced spoke heard nothing')
  //! the unsynced spoke's first ask brings them: its digest answer ships the held subset
  h.node.step({ kind: 'bytesIn', link: 4, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  assert.deepEqual(sent(4).map((r) => r.seq), [3, 5, 6], 'the answer that syncs the link covers what the fold took in')
  //! a second latch whose teacher re-ships a record the lane already holds forwards nothing for it (not re-sent)
  const before = sent(3).length
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { px: { bb: 7 } }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['px', 'b'], 2), pp: 3 }]) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('bb', [{ seq: 7, rec: rec(['px', 'c'], 3), pp: 6 }]) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 7 }, n: 2 }) })
  assert.equal(h.jk(JK.acquire).length, 2, 'the second fold committed')
  assert.deepEqual(sent(3).slice(before).map((r) => r.seq), [7], 'only the record the lane lacked was forwarded; seq 5 was already there')
})

//! the review of wave 6a (2026-10-12): the two legs of the forward at the frame level. A latch from a HELD base (a
// repair) forwards the delta — the base is at every synced spoke already, because a client's digest answer ships every
// partition the node FEEDS (Scope.feeds: held, or acquiring from a held base or from nothing), so a spoke that syncs
// mid-repair gets the base from the answer. A latch that RE-ENTERS from an orphan forwards the WHOLE partition: an orphan
// is no spoke feed, a spoke synced since the freeze has nothing of it, and one synced before holds the frozen rows and
// drops the copies. kernel/client.test.ts drives the same two legs end to end with a real spoke.
test('ACQUISITION forwards to spokes — the two legs: a spoke that syncs while px is under REPAIR is answered its base and hears the delta at the fold; a spoke synced all along hears the WHOLE of px when it re-enters from an orphan', () => {
  const h = armedView1()
  h.node.writes.ring.place('px', 'bb', 'aa')
  const spoke = (link: number, u: string) => {
    h.node.step({ kind: 'linkUp', link, dialed: false })
    h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `sim:${u}`, r: 1 }) })
  }
  const sync = (link: number) => h.node.step({ kind: 'bytesIn', link, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  const sent = (link: number) => h.of('send').filter((e) => e[1] === link)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === VERB.RECORDS)
    .flatMap((f) => [...f.records()].map((r) => r.seq))
  spoke(3, 'zz'); sync(3)
  spoke(4, 'zy')
  //! px held at aa: bb#3, bb#5 — tapped live to the synced spoke zz
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 3, rec: rec(['px', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 5, rec: rec(['px', 'b'], 2), pp: 3 }]) })
  assert.deepEqual(sent(3), [3, 5])
  //! the repair: cc announces bb at 7, aa re-latches; zy syncs NOW and is answered the base (held() would have skipped it)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { px: { bb: 7 } }) })
  assert.equal(h.node.scope!.held('px'), false)
  assert.equal(h.node.scope!.feeds('px'), true)
  sync(4)
  assert.deepEqual(sent(4), [3, 5], 'the answer shipped the base of the partition under repair')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('bb', [{ seq: 7, rec: rec(['px', 'c'], 3), pp: 5 }]) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 7 }, n: 1 }) })
  assert.equal(h.jk(JK.acquire).length, 1)
  assert.deepEqual(sent(3), [3, 5, 7], 'the delta to the spoke synced all along')
  assert.deepEqual(sent(4), [3, 5, 7], 'the delta to the spoke synced mid-repair: the base came with its answer')
  //! the freeze: epoch 2 moves px off aa (an orphan); then epoch 3 gives it back, and cc's announce re-enters it
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  if (h.node.scope!.entries.get('px')?.state !== SCOPE.orphan) {
    //! the ring's hash may still place px on aa at two members: force the freeze the way rescope does, by assignment
    h.node.writes.ring.place('px', 'bb', 'cc')
    h.node.scope!.rescope(h.node)
  }
  assert.equal(h.node.scope!.entries.get('px')!.state, SCOPE.orphan, 'px froze into an orphan at aa')
  assert.equal(h.node.scope!.feeds('px'), false)
  h.node.writes.ring.place('px', 'bb', 'aa')
  const before = { zz: sent(3).length, zy: sent(4).length }
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(h.node.epoch, { px: { bb: 9 } }) })
  assert.equal(h.node.scope!.entries.get('px')!.state, SCOPE.acquiring, 'the re-entry latch')
  assert.equal(h.node.scope!.feeds('px'), false, 'not fed until its fold')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('bb', [{ seq: 9, rec: rec(['px', 'd'], 4), pp: 7 }], h.node.epoch) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: h.node.epoch, t: { bb: 9 }, n: 1 }) })
  assert.equal(h.jk(JK.acquire).length, 2, 'the re-entry fold')
  assert.deepEqual(sent(3).slice(before.zz), [3, 5, 7, 9], 'the WHOLE of px to a spoke synced all along (it drops the three it holds)')
  assert.deepEqual(sent(4).slice(before.zy), [3, 5, 7, 9], 'and to the other')
})

//! THE LANE RULE (wave 6b, 2026-10-12; the wave-6a review's probe): a lane holds each (origin, seq) ONCE, and the scalar
// fence (streams.applied) never sits below the lane's tail. A teacher ships every entry of p it holds, its own floor as
// the cut — so an entry above its floor (a gapped chain there) arrives above the cut. The fold used to raise the fence
// only to the cut, and the fast path appends at the tail on `seq > applied` alone (write.ts inbound), so the same record
// staged live during the latch was appended again by the live replay (lane bb at aa read [3, 5, 7, 7]; the forward
// shipped it twice and the spoke dropped the copy), a later re-ship of it was appended a third time, and a record
// between the cut and it landed out of order. Now the fence rises to the top of what the teacher shipped on each lane;
// the floor stays at the cut (the fold trusts the cut, never the chain). Red on the base at "the lane holds 7 once"
// (actual [3, 5, 7, 7]).
test('THE LANE RULE — a teacher record above the cut that also staged live is in the lane once: the replay drops it on the dual fence, the spoke hears it once, a later re-ship drops, a record between the cut and it splices in order; the fence is at the lane\'s tail', () => {
  const h = armedView1()
  h.node.writes.ring.place('px', 'bb', 'aa')
  h.node.writes.ring.place('py', 'bb', 'aa')
  h.node.step({ kind: 'linkUp', link: 3, dialed: false })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.HELLO, { u: 'zz', i: 1, l: 'sim:zz', r: 1 }) })
  h.node.step({ kind: 'bytesIn', link: 3, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 1, q: 1 }) })
  const sent = () => h.of('send').filter((e) => e[1] === 3)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === VERB.RECORDS)
    .flatMap((f) => [...f.records()].map((r) => r.seq))
  const lane = () => h.node.logs.get('bb')!.map((e) => e.seq)
  //! the latch opens on bb's announce (its floor for px on lane bb is 5); bb#7 (px.c, chained to 5) arrives LIVE mid-latch: staged
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 7, rec: rec(['px', 'c'], 3), pp: 5 }]) })
  assert.equal(h.node.state.size, 0, 'nothing folds during the latch')
  //! the teacher holds bb#7 too, above its own floor (its chain to 7 is gapped: a lost frame it has not repaired yet), and
  // ships everything it holds of px with its floor as the cut: 3, 5 and 7, cut bb: 5
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 3, rec: rec(['px', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['px', 'b'], 2), pp: 3 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 7, rec: rec(['px', 'c'], 3), pp: 5 }]) })
  const dups = h.jk(JK.dupDrop).length
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 3 }) })
  assert.equal(h.jk(JK.acquire).length, 1, 'the fold committed')
  assert.deepEqual(lane(), [3, 5, 7], 'the lane holds 7 once: the fold spliced it, the live replay dropped its copy')
  assert.equal(h.jk(JK.dupDrop).length, dups + 1, 'the replayed copy went through the dual fence and dropped as present in the lane')
  assert.deepEqual(sent(), [3, 5, 7], 'the spoke heard each record once (the forward, V4-53)')
  const d = h.node.streams.get('bb')!
  assert.equal(d.applied, 7, 'the fence is at the lane\'s tail, above the cut')
  assert.equal(d.parts!.get('px')!.s, 5, 'the floor is the cut: the fold attests what the teacher attested, never the chain')
  assert.equal(h.node.state.get(JSON.stringify(['px', 'c'])), 3)
  //! a later re-ship of bb#7 (an AE-shaped repeat) drops; bb#6, a record of py between the cut and the tail, splices at its seq
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 7, rec: rec(['px', 'c'], 3), pp: 5 }]) })
  assert.deepEqual(lane(), [3, 5, 7], 'a re-ship of a record above the cut drops on lane presence')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 6, rec: rec(['py', 'a'], 6), pp: 0 }]) })
  assert.deepEqual(lane(), [3, 5, 6, 7], 'a record between the cut and the tail lands at its seq position, the lane ascending')
  assert.equal(d.parts!.get('py')!.s, 6, 'py\'s floor chains from 0 at the splice')
  assert.deepEqual(sent(), [3, 5, 7, 6], 'the spoke heard the interior record once, the re-ship never')
  assert.equal(d.applied, 7, 'the fence never regresses')
})

test('ACQUISITION aborts — torn count, foreign ACQ, teacher death, epoch flip, tick timeout: the buffer drops whole, nothing folds', () => {
  //! torn: DONE's n disagrees with the staged teacher count
  const t1 = armedView1()
  t1.node.writes.ring.place('px', 'bb', 'aa')
  t1.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  t1.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 3, rec: rec(['px', 'a'], 1) }]) })
  t1.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { bb: 5 }, n: 2 }) })
  assert.equal(t1.jk(JK.acquireAbort).filter((e) => e.b === 'torn').length, 1)
  assert.equal(t1.node.state.size, 0, 'nothing folded')
  assert.equal(t1.node.scope!.entries.get('px'), undefined, 'no residue ⇒ the entry drops to out (re-offered next round)')
  //! foreign ACQ: only the latched teacher's frames stage
  const t2 = armedView1()
  t2.node.writes.ring.place('px', 'bb', 'aa')
  t2.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  t2.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('cc', [{ seq: 9, rec: rec(['px', 'x'], 9) }]) })
  assert.equal(t2.jk(JK.stageDrop).length, 1, 'a second teacher\'s transfer drops (one teacher per attempt)')
  //! teacher death aborts; epoch flip aborts
  t2.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  assert.equal(t2.jk(JK.acquireAbort).filter((e) => e.b === 'linkDown').length, 1)
  const t3 = armedView1()
  t3.node.writes.ring.place('px', 'bb', 'aa')
  t3.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  t3.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(t3.jk(JK.acquireAbort).filter((e) => e.b === 'epoch').length, 1, 'the machine is epoch-scoped')
  //! tick timeout: STAGE_TICKS heartbeats without DONE re-offers by abort
  const t4 = armedView1()
  t4.node.writes.ring.place('px', 'bb', 'aa')
  t4.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { px: { bb: 5 } }) })
  for (let i = 0; i < 9; i++) t4.tick()
  assert.equal(t4.jk(JK.acquireAbort).filter((e) => e.b === 'timeout').length, 1)
})

//! found by the scoped sweep when the member digest retired (DESIGN-SCALE stage 2; A2 seed 9 at FERO_SCOPED_SEEDS=12):
// two holders of one partition, each ahead on a DIFFERENT lane (an owner change leaves exactly this shape), each
// latch the other on the other's announcement. Before, an acquiring node refused to teach ("mid-latch ourselves"),
// so both timed out, aborted to orphan on their residue, re-latched at the next round and cycled for ever — the
// admit digest's lane suffixes used to paper over it. Now a node teaches its pre-latch base with its floors as the
// cut, so both teach and both fold.
test('MUTUAL LATCH — two holders each behind the other on a different lane of p latch each other; the acquiring node still teaches its pre-latch base, so both fold and both hold both lanes (no deadlock, no orphan cycle)', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] }) // aa's own lane: aa@1
  //! bb announces p on ITS lane (bb:1), which aa lacks: aa is behind → latches bb, answers need with its own floors
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { p: { bb: 1 } }) })
  assert.equal(h.node.scope!.entries.get('p')!.state, SCOPE.acquiring)
  assert.equal(h.node.scope!.entries.get('p')!.teacher, 'bb')
  const need = sentOn(h, 1, VERB.HAVEA).pop()!.value as { a: Record<string, { ok: number; need: number; m: Record<string, number> }> }
  assert.deepEqual(need.a.p, { ok: 0, need: 1, m: { aa: 1 } }, 'aa asks bb to teach it lane bb, above its own marks')
  //! bb was behind on lane aa the same way and latched aa: its need arrives while aa is mid-latch — aa teaches anyway
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p: { ok: 0, need: 1, m: { bb: 1 } } }) })
  const acq = sentOn(h, 1, VERB.ACQ)
  assert.equal(acq.length, 1, 'the acquiring node taught its pre-latch base (it used to refuse: the deadlock)')
  assert.deepEqual([...acq[0].records()].map((rv) => [rv.origin, rv.seq]), [['aa', 1]])
  //! `w` (stage 3): the teacher's dedup-window tuples for p — aa's own write was attempt (aa~1, cid 1), committed at aa@1
  assert.deepEqual(sentOn(h, 1, VERB.ACQDONE).map((f) => f.value), [{ p: 'p', e: 1, t: { aa: 1 }, n: 1, w: [['aa~1', 1, 1, 1, 'aa']] }], 'with its own floors as the cut: a sound claim whatever its latch state')
  assert.equal(h.node.scope!.entries.get('p')!.state, SCOPE.acquiring, 'and its own latch is untouched')
  //! bb's transfer lands: aa folds, holds both lanes, and its post-fold round announces both floors to bb
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 1, rec: rec(['p', 'y'], 2), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'p', e: 1, t: { bb: 1 }, n: 1 }) })
  assert.equal(h.node.scope!.held('p'), true)
  assert.equal(h.jk(JK.acquireAbort).length, 0, 'no timeout, no abort, no orphan cycle')
  assert.deepEqual([h.node.streams.get('aa')!.parts!.get('p')!.s, h.node.streams.get('bb')!.parts!.get('p')!.s], [1, 1], 'both lanes floored')
  assert.deepEqual([...h.node.state.keys()].sort(), [JSON.stringify(['p', 'x']), JSON.stringify(['p', 'y'])])
  assert.deepEqual(haveqs(h, 1).pop()!.q, { p: { aa: 1, bb: 1 } }, 'the post-fold round carries both floors to bb')
})

test('SHED — the stateless predicate: HAVEA attestations from EVERY current holder over every frozen lane release the data; a partial answer does not', () => {
  const h = armedView1()
  h.node.writes.ring.place('p', 'bb', 'aa')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1) }]) })
  //! the R-set moves to {bb, cc}: aa freezes into an orphan
  h.node.writes.ring.place('p', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.jk(JK.orphaned).length, 1)
  //! bb attests coverage — HALF the R-set: the predicate must NOT fire (every CURRENT holder, always)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }) })
  assert.equal(h.jk(JK.shed).length, 0, 'one of two holders is not coverage')
  assert.equal(h.node.state.get(JSON.stringify(['p', 'x'])), 1)
  //! cc attests too — the predicate fires: data, floors, lanes, entry all leave
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }) })
  assert.equal(h.jk(JK.shed).length, 1, 'every current holder covered ⇒ shed')
  assert.equal(h.node.state.has(JSON.stringify(['p', 'x'])), false)
  assert.equal(h.node.scope!.entries.get('p'), undefined)
  assert.equal(h.node.logs.get('bb')!.some((e) => e.rec.key[0] === 'p'), false, 'the lane filtered')
  assert.equal(h.node.streams.get('bb')!.parts?.get('p'), undefined, 'floors dropped')
  assert.equal(h.node.versions.has(JSON.stringify(['p', 'x'])), false, 'stamps dropped')
  //! DESIGN-SCALE stage 2: the release rides to p's CURRENT holders as HAVEQ `x`, in the shed step — one frame per holder
  for (const link of [1, 2]) {
    const xs = sentOn(h, link, VERB.HAVEQ).map((f) => f.value as { e: number; q: Record<string, unknown>; x?: string[] }).filter((v) => v.x !== undefined)
    assert.deepEqual(xs, [{ e: 2, q: {}, x: ['p'] }], `link ${link}: the holder is told p was released here`)
  }
})

//! sentOn — every frame of one verb this node shipped on `link`, decoded, in order
const sentOn = (h: ReturnType<typeof harness>, link: number, verb: number) =>
  h.of('send').filter((e) => e[1] === link).map((e) => new Framer().push((e[2] as Uint8Array).slice())[0]).filter((f) => f && f.verb === verb)

//! ── DESIGN-SCALE stage 2: the optional HAVEQ keys d/g/x and the HAVEA keys g/x (no MAGIC bump, V4-14) ──

test('STAGE 2 KEYS — HAVEQ `x` voids the sender\'s marks for p; a HAVEA `x: 1` (none) voids a stale pin; a HAVEQ about a partition aa neither holds nor is assigned answers `x: 1` where it used to be silent', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] })
  //! bb attests p (its HAVEQ feeds marks and marksD here), then announces it RELEASED p: every mark it fed is void
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { p: { aa: 1 } }, d: { p: { aa: 1 } }, g: ['p'] }) })
  const e = h.node.scope!.entries.get('p')!
  assert.deepEqual([...e.marks.get('bb')!], [['aa', 1]], 'bb\'s marks fed')
  assert.deepEqual([...e.marksD.get('bb')!], [['aa', 1]], 'bb\'s durable marks fed from the HAVEQ `d` map (not only from a HAVEA md)')
  assert.equal(e.gl.has('bb'), true, 'bb said it is gapless for p')
  //! the bit is last-value on the HAVEQ leg too (the review of stage 2: this clearing had no test): an attestation
  // WITHOUT g clears it, the next one with g sets it again, and a pure probe ({}: no attestation) leaves it alone
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { p: { aa: 1 } } }) })
  assert.equal(e.gl.has('bb'), false, 'an announcement without g: bb is no longer gapless for p')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { p: { aa: 1 } }, g: ['p'] }) })
  assert.equal(e.gl.has('bb'), true, 'and the next one with g sets it again')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { p: {} } }) })
  assert.equal(e.gl.has('bb'), true, 'a pure probe says nothing about content: the bit stands')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: {}, x: ['p'] }) })
  assert.equal(e.marks.has('bb'), false, 'released: bb\'s marks are void')
  assert.equal(e.marksD.has('bb'), false)
  assert.equal(e.gl.has('bb'), false)
  assert.equal(sentOn(h, 1, VERB.HAVEA).length, 4, 'a release frame with an empty q gets no answer (the four attestations did)')
  //! cc's ok answer feeds a mark, then cc answers `none` for p: a stale pin, cleared
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 1 }, g: 1 } }) })
  assert.deepEqual([...e.marks.get('cc')!], [['aa', 1]])
  assert.equal(e.gl.has('cc'), true)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 1 } } }) })
  assert.equal(e.gl.has('cc'), false, 'last-value on the HAVEA leg too: an ok without g clears it')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 1 }, g: 1 } }) })
  assert.equal(e.gl.has('cc'), true)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEA, { e: 1, a: { p: { ok: 0, need: 0, x: 1 } } }) })
  assert.equal(e.marks.has('cc'), false, 'none: cc neither holds nor is assigned p — its pin here was stale')
  assert.equal(e.gl.has('cc'), false)
  //! asked about a partition this node neither holds nor is assigned: `x: 1`, not silence
  h.node.writes.ring.place('zz', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { zz: { bb: 3 } }) })
  const last = sentOn(h, 1, VERB.HAVEA).pop()!.value as { a: Record<string, unknown> }
  assert.deepEqual(last.a.zz, { ok: 0, need: 0, x: 1 }, 'none: the asker learns its pin on aa for zz is stale')
  assert.equal(h.node.scope!.entries.has('zz'), false, 'and nothing was minted or latched')
})

test('STAGE 2 KEYS — an ok answer carries `g: 1` exactly when the content tail equals the floor on every lane of p; `d` rides a durable node\'s answers and announcements; a skewed frame with d/g/x is dropped whole', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p', 'bb', 'aa')
  //! lane bb: seq 1 chained (floor 1), then seq 3 with an unknown predecessor — folds, the floor waits: NOT gapless
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 1, rec: rec(['p', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 3, rec: rec(['p', 'c'], 3), pp: 2 }]) })
  assert.equal(h.node.streams.get('bb')!.parts!.get('p')!.s, 1, 'the floor stopped at the gap')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { p: { bb: 1 } }) })
  let ans = (sentOn(h, 2, VERB.HAVEA).pop()!.value as { a: Record<string, { ok: number; g?: number }> }).a.p
  assert.equal(ans.ok, 1)
  assert.equal(ans.g, undefined, 'content (3) runs past the floor (1): not gapless')
  //! the gap fills: the chain walk trues the floor to 3 — gapless now
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 2, rec: rec(['p', 'b'], 2), pp: 1 }]) })
  assert.equal(h.node.streams.get('bb')!.parts!.get('p')!.s, 3)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { p: { bb: 3 } }) })
  ans = (sentOn(h, 2, VERB.HAVEA).pop()!.value as { a: Record<string, { ok: number; g?: number }> }).a.p
  assert.deepEqual(ans, { ok: 1, need: 0, m: { bb: 3 }, g: 1 }, 'gapless: tail 3 = floor 3 on the one lane of p')
  //! a skewed frame (another epoch) is dropped whole: no mark fed, no pin voided, no answer
  const e = h.node.scope!.entries.get('p')!
  const before = sentOn(h, 2, VERB.HAVEA).length
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.HAVEQ, { e: 2, q: { p: { bb: 9 } }, d: { p: { bb: 9 } }, g: ['p'], x: ['p'] }) })
  assert.deepEqual([...e.marks.get('cc')!], [['bb', 3]], 'the skewed frame fed nothing (cc\'s mark is still its lawful 3)')
  assert.equal(e.marksD.has('cc'), false)
  assert.equal(sentOn(h, 2, VERB.HAVEA).length, before, 'and got no answer')
  assert.equal(h.jk(JK.frameDrop).filter((x) => x.b === 'haveq epoch skew').length, 1)
  //! a DURABLE node's ok answer carries md as before (the `d` map on its own announcements is pinned where announcements are)
  const d = armedView1({ durable: true })
  d.node.membership.rejoinFloor = 0
  d.node.writes.ring.place('p', 'aa', 'bb')
  d.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] })
  d.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { p: { aa: 1 } }) })
  const dans = (sentOn(d, 1, VERB.HAVEA).pop()!.value as { a: Record<string, { ok: number; md?: Record<string, number>; g?: number }> }).a.p
  assert.deepEqual(dans.md, {}, 'durable: the md map rides (nothing fsynced yet)')
  assert.equal(dans.g, 1)
})

//! ── DESIGN-SCALE stage 2: announce on change, the sweep, the targeted rounds ──

//! haveqs — the HAVEQ bodies this node shipped on `link`, in order
const haveqs = (h: ReturnType<typeof harness>, link: number) =>
  sentOn(h, link, VERB.HAVEQ).map((f) => f.value as { e: number; q: Record<string, Record<string, number>>; d?: Record<string, Record<string, number>>; g?: string[]; x?: string[] })

test('ANNOUNCE ON CHANGE — one commit → at the next tick one HAVEQ with one entry to each of the R−1 co-holders (never to a non-holder), then silence once they have answered; a never-answered co-holder is asked every tick until it does (aeFan 0: the sweep off)', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p', 'aa', 'bb') // R=2: bb is the one co-holder; cc holds nothing of p
  const n1 = () => haveqs(h, 1).length, n2 = () => haveqs(h, 2).length
  assert.equal(n1() + n2(), 0, 'quiet before the write')
  h.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] })
  assert.deepEqual([...h.node.scope!.dirty], ['p'], 'the stamp site marked p dirty')
  assert.equal(n1(), 0, 'nothing leaves at the stamp: the announcement waits for the tick')
  h.tick()
  assert.deepEqual(haveqs(h, 1).map((v) => v.q), [{ p: { aa: 1 } }], 'one HAVEQ to bb carrying the new floor')
  assert.deepEqual(haveqs(h, 1)[0].g, ['p'], 'and the gapless bit for it')
  assert.equal(n2(), 0, 'cc is no holder of p: nothing')
  assert.equal(h.node.scope!.dirty.size, 0, 'the tick cleared the dirty set')
  //! bb has not answered: the never-answered leg asks again at the next tick, and the one after
  h.tick(); h.tick()
  assert.equal(n1(), 3, 'a co-holder that never attested p is asked every tick until it does')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 1 }, g: 1 } }) })
  assert.deepEqual([...h.node.scope!.entries.get('p')!.marks.get('bb')!], [['aa', 1]], 'the answer carried bb\'s floor back: marks converge in one round trip')
  h.tick(); h.tick()
  assert.equal(n1(), 3, 'silence: nothing changed, bb has attested, no sweep')
  //! a second commit: exactly one more entry to bb at the next tick, then silence again
  h.node.step({ kind: 'write', recs: [rec(['p', 'y'], 2), rec(['p', 'z'], 3)] })
  h.tick()
  assert.equal(n1(), 4)
  assert.deepEqual(haveqs(h, 1)[3].q, { p: { aa: 3 } }, 'a batch of two records is one entry: the floor')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 3 }, g: 1 } }) })
  h.tick(); h.tick(); h.tick()
  assert.equal(n1(), 4, 'silence')
  assert.equal(n2(), 0, 'and cc never heard of p')
  //! a DURABLE announcer carries its durable floors too (`d`), empty until the fsync echo
  const d = armedView1({ durable: true, tune: { aeFan: 0 } })
  d.node.membership.rejoinFloor = 0
  d.node.writes.ring.place('p', 'aa', 'bb')
  d.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] })
  d.tick()
  assert.deepEqual(haveqs(d, 1), [{ e: 1, q: { p: { aa: 1 } }, d: { p: {} }, g: ['p'] }], 'durable: q, d and g')
})

test('THE SWEEP — with aeFan 1 and two co-holders, every held partition is re-announced to each co-holder within ⌈c / aeFan⌉ = 2 ticks, in uuid order, and an idle tick costs exactly min(aeFan, c) HAVEQ frames; aeFan 2 covers both every tick', () => {
  const h = armedView1({ tune: { aeFan: 1 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p1', 'aa', 'bb')
  h.node.writes.ring.place('p2', 'aa', 'cc')
  h.node.step({ kind: 'write', recs: [rec(['p1', 'x'], 1), rec(['p2', 'x'], 2)] })
  //! both co-holders attest first (so the never-answered leg is quiet and what remains is the sweep)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p1: { ok: 1, need: 0, m: { aa: 1 } } }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { p2: { ok: 1, need: 0, m: { aa: 2 } } }) })
  h.tick() // the dirty announcement (p1 → bb, p2 → cc) plus the first sweep slice
  const b0 = haveqs(h, 1).length, c0 = haveqs(h, 2).length
  const perTick: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    const b = haveqs(h, 1).length, c = haveqs(h, 2).length
    h.tick()
    perTick.push([haveqs(h, 1).length - b, haveqs(h, 2).length - c])
  }
  assert.deepEqual(perTick, [[0, 1], [1, 0], [0, 1], [1, 0]], 'one frame per tick, alternating bb/cc in uuid order (the cursor): every pair is re-proved every 2 ticks')
  assert.deepEqual(haveqs(h, 1).slice(b0).map((v) => v.q), [{ p1: { aa: 1 } }, { p1: { aa: 1 } }], 'bb is told exactly what it shares: p1')
  assert.deepEqual(haveqs(h, 2).slice(c0).map((v) => v.q), [{ p2: { aa: 2 } }, { p2: { aa: 2 } }], 'cc: p2')
  //! aeFan 2 (≥ c): both co-holders every tick — the idle cost is min(aeFan, c) = 2 frames
  const w = armedView1({ tune: { aeFan: 2 } })
  w.node.membership.rejoinFloor = 0
  w.node.writes.ring.place('p1', 'aa', 'bb')
  w.node.writes.ring.place('p2', 'aa', 'cc')
  w.node.step({ kind: 'write', recs: [rec(['p1', 'x'], 1), rec(['p2', 'x'], 2)] })
  w.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p1: { ok: 1, need: 0, m: { aa: 1 } } }) })
  w.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { p2: { ok: 1, need: 0, m: { aa: 2 } } }) })
  w.tick()
  const wb = haveqs(w, 1).length, wc = haveqs(w, 2).length
  w.tick(); w.tick(); w.tick()
  assert.deepEqual([haveqs(w, 1).length - wb, haveqs(w, 2).length - wc], [3, 3], 'every tick re-proves every co-holder')
  //! a paused link is skipped by the sweep (and by every leg): nothing is queued into a drop-oldest queue
  w.node.step({ kind: 'pause', link: 1 })
  const pb = haveqs(w, 1).length, pc = haveqs(w, 2).length
  w.tick(); w.tick()
  assert.equal(haveqs(w, 1).length - pb, 0, 'paused: skipped')
  assert.equal(haveqs(w, 2).length - pc, 2, 'the flowing link still swept')
})

//! the §7 stage-2 row's "skewed frames dropped at a mid-announcement install", as an INSTALL between an announcement
// and its answer (the review of stage 2: the keys test sends a hand-built frame at the wrong epoch, which is the
// same drop but not the same moment). The install clears the marks (rescope) and runs its own round at the new epoch;
// the late answer to the old announcement is dropped whole; the never-answered leg asks again at the next tick.
test('MID-ANNOUNCEMENT INSTALL — a view installed between an owner\'s announcement and the co-holder\'s answer: the answer is dropped whole, the install\'s round re-asks at the new epoch, and an answer at the new epoch converges the marks', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p', 'aa', 'bb')
  h.node.step({ kind: 'write', recs: [rec(['p', 'x'], 1)] })
  h.tick()
  assert.deepEqual(haveqs(h, 1).map((v) => [v.e, v.q]), [[1, { p: { aa: 1 } }]], 'the announcement at epoch 1')
  const e = h.node.scope!.entries.get('p')!
  //! the view moves under it (the same members, so p is still aa's and bb's: nothing freezes); the install clears the
  // marks and runs the full round at epoch 2
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.epoch, 2)
  assert.equal(e.state, SCOPE.held, 'p is still held: its holders did not change')
  assert.equal(e.marks.has('bb'), false, 'the install cleared the marks')
  assert.deepEqual(haveqs(h, 1).slice(1).map((v) => [v.e, v.q]), [[2, { p: { aa: 1 } }]], 'the install\'s own round, at epoch 2')
  //! bb's answer to the epoch-1 announcement lands now: dropped whole
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p: { ok: 1, need: 0, m: { aa: 1 } } }) })
  assert.equal(e.marks.has('bb'), false, 'the skewed answer fed nothing')
  assert.equal(h.jk(JK.frameDrop).filter((x) => x.b === 'havea epoch skew').length, 1)
  //! bb has not attested at epoch 2: the never-answered leg asks again at the next tick, at epoch 2
  h.tick()
  assert.deepEqual(haveqs(h, 1).slice(2).map((v) => [v.e, v.q]), [[2, { p: { aa: 1 } }]], 're-asked at the new epoch')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(2, { p: { ok: 1, need: 0, m: { aa: 1 } } }) })
  assert.deepEqual([...e.marks.get('bb')!], [['aa', 1]], 'the answer at the right epoch converges the marks')
  h.tick()
  assert.equal(haveqs(h, 1).length, 3, 'then silence')
})

test('TARGETED ROUNDS — the post-fold round announces the acquired partition to ITS holders only; the admit round announces to the admitted peer only, the partitions the two share', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('p1', 'aa', 'bb')
  h.node.writes.ring.place('px', 'cc', 'aa')
  h.node.step({ kind: 'write', recs: [rec(['p1', 'x'], 1)] })
  h.tick()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(1, { p1: { ok: 1, need: 0, m: { aa: 1 } } }) })
  const b0 = haveqs(h, 1).length, c0 = haveqs(h, 2).length
  //! cc announces px (lane cc at 5); aa (assigned, from zero) latches, cc teaches, aa folds
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { px: { cc: 5 } }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('cc', [{ seq: 5, rec: rec(['px', 'a'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: 'px', e: 1, t: { cc: 5 }, n: 1 }) })
  assert.equal(h.node.scope!.held('px'), true)
  assert.deepEqual(haveqs(h, 2).slice(c0).map((v) => v.q), [{ px: { cc: 5 } }], 'the post-fold round: px to cc, its co-holder — nothing else')
  assert.equal(haveqs(h, 1).length, b0, 'bb holds nothing of px: the fold told it nothing (it used to get a full round)')
  //! bb's link dies and comes back: the admit round goes to bb alone, with p1 (shared) and not px (not shared)
  h.node.step({ kind: 'linkDown', link: 1, reason: 'test' })
  const c1 = haveqs(h, 2).length
  h.admit(3, 'bb')
  assert.deepEqual(haveqs(h, 3).map((v) => v.q), [{ p1: { aa: 1 } }], 'the admit round: the one shared partition, to the admitted peer')
  assert.equal(haveqs(h, 2).length, c1, 'cc heard nothing of bb\'s re-admit')
})

//! a floor can exist for a lane this node has NO entries of: an ACQDONE cut names every lane the teacher
// attests, and a lane whose records were all compacted away ships no record. The old shed walked node.logs,
// so such a stream (no lane at all) kept its floor past the shed; the lane-less stream is the shape the
// stage-1 note had wrong (it said "lanes with no entries of p" — those the old walk did visit).
test('SHED drops the partition\'s floor from a stream that has NO lane (a cut-learned floor with no record of that origin)', () => {
  const h = armedView1()
  h.node.writes.ring.place('p', 'bb', 'aa')
  //! bb teaches p: one record on lane bb, and a cut that attests lane dd at 3 — dd ships nothing
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { p: { bb: 5, dd: 3 } }) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: acqFrame('bb', [{ seq: 5, rec: rec(['p', 'x'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.ACQDONE, { p: 'p', e: 1, t: { bb: 5, dd: 3 }, n: 1 }) })
  assert.equal(h.node.scope!.held('p'), true)
  assert.equal(h.node.streams.get('dd')!.parts!.get('p')!.s, 3, 'the cut gave dd a floor for p')
  assert.equal(h.node.logs.has('dd'), false, 'and dd has no lane here')
  //! the R-set moves off aa; both holders attest the one frozen tail (bb:5): shed
  h.node.writes.ring.place('p', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.jk(JK.orphaned).length, 1)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: havea(2, { p: { ok: 1, need: 0, m: { bb: 5 } } }) })
  assert.equal(h.jk(JK.shed).length, 1, 'shed')
  assert.equal(h.node.streams.get('bb')!.parts?.get('p'), undefined, 'the lane\'s floor is gone')
  assert.equal(h.node.streams.get('dd')!.parts?.get('p'), undefined, 'the lane-less stream\'s floor is gone too')
})

//! ── DESIGN-SCALE stage 3: compaction on scoped nodes (kernel/log.ts, the banner's rule C1-C4) ──

//! hot — `n` writes of one cell of `p` on aa's own lane (batches of 100): every entry but the last is a loser
const hot = (h: ReturnType<typeof harness>, p: string, n: number) => {
  for (let i = 0; i < n; i += 100)
    h.node.step({ kind: 'write', recs: Array.from({ length: Math.min(100, n - i) }, (_, k) => rec([p, 'x'], i + k)) })
}
const laneSeqs = (h: ReturnType<typeof harness>, o = 'aa') => h.node.logs.get(o)!.map((e) => e.seq)
const compactedRows = (h: ReturnType<typeof harness>) => h.jk(JK.compacted).map((e) => [e.a, e.b, e.c])

test('COMPACTION PIN (stage 3) — an armed node compacts only on attested crash-stable marks: a holder that has attested nothing pins the frontier at 0, a co-holder\'s mark IS the frontier, the lane\'s last entry and every winner stay, the per-partition index and the journal row (with the partition) follow; the compactor\'s own open latch pins; the unscoped control compacts on the member frontier as before', () => {
  //! compactAt 64: the trigger stays size-armed (a lane under it is never walked), and the lane here shrinks below the
  // default 4,096 after its first pass
  const h = armedView1({ tune: { aeFan: 0, compactAt: 64 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('k', 'aa', 'bb')
  hot(h, 'k', 4200)
  assert.equal(h.node.logs.get('aa')!.length, 4200, 'past compactAt')
  //! (a) bb has attested nothing for k: F(aa, k) = 0 — nothing may drop (an acquiring holder attests nothing either)
  maybeCompact(h.node)
  assert.equal(h.node.logs.get('aa')!.length, 4200, 'pinned: a holder with no attestation is the frontier\'s 0')
  assert.deepEqual(compactedRows(h), [])
  assert.deepEqual(h.node.scope!.memo.get('aa'), { len: 4200, v: h.node.scope!.evidence }, 'the fruitless pass is memoized on (length, evidence)')
  //! (b) bb attests half the lane: exactly the losers at or under its mark drop; the winner (the last entry) and everything above stay
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: 2000 } }) })
  maybeCompact(h.node)
  assert.equal(h.node.logs.get('aa')!.length, 2200, '2000 losers at or under bb\'s mark left; 2200 above it stayed')
  assert.deepEqual(compactedRows(h), [['aa', 2000, 'k']], 'one journal row per (lane, partition), with the partition')
  assert.ok(laneSeqs(h).every((s) => s > 2000), 'nothing below the frontier is left but winners (there is none below it)')
  assert.deepEqual(h.node.byPart!.get('k')!.get('aa'), h.node.logs.get('aa'), 'the per-partition index is the lane\'s filter after the pass')
  assert.equal(h.node.state.get(JSON.stringify(['k', 'x'])), 4199, 'the fold is untouched')
  //! (c) bb attests the tail: every loser goes, the winner stays — one entry, the lane's last
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: 4200 } }) })
  maybeCompact(h.node)
  assert.deepEqual(laneSeqs(h), [4200], 'the winner alone')
  assert.deepEqual(compactedRows(h), [['aa', 2000, 'k'], ['aa', 2199, 'k']])
  //! (d) the compactor's OWN open latch pins (C1): q held by aa and cc; cc announces a lane aa lacks, aa latches cc —
  // q's losers stay though cc's marks for q cover them; the fold closes the latch and the next pass drops them
  h.node.writes.ring.place('q', 'aa', 'cc')
  hot(h, 'q', 100)
  const qTail = h.node.logs.get('aa')!.at(-1)!.seq
  h.node.step({ kind: 'write', recs: [rec(['k', 'y'], 1)] }) // so q's last entry is not the lane's tail
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { q: { aa: qTail, cc: 3 } }) })
  assert.equal(h.node.scope!.entries.get('q')!.state, SCOPE.acquiring, 'aa is behind on lane cc: latched')
  maybeCompact(h.node)
  assert.equal(h.node.byPart!.get('q')!.get('aa')!.length, 100, 'an acquiring partition never compacts, whatever the marks say')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: acqFrame('cc', [{ seq: 3, rec: rec(['q', 'z'], 1), pp: 0 }]) })
  h.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.ACQDONE, { p: 'q', e: 1, t: { aa: qTail, cc: 3 }, n: 1 }) })
  assert.equal(h.node.scope!.held('q'), true)
  maybeCompact(h.node)
  assert.equal(h.node.byPart!.get('q')!.get('aa')!.length, 1, 'held again: q\'s 99 losers under cc\'s mark drop')
  assert.equal(h.node.logs.get('aa')!.length, 3, 'k\'s winner, q\'s winner, the tail')
  //! the size trigger: a lane under compactAt is not walked (the memo is not even consulted)
  hot(h, 'q', 10)
  h.node.step({ kind: 'bytesIn', link: 2, bytes: haveq(1, { q: { aa: h.node.logs.get('aa')!.at(-1)!.seq, cc: 3 } }) })
  const rows = compactedRows(h).length
  maybeCompact(h.node)
  assert.deepEqual([h.node.logs.get('aa')!.length, compactedRows(h).length], [13, rows], 'under compactAt: nothing walked')
  //! the unscoped control: the member-ranged frontier, as before (the digest plane's marks)
  const plain = harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
  plain.node.step({ kind: 'start' })
  plain.admit(1, 'bb')
  plain.admit(2, 'cc')
  plain.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  plain.node.writes.ring.place('k', 'aa', 'bb')
  hot(plain, 'k', 4200)
  const tail = plain.node.streams.get('aa')!.applied
  plain.node.confirm.feed(plain.node, 'bb', 'aa', tail, -1)
  plain.node.confirm.feed(plain.node, 'cc', 'aa', tail, -1)
  maybeCompact(plain.node)
  assert.deepEqual(compactedRows(plain), [['aa', 4199, undefined]], 'unscoped: one row per lane, no partition')
})

test('COMPACTION (stage 3) — a DURABLE co-holder counts at its durable marks, never its volatile floors (the seed-27 class); a MEMORY co-holder at its floors', () => {
  const h = armedView1({ tune: { aeFan: 0, compactAt: 64 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('k', 'aa', 'bb')
  hot(h, 'k', 4200)
  //! bb is durable: its HAVEQ carries `d`. Its volatile floor covers the whole lane, its durable floor 1,000
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { k: { aa: 4200 } }, d: { k: { aa: 1000 } } }) })
  maybeCompact(h.node)
  assert.equal(h.node.logs.get('aa')!.length, 3200, 'F = bb\'s DURABLE mark: a crash before its fsync would need the rows above it')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HAVEQ, { e: 1, q: { k: { aa: 4200 } }, d: { k: { aa: 4200 } } }) })
  maybeCompact(h.node)
  assert.deepEqual(laneSeqs(h), [4200], 'the durable mark reaches the tail: everything but the winner goes')
  //! a memory peer (never a `d` map) counts at its floors
  const m = armedView1({ tune: { aeFan: 0 } })
  m.node.membership.rejoinFloor = 0
  m.node.writes.ring.place('k', 'aa', 'bb')
  hot(m, 'k', 4200)
  m.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: 4200 } }) })
  maybeCompact(m.node)
  assert.deepEqual(laneSeqs(m), [4200], 'a memory node\'s floors are crash-stable (its crash is a total refold)')
})

test('COMPACTION (stage 3) — a DURABLE compactor counts ITSELF at its durable floor; a compacting pass arms the snapshot swap, and the swap\'s echo rewrites the boot record with the floor seed above the gaps the pass opened', () => {
  const h = armedView1({ durable: true, tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('k', 'aa', 'bb')
  hot(h, 'k', 4200)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: 4200 } }) })
  //! nothing fsynced yet: self's durable floor is 0 — F = 0 whatever bb says
  const boots0 = h.of('boot').length, snaps0 = h.of('snapshot').length
  h.tick()
  assert.equal(h.node.logs.get('aa')!.length, 4200, 'pinned by this node\'s own un-fsynced rows')
  assert.equal(h.of('snapshot').length, snaps0, 'no pass dropped anything: no swap armed')
  //! the echoes land: the durable floor reaches the tail, the next tick compacts, and the SAME tick swaps the WAL
  for (const p of h.of('persist')) h.node.step({ kind: 'persisted', batch: p[1] as number })
  assert.equal(h.node.streams.get('aa')!.parts!.get('k')!.d, 4200)
  h.tick()
  assert.deepEqual(laneSeqs(h), [4200], 'compacted on its own durable floor and bb\'s mark')
  assert.equal(h.of('snapshot').length, snaps0 + 1, 'the compacting pass armed the snapshot swap in the same tick')
  const rows = h.of('snapshot').at(-1)![2] as { bytes: Uint8Array }[]
  assert.equal(rows.length, 1, 'the swap carries the compacted lane: one row')
  //! the swap's echo rewrites the boot record (no dirty entry cleared here — the compaction flag alone does it)
  const boots1 = h.of('boot').length
  assert.ok(boots1 >= boots0)
  h.node.step({ kind: 'persisted', batch: h.of('snapshot').at(-1)![1] as number })
  assert.equal(h.of('boot').length, boots1 + 1, 'the echo of a compaction-armed swap rewrites the boot record')
  const seed = (h.of('boot').at(-1)![1] as BootRecord).floors!
  assert.deepEqual(seed.aa.k, [4200, 4200], 'the seed\'s durable floor sits above every gap: a restore chains from it')
})

test('COMPACTION (stage 3) — V4-18 at an armed node: a field a row write swept drops, a superseded row drops, a fenced field remove stays, a row remove stays while its tombstone lives (until stage 4 releases it), and C4 keeps the lane\'s last entry even when it is a loser', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('m', 'aa', 'bb')
  h.node.writes.ring.place('r', 'aa', 'bb')
  const w = (r: Rec) => { h.node.step({ kind: 'write', recs: [r] }); return h.node.logs.get('aa')!.at(-1)!.seq }
  const s1 = w(rec(['m'], { a: 1, b: 2 }))                       // the first row: superseded by s3
  const s2 = w(rec(['m', 'c'], 3))                               // a field s3 sweeps
  const s3 = w(rec(['m'], { a: 1, b: 2, d: 4 }))                 // the row's winner
  const s4 = w({ type: REC.remove, key: ['m', 'a'] })            // a field remove above the live row: fenced
  const s5 = w(rec(['m', 'z'], 9))                               // a live field on top
  const s6 = w(rec(['r'], { v: 1 }))                             // superseded by the remove
  const s7 = w({ type: REC.remove, key: ['r'] })                 // the row remove: a winner while its tombstone lives
  const s8 = w(rec(['m', 'z2'], 1))                              // the lane's tail
  assert.deepEqual(laneSeqs(h), [s1, s2, s3, s4, s5, s6, s7, s8])
  //! bb attests each partition at ITS floor on lane aa (r's last record is s7: a mark of s8 for (aa, r) would read as
  // "aa is behind" and open a latch, which pins r under C1 — the kernel's right answer to an unreal claim)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { m: { aa: s8 }, r: { aa: s7 } }) })
  assert.equal(h.node.scope!.entries.get('r')!.state, SCOPE.held)
  compactScoped(h.node, 'aa') // the pass itself (the lane is far under the size trigger)
  assert.deepEqual(laneSeqs(h), [s3, s4, s5, s7, s8], 'the winners: the row, its fenced field remove, the live field, the row remove, the tail')
  assert.deepEqual(compactedRows(h).sort(), [['aa', 1, 'r'], ['aa', 2, 'm']].sort())
  assert.equal(h.node.versions.has(JSON.stringify(['r'])), true, 'the tombstone lives: GC stays pinned under scoping')
  //! C4: a lane whose LAST entry is a loser (a record on bb\'s lane, a higher stamp, beat it — the gate folds it, aa
  // holds k) keeps that entry
  const c = armedView1({ tune: { aeFan: 0 } })
  c.node.membership.rejoinFloor = 0
  c.node.writes.ring.place('k', 'aa', 'bb')
  c.node.step({ kind: 'write', recs: [rec(['k', 'x'], 1)] })
  c.node.step({ kind: 'write', recs: [rec(['k', 'x'], 2)] })
  const [t1, t2] = laneSeqs(c)
  c.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: t2 + 5, rec: rec(['k', 'x'], 9), pp: 0 }]) })
  assert.equal(c.node.state.get(JSON.stringify(['k', 'x'])), 9, 'bb\'s record won: both of aa\'s are losers')
  c.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: t2, bb: t2 + 5 } }) })
  compactScoped(c.node, 'aa')
  assert.deepEqual(laneSeqs(c), [t2], 'the first loser dropped; the last entry stays though it lost (the client digest reports the lane tail)')
  assert.deepEqual([t1 < t2, compactedRows(c)], [true, [['aa', 1, 'k']]])
})

test('COMPACTION (stage 3) — an ORPHAN never compacts (its content tails are the shed evidence), and the memo skips a lane the last pass could not advance until the evidence or the lane changes', () => {
  const h = armedView1({ tune: { aeFan: 0 } })
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('k', 'aa', 'bb')
  hot(h, 'k', 300)
  //! the R-set moves off aa: k freezes into an orphan; ONE of the two new holders attests the whole lane (the shed
  // wants both, so the entry stays an orphan); the pass must leave it whole
  h.node.writes.ring.place('k', 'bb', 'cc')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(h.node.scope!.entries.get('k')!.state, SCOPE.orphan)
  h.node.step({ kind: 'bytesIn', link: 1, bytes: havea(2, { k: { ok: 1, need: 0, m: { aa: 300 } } }) })
  assert.equal(h.jk(JK.shed).length, 0, 'not shed: cc has not attested')
  h.node.tune.compactAt > 300 || assert.fail('the default compactAt must sit above this lane')
  for (const o of h.node.logs.keys()) compactScoped(h.node, o) // the pass itself, with no size trigger in the way
  assert.equal(h.node.logs.get('aa')!.length, 300, 'an orphan\'s entries never drop, whatever the holders attest')
  assert.deepEqual(compactedRows(h), [])
  //! the memo: a held lane past compactAt with a pinned frontier is walked once, then skipped until a mark rises
  const m = armedView1({ tune: { aeFan: 0, compactAt: 64 } })
  m.node.membership.rejoinFloor = 0
  m.node.writes.ring.place('k', 'aa', 'bb')
  hot(m, 'k', 100)
  let gets = 0
  const real = m.node.versions
  m.node.versions = new (class extends Map<string, { epoch: number; seq: number; origin: string }> { get(k: string) { gets++; return super.get(k) } })(real)
  maybeCompact(m.node)
  assert.equal(gets, 0, 'F = 0 (bb attested nothing): no entry is even looked at — keep() short-circuits on the frontier')
  maybeCompact(m.node)
  assert.deepEqual([gets, m.node.scope!.memo.get('aa')], [0, { len: 100, v: m.node.scope!.evidence }], 'the memoized pass is skipped')
  m.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: 50 } }) })
  maybeCompact(m.node)
  assert.deepEqual([gets, m.node.logs.get('aa')!.length], [50, 50], 'the mark rose: re-walked (one version lookup per entry under F), 50 losers dropped')
  const g1 = gets
  maybeCompact(m.node)
  assert.equal(gets, g1, 'nothing changed since: skipped again')
  m.node.step({ kind: 'write', recs: [rec(['k', 'x'], -1)] })
  const g2 = gets // the write's own LWW election reads versions too
  maybeCompact(m.node)
  assert.equal(gets, g2, 'the lane grew but the frontier did not: the pass runs and looks at nothing under F (bb is still at 50)')
})

//! a learner at epoch `e` whose ring places p on {owner, learner}: the harness of the V4-51 teach test, parameterized
const learner = (uuid: string, e: number, p: string, owner: string) => {
  const m: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
  const L = harness(uuid, { replicas: 2, tune: { aeFan: 0 }, boot: { epoch: e, members: m } })
  L.node.step({ kind: 'start' })
  L.admit(1, 'aa')
  L.admit(2, uuid === 'bb' ? 'cc' : 'bb')
  L.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e, m }) })
  assert.equal(L.node.armed, true)
  L.node.membership.rejoinFloor = 0
  L.node.writes.ring.place(p, owner, uuid)
  return L
}

test('COMPACTION (stage 3) — the teacher ships exactly what compaction keeps: a learner taught by a compacted teacher folds the winners alone and reaches the teacher\'s state; the teach of an uncompacted lane ships the same entries a pass would keep', () => {
  const T = armedView1({ tune: { aeFan: 0 } })
  T.node.membership.rejoinFloor = 0
  T.node.writes.ring.place('k', 'aa', 'bb')
  hot(T, 'k', 300)
  T.node.step({ kind: 'write', recs: [rec(['k', 'y'], 7)] })
  T.node.step({ kind: 'write', recs: [rec(['k', 'y'], 8)] })
  const tail = T.node.logs.get('aa')!.at(-1)!.seq
  T.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: tail } }) })
  for (const o of T.node.logs.keys()) compactScoped(T.node, o)
  assert.equal(T.node.logs.get('aa')!.length, 2, 'x\'s winner and y\'s winner (the tail)')
  //! the R-set moves to {aa, cc}: cc asks from zero; the teach is the compacted lane and ACQDONE carries the cut
  T.node.writes.ring.place('k', 'aa', 'cc')
  T.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  T.node.step({ kind: 'bytesIn', link: 2, bytes: havea(2, { k: { ok: 0, need: 1, m: {} } }) })
  const acq = sentOn(T, 2, VERB.ACQ), done = sentOn(T, 2, VERB.ACQDONE)
  assert.deepEqual(acq.flatMap((f) => [...f.records()].map((rv) => rv.seq)), laneSeqs(T), 'the teach IS the compacted lane')
  assert.equal((done[0].value as { n: number }).n, 2)
  const L = learner('cc', 2, 'k', 'aa')
  L.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(2, { k: { aa: tail } }) })
  assert.equal(L.jk(JK.acquireStart).length, 1, 'the from-zero latch opened on aa')
  for (const f of [...acq, ...done]) L.node.step({ kind: 'bytesIn', link: 1, bytes: f.buf.slice() })
  assert.equal(L.node.scope!.held('k'), true)
  assert.equal(L.node.stateHash, T.node.stateHash, 'the learner\'s fold equals the teacher\'s state')
  assert.deepEqual(laneSeqs(L), laneSeqs(T))
  assert.equal(L.node.streams.get('aa')!.parts!.get('k')!.s, tail, 'the cut is the teacher\'s floor, above every gap the pass opened')
  //! the same teach from an UNCOMPACTED twin ships the same entries: the one keep() predicate — here the learner pins
  // the twin\'s frontier at 0 (it is a holder that attested nothing), so keep() passes everything above its marks
  const U = armedView1({ tune: { aeFan: 0 } })
  U.node.membership.rejoinFloor = 0
  U.node.writes.ring.place('k', 'aa', 'cc')
  hot(U, 'k', 300)
  U.node.step({ kind: 'bytesIn', link: 2, bytes: havea(1, { k: { ok: 0, need: 1, m: {} } }) })
  assert.equal(sentOn(U, 2, VERB.ACQ).flatMap((f) => [...f.records()]).length, 300, 'uncompacted, and the learner pins F at 0: every entry above its marks ships, as a teach always did')
})

test('COMPACTION (stage 3) — A9: a retry after a lost WACK and an owner move dup-acks at the new owner with the ORIGINAL coordinates, though compaction dropped the original commit from the teacher\'s lane: ACQDONE `w` carries the teacher\'s dedup window for the partition', () => {
  const T = armedView1({ tune: { aeFan: 0 } })
  T.node.membership.rejoinFloor = 0
  T.node.writes.ring.place('k', 'aa', 'bb')
  //! five attempts of issuer zz, each overwriting k.x, committed at aa (the owner) — the window holds all five with the partition
  for (let c = 1; c <= 5; c++) T.node.step({ kind: 'bytesIn', link: 1, bytes: writeFrame('zz~1', c, 1, [rec(['k', 'x'], c)]) })
  const lane = T.node.logs.get('aa')!.map((e) => ({ seq: e.seq, cid: e.cid }))
  assert.deepEqual(lane.map((e) => e.cid), [1, 2, 3, 4, 5])
  assert.deepEqual(T.node.writes.committed('zz~1', 3), { s: lane[2].seq, e: 1, o: 'aa', p: 'k' })
  T.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { k: { aa: lane[4].seq } }) })
  for (const o of T.node.logs.keys()) compactScoped(T.node, o)
  assert.deepEqual(T.node.logs.get('aa')!.map((e) => e.cid), [5], 'the four losers are gone from the lane — their identities live in the window only')
  //! the owner moves to cc (epoch 2); cc latches aa from zero; the teach ships cid 5 and `w` ships all five
  T.node.writes.ring.place('k', 'cc', 'aa')
  T.node.step({ kind: 'bytesIn', link: 2, bytes: encodeControl(VERB.VIEW, { e: 2, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  T.node.step({ kind: 'bytesIn', link: 2, bytes: havea(2, { k: { ok: 0, need: 1, m: {} } }) })
  const done = sentOn(T, 2, VERB.ACQDONE)[0].value as { n: number; w: (string | number)[][] }
  assert.equal(done.n, 1)
  assert.deepEqual(done.w.map((t) => t[1]).sort(), [1, 2, 3, 4, 5], '`w`: the window\'s five tuples for k')
  assert.deepEqual(done.w.find((t) => t[1] === 3), ['zz~1', 3, lane[2].seq, 1, 'aa'])
  const L = learner('cc', 2, 'k', 'cc')
  L.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(2, { k: { aa: lane[4].seq } }) })
  for (const f of [...sentOn(T, 2, VERB.ACQ), ...sentOn(T, 2, VERB.ACQDONE)]) L.node.step({ kind: 'bytesIn', link: 1, bytes: f.buf.slice() })
  assert.equal(L.node.scope!.held('k'), true)
  assert.deepEqual(L.node.writes.committed('zz~1', 3), { s: lane[2].seq, e: 1, o: 'aa', p: 'k' }, 'the learner\'s window has the compacted loser\'s coordinates')
  //! zz's retry of cid 3 (its WACK was lost) reaches the NEW owner: dedup'd with the original coordinates, no re-commit,
  // the newer value stands — without `w` cc would commit value 3 afresh at epoch 2, on top of 5
  L.node.step({ kind: 'bytesIn', link: 2, bytes: writeFrame('zz~1', 3, 2, [rec(['k', 'x'], 3)]) })
  assert.equal(L.jk(JK.writeDup).length, 1, 'dup-acked')
  assert.deepEqual(sentOn(L, 2, VERB.WACK).map((f) => f.value), [{ u: 'zz~1', c: 3, n: 1, s: lane[2].seq, e: 1, o: 'aa' }], 'the ORIGINAL coordinates and lane')
  assert.equal(L.node.state.get(JSON.stringify(['k', 'x'])), 5, 'the old value did not land on top of the newer one')
  assert.equal(L.node.logs.get('cc'), undefined, 'nothing re-committed')
})

//! the compaction site of the per-partition index (log.ts compact → node.indexDrop). No armed node reaches it
// today (the pin above) and a scoped node at epoch 0 has no members to range a frontier over, so nothing
// exercised it: dropping the indexDrop call stayed green everywhere (the stage-1 skeptic). Stage 3 will
// compact armed nodes on the per-(o,p) frontier; this pins the site until then by calling compact directly.
test('COMPACTION keeps byPart in step — a scoped node\'s superseded entries leave the index with the lane (the site stage 3 will reach)', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('k', 'aa', 'bb')
  h.node.writes.ring.place('q', 'aa', 'cc')
  //! one hot cell of k written five times, one cell of q once: four entries of k are superseded
  for (let i = 0; i < 5; i++) h.node.step({ kind: 'write', recs: [rec(['k', 'x'], i)] })
  h.node.step({ kind: 'write', recs: [rec(['q', 'y'], 1)] })
  const lane = h.node.logs.get('aa')!
  assert.equal(lane.length, 6)
  assert.equal(h.node.byPart!.get('k')!.get('aa')!.length, 5)
  const dropped = compact(h.node, 'aa', lane[lane.length - 1].seq)
  assert.equal(dropped, 4, 'the four superseded entries of k')
  const kept = h.node.logs.get('aa')!
  assert.deepEqual(h.node.byPart!.get('k')!.get('aa'), kept.filter((e) => e.rec.key[0] === 'k'), 'byPart(k) is the lane\'s filter — same objects, same order')
  assert.deepEqual(h.node.byPart!.get('q')!.get('aa'), kept.filter((e) => e.rec.key[0] === 'q'), 'q untouched')
  assert.equal(h.node.byPart!.get('k')!.get('aa')!.length, 1)
})

//! ── V4-51: a teach bigger than one frame leaves in cuts ───────────────────────────
// ACQDONE's n counts RECORDS, so a teach cut into several ACQ frames folds exactly as one frame did: the learner's
// staged count matches, no 'torn' abort, the cut is attested.
test('an ACQ teach bigger than one frame leaves in cuts; the learner\'s count matches and the fold completes', () => {
  const T = armedView1({ tune: { aeFan: 0, frame: 4096 } })
  T.node.membership.rejoinFloor = 0
  T.node.writes.ring.place('p', 'aa', 'bb')
  T.node.step({ kind: 'write', recs: Array.from({ length: 10 }, (_, i) => rec(['p', `f${i}`], new Uint8Array(1500).fill(i))) })
  const lane = T.node.logs.get('aa')!.map((e) => e.seq)
  assert.equal(lane.length, 10)
  //! the learner: bb at view 1, assigned p, latches aa on aa's announcement and asks from zero
  const L = harness('bb', { replicas: 2, tune: { frame: 4096 }, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] } })
  L.node.step({ kind: 'start' })
  L.admit(1, 'aa')
  L.admit(2, 'cc')
  L.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']] }) })
  assert.equal(L.node.armed, true)
  L.node.writes.ring.place('p', 'aa', 'bb')
  L.node.step({ kind: 'bytesIn', link: 1, bytes: haveq(1, { p: { aa: lane[9] } }) })
  assert.equal(L.jk(JK.acquireStart).length, 1, 'the latch opened on aa')
  const need = sentOn(L, 1, VERB.HAVEA).pop()!
  //! the teacher answers the need: five ACQ cuts of two records each, then ACQDONE counting all ten
  T.node.step({ kind: 'bytesIn', link: 1, bytes: need.buf.slice() })
  const acq = sentOn(T, 1, VERB.ACQ)
  assert.deepEqual(acq.map((f) => f.records().map((rv) => rv.seq)), [0, 2, 4, 6, 8].map((k) => [lane[k], lane[k + 1]]))
  assert.ok(acq.every((f) => f.buf.length - 11 <= 4096), 'every ACQ frame within the cap')
  const done = sentOn(T, 1, VERB.ACQDONE)
  assert.deepEqual(done.map((f) => (f.value as { n: number }).n), [10])
  for (const f of [...acq, ...done]) L.node.step({ kind: 'bytesIn', link: 1, bytes: f.buf.slice() })
  assert.equal(L.jk(JK.acquire).length, 1, 'the fold committed')
  assert.deepEqual(L.jk(JK.acquireAbort), [], 'no torn abort')
  assert.equal(L.node.scope!.held('p'), true)
  assert.equal(L.node.state.size, 10)
  assert.equal(L.node.streams.get('aa')!.parts!.get('p')!.s, lane[9], 'the teacher\'s cut is attested')
})
