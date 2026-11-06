# fero v5: the public API, draft 1

Written 2026-11-06 for the v5 design-space study ([BRIEF.md](BRIEF.md)). This is the first exact draft of what an app developer writes against fero v5. E-22 builds a prototype of exactly this and runs every pattern on it ([QUESTIONS.md](QUESTIONS.md) Q-22). Sources: [DESIGN-V5.md](../DESIGN-V5.md) §3 to §6 (mostly §4.5); v4's public API ([api/index.ts](../../api/index.ts), [api/types.ts](../../api/types.ts), [examples/](../../examples)); [REQUIREMENTS.md](REQUIREMENTS.md) P-01 to P-22, DATA-01 to DATA-09 and TEST-01 to TEST-13; [SPACE.md](SPACE.md) §4 for the candidates.

**How sure each part is.**
- **Type-checked here.** Every `ts` block whose first line is `// file: …` compiles with TypeScript 6.0.2 against data's shipped types (data at 63fea66, Node 22.22.0). That includes the 22 pattern files and 10 lines that must *not* compile. §10 has the one command that re-checks this file.
- **Promised.** Each pattern's guarantee is the requirement it must meet. Nothing here is built or measured. E-22 tests the promises.
- **Reasoned.** The choices, the candidate notes and the proposed answers, unless a source is linked.

## 0. Words and layers

| Word | What it is here |
|---|---|
| partition | the unit of order and atomicity: one row, or the rows whose keys share a prefix (`partition: { before: '/' }`) |
| group | whatever holds one log and one writer: a shard, a cell or a lane, by candidate. Seen only in `cluster.groups` |
| writer | a group's leader: the one process that appends to its log |
| version | a row's place in its partition's order. An opaque string |
| cursor | where a reader is. An opaque string |
| attempt | one write or call, with an id that its retries keep |
| writer time | the writer's clock, clamped to its peers'; TTLs, leases and `ctx.now()` use it |
| session | one process's life, held by a lease it renews by itself; `while: 'session'` rows die with it |

The layers are DESIGN-V5 §4's. **L0** storage and io. **L1** the log. **L2** fold and ops: records to rows, conditions, ops, writer time, dedup, row expiry. **L3** flow: `follow`, `read`, cursors, relays, near caches. **L4** the surface: `fero()` and this file's verbs. **L5** libraries, built only from L4: queue, lock, group, derive, saga, limiter, service, migrate, tape, the gateways and the CLI.

## 1. The shape on one screen

```ts
// file: shape.ts — the whole surface on one screen
import { fero, op } from 'fero'

const shop = await fero('shop', { data: { widgets: { stock: 10 } } })      // a seed makes a server
shop.data.gadgets = { stock: 3 }                                           // a write by assignment
const sold = await shop.set(['widgets', 'stock'], op.incr(-1, { min: 0 })) // judged at the writer
const left = shop.snapshot.widgets.stock                                   // a sync read of a held row
const low = shop.data.lt('stock', 5)                                       // a live view: data's operator
low.tap(() => console.log('low', low.snapshot()))
const fresh = await shop.get('gadgets', { fresh: true })                   // a linearizable read
for await (const e of shop.read({ from: 'earliest' })) console.log(e.version, e.rec)   // the log, then live
console.log(sold.value, left, fresh)
```

## 2. What changes from v4, and why

**Kept, because it works and the examples teach it:** `fero(name, opts)` returning `{ name, data, methods, cluster, snapshot, destroy }`; writes by plain assignment; data's operators as live views; `methods:` as the door (V4-5); a write shows only once it commits (V4-7); the role by declared act; `validation:`; the seed; Ctrl-C as a clean stop (V4-8); `fero.spawn` (V4-9); `fero.clientKey`; the config cascade and its spellings (V4-10); the box directory on one box (V4-3); one process per `dir` (V4-59); a throw in user code goes to the Fault printer, never into fero (V4-47); the diagnostics door `diag(f)` stays off the typed surface, in `fero/internals`.

| v4 | v5 | Why |
|---|---|---|
| one cluster per resource; every key per resource | one cluster per project. Node keys (`listen`, `dir`, `secret`, …) are per process; a second `fero()` naming another value is refused `node-config` | DESIGN decision 5a: resources are catalog entries |
| options live in each process | resource keys live in the catalog: the server that creates the resource writes them; later opens must agree (`config-differs`) or use `fero.alter` | DESIGN §4.5; DEP-10 |
| built-in `methods.update/insert/remove/read` | the verbs `set`, `remove`, `get` on the resource; `methods` holds only your methods | one write path; your method names no longer collide |
| `confirm: 'committed' \| 'replicated' \| 'persisted'` per write | one answer, after commit at the resource's `durability` (default `persisted`) | one commit point per resource: v4's lower rungs (stamped at the owner; in a majority's log) no longer exist, and decision 23a cuts `confirm: 'sent'` |
| `WriteResolve { origin, seq, epoch }` | `Ack { key, version, attempt, value }`, the version opaque | positions must keep their meaning across moves and every candidate (SC-08(d), DEV-09) |
| `WriteReject { reached, reason }` and `ScopedError` | one `FeroError { code, outcome }` | one thing to catch; `outcome` says plainly whether it may have committed (F-02) |
| a cell keeps its newest stamp (LWW; example 17 loses an increment) | log order per partition, judged at one writer; `op.incr` instead of read-modify-write | P-11, P-14, DATA-01 |
| `replicas: R` | `copies` (voters) and `standbys` (full replicas) | DESIGN §4.5 |
| `heartbeat.ms` | the cluster key `ping.ms` | one clock per cluster, kept in `#meta` |
| `secret: { client }` | `token`: the client key, or a signed token with claims | OPS-06, OPS-10 |
| `cluster.epoch`, `members` (the view), `partitions` | `cluster.members`, `groups`, `health`, `numbers`; `cluster.writes.lookup(id)` | OPS-02, OPS-08, F-09 |
| a server keeps rows in memory unless `dir` | a server keeps a disk by default (`.fero/<project>/m<n>`); `dir: false` is memory only, and health says so | the default rung is `persisted`; see Q-A3 |
| `await f.data` gathers a scoped resource | `get(key)`, `follow(sel)`, `read({ from })` | P-03, P-07 |
| `validation(rec)` gets fero's numeric record | it gets data's record (`type: 'update' \| 'insert' \| 'remove'`) | the public record is data's; the wire bytes stay as they are (DATA-03) |
| `ctx.peer` | unchanged, plus `ctx.claims`, `ctx.session`, `ctx.key`, `ctx.now()`, `ctx.id()`, the verbs, `ctx.use(other)` | TEST-02, TEST-03 |
| — | new: ops, conditions, `ttl`, sessions, `claim`, `batch`, call keys, `rules`, `history`, `rows`, `durability`, `partition`, `load`, `shape`, `schema`, `alter`, `drop`, `fork`, `erase`, tokens, the L5 libraries | P-02 to P-22 |
| `seams`, `replicas`, `heartbeat`, `confirm` | removed | above |

## 3. The declarations

`data` here is the data engine's own type file, so views are typed by data (DATA-05). The libraries are named exports of `'fero'`, so a browser bundle keeps only what it imports.

```ts
// file: fero.d.ts — fero v5's public API, draft 1. Declarations only.
// Views are data's operators, so their types are data's own (DATA-05).
import type { Ops, View, ChangeRecordV2, ReadonlyData } from 'data'
/** One change as fero logs, sends and folds it: data's record minus order moves (DATA-03). */
export type Rec = Exclude<ChangeRecordV2, { type: 'move' }>

// ── words ────────────────────────────────────────────────────────────────
export type Key = string                                     // a top-level row key
export type Path = readonly [Key, ...(string | number)[]]    // a cell: the row key, then a field path
export type Partition = string                               // the unit of order; by default the row key
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`   // a number is milliseconds
export type Size = number | `${number}${'B' | 'KB' | 'MB' | 'GB' | 'TB'}`    // a number is bytes
/** A row's version, a record's position, a lock's token. Opaque. Two versions of ONE partition
 *  compare with plain string `<` in log order, across failovers, moves and restores; versions of
 *  different partitions have no order (fero test's shuffle makes code that leans on one fail). */
export type Version = string & { readonly __fero: 'version' }
/** Where a reader is. Opaque and serialisable; its size bound is stated per candidate
 *  (about 8 KB for a whole resource of 1,024 slots). */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
/** Writer time: milliseconds since the epoch, by the writer's clamped clock (L2). */
export type Time = number

// ── fero(name, opts) ─────────────────────────────────────────────────────
export declare function fero<Row = any, M extends Handlers<Row> = Handlers<Row>>(
  name: string,
  opts?: Options<Row, M>,
): Promise<Resource<Row, M>>

/** One bag, three scopes. A key's scope says who keeps it and when it may change. */
export type Options<Row = any, M extends Handlers<Row> = Handlers<Row>> =
  NodeOptions & ResourceOptions<Row, M> & OpenOptions

/** Node scope: this process. Set by the first fero() in the process or by the config cascade;
 *  a later fero() that names a different value is refused 'node-config'. Change = restart. */
export interface NodeOptions {
  project?: string           // default: the `name` in the nearest package.json, else its folder's name
  uuid?: string              // member id; default: random, kept in `dir`
  server?: boolean           // default: by declared act (any server marker); false = the client pin
  listen?: string | false    // server default: a free loopback port; false = a socketless solo node
  advertise?: string         // the address others dial; default: `listen`
  hosts?: string[]           // dial targets; default: [] plus what the box directory lists
  seeds?: string[]           // the founding members across boxes; default: none (one box founds by file)
  dir?: string | false       // server default: .fero/<project>/m<n> next to package.json, the first unlocked; false = memory only
  object?: string | false    // 'file:///…' or 's3://bucket/prefix'; default: .fero/<project>/objects on one box; set it across boxes (decision 23a)
  secret?: string | false    // the members' shared secret (the door); never a flag
  token?: string             // a client's credential: fero.clientKey(secret) or a fero.token(...)
  admin?: string             // the admin key: planner hints, drop, recover; never a flag
  rendezvous?: string | false  // the box directory; default '127.0.0.1:3376'
  redial?: { ms?: number; tries?: number }   // default 100 ms, 10 tries
  leave?: { ms?: number }    // how long a clean stop asks to be voted out; default 8000
  journal?: { cap?: number } // the diagnostics ring; default 4096
  diag?: { allow?: Record<string, string> }  // debugger attach tokens; never a flag
  memory?: Size              // this server's memory bound; near it, writes are refused 'read-only' with the reason
  connect?: { wait?: Duration }   // how long to look for a cluster before saying who is missing; default '10s'
  shuffle?: boolean | number // TEST-12: interleave partitions in a seeded order; default on under a world, off live
}
export type Bind = 'live' | 'sim' | `tape:${string}` | `./${string}`

/** Resource scope: the catalog. The fero() that creates the resource writes these; from then on a
 *  key you pass must equal the catalog's (else 'config-differs'), and a key you leave out takes
 *  the catalog's. Change them online with fero.alter. */
export interface ResourceOptions<Row = any, M extends Handlers<Row> = Handlers<Row>> {
  partition?: { before: string }    // rows whose keys share the text before `before` are one partition; default: each row
  history?: History                 // default 0: only what recovery needs
  rows?: boolean | RowsRule<Row>    // default true; false = no state (a stream)
  durability?: 'persisted' | 'none' // default 'persisted'; 'none' needs rows: false
  copies?: 1 | 3 | 5                // voters per group; default 3 (1 while fewer than three servers exist)
  standbys?: number                 // full replicas per group, voters included; default: every server, up to 5
  data?: Record<Key, Row>           // the seed: applied once, when the resource is created
  methods?: M                       // the hosted methods, AND the door: clients then write only through them
  validation?: (rec: Rec) => true | string   // where a write enters, and again at the writer
  schema?: Schema<Row>              // checked at the writer; refused 'schema' with the path
  rules?: {
    write?: (who: Who, rec: Rec, current: Row | undefined) => true | string   // at the writer
    read?: (who: Who, partition: Partition) => boolean                         // where a follow is served
  }
  load?: (key: Key, ctx: { now(): Time }) => Row | undefined | Promise<Row | undefined>  // read-through, once per key per miss
  shape?: { version: number; up?: Record<number, Upcaster> }   // default { version: 1 }
}
export type History = 0 | 'all' | number /* records */ | `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}${'KB' | 'MB' | 'GB' | 'TB'}`
export interface RowsRule<Row> {
  ttl?: Duration          // removed this long after its last write or touch, by writer time
  max?: number            // past it, the rows with the oldest last write are removed
  where?: (row: Row) => boolean   // rows for which it is false are removed
  while?: 'session'       // every row lives while the session that wrote it lives (presence)
}
/** One version step: a record written under version n, as the code of version n + 1 expects it.
 *  A snapshot row is passed as a whole-row update. null drops the record. */
export type Upcaster = (rec: Rec) => Rec | readonly Rec[] | null
/** Standard Schema v1 (standardschema.dev): zod, valibot, arktype and others implement it. */
export interface Schema<Row> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): { value: Row; issues?: undefined } | { issues: readonly { message: string; path?: readonly PropertyKey[] }[] }
  }
}

/** Open scope: this process's handle only. Never written anywhere. */
export interface OpenOptions {
  cache?: { memory: Size }  // a near cache: follow only what this process reads or follows, inside this bound
  signals?: boolean         // Ctrl-C and SIGTERM stop this handle cleanly; default true
  bind?: Bind               // fero test: what this name resolves to; usually --fero.<name>.bind
}

// ── the resource ─────────────────────────────────────────────────────────
export interface Resource<Row = any, M extends Handlers<Row> = Handlers<Row>> extends Verbs<Row> {
  readonly name: string
  /** The live view: sync reads of held rows (property sugar gives data's child handles),
   *  plain-assignment writes (`f.data.k = row`, `f.data.k.field = x`, `delete f.data.k`, an op
   *  value), and data's operators, whose results are live views. */
  readonly data: LiveData<Row>
  /** The rows this process holds, immutable, at the last commit it applied. Reading a row is a
   *  property read. A row of a partition it does not hold throws 'shortfall'; enumerating a
   *  partial picture throws 'holistic'. */
  readonly snapshot: Readonly<Record<Key, Row>>
  readonly methods: Callers<M>
  readonly cluster: ClusterView
  /** Close this handle. The last handle of a server process also leaves the cluster (retire and
   *  hand over), or only hands over under FERO_SUPERVISED. true when every step finished in time. */
  destroy(): Promise<boolean>
  /** OPS-13: remove a partition's rows and every copy of its records within 30 days; replays
   *  and forks then show an 'erased' marker. Servers only. */
  erase(partition: Partition): Promise<void>
}

/** The verbs shared by a resource, a method's ctx, and a library's scoped writer. */
export interface Verbs<Row = any> {
  // reads
  get(key: Key, opts: GetOpts & { version: true }): Promise<{ value: Row; version: Version } | undefined>
  get(key: Key, opts?: GetOpts): Promise<Row | undefined>
  get(key: Path, opts?: GetOpts): Promise<unknown>
  follow(sel: Partition | readonly Partition[] | { prefix: string } | { share: Share }): Follow<Row>
  read(opts: ReadOpts): LogReader<Row>
  // writes: each answers after its commit, at the resource's durability
  set(key: Key, value: Row | Op, opts?: WriteOpts): Promise<Ack>
  set(key: Path, value: unknown, opts?: WriteOpts): Promise<Ack>
  remove(key: Key | Path, opts?: WriteOpts): Promise<Ack>
  touch(key: Key, opts?: { ttl?: Duration; timeout?: Duration }): Promise<Ack>
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
  batch(writes: readonly BatchWrite<Row>[], opts?: { timeout?: Duration }): Promise<Ack[]>
}

export interface GetOpts {
  fresh?: boolean      // linearizable: the writer confirms it still leads (read index); one round trip, no fsync
  version?: boolean    // also answer the row's version
  timeout?: Duration   // default '10s'
}
export interface WriteOpts {
  if?: Cond            // every condition given must hold at the writer, or 'conflict' ('fenced' for a fence)
  ttl?: Duration       // this row's ttl, from this write
  while?: 'session'    // this row lives while the writer's session lives (in a method: the caller's)
  timeout?: Duration   // default '10s'; past it the promise rejects 'timeout' (outcome unknown)
}
export interface Cond {
  absent?: true        // the row does not exist
  present?: true       // the row exists
  version?: Version    // the row's version is exactly this
  equals?: unknown     // the value at the key or path deep-equals this
  fence?: Fence        // no token for this lock newer than this one has been seen by this writer
  expired?: true       // the row is absent, or its ttl has passed by writer time
}
export interface Fence { lock: string; token: Version }

/** An op value: the writer computes the value to append (L2). Usable with set, batch and assignment. */
export interface Op { readonly __op: 'incr' | 'push' | 'merge' | 'max' | 'min' }
export declare const op: {
  incr(n: number, bounds?: { min?: number; max?: number }): Op   // a bound that would be crossed: 'conflict'
  push(...items: unknown[]): Op
  merge(fields: Record<string, unknown>): Op
  max(x: number | string): Op
  min(x: number | string): Op
}

export interface Ack {
  key: Path
  version: Version     // the record's position, now the row's version
  attempt: AttemptId
  value?: unknown      // what an op appended (incr: the new number)
}
export interface BatchWrite<Row = any> {   // all in one partition, all or none
  key: Key | Path
  value?: Row | Op | unknown
  remove?: true
  if?: Cond
  ttl?: Duration
}
export interface ClaimOpts<Row> {
  partition: Partition
  n?: number                                  // default 1
  lease: Duration
  where?: (row: Row, t: Time) => boolean      // runs at the writer
}
export interface Claimed<Row> {
  key: Key
  value: Row
  token: Version       // the row's version after the claim: ack with `if: { version: token }`
  until: Time          // the lease ends, by writer time
  deliveries: number
}

// ── reads ────────────────────────────────────────────────────────────────
/** fero's lens over data: data's operators, plus assignment writes on any row key. */
export interface LiveData<Row> extends Ops<Record<Key, Row>> {
  [key: string]: any
  snapshot(): Readonly<Record<Key, Row>>
}
/** state mode: a snapshot of exactly the selected partitions, then deltas; a slow reader is
 *  conflated per row; a snapshot replaces the whole picture between begin and end markers.
 *  Read-only: write through the resource. */
export interface Follow<Row> extends LiveData<Row> {
  readonly ready: Promise<void>   // the first snapshot has landed; reads before it throw 'shortfall'
  cursor(): Cursor
  close(): void
}
/** One of `of` equal, fixed shares of a resource: a partition is in one share forever.
 *  `of` is at most the candidate's fixed bucket count (stated in SC-10). */
export interface Share { index: number; of: number }
export interface ReadOpts {
  from: Cursor | 'earliest' | 'latest'
  partitions?: readonly Partition[]
  prefix?: string
  share?: Share
  credit?: Size                            // in-flight bytes; default '1MB'; a grant always admits one record
}
/** log mode: every committed record of the selection from the cursor, in order per partition,
 *  never conflated. It opens when read() is called, so 'latest' is the log's end at that moment.
 *  Iterating throws 'expired' (with `earliest`) or 'unknown-log'. */
export interface LogReader<Row> extends AsyncIterable<Entry<Row>> {
  readonly cursor: Cursor   // just after the last entry yielded
  readonly gaps: number     // durability 'none' only: restarts at 'latest' after a writer change
  close(): void
}
export interface Entry<Row> {
  rec: Rec                  // data's record, verbatim (DATA-03)
  row?: Row                 // rec.value when the record writes a whole row
  partition: Partition
  version: Version
  t: Time
  reason?: 'ttl' | 'max' | 'where' | 'session' | 'erased'   // why the writer removed a row
}

// ── methods ──────────────────────────────────────────────────────────────
export type Handler<Row = any> = (arg: any, ctx: Ctx<Row>) => unknown
export type Handlers<Row = any> = Record<string, Handler<Row>>
export interface Ctx<Row = any> extends Verbs<Row> {
  readonly data: LiveData<Row>      // a scope over this resource's surface; writes are this call's
  readonly peer: string             // the caller's id (the server's own on a local call)
  readonly claims: Claims | null    // the caller's token claims
  readonly session: string          // the caller's session (what `while: 'session'` binds to)
  readonly key?: string             // the call key, when the caller gave one
  now(): Time                       // keyed: the call claim's writer time; else this server's clock; virtual under a world
  id(): string                      // keyed: derived from the call key and a counter, so a re-run sees the same ids
  flush(): Promise<void>            // this call's writes so far have committed
  use<R2>(other: Resource<R2, any>): Verbs<R2>   // another resource, with writes attributed to this call
}
export type Callers<M> = {
  [K in keyof M]: M[K] extends (arg: infer A, ctx: any) => infer R
    ? (...args: undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) => CallOf<R>
    : never
}
type CallOf<R> = unknown extends R ? LiveCall<any> : Awaited<R> extends View<infer T> ? LiveCall<T> : Call<Awaited<R>>
export interface CallOpts {
  key?: string        // an input key: runs at most once within `ttl`; a retry gets the first result
  ttl?: Duration      // default '1d'
  timeout?: Duration  // default '10s'
}
export interface Call<R> extends PromiseLike<R> {}
/** A method that returns a view streams: await it for one picture, open() it for a live mirror. */
export interface LiveCall<T> extends Call<T> {
  open(): ReadonlyData<T>
  close(): void
}

// ── identity ─────────────────────────────────────────────────────────────
export interface Claims {
  sub: string                     // who
  follow?: readonly string[]      // partitions or 'prefix*' this client may follow
  call?: readonly string[]        // methods it may call
  write?: readonly string[]       // partitions or 'prefix*' it may write plainly (open resources)
  exp?: Time
  [claim: string]: unknown
}
export interface Who { peer: string; claims: Claims | null; session: string }

// ── cluster and health ───────────────────────────────────────────────────
export interface ClusterView {
  snapshot(): ClusterShape
  tap(fn: () => void): ClusterView
  readonly writes: WritesView
}
export interface ClusterShape {
  id: string                  // the cluster id minted at genesis
  project: string
  writable: boolean           // every group of this resource has a writer that heard from a majority within election.ms
  me: {
    id: string
    life: string              // random per process start
    role: 'server' | 'client' | 'solo'
    listen: string | false
    advertise?: string
    caughtUp: boolean         // every group this process replicates is within lag.max of its commit
    lag: number               // records behind, the largest over its groups
    primary: string | null    // a client: the server feeding it
  }
  members: Record<string, { listen: string; roles: ('server' | 'log')[]; state: 'live' | 'draining' | 'retiring' | 'gone'; up: boolean }>
  groups: Record<string, {    // the units that each hold a log and one writer (DESIGN-V5's shards)
    voters: string[]; learners: string[]; leader: string | null; live: number; lag: number
    shares: number            // how many of the resource's fixed buckets it holds
  }>
  numbers: { writesPerSec: number; waitingWrites: number; lag: number; memory: number; clients: number }
  health: HealthRow[]         // empty when all is well
}
export interface HealthRow {
  kind: HealthKind
  severity: 'info' | 'warn' | 'down'
  since: Time
  message: string             // the cause, one line, also printed once on stderr
  fix: string
  group?: string
  member?: string
  value?: number
  limit?: number
}
export type HealthKind =
  | 'one-voter' | 'under-replicated' | 'no-writer' | 'meta-down' | 'catching-up' | 'two-machines'
  | 'limit' | 'disk-full' | 'read-only' | 'memory-only' | 'busy' | 'quarantined' | 'divergence'
  | 'skew' | 'slow' | 'version' | 'unplaced'
export interface WritesView {
  snapshot(): WriteRow[]      // this process's last 64 attempts
  tap(fn: () => void): WritesView
  lookup(id: AttemptId): Promise<WriteRow>   // asks the writer: committed, refused, or unknown past the horizon
}
export interface WriteRow {
  id: AttemptId
  key: Path
  state: 'pending' | 'committed' | 'refused' | 'unknown'
  version?: Version
  code?: Code
}

// ── errors ───────────────────────────────────────────────────────────────
export declare class FeroError extends Error {
  readonly code: Code
  /** 'refused': it never committed and never will (for a call: it is over and will not run
   *  again; writes it made before a throw stay). 'unknown': it may have committed;
   *  cluster.writes.lookup(attempt) tells later. */
  readonly outcome: 'refused' | 'unknown'
  readonly resource: string
  readonly key?: Path
  readonly attempt?: AttemptId
  readonly retryAfter?: number    // ms
  readonly current?: Version      // conflict, fenced
  readonly earliest?: Cursor      // expired
  readonly path?: readonly PropertyKey[]   // schema
  readonly reason?: string        // invalid, rule, read-only: the rule's own words
  readonly cause?: Code           // timeout: the last answer before it
  readonly hint: string           // the fix, one line
}
export type Code =
  // writes (L2, at the writer)
  | 'conflict' | 'fenced' | 'absent-row' | 'absent-path' | 'sparse-hole' | 'invalid-key' | 'unencodable'
  | 'too-large' | 'cross-partition' | 'no-rows' | 'schema' | 'invalid' | 'rule' | 'rule-threw' | 'rule-timeout'
  | 'methods-only' | 'forbidden' | 'call-diverged' | 'read-only' | 'disk-full' | 'backpressure'
  // reads (L3, L4)
  | 'shortfall' | 'holistic' | 'expired' | 'unknown-log' | 'schema-changed'
  // calls (L4)
  | 'no-method' | 'threw' | 'busy'
  // either: the outcome is unknown
  | 'timeout' | 'unknown' | 'destroyed'
  // libraries (L5)
  | 'locked' | 'limited' | 'no-answerer'
  // config and admin
  | 'config' | 'node-config' | 'config-differs' | 'too-many-resources' | 'admin-only' | 'stale-plan'
  | 'dir-held' | 'wrong-project' | 'wrong-cluster' | 'no-server-here' | 'unbound'
  // inside fero only: the client retries; seen only in cluster.writes and the debugger
  | 'no-writer' | 'moved' | 'retry' | 'wrong-group' | 'stale-attempt' | 'empty'

// ── fero's statics ───────────────────────────────────────────────────────
export declare namespace fero {
  function id(): string          // unique; time-sortable; seeded under a world
  function now(): Time           // the wall clock; the world's under test
  function alter(name: string, change: Alter): Promise<void>   // online; resolves once every server runs it
  function drop(name: string): Promise<void>                    // admin key if the cluster has a secret; a re-created name never shows old rows
  function fork(name: string, opts: { as: string; at?: Cursor /* now */ }): Promise<void>   // costs one record per group
  function token(claims: Claims, opts?: { ttl?: Duration /* '1h' */ }): string    // needs `secret`
  function revoke(sub: string): Promise<void>                   // its tokens stop working within one ping.ms
  function clientKey(secret: string): string
  function spawn(file: string, args?: string[], opts?: { stdin?: 'pipe' | 'ignore' }): Spawned
  /** Binds this process: later fero() calls resolve in it. seed default: random, printed;
   *  start default 0; shuffle default true. */
  function world(opts?: { seed?: number; start?: Time; shuffle?: boolean }): World
}
export type Alter =
  | Partial<ResourceOptions<any, any>>
  | { gate: string | null }       // admin: refuse writes with this reason while reads go on (DEP-11); null opens
  | Partial<ClusterKeys>          // with name '#meta'
/** Cluster scope: kept in #meta; fero.alter('#meta', {...}) checks ranges and cross-key rules. */
export interface ClusterKeys {
  'copies.meta': 1 | 3 | 5          // default 3 from three members
  'copies.default': 1 | 3 | 5       // default 3
  'ping.ms': number                 // default 500
  'election.ms': number             // default 2000 (TS) / 1000 (native); > 2 × ping.ms
  'election.jitter': number         // default 500 / 250
  'evict.after': Duration           // default '10m'
  'settle.ms': number               // default 30000
  'catchup.max': Duration           // default '10m'
  'skew.max': number                // default 250; < election.ms
  'lag.max': number                 // records; default 1000
  'issuer.window': number           // default 1024; may only rise online
  'session.ms': number              // presence lease; default 10000
}
export interface Spawned {
  pid: number
  out: string
  exited: Promise<number | null>
  stop(): Promise<number | null>
  write(line: string): void
  child: unknown            // Node's ChildProcess
}
export interface World {
  readonly seed: number
  now(): Time
  id(): string
  advance(by: Duration): Promise<void>   // move virtual time; timers, leases and TTLs fire in order
  close(): Promise<void>
}

// ── L5 libraries: each one file, built only from the verbs above, no wire verb of its own ──
export declare function queue<Job = unknown>(name: string, opts?: QueueOpts): Promise<Queue<Job>>
export interface QueueOpts {
  lease?: Duration          // default '30s'
  deliveries?: number       // default 5; then the message moves to `${name}.dead`
  history?: History         // default 0; '7d' keeps an audit trail
}
export interface Queue<Job> {
  readonly name: string
  readonly dead: Resource<Job>
  add(job: Job, opts?: AddOpts): Promise<{ id: string }>
  take(n?: number, opts?: TakeOpts): Promise<Msg<Job>[]>   // an empty take writes nothing
  /** returns: ack; throws: nack. Default: every partition, spread over the live workers by shares. */
  work(fn: (job: Job, msg: Msg<Job>) => unknown, opts?: { concurrency?: number /* 1 */; partitions?: readonly Partition[] }): Runner
}
export interface AddOpts {
  partition?: Partition     // FIFO within a partition; default 'main'
  id?: string               // idempotent: a second add of the same id is a no-op
  delay?: Duration
  at?: Time
  cron?: string             // five fields, writer time, UTC; needs `id`
  priority?: number         // 0 (first) to 9; default 4 (S)
}
export interface TakeOpts {
  partitions?: readonly Partition[]   // default ['main']
  wait?: Duration           // wait up to this long for a message; default 0; writes nothing while waiting
  lease?: Duration          // default: the queue's
}
export interface Msg<Job> {
  readonly id: string
  readonly job: Job
  readonly deliveries: number
  readonly until: Time
  ack(): Promise<void>                        // 'conflict' if the lease had lapsed and it was taken again
  nack(opts?: { delay?: Duration }): Promise<void>
  extend(lease?: Duration): Promise<void>
}
export interface Runner { readonly lag: number; stop(): Promise<void> }

export declare function lock(name: string, opts?: LockOpts): Promise<Lock>
export interface LockOpts {
  lease?: Duration             // default '10s'
  wait?: Duration | 'forever'  // default 0: one try, else 'locked'
  renew?: boolean              // renew every lease/3 while held; default true
}
export interface Lock {
  readonly name: string
  readonly token: Version      // strictly rises across holders, failovers, moves and restores
  readonly fence: Fence        // pass as `if: { fence }` on every protected write
  readonly lost: Promise<void> // the lease lapsed before a renewal landed
  renew(): Promise<void>       // only needed with renew: false
  release(): Promise<void>
}

export declare function group<Row>(source: Resource<Row, any>, name: string, opts?: GroupOpts): Promise<Group<Row>>
export interface GroupOpts {
  from?: 'earliest' | 'latest'   // where a new group starts; default 'earliest'
  lease?: Duration               // membership lease; default '10s'
  max?: number                   // entries per batch; default 100
}
export interface Group<Row> extends AsyncIterable<GroupBatch<Row>> {
  readonly member: string
  readonly generation: number
  readonly owned: number         // shares this member owns now
  /** effectively once: out's writes carry attempt ids made from the entry's position, so a
   *  re-run after a crash writes nothing twice; the cursor commits after them. */
  run(fn: (e: Entry<Row>, out: Out) => unknown): Runner
  leave(): Promise<void>
}
export interface GroupBatch<Row> {
  readonly entries: Entry<Row>[]
  commit(): Promise<void>        // 'fenced' when this member's generation has passed
}
export interface Out { use<R2>(target: Resource<R2, any>): Verbs<R2> }

export declare function derive<A, B>(
  source: Resource<A, any>, target: Resource<B, any>,
  fn: (e: Entry<A>, out: Verbs<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>

export declare function saga(steps: readonly Step[], opts?: SagaOpts): Promise<Ack[]>
export interface Step {
  to: Resource<any, any>
  key: Key | Path
  value?: unknown            // a value or an op
  remove?: true
  if?: Cond
}
export interface SagaOpts {
  id?: string                // default fero.id(); a later holder that finds the intent finishes or undoes it
  lease?: Duration           // the locks' lease; default '10s'
}

export declare function limiter(name: string, opts: { max: number; per: Duration }): Promise<Limiter>
export interface Limiter {
  take(key: string, n?: number): Promise<{ left: number; reset: Time }>   // else 'limited', with retryAfter
}

export declare function service<Req = unknown, Res = unknown>(name: string, opts?: { durability?: 'none' | 'persisted' /* 'none' */ }): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string /* 'main' */; concurrency?: number /* 1 */ }): Runner
  ask(req: Req, opts?: { timeout?: Duration /* '10s' */; group?: string }): Promise<Res>   // 'no-answerer' at once, or 'timeout'
}

/** perSec default: adaptive; it backs off while commit p99 is above twice its steady value. */
export declare function migrate<A, B>(res: Resource<A, any>, opts: { to: number; fn: (row: A) => B; perSec?: number }): Promise<MigrateJob>
export interface MigrateJob { readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }

export declare function tape<In = unknown, Out = unknown>(name: string, opts?: { window?: Duration /* '14d' */ }): Promise<Tape<In, Out>>
export interface Tape<In, Out> {
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
  replay(from?: Cursor): AsyncIterable<{ match: string; input: In; answer: Out; version: Version }>
}

/** A protocol front so each competitor's own tool can drive fero (PERF-01); E-45 builds them. */
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string /* 'kv' */ }): Promise<{ close(): Promise<void> }>
```

## 4. What the types cannot say

**Roles.**
- A process is a **server** if it sets any server marker: `server: true`, a `listen` address, a `dir`, `seeds`, `data`, `methods`, or a code key (`validation`, `schema`, `rules`, `load`, `shape.up`). Otherwise it is a **client**. `listen: false` is a socketless solo node: the only voter of every group, for tests (TEST-01).
- **Only a server creates a resource.** A client's `fero(name)` resolves at once. Until a server defines the name, the client's writes wait as `pending` rows of `cluster.writes`, and `cluster.health` shows `unplaced`. So example 03 still starts the client first.
- A client **follows the whole resource**, unless it sets `cache.memory`. Then it follows only the partitions it reads or `follow`s, and drops the least recently read when full.
- A server folds the groups it replicates (by default every server, up to `standbys`: 5). Other rows are one hop away, as on a client.
- Node keys come from the first `fero()` in the process or from the cascade, never per name: `--fero.shop.dir` is refused `config`. Resource and open keys may be per name (`--fero.shop.history 7d`).

**Answers.**
- Every verb answers **after its commit**, at the resource's durability. `persisted`: a majority of the group's voters has it on disk. `none`: the writer took it.
- If this process follows the partition, the promise resolves only once its own view shows the write (read-your-writes).
- A **plain assignment** is the same write with no promise. It shows when it commits. A refused one never shows; it appears as a `refused` row of `cluster.writes` and as one stderr line.
- `outcome: 'refused'` means it never committed and never will (F-02). `outcome: 'unknown'` (`timeout`, `unknown`, `destroyed`) means it may have. fero keeps retrying that attempt in the background until it gets a definite answer, or until half the retry horizon (5 minutes) has passed; `cluster.writes.lookup(attempt)` says how it ended.
- **fero retries by itself**, with jittered backoff from 200 ms to `election.ms`, and honours every `retryAfter`. An app never resends a write. A new try of the same change is a new attempt, judged afresh.

**At the writer (L2), in this order:** dedup; shape checks (`absent-row`, `absent-path`, `sparse-hole`); `validation`, `schema` and `rules.write`; conditions; ops. The writer appends results only, and followers, clients and replays apply plain values. So writer-side code may be non-deterministic, but it must be synchronous and must not read app state. `load` is the exception: it is asynchronous and lands later as an ordinary write.

**Ops on what is missing.** An op on a missing row, or on a missing field of a row that exists, starts from its identity: `incr` from 0, `push` from `[]`, `merge` from `{}`; `max` and `min` take the value. A field write or a field op on a row that does not exist is refused `absent-row` (decision 14a). So a counter is its own row (`views.set('page:/', op.incr(1))`), or a field of a row you created first.

**Reads.**
- `f.data`, `f.snapshot`, a `follow` view, and `get` of a held row read this process's committed fold, with no hop. A row handed out is deep-frozen, so a read by reference cannot change it (DATA-07).
- Every read carries the highest version this process has seen in that partition, and a server answers only once its fold has reached it. So a process never reads older than what it already saw or wrote.
- `get(key, { fresh: true })` is linearizable: the writer confirms it still leads (Raft's read index), then answers. One round trip, no fsync.
- **Sync reads never guess.** A row of a partition this process does not hold throws `shortfall`. Enumerating, or an operator over every row, on a partial picture throws `holistic`.

**Order.** Total within a partition. None across partitions, ever. Under a world, and with `shuffle`, deliveries interleave partitions in a seeded random order that keeps each partition's own order, so code that leans on order across partitions fails in test (TEST-12).

**Versions.** Two versions of one partition compare with plain string `<`, in log order, across failovers, moves and restores. So an outside system can check a lock token with `<` (P-10). Versions of different partitions have no order.

**Methods.**
- A handler runs on the server the caller reached. `ctx.data` is that server's committed fold, which may trail the writer. So a check-then-set must carry a condition (`if: { version }`) or be an op (Q-A8).
- A **keyed call** (`{ key }`) claims a row in `#calls` first, runs at most once within its `ttl`, and a retry gets the first result. If its server dies, it is re-run elsewhere when the claim's lease lapses, with the same attempt ids and the same `ctx.now()` and `ctx.id()`. So handlers must be deterministic given `arg` and `ctx`. A re-run that writes something different is refused `call-diverged`.
- An **unkeyed call** whose server dies answers `unknown`: it may have run. fero does not resend it.
- A handler that returns a data view streams (`LiveCall`). One that throws answers `threw` with its message; writes it made before the throw stay.

**The door and tokens.**
- With `methods:` declared, clients change data only through the methods; a plain client write is refused `methods-only` (V4-5). Reads stay open unless `rules.read` or a token limits them.
- A token from `fero.token(claims)` limits what a client follows, calls and writes. Servers check it when a follow opens, on every write and call, and on every record that a relay, a prefix, a view or a method's returned view forwards. `fero.revoke(sub)` ends access within one `ping.ms` (OPS-10).

**Sizes and bounds.** A record is at most 1 MB and a row at most 64 MB (sent in frames); larger is refused `too-large` before it is appended (SC-15). A client holds at most 512 waiting writes or 64 MB, then refuses `backpressure` (DESIGN §4.4). `rows.max` is per resource, enforced per group as that group's share. Every other queue is bounded and refuses with a reason (F-13).

**Stopping.** `destroy()` closes one handle. The last handle in a server process also leaves the cluster: it retires, then hands over leadership. So Ctrl-C on one of two processes leaves the other as the only voter, as in v4's example 01. Under `FERO_SUPERVISED` it only hands over, because a restart is coming (DESIGN decision 6a).

**Time and ids.** `fero.now()` and `fero.id()` are the wall clock and random ids when live, and the world's virtual clock and seeded ids under test. `ctx.now()` is the claim's writer time for a keyed call (TEST-02).

## 5. Errors and refusal codes

Every refusal is a `FeroError`. `code` says what, `outcome` says whether it may have committed, `hint` says the fix.

| Code | Layer | Outcome | When | Fields |
|---|---|---|---|---|
| `conflict` | L2 | refused | a condition failed, or an op's bound would be crossed | `current` |
| `fenced` | L2 | refused | a fence token older than one this writer has seen; a group commit from a passed generation | `current` |
| `absent-row` | L2 | refused | a field write to a row that does not exist (decision 14a) | |
| `absent-path` | L2 | refused | a field write whose parent field does not exist | |
| `sparse-hole` | L2 | refused | a remove of an array's own element: write the spliced array | |
| `invalid-key` | L4 | refused | a key data cannot fold | |
| `unencodable` | L4 | refused | a value that would not arrive unchanged (a bigint, a function, a Date, a Map, a Proxy, deeper than 60) | |
| `too-large` | L3, L4 | refused | a record over 1 MB, a row over 64 MB, a read answer over one frame | |
| `cross-partition` | L4 | refused | a `batch` whose keys span partitions | |
| `no-rows` | L2 | refused | an op, a claim or a condition on a `rows: false` resource | |
| `schema` | L2 | refused | `schema` said no | `path`, `reason` |
| `invalid` | L2, L4 | refused | `validation` returned a reason | `reason` |
| `rule` | L2 | refused | `rules.write` returned a reason | `reason` |
| `rule-threw`, `rule-timeout` | L2 | refused | a rule threw, or held the writer too long; a rule that keeps timing out is quarantined | |
| `methods-only` | L4 | refused | a client's plain write to a resource with `methods:` | |
| `forbidden` | L3, L4 | refused | the token or `rules.read` does not allow it | |
| `call-diverged` | L4 | refused | a keyed call's re-run wrote something different | |
| `read-only` | L2 | refused | the write gate is closed (`reason`), or the server is near its `memory` | `reason`, `retryAfter` |
| `disk-full` | L0 | refused | the disk is at its hard limit; reads go on | `retryAfter` |
| `backpressure` | L4 | refused | this client holds 512 waiting writes or 64 MB | `retryAfter` |
| `no-method` | L4 | refused | no method of that name | |
| `threw` | L4 | refused | the handler threw; writes it made before stay | `reason` |
| `busy` | L4 | refused | every server tried has a stalled main thread | `retryAfter` |
| `timeout` | any | unknown | no definite answer within `timeout` | `attempt`, `cause` |
| `unknown` | L2, L4 | unknown | the answer was lost past the horizon; an unkeyed call lost its server | `attempt` |
| `destroyed` | L4 | unknown | the handle closed with the write in flight | `attempt` |
| `shortfall` | L4 | thrown | a sync read of a partition this process does not hold | |
| `holistic` | L4 | thrown | an operator or enumeration over a partial picture | |
| `expired` | L3 | thrown by a reader | its cursor is older than `history` | `earliest` |
| `unknown-log` | L3 | thrown by a reader | a cursor of another cluster, a re-created resource, or an older epoch | |
| `schema-changed` | L4 | thrown by a reader | an old record or tape that the upcasters cannot bring to this version | |
| `locked` | L5 | refused | the lock is held past `wait` | |
| `limited` | L5 | refused | over the limit | `retryAfter` |
| `no-answerer` | L5 | refused | no live answerer in the group | |
| `config`, `node-config`, `config-differs` | L4 | thrown by `fero()` | a bad key or value; a node key unlike this process's; a resource key unlike the catalog's | |
| `too-many-resources` | L1 | refused | past the project's resource limit (SC-13) | |
| `admin-only` | L0 | refused | a planner, `drop` or recover verb without the admin key | |
| `stale-plan` | L1 | refused | a hint that names an old group configuration | |
| `dir-held` | L0 | thrown by `fero()` | another live process holds `dir` | |
| `wrong-project`, `wrong-cluster` | L0 | thrown by `fero()` | a dir or a peer of another project or cluster | |
| `no-server-here` | L4 | thrown by `fero()` | a server marker in a browser or an edge worker | |
| `unbound` | L4 | thrown by `fero()` | under a world, a name that nothing binds: never a silent network call (TEST-04) | |

**Inside fero only:** `no-writer`, `moved`, `retry`, `wrong-group`, `stale-attempt` and `empty`. The client acts on them by itself (it retries, follows `moved`, or resolves an empty `claim` with `[]`). An app sees them only as a `timeout`'s `cause`, in `cluster.writes` and in the debugger.

## 6. Config keys

The cascade is v4's: `--fero.<key>` beats the call, which beats `FERO_<KEY>`, then the project's `fero.opt.ts`, then `$HOME`'s, then the default (OPS-03). Layers below: **f** flag, **c** call, **e** environment, **p** a `fero.opt` file. Types and defaults are in §3.

| Scope | Keys | Layers | Changes |
|---|---|---|---|
| node | `project`, `server`, `listen`, `advertise`, `hosts`, `seeds`, `dir`, `object`, `rendezvous`, `redial.ms`, `redial.tries`, `leave.ms`, `journal.cap`, `memory`, `connect.wait`, `shuffle` | fcep | restart |
| node | `uuid` | fce (one shared file would give every process one identity) | restart |
| node | `secret`, `token`, `admin`, `diag.allow` | cep (a secret never rides the command line) | restart; `secret` rotates online through `#meta` (OPS-06) |
| open | `cache.memory`, `bind` | fcep, per name | the next open |
| open | `signals` | c | the next open |
| resource | `partition.before`, `history`, `rows.ttl`, `rows.max`, `rows.while`, `durability`, `copies`, `standbys`, `shape.version` | fcep, per name; written at create, compared at every later open | `fero.alter` |
| resource | `data` | cp (an object of rows) | applied once, at create |
| resource | `methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up` | c (code; registered by hash) | a roll: `fero.alter` adds the new hash first |
| cluster | `copies.meta`, `copies.default`, `ping.ms`, `election.ms`, `election.jitter`, `evict.after`, `settle.ms`, `catchup.max`, `skew.max`, `lag.max`, `issuer.window`, `session.ms` | `fero.alter('#meta', …)` or `fero alter '#meta' key=value` | online, with range and cross-key checks (`election.ms` > 2 × `ping.ms`; `skew.max` < `election.ms`; `issuer.window` only rises) |

Defaults that DESIGN-V5 does not give are proposed here: `skew.max` 250 ms, `lag.max` 1,000 records, `session.ms` 10 s, `connect.wait` 10 s, a call key's `ttl` 1 day, a token's `ttl` 1 hour, a write's `timeout` 10 s (v4's). Each new key gets what v4's rule asks: a row in `LEAVES`, a coercion if it needs one, a README row and a `config.test.ts` case ([CLAUDE.md](../../CLAUDE.md), "The two seams").

**The CLI (L5)** keeps v4's verbs and adds DESIGN-V5 §4.6's: `fero run`, `test`, `deploy`, `ls`, `debug`, `recover`, `join-token`, `log` (a log member), the planner's `drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `groups`, and `alter`, `drop`, `export` (OPS-07), `migrate` (a v4 `dir`, DEP-19). Their flags belong to LAYERS.md.

## 7. Every pattern: the code, the guarantee, the layer

The guarantee is the requirement's own promise. E-22 runs each file below as a check, with a leader change and a move injected and 100 seeds of the shuffle (Q-22).

### P-01 Live shared state

```ts
// file: p01.ts — live shared state (two files)
import { fero } from 'fero'
type Item = { stock: number }

// ── server.ts
const shop = await fero<Item>('shop', { data: { widgets: { stock: 10 } } })   // a seed makes a server
shop.data.tap(() => console.log(shop.snapshot))                                 // every commit, live

// ── client.ts: a bare name is a client; it follows the whole resource
const client = await fero<Item>('shop')
client.data.gadgets = { stock: 3 }                      // fire and forget: it shows when it commits (V4-7)
const ack = await client.set('gadgets', { stock: 4 })   // the same write, with an answer after commit
const w = client.snapshot.widgets                       // a sync read of a held row: a property read
console.log(ack.version, w.stock)
```

**Guarantee.** Order per partition. The answer comes once a majority has the write on disk. Read-your-writes. A held-row read is a property read (bar under 100 ns); write p99 ≤ C + 5 ms in TypeScript. **Layer:** L4, over L2's fold and L3's follow.

### P-02 Cache with expiry, session store

```ts
// file: p02.ts — cache with expiry, session store
import { fero } from 'fero'

const cache = await fero('cache', { rows: { ttl: '10m', max: 1e6 } })   // the writer expires and evicts
await cache.set('user:42', { name: 'Ada' })
await cache.set('hot', { n: 1 }, { ttl: '30s' })                        // this row's own ttl
const sessions = await fero('sessions', { rows: { ttl: '30m' } })
await sessions.touch('sid-9f2')                                          // resets the ttl, keeps the value
```

**Guarantee.** The writer removes rows by its own time, as records with a reason (`ttl`, `max`), so every copy agrees on which rows exist at each position. A row goes within one tick plus `skew.max` of its ttl, never before. Expiry work grows with what expires, not with what is held. `max` is enforced per group as its share. **Layer:** L2.

### P-03 Near cache, client data sync

```ts
// file: p03.ts — near cache, client data sync
import { fero } from 'fero'

const users = await fero('users', { cache: { memory: '200MB' } })   // follows only what it reads
const u = await users.get('u42')               // one hop; from now on u42 is followed
const same = users.snapshot.u42                // sync; u7 (never read) would throw 'shortfall'
const mine = users.follow(['u42', 'u43'])      // a snapshot of exactly these, then deltas
await mine.ready
mine.tap(() => console.log(mine.snapshot()))
console.log(u, same, mine.cursor())            // a reconnect resumes from the cursor by itself
```

**Guarantee.** A miss is one hop, then the partition is followed. A snapshot, then deltas, with no gap and no overlap; a reconnect resumes from the cursor and misses nothing. A sync read of a row not held throws `shortfall`, never a stale answer. Memory stays inside `cache.memory`. **Layer:** L3.

### P-04 Read-through cache

```ts
// file: p04.ts — read-through cache over another system
import { fero } from 'fero'

const prices = await fero('prices', {
  rows: { ttl: '5m' },
  load: (sku) => db.price(sku),            // runs at the writer, once per key however many miss
})
const p = await prices.get('sku-1')        // a miss waits for the one load; a write meanwhile wins
console.log(p)
```

**Guarantee.** One `load` per key however many readers miss at once. The loaded row is written with `if: { version }` as it was at the miss, so a write that lands during the load wins. `undefined` writes nothing. **Layer:** L4, using L2's condition at the writer.

### P-05 WebSocket fan-out by room

```ts
// file: p05.ts — websocket fan-out by room (two files)
import { fero } from 'fero'

// ── chat.ts, a server: a room is a partition, a message a row
await fero('chat', { server: true, partition: { before: '/' }, rows: { ttl: '1d' }, history: '1d' })

// ── web.ts, a webserver: a client that follows only the rooms its sockets joined
const chat = await fero('chat', { cache: { memory: '200MB' } })
wss.on('connection', (ws, room) => {
  const live = chat.follow(room)                       // snapshot, then deltas, encoded once per link
  live.tap((r) => ws.send(JSON.stringify(r)))
  ws.on('message', (text) => { chat.data[`${room}/${fero.id()}`] = { text, at: fero.now() } })
  ws.on('close', () => live.close())
})
```

**Guarantee.** Order per room. A webserver never receives a room it does not follow. Each record is encoded once per link. A reconnect within `history` misses nothing. Delivery p99 ≤ C + one hop. **Layer:** L3.

### P-06 Pub/sub

```ts
// file: p06.ts — pub/sub
import { fero } from 'fero'

const news = await fero('news', { rows: false, durability: 'none' })   // no disk, no log, best effort
// default durability: one group-commit fsync, nothing kept after delivery (history 0, rows false)
const sub = news.read({ partitions: ['sports'], from: 'latest' })
await news.set('sports', { headline: 'late winner' })                  // the subject is the partition
for await (const e of sub) console.log(e.rec.value)
```

**Guarantee.** Every current subscriber gets every message, in order per subject. The default `persisted` costs one group-commit fsync and keeps nothing after delivery. `none` uses no disk and no log, and is best effort; its readers count restarts in `gaps`. **Layer:** L2, L3. DESIGN decision 21 defers `none` to phase 5, but P-06 makes it a MUST, so the API declares it now.

### P-07 Streams and replay

```ts
// file: p07.ts — streams and replay
import { fero } from 'fero'

const events = await fero('events', { rows: false, history: '7d' })
await events.set('order:981', { type: 'paid', cents: 1200 })

const r = events.read({ from: savedCursor ?? 'earliest' })   // any kept position, or 'latest'
for await (const e of r) {
  console.log(e.partition, e.version, e.rec.value)
  save(r.cursor)                                             // a position never changes meaning
}
```

**Guarantee.** Every committed record of the selected partitions, once, in order per partition. A position never changes meaning across failover, scaling or moves. Past `history`, the reader gets `expired` with the earliest kept cursor. **Layer:** L1, L3.

### P-08 Consumer groups

```ts
// file: p08.ts — consumer groups
import { fero, group } from 'fero'

const orders = await fero('orders')
const invoices = await fero('invoices')

// effectively once: the output and the cursor commit together
const invoicing = await group(orders, 'invoicing')
invoicing.run((e, out) => out.use(invoices).set(e.partition, { order: e.row, at: e.t }))

// at least once: commit when the batch is done
const billing = await group(orders, 'billing')     // members share the stream; one owner per share
for await (const batch of billing) {
  for (const e of batch.entries) await bill(e.row)
  await batch.commit()                              // a paused (zombie) member is refused 'fenced'
}
```

**Guarantee.** Each share is owned by one live member per generation. A crash hands its shares on within one lease plus one commit. A zombie's `commit()` is refused `fenced`. At least once with `commit()`; effectively once with `run()`, whose outputs carry attempt ids made from the source position and commit before the cursor. **Layer:** L5, over L3's `read({ share })` and L2's fences. How the outputs stay deduplicated across a restart longer than the dedup horizon is Q-30's question; the API is the same whatever it answers.

### P-09 Work queue

```ts
// file: p09.ts — work queue
import { queue } from 'fero'

const jobs = await queue<{ url: string }>('thumbs', { lease: '30s', deliveries: 5 })
await jobs.add({ url: 'a.png' })
jobs.work(async (job) => { await resize(job.url) })   // returns: ack; throws: nack; 5 deliveries: thumbs.dead
```

**Guarantee.** At most one live lease per message. None is lost while unacked. Messages are handed out in FIFO order per partition; a queue has one partition, `main`, unless `add` names others (like SQS FIFO's message groups). After `deliveries`, the message moves to `thumbs.dead`. An empty take writes nothing. **Layer:** L5, on L2's `claim`.

### P-10 Locks and leader election

```ts
// file: p10.ts — locks and leader election
import { fero, lock } from 'fero'

const ledger = await fero('ledger')
const l = await lock('payroll', { lease: '10s', wait: '5s' })            // else 'locked'
await ledger.set('run-42', { by: process.pid }, { if: { fence: l.fence } })   // an older token: 'fenced'
await l.release()

const leader = await lock('leader:billing', { wait: 'forever' })        // leader election
leader.lost.then(() => process.exit(1))                                 // lost the lease: stop acting
```

**Guarantee.** At most one holder per lease, by writer time. Tokens strictly rise across failovers, moves and restores, and compare with `<`. A write whose token is older than one its writer has seen is refused `fenced`; every writer follows `#locks`, so this holds across groups. The lock row keeps where its holder wrote; on acquire, those versions become the new holder's read floor, so it sees the previous holder's writes. Acquire ≤ C. **Layer:** L5, on L2's conditions.

### P-11 Counters and rate limits

```ts
// file: p11.ts — counters and rate limits
import { fero, op, limiter } from 'fero'

const views = await fero<number>('views')
const a = await views.set('page:/', op.incr(1))   // a.value is the new count; a retry never counts twice
const api = await limiter('api', { max: 100, per: '1m' })
const { left } = await api.take('user:42')        // past 100 a minute: 'limited', with retryAfter
console.log(a.value, left)
```

**Guarantee.** Each acknowledged `incr` counts exactly once across retries; `a.value` is the count it made. A bound (`op.incr(-1, { min: 0 })`) is never crossed: the write is refused `conflict` with `current`. A refused limit writes nothing, because a first send's refusal is not appended. Op cost at the writer ≤ 3 µs in TypeScript. **Layer:** L2; `limiter` is L5.

### P-12 Leaderboards, live aggregates

```ts
// file: p12.ts — leaderboards, live aggregates (two files)
import { fero, type Handlers } from 'fero'
type Score = { player: string; room: string; points: number }

// ── server.ts
export const methods = {
  top: (n: number, ctx) => ctx.data.za('points', n),        // returns a view: a client can open it live
} satisfies Handlers<Score>
const scores = await fero<Score, typeof methods>('scores', { methods })
const top10 = scores.data.za('points', 10)                   // a server that holds every row
top10.tap(() => render(top10.snapshot()))
const perRoom = scores.data.group((r) => r.room)
console.log(perRoom.snapshot())

// ── screen.ts: a client, typed by the server's methods
const fan = await fero<Score, typeof methods>('scores')
const live = fan.methods.top(10).open()                      // served live by a server that folds the rows
live.tap(() => render(live.snapshot()))
```

**Guarantee.** A view equals its query over the committed state after each commit, at ≤ 1 µs per affected view per change. Across groups, views merge by partials (Q-23). A whole-resource view on a process that holds only some partitions throws `holistic`; that is why the client opens the server's view. **Layer:** L4, data's operators.

### P-13 Presence

```ts
// file: p13.ts — presence
import { fero } from 'fero'

const online = await fero('online', { rows: { while: 'session' } })   // every row dies with its writer's session
await online.set('ada', { since: fero.now() })
const here = await fero('here', { partition: { before: '/' } })
await here.set('room1/ada', { since: fero.now() }, { while: 'session' })   // one row bound to the session
```

**Guarantee.** When a session lapses, its rows go on every copy within `session.ms` plus one tick. A live session's rows are never removed. **Layer:** L2: each writer follows `#sessions`.

### P-14 Invariants

```ts
// file: p14.ts — invariants
import { fero, op } from 'fero'
type Item = { left: number; price: number }

const stock = await fero<Item>('stock', {
  methods: {
    sell: async (sku: string, ctx) => {
      const a = await ctx.set([sku, 'left'], op.incr(-1, { min: 0 }))   // two sells of the last one: one ok
      return a.value
    },
    reprice: async ({ sku, price }: { sku: string; price: number }, ctx) => {
      const got = await ctx.get(sku, { version: true })                   // check, then set only if unchanged
      if (!got || got.value.price === price) return
      await ctx.set(sku, { ...got.value, price }, { if: { version: got.version } })
    },
  },
})
console.log(stock.snapshot)
```

**Guarantee.** Conditions and ops are judged at the one writer, against its log-end state, so they are linearizable per partition. Two sells of the last item through two servers: exactly one `ok`. A refusal says why and never commits later. **Layer:** L2.

### P-15 Transactions across partitions

```ts
// file: p15.ts — transactions across partitions (a saga)
import { fero, op, saga } from 'fero'

const accounts = await fero('accounts')
await saga([
  { to: accounts, key: ['alice', 'cents'], value: op.incr(-5000, { min: 0 }) },
  { to: accounts, key: ['bob', 'cents'], value: op.incr(5000) },
], { id: 'tx-981' })   // finishes or is undone, even if this process dies mid-way; readers may see a half
```

**Guarantee (MUST).** Every saga finishes, by its holder or a later one, or is undone, even with paused holders: it takes locks in key order, writes an intent row, applies each step with a fence, then removes the intent. Readers may see the steps one at a time. **Atomic visibility (SHOULD)** is not in 5.0 (Q-A10). **Layer:** L5.

### P-16 Event sourcing, CQRS

```ts
// file: p16.ts — event sourcing, CQRS
import { fero } from 'fero'
type Fact = { account: string; cents: number }

const facts = await fero<Fact>('facts', { rows: false, history: 'all' })   // every fact, forever
await facts.set('acct:alice', { account: 'alice', cents: 500 })
const balance = new Map<string, number>()
for await (const e of facts.read({ from: 'earliest' }))                     // rebuild from the start
  if (e.row) balance.set(e.row.account, (balance.get(e.row.account) ?? 0) + e.row.cents)
```

**Guarantee.** `history: 'all'` never drops a record. A rebuilt projection equals the live one byte for byte, because both fold the same records with data (DATA-01), and upcasters run on both paths (P-20). **Layer:** L2, L4.

### P-17 Derived resources

```ts
// file: p17.ts — derived resources
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }

const orders = await fero<Order>('orders')
const totals = await fero<number>('totals')
await derive(orders, totals, (e, out) => e.row && out.set(e.row.user, op.incr(e.row.cents)))   // once per order
```

**Guarantee.** Each record of `orders` affects `totals` exactly once, across crashes, restarts and moves. `op.incr` is not idempotent, so this is the hard case on purpose. **Layer:** L5: a consumer group whose outputs carry attempt ids made from source positions (Q-30).

### P-18 Tapes, forks, replays

```ts
// file: p18.ts — tapes, forks, replays (two files)
import { fero, tape } from 'fero'

// ── try.ts, on the live cluster: a fork shares the parent's history
await fero.fork('shop', { as: 'shop-try' })                  // one record per group, no copy
const trial = await fero('shop-try', { server: true })
await trial.set('widgets', { stock: 0 })                     // the parent never sees it

// ── a fero test run: one world per process, virtual time and ids, the shuffle on
const w = fero.world({ seed: 7 })
const shop = await fero('shop', { listen: false })           // a socketless solo node
await shop.set('k', { at: fero.now() })
await w.advance('1h')                                         // TTLs, leases and timers fire in order
const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
console.log(stripe.find('charge:981'))
```

**Guarantee.** A fork costs one record per group, not a copy (TEST-06). It is one consistent cut per group, and per partition across groups. A world makes a run a function of its seed (TEST-02). A recorded input re-runs on the exact earlier state (TEST-07). **Layer:** L1, L4; `tape` is L5.

### P-19 Clients everywhere

```ts
// file: p19.ts — clients everywhere (a browser, an edge worker)
import { fero } from 'fero'

const token = 'from your server: fero.token({ sub: "ada", follow: ["ada*"] })'
const shop = await fero('shop', { hosts: ['wss://shop.example.com'], token, cache: { memory: '20MB' } })
const cart = shop.follow({ prefix: 'ada' })
await cart.ready
cart.tap(() => render(cart.snapshot()))
```

**Guarantee.** The same API in Node, Bun, Deno, browsers and edge workers, over WebSocket on the project's one TLS address, with P-03's promises. The browser bundle, data included, is at most 60 KB gzip. A server marker in a browser is refused `no-server-here`. Other languages use the RESP gateway or the documented wire. **Layer:** L0's transport, L3, L4.

### P-20 Change the shape of rows

```ts
// file: p20.ts — change the shape of rows
import { fero, migrate } from 'fero'

const users = await fero('users', {
  shape: {
    version: 3,
    up: {
      1: (r) => r,                                    // v1 → v2: the same record
      2: (r) => r.key.length === 1                    // v2 → v3: name becomes { first, last }
        ? { ...r, value: { ...(r.value as any), name: { first: (r.value as any).name, last: '' } } }
        : r,
    },
  },
  schema: UserV3,                                     // checked at the writer: 'schema' with the path
})
const job = await migrate(users, { to: 3, fn: (row: any) => row, perSec: 500 })   // rewrite live rows, paced
await job.done
```

**Guarantee.** The catalog records from which position each `shape.version` is in force. A record, snapshot row or tape input written under an older version passes the upcasters in order on every path (folds, follows, replays), so a rebuild equals the live state. A tape that cannot be upcast is refused `schema-changed` (M). `schema` refuses at the writer with the path; `migrate` rewrites live rows as a resumable, exactly-once, paced job (S). **Layer:** L4; `migrate` is L5.

### P-21 Request and reply

```ts
// file: p21.ts — request and reply (two files)
import { service } from 'fero'

// ── worker.ts, on each answerer
const thumbs = await service<{ url: string }, { url: string }>('thumbs')
thumbs.answer(async (req) => ({ url: await resize(req.url) }), { group: 'workers' })

// ── app.ts, an asker
const out = await thumbs.ask({ url: 'a.png' }, { timeout: '5s' })   // one answer, 'timeout', or 'no-answerer'
console.log(out.url)
```

**Guarantee.** Requests spread over the live answerers of a group. Each request gets at most one answer, because the reply row is written `if: { absent: true }`. With no live answerer, `no-answerer` at once; otherwise an answer or `timeout`. **Layer:** L5, on `claim`, sessions and conditions. The service resource is `durability: 'none'` by default, for P-21's latency bar (Q-A17).

### P-22 Delayed jobs, waiting takes, priorities

```ts
// file: p22.ts — delayed jobs, waiting takes, priorities
import { queue } from 'fero'

const mail = await queue<{ to: string }>('mail')
await mail.add({ to: 'ada@x.io' }, { delay: '15m' })
await mail.add({ to: 'ops@x.io' }, { cron: '0 6 * * *', id: 'daily-report' })
await mail.add({ to: 'vip@x.io' }, { priority: 0 })
const [m] = await mail.take(1, { wait: '20s' })   // woken by an enqueue; writes nothing while waiting
if (m) { await sendMail(m.job.to); await m.ack() }
```

**Guarantee.** A delayed message becomes takeable within one tick of its time, by writer time, and never before. A waiting take is woken within C + one hop of an enqueue, and writes nothing while it waits. Priorities hold within a partition (S). **Layer:** L5, on `claim` (whose `where` gets writer time) and `follow`.

## 8. Where the candidates differ

The types above are the same for every candidate in SPACE §4. These notes say what behaviour changes under each, so the API survives whichever wins.

| Candidate or axis | What changes for a developer | What the API does about it |
|---|---|---|
| Slots that move (DRAFT, MIN, MIN-P, MIN-TS, RUST, RLOG, LEAN, SIDE, SLOG, OBJ) | nothing | the reference. `share.of` is at most 1,024 (the slot count) |
| No moves, fixed 16 cells re-keyed to grow (CELL) | after a re-key, old cursors and versions belong to an old generation | a re-key bumps the epoch, so versions still sort and old cursors are refused `unknown-log`; a group restarts its shares at a mapped cursor. `share.of` is at most 16 |
| Project lanes (LANE) | `copies` and `durability` are per project, not per resource | a resource key unlike the project's is refused `config-differs`, naming the project key. `share.of` is at most 64. A key-range move between lanes bumps the epoch, as CELL's re-key does |
| Splits (SPLIT, PD) | cursors carry lineage | `Cursor` is opaque, so only its size changes (stated in SC-10) |
| PD (2PC, a timestamp oracle) | real atomic transactions | `saga` could gain `{ atomic: true }` for free; `Version` is a timestamp, still opaque |
| ISR (Kafka's shape) | a `memory`-like default; transactions by a coordinator | `durability` gains the ISR rung (decision 4b); `saga({ atomic: true })` maps to its transactions |
| A Rust or Go server with a TS client (SRV) | the server cannot run JavaScript | everything that is a function and runs on a server needs a JS host: `methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `claim`'s `where`, `shape.up`. Under SRV, a "server" process in `fero()` is an app process attached to the local fero binary: methods run there (U `cli`), views are served from there as a relay, and writer-side code is refused `config` at define. The portable core is declarative: conditions, ops, `ttl`, `max`, `while`, `partition.before`, `history`, `durability`, and views on clients and relays. Records on the wire stay data's (DATA-03), and versions and cursors are strings the server mints |
| V8 inside a Rust server (EMB-V8) | nothing | every function key runs in an isolate at the server |
| Calls at the writer's host (SIDE, U `ldr`) | a method sees the writer's state | the same code; conditions are still required for portability (Q-A8) |
| Only leaders fold (LEAN) | a server holds rows only for groups it leads | `snapshot` throws `shortfall` more often; apps use `get` and `follow`. No API change |
| The object store is the log (OBJ) | commits pay a PUT; a `fresh` read reads the manifest | no API change; the bars move |
| An outside log (BUY) | fero's L2 to L5 on JetStream | `Version` is a stream sequence per subject; conditions over a row map to JetStream's per-key revision check (E-44) |
| Dedup options (D: `win`, `sess`, `srcpos`) | none | attempt ids are internal, and `stale-attempt` never reaches an app |
| TypeScript or native kernel (L) | defaults: `election.ms` 2 s or 1 s | no API change |

## 9. Open API questions, each with a proposed answer

- **Q-A1. Who creates a resource?** Proposed: only a server. It keeps the seed applying once, at create (DEP-05), and a client started first still works, because its writes wait.
- **Q-A2. A changed resource key on open.** Proposed: refused `config-differs` across boxes. On one box, when this process is the only server running the resource's code, `fero()` alters it online and prints one line, so editing `history` in dev needs no command.
- **Q-A3. A disk by default.** Proposed: yes; `persisted` must mean a disk. `dir: false` is memory only, and the health row `memory-only` says so. Cost: example rows survive restarts, so examples 01 to 03 change their READMEs, and `.fero/` joins `.gitignore`. SC-01 (ready ≤ 1 s) must still hold.
- **Q-A4. The project's name.** Proposed: the `name` in the nearest `package.json`, else its folder's name; `project` overrides. Two projects on one box never join (DEP-18).
- **Q-A5. `get(key)` against DESIGN's `read(key, { fresh })`.** Proposed: `get` for one row, and `read` only for the log, so one verb does not mean two things.
- **Q-A6. Partition rules.** Proposed: declarative only in 5.0 (`{ before }`). It covers rooms, tenants and users; clients can compute it; SRV can run it; it needs no code hash. The function form comes back if an app shows a need.
- **Q-A7. A public `slots` key.** Proposed: no. OPS-01 and SC-08(e) say no numbers to choose; the share count is a stated ceiling per candidate instead.
- **Q-A8. Where methods run.** Proposed: where the caller reached (U `any`), with conditions or ops for check-then-set. If E-22 shows that people forget the condition, add a method option `{ at: 'writer', partition: (arg) => key }` that routes the call to the writer (U `ldr` as an opt-in).
- **Q-A9. `confirm` per write and a `memory` rung.** Proposed: neither in 5.0 (decisions 4 and 23a); the types refuse both. Reopen with PERF-02's and PERF-05's default-config rows (X1).
- **Q-A10. Atomic visibility for sagas.** Proposed: not in 5.0. Reserve `saga(steps, { atomic: true })` and `read({ atomic: true })` for RAMP, if E-24 prices it at 2 rules or fewer.
- **Q-A11. How long a call key lasts.** Proposed: `ttl` default 1 day, as Stripe keeps idempotency keys for at least 24 hours ([Stripe API, idempotent requests](https://docs.stripe.com/api/idempotent_requests)).
- **Q-A12. A bare client holds the whole resource.** Proposed: yes, as v4. At 80% of the node's `memory`, health warns and names the fix: `cache: { memory }` (SC-09).
- **Q-A13. A `publish` verb.** Proposed: no; `set` on a `rows: false` resource is publishing. One verb fewer.
- **Q-A14. Offsets in answers.** Proposed: never. An `Ack` carries a version, which keeps its meaning across moves; a group's offset does not.
- **Q-A15. One error class.** Proposed: one `FeroError` with `code` and `outcome`, replacing v4's `WriteReject` and `ScopedError`.
- **Q-A16. `ctx.peer`.** Proposed: stays a string (examples 40 to 44 stamp it); claims and session sit beside it.
- **Q-A17. Request and reply latency.** P-21's bar says "two hops", but asker, server, answerer, server and asker are four network legs. Proposed: read the bar as two server hops, and default `service` to `durability: 'none'`. E-22 records the legs.
- **Q-A18. Where the libraries live.** Proposed: named exports of `'fero'`, one specifier, tree-shaken in browsers. Each is its own file built only from L4.
- **Q-A19. Durations.** Proposed: `'30s'` or milliseconds in the call; config keys keep v4's `.ms` numbers so the cascade's spellings stay.
- **Q-A20. Functions at the writer (`rows.where`, `claim`'s `where`, `rules.write`).** Proposed: keep them in 5.0, synchronous, by code hash, under a watchdog (decision 23a). Under SRV they need EMB-V8, or are refused at define.
- **Q-A21. Consumer-group shares.** Proposed: `read({ share: { index, of } })`, where a partition sits in one share forever. `of` is at most the candidate's fixed bucket count, stated in SC-10.
- **Q-A22. Typed rows.** Proposed: TypeScript's `Row` parameter, plus an optional Standard Schema ([standardschema.dev](https://standardschema.dev)) checked at the writer. No schema library becomes a dependency.

## 10. How this file is checked

`env.d.ts` stands in for the app's own world, so the pattern files compile. `types.ts` holds what must and must not compile: each `@ts-expect-error` line fails the check if it ever compiles.

```ts
// file: env.d.ts — stand-ins for the app's own world, so the pattern files type-check
declare const console: { log(...a: unknown[]): void }
declare const process: { pid: number; argv: string[]; exit(code?: number): never }
interface Socket { send(s: string): void; on(ev: 'message', fn: (text: string) => void): void; on(ev: 'close', fn: () => void): void }
declare const wss: { on(ev: 'connection', fn: (ws: Socket, room: string) => void): void }
declare const db: { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }
declare function resize(url: string): Promise<string>
declare function sendMail(to: string): Promise<void>
declare function bill(order: unknown): Promise<void>
declare function render(x: unknown): void
declare const savedCursor: import('fero').Cursor | undefined
declare function save(c: import('fero').Cursor): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string }; email: string }>
```

```ts
// file: types.ts — what must and must not type-check
import { fero, op, type Version } from 'fero'

// inferred, no type arguments: handlers get a typed ctx, callers get typed arguments
const bank = await fero('bank', { methods: {
  deposit: async (cents: number, ctx) => { ctx.data[fero.id()] = { cents }; await ctx.flush(); return cents },
} })
const n: number = await bank.methods.deposit(5)
// @ts-expect-error the argument is a number
bank.methods.deposit('5')
// @ts-expect-error a plain result has no live form
bank.methods.deposit(5).open()

const f = await fero<{ n: number }>('f')
// @ts-expect-error no 'memory' rung in 5.0 (decision 4b is open)
await fero('x', { durability: 'memory' })
// @ts-expect-error copies: 2 is cut (decision 23a)
await fero('x', { copies: 2 })
// @ts-expect-error a history is a number of records, a time or a size
await fero('x', { history: '7 days' })
// @ts-expect-error no per-write confirm (decision 23a)
await f.set('k', { n: 1 }, { confirm: 'sent' })
// @ts-expect-error a partition rule is declarative in 5.0
await fero('x', { partition: (k: string) => k })
// @ts-expect-error incr takes a number
op.incr('1')
// @ts-expect-error versions are opaque, never plain strings
await f.set('k', { n: 1 }, { if: { version: '9001' } })
const v = (await f.get('k', { version: true }))?.version
if (v) await f.set('k', { n: 2 }, { if: { version: v satisfies Version } })
f.data.k = op.incr(1)                      // an op value by assignment
f.data.k = { n: 3 }                        // a row by assignment
console.log(n)
// @ts-expect-error deposit needs its argument
bank.methods.deposit()
const solo = await fero('solo', { methods: { ping: (_, ctx) => ctx.peer } })
const who: string = await solo.methods.ping()   // an untyped argument may be left out
console.log(who)
```

The checker writes every `// file:` block to a fresh folder and runs `tsc` against data's `types/public.d.ts`:

```js check
// API.md checker: every ```ts block whose first line is "// file: <name>" is written to a fresh
// folder and type-checked with tsc against data's shipped types. DATA names data's folder.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const md = readFileSync(process.argv[1], 'utf8')
const data = process.env.DATA ?? '/home/user/pemrouz/data'
const out = mkdtempSync(join(tmpdir(), 'fero-api-'))
const files = []
for (const [, body, name] of md.matchAll(/```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)```/g)) {
  writeFileSync(join(out, name), body)
  files.push(name)
}
const compilerOptions = {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] },
}
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files }))
console.log(`${files.length} blocks → ${out}`)
execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${files.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
```

Run from the repo root (`DATA` names data's folder; the default is this machine's):

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/API.md)" docs/v5-space/API.md
```

**Result, run here on 2026-11-06** (Node v22.22.0, TypeScript 6.0.2 at `/opt/node22/bin/tsc`, data at 63fea66): `ok: 26 blocks type-check (tsc Version 6.0.2)`. A planted error (`op.incr("x")` in P-14) makes the same command exit 1. Not checked here: that any of this runs. E-22 builds it.
