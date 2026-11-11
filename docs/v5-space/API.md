# fero v5: the public API

Final, 2026-11-11, for the v5 design-space study ([BRIEF.md](BRIEF.md)). It is the public surface of **COMP2**, the design [VERDICT.md](VERDICT.md) chose, **built as MIN-P+par's shape first** ([VERDICT §0](VERDICT.md#0-the-answer)). Draft 1 (2026-11-06) was written before most experiments ran. This page brings every part of it in line with what they found.

- **What this page is.** What an app developer writes against fero v5, how they use it, and what each call promises.
- **The design in one line.** Raft groups owned by the project hold fixed slots of many resources. One loop on `#meta`'s leader heals replicas and moves slots. `data` folds the rows on every full replica ([VERDICT §5.1](VERDICT.md#51-its-full-line-in-plain-words)).
- **Words.** VERDICT's [key of terms](VERDICT.md#key-of-terms) explains the study's words (row, rung, slot, group, fold, and the labels A-nn, RR-nn, E-nn). Section 0 below adds the API's own. "E-22 D3" names item D3 of [E-22's API notes][API-NOTES]; "E-45 F1" names finding F1 of [E-45].

**What comes when.**
- **Built first, in TypeScript: MIN-P+par's shape.** That is COMP2 without the `memory` rung. Everything on this page is in it, except the parts listed next.
  - Its first slice leaves out the object-store tier and restore, the `none` rung and relays, platform hints, the slow-leader rule and merged views. They follow in later phases ([VERDICT §9](VERDICT.md#9-the-next-step) step 4).
  - The first slice still founds a cluster across boxes, in the one way this page allows. The founders create the cluster id in the object store once, by a conditional write (A-08's 4 genesis rules, [E-33]). That is the slice's only use of the store. On one box a local folder stands in, with an exclusive file create (this page's reading).
- **Only with the `memory` rung, and only if it passes its kill test.** The test runs with one write in flight. It needs p99 under about 0.30 ms and at least about 4,340 acks a second (VERDICT §0 item 12, §9 step 6b).
  - `durability: 'memory'`. Until the rung is built, `fero()` refuses it with `config`.
  - The refusal `needs-persisted`: a fenced write, a session-bound write or a saga step on a `memory` resource (RR-14).
  - `fero recover --unclean` starting a new session generation and new slot epochs for a `memory` group (RR-12, RR-13).
  - Nothing else in the types changes.
- **At the native step** (L `ts→rs`, only for the rows TypeScript does not win; VERDICT §9 step 8).
  - No type and no verb changes. `data` still folds every row in JavaScript, so methods, views and every function key run as before (RR-17's design rule, [VERDICT §3.3](VERDICT.md#33-which-data-01-reading-the-brief-supports)).
  - Defaults change: `election.ms` goes under 1,000 ([A-02](AMENDMENTS.md)). Two bars tighten: P-01's write p99 to C + 0.5 ms, and P-11's op cost to 0.5 µs.
  - If TypeScript wins those rows, there is no native step, and nothing here changes.

**How sure each part is.**
- **Type-checked here.** Every `ts` block whose first line is `// file: …` compiles with TypeScript 6.0.2 against data's shipped types (data at 63fea66, Node 22.22.0). That includes the 22 pattern files and the lines that must *not* compile. Section 10 has the command and today's result.
- **Run on a prototype.** [E-22] built draft 1's surface on five kernel operations. It ran all 22 patterns with a leader change and a slot move forced into each, with and without the shuffle. Porcupine found 183,159 partition histories linearizable after one fix, and real Knossos agrees on 185,959 ([E-22b]). Most changes on this page come from that run.
- **Model-checked.** The rules under the surface: subscribe ([E-31]), dedup ([E-20]), sagas ([E-24]), derived outputs ([E-30]), a slot move meeting a leader change and dedup ([E-32]), and genesis and restore ([E-33]). Writer time was simulated ([E-21]).
- **Judged.** COMP2's cells, with the clauses restated as VERDICT uses them ([cards.json][cards]):
  - P: 9 MUSTs met, 13 open; as worded, P-05 is open too. P-22 (S) met, P-15 (S) not met, P-20 (S) open.
  - DATA: 2 MUSTs met, 7 open. TEST: 6 met, 6 open, and TEST-11 (S) open.
  - MIN-P+par also meets P-10, P-15 and F-02 (M), since it has no `memory` rung.
  - But MIN-P+par fails PERF-04, a MUST, by proof (RR-15, gap 0.07). No `persisted` commit here can beat 0.323 ms at p99, so it cannot win JetStream's default test line. So the first build is out on either DATA-01 reading, unless the user accepts that test line as a loss ([VERDICT §8](VERDICT.md#8-what-the-user-must-confirm) item 2; §6).
  - Each pattern in section 7 says where it stands.
- **Promised, not yet built.** Marked **(new)** where they appear: caller keys on writes and their bound, issue order for unawaited writes, the version number form and reads from a version, `fero.cursor`, byte values, `op.now`, `until`, a claim's `due`, `saga.sweep`, and the `memory` refusal.
- **Reasoned.** Everything else, unless a source is linked.

## 0. Words and layers

| Word | What it is here |
|---|---|
| resource | a named map of rows. It is an entry in the project's catalog, not a cluster of its own |
| partition | the unit of order and atomicity: one row, or the rows whose keys share a prefix (`partition: { before: '/' }`) |
| slot | one of a resource's 4,096 fixed buckets. A partition hashes to one slot ([A-16](AMENDMENTS.md)) |
| group | one Raft log with one leader. The project's groups hold slots of many resources. Seen only in `cluster.groups` |
| writer | a group's leader: the one process that appends to its log and judges writes |
| rung | what a commit means: `persisted`, `none`, or (with the rung) `memory`. Set per resource, never per write |
| version | a row's place in its partition's order: its slot's (epoch, sequence). An opaque string |
| cursor | where a reader is: one (epoch, sequence) per slot it reads. An opaque string |
| attempt | one write or call, with an id that its retries keep |
| session | one process's life, held by a lease it renews by itself. Writers keep its dedup floor; `while: 'session'` rows die with it |
| writer time | the median of the members' clocks, never going back ([A-23](AMENDMENTS.md)). TTLs, leases, delays and `ctx.now()` use it |
| fence | a lock's token carried on a write. Each group's writer refuses a token older than one it has accepted for that lock |

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
for await (const e of shop.read({ from: 'earliest', until: 'latest' })) console.log(e.version, e.rec)
console.log(sold.value, left, fresh)
```

## 2. What changes from v4, and why

**Kept from v4,** because it works and the examples teach it:
- `fero(name, opts)` returning `{ name, data, methods, cluster, snapshot, destroy }`, writes by plain assignment, and data's operators as live views.
- `methods:` as the door (V4-5), and a write that shows only once it commits (V4-7).
- The role by declared act, `validation:`, the seed, and Ctrl-C as a clean stop (V4-8).
- `fero.spawn` (V4-9), `fero.clientKey`, the config cascade (V4-10) and the box directory (V4-3).
- One process per `dir` (V4-59), user throws sent to the Fault printer (V4-47), and `diag(f)` in `fero/internals`.

| v4 | v5 | Why |
|---|---|---|
| a cluster per resource | one cluster per project; a resource is a catalog entry whose slots sit in the project's groups | G `pslot` ([VERDICT §5.1](VERDICT.md#51-its-full-line-in-plain-words)) |
| a cell keeps its newest stamp (LWW) | log order per partition, judged at one writer; ops instead of read-modify-write | P-11, P-14, DATA-01 |
| `confirm` per write | one answer, at the resource's rung | a rung per resource, never per write (AMENDMENTS 4, note 13) |
| built-in `methods.update/insert/remove/read` | the verbs `set`, `remove`, `touch`, `get`, `claim`, `batch`; `methods` holds only yours | one write path |
| `WriteResolve` and `WriteReject` | `Ack { key, version, attempt, value }` and one `FeroError { code, outcome }` | `outcome` says whether it may have committed (F-02) |
| a forwarded write could commit twice | client sessions: exactly once per attempt | D `sess` ([E-20]) |
| `replicas`, `heartbeat`, `seams` | `copies`, `standbys`, the cluster key `ping.ms` | |

## 3. The declarations

`data` here is the data engine's own type file, so views are typed by data (DATA-05). The libraries are named exports of `'fero'`, so a browser bundle keeps only what it imports.

```ts
// file: fero.d.ts — fero v5's public API, final: COMP2, built as MIN-P+par first. Declarations only.
// Views are data's operators, so their types are data's own (DATA-05).
import type { Ops, View, ChangeRecordV2, ReadonlyData } from 'data'
/** One change as user code sees it: data's v2 record minus order moves, decoded. The log, the
 *  journal and the wire keep DATA-03's form, { type: 0|1|2, key: [rowKey, ...path], value, at? },
 *  verbatim; fero turns the type number into its name only where it hands a record to user code.
 *  An array index in a write's Path appears in rec.key as its decimal string, as in data's v2
 *  records and v4's (kernel/env.ts: key: string[]). */
export type Rec = Exclude<ChangeRecordV2, { type: 'move' }>
/** One change on a live view's stream: data's full record, order moves included (E-22 D12). */
export type ViewRec = ChangeRecordV2

// ── words ────────────────────────────────────────────────────────────────
export type Key = string                                     // a top-level row key
export type Path = readonly [Key, ...(string | number)[]]    // a cell: the row key, then a field path
export type Partition = string                               // the unit of order; by default the row key
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`   // a number is milliseconds
export type Size = number | `${number}${'B' | 'KB' | 'MB' | 'GB' | 'TB'}`    // a number is bytes
/** A row's version, a record's position, a lock's token: its slot's (epoch, sequence). Opaque.
 *  Two versions of ONE partition compare with plain string `<` in log order, across failovers,
 *  slot moves, restores and (with the memory rung) an unclean recovery, which takes new slot
 *  epochs. Versions of different partitions have no order (the shuffle makes code
 *  that leans on one fail). fero.version gives the number form gateways need (E-45 F1). */
export type Version = string & { readonly __fero: 'version' }
/** Where a reader is: one (epoch, sequence) per slot it reads (E-31). Opaque and serialisable.
 *  A whole-resource cursor holds up to 4,096 entries; its bar is 8 KB (Q-19), measured in phase 1. */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
/** Writer time: ms since the epoch. The median of the members' clocks, never going back (A-23). */
export type Time = number
/** What a commit means. Set per resource, never per write (AMENDMENTS 4, note 13).
 *  'persisted': on disk at a majority. 'none': best effort, no disk, no log; needs rows: false.
 *  'memory': in memory at a majority. It comes only with the memory rung, and only if the rung
 *  passes its kill test (VERDICT §9 step 6b). Until then fero() refuses it with 'config'. */
export type Durability = 'persisted' | 'memory' | 'none'

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
  hosts?: string[]           // members to dial and join: how a running cluster grows (A-08)
  seeds?: string[]           // the founders of a first start across boxes; never beside a dir that holds an id (A-08)
  dir?: string | false       // server default: .fero/<project>/m<n> next to package.json, the first unlocked; false = memory only
  object?: string | false    // 'file:///…' or 's3://bucket/prefix'; default .fero/<project>/objects on one box.
                             // Required across boxes: the cluster id is created there once, by a conditional write (A-08)
  secret?: string | false    // the members' shared secret (the door); never a flag
  token?: string             // a client's credential: fero.clientKey(secret) or a fero.token(...)
  admin?: string             // the admin key: hints, drop, recover, restore; never a flag
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

/** Resource scope: the catalog. The open that creates the resource writes these; from then on a
 *  key you pass must equal the catalog's (else 'config-differs'), and a key you leave out takes the
 *  catalog's. Change them online with fero.alter. Declarative keys may come from any process
 *  (E-22 D2); code keys and the seed make the process a server. */
export interface ResourceOptions<Row = any, M extends Handlers<Row> = Handlers<Row>> {
  // declarative
  partition?: { before: string }    // rows whose keys share the text before `before` are one partition; default: each row
  history?: History                 // default 0: only what recovery needs
  rows?: boolean | RowsRule<Row>    // default true; false = no state (a stream)
  durability?: Durability           // default 'persisted'
  copies?: 1 | 3 | 5                // voters per group; default 3 (1 while fewer than three servers exist)
  standbys?: number                 // full copies per group, voters included; the rest are learners; default: every server, up to 5
  // the seed and code: a server only
  data?: Record<Key, Row>           // the seed: applied once, when the resource is created
  methods?: M                       // the hosted methods, AND the door: clients then write only through them
  validation?: (rec: Rec) => true | string   // where a write enters (on a server), and again at the writer
  schema?: Schema<Row>              // checked at the writer; refused 'schema' with the path
  rules?: {
    write?: (who: Who, rec: Rec, current: Row | undefined) => true | string   // at the writer
    read?: (who: Who, partition: Partition) => boolean                         // where a follow is served
  }
  load?: (key: Key, ctx: { now(): Time }) => Row | undefined | Promise<Row | undefined>  // read-through, once per key per miss
  shape?: { version: number; up?: Record<number, Upcaster> }   // default { version: 1 }; a bump is a fero.alter
}
export type History = 0 | 'all' | number /* records */ | `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}${'KB' | 'MB' | 'GB' | 'TB'}`
export interface RowsRule<Row> {
  ttl?: Duration          // removed this long after its last write or touch, by writer time
  max?: number            // past it, the rows with the oldest last write are removed; per group, as its share rounded up
  where?: (row: Row) => boolean   // code: rows for which it is false are removed
  while?: 'session'       // every row lives while the session that wrote it lives (presence); not on 'memory'
}
/** One version step: a record written under version n, as the code of version n + 1 expects it.
 *  A snapshot row and a held row are passed as whole-row updates. null drops the record. */
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
   *  partial picture throws 'holistic'. console.log prints the rows (E-22 C9). */
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
  // writes: each answers after its commit, at the resource's rung
  set(key: Key, value: Row | Op, opts?: WriteOpts): Promise<Ack>
  set(key: Path, value: unknown, opts?: WriteOpts): Promise<Ack>
  remove(key: Key | Path, opts?: WriteOpts): Promise<Ack>
  /** A write that keeps the value: it resets the ttl, or sets a claim's lease (0 ends it),
   *  under a condition (E-22 C2). It gives the row a new version (E-22 C11). */
  touch(key: Key, opts?: TouchOpts): Promise<Ack>
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
  batch(writes: readonly BatchWrite<Row>[], opts?: { id?: string; timeout?: Duration }): Promise<Ack[]>
}

export interface GetOpts {
  fresh?: boolean      // linearizable: the writer confirms it still leads (read index); one round trip, no fsync
  version?: boolean    // also answer the row's version
  timeout?: Duration   // default '10s'
}
export interface WriteOpts {
  if?: Cond            // every condition given must hold at the writer, or 'conflict' ('fenced' for a fence)
  ttl?: Duration       // this row's ttl, from this write
  while?: 'session'    // this row lives while the writer's session lives (in a method: the caller's); not on 'memory'
  id?: string          // (new) a caller key: a resend or re-run with this id within 1 day gets the first answer (A-10)
  timeout?: Duration   // default '10s'; past it the promise rejects 'timeout'
}
export interface TouchOpts {
  ttl?: Duration       // reset the ttl to this, from now
  lease?: Duration     // a claimed row: hold it this long from now; 0 ends the lease
  if?: Cond
  id?: string
  timeout?: Duration
}
export interface Cond {
  absent?: true        // the row does not exist
  present?: true       // the row exists
  version?: Version    // the row's version is exactly this
  equals?: unknown     // the value at the key or path deep-equals this
  fence?: Fence        // this partition's writer has accepted no write for this lock under a newer token (A-24)
  expired?: true       // the row is absent, or its ttl has passed by writer time
}
export interface Fence { lock: string; token: Version }

/** An op value: the writer computes the value to append (L2). Usable with set, batch and assignment. */
export interface Op { readonly __op: 'incr' | 'push' | 'merge' | 'max' | 'min' | 'now' }
export declare const op: {
  incr(n: number, bounds?: { min?: number; max?: number }): Op   // a bound that would be crossed: 'conflict'
  push(...items: unknown[]): Op
  merge(fields: Record<string, unknown>): Op
  max(x: number | string): Op
  min(x: number | string): Op
  now(plus?: Duration): Op       // (new) the writer's time when it applies the write, plus `plus` (E-22 D5)
}

export interface Ack {
  key: Path
  version: Version     // the record's position, now the row's version
  attempt: AttemptId
  value?: unknown      // ops only: the value the op wrote (incr: the new number)
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
  /** (new) Declarative, so a client can send it: a row is taken only when this field holds a
   *  Time at or before writer time, or is missing. E-22 passed a function here, which crossed for
   *  free only because its prototype ran in one process. */
  due?: keyof Row & string
}
export interface Claimed<Row> {
  key: Key
  value: Row
  /** The claim's version, the same for every row one claim hands out; ack with `if: { version: token }`.
   *  A touch gives the row a new version (E-22 C11), so after a touch its Ack.version is the token. */
  token: Version
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
 *  conflated per row; a snapshot replaces the whole picture. A reconnect resumes from the cursor
 *  by itself. Read-only: write through the resource. */
export interface Follow<Row> extends LiveData<Row> {
  readonly ready: Promise<void>   // the first snapshot has landed; reads before it throw 'shortfall'
  cursor(): Cursor
  close(): void
}
/** One of `of` equal, fixed shares of a resource's slots: a partition is in one share forever.
 *  `of` is at most 4,096, the slot count (A-16). */
export interface Share { index: number; of: number }
export interface ReadOpts {
  /** A Version needs exactly one partition in `partitions`; the read starts at that record (E-45 F1b). */
  from: Cursor | Version | 'earliest' | 'latest'
  until?: 'latest'                         // (new) end at the log's end as it was when read() was called; default: never end
  partitions?: readonly Partition[]
  prefix?: string
  share?: Share
  credit?: Size                            // in-flight bytes; default '1MB'; a grant always admits one record
}
/** log mode: every committed record of the selection from the cursor, in order per partition,
 *  never conflated. It opens when read() is called, so 'latest' is the log's end at that moment.
 *  Iterating throws 'expired' (with `earliest`) or 'unknown-log'. A live reader ends only on
 *  break, close() or `until` (E-22 C10). */
export interface LogReader<Row> extends AsyncIterable<Entry<Row>> {
  readonly cursor: Cursor   // just after the last entry yielded
  readonly gaps: number     // durability 'none' only: restarts at 'latest' after a writer change
  close(): void
}
export interface Entry<Row> {
  rec: Rec                  // the logged record, decoded for user code (DATA-03; see Rec)
  row?: Row                 // rec.value when the record writes a whole row
  partition: Partition
  version: Version
  t: Time                   // writer time
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
  key?: string        // a caller key: runs at most once within `ttl`; a retry gets the first result
  ttl?: Duration      // default '1d'
  timeout?: Duration  // default '10s'
}
export interface Call<R> extends PromiseLike<R> {}
/** A method that returns a view streams: await it for one picture, open() it for a live mirror.
 *  The stream carries data's full records, order moves included (ViewRec, E-22 D12). */
export interface LiveCall<T> extends Call<T> {
  open(): ReadonlyData<T> & { readonly ready: Promise<void> }   // ready: the first picture landed (E-22 C8)
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
  tap(fn: () => void): () => void   // returns: stop
  readonly writes: WritesView
}
export interface ClusterShape {
  id: string                  // the cluster id minted at genesis
  project: string
  writable: boolean           // every group holding this resource has a writer that heard from a majority within election.ms
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
  groups: Record<string, {    // the project's groups that hold this resource's slots
    voters: string[]; learners: string[]; leader: string | null; live: number; lag: number
    slots: number             // how many of this resource's 4,096 slots it holds
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
  | 'limit' | 'disk-full' | 'read-only' | 'memory-only' | 'busy' | 'quarantined' | 'repairing' | 'divergence'
  | 'skew' | 'slow' | 'version' | 'unplaced' | 'store-down'
export interface WritesView {
  snapshot(): WriteRow[]      // this process's last 64 attempts
  tap(fn: () => void): () => void
  lookup(id: AttemptId): Promise<WriteRow>   // asks the writer: committed, refused, or unknown once its session lapsed
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
  | 'too-many-keys'                         // (new) past the resource's bound of live caller keys (F-13)
  | 'needs-persisted'                       // the memory rung only (RR-14)
  // reads (L3, L4)
  | 'shortfall' | 'holistic' | 'expired' | 'unknown-log' | 'schema-changed'
  // calls (L4)
  | 'no-method' | 'threw' | 'busy'
  // the outcome is unknown
  | 'timeout' | 'unknown' | 'destroyed' | 'restored'
  // libraries (L5)
  | 'locked' | 'limited' | 'no-answerer' | 'no-undo'
  // config and admin
  | 'config' | 'node-config' | 'config-differs' | 'too-many-resources' | 'admin-only' | 'stale-plan'
  | 'dir-held' | 'wrong-project' | 'wrong-cluster' | 'no-server-here' | 'unbound'
  // inside fero only: the client acts by itself; seen only in cluster.writes and the debugger
  | 'no-writer' | 'moved' | 'retry' | 'end' | 'wrong-group' | 'stale-attempt' | 'empty'

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
  /** (new) A saved cursor's text back as a Cursor, with its form checked (E-22 D8). Text that is not
   *  a cursor throws 'unknown-log'; a cursor of another cluster or resource is refused 'unknown-log'
   *  when read() opens it. */
  function cursor(text: string): Cursor
  function spawn(file: string, args?: string[], opts?: { stdin?: 'pipe' | 'ignore' }): Spawned
  /** Binds this process: later fero() calls resolve in it. seed default: random, printed;
   *  start default 0; shuffle default true. */
  function world(opts?: { seed?: number; start?: Time; shuffle?: boolean }): World
  /** (new) A version's number form, for gateways (E-45 F1, A-10). It is below 2^63 and keeps one
   *  partition's order, with room below it for a record's place in a batch. */
  namespace version {
    function toNumber(v: Version): bigint
    function fromNumber(n: bigint): Version
  }
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
  'election.ms': number             // default 2000 in TS; under 1000 at the native step (A-02); > 2 × ping.ms
  'election.jitter': number         // default 0.25 × election.ms: 500 in TS (A-02)
  'evict.after': Duration           // default '10m'
  'settle.ms': number               // default 30000
  'catchup.max': Duration           // default '10m'
  'skew.max': number                // default 250: the clocks' agreement bound (A-23); < election.ms
  'lag.max': number                 // records; default 1000
  'session.ms': number              // a session's lease; default 10000
}
export interface Spawned {
  pid: number
  out: string
  exited: Promise<number | null>
  stop(): Promise<number | null>
  write(line: string): void
  child: unknown            // Node's ChildProcess
}
/** Under a world, setTimeout and setInterval (and clear, ref, unref) run on its clock (E-22 D1). */
export interface World {
  readonly seed: number
  now(): Time
  id(): string
  advance(by: Duration): Promise<void>   // move virtual time; timers, leases and TTLs fire in order
  close(): Promise<void>
}

// ── L5 libraries: each one file, built only from the verbs above, no wire verb of its own ──
// Their own resources are always 'persisted' (RR-14).
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
  /** returns: ack; throws: nack. Default: every partition, spread over the live workers. */
  work(fn: (job: Job, msg: Msg<Job>) => unknown, opts?: { concurrency?: number /* 1 */; partitions?: readonly Partition[] }): Runner
}
export interface AddOpts {
  partition?: Partition     // FIFO within a partition; default 'main'
  id?: string               // idempotent: a second add of the same id is a no-op
  delay?: Duration          // from writer time, by op.now (E-22 D5)
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
  /** The claim's token. extend and nack are touches, which give the row a new version (E-22 C11),
   *  so each one replaces this with its Ack.version, and ack uses the newest (as E-22's queue does). */
  readonly token: Version
  ack(): Promise<void>                        // 'conflict' if the lease had lapsed and it was taken again
  nack(opts?: { delay?: Duration }): Promise<void>   // a touch: held by nobody until `delay` ends
  extend(lease?: Duration): Promise<void>     // a touch of the lease, if the claim still holds
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
  readonly token: Version      // the version of the write that took the lock; renewals keep it (E-22 C6)
  readonly fence: Fence        // pass as `if: { fence }` on every protected write
  readonly lost: Promise<void> // the lease lapsed before a renewal landed
  renew(): Promise<void>       // only needed with renew: false
  release(): Promise<void>
}

export declare function group<Row>(source: Resource<Row, any>, name: string, opts?: GroupOpts): Promise<Group<Row>>
export interface GroupOpts {
  from?: 'earliest' | 'latest'   // where a share starts when it is first taken; default 'earliest'
  lease?: Duration               // membership lease; default '10s'
  max?: number                   // entries per batch; default 100
  shares?: number                // shares the source is cut into, at most 4,096; default 16 (E-22 D16)
}
export interface Group<Row> extends AsyncIterable<GroupBatch<Row>> {
  readonly member: string
  readonly owned: number         // shares this member owns now; each share has its own token
  /** Exactly once: each output's entry carries the derived-once mark (per consumer, source slot
   *  and output slot, the highest source sequence applied), carried when its slot moves (A-05). */
  run(fn: (e: Entry<Row>, out: Out) => unknown): Runner
  leave(): Promise<void>
}
export interface GroupBatch<Row> {
  readonly entries: Entry<Row>[]
  commit(): Promise<void>        // at least once; 'fenced' when this member no longer owns the share
}
export interface Out { use<R2>(target: Resource<R2, any>): Verbs<R2> }

export declare function derive<A, B>(
  source: Resource<A, any>, target: Resource<B, any>,
  fn: (e: Entry<A>, out: Verbs<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>

/** A unit across partitions: it ends all applied or all undone, by its holder or a later one
 *  (A-24). Readers may see half of it. A step on a 'memory' resource is refused before the first
 *  step (RR-14); a step whose op has no inverse and no `undo` is refused 'no-undo' (E-22 F4). */
export declare function saga(steps: readonly Step[], opts?: SagaOpts): Promise<Ack[]>
export declare namespace saga {
  /** (new) On a server: finish or undo every unit whose holder's lease has lapsed (E-22 D16). */
  function sweep(opts?: { every?: Duration /* '10s' */ }): Runner
}
export interface Step {
  to: Resource<any, any>
  key: Key | Path
  value?: unknown            // a value or an op
  remove?: true
  if?: Cond
  undo?: Op | { value: unknown } | { remove: true }   // needed for push, merge, max, min and now
}
export interface SagaOpts {
  id?: string                // default fero.id(); kept 1 day; a later call with this id finishes or undoes it
  lease?: Duration           // the locks' lease; default '10s'
}

export declare function limiter(name: string, opts: { max: number; per: Duration }): Promise<Limiter>
export interface Limiter {
  take(key: string, n?: number): Promise<{ left: number; reset: Time }>   // else 'limited', with retryAfter
}

/** Persisted: an ask is three commits (E-22 D7). */
export declare function service<Req = unknown, Res = unknown>(name: string): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string /* 'main' */; concurrency?: number /* 1 */ }): Runner
  ask(req: Req, opts?: { timeout?: Duration /* '10s' */; group?: string /* 'main' */ }): Promise<Res>   // 'no-answerer' at once, or 'timeout'
}

/** perSec default: adaptive; it backs off while commit p99 is above twice its steady value. */
export declare function migrate<A, B>(res: Resource<A, any>, opts: { to: number; fn: (row: A) => B; perSec?: number }): Promise<MigrateJob>
export interface MigrateJob { readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }

/** One tape is one partition, so it replays in order (E-22 D14). */
export declare function tape<In = unknown, Out = unknown>(name: string, opts?: { window?: Duration /* '14d' */ }): Promise<Tape<In, Out>>
export interface Tape<In, Out> {
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
  replay(from?: Cursor): AsyncIterable<{ match: string; input: In; answer: Out; version: Version }>
}

/** A protocol front so each competitor's own tool can drive fero (PERF-01, E-45). */
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string /* 'kv' */ }): Promise<{ close(): Promise<void> }>
```

## 4. What the types cannot say

**Roles.**
- A process is a **server** if it sets a server marker: `server: true`, `listen`, `dir`, `seeds`, a `data` seed, `methods`, or a code key (`validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`). Otherwise it is a **client**.
- `listen: false` is a socketless solo node: the only voter of every group, for tests (TEST-01).
- **Any process may create a resource whose keys are all declarative** (`partition`, `rows` without `where`, `history`, `durability`, `copies`, `standbys`). Code keys need a server. A queue worker can then make its own queue ([E-22] D2, [E-45] F2).
- A resource needs a server somewhere in the project. Until one runs, writes wait as `pending` rows of `cluster.writes`, and health shows `unplaced` ([E-22] C1).
- A client follows the whole resource, unless it sets `cache.memory`. Then it follows only what it reads or `follow`s, and drops the least recently read when full.
- A server folds every group it replicates, with `data` (F `all`). By default every server holds a full copy of each group, up to `standbys` (5). Other rows are one hop away.
- Node keys come from the first `fero()` in the process or from the cascade, never per name: `--fero.shop.dir` is refused `config`. Resource and open keys may be per name.

**Answers.**
- Every verb answers **after its commit**, at the resource's rung.
- **A refusal waits too.** A refusal, an empty `claim` and a `call-diverged` answer are sent only once the log end they were judged on has committed ([A-04](AMENDMENTS.md)). Before this fix, a write could be refused because of a write that was then lost (10 of 100 seeds of a planted race, [E-22]).
- If this process follows the partition, the promise resolves only once its own view shows the write (read-your-writes).
- A **plain assignment** is the same write with no promise. It shows when it commits. A refused one never shows; it appears as a `refused` row of `cluster.writes` and as one stderr line.
- `outcome: 'refused'` means it never committed and never will (F-02). `outcome: 'unknown'` means it may have. fero keeps resending that attempt in the background while its session lives, until it gets a definite answer. `cluster.writes.lookup(attempt)` says how it ended.
- **fero retries by itself**, with jittered backoff from 200 ms to `election.ms`, and honours every `retryAfter`. An app never resends a write. A new try of the same change is a new attempt, judged afresh, unless it carries the same caller key.
- **Issue order (new).** One process's writes to one partition commit in the order it issued them, even when it does not await each one ([A-10](AMENDMENTS.md)). E-45 saw the prototype break this in 12 of 100 seeds, with a leader change inside a burst ([E-45] F4).
- **Admission.** Each client may have only a granted number of writes in flight: a credit window ([A-07](AMENDMENTS.md)). The rest wait in the client. A client holds at most 512 waiting writes or 64 MB, then refuses `backpressure`. A write still waiting at its `timeout` fails `timeout` with `outcome: 'refused'`, since it was never sent.

**Sessions and retries** (D `sess`, [E-20]).
- Each process has one session. fero registers it in `#sessions` and renews its lease within `session.ms` (10 s).
- Each write carries its session and a sequence. The writer keeps, per session, a floor and the answers it gave. A resend gets the first answer. A copy below the floor is dropped. E-20 model-checked this at 13 rules, with no time rule.
- Under `fwd`, a server forwards a copy only once (`forward.once`, [A-21](AMENDMENTS.md)). That is what keeps "a refused attempt never commits later" true when refusals are not logged.
- **The floor comes first on every path that judges a copy, the fence check included** ([E-32]'s first rule). So a retry of a fenced write that committed answers `ok`, never `fenced`. Without it, composing found a write both applied and refused in 6 steps.
- A snapshot keeps the floor, the answers, the derived-once marks and the highest lock tokens beside the rows. A slot move carries the floor and the marks ([E-32]'s other two rules). So retries stay exactly once across snapshots and moves.
- The dedup check compares the change (the key, the value or op, a remove), not its `if` ([E-22] D4). The same id with a different change is refused `call-diverged`.
- **Caller keys.** `id` on a write and `key` on a call are keys the app picks. A resend or re-run with the same key within 1 day gets the first answer (TEST-03, A-10, [E-22] D3). A key costs about 221 B for its day ([E-20]), so use them for retries across processes, not on every write.
  - **Their bound (new; proposed here, untested).** Unbounded, the key table grows with the count of keyed writes: E-20 puts it at 13 GB for a 10-minute life at 1e5 writes a second. F-13 forbids that.
  - So a resource keeps at most 1,000,000 live caller keys, about 211 MB at E-20's measured size. Each group that holds its slots keeps its share, rounded up, as `rows.max` does. The keys also count toward the server's `memory` bound.
  - Past the bound, a write or call with a new key is refused `too-many-keys`, with `retryAfter` set to when the oldest key lapses. A resend of a key already held still gets its first answer.
  - Where the table lives and how a move carries it: [LAYERS.md](LAYERS.md) section 3.2.
- If this process's session lapses (a pause longer than `session.ms`), its writes in flight answer `unknown`. Its session-bound rows go, and it starts a new session.
- Cost: about 309 B per active session at a writer. A slot move carries about 16 bytes per active session ([E-20]).

**At the writer (L2), in this order:**
1. dedup (the floor);
2. the rung rule (with the `memory` rung only);
3. shape checks (`absent-row`, `absent-path`, `sparse-hole`);
4. `validation`, `schema` and `rules.write`;
5. conditions (a fence among them);
6. ops.

- The writer appends results only. Followers, clients and replays apply plain values.
- So writer-side code may be non-deterministic, but it must be synchronous and must not read app state.
- `load` is the exception: it is asynchronous and lands later as an ordinary write.
- Writer-side code is only the code keys, registered by hash on every server. A call never carries code to a writer, since a client has none to send. So a `claim`'s filter is a field name, `due`, not a function (new).

**Ops on what is missing.** An op on a missing row, or on a missing field of a row that exists, starts from its identity. So `incr` starts from 0, `push` from `[]` and `merge` from `{}`; `max`, `min` and `now` take the value. A field write or field op on a row that does not exist is refused `absent-row`. So a counter is its own row, or a field of a row you created first.

**Rungs** (Q `mix`).
- `durability` is set per resource, never per write. The project's groups are cut by rung, so one group never mixes two (AMENDMENTS 4, note 13).
- `persisted` (the default): on disk at a majority. It survives a power loss of every member.
- `none`: no disk, no log, best effort. It needs `rows: false`. Readers count restarts in `gaps`. Its failover rule was never modelled (K-10).
- `memory` (with the rung only): in memory at a majority, and the disks catch up within about a second. If a majority stops uncleanly inside that second, the acknowledged tail is gone. `fero recover --unclean` lists what may be lost before it runs (F-12).
- **RR-14's rule (with the rung).** Locks, fences, sagas and session-bound writes never sit on a `memory` resource. On a `memory` resource:
  - a write with `if: { fence }` is refused `needs-persisted`;
  - a write with `while: 'session'` is refused `needs-persisted`, and `rows: { while: 'session' }` is refused at create;
  - `saga()` refuses a unit with a step there before its first step.
  - The libraries keep their own state (`#locks`, `#sagas`, `#sessions`, `#calls`, a queue, a group's cursors) on `persisted` resources.
- **RR-13's recovery rule (with the rung).** After an unclean stop, a `memory` group's recovery starts a new session generation for its slots, as a restore does ([A-08](AMENDMENTS.md)). A late copy from before is answered `restored`, never judged again.
  - The recovery also takes new epochs for the group's slots, recorded in the restore mark before use (RR-12; A-08). So no version or cursor position from the lost tail is ever handed out twice.
- Why: the lost tail can take back a fence raise, a refusal or a saga step. So P-10, F-02 and P-15 are open for COMP2 until these rules are modelled (RR-11 to RR-13; VERDICT §9 step 2b).

**Reads.**
- `f.data`, `f.snapshot`, a `follow` view, and `get` of a held row read this process's committed fold, with no hop.
- A row handed out is deep-frozen, so a read by reference cannot change it (DATA-07). COMP2's cell is open: in E-22's probe, a row read through a `filter` view was not frozen.
- Every read carries the highest version this process has seen in that partition. A server answers only once its fold has reached it. So a process never reads older than what it already saw or wrote.
- A near-cache miss (`get` of a row not held) is answered from a server's fold. That fold may trail a write another process already had acknowledged. `get(key, { fresh: true })` is the linearizable form ([E-22] C11).
- `fresh: true`: the writer confirms it still leads (Raft's read index), then answers. One round trip, no fsync.
- **Sync reads never guess.** A row of a partition this process does not hold throws `shortfall`. An operator over every row of a partial picture throws `holistic`.

**Cursors and `end`** ([E-31], [A-06](AMENDMENTS.md)).
- A cursor holds one (epoch, sequence) per slot. It keeps its meaning across failovers and slot moves. A cursor made of group offsets broke at the first move in E-31's model (5 steps).
- A replica that lacks a reader's next record answers `end`. The client resubscribes elsewhere with its cursor, by itself.
- Only the leader of the group that holds the slot says `expired`. As drafted, a follower that reloaded a snapshot ended a log reader for good (7 steps).
- So a reader hears `expired` only when no live replica holding the slot has its next record. E-31 model-checked this through a leader crash, a reload, a dropped link, a relay crash and a slot move. It took 26 rules, on ten bounds of up to 7.6 million states.
- **Size.** A whole-resource cursor holds up to 4,096 entries, and its bar is 8 KB (Q-19). E-19's coding gave 1.0 to 3.3 KB at 1,024 slots. At 4,096 that scales to about 4 to 13 KB (reasoned, G-06).
  - Phase 1 measures it. If it is over the bar, the slot count falls back to 1,024 ([VERDICT §9](VERDICT.md#9-the-next-step), kill table, step 4).
  - A reader of 1 to 10 partitions holds 22 to 79 B ([E-19]).

**Order.** Total within a partition. None across partitions, ever.
- Under a world, and with `shuffle`, deliveries interleave partitions in a seeded order that keeps each partition's own order. So code that leans on order across partitions fails in test (TEST-12). E-22's planted app failed in 25 of 100 shuffled seeds and never without the shuffle.
- In log mode the shuffle keeps each slot's order, so a cursor stays exact ([E-22] C7).

**Versions.**
- Two versions of one partition compare with plain string `<`, in log order, across failovers, moves and restores. So an outside system can check a lock token with `<` (P-10).
- With the `memory` rung, this also holds across a `memory` group's unclean recovery. `fero recover --unclean` takes new slot epochs, so an (epoch, sequence) from the lost tail never names a second record (RR-12's recovery, as above).
- **(new)** `fero.version.toNumber(v)` gives a number below 2^63 that keeps the partition's order. Gateways need it for etcd revisions, Kafka offsets and JetStream sequences ([E-45] F1). Apps never need it.
- **(new)** `read({ partitions: [p], from: version })` starts at that record ([E-45] F1b).

**Values.** Rows are JSON-like values. **(new)** `Uint8Array` is a value too, kept as bytes on the wire ([E-45] F3, DATA-03). A bigint, a function, a `Date`, a `Map`, a `Proxy` or nesting deeper than 60 is refused `unencodable`.

**Time** (T `clamp`, [A-23](AMENDMENTS.md), [E-21]).
- Writer time is the median of the members' clocks, the writer's own included. Each reading is carried forward by the receiver's monotonic clock. It never goes back.
- E-21 simulated it at 7 rules. With one wrong clock, the leader's included, every check passed and no failover happened. Rows went at worst 100 ms early and 300 ms late by real time.
- **When most clocks disagree, the group stops writing** rather than expire rows by a wrong time. That is the agreement guard, 9 rules in all, in force until the user says otherwise ([VERDICT §8](VERDICT.md#8-what-the-user-must-confirm) item 12). Health shows `skew`.
  - No rule sees two clocks that jump together by the same amount ([E-21]).
- A new writer of `#sessions` or `#locks` gives every lease at least one `election.ms` to be renewed ([E-22] D10). So a lease can outlast a pause by one election each time its group elects ([E-22] F5).
- **Expiry, presence and delays are judged while a writer exists.** With no writer they wait. E-22 saw a row expire 2,036 ms late with a failover near its ttl ([E-22] D9).
- `fero.now()` and `fero.id()` are the wall clock and random ids live, and the world's clock and seeded ids under test. `ctx.now()` is the call claim's writer time for a keyed call (TEST-02).
- Under a world, `setTimeout`, `setInterval` and their `clear`, `ref` and `unref` run on the world's clock ([E-22] D1).

**Methods** (U `any`).
- A handler runs on the server the caller reached. `ctx.data` is that server's committed fold, which may trail the writer.
- **A check-then-set must carry a condition or be an op.** In E-22, a plain read then a plain set sold the last item twice in 120 of 120 races. That happened wherever the calls ran, even after a `fresh` read. The condition and op forms never did (0 of 240).
- Running at the writer is not the safety, so there is no `at: 'writer'` option ([E-22] C5, D15).
- A **keyed call** (`{ key }`) claims a row in `#calls` first. It runs at most once within its `ttl`, and a retry gets the first result.
  - If its server dies, it is re-run elsewhere when the claim's lease lapses, with the same attempt ids, `ctx.now()` and `ctx.id()`.
  - So handlers must be deterministic given `arg` and `ctx`. A re-run that writes a different change is refused `call-diverged`.
- An **unkeyed call** whose server dies answers `unknown`: it may have run. fero does not resend it.
- A handler that returns a data view streams (`LiveCall`). `open()` gives a handle with `ready` ([E-22] C8).
- A handler that throws answers `threw` with its message; writes it made before the throw stay. A `FeroError` that escapes a handler keeps its own code: a sold-out `sell` answers `conflict`, not `threw` ([E-22] C3).
- `while: 'session'` inside a method binds the caller's session.

**Locks and fences** ([A-24](AMENDMENTS.md), [E-24], [E-21]).
- A lock is a row of `#locks`. Its token is the version of the write that took it; renewals keep it ([E-22] C6). Tokens strictly rise, across failovers, moves and restores.
- A fenced write (`if: { fence }`) is judged by its own partition's writer. Each group keeps a fence table: per lock, the newest token it has accepted. It keeps that token after the lock row is gone ([E-22] D11).
- Writers do not follow `#locks`. Following was not enough without a bound on delay, and not needed ([E-24]).
- **So:** no write commits under a token older than one this partition's writer has accepted.
  - A stale write can still land between a new grant and the new holder's first write there ([E-22] F5).
  - To fence a partition at once, write to it with the new token first (E-24's `bump`, after Kafka's epoch bump).
- Fencing does not lean on clocks. In E-21, no protected write committed under an old token under any clock rule, even the raw clock.
- A restore restarts the fence tables above every token handed out (OPS-07, [E-33]).

**The door and tokens.**
- With `methods:` declared, clients change data only through the methods. A plain client write is refused `methods-only` (V4-5). Reads stay open unless `rules.read` or a token limits them.
- A token from `fero.token(claims)` limits what a client follows, calls and writes. Servers check it when a follow opens, on every write and call, and on every record a relay, a prefix, a view or a method's returned view forwards.
- `fero.revoke(sub)` ends access within one `ping.ms` (OPS-10). E-22 did not build tokens; OPS-10's closer is a hostile-client suite.

**Sizes and stated ceilings** (SC-10).
- A record is at most 1 MB and a row at most 64 MB (sent in frames). Larger is refused `too-large` before it is appended (SC-15).
- 4,096 slots per resource ([A-16](AMENDMENTS.md)). One partition is one writer.
  - With the app splitting every partition above half a writer's share, a resource reaches about 135 effective writers ([E-18]). At the 1,024 fallback it is 72.
- One `data` source holds at most 16,777,216 rows ([A-13](AMENDMENTS.md), [E-34]). The heap is sized from rows, and rows per process are bounded.
- `limit`, `reverse`, `reduce` with no merge function, and exact quantiles need one process that folds every group. So they are bounded by rows per process (A-10).
- `rows.max` is kept per group as its share, rounded up. So the resource holds at most `max` plus one row per group that holds its slots ([E-22] D13).
- An idle resource costs about 85 B per touched slot. It is 0.4 to 1.2 KB at 1 to 10 touched slots ([E-36]).
- Every other queue is bounded and refuses with a reason (F-13).

**Starting, stopping, restoring.**
- **Genesis.** On one box, the first server founds the cluster in `.fero/`. Across boxes, the cluster id is created in the object store at the first start, by a conditional write ([A-08](AMENDMENTS.md), [E-33]: 4 rules).
  - `seeds` name the founders. They never run beside a dir that holds an id. A running cluster grows by `hosts`.
  - The draft's "a majority of seeds with no id" founded two clusters in 10 steps ([E-33]).
- One process per `dir`: a second one is refused `dir-held` (V4-59).
- `destroy()` closes one handle. The last handle in a server process also leaves the cluster: it retires, then hands over leadership. Under `FERO_SUPERVISED` it only hands over, because a restart is coming.
- **Restore** (`fero restore`, an admin step). It takes an epoch above every epoch ever used, which the object store's manifest records, and starts a new session generation ([E-33]: 8 rules).
  - A cursor from before is refused `unknown-log`. A retry from before is answered `restored`, never re-run. Fence tables restart above every token handed out (OPS-07).
- A slot move records its new epoch in the store first, so a move waits while the store is down (F-15 restated, VERDICT §8 item 11). Writes and reads go on, and health shows `store-down`.

**Under test.**
- A name bound to nothing under a world is a loud `unbound`, never a silent network call (TEST-04).
- A live reader that can never be woken is reported as such, not as Node's exit code 13 ([E-22] C10).
- A tape is one partition ([E-22] D14). `fero.fork` is not built yet (TEST-06 is open).

## 5. Errors and refusal codes

Every refusal is a `FeroError`. `code` says what, `outcome` says whether it may have committed, `hint` says the fix.

| Code | Layer | Outcome | When | Fields |
|---|---|---|---|---|
| `conflict` | L2 | refused | a condition failed, or an op's bound would be crossed; sent once the log end it was judged on has committed (A-04) | `current` |
| `fenced` | L2 | refused | a fence token older than one this partition's writer has accepted; a group commit from a member that no longer owns the share | `current` |
| `absent-row` | L2 | refused | a field write or a `touch` on a row that does not exist | |
| `absent-path` | L2 | refused | a field write whose parent field does not exist | |
| `sparse-hole` | L2 | refused | a remove of an array's own element: write the spliced array | |
| `invalid-key` | L4 | refused | a key data cannot fold | |
| `unencodable` | L4 | refused | a value that would not arrive unchanged (a bigint, a function, a Date, a Map, a Proxy, deeper than 60); `Uint8Array` is fine | |
| `too-large` | L3, L4 | refused | a record over 1 MB, a row over 64 MB, a read answer over one frame | |
| `cross-partition` | L4 | refused | a `batch` whose keys span partitions | |
| `no-rows` | L2 | refused | an op, a claim or a condition on a `rows: false` resource | |
| `schema` | L2 | refused | `schema` said no | `path`, `reason` |
| `invalid` | L2, L4 | refused | `validation` returned a reason | `reason` |
| `rule` | L2 | refused | `rules.write` returned a reason | `reason` |
| `rule-threw`, `rule-timeout` | L2 | refused | a rule threw, or held the writer too long; a rule that keeps timing out is quarantined | |
| `methods-only` | L4 | refused | a client's plain write to a resource with `methods:` | |
| `forbidden` | L3, L4 | refused | the token or `rules.read` does not allow it | |
| `call-diverged` | L2 | refused | a different change under an id already used (key, value or op, remove; not its `if`: [E-22] D4) | |
| `read-only` | L2 | refused | the write gate is closed, or the server is near its `memory` | `reason`, `retryAfter` |
| `disk-full` | L0 | refused | the disk is at its hard limit; reads go on | `retryAfter` |
| `backpressure` | L4 | refused | this client holds 512 waiting writes or 64 MB | `retryAfter` |
| `too-many-keys` | L2 | refused | (new) a write or call with a new caller key, past the resource's bound of live keys (F-13) | `retryAfter` |
| `needs-persisted` | L2, L5 | refused | with the `memory` rung: a fenced write, a `while: 'session'` write or a saga step on a `memory` resource (RR-14) | |
| `no-method` | L4 | refused | no method of that name | |
| `threw` | L4 | refused | the handler threw its own error; writes it made before stay | `reason` |
| `busy` | L4 | refused | every server tried has a stalled main thread | `retryAfter` |
| `timeout` | any | unknown | no definite answer within `timeout`; `refused` if the write never left the client | `attempt`, `cause` |
| `unknown` | L2, L4 | unknown | the session lapsed with the write in flight; an unkeyed call lost its server | `attempt` |
| `destroyed` | L4 | unknown | the handle closed with the write in flight | `attempt` |
| `restored` | L2 | unknown | an attempt from a session generation before a restore, or before a `memory` group's unclean recovery; it will not run now | `attempt` |
| `shortfall` | L4 | thrown | a sync read of a partition this process does not hold | |
| `holistic` | L4 | thrown | an operator or enumeration over a partial picture | |
| `expired` | L3 | thrown by a reader | its cursor is older than `history`; said only by the leader of the group that holds the slot (A-06) | `earliest` |
| `unknown-log` | L3 | thrown by a reader, or by `fero.cursor` | a cursor of another cluster, a re-created resource, or from before a restore; text that is not a cursor | |
| `schema-changed` | L4 | thrown by a reader | an old record or tape that the upcasters cannot bring to this version | |
| `locked` | L5 | refused | the lock is held past `wait` | |
| `limited` | L5 | refused | over the limit | `retryAfter` |
| `no-answerer` | L5 | refused | no live answerer in the group, by this process's view of presence | |
| `no-undo` | L5 | refused | a saga step whose op has no inverse and no `undo` ([E-22] F4) | |
| `config`, `node-config`, `config-differs` | L4 | thrown by `fero()` | a bad key or value (or `durability: 'memory'` before the rung is built); a node key unlike this process's; a resource key unlike the catalog's | |
| `too-many-resources` | L1 | refused | past the project's resource limit (SC-13) | |
| `admin-only` | L0 | refused | a planner, `drop`, recover or restore verb without the admin key | |
| `stale-plan` | L1 | refused | a hint that names an old group configuration | |
| `dir-held` | L0 | thrown by `fero()` | another live process holds `dir` | |
| `wrong-project`, `wrong-cluster` | L0 | thrown by `fero()` | a dir or a peer of another project or cluster | |
| `no-server-here` | L4 | thrown by `fero()` | a server marker in a browser or an edge worker | |
| `unbound` | L4 | thrown by `fero()` | under a world, a name that nothing binds | |

**Inside fero only:** `no-writer`, `moved`, `retry`, `end`, `wrong-group`, `stale-attempt` and `empty`. The client acts on them by itself. It retries, follows `moved`, resubscribes after `end` with its cursor (A-06), or resolves an empty `claim` with `[]`. A member that cannot forward a write refuses it at once with a redirect, never holding it ([A-02](AMENDMENTS.md)). An app sees these codes only as a `timeout`'s `cause`, in `cluster.writes` and in the debugger.

## 6. Config keys

The cascade is v4's: `--fero.<key>` beats the call, which beats `FERO_<KEY>`, then the project's `fero.opt.ts`, then `$HOME`'s, then the default (OPS-03). Layers below: **f** flag, **c** call, **e** environment, **p** a `fero.opt` file. Types and defaults are in section 3.

| Scope | Keys | Layers | Changes |
|---|---|---|---|
| node | `project`, `server`, `listen`, `advertise`, `hosts`, `seeds`, `dir`, `object`, `rendezvous`, `redial.ms`, `redial.tries`, `leave.ms`, `journal.cap`, `memory`, `connect.wait`, `shuffle` | fcep | restart |
| node | `uuid` | fce (one shared file would give every process one identity) | restart |
| node | `secret`, `token`, `admin`, `diag.allow` | cep (a secret never rides the command line) | restart; `secret` rotates online through `#meta` (OPS-06) |
| open | `cache.memory`, `bind` | fcep, per name | the next open |
| open | `signals` | c | the next open |
| resource | `partition.before`, `history`, `rows.ttl`, `rows.max`, `rows.while`, `durability`, `copies`, `standbys`, `shape.version` | fcep, per name; written at create, compared at every later open | `fero.alter` (for `durability` and `copies`, see Q-A25) |
| resource | `data` | cp (an object of rows) | applied once, at create |
| resource | `methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up` | c (code; registered by hash) | a roll: `fero.alter` adds the new hash first |
| cluster | `copies.meta`, `copies.default`, `ping.ms`, `election.ms`, `election.jitter`, `evict.after`, `settle.ms`, `catchup.max`, `skew.max`, `lag.max`, `session.ms` | `fero.alter('#meta', …)` or `fero alter '#meta' key=value` | online, with range and cross-key checks (`election.ms` > 2 × `ping.ms`; `skew.max` < `election.ms`) |

- **Defaults from the evidence:** `election.ms` 2 s in TypeScript, with jitter 0.25 of it ([A-02](AMENDMENTS.md)). CheckQuorum runs every quarter of `election.ms`; that is a fixed rule, not a key.
  - At those values the worst failover draw is about 2.5 s plus 5 to 20 ms, against F-05's 2.5 s. So step 7 may set `election.ms` a little lower, at about 1,980 ([VERDICT §9](VERDICT.md#9-the-next-step) kill table).
  - At the native step `election.ms` goes under 1,000 (A-02).
- **Gone:** `issuer.window`. It belonged to draft 1's dedup window (D `win`); client sessions need no window ([E-20]).
- **Proposed here, untested:** `skew.max` 250 ms, `lag.max` 1,000 records, `session.ms` 10 s, `connect.wait` 10 s, a caller key's life 1 day, a token's `ttl` 1 hour, a write's `timeout` 10 s (v4's). E-21 and E-22 ran with `skew.max` 250 ms and `session.ms` 10 s.
- Each new key gets what v4's rule asks: a row in `LEAVES`, a coercion if it needs one, a README row and a `config.test.ts` case ([CLAUDE.md](../../CLAUDE.md), "The two seams").

**The CLI (L5)** keeps v4's verbs. It adds DESIGN-V5 §4.6's: `fero run`, `test`, `deploy`, `ls`, `debug`, `recover`, `restore`, `join-token`, the planner's `drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `groups`, and `alter`, `drop`, `export` (OPS-07), `migrate` (a v4 `dir`, DEP-19). There is no `fero init`: across boxes, genesis is the object store's conditional write (A-08). Platform hints are inputs to the controller's loop, under A-20's re-checks (VERDICT §8 item 4). The flags belong to LAYERS.md.

## 7. Every pattern: the code, the guarantee, the layer

Each pattern ran on E-22's prototype as a check, under 100 seeds with and without the shuffle. Each seed had a leader change and a slot move forced into the work ([E-22]'s per-pattern table). The code below is that code, with E-22's fixes. **Status** is COMP2's judged cell ([cards.json][cards]), and what closes it if open ([VERDICT §5.4](VERDICT.md#54-every-must-it-leaves-open-restated-99)).

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

**Guarantee.** Order per partition. The answer comes once a majority has the write on disk. Read-your-writes. A held-row read is a property read (bar under 100 ns). Write p99 ≤ C + 5 ms in TypeScript. **Layer:** L4, over L2's fold and L3's follow.

**Status: open.** E-22 found every replica equal to the fold of the committed log (600 of 600 partitions linearizable). The write p99 has not been shown on a real kernel. Closer: the PERF-08 pin and example 02 on three real processes (phase 2).

### P-02 Cache with expiry, session store

```ts
// file: p02.ts — cache with expiry, session store
import { fero } from 'fero'

const cache = await fero('cache', { rows: { ttl: '10m', max: 1e6 } })   // declarative: any process may create it
await cache.set('user:42', { name: 'Ada' })
await cache.set('hot', { n: 1 }, { ttl: '30s' })                        // this row's own ttl
const sessions = await fero('sessions', { rows: { ttl: '30m' } })
await sessions.set('sid-9f2', { user: 42 })                              // a touch needs the row (E-22 D8)
await sessions.touch('sid-9f2')                                          // resets the ttl, keeps the value
```

**Guarantee.**
- The writer removes rows by writer time, as records with a reason (`ttl`, `max`). So every copy agrees on which rows exist at each position.
- By writer time a row goes within one tick of its ttl, never before (P-02 allows one tick plus `skew.max`). With no writer it waits: E-22 saw 2,036 ms late with a failover near the ttl ([E-22] D9).
- Expiry work grows with what expires, not with what is held.
- `max` is kept per group, as its share rounded up ([E-22] D13).
- **Layer:** L2.

**Status: open.** By writer time while a writer exists, it held ([E-21], [E-22]). Owed: the expiry-tick pin at 1e3 to 1e6 rows. Read to the letter, a failover breaks the bound for every one-writer design (VERDICT §8 item 20).

### P-03 Near cache, client data sync

```ts
// file: p03.ts — near cache, client data sync
import { fero } from 'fero'

const users = await fero('users', { cache: { memory: '200MB' } })   // follows only what it reads
const u = await users.get('u42')               // one hop, from a server's fold; from now on u42 is followed
const sure = await users.get('u42', { fresh: true })   // linearizable: the writer confirms it leads
const same = users.snapshot.u42                // sync; u7 (never read) would throw 'shortfall'
const mine = users.follow(['u42', 'u43'])      // a snapshot of exactly these, then deltas
await mine.ready
mine.tap(() => console.log(mine.snapshot()))
console.log(u, sure, same, mine.cursor())      // a reconnect resumes from the cursor by itself
```

**Guarantee.**
- A miss is one hop, then the partition is followed. The miss reads a server's fold, which may trail another process's acknowledged write; use `fresh` when that matters ([E-22] C11).
- A snapshot, then deltas, with no gap and no overlap. A reconnect resumes from the cursor and misses nothing. A replica that cannot serve says `end`, and the client moves on by itself (A-06).
- A sync read of a row not held throws `shortfall`, never a stale answer. Memory stays inside `cache.memory`.
- **Layer:** L3.

**Status: met.** [E-31] model-checked the cursor property across a leader crash, a reload, a slot move and a relay. E-22's near-cache check passed.

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

**Guarantee.** One `load` per key however many readers miss at once. The loaded row is written with `if: { absent: true }`, so a write that lands during the load wins. `undefined` writes nothing. **Layer:** L4, using L2's condition at the writer.

**Status: met.** In E-22, six readers missing one key made one load, and a write during the load kept its value. Both held in 100 of 100 seeds in each mode.

### P-05 WebSocket fan-out by room

```ts
// file: p05.ts — websocket fan-out by room (two files)
import { fero } from 'fero'

// ── chat.ts, a server: a room is a partition, a message a row
await fero('chat', { server: true, partition: { before: '/' }, rows: { ttl: '1d' }, history: '1d' })

// ── web.ts, a webserver: a client that follows only the rooms its sockets joined
const chat = await fero('chat', { cache: { memory: '200MB' } })
wss.on('connection', (ws, room) => {
  const live = chat.follow(room)                                    // snapshot, then deltas, encoded once per link
  live.ready.then(() => ws.send(JSON.stringify(live.snapshot())))   // the room so far (E-22 D8)
  live.tap((r) => ws.send(JSON.stringify(r)))                       // then each change
  ws.on('message', (text) => { chat.data[`${room}/${fero.id()}`] = { text, at: fero.now() } })
  ws.on('close', () => live.close())
})
```

**Guarantee.**
- Order per room. A webserver never receives a room it does not follow. Each record is encoded once per link. A reconnect within `history` misses nothing.
- Delivery: a relay batches each room for a bounded few ms, and about 1,000 sockets a core keep a round near 10 ms ([A-11](AMENDMENTS.md), [E-08]). That is P-05 as restated (RR-02, VERDICT §8 item 6).
- **Layer:** L3.

**Status: open as worded, met as restated.** As worded, "C + one hop" is about 0.83 ms. E-08's relay alone had p99 1.2 ms at 1,000 subscribers. That is why the bar is restated.

### P-06 Pub/sub

```ts
// file: p06.ts — pub/sub
import { fero } from 'fero'

const news = await fero('news', { rows: false, durability: 'none' })   // no disk, no log, best effort
// default durability: one group-commit fsync, nothing kept after delivery (history 0, rows false)
const sub = news.read({ partitions: ['sports'], from: 'latest' })
await news.set('sports', { headline: 'late winner' })                  // the subject is the partition
for await (const e of sub) { console.log(e.rec.value, sub.gaps); break }   // a live reader ends on break or close()
```

**Guarantee.** Every current subscriber gets every message, in order per subject. The default `persisted` costs one group-commit fsync and keeps nothing after delivery. `none` uses no disk and no log, and is best effort; its readers count restarts in `gaps`. **Layer:** L2, L3. The `none` rung comes after the first slice.

**Status: open.** On E-22's prototype, `none` lost 0 of 900 deliveries. Closer: the `none` rung built and its failover rule modelled (K-10), then `nats bench` and `nats latency` through E-45's NATS gateway.

### P-07 Streams and replay

```ts
// file: p07.ts — streams and replay
import { fero } from 'fero'

const events = await fero('events', { rows: false, history: '7d' })
const ack = await events.set('order:981', { type: 'paid', cents: 1200 })

const from = savedCursor ? fero.cursor(savedCursor) : 'earliest'           // saved text, checked back into a Cursor
const r = events.read({ from, until: 'latest' })                           // any kept position
for await (const e of r) {
  console.log(e.partition, e.version, e.rec.value)
  save(r.cursor)                                             // per-slot positions: a move never changes them
}
const one = events.read({ partitions: ['order:981'], from: ack.version })   // one partition, from a version
one.close()
```

**Guarantee.** Every committed record of the selected partitions, once, in order per partition. A position never changes meaning across failover, scaling or moves. Past `history`, the reader gets `expired` with the earliest kept cursor, and only from the slot's leader (A-06). **Layer:** L1, L3.

A cursor saved as text comes back through `fero.cursor(text)`, which checks its form. E-22 needed a cast there (D8).

**Status: met.** E-31 holds the log-reader property on ten bounds. E-22's stream check resumed from saved cursors.

### P-08 Consumer groups

```ts
// file: p08.ts — consumer groups
import { fero, group } from 'fero'

const orders = await fero('orders')
const invoices = await fero('invoices')

// exactly once: each output's entry carries the derived-once mark (A-05)
const invoicing = await group(orders, 'invoicing')
invoicing.run((e, out) => out.use(invoices).set(e.partition, { order: e.row, at: e.t }))

// at least once: commit when the batch is done
const billing = await group(orders, 'billing', { shares: 16 })   // one owner per share
for await (const batch of billing) {
  for (const e of batch.entries) await bill(e.row)
  await batch.commit()                                            // a paused (zombie) member is refused 'fenced'
}
```

**Guarantee.**
- Each share is owned by one live member at a time, and has its own token. A zombie's `commit()` is refused `fenced` (40 of 40 in E-22).
- A crash hands its shares on within one lease plus one commit.
- `commit()` gives at least once.
- `run()` gives exactly once, even after a restart longer than the dedup horizon. Each output's own entry carries the derived-once mark: per consumer, source slot and output slot, the highest source sequence applied. The mark moves with its output slot ([A-05](AMENDMENTS.md), [E-30]: 5 rules, 29 B a mark).
- A record's outputs to one slot go in one entry (G-13).
- **Layer:** L5, over L3's `read({ share })` and L2's fences.

**Status: open.** Nothing was skipped and no zombie committed ([E-22]; E-30 past the horizon). The hand-on time is not measured. Closer: the rebalance-time pin when L5 is built.

### P-09 Work queue

```ts
// file: p09.ts — work queue
import { queue } from 'fero'

const jobs = await queue<{ url: string }>('thumbs', { lease: '30s', deliveries: 5 })
await jobs.add({ url: 'a.png' })
jobs.work(async (job) => { await resize(job.url) })   // returns: ack; throws: nack; 5 deliveries: thumbs.dead
```

**Guarantee.**
- At most one live lease per message. None is lost while unacked.
- FIFO per partition. A queue has one partition, `main`, unless `add` names others (like SQS FIFO's message groups).
- After `deliveries`, the message moves to `thumbs.dead`. An empty take writes nothing.
- `extend` and `nack({ delay })` are a `touch` of the claim's lease, under the claim's token ([E-22] C2).
- A touch gives the row a new version, so it would make the old token stale ([E-22] C11). So `Msg` keeps each touch's `Ack.version` as its token, and a later `ack` uses it. An `ack` after an `extend` is then not refused `conflict`.
- **Layer:** L5, on L2's `claim`.

**Status: met.** E-22 killed one worker and paused one for 40 s: each job was removed once, dead-lettered after 5 deliveries, never under two live leases.

### P-10 Locks and leader election

```ts
// file: p10.ts — locks and leader election
import { fero, lock } from 'fero'

const ledger = await fero('ledger')                                     // persisted: a fence never sits on 'memory'
const l = await lock('payroll', { lease: '10s', wait: '5s' })            // else 'locked'
await ledger.set('run-42', { by: process.pid }, { if: { fence: l.fence } })   // an older token: 'fenced'
await l.release()

const leader = await lock('leader:billing', { wait: 'forever' })        // leader election
leader.lost.then(() => process.exit(1))                                 // lost the lease: stop acting
```

**Guarantee.**
- At most one holder per lease, by writer time. A lease can outlast a pause by one `election.ms` each time `#locks` elects ([E-22] F5).
- Tokens strictly rise across failovers, moves and restores, and compare with `<`.
- A write under a token older than one its partition's writer has accepted is refused `fenced`. Each group keeps a fence table and does not follow `#locks` (A-24). A stale write can still land before the new holder's first write there ([E-22] F5).
- Acquire ≤ C: it is one conditional write.
- **Layer:** L5, on L2's conditions.

**Status: open for COMP2, met for MIN-P+par.** E-22's fencing checks were clean in every seed. Its pattern check missed in 3 of 300 runs, each traced to the check's own expectations, not to a broken guarantee ([E-22] F5). In E-21 the fence refused every stale write under every clock rule. COMP2 is open only for the `memory` rung's lost tail (RR-12). Closer: RR-14's rule, then E-24's lock bounds run with a lost tail.

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

**Guarantee.** Each acknowledged `incr` counts exactly once across retries; `a.value` is the count it made. A bound (`op.incr(-1, { min: 0 })`) is never crossed: the write is refused `conflict` with `current`. A refused take writes nothing, because a first send's refusal is not appended (`forward.once`; VERDICT §8 item 10). Op cost at the writer ≤ 3 µs in TypeScript. **Layer:** L2; `limiter` is L5.

**Status: open.** Exactly once and the bounds held ([E-22], [E-20]). The op cost was never measured on a real L2. Closer: PERF-10's pin.

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
await live.ready                                             // the first picture (E-22 C8)
live.tap(() => render(live.snapshot()))
```

**Guarantee.**
- A view equals its query over the committed state after each commit, at ≤ 1 µs per affected view per change.
- Across groups, views merge exactly only with data's merge contract: ties by row key, an exactly rounded sum, one order on values ([A-10](AMENDMENTS.md), [E-23]). Without it, `filter` and `group` merge exactly; `sum` only with integers; `top-k` not in its ties.
- A whole-resource view on a process that holds only some partitions throws `holistic`. That is why the client opens the server's view. The stream carries data's order moves ([E-22] D12).
- **Layer:** L4, data's operators. Merged views come after the first slice.

**Status: open.** data's merge contract is not landed, and `group` costs 2,574 µs at 1e6 rows against 1 µs ([E-05]). Closer: the contract and per-row `group` deltas in data, then data's pins.

### P-13 Presence

```ts
// file: p13.ts — presence
import { fero } from 'fero'

const online = await fero('online', { rows: { while: 'session' } })   // every row dies with its writer's session
await online.set('ada', { since: fero.now() })
const here = await fero('here', { partition: { before: '/' } })
await here.set('room1/ada', { since: fero.now() }, { while: 'session' })   // one row bound to the session
```

**Guarantee.**
- When a session lapses, its rows go on every copy within `session.ms` plus one tick. A live session's rows are never removed.
- A session-bound write is sent only once its session's record has committed ([A-04](AMENDMENTS.md)). Before that fix, a dead process's row outlived its session for good in 19 of 100 seeds ([E-22] F2).
- A new writer of `#sessions` gives every lease one `election.ms` to be renewed ([E-22] D10).
- **Layer:** L2: each writer learns lapses from `#sessions`.

**Status: met.** A killed client's rows went within 9.8 s of a 10 s lease; a client paused 5 s kept its rows ([E-22]). Read to the letter, a `#sessions` failover near the lapse gave 12.4 s (VERDICT §8 item 20).

### P-14 Invariants

```ts
// file: p14.ts — invariants
import { fero, op } from 'fero'
type Item = { left: number; price: number }

const stock = await fero<Item>('stock', {
  methods: {
    sell: async (sku: string, ctx) => {
      const a = await ctx.set([sku, 'left'], op.incr(-1, { min: 0 }))   // the loser gets 'conflict', not 'threw'
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

**Guarantee.** Conditions and ops are judged at the one writer, against its log-end state, and a refusal waits for that state's commit (A-04). So they are linearizable per partition. Two sells of the last item through two servers: exactly one `ok`. A refusal says why and never commits later. **Layer:** L2.

**Status: met.** One `ok` in all 300 races under leader changes, slot moves and the shuffle ([E-22]). Porcupine and Knossos found every history linearizable ([E-22b]).

### P-15 Transactions across partitions

```ts
// file: p15.ts — transactions across partitions (a saga)
import { fero, op, saga } from 'fero'

const accounts = await fero('accounts')                    // persisted: a saga step never sits on 'memory'
await saga([
  { to: accounts, key: ['alice', 'cents'], value: op.incr(-5000, { min: 0 }) },   // undone by its inverse
  { to: accounts, key: ['bob', 'cents'], value: op.incr(5000) },
  { to: accounts, key: ['bob', 'log'], value: op.push('tx-981'), undo: op.push('undo:tx-981') },  // no inverse: say how
], { id: 'tx-981' })   // finishes or is undone, even if this process dies mid-way; readers may see a half

saga.sweep({ every: '10s' })                               // on a server: finish or undo units whose holder died
```

**Guarantee (MUST).** Every saga ends all applied or all undone, by its holder or a later one, even with paused holders ([A-24](AMENDMENTS.md), [E-24]):
- It takes its partitions' locks in key order. The locks belong to the unit until it ends, not to the holder's lease.
- It writes an intent row in `#sagas`. A saga that finds another's unfinished intent on its partitions finishes or undoes that one first.
- Each step carries its partition lock's fence.
- A failed run undoes every step, the failed one and those after it too. So whoever ends a unit has written every one of its partitions with its own token.
- A step whose op has no inverse needs its own `undo`, or the saga refuses `no-undo` before it starts ([E-22] F4).
- **Atomic visibility (SHOULD)** is not in 5.0: readers may see the steps one at a time.
- **Layer:** L5.

**Status: MUST open for COMP2, met for MIN-P+par; SHOULD not met.**
- E-24 holds the MUST on seven bounds, up to 2.9 million states, with 38 rules. Real Elle finds no write cycle in 300 histories ([E-22b]).
- COMP2 is open only for the `memory` rung's lost tail (RR-11, RR-14). Closer: RR-14's refusal, and E-24's model rerun with a lost tail.
- Elle finds readers seeing half a unit in 66 to 77 of 100 histories ([E-22]). That is the SHOULD.

### P-16 Event sourcing, CQRS

```ts
// file: p16.ts — event sourcing, CQRS
import { fero } from 'fero'
type Fact = { account: string; cents: number }

const facts = await fero<Fact>('facts', { rows: false, history: 'all' })   // every fact, forever
await facts.set('acct:alice', { account: 'alice', cents: 500 })
const balance = new Map<string, number>()
for await (const e of facts.read({ from: 'earliest', until: 'latest' }))   // rebuild from the start, then stop
  if (e.row) balance.set(e.row.account, (balance.get(e.row.account) ?? 0) + e.row.cents)
```

**Guarantee.** `history: 'all'` never drops a record. A rebuilt projection equals the live one byte for byte, because both fold the same records with data (DATA-01), and upcasters run on both paths (P-20). **Layer:** L2, L4.

**Status: open.** E-22's rebuild check passed. Byte for byte fails today for a `sum` (it depends on record order, [E-43]) and for `top-k` ties ([E-23]). Closer: data's merge contract (A-10), then the rebuild test.

### P-17 Derived resources

```ts
// file: p17.ts — derived resources
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }

const orders = await fero<Order>('orders')
const totals = await fero<number>('totals')
await derive(orders, totals, (e, out) => e.row && out.set(e.row.user, op.incr(e.row.cents)))   // once per order
```

**Guarantee.** Each record of `orders` affects `totals` exactly once, across crashes, restarts and moves, with the derived-once mark ([A-05](AMENDMENTS.md)). `op.incr` is not idempotent, so this is the hard case on purpose. **Layer:** L5: a consumer group whose outputs carry the mark.

**Status: met.** [E-30] model-checked the mark: no output twice past the dedup horizon or across an output slot move. Without caller-set ids, E-22's derive was wrong in 10 of 40 runs; with them, exact in 40 of 40 ([E-22] D3).

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

**Guarantee.** A fork costs one record per group, not a copy (TEST-06). It is one consistent cut per group, and per partition across groups. A world makes a run a function of its seed (TEST-02). A recorded input re-runs on the exact earlier state (TEST-07). A tape is one partition, so it replays in order. **Layer:** L1, L4; `tape` is L5.

**Status: open.** Tapes and reruns held on prototypes ([E-22], [E-06]). The fork was not built. Closer: the fork on the snapshot and segment store, with TEST-06's 1 KB pin.

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

**Guarantee.**
- The same API in Node, Bun, Deno, browsers and edge workers, over WebSocket on the project's one TLS address, with P-03's promises.
- The browser bundle, `data` included, is at most 60 KB gzip. A server marker in a browser is refused `no-server-here`.
- The door rides with the WebSocket upgrade: the proof, the follow and the first write leave in one flight. Node clients use the plain TLS transport ([E-40]).
- Other languages use the RESP gateway or the documented wire.
- **Layer:** L0's transport, L3, L4.

**Status: met.** [E-40]: the client with `data` is 27.9 KB gzip. A cold client reached its first committed write in 13 ms (a Web Worker) and 17 ms (a page). WebSocket fan-out was 0.89 to 0.95 times TCP's.

### P-20 Change the shape of rows

```ts
// file: p20.ts — change the shape of rows
import { fero, migrate, type Rec } from 'fero'

const shape = {
  version: 3,
  up: {
    1: (r: Rec) => r,                                 // v1 → v2: the same record
    2: (r: Rec) => r.key.length === 1                 // v2 → v3: name becomes { first, last }
      ? { ...r, value: { ...(r.value as any), name: { first: (r.value as any).name, last: '' } } }
      : r,
  },
}
await fero.alter('users', { shape, schema: UserV3 })  // the bump and the v3 code's hash: online; held rows are upcast once
const users = await fero('users', { shape, schema: UserV3 })   // matches the catalog now; schema checked at the writer
const job = await migrate(users, { to: 3, fn: (row: any) => row, perSec: 500 })   // rewrite live rows, paced
await job.done
```

**Guarantee.**
- The catalog records from which position each `shape.version` is in force.
- A record, snapshot row or tape input written under an older version passes the upcasters in order on every path (folds, follows, replays).
- At the bump, every held row is upcast too, so the live state equals a rebuild. That costs one pass over the held rows per process per bump ([E-22] C4).
- An open with a new `shape` on a resource that exists is refused `config-differs`, so a bump is a `fero.alter` step ([E-22] D8).
- A new code key, such as `schema`, is a roll too: the alter adds its hash first (section 6). E-22's prototype ignored code keys in `alter`, so its v3 code got in by opening with `schema` (D8).
- A tape that cannot be upcast is refused `schema-changed` (M). `schema` refuses at the writer with the path. `migrate` is a resumable, exactly-once, paced job (S).
- **Layer:** L4; `migrate` is L5.

**Status: open (M and S).** Upcasters held across three versions with the migrating server killed ([E-22]). Byte for byte waits on data's contract (A-10), and an old tape on new code was not run.

### P-21 Request and reply

```ts
// file: p21.ts — request and reply (two files)
import { service } from 'fero'

// ── worker.ts, on each answerer
const thumbs = await service<{ url: string }, { url: string }>('thumbs')   // persisted: an ask is three commits
thumbs.answer(async (req) => ({ url: await resize(req.url) }), { group: 'workers' })

// ── app.ts, an asker
const out = await thumbs.ask({ url: 'a.png' }, { timeout: '5s', group: 'workers' })   // one answer, 'timeout', or 'no-answerer'
console.log(out.url)
```

**Guarantee.**
- Requests spread over the live answerers of a group. Each request gets at most one answer, because the reply row is written `if: { absent: true }`.
- The asker names the same `group` as its answerers. Both default to `main`, so an ask without it would find no answerer in `workers` ([E-22]'s pattern passes it too).
- With no live answerer, `no-answerer` at once. "At once" reads this process's view of presence. So a just-dead answerer lingers for `session.ms`, and asks time out instead.
- The service is `persisted`. A `none` service cannot use `claim`, which needs rows ([E-22] D7).
- **Layer:** L5, on `claim`, sessions and conditions.

**Status: open.** 383 answers and 17 timeouts of 400 asks, never two answers ([E-22]). An ask is three commits: a median of 6.0 ms of virtual time, against 2.15 ms for one write. Closer: a `none`-rung service timed with `nats bench`, or the bar restated as three commits (Q-A17).

### P-22 Delayed jobs, waiting takes, priorities

```ts
// file: p22.ts — delayed jobs, waiting takes, priorities
import { queue } from 'fero'

const mail = await queue<{ to: string }>('mail')
await mail.add({ to: 'ada@x.io' }, { delay: '15m' })                      // from writer time (op.now)
await mail.add({ to: 'ops@x.io' }, { cron: '0 6 * * *', id: 'daily-report' })
await mail.add({ to: 'vip@x.io' }, { priority: 0 })
const [m] = await mail.take(1, { wait: '20s' })   // woken by an enqueue; writes nothing while waiting
if (m) { await sendMail(m.job.to); await m.ack() }
```

**Guarantee.**
- A delayed message becomes takeable within one tick of its time, by writer time, and never before. `delay` counts from the writer's time of the add, through `op.now` ([E-22] D5).
- A waiting take is woken within C + one hop of an enqueue, and writes nothing while it waits. A lapsed lease writes no record, so it wakes a waiter only at the library's next poll, once a second ([E-22] D6).
- Priorities hold within a partition (S).
- **Layer:** L5, on `claim` (whose `due` field the writer compares with writer time) and `follow`.

**Status: MUST open, SHOULD met.** No delayed message was taken early by writer time, and priority 0 came first in every seed ([E-22]). Closer: `op.now` in L2 (a phase-1 shape), then the waiting-take wake pin.

## 8. What the verdict fixed

Draft 1 kept one set of types for every candidate. The verdict picked COMP2, so the types now take COMP2's options. These are the choices that show on the surface ([VERDICT §5.1](VERDICT.md#51-its-full-line-in-plain-words)).

| Axis | COMP2's choice | How it shows on the surface |
|---|---|---|
| G `pslot`, P `slot` | groups owned by the project hold slots of many resources; 4,096 slots per resource ([A-16](AMENDMENTS.md)) | A resource is a catalog entry, not a cluster. An idle one costs about 85 B per touched slot ([E-36]). `cluster.groups` lists the project's groups that hold its slots. `share.of` is at most 4,096. One partition is one writer, so the app splits a hot partition (SC-03 restated) |
| Q `mix` | `persisted` by default; `none` per resource; `memory` per resource, only with the rung | `durability` is a resource key and never a write option. With the rung, a fence, a session-bound write or a saga step on a `memory` resource is refused `needs-persisted` (RR-14) |
| D `sess` | client sessions with `forward.once`, the derived-once mark, and caller keys | One session per process. fero retries alone, and a resend gets the first answer. `id` on a write and `key` on a call are caller keys. `group.run` and `derive` stay exactly once after a restart of any length ([E-20], [E-30], [E-32]) |
| O `slot` | a sequence per slot, compared as (epoch, sequence) | Versions and cursors keep their meaning across failovers and slot moves. Cursors are per slot. A version has a number form for gateways. A restore takes new epochs, so an older cursor is refused `unknown-log` |
| T `clamp`, with A-23 | writer time is the median of the members' clocks | `ctx.now()`, ttls, leases and delays use it. One wrong clock, the leader's included, changes nothing and causes no failover. When most clocks disagree, the group stops writing (health `skew`) ([E-21]) |
| X `saga` | sagas with fenced locks and an intent row (A-24) | `saga()` is the unit across partitions. It ends all applied or all undone, and readers may see half. No `atomic` option ([E-24]) |
| W `any ridx` | reads from any ready replica at your floor, or by read index | `get` and `follow` answer from a nearby ready replica. `fresh: true` asks the writer. A replica that lacks your next record says `end`, and the client moves on by itself (A-06) |
| U `any` | methods run where the caller reached | A check-then-set must carry a condition or be an op. There is no `at: 'writer'` ([E-22] C5, D15) |
| H `emb`, M `kw` | fero runs inside the app's Node process, with the kernel on a worker thread | `fero()` in your process is the server; there is no separate binary. Every function key runs in your process. A 5 s busy handler did not stop the kernel's heartbeat, so it caused no false failover ([E-07]). But E-07's worker also took writes without the main thread. With writes judged on the main thread ([LAYERS.md](LAYERS.md) section 10, item 1), the same stall holds new writes to the groups this server leads. F-14 asks that writes keep going, so phase 1 re-runs E-07's stall that way |
| F `all`, with RR-17's design rule | every full replica folds the rows with `data` | `f.snapshot` and views are data's on every server. A full replica keeps a full `data` copy beside the worker's index. With values in both, that is the rows twice; plan memory for it ([E-34], [E-05]) |
| S `jrnl +tier(store)`, with A-08 | one journal per process, an object-store tier, the restore mark in the store | A server keeps a disk by default. Across boxes `object` is required: genesis creates the cluster id there. A slot move waits while the store is down (health `store-down`); writes go on |
| Y `fwd` | any server takes a write and forwards it | Clients dial any address. A server that cannot forward refuses at once with a redirect ([A-02](AMENDMENTS.md)), and the client moves |
| R `raft`, I `port`, V `+lrn` | Raft groups on etcd's raft ported to TypeScript; voters plus learners | Failover takes about one election (`election.ms` 2 s in TS). `copies` sets the voters; `standbys` adds learners ([E-10], [E-13]) |
| C `cent-co` | one loop on `#meta`'s leader heals replicas and moves slots | Healing and moves wait while `#meta` has no leader (health `meta-down`). Platform hints are inputs to the loop ([E-16]) |
| Z `par` | a damaged entry is copied back from a peer | A replica with a bad entry keeps its id but neither votes nor stands until repaired (health `repairing`). Readers there get `end` and move on, a rule in the record but not modelled ([E-37]; VERDICT §5.1) |
| L `ts→rs` | TypeScript first; a Rust core only for rows TypeScript does not win | No type changes at the native step: `data` keeps folding in JavaScript (RR-17). Defaults change (section 6) |
| N `proc` | one process per project on the hosted platform | Awake all month, it costs $2.34 against DEP-21's $2.19 free bar ([E-41]; VERDICT §5.3) |

- K `lib` shows only as a promise: every verb is built on the kernel's five operations, and no pattern needed a sixth ([E-22]).
- COMP2's twins have the same surface. "COMP2 V=full" (every replica votes) and COMP2 in TypeScript for good (L `ts`) change no type ([VERDICT §5.1](VERDICT.md#51-its-full-line-in-plain-words)).
- Two leads could still change the surface: D `keys` and X `rampv` ([VERDICT §4.7](VERDICT.md#47-the-options-no-judged-row-holds)). See Q-A10 and Q-A24.

## 9. Open API questions

Each question is settled from the evidence, or kept open with what decides it.

**Settled.**
- **Q-A1. Who creates a resource?** Any process, when every key it passes is declarative. Code keys and the seed need a server. A queue worker or a gateway can then make its own resource ([E-22] D2, [E-45] F2).
- **Q-A2. A changed resource key on open.** Refused `config-differs`. Changes go through `fero.alter`; a `shape` bump is one ([E-22] D8). The one-box dev shortcut stays as draft 1 proposed: no experiment bore on it.
- **Q-A3. A disk by default.** Yes. `persisted` is COMP2's default rung. `dir: false` is memory only, and health says `memory-only`. SC-01's ready time stays a phase-1 pin.
- **Q-A4. The project's name.** As proposed: the nearest `package.json`'s `name`, else its folder's name. No experiment bore on it.
- **Q-A5. `get` against `read`.** `get` for one row, `read` for the log, as E-22 built them. `read` can also start from a version ([E-45] F1b).
- **Q-A6. Partition rules.** Declarative only (`{ before }`). E-22 and E-45's gateways needed nothing else.
- **Q-A7. A public `slots` key.** No. The count is fixed at 4,096 (A-16). It falls back to 1,024 only if phase 1's cursor bar fails (VERDICT §9 kill table).
- **Q-A8. Where methods run.** Where the caller reached (U `any`). `at: 'writer'` is dropped: it is not the safety ([E-22] C5, D15).
- **Q-A9. A rung per write, and the `memory` rung.** Never a rung per write: groups are cut by rung (AMENDMENTS 4, note 13; RR-14). `memory` comes per resource, only if it passes its kill test.
- **Q-A11. How long a caller key lasts.** 1 day, for calls and writes alike. A key costs about 221 B for that day ([E-20]).
- **Q-A12. A bare client holds the whole resource.** Yes, as v4. At 80% of the node's `memory`, health warns and names the fix, `cache: { memory }` (SC-09).
- **Q-A13. A `publish` verb.** No. `set` on a `rows: false` resource is publishing; E-45's NATS gateway mapped PUB to it.
- **Q-A14. Offsets in answers.** Never for apps. A version has a number form for gateways ([E-45] F1, A-10).
- **Q-A15. One error class.** Yes, as E-22 built it. A `FeroError` that escapes a handler keeps its code ([E-22] C3).
- **Q-A16. `ctx.peer`.** Stays a string; claims and session sit beside it.
- **Q-A18. Where the libraries live.** Named exports of `'fero'`, one file each, built only from the verbs. E-22 built nine this way, and E-45's gateways are L5 too.
- **Q-A19. Durations.** `'30s'` or milliseconds in the call. Config keys keep v4's `.ms` numbers.
- **Q-A20. Functions at the writer.** Kept. COMP2 runs JavaScript on every server (H `emb`), and RR-17 keeps it so after the native step. Draft 1's caveat for a Rust server is gone.
- **Q-A21. Consumer-group shares.** `read({ share: { index, of } })`, with `of` at most 4,096. A group cuts its source into `shares` (default 16). Each share has its own token, so `generation` is gone ([E-22] D16).
- **Q-A22. Typed rows.** TypeScript's `Row` parameter, plus an optional Standard Schema checked at the writer, as E-22 built it.

**Still open.**
- **Q-A10. Atomic visibility for sagas.** Not in 5.0.
  - E-24: RAMP-Fast keeps reads atomic for plain sets with 1 novel rule. On ops it leaves fractured reads (10 in 36,000 reads), since a version carries earlier units' effects.
  - `rampv` fixes that, for at least 2 more novel rules and no fixed bound on rounds ([E-24]).
  - It is VERDICT's second lead (§4.7). **Decides:** step 3's RAMP model with the vector, then a judging pass of its 12 cells. `saga(steps, { atomic: true })` and `read({ atomic: true })` stay reserved.
- **Q-A17. Request and reply latency.** A `none` service cannot claim, so an ask is three persisted commits ([E-22] D7). **Decides:** the user restates P-21 as three commits, or a later phase builds a `none`-rung service with no claims and times it with `nats bench` (VERDICT §5.4).
- **Q-A23 (new). What RR-14's "session-bound writes" covers.**
  - This page reads it as `while: 'session'` writes, in A-04's words.
  - For plain writes' floors and refusals on a `memory` group, it adds RR-13's recovery rule: a new session generation after an unclean stop.
  - **Decides:** step 2b's model: E-20's and E-24's bounds with a lost tail, without and with the rule. It matters only with the rung.
- **Q-A24 (new). Dedup by sessions or by keys.** D `keys` (one key table for fero's own retries) could save 8 to 10 pairs (VERDICT §4.7, first lead). The surface barely moves: `id` and `key` stay, and presence sessions stay. **Decides:** step 3's crossing run with `keys` in place of sessions, and its byte pin against DEP-13.
- **Q-A25 (new). Changing `durability` or `copies` online.** Groups are cut by them (note 13). Proposed: `fero.alter` moves the resource's slots to groups of the new class, one at a time (A-18). **Decides:** phase 1's model of `pslot`'s placement rules (K-04, K-05; VERDICT §5.4, DEV-03).
- **Q-A26 (new). A reader that ends.** `until: 'latest'` is proposed here from [E-22] C10; nothing tested it. **Decides:** phase 1's review of L3's interfaces (DEV-09).
- **Q-A27 (new). The user's readings behind some guarantees.** The agreement guard (VERDICT §8 item 12: stop, in force). Expiry and presence by writer time (item 20). P-05's restated bar (item 6). F-15's slot-move wait (item 11). The types stay the same under either answer; section 7 says which reading each guarantee uses.
- **Q-A28 (new). Rows bound to a named lease** (`while: { lease: id }`, [E-45] F9, a SHOULD). Not in 5.0: `while: 'session'` stays the one form. **Decides:** whether PERF-07's keep-alive row must match etcd's, which renews on its leader with no log write.

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
declare const savedCursor: string | undefined      // text from the app's own storage
declare function save(c: string): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string }; email: string }>
```

```ts
// file: types.ts — what must and must not type-check
import { fero, op, saga, group, service, type Version } from 'fero'

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
const m = await fero('m', { durability: 'memory' })     // compiles; refused 'config' until the rung is built
// @ts-expect-error a rung is per resource, never per write (AMENDMENTS 4, note 13; RR-14)
await f.set('k', { n: 1 }, { durability: 'memory' })
// @ts-expect-error copies: 2 is cut (decision 23a)
await fero('x', { copies: 2 })
// @ts-expect-error a history is a number of records, a time or a size
await fero('x', { history: '7 days' })
// @ts-expect-error no per-write confirm (decision 23a)
await f.set('k', { n: 1 }, { confirm: 'sent' })
// @ts-expect-error a partition rule is declarative
await fero('x', { partition: (k: string) => k })
// @ts-expect-error incr takes a number
op.incr('1')
// @ts-expect-error versions are opaque, never plain strings
await f.set('k', { n: 1 }, { if: { version: '9001' } })
const v = (await f.get('k', { version: true }))?.version
if (v) await f.set('k', { n: 2 }, { if: { version: v satisfies Version } })
f.data.k = op.incr(1)                      // an op value by assignment
f.data.k = { n: 3 }                        // a row by assignment
await f.set('k', { n: 4 }, { id: 'order-77' })          // a caller key (A-10)
await f.set('t', { n: 5 }, { ttl: '1m' })
await f.set(['t', 'at'], op.now('15m'))                 // writer time, plus 15 minutes
await m.set('blob', new Uint8Array([1, 2, 3]))          // bytes are values (E-45 F3)
if (v) await f.touch('k', { lease: '30s', if: { version: v } })   // a claim's lease, under its token (E-22 C2)
// @ts-expect-error a lease is a duration
await f.touch('k', { lease: true })
const num: bigint = v ? fero.version.toNumber(v) : 0n   // the number form, for gateways (E-45 F1)
// @ts-expect-error the number form is a bigint
fero.version.fromNumber(7)
const r = f.read({ partitions: ['k'], from: fero.version.fromNumber(num) })   // a read from a version
r.close()
const text: string = r.cursor                           // a cursor saves as text
// @ts-expect-error saved text is not a Cursor until fero.cursor() checks it (E-22 D8)
f.read({ from: text })
f.read({ from: fero.cursor(text) }).close()
// @ts-expect-error a saga step names its resource
await saga([{ key: 'a', value: 1 }])
await saga([{ to: f, key: 'a', value: op.push(1), undo: op.push('undo') }])   // an op with no inverse says how
// @ts-expect-error a group has no generation: each share has its own token (E-22 D16)
console.log((await group(f, 'g')).generation)
// @ts-expect-error a service is persisted: a claim needs rows (E-22 D7)
await service('s', { durability: 'none' })
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

**Result, run here on 2026-11-11** (Node v22.22.0, TypeScript 6.0.2 at `/opt/node22/bin/tsc`, data at 63fea66): `ok: 26 blocks type-check (tsc Version 6.0.2)`.
- `types.ts` has 16 `@ts-expect-error` lines. An earlier text said 16 when there were 15; the 16th is the saved-text cursor, added with `fero.cursor`.
- With all 16 stripped, tsc reports 16 errors, each for the reason its comment gives. For example, a rung in `WriteOpts` is "not a known property", `fromNumber(7)` is "not assignable to bigint", and saved text in `read({ from })` is "not assignable to ... Cursor".
- A planted error (`op.incr("x")` in P-14) makes the same command exit 1.
- Not checked here: that any of this runs. E-22 ran draft 1's surface; the parts marked **(new)** are not built.

[API-NOTES]: experiments/E22-api-prototype/API-NOTES.md
[cards]: judging/closure/hybrids/cards.json
[E-05]: experiments/E05-fold-cost/README.md
[E-06]: experiments/E06-fork-rewind/README.md
[E-07]: experiments/E07-gc-worker/README.md
[E-08]: experiments/E08-relay-fanout/README.md
[E-10]: experiments/E10-raft-port/README.md
[E-13]: experiments/E13-handover/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-18]: experiments/E18-slot-balance/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-22b]: experiments/E22b-real-elle/README.md
[E-23]: experiments/E23-merged-views/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-32]: experiments/E32-composition/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-34]: experiments/E34-wake-10gb/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-40]: experiments/E40-browser-client/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-43]: experiments/E43-fold-versions/README.md
[E-45]: experiments/E45-drivers/README.md
