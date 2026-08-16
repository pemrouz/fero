//! ── kernel/alloc.perf — the M8 allocation gates: every "allocation-free" claim, counter-verified ──
// Plan §7.1 asked for "zero heap allocations per steady-state inbound record"; the M8 panel narrowed
// that to the claim the code actually makes and the product actually needs — THREE classes:
//
//   Z  (zero-garbage): ring lookups — gcEvents === 0 across a 1M-call window is the categorical
//      witness (a loop that allocates nothing can never scavenge), belt-and-braced by a bounded delta.
//   R0 (zero-retention): the steady-state DUPLICATE-absorb step, the Outbox frame cycle, the issuer
//      write+ACK cycle — transient garbage is bounded and BY DESIGN (one RecordView per record, one
//      finished frame per flush: codec's copy-on-retain contract); what must be ZERO is what a cycle
//      durably KEEPS.
//   RB (retention-budget): the FRESH inbound path RETAINS on purpose — retention IS the product (the
//      log entry is the retransmit buffer, the version stamp is the LWW floor). The honest claim is a
//      BUDGET per record, batch-independent.
//
// All gates pin the production steady-state shape: journal DISARMED, unscoped (epoch-0 / R=∞),
// non-durable, non-client — the same posture every perf sibling declares. The sweep's always-armed
// journal is a DIFFERENT verified statement (the 'armed' gate: exact row counts + cap-bounded
// retention). Deliberate NON-claims, so nobody reads more than is proved: armed/scoped ingest
// (rxParts + early rec), durable persistRun, client spoke feeds, encodeControl's owned slice, and
// apply's transient hash-mirror garbage — none of these claims allocation-freedom and none is gated.
//
// FAILURE TAXONOMY (read this before touching a number):
//  (i)  a Z gate with gcEvents > 0 in EVERY window is REAL on any box — heap physics doesn't inherit
//       CPU contention; the regression signature is the EVENT count scaling with n (the delta
//       saturates and may even shrink — scavenges eat it; that asymmetry is why the conjunct exists).
//  (ii) a single-window blip is absorbed by the best-window predicate; do nothing.
//  (iii) an RB gate over budget with its freshness pins green = a leak or an honest cost growth —
//       a DECISIONS conversation, never a widened budget.
//  (iv) an RB gate red WITH a freshness pin red = the fixture rotted; the budget was never in play.
//  (v)  any deterministic pin (identity/count) failing = a bug on any machine.
//  (vi) the sentinel failing = --expose-gc fell off the npm script; fix the script.
// SLACK (64 KiB) is the instrument floor for one window, not a tuning knob; an engine upgrade that
// moves it is an instrument change to investigate and record, never quietly re-tune.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { Ring } from './ring.ts'
import { VERB, Outbox, encodeControl } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { alloc } from '#utils'

const SLACK = 64 * 1024

//! the sentinel: never skip, never quietly pass — a missing flag means the perf script regressed
test('SENTINEL: --expose-gc is present (the perf script carries it)', () => {
  assert.equal(typeof (globalThis as { gc?: unknown }).gc, 'function',
    'global.gc missing — the alloc gates need --expose-gc; run via `npm run perf` and check package.json')
})

//! D6 first — the instrument-can-see control (plan §6's "prove the monitors can see", applied to the
// instrument itself): a deliberately-allocating loop MUST trip the garbage witness.
test('D6 control: a deliberately-allocating loop trips garbage() loudly', async () => {
  let junk: unknown[] = []
  const g = await alloc.garbage((n) => {
    for (let i = 0; i < n; i++) junk.push({ i, arr: new Array(8).fill(i) })
    junk = []
  }, 500_000, { warm: 1_000 })
  assert.ok(g.gcEvents > 0, `the control loop allocated ~28MB and the instrument saw ${g.gcEvents} gc events — it cannot see`)
})

// ── fixtures (the perf siblings' shapes, local by design — suite-local state, sweep untouched) ──

const ringFixture = () => {
  const r = new Ring()
  r.build(1, Array.from({ length: 5 }, (_, i) => [`n${String(i + 1).padStart(2, '0')}`, `sim:${i}`] as [string, string]))
  return r
}
const keys = Array.from({ length: 4096 }, (_, i) => `part${i}`)

//! a formed synced 1-peer node, journal disarmed — the node.perf.ts idiom
const formedNode = () => {
  const env: Env = {
    now: () => 0,
    rng: () => 0.5,
    sink: { connect() {}, send() {}, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.journal.armed = false
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  return node
}

const recsOf = (batch: number, base = 0): Rec[] =>
  Array.from({ length: batch }, (_, i) => ({ type: REC.update, key: [`k${(base + i) % 256}`], value: { n: base + i, s: `v${i}` } }))

const framesOf = (count: number, batch: number, origin = 'bb') => {
  const o = new Outbox()
  const out: Uint8Array[] = []
  for (let f = 0; f < count; f++) {
    o.begin(VERB.RECORDS, { origin, baseSeq: 1 + f * batch, epoch: 0 })
    for (const rec of recsOf(batch, f * batch)) o.add(rec)
    out.push(o.finish()!)
  }
  return out
}

// ── class Z: zero-garbage (the ring's stated contract — ring.ts "allocation-free") ──────────────

test('Z1 ring.ownerOf: zero-garbage across 1M calls', async () => {
  const r = ringFixture()
  let sink = 0
  const g = await alloc.garbage((n) => { for (let i = 0; i < n; i++) sink += r.ownerOf(keys[i & 4095]).length }, 1_000_000)
  assert.ok(sink > 0)
  assert.equal(g.gcEvents, 0, `ownerOf scavenged (${g.gcEvents} events in the best window) — the allocation-free claim broke`)
  assert.ok(g.bytes <= SLACK, `delta ${g.bytes}B over the instrument floor`)
})

test('Z2 ring.holders memo-hit: zero-garbage across 1M calls (pre-populated walk cache)', async () => {
  const r = ringFixture()
  for (let i = 0; i < 4096; i++) r.holders(keys[i], 3) // one walk per partition — the loop below is pure Map.get
  let sink = 0
  const g = await alloc.garbage((n) => { for (let i = 0; i < n; i++) sink += r.holders(keys[i & 4095], 3).length }, 1_000_000)
  assert.ok(sink > 0)
  assert.equal(g.gcEvents, 0, `holders memo-hit scavenged (${g.gcEvents} events)`)
  assert.ok(g.bytes <= SLACK)
})

test('Z3 ring.holds + holdsAny: zero-garbage across 1M calls', async () => {
  const r = ringFixture()
  let sink = 0
  const g = await alloc.garbage((n) => {
    for (let i = 0; i < n; i++) { if (r.holds('n01', keys[i & 4095])) sink++; if (r.holdsAny('n02', keys[i & 4095], 3)) sink++ }
  }, 1_000_000)
  assert.ok(sink > 0)
  assert.equal(g.gcEvents, 0, `holds/holdsAny scavenged (${g.gcEvents} events)`)
  assert.ok(g.bytes <= SLACK)
})

test('Z4 ring.holdersOf: zero-garbage across 1M walks (the M8 finding, fixed: index-cursor writes)', async () => {
  //! the pre-M8 shape (`out.length = 0` then push) discarded the scratch's backing store every call —
  // ~150 B/call, 7 scavenges per 100k calls measured. The gate is the regression fence for the fix.
  const r = ringFixture()
  let sink = 0
  const g = await alloc.garbage((n) => { for (let i = 0; i < n; i++) sink += r.holdersOf(keys[i & 4095], 3).length }, 1_000_000)
  assert.ok(sink > 0 && sink % 3 === 0)
  assert.equal(g.gcEvents, 0, `holdersOf scavenged (${g.gcEvents} events) — the scratch discipline broke`)
  assert.ok(g.bytes <= SLACK)
  //! D1 — the scratch CONTRACT is an identity check: every call returns the same array object
  assert.equal(r.holdersOf('p', 3), r.holdersOf('q', 3), 'holdersOf must return the reusable scratch (copy-before-retain contract)')
})

// ── class R0: zero-retention cycles ────────────────────────────────────────────────────────────

test('R0a the steady-state duplicate-absorb step: ZERO retained bytes/record (the narrowed §7.1 claim)', async () => {
  const node = formedNode()
  const [frame] = framesOf(1, 64)
  node.step({ kind: 'bytesIn', link: 1, bytes: frame }) // applied once — every redelivery below dedups
  const logLen = node.logs.get('bb')!.length
  const stateN = node.state.size
  const ret = await alloc.retained((n) => {
    for (let i = 0; i < n; i++) node.step({ kind: 'bytesIn', link: 1, bytes: frame })
  }, 3_000, { warm: 200 })
  //! D5 freshness pins — with these green, a red budget is a real leak, never a rotted fixture
  assert.equal(node.logs.get('bb')!.length, logLen, 'dup absorb must not append')
  assert.equal(node.state.size, stateN, 'dup absorb must not apply')
  assert.equal(node.journal.n, 0, 'disarmed journal must not row (D4)')
  assert.equal(node.writes.rxParts, null, 'unscoped ingest must never build rxParts (D3)')
  assert.ok(ret <= SLACK, `dup-absorb retained ${ret}B over ${3_000 * 64} records — zero-retention broke`)
})

test('R0b the Outbox frame cycle retains nothing (the finished slice is the ONE owned copy, dropped here)', async () => {
  const o = new Outbox()
  const batch = recsOf(64)
  let bytes = 0
  const g = await alloc.retained((n) => {
    for (let i = 0; i < n; i++) {
      o.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1 + i * 64, epoch: 0 })
      for (const rec of batch) o.add(rec)
      bytes += o.finish()!.length
    }
  }, 2_000, { warm: 200 })
  assert.ok(bytes > 0)
  assert.ok(g <= SLACK, `Outbox cycle retained ${g}B — the streaming encoder is pinning buffers`)
  //! D2 — writer identity: a fitting steady cycle must reuse THE writer and THE buffer
  const w = o.w, buf = o.w.buf
  o.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 0 })
  for (const rec of batch) o.add(rec)
  o.finish()
  assert.equal(o.w, w, 'Outbox writer identity changed across a cycle')
  assert.equal(o.w.buf, buf, 'Outbox writer buffer regrew on a fitting steady cycle')
})

test('R0c the issuer leg (write + WACK clears pending): retention plateaus, pending never accretes', async () => {
  //! measure-then-classify (panel): if the cid-dedup window retained per-cycle this converts to an RB
  // budget with the measured number — it measured clean, so it is pinned as zero-retention.
  let frames = 0
  const timers: { id: number; tag: number }[] = []
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: {
      connect() {}, send() { frames++ }, close() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {},
      timer(id, tag) { timers.push({ id, tag }) },
    },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1', hosts: ['x:2', 'x:3'], heartbeatMs: 50 }, env)
  node.journal.armed = false
  node.step({ kind: 'start' })
  for (let p = 0; p < 2; p++) {
    const u = p === 0 ? 'bb' : 'cc'
    node.step({ kind: 'linkUp', link: p + 1, dialed: true, to: `x:${p + 2}` })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.HELLO, { u, i: 1, l: `x:${p + 2}` }) })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  const hb = timers.find((t) => t.tag === 2)!
  node.step({ kind: 'timer', id: hb.id, tag: hb.tag })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.VOTE, { e: 1, g: 1, ce: 0, h: 'aa,bb,cc' }) })
  assert.equal(node.epoch, 1, 'fixture must commit view 1')
  node.writes.ring.place('theirs', 'bb')
  const recs = recsOf(64).map((r0) => ({ ...r0, key: ['theirs', r0.key[0]] }))
  let base = 0
  const ret = await alloc.retained((n) => {
    for (let i = 0; i < n; i++) {
      node.step({ kind: 'write', recs })
      node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: base + 1, n: 64, s: 1, e: 1 }) })
      base += 64
    }
  }, 500, { warm: 100 })
  assert.equal(node.writes.pending.size, 0, 'WACK must clear pending every cycle (D5)')
  assert.ok(frames > 0)
  assert.ok(ret <= SLACK, `issuer cycle retained ${ret}B over 500 cycles — the attempt plane is leaking`)
})

// ── class RB: retention budgets on the FRESH path (retention is the product; the budget is the claim) ──

const budgetGate = async (batch: number, framesPerWindow: number, budget: number) => {
  const node = formedNode()
  //! ALL frames pre-encoded before any window (node.perf's own lesson: encode inside the measurement
  // dilutes the receive-path number — here it would also pollute retention with encode garbage)
  const o = new Outbox()
  const all: Uint8Array[] = []
  const total = framesPerWindow * 6 + 2 // k=5 windows + warmup + slack
  for (let f = 0; f < total; f++) {
    o.begin(VERB.RECORDS, { origin: 'bb', baseSeq: 1 + f * batch, epoch: 0 })
    for (const rec of recsOf(batch, f * batch)) o.add(rec)
    all.push(o.finish()!)
  }
  let cursor = 0
  const logBefore = node.logs.get('bb')?.length ?? 0
  const ret = await alloc.retained(() => {
    for (let i = 0; i < framesPerWindow; i++) node.step({ kind: 'bytesIn', link: 1, bytes: all[cursor++] })
  }, framesPerWindow, { warm: 1, k: 5 })
  const consumed = cursor - 1 // minus the warmup call's frames? warm:1 ⇒ one window of frames consumed there too
  assert.ok(consumed > 0)
  //! D5 freshness: every delivered record appended — the budget was genuinely in play
  assert.equal(node.logs.get('bb')!.length - logBefore, cursor * batch, 'every fresh record must append (fixture rotted otherwise)')
  const perRecord = ret / (framesPerWindow * batch)
  assert.ok(perRecord <= budget,
    `fresh inbound retained ${perRecord.toFixed(0)} B/record at batch ${batch} (budget ${budget}) — leak or honest growth: DECISIONS, never widen`)
}

test('RB1 fresh inbound retention ≤ 512 B/record at batch 512', async () => {
  await budgetGate(512, 16, 512)
})

test('RB2 batch-independence: ≤ 640 B/record at batch 16 (amplifies any per-FRAME retention 32×)', async () => {
  await budgetGate(16, 512, 640)
})

// ── the armed posture (the sweep's shape) — a DIFFERENT verified statement ─────────────────────

test('armed: dup loop journals EXACTLY one row per record and retention plateaus at the ring cap', async () => {
  const node = formedNode()
  node.journal.armed = true
  const [frame] = framesOf(1, 64)
  node.step({ kind: 'bytesIn', link: 1, bytes: frame })
  const n0 = node.journal.n
  //! warmup (200 steps × 64 dupDrops = 12,800 emits) saturates the 4096-cap drop-oldest ring BEFORE
  // the first window, so the fill never rides inside a measurement
  const ret = await alloc.retained((n) => {
    for (let i = 0; i < n; i++) node.step({ kind: 'bytesIn', link: 1, bytes: frame })
  }, 1_000, { warm: 200 })
  assert.equal(node.journal.n - n0, (200 + 5 * 1_000) * 64, 'exactly one dupDrop row per redelivered record (D4)')
  assert.ok(ret <= SLACK, `armed dup loop retained ${ret}B — the ring must be cap-bounded, drop-oldest`)
})
