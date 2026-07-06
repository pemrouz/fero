//! fero-v3/internals — the power-user escape hatch: the REAL layers, not a demonstrator.
// v2's internals exported an L1 view()/distribute() whose replay semantics silently
// diverged from the product (no LWW, no fences) — "a seam that lies" per the audit.
// v3 exports exactly what the product runs: the kernel, the codec, and the sim
// executive, so anything built on these is built on the same code paths the tests
// and sweeps validate (plan §3.3).

export { Node, MAX_REDIALS, stable, type NodeOpts } from './kernel/node.ts'
export { Membership, SUSPECT_TICKS, MAX_PULLS, type View } from './kernel/membership.ts'
export { Writes, NACK, MAX_PENDING, RETRY_TICKS, DEDUP_KEEP, MAX_ISSUERS } from './kernel/write.ts'
export { Ring, VNODES } from './kernel/ring.ts'
export { Link, LS, MAX_QUEUED } from './kernel/link.ts'
export { Journal, JK, type JEvent } from './kernel/journal.ts'
export {
  Framer, Frame, RecordView, Outbox, Cursor, Writer, FrameError,
  VERB, VT, MAGIC, MAX_FRAME, HEADER, FLAG_PROV,
  encodeFrame, encodeControl, encodeRuns, crc32c, crcFrame, type Prov,
} from './kernel/codec.ts'
export { REC, TAG, partitionOf, type Rec, type Applied, type Event, type EffectSink, type Env } from './kernel/env.ts'
export { Sim, mulberry32, pairKey, type Fault, type Violation } from './sim/exec.ts'
export { cluster, formed, writes } from './sim/harness.ts'
export { converged, drained, perEvent } from './sim/monitors.ts'
export { Runtime } from './shell/runtime.ts'
export { captureSim, captureLive, captureNode } from './tools/debug/capture.ts'
