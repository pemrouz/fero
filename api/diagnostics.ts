//! ── api/diagnostics — the Symbol-keyed internals seam (M7, DESIGN-M7 §3; v2's idiom, v3's organs) ──
// v2 hung an off-surface handle on every fero() instance (`instance[diagnostics]`) for observability +
// fault injection; v3 keeps the IDIOM — Symbol-keyed, off the typed public surface, out of Object.keys
// (language semantics: symbol props are invisible to keys/for-in/JSON) — and maps the members onto
// v3's real internals. Nothing is stubbed: members that cannot be honest on a TCP shell are ABSENT,
// not faked — v2's observe/observing are answered by the journal cursor + the public tap (pull-spine,
// DECISIONS O), and isolate/heal live at the sim tier only (a TCP shell cannot hold a partition
// honestly: redial/revive heals it within redialMs; the M8 sketch is an IDEAS line, not code).
// This module imports TYPES only, so tools/tests can import the Symbol without loading the composer.

import type { JEvent } from '../kernel/journal.ts'
import type { captureNode } from '../tools/debug/capture.ts'
import type { Fero } from './types.ts'

//! CapturedNode — one node's slice in THE capture format (the diagNode-fold-backed shape).
export type CapturedNode = ReturnType<typeof captureNode>

export interface Diagnostics {
  //! this node's slice in THE capture format — the same fold the DIAG wire serves (parity by construction)
  capture(): CapturedNode
  //! atomic cursor pull over the diagnostics ring: {n, dropped} ride WITH the events so gaps are
  // computable from one call (a split read could misjudge truncation); never spliced, never reordered
  journal(from?: number): { n: number; dropped: number; events: JEvent[] }
  //! live subscriptions this node SERVES (the v2 leak guard: must return to 0 after an ungraceful peer drop)
  served(): number
  //! in-flight confirm probes, BOTH registries — api-level awaiters and kernel-level tallies; each must drain to 0
  confirms(): { api: number; kernel: number }
  //! Σ entries across all origin logs — the compaction assertion scalar (v2 parity)
  logSize(): number
  //! forced frontier-bounded compaction + tombstone GC NOW (size-gate-free — v2's drive-it-deterministically
  // purpose). HONEST REFUSALS, both 0: on an ARMED node (compaction is PINNED under scoping — the
  // member-ranged frontier is unsound for holders, kernel/log.ts; refusing here is memory-over-loss) and
  // on a destroyed node. Runs the composer's fold after, so cluster/journal surfaces never lag the pass.
  compact(): number
  //! abrupt socket destroy to an identified peer — what a real network drop looks like (the kernel hears
  // linkDown via 'close'; the peer typically redials within redialMs — a transient, not a partition).
  // OPTIONAL: present only on real-TCP backings; false = no identified live link to that uuid.
  drop?(uuid: string): boolean
  //! crash (V4-6): tear the instance down WITHOUT the graceful leave — a process death, as the cluster
  // sees it (no ballot; the survivors suspect, then evict). destroy() leaves first; this is drop()'s
  // fault-injection twin for tests and failure stories. OPTIONAL like drop().
  crash?(): Promise<void>
  //! the directory nodes this instance runs (V4-3): its `#directory` client and, when it won the bind,
  // the hosted `#directory` server — real Fero instances, so a tool can capture/diag them like any node.
  // null when the instance meets no directory (rendezvous: false, listen: false, a system resource).
  rendezvous(): { client: Fero | null; host: Fero | null } | null
}

//! diagnostics — the Symbol key. Not Symbol.for (a registry symbol would be forgeable); exported from
// fero/internals. `{...instance}` copies it (truthful) and getOwnPropertySymbols finds it (the escape
// hatch, by design); JSON/Object.keys/for-in never see it.
export const diagnostics: unique symbol = Symbol('fero.diagnostics')

//! diag — the one sanctioned door: undefined when the instance carries no handle (never throws).
export const diag = (f: Fero): Diagnostics | undefined =>
  (f as unknown as Record<symbol, Diagnostics | undefined>)[diagnostics]
