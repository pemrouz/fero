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
import { VERB, encodeControl, encodeRuns } from './codec.ts'
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
// lanes are the norm here), so the helper asserts the rows encoded to exactly one
const frame = (origin: string, rows: { seq: number; rec: Rec }[], epoch = 1): Uint8Array => {
  const out = encodeRuns(rows.map((r) => ({ rec: r.rec, origin, seq: r.seq, epoch })), VERB.RECORDS)
  assert.equal(out.length, 1, 'test rows must be one contiguous run — send gappy seqs as separate frames')
  return out[0]
}

test('DUAL FENCE — an under-fence interior SPLICES in (lane ascending, floor advances); dups above and below the floor still drop', () => {
  const h = armedView1()
  //! cross-link interleave: seqs 10 then 12 arrive first (applied runs to 12), the interior 11 later
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2) }]) })
  const d = h.node.streams.get('bb')!
  assert.equal(d.applied, 12)
  assert.deepEqual([d.parts!.get('p1')!.s, d.parts!.get('p2')!.s], [10, 12], 'fast-path floors track per-partition maxes')
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3) }]) })
  assert.deepEqual(h.node.logs.get('bb')!.map((e) => e.seq), [10, 11, 12], 'the splice lands at its seq position — ascending preserved')
  assert.equal(h.node.state.get(JSON.stringify(['p1', 'b'])), 3, 'the interior record folded through the one LWW election')
  assert.equal(d.parts!.get('p1')!.s, 11, 'the possession floor advanced with the splice')
  assert.equal(d.applied, 12, 'the scalar fence never regresses or fragments')
  //! a genuine duplicate of the splice drops on lane presence; a below-floor absentee drops as covered
  const dups = () => h.jk(JK.dupDrop).length
  const before = dups()
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3) }]) })
  assert.equal(dups(), before + 1, 'present-in-lane ⇒ dup')
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 9, rec: rec(['p1', 'z'], 9) }]) })
  assert.equal(dups(), before + 2, 'absent but ≤ floor ⇒ effect-covered, dropped')
  assert.equal(h.node.state.has(JSON.stringify(['p1', 'z'])), false)
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
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }]) })
  h.node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2) }]) })
  const persists = () => h.of('persist').length
  const afterFast = persists()
  assert.ok(afterFast >= 1, 'the fast-path frame persisted (the received bytes are the row)')
  //! the persisted echoes advance the per-(origin, partition) DURABLE floors each batch covered
  for (const p of h.of('persist')) h.node.step({ kind: 'persisted', batch: p[1] as number })
  const d = h.node.streams.get('bb')!
  assert.deepEqual([d.parts!.get('p1')!.d, d.parts!.get('p2')!.d], [10, 12], 'durable floors advanced per the batch cover')
  //! the interior arrives: memory-only — NO persist effect, the partition is dirty in the boot record
  h.node.step({ kind: 'bytesIn', link: 2, bytes: frame('bb', [{ seq: 11, rec: rec(['p1', 'b'], 3) }]) })
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

test('REPLAY — the boot held-gate skips non-held rows (applied/chain advance, no fold), floors rebuild from row maxes EXCEPT boot-dirty partitions', () => {
  const h = harness('aa', {
    replicas: 2,
    boot: { epoch: 1, members: [['aa', 'sim:aa'], ['bb', 'sim:bb'], ['cc', 'sim:cc']], heldPartitions: ['p1', 'p3'], dirtyParts: ['p3'] },
  })
  //! pin p2 away from aa so the ring agrees with the boot record's silence about it
  h.node.writes.ring.place('p2', 'bb', 'cc')
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 10, rec: rec(['p1', 'a'], 1) }]), prev: 0 })
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 12, rec: rec(['p2', 'a'], 2) }]), prev: 10 })
  h.node.step({ kind: 'replay', bytes: frame('bb', [{ seq: 14, rec: rec(['p3', 'a'], 3) }]), prev: 12 })
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
