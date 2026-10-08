//! Perf sibling: the kernel step tax — the event/effect architecture's cost, measured against a direct-call strawman.
// This is the M0 go/no-go measurement from plan-v3.md §11 (and a PERMANENT
// tracked ratio thereafter, per the judge grafts): if events-in/effects-out
// costs multiples of the direct approach on the hot path, the architecture
// claim fails HERE, in week one, not at M5. The strawman does the irreducible
// work (state-map set + frame encode); the kernel adds ingest bookkeeping, the
// journal, the state-hash mirror, and effect dispatch.

import { test } from 'node:test'
import assert from 'node:assert'
import { Node } from './node.ts'
import { Framer, VERB, encodeControl, encodeRuns, Outbox } from './codec.ts'
import { REC, type Env, type Rec } from './env.ts'
import { bench, ratio } from '#utils'
//! fixtures single-sourced with the M8 baseline probes (tools/perf/fixtures.ts) — declaration move
// only; every timed loop body below is byte-identical to its pre-extraction form
import { NODE_BATCH as BATCH, nodeRecs as recs, formedNode } from '../tools/perf/fixtures.ts'

test('ratio: full kernel write path vs direct-call strawman stays within budget', () => {
  const node = formedNode()
  const state = new Map<string, unknown>()
  const outbox = new Outbox()
  const r = ratio.interleaved(
    () => { // strawman: the irreducible work — set state, encode one frame
      outbox.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 0 })
      for (const rec of recs) { state.set(rec.key[0], rec.value); outbox.add(rec) }
      outbox.finish()
    },
    () => { node.step({ kind: 'write', recs }) }, // the whole kernel: ingest + hash mirror + effects
  )
  //! budget 6x: the M0 kernel carries a per-apply state-hash mirror (the sim's convergence oracle) that
  // moves behind the api-layer seam at M5 — the ratio is tracked so that migration must show up HERE as a drop.
  assert.ok(r < 6, `kernel/strawman ratio ${r.toFixed(2)} exceeds 6x — the event/effect tax grew`)
})

//! COUNTED: one write event with one admitted peer emits exactly ONE frame (coalescing), and a
// 3-peer mesh emits exactly three — frame counts are deterministic on any machine.
test('counted: frames per write burst = admitted peers, exactly', () => {
  let frames = 0
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: { connect() {}, send() { frames++ }, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  for (let p = 0; p < 3; p++) {
    node.step({ kind: 'linkUp', link: p + 1, dialed: true, to: `x:${p + 2}` })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.HELLO, { u: `p${p}`, i: 1, l: `x:${p + 2}` }) })
    node.step({ kind: 'bytesIn', link: p + 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  }
  frames = 0
  node.step({ kind: 'write', recs })
  assert.equal(frames, 3, `write burst produced ${frames} frames for 3 peers — coalescing broke`)
})

//! ABSOLUTE (tripwire): steady-state inbound apply — decode+dedup+LWW+apply for 2k records.
// Frames are pre-encoded OUTSIDE the timed region (the review caught encode
// riding inside the measurement, diluting the receive-path gate by ~half);
// bench.time runs the fn 6x (warmup + 5), so 6 frames with advancing seqs keep
// every timed pass on the genuinely-new path instead of the dupDrop path.
test('absolute: 2k-record inbound apply under the tripwire ceiling', () => {
  const node = formedNode()
  const o = new Outbox()
  const frames: Uint8Array[] = []
  for (let i = 0; i < 6; i++) {
    o.begin(VERB.RECORDS, { origin: 'bb', baseSeq: 1 + i * BATCH, epoch: 0 })
    for (const rec of recs) o.add(rec)
    frames.push(o.finish()!)
  }
  let i = 0
  const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) })
  assert.ok(ms < 100, `2k inbound apply took ${ms.toFixed(1)}ms (ceiling 100ms)`)
})

//! RATIO (V4-18, overlapping cells): a field write pays for ITS OWN subtree only. A partition holding
// 10k deeper cells (['users', uK, 'name']) must not make a write at ['users', uK] cost more than the
// same write into a partition with nothing under it: the sweep finds the write's subtree in one
// lookup (the deep index is keyed by ancestor) and never walks the partition. With the index keyed
// by partition this ratio was about 300x. Both sides are inbound frames on their own lanes with
// advancing seqs (every timed pass is the fresh-record path, never dupDrop).
test('ratio: a mid-depth write into a partition holding 10k deeper cells costs the same as into an empty one', () => {
  const node = formedNode()
  const o = new Outbox()
  const frame = (origin: string, baseSeq: number, recs: Rec[]) => { o.begin(VERB.RECORDS, { origin, baseSeq, epoch: 0 }); for (const r of recs) o.add(r); return o.finish()! }
  for (let i = 0; i < 10_000; i += 1000)
    node.step({ kind: 'bytesIn', link: 1, bytes: frame('bb', 1 + i, Array.from({ length: 1000 }, (_, j) => ({ type: REC.update, key: ['users', 'u' + (i + j), 'name'], value: 'n' })) ) })
  const mid = (p: string): Rec[] => Array.from({ length: BATCH }, (_, i) => ({ type: REC.update, key: [p, 'u' + i], value: { name: 'm' } }))
  const empty: Uint8Array[] = [], full: Uint8Array[] = []
  for (let r = 0; r < 8; r++) { empty.push(frame('cc', 1 + r * BATCH, mid('empty'))); full.push(frame('dd', 1 + r * BATCH, mid('users'))) }
  let i = 0, j = 0
  const r = ratio.interleaved(
    () => { node.step({ kind: 'bytesIn', link: 1, bytes: empty[i++] }) },
    () => { node.step({ kind: 'bytesIn', link: 1, bytes: full[j++] }) },
  )
  assert.ok(r < 3, `mid-depth write with 10k deeper cells / into an empty partition = ${r.toFixed(2)}x — the sweep is walking the partition, not the subtree (budget 3x)`)
})

//! COUNTED + ABSOLUTE (M8, plan §7's "digest build at realistic origins×partitions"): a caught-up
// peer's r:1 digest asks for OURS and ships nothing back (its claim covers every lane) — so the step
// isolates the digest BUILD: walk 100 origin lanes, encode one control frame. Entry count is the
// deterministic law (every lane exactly once); the ms is the usual tripwire tier.
test('counted + absolute: digest build over 100 origin lanes — every lane exactly once, one frame', () => {
  const sent: Uint8Array[] = []
  const env: Env = {
    now: () => 0, rng: () => 0.5,
    sink: { connect() {}, send(_l, bytes) { sent.push(bytes) }, close() {}, timer() {}, cancel() {}, apply() {}, persist() {}, boot() {}, confirm() {}, snapshot() {} },
  }
  const node = new Node({ uuid: 'aa', listen: 'x:1' }, env)
  node.journal.armed = false
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'x:2' })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'x:2' }) })
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
  const ORIGINS = 100
  const one: Rec = { type: REC.update, key: ['k'], value: 1 }
  for (let o = 0; o < ORIGINS; o++)
    node.step({ kind: 'bytesIn', link: 1, bytes: encodeRuns([{ rec: one, origin: `origin-${o}`, seq: 1, epoch: 0 }])[0] })
  //! the peer claims every lane at our tails — nothing to ship, ONLY the digest answer builds
  const claim: Record<string, number> = { aa: 0 }
  for (let o = 0; o < ORIGINS; o++) claim[`origin-${o}`] = 1
  const ask = encodeControl(VERB.DIGEST, { d: claim, r: 1 })
  sent.length = 0
  const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: ask }) })
  assert.equal(sent.length, 6, 'each r:1 answers with exactly ONE digest frame (warmup + 5 timed)')
  const answer = new Framer().push(sent[sent.length - 1])[0]
  assert.equal(answer.verb, VERB.DIGEST)
  const d = (answer.value as { d: Record<string, number> }).d
  assert.equal(Object.keys(d).length, ORIGINS, 'every origin lane appears in the digest exactly once')
  assert.ok(ms < 50, `100-lane digest build took ${ms.toFixed(2)}ms (tripwire 50ms)`)
})
