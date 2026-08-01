//! ── tools/perf/probes — the graduated probe registry: the loop shapes whose medians persist ──────
// Each probe re-runs its perf sibling's EXACT timed loop shape (fixtures single-sourced via
// fixtures.ts — see its header rule) under bench.time's discipline and reports {ms, n, persec}.
// Graduation policy: a probe graduates by adding a row here + a matching baseline entry — the
// schema is open; the eight below sit on plan §7's execution-frequency spine and each already
// carries a hard tripwire in its sibling (which remains the enforcement backstop on every box).
// The strawman ratio rides along INFORMATIONAL-only: it is gated at node.perf.ts, and baseline-
// gating the same number twice is how thresholds drift apart.
//
// COUNTS are recomputed from the same fixtures the siblings assert against — wire-structural laws
// only (bytes per canonical record, frames per burst/forward/run): harness-independent, exact-
// compared on ANY machine. Probe-intrinsic exactness (state sizes, seq advances) stays as in-probe
// validity asserts, never persisted — persisting bench-rep-dependent numbers would turn a harness
// change into a fake wire-drift.

import { Runtime } from '../../shell/runtime.ts'
import { Bind } from '../../api/data.ts'
import { Node } from '../../kernel/node.ts'
import { Framer, Outbox, VERB, encodeControl, encodeFrame, encodeRuns } from '../../kernel/codec.ts'
import { REC, type Env, type Rec } from '../../kernel/env.ts'
import { bench, ratio } from '#utils'
import {
  CANONICAL_FRAME_BYTES, canonicalFrame, CODEC_N, codecRecs,
  NODE_BATCH, nodeRecs, formedNode, formedView1, writeFrames, ringFixture, ringKeys,
} from './fixtures.ts'

export interface ProbeResult { ms: number; n: number; persec: number }
export interface Probe {
  id: string
  file: string // the sibling whose loop shape this re-runs (its tripwire is the backstop)
  mode: 'sync' | 'tier3'
  run: () => ProbeResult | Promise<ProbeResult>
}

const result = (ms: number, n: number): ProbeResult => ({ ms: +ms.toFixed(3), n, persec: Math.round(n / (ms / 1000)) })

//! the wire-count laws the baseline exact-compares — recomputed HERE from the shared fixtures
export const counts = (): Record<string, number> => {
  const perBurst = (() => {
    //! node.perf.ts's counted law verbatim: an M0 (epoch-0) node with 3 admitted+synced peers — one
    // write burst coalesces into exactly one frame PER PEER (a view-1 node would owner-route instead,
    // which is the perForward law below, not this one)
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
    node.step({ kind: 'write', recs: Array.from({ length: 64 }, (_, i) => ({ type: REC.update, key: ['self', `k${i}`], value: i })) })
    return frames
  })()
  const perForward = (() => {
    const { node, framesSent } = formedView1()
    node.writes.ring.place('theirs', 'bb')
    const before = framesSent()
    node.step({ kind: 'write', recs: Array.from({ length: 64 }, (_, i) => ({ type: REC.update, key: ['theirs', `k${i}`], value: i })) })
    return framesSent() - before
  })()
  const perOwnerRun = (() => {
    const owner = formedView1()
    owner.node.writes.ring.place('hot', 'aa')
    const [frame] = writeFrames(1, 64)
    const before = owner.framesSent()
    owner.node.step({ kind: 'bytesIn', link: 1, bytes: frame })
    return owner.framesSent() - before
  })()
  return {
    'wire.bytes-per-record': canonicalFrame().length, // must equal CANONICAL_FRAME_BYTES — the gate asserts both ways
    'wire.frames-per-burst-3peers': perBurst,
    'write.frames-per-forward': perForward,
    'write.frames-per-owner-run': perOwnerRun,
  }
}
export { CANONICAL_FRAME_BYTES }

export const syncProbes: Probe[] = [
  {
    id: 'codec.encode-decode-10k', file: 'kernel/codec.perf.ts', mode: 'sync',
    run: () => {
      const ms = bench.time(() => {
        const bytes = encodeFrame(codecRecs, { origin: 'o', baseSeq: 1, epoch: 0 })
        for (const v of new Framer().push(bytes)[0].records()) v.value
      })
      return result(ms, CODEC_N)
    },
  },
  {
    id: 'node.inbound-apply-2k', file: 'kernel/node.perf.ts', mode: 'sync',
    run: () => {
      const node = formedNode()
      const o = new Outbox()
      const frames: Uint8Array[] = []
      for (let i = 0; i < 6; i++) {
        o.begin(VERB.RECORDS, { origin: 'bb', baseSeq: 1 + i * NODE_BATCH, epoch: 0 })
        for (const rec of nodeRecs) o.add(rec)
        frames.push(o.finish()!)
      }
      let i = 0
      const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) })
      if (node.streams.get('bb')!.applied !== 6 * NODE_BATCH) throw new Error('probe invalid: not every rep applied fresh')
      return result(ms, NODE_BATCH)
    },
  },
  {
    id: 'write.owner-2k', file: 'kernel/write.perf.ts', mode: 'sync',
    run: () => {
      const { node } = formedView1()
      node.writes.ring.place('hot', 'aa')
      const frames = writeFrames(6, 2000)
      let i = 0
      const ms = bench.time(() => { node.step({ kind: 'bytesIn', link: 1, bytes: frames[i++] }) })
      return result(ms, 2000)
    },
  },
  {
    //! 512 per burst, NOT the sibling's 2000: a 2k-attempt batch overflows the bounded pending queue
    // (MAX_PENDING drop-oldest) and splits past the one-frame flush cap, so 976 attempts per rep are
    // silently dropped and the remainder never ships without the retry timer — the sibling's tripwire
    // is a consistent workload but NOT a clean per-attempt number. 512 = one wire run, one WACK, a
    // fully-drained cycle: the honest issuer-leg contract (mint → forward → ACK → pending empty).
    id: 'write.issuer-512', file: 'kernel/write.perf.ts', mode: 'sync',
    run: () => {
      const { node } = formedView1()
      node.writes.ring.place('theirs', 'bb')
      const recs: Rec[] = Array.from({ length: 512 }, (_, i) => ({ type: REC.update, key: ['theirs', `f${i & 511}`], value: i }))
      let base = 0
      const ms = bench.time(() => {
        node.step({ kind: 'write', recs })
        node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.WACK, { u: 'aa~1', c: base + 1, n: 512, s: 1, e: 1 }) })
        base += 512
      })
      if (node.writes.pending.size !== 0) throw new Error('probe invalid: pending must drain every rep')
      return result(ms, 512)
    },
  },
  {
    id: 'api.write-5k', file: 'api/data.perf.ts', mode: 'sync',
    run: () => {
      const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
      const bind = new Bind(rt)
      let v = 0
      const ms = bench.time(() => { for (let i = 0; i < 5000; i++) bind.data['k' + (i & 1023)] = ++v })
      if (rt.node.seq !== 5000 * 6) throw new Error('probe invalid: reps hit the no-op path')
      bind.destroy()
      void rt.destroy()
      return result(ms, 5000)
    },
  },
  {
    id: 'api.inbound-5k', file: 'api/data.perf.ts', mode: 'sync',
    run: () => {
      const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 })
      const bind = new Bind(rt)
      rt.node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' })
      rt.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) })
      rt.node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) })
      const sets: Uint8Array[][] = []
      let seq = 0
      for (let rep = 0; rep < 6; rep++) {
        const frames: Uint8Array[] = []
        for (let i = 0; i < 5000; i += 50) {
          const recs: { rec: Rec; origin: string; seq: number; epoch: number }[] = []
          for (let k = 0; k < 50; k++) recs.push({ rec: { type: REC.update, key: ['r' + ((i + k) & 1023)], value: seq }, origin: 'bb', seq: ++seq, epoch: 0 })
          frames.push(encodeRuns(recs)[0])
        }
        sets.push(frames)
      }
      let rep = 0
      const ms = bench.time(() => { for (const f of sets[rep]) rt.node.step({ kind: 'bytesIn', link: 1, bytes: f }); rep++ })
      if (rt.node.streams.get('bb')!.applied !== 5000 * 6) throw new Error('probe invalid: reps hit the dup path')
      bind.destroy()
      void rt.destroy()
      return result(ms, 5000)
    },
  },
  {
    id: 'ring.ownerof-1m', file: 'kernel/ring.perf.ts', mode: 'sync',
    run: () => {
      const r = ringFixture()
      let sink = 0
      const ms = bench.time(() => { for (let i = 0; i < 1_000_000; i++) sink += r.ownerOf(ringKeys[i & 4095]).length })
      if (sink === 0) throw new Error('probe invalid')
      return result(ms, 1_000_000)
    },
  },
]

//! node.step-vs-strawman — INFORMATIONAL: persisted so drift is data, gated only at node.perf.ts
export const strawmanRatio = (): number => {
  const node = formedNode()
  const state = new Map<string, unknown>()
  const outbox = new Outbox()
  return +ratio.interleaved(
    () => {
      outbox.begin(VERB.RECORDS, { origin: 'aa', baseSeq: 1, epoch: 0 })
      for (const rec of nodeRecs) { state.set(rec.key[0], rec.value); outbox.add(rec) }
      outbox.finish()
    },
    () => { node.step({ kind: 'write', recs: nodeRecs }) },
  ).toFixed(3)
}
