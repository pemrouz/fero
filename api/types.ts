//! ── api/types — the exported public type vocabulary (plan §9: typed end-to-end) ──
// Everything a consumer can name lives here: the guarantee ladder, the write
// outcome unions, the config schema, and the composed instance shape. Substrate
// `any` is wrapped at api/substrate.ts and never propagates past this surface.

import type { ChildProcess } from 'node:child_process'
import type { Rec } from '../kernel/env.ts'
import type { Context } from './methods.ts'

//! Guarantee — the confirm ladder a write can be awaited at. 'committed' = stamped + applied at the
// owner (coordinates known); 'replicated' = a majority of the committed view holds it in-log
// (shippable evidence, M4c); 'persisted' = a majority has fsync-RESOLVED it (durable evidence).
// The bar is a majority OF THE COMMITTED VIEW, so it is SELF alone at epoch 0 (open genesis has no
// view) and in a view of one (after a clean leave to one): a majority of one is one — a solo resolves
// 'replicated' at once and, with dir, 'persisted' as soon as its own fsync lands.
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
  //! reason — 'timeout' | 'superseded' | 'dropped' | 'destroyed' (the kernel's outcomes), 'methods-only'
  // (the server takes client changes only through its `methods:` — V4-5), or the server's own
  // seams.validation string for a relayed record it refused (V4-4).
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
  //! validation — a SCHEMA check: what a record may look like, never who may write it. Return true to
  // admit, or a reason string to reject (a refused assignment never shows — V4-7; methods.* rejects
  // with the reason; inside a hosted method the CALL fails with it — V4-5). Runs at the ONE local ingest, before
  // anything is issued — the server's own writes, its handlers' ctx.data writes, the data: seed — AND,
  // on an OPEN server, at the relay ingress for the client writes it relays (V4-4: a refused relayed
  // write WNACKs `invalid` with the reason, so the client's promise rejects and a plain client
  // assignment is refused exactly like a local reject — nothing ever showed). Under `methods:` no client record ever reaches
  // it — the door refuses first. Keep it a pure function of the record: it runs inside the kernel step,
  // and a retransmit of an already-committed record is dup-ACKed without re-checking. Per-caller rules
  // belong in hosted methods (ctx.peer).
  validation?: (rec: Rec) => true | string
}

//! FeroConfig — the declared, picked config schema. Unknown keys throw at fero() time; so does a
// function-valued key (methods live under `methods:` — V4-5).
//! V4-10: the call is ONE of six layers (api/config.ts): a launch flag `--fero.<key>` beats the call,
// the call beats `FERO_<KEY>` in the environment, env beats a `fero.opt.ts` at the project or in $HOME,
// and every layer is beaten by a value scoped to this resource's name (`--fero.shop.dir`,
// `FERO_SHOP_DIR`, `{ shop: { dir } }`). Keys are nested lowercase words so one spelling survives every
// layer. Call-only (a function or a per-instance switch): methods, seams, signals; data also rides a
// file; uuid never comes from a file. `FERO_CONFIG=off` reads the call alone (the test battery).
//! Role (v4.1) is by DECLARED ACT: any server marker — server: true, listen, dir, replicas, a `data`
// seed, or `methods:` — makes a server; no marker makes a CLIENT dialing its hosts (or, bare, the
// servers the directory lists for the name). Role is a pure function of the config.
export interface FeroConfig {
  uuid?: string
  //! server — the explicit role pin: true = serve even with no other marker (binds a free loopback port
  // and registers it with the directory); false (V4-10) = the CLIENT pin: any server marker from any
  // layer is refused naming it, so a process meant to follow can never be turned into a server by a
  // stray flag, variable or file.
  server?: boolean
  //! listen — the dialable address; omitted on a server = a free loopback port (127.0.0.1:0, the
  // OS picks; cluster.me.listen shows it), published through the directory; false = the socketless
  // solo node (serves nothing, dials nothing, meets no directory — pure local; refuses hosts loudly).
  listen?: string | false
  //! hosts — static dial targets: alone = a client's feeders; beside a server marker = a dialing
  // member (the listen+hosts cluster shape). The directory's discovered set is UNIONED with them;
  // omitted on a bare client = the discovered set alone.
  hosts?: string[]
  //! rendezvous (V4-3) — the per-box directory every dialable node meets at. Precedence: this key >
  // the FERO_RENDEZVOUS environment variable (an address, or 'off' — it sets the PROCESS DEFAULT and
  // never overrides an explicit key) > the constant '127.0.0.1:3376'. A server registers
  // {name, uuid, listen} there; everyone looks its name up LIVE, and the addresses feed the kernel's
  // dial set. false = no directory at all (the pure-static shape). The first dialable server on the
  // box to bind the address hosts it — a discovery role only; the data role never depends on timing.
  // A user resource may not listen on a rendezvous socket under any spelling (`0.0.0.0:3376` too).
  rendezvous?: string | false
  dir?: string
  //! heartbeat.ms (V4-10 spelling; was heartbeatMs) — the one clock: pings, membership ticks, the write
  // retry clock, compaction and WAL-snapshot arming all run on it. 500 by default; 0 = off (an
  // explicit protocol mode, the sim's sweep mode). A cluster contract: every member the same.
  heartbeat?: { ms?: number }
  //! redial.ms (was redialMs) — the dial backoff base after a peer drops; doubles up to 32× the base.
  // 100 by default. redial.tries — how many times a dropped peer is dialed before the chain gives up
  // (heartbeats revive it); 10 by default, the kernel tune row `redials`. A dead MEMBER is dialed 5
  // times (the eviction clock, tune row `memberRedials`), or `tries` if that is lower.
  redial?: { ms?: number; tries?: number }
  //! journal.cap (was journalCap) — the diagnostics ring size; older events are dropped and counted.
  // 4096 by default; captures that want full-history time travel raise it.
  journal?: { cap?: number }
  //! replicas (M6): scoped replication — each partition lives on exactly R holders. Omit for full
  // replication (every server holds everything). Integer ≥ 1; implies the server role (v4.1).
  replicas?: number
  //! data (v4.1) — initial rows, applied ONLY when the local fold is empty at boot (a durable
  // restore or replayed state never re-seeds); rides the ordinary validated ingest. Implies server.
  data?: Record<string, unknown>
  //! methods (V4-5) — the hosted methods, AND THE DOOR: declaring them means clients change data ONLY
  // through them. Every relayed plain write from a client — assignment, delete, the write builtins,
  // methods.update/insert/remove (one ingest, the same bytes) — is refused at the relay with the
  // terminal reason 'methods-only' (the client's promise rejects typed; a plain assignment never shows).
  // The pin is about the WIRE: the server's own writes and its handlers' ctx.data writes are trusted
  // (they still meet seams.validation). Reads and subscriptions stay open — reads are not writes.
  // Omit it for an OPEN resource (anyone admitted may write anything — the demo shape). Open or
  // protected, nothing in between. `methods: {}` is a resource clients may only read. A handler gets
  // (arg, ctx): ctx.data is the server's own surface, ctx.peer the caller's uuid, ctx.flush() the
  // mid-body barrier. Names may not start with \u0000 (the system plane) or be update/insert/remove
  // (the built-in writers). Implies server.
  methods?: Record<string, (arg: any, ctx: Context) => unknown>
  seams?: Seams
  //! signals (V4-8) — the clean stop on Ctrl-C. By default every live instance destroy()s on SIGINT or
  // SIGTERM (the graceful leave, then teardown) and, if nothing else in the process listens for that
  // signal, the process exits 0. false keeps this instance out of it: stop it yourself.
  signals?: boolean
}

//! FeroOpts — the config bag. Recognition is by DECLARED KEY (V4-5 retired the "any function-valued
// option is a method" rule: a top-level function throws with a pointer to `methods:`).
export type FeroOpts = FeroConfig

//! Methods — the one RPC/write namespace. M5a ships the default writers; user methods + remote
// dispatch (return-type consumption, subscriptions) land at M5c.
export interface Methods {
  update(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  insert(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  remove(change: Change, opts?: WriteOpts): Promise<WriteResolve>
  [method: string]: (...args: unknown[]) => unknown
}

//! Peer — one row of cluster.peers: every identified live link, members and clients alike.
export interface Peer {
  uuid: string
  incarnation: number
  up: boolean
  //! client — the peer's ROLE as it declared it at HELLO: true = a spoke (never a view member), false = a
  // server. `Object.values(peers).filter((p) => p.client).length` is "my clients"; the row count is "my links".
  client: boolean
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
// query and connect it like any resource. The confirm ring is NOT in it: `cluster.writes` is its own
// handle (the last 64 write outcomes of THIS node, keyed by a counter: `{ key, state, origin?, seq?,
// epoch?, cid?, reason? }`) — `f.cluster.writes.snapshot()`, `f.cluster.writes.tap(…)` — so a bare
// `cluster.tap` repaints only when the view moves, and the ring is published one microtask after a write
// settles.
export interface ClusterShape {
  epoch: number
  //! writable (I-33), by role. A member: its own write-gate is open (it is in the committed view and
  // reaches a majority of it). A client: its feeder says its gate is open — read off the feeder's
  // digests, so one heartbeat behind at worst; false with no feeder, or before the feeder has said.
  writable: boolean
  members: Record<string, string>
  peers: Record<string, Peer>
  me: {
    uuid: string
    //! origin: the provenance lane this life stamps its writes under — the SAME string WriteResolve.origin
    // and cluster.writes[*].origin carry: the bare uuid in a node's first life, `uuid~N` from its Nth
    // (a durable restart bumps it; kernel/node.ts). incarnation: that N, the life counter.
    origin: string
    incarnation: number
    listen: string
    role: 'server' | 'client'
    //! primary: on a CLIENT, the uuid of the ONE server feeding it (a spoke digests exactly one) — null
    // until a link is admitted, and re-set to the survivor on failover; always null on a server
    primary: string | null
    //! hosts (V4-3): what this node was TOLD to dial — the configured `hosts` ∪ the addresses the
    // directory published for the name, minus its own listen — on every role. NOT the set the kernel
    // dials: it also dials every member the committed view teaches it, and a left member's address
    // stays here until the directory drops it. The LINKED set is `peers`.
    hosts: string[]
    //! rendezvous (V4-3): the directory this node meets at — false when it meets none (disabled, or
    // a socketless solo); `hosting` = this instance binds it; `up` = a directory link is admitted (a
    // bare client with `up: false` and `hosts: []` is "no directory on this box", distinct from
    // "nobody registered yet"); `error` = the last bind errno other than EADDRINUSE (EACCES: a
    // reserved band …) or the host's register refusal — absent when all is well
    rendezvous: { addr: string; hosting: boolean; up: boolean; error?: string } | false
  }
  partitions: Partitions
}

//! Fero — the composed instance. `data` and `cluster` are ViewProxies (dynamic by nature — reads
// mint child views); they are typed open here and by their value shapes above.
export interface Fero {
  name: string
  //! data — the live view: reads, plain-assignment writes and the operators. `data.tap((r) => …)` delivers
  // change records `{ type, key, value?, at? }`; a NEW top-level row arrives as
  // `{ type: 'insert', key: [], value, at: '<row>' }` — the row key rides `at` — while a rewrite or a
  // remove of that row carries it in key[0].
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

//! Spawned (V4-9) — what fero.spawn(file, args?, opts?) returns: a separate `node <file> …` process, the
// reader's other terminal from code. `out` is everything it printed to stdout so far; `exited` its exit
// code once it has ended and its output has drained (null when a signal ended it); `stop()` is the reader's Ctrl-C (SIGINT — a fero process leaves
// by ballot and exits 0, V4-8) and resolves that code, or null after five seconds of nothing (SIGKILL).
// `write(line)` types a line and Enter into the child's stdin — only a child spawned with
// `{ stdin: 'pipe' }` has one (the default 'ignore' closes it, so a role's readline ends at once); it
// throws when there is none or the child has exited. `child` is Node's handle for anything else.
export interface SpawnOpts {
  stdin?: 'pipe' | 'ignore'
}
export interface Spawned {
  pid: number
  out: string
  exited: Promise<number | null>
  stop(): Promise<number | null>
  write(line: string): void
  child: ChildProcess
}
