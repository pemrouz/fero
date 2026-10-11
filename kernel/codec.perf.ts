//! Perf sibling: codec — counted invariants first, interleaved ratios second, absolutes last (plan §7 priority order).
// Rationale: this box (WSL2) swings absolute numbers 2-3x, so the PRIMARY gates
// are deterministic on any machine — exact bytes-on-wire and frame counts — and
// the relative lazy-scan<full-decode contract. The single absolute ceiling is a
// superlinearity tripwire with deliberate headroom, never the first line.

import { test } from 'node:test'
import assert from 'node:assert'
import { Framer, Outbox, VERB, encodeFrame } from './codec.ts'
import { REC } from './env.ts'
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

//! RATIO (V4-51): a frame that straddles chunks arrives in time LINEAR in its size — the Framer builds it once in a
// buffer that doubles as its bytes come. The old carry was re-copied whole with every chunk: a 16 MiB frame in 64 KiB
// chunks took 62-82x a 2 MiB one (quadratic in the limit, 64x); linear is ~8x (6.5-8.6x on the prototype). Best of
// three of each, so one slow round on a busy box cannot fail it.
test('ratio: a 16 MiB frame in 64 KiB chunks arrives in time linear in its size (16 MiB / 2 MiB < 20x)', () => {
  const CHUNK = 64 * 1024
  const chunksOf = (mib: number) => {
    const frame = encodeFrame([{ type: REC.update, key: ['big'], value: new Uint8Array(mib << 20) }], { origin: 'aa', baseSeq: 1, epoch: 1 })
    const cs: Uint8Array[] = []
    for (let at = 0; at < frame.length; at += CHUNK) cs.push(frame.slice(at, Math.min(frame.length, at + CHUNK)))
    return cs
  }
  const time = (cs: Uint8Array[]) => {
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const f = new Framer()
      const t0 = performance.now()
      let n = 0
      for (const c of cs) n += f.push(c).length
      best = Math.min(best, performance.now() - t0)
      assert.equal(n, 1)
    }
    return best
  }
  const small = time(chunksOf(2)), big = time(chunksOf(16))
  assert.ok(big / small < 20, `16 MiB took ${(big / small).toFixed(1)}x 2 MiB (${big.toFixed(1)} / ${small.toFixed(1)} ms) — split frames no longer arrive linearly`)
})
