//! ── api/types — the exported public type vocabulary (plan §9: typed end-to-end) ──
// Everything a consumer can name lives here: the guarantee ladder, the write
// outcome unions, the config schema, and the composed instance shape. Substrate
// `any` is wrapped at api/substrate.ts and never propagates past this surface.

import type { Rec } from '../kernel/env.ts'

//! Guarantee — the confirm ladder a write can be awaited at. 'committed' = stamped + applied at the
// owner (coordinates known); 'replicated' = a majority of the committed view holds it in-log
// (shippable evidence, M4c); 'persisted' = a majority has fsync-RESOLVED it (durable evidence).
export type Guarantee = 'committed' | 'replicated' | 'persisted'

//! WriteResolve — a write that reached its asked guarantee: the commit coordinates, plus the attempt
// cid when the write took the attempt path (absent on epoch-0 fast-path commits).
export interface WriteResolve {
  guarantee: Guarantee
  key: string[]
  origin: string
  seq: number
  epoch: number
  cid?: number
}

//! WriteReject — a write that did NOT reach its asked guarantee inside its deadline. `reached` is the
// rung it provably got to ('issued' = accepted into the pipeline, coordinates unknown; 'committed' =
// coordinates known via localCommit). A reject is NOT a rollback claim: the kernel keeps retrying an
// issued attempt, and a committed write stays committed — the reject reports what could be PROVEN in
// time, mirroring M4c's honest-probe semantics.
export interface WriteReject {
  guarantee: Guarantee
  reached: 'issued' | 'committed'
  reason: string
  localCommit?: { origin: string; seq: number; epoch: number }
}

//! Change — the argument shape of the default write methods: key as name or path; value; `at` for
// ordered inserts. (`methods.update({key:'user42', value:{…}})` ≡ `data.user42 = {…}` — one ingest.)
export interface Change {
  key?: string | string[]
  value?: unknown
  at?: string
}

//! WriteOpts — the options argument (always separate from the payload, never in-band keys).
export interface WriteOpts {
  confirm?: Guarantee
  timeout?: number
}

//! Seams — the ONE reserved nested config key for function-valued config (plan §9), so the
// "functions are methods" recognition rule survives. M5a ships `validation` (the user-overridable
// hook BOTH assignment and methods.update pass through — v2's OQ6 closed by construction);
// hash/codec/storage land with their milestones.
export interface Seams {
  //! validation — return true to admit, or a reason string to reject (assignment bounces + reverts;
  // methods.* rejects with the reason). Runs at the ONE local ingest, before anything is issued.
  validation?: (rec: Rec) => true | string
}

//! FeroConfig — the declared, picked config schema. Unknown non-function keys throw at fero() time.
export interface FeroConfig {
  uuid?: string
  listen?: string
  hosts?: string[]
  dir?: string
  heartbeatMs?: number
  redialMs?: number
  journalCap?: number
  //! replicas (M6): scoped replication — each partition lives on exactly R holders. Omit for full
  // replication (every server holds everything). Integer ≥ 1; servers only.
  replicas?: number
  seams?: Seams
}

//! FeroOpts — config + methods in one bag, recognized by VALUE TYPE: function values are methods,
// everything else must be a declared config key. (No `methods:` wrapper key — plan §9 verbatim.)
export type FeroOpts = FeroConfig & { [method: string]: unknown }

//! Methods — the one RPC/write namespace. M5a ships the default writers; user methods + remote
// dispatch (return-type consumption, subscriptions) land at M5c.
export interface Methods {
  update(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  insert(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  remove(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  [method: string]: (...args: unknown[]) => unknown
}

//! Peer — one row of cluster.peers.
export interface Peer {
  uuid: string
  incarnation: number
  up: boolean
}

//! Partitions — the cluster.partitions row (M6, DESIGN-M6 C9): bounded, locally-derivable scalars
// (rates/alarms, never a per-partition firehose — partition→holders rows are keyspace-unbounded and
// were rejected). shedWaitingOn is the H7 surface: the uuids currently pinning any orphan's shed.
export interface Partitions {
  replicas: number // 0 = unscoped (R=∞)
  epoch: number
  w: number // derived write-quorum of the R-set (majority; never configurable)
  held: number
  acquiring: number
  orphaned: number
  acquired: number // lifetime counters
  shed: number
  shedWaitingOn: string[]
}

//! ScopedError — the typed refusal (plan §5/§9: an expression means the same at R=2 and R=∞; a
// holistic op on a scoped node throws THIS, never warn + local partial; a gather that cannot reach
// a partition's holders rejects with THIS, never a silent subset). `scoped: true` is the wire
// discriminant — a RESULT error value carrying it rehydrates as-is instead of an Error-string wrap.
export interface ScopedError {
  scoped: true
  op: string // 'group' | 'top' | 'gather' | 'get' | 'predicate' | …
  reason: 'holistic' | 'closure' | 'unreachable' | 'timeout' | 'shortfall'
  replicas: number
  partition?: string
  missing?: string[]
  hint: string
}

//! ClusterShape — the value under the `cluster` ViewProxy: the committed view {epoch, members,
// writable} reactive, peers as rows, `me` a derived row (v2 OQ5 closed). It IS a data proxy —
// query and connect it like any resource.
export interface ClusterShape {
  epoch: number
  writable: boolean
  members: Record<string, string>
  peers: Record<string, Peer>
  me: { uuid: string; origin: string; listen: string }
  partitions: Partitions
}

//! Fero — the composed instance. `data` and `cluster` are ViewProxies (dynamic by nature — reads
// mint child views); they are typed open here and by their value shapes above.
export interface Fero {
  name: string
  data: any
  methods: Methods
  cluster: any
  //! snapshot (v4.1): the synchronous dense value of the resource — data's [value] read surfaced
  // first-class (the render-loop idiom; no internals import). A fresh top container per access with
  // rows shared BY REFERENCE: mutating them corrupts the live projection (the documented data-model
  // footgun — methods.read() is the cloning path). On an armed scoped node it throws ScopedError:
  // a sync local read would be the shard, and a silent partial is never an answer (plan §9).
  readonly snapshot: unknown
  destroy(): Promise<void>
}
