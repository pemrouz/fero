//! fero-v3/internals — the power-user escape hatch: the REAL layers, not a demonstrator.
// v2's internals exported an L1 view()/distribute() whose replay semantics silently
// diverged from the product (no LWW, no fences) — "a seam that lies" per the audit.
// v3 exports exactly what the product runs: the kernel, the codec, and the sim
// executive, so anything built on these is built on the same code paths the tests
// and sweeps validate (plan §3.3).

export { Node, MAX_REDIALS, LAMPORT_LEASE, SNAPSHOT_AT, stable, type NodeOpts } from './kernel/node.ts'
export { Membership, SUSPECT_TICKS, MAX_PULLS, type View } from './kernel/membership.ts'
export { Writes, NACK, MAX_PENDING, RETRY_TICKS, DEDUP_KEEP, MAX_ISSUERS } from './kernel/write.ts'
export { Ring, VNODES } from './kernel/ring.ts'
export { Streams, StreamDescriptor } from './kernel/streams.ts'
export { Confirm, CONFIRM, MAX_PROBES } from './kernel/confirm.ts'
export { frontier, compact, gcTombstones, maybeCompact, COMPACT_AT } from './kernel/log.ts'
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
export { converged, drained, confirmedIntact, perEvent } from './sim/monitors.ts'
export { Runtime } from './shell/runtime.ts'
export { captureSim, captureLive, captureNode } from './tools/debug/capture.ts'
//! M5 api layer — the public surface's building blocks, for embedders composing their own shells.
export { fero } from './api/index.ts'
//! M7 [diagnostics] — the Symbol-keyed internals seam on every fero() instance (off the typed surface).
export { diagnostics, diag, type Diagnostics, type CapturedNode } from './api/diagnostics.ts'
export { Bind, WRITES_KEEP, cellOf, type Coords, type Outcome } from './api/data.ts'
export { Host, Caller, handle, SYSTEM, type Context } from './api/methods.ts'
//! NB: the v2-era capture sink is GONE (D2 — the lens owns the write surface); this line
// once re-exported it and made the whole entry a SyntaxError at import (pinned by
// tests/internals.test.ts).
export { proxy, snapshot, applyRec, applyStreamRec, records, isProxy, lens, unwrap, contract, ORIGIN } from './api/substrate.ts'
export { client } from './sim/harness.ts'
export type {
  Fero, FeroConfig, FeroOpts, Methods, Change, WriteOpts,
  Guarantee, WriteResolve, WriteReject, Seams, Peer, ClusterShape, Partitions, ScopedError,
} from './api/types.ts'
