//! Perf sibling: codec — counted invariants first, interleaved ratios second, absolutes last (plan §7 priority order).
// Rationale: this box (WSL2) swings absolute numbers 2-3x, so the PRIMARY gates
// are deterministic on any machine — exact bytes-on-wire and frame counts — and
// the relative lazy-scan<full-decode contract. The single absolute ceiling is a
// superlinearity tripwire with deliberate headroom, never the first line.

import { test } from 'node:test'
import assert from 'node:assert'
import { Framer, Outbox, VERB, encodeFrame } from './codec.ts'
import { bench, ratio } from '#utils'
//! fixtures single-sourced with the M8 baseline probes (tools/perf/fixtures.ts) — declaration move
// only; every timed loop body below is byte-identical to its pre-extraction form
import { CANONICAL_FRAME_BYTES, CODEC_N as N, canonicalFrame, codecRecs as recs } from '../tools/perf/fixtures.ts'

//! COUNTED: the wire cost of a canonical record is pinned EXACTLY — any encoding change that grows it fails on every machine identically.
test('counted: bytes-on-wire per canonical record is pinned', () => {
  const one = canonicalFrame()
  // 11 header + prov(origin len+utf8, baseSeq, epoch) + count u32 + record(tag, key segs, obj value) — the exact figure is the contract
  assert.equal(one.length, CANONICAL_FRAME_BYTES, `canonical record frame is ${one.length}B (was ${CANONICAL_FRAME_BYTES}B — wire cost changed, justify in DECISIONS)`)
})

//! COUNTED: a batch coalesces into exactly ONE frame, and decode yields exactly N views (no splits, no drops).
test('counted: one flush = one frame; N in = N out', () => {
  const o = new Outbox()
  o.begin(VERB.RECORDS, { origin: 'o', baseSeq: 1, epoch: 0 })
  for (const r of recs) o.add(r)
  const bytes = o.finish()!
  const frames = new Framer().push(bytes)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].records().length, N)
})

//! RATIO: boundary scan must stay strictly cheaper than full decode — the lazy-decode contract, asserted as a relation (WSL2-proof).
test('ratio: lazy records() scan < full value decode', () => {
  const bytes = encodeFrame(recs, { origin: 'o', baseSeq: 1, epoch: 0 })
  const frame = () => new Framer().push(bytes.slice())[0]
  const r = ratio.interleaved(
    () => { for (const v of frame().records()) v.value },  // baseline: decode every value
    () => { frame().records() },                            // candidate: boundary scan only
  )
  assert.ok(r < 0.75, `scan/decode ratio ${r.toFixed(2)} — lazy decode no longer pays`)
})

//! ABSOLUTE (tripwire tier): encode+decode 10k object records — generous ceiling, catches superlinear regressions only.
test('absolute: encode+decode 10k records under the tripwire ceiling', () => {
  const ms = bench.time(() => {
    const bytes = encodeFrame(recs, { origin: 'o', baseSeq: 1, epoch: 0 })
    for (const v of new Framer().push(bytes)[0].records()) v.value
  })
  assert.ok(ms < 300, `10k encode+decode took ${ms.toFixed(1)}ms (ceiling 300ms)`)
})
