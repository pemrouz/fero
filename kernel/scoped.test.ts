//! Tier-1 M6 slice-2 suite: the scoped EVIDENCE plane — possession floors, the dual-fence ingest law,
// the no-interior-rows WAL discipline, the boot dirty ledger, the replay held-gate, scoped confirm
// thresholds, and the armed compaction pin. Everything here drives the kernel by hand-crafted events
// against a recording sink (the write.test.ts idiom); the companion guarantee is INERTNESS — the
// unscoped control cases pin that none of this machinery is reachable at R=∞.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { compact, maybeCompact } from './log.ts'
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
  assert.deepEqual(h.node.writes.committed('aa~1', 1), { s: 9, e: 1, o: 'bb~3' }, 'the window names the lane, not the link')
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
  assert.deepEqual(hops, [{ u: 'zz~1', c: 1, n: 1, s: 20, e: 1, o: 'bb' }, { u: 'zz~1', c: 2, n: 1, s: 21, e: 1 }], 'the lane hops only where the tap will stay silent')
  assert.equal(h.of('acked').length, 1, 'a relayed attempt never settles here')
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
  assert.deepEqual(h.node.writes.committed('cc~1', 7), { s: 5, e: 1, o: 'bb' }, 'the window names the lane the fold put the record on')
  //! cc re-sends cid 7 (its first WACK was lost): answered from the window, with the lane
  h.node.step({ kind: 'bytesIn', link: 2, bytes: writeFrame('cc~1', 7, 1, [rec(['px', 'a'], 1)]) })
  assert.deepEqual(framesOn(h, 2, VERB.WACK).map((f) => f.value), [{ u: 'cc~1', c: 7, n: 1, s: 5, e: 1, o: 'bb' }], 'the dup answer after a fold carries the lane')
  //! the REPLAY leg, armed: a restored owner replays a held row with attempt identity, then meets the re-send
  const r = harness('aa', { replicas: 2, boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']], heldPartitions: ['p1'] } })
  r.node.step({ kind: 'replay', bytes: encodeRuns([{ rec: rec(['p1', 'a'], 1), origin: 'bb', seq: 10, epoch: 1, iss: 'cc~1', cid: 3, pp: 0 }], VERB.RECORDS, true)[0], prev: 0 })
  assert.deepEqual(r.node.writes.committed('cc~1', 3), { s: 10, e: 1, o: 'bb' }, 'replay names the lane')
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
  assert.deepEqual(framesOn(h, 3, VERB.WACK).map((f) => f.value), [{ u: 'zz~1', c: 1, n: 1, s: 8, e: 1 }], 'the hop carries no lane')
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
  assert.deepEqual(sentOn(h, 1, VERB.ACQDONE).map((f) => f.value), [{ p: 'p', e: 1, t: { aa: 1 }, n: 1 }], 'with its own floors as the cut: a sound claim whatever its latch state')
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

test('COMPACTION PIN — armed nodes never compact or GC on the member-ranged frontier (unsound under scoping); the unscoped control still does', () => {
  const build = (replicas?: number) => {
    const h = replicas ? armedView1() : harness('aa', { hosts: ['sim:bb', 'sim:cc'] })
    if (!replicas) {
      h.node.step({ kind: 'start' })
      h.admit(1, 'bb')
      h.admit(2, 'cc')
      const m: [string, string][] = [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']]
      h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VIEW, { e: 1, m }) })
      assert.equal(h.node.epoch, 1)
    }
    h.node.writes.ring.place('k', 'aa', 'bb')
    //! one hot cell overwritten past COMPACT_AT: every superseded entry is compactable
    for (let i = 0; i < 4200; i += 100)
      h.node.step({ kind: 'write', recs: Array.from({ length: 100 }, (_, k) => rec(['k', 'x'], i + k)) })
    //! peers announce marks past the tail so the unscoped frontier is unpinned
    const tail = h.node.streams.get('aa')!.applied
    h.node.confirm.feed(h.node, 'bb', 'aa', tail, -1)
    h.node.confirm.feed(h.node, 'cc', 'aa', tail, -1)
    return h
  }
  const armed = build(2)
  const lenBefore = armed.node.logs.get('aa')!.length
  maybeCompact(armed.node)
  assert.equal(armed.node.logs.get('aa')!.length, lenBefore, 'armed: pinned — no cut until per-(o,p) attested marks exist')
  assert.equal(armed.jk(JK.compacted).length, 0)
  const plain = build(undefined)
  maybeCompact(plain.node)
  assert.ok(plain.jk(JK.compacted).length > 0, 'unscoped control: the same evidence compacts')
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
