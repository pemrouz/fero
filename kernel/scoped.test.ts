//! Tier-1 M6 slice-2 suite: the scoped EVIDENCE plane — possession floors, the dual-fence ingest law,
// the no-interior-rows WAL discipline, the boot dirty ledger, the replay held-gate, scoped confirm
// thresholds, and the armed compaction pin. Everything here drives the kernel by hand-crafted events
// against a recording sink (the write.test.ts idiom); the companion guarantee is INERTNESS — the
// unscoped control cases pin that none of this machinery is reachable at R=∞.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { JK } from './journal.ts'
import { maybeCompact } from './log.ts'
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

test('AE FILTER — a digest answer ships a member only the partitions ITS R-set covers', () => {
  const h = armedView1()
  h.node.membership.rejoinFloor = 0
  h.node.writes.ring.place('shared', 'aa', 'bb')
  h.node.writes.ring.place('private', 'aa', 'cc')
  h.node.step({ kind: 'write', recs: [rec(['shared', 'x'], 1)] })
  h.node.step({ kind: 'write', recs: [rec(['private', 'x'], 2)] })
  const sentBefore = h.of('send').filter((e) => e[1] === 1).length
  //! bb re-announces empty tails (r=0 digest) — the suffix answer must carry ONLY bb's partitions
  h.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  const frames = h.of('send').filter((e) => e[1] === 1).slice(sentBefore)
    .map((e) => new Framer().push((e[2] as Uint8Array).slice())[0])
    .filter((f) => f && f.verb === VERB.RECORDS)
  const shipped: string[] = []
  for (const f of frames) for (const rv of f.records()) shipped.push((rv.rec() as Rec).key[0])
  assert.deepEqual(shipped, ['shared'], 'the suffix ships bb\'s partitions only — never private ones')
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
