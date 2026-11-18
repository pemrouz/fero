// file: fero.d.ts — fero v5's public API for the chosen design (V5-1 to V5-11). Declarations only.
import type { Ops, View, ChangeRecordV2, ReadonlyData } from 'data'
/** One change record: data's own, and the wire's. A tap gets one; an Entry carries one. */
export type Rec = Exclude<ChangeRecordV2, { type: 'move' }>

// ── words ────────────────────────────────────────────────────────────────
export type Key = string
/** A row key, then the fields below it: ['widgets', 'stock']. */
export type Path = readonly [Key, ...(string | number)[]]
export type Partition = string
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
export type Size = `${number}${'B' | 'KB' | 'MB' | 'GB' | 'TB'}`
/** A row's place in its partition's log. Opaque. Two versions of one partition compare with `<`. */
export type Version = string & { readonly __fero: 'version' }
/** A reader's place across many partitions. Opaque text: save it, pass it back as `from`. */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
export type Time = number

// ── fero(name, opts) ─────────────────────────────────────────────────────
/** Open a resource. The row type comes from a `data` seed, from `fero<Row>(name, opts)`, or from
 *  `fero.of<Row>()(name, opts)`. TypeScript cannot take one type argument and work out the other,
 *  so `fero<Row>(name, { methods })` does not compile: it would leave the methods untyped.
 *  With methods, let the seed give the row type, or use `fero.of<Row>()`. */
export declare function fero<R extends Resource<any, any> = Resource<any, Methods<any>>>(
  name: string,
  opts?: ProcessOptions & OpenOptions,
): Promise<R>   // `fero<typeof shop>(name)`: a client typed by a server's exported handle
export declare function fero<Row, M extends Methods<Row>>(
  name: string,
  opts?: Options<Row, M>,
): Promise<Resource<Row, M>>   // both worked out from the options, or both given: `fero<Row, typeof methods>`
export declare function fero<Row>(
  name: string,
  opts?: Omit<Options<Row, Methods<Row>>, 'methods'> & { methods?: never },
): Promise<Resource<Row, Methods<Row>>>   // the row type alone: no `methods` here; a client's calls are untyped
export type Options<Row = any, M extends Methods<any> = Methods<any>> =
  ProcessOptions & ResourceOptions<Row, M> & OpenOptions

/** Remembered by this process only. A restart changes them. */
export interface ProcessOptions {
  project?: string
  uuid?: string
  listen?: string | false       // false: a solo node with no socket, for tests
  advertise?: string
  rendezvous?: string | readonly string[] | false   // where the directory is asked (V4-3, V5-3)
  hosts?: readonly string[]     // this resource's members by hand, when the directory is off
  dir?: string | false          // one per process: every resource it serves shares one journal
  object?: string | false       // the store where a resource's id is created once
  secret?: string | false
  token?: string
  admin?: string
  memory?: Size
  ping?: { ms?: number }
  evict?: { after?: number }
  settle?: { ms?: number }
  handback?: { max?: number }   // leader hand-backs in flight; default 8 (V5-10)
  bulk?: { rate?: Size }        // bytes a second for catch-up and other bulk work (V5-9)
  redial?: { ms?: number; tries?: number }
  leave?: { ms?: number }
  journal?: { cap?: number }
  diag?: { allow?: Record<string, string> }
  connect?: { wait?: Duration }
  shuffle?: boolean | number
}

/** Remembered by the resource's own log (V5-2). The founding open writes them; fero.alter changes them. */
export interface ResourceOptions<Row = any, M extends Methods<any> = Methods<any>> {
  /** The unit of order. Default: each row. `{ before: '/' }`: the key's text before the first '/'.
   *  A function of the row key: code, the same on every process that routes by it. Fixed at founding. */
  partition?: { before: string } | ((key: Key) => Partition)
  history?: History
  rows?: boolean | RowsRule<Row>
  copies?: 1 | 3 | 5            // the copies whose disks decide a commit
  standbys?: number             // more full copies that do not vote
  election?: { ms?: number; jitter?: number }
  // the seed and code: a server only
  data?: Record<Key, Row>
  methods?: M
  validation?: (rec: Rec) => true | string
  schema?: Schema<Row>
  rules?: {
    write?: (who: Who, rec: Rec, current: Row | undefined) => true | string
    read?: (who: Who, partition: Partition) => boolean
  }
  load?: (key: Key, ctx: { now(): Time }) => Row | undefined | Promise<Row | undefined>
  shape?: { version: number; up?: Record<number, Upcaster> }
}
export type History = 0 | 'all' | number | `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}${'KB' | 'MB' | 'GB' | 'TB'}`
export interface RowsRule<Row> { ttl?: Duration; max?: number; where?: (row: Row) => boolean; while?: 'session' }
export type Upcaster = (rec: Rec) => Rec | readonly Rec[] | null
export interface Schema<Row> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): { value: Row; issues?: undefined } | { issues: readonly { message: string; path?: readonly PropertyKey[] }[] }
  }
}

/** Remembered by nobody: how this open behaves. */
export interface OpenOptions {
  /** true: serve this resource from this process. false: stay a client. Default: by declared act. */
  server?: boolean
  /** 'all' (default): every row, kept live; the open sends the whole resource once.
   *  'asked': only what this open gets or follows. A size: the same, inside that bound. */
  hold?: 'all' | 'asked' | Size
  signals?: boolean
  bind?: 'live' | 'sim' | `tape:${string}` | `./${string}`
}

// ── the resource ─────────────────────────────────────────────────────────
export interface Resource<Row = any, M extends Methods<any> = Methods<any>> extends Verbs<Row> {
  readonly name: string
  /** Change and watch: assignment writes, and data's operators as live views. */
  readonly data: LiveData<Row>
  /** Read: `f.rows.k` is one lookup and hands out the frozen row. Listing it walks the rows.
   *  A row not held here throws 'not-held'; so does listing on a process that holds only part.
   *  Never a trip, never a copy (PA-8). */
  readonly rows: Rows<Row>
  /** v4's whole picture, with v4's meaning: a new frozen container of every row on each access.
   *  O(rows). The same as `data.snapshot()`. To read a row, use `rows`. */
  readonly snapshot: Rows<Row>
  /** Your functions on the resource's servers, and nothing else. */
  readonly methods: Callers<M>
  /** This resource's own members, groups, health and writes in flight. */
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
/** A lookup can miss: a key that names no row reads `undefined`. */
export type Rows<Row> = Readonly<Record<Key, Row | undefined>>

export interface Verbs<Row = any> {
  // reads: anything awaited may make one trip
  get(key: Key, opts: GetOpts & { version: true }): Promise<{ value: Row; version: Version } | undefined>
  get(key: Key, opts?: GetOpts): Promise<Row | undefined>
  get(key: Path, opts?: GetOpts): Promise<unknown>
  // writes: every one commits on disk at a majority (V5-5). A plain whole-row write returns a
  // Write, which also reports its earlier stages. A write the leader can refuse on state, or that
  // answers a value, returns a Judged: it answers at its commit only (V5-11 ruling 6). A write
  // with a `once` name is one of those: the name may be taken ('call-diverged', 'too-many-keys').
  /** Read, decide, write: `fn` gets the row, returns the next one (undefined: write nothing).
   *  Written `if` unchanged since the read; on a conflict it reads again and calls `fn` again. */
  set(key: Key, fn: (row: Row | undefined) => Row | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(key: Key, value: Op, opts?: WriteOpts): Judged
  set(key: Key, value: Row, opts: JudgedOpts): Judged
  set(key: Key, value: Row, opts?: PlainOpts): Write
  set(key: Path, value: unknown, opts?: WriteOpts): Judged
  remove(key: Key, opts: JudgedOpts): Judged
  remove(key: Key, opts?: PlainOpts): Write
  remove(key: Path, opts?: WriteOpts): Judged
  /** Several changes to ONE partition: one log entry, all or none. Not needed for speed. */
  batch(writes: readonly BatchWrite<Row>[], opts?: { once?: string; timeout?: Duration }): Judged<Ack[]>
  /** Keep the value; reset its ttl or lease. */
  touch(key: Key, opts?: TouchOpts): Judged
  // staying up to date
  /** Rows: these partitions as they are now, then each change. */
  follow(of: Selector): Follow<Row>
  /** Records: every committed change, in order, from a position (default: from now on). */
  changes(opts?: ChangesOpts): Changes<Row>
  /** For libraries: the leader leases the first takeable rows of a partition to the caller. */
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
}

export interface GetOpts {
  fresh?: boolean      // ask the leader: one trip plus its round with a majority; no disk
  hold?: false         // a miss is read once and not kept: one trip, one row's bytes, no follow
  version?: boolean
  timeout?: Duration
}
export interface WriteOpts {
  if?: Cond
  ttl?: Duration
  while?: 'session'
  /** A name you pick: a resend under the same name within a day gets the first answer.
   *  A named write is judged (the name may be taken), so it answers at its commit only. */
  once?: string
  timeout?: Duration
}
export type PlainOpts = Omit<WriteOpts, 'if' | 'once'> & { if?: undefined; once?: undefined }
export type JudgedOpts = WriteOpts & ({ if: Cond } | { once: string })
export interface TouchOpts { ttl?: Duration; lease?: Duration; if?: Cond; once?: string; timeout?: Duration }
export interface Cond {
  absent?: true
  present?: true
  version?: Version
  equals?: unknown
  lock?: LockRef       // refused 'fenced' if this partition's leader has seen a newer holder
  expired?: true
}

export interface Op { readonly __op: 'incr' | 'push' | 'merge' | 'max' | 'min' | 'now' }
export declare const op: {
  incr(n: number, bounds?: { min?: number; max?: number }): Op
  push(...items: unknown[]): Op
  merge(fields: Record<string, unknown>): Op
  max(x: number | string): Op
  min(x: number | string): Op
  now(plus?: Duration): Op
}

/** The committed answer. */
export interface Ack { key: Path; version: Version; attempt: AttemptId; value?: any }
/** A progress report: how far the write got. No version, no value (V5-11). */
export interface Early { key: Path; attempt: AttemptId; stage: 'received' | 'replicated' }
/** A write's handle. Awaiting it answers at the commit. A promise is made only when it is awaited. */
export interface Judged<A = Ack> extends PromiseLike<A> {
  catch(fn: (e: FeroError) => unknown): Promise<unknown>
}
/** A write that cannot be refused on state: it also reports its earlier stages.
 *  A stage the write never reached rejects with the write's own error (a refusal before the
 *  leader appended it, a timeout). Once a stage has resolved, the handle never ends in a refusal. */
export interface Write extends Judged {
  readonly received: Promise<Early>     // the leader appended it
  readonly replicated: Promise<Early>   // a majority handed it to their operating systems
}
export type BatchWrite<Row = any> =
  | { key: Key; value?: Row | Op; remove?: true; if?: Cond; ttl?: Duration }     // a whole row: checked against Row
  | { key: Path; value?: unknown; remove?: true; if?: Cond; ttl?: Duration }    // a field: not checked
export interface ClaimOpts<Row> { partition: Partition; n?: number; lease: Duration; due?: keyof Row & string }
export interface Claimed<Row> { key: Key; value: Row; token: Version; until: Time; deliveries: number }

// ── staying up to date ───────────────────────────────────────────────────
export interface LiveData<Row> extends Omit<Ops<Record<Key, Row>>, 'patch'> {
  /** A row's or a field's handle: `f.data.k`, `f.data.k.stock`. Untyped: it is data's own proxy.
   *  Its `update(v)` and `remove()` are writes, and return what `f.set` and `f.remove` return. */
  [key: string]: any
  /** A whole frozen picture: a new container of every held row. O(rows). */
  snapshot(): Rows<Row>
  /** v4's lens calls. Each is the resource's verb under another name: the same handle comes back. */
  set(key: Key, value: Op): Judged
  set(key: Key, value: Row): Write
  /** One `set` per pair. The handle answers when every one has committed. Not all-or-none. */
  patch(pairs: readonly (readonly [Key, Row])[]): Judged<Ack[]>
}
/** Which partitions: one, a list, every one whose name starts with a prefix, or one share of all. */
export type Selector = Partition | readonly Partition[] | { prefix: string } | { share: Share }
export interface Share { index: number; of: number }
export interface Follow<Row> extends LiveData<Row> {
  readonly ready: Promise<void>
  readonly rows: Rows<Row>
  readonly cursor: Cursor
  close(): void
}
export interface ChangesOpts {
  of?: Selector
  /** 'latest' (default): from now on. "Now" is fixed when `changes()` is called, not when the loop
   *  starts: every write this process makes after the call is seen. 'earliest': everything kept.
   *  Or a saved cursor, or a version. */
  from?: 'earliest' | 'latest' | (string & {})
  until?: 'latest'
  credit?: Size
}
export interface Changes<Row> extends AsyncIterable<Entry<Row>> {
  readonly cursor: Cursor
  close(): void
}
export interface Entry<Row> {
  rec: Rec                  // the record itself, shared with every other reader: never copied
  value?: Row               // rec.value, typed, when the record wrote a whole row. Undefined for a
                            // field write or a remove. Never looked up: it is not "the row now"
  partition: Partition
  version: Version
  time: Time                // the leader's time when it was written (writer time)
  source: string            // the resource it came from
  reason?: 'ttl' | 'max' | 'where' | 'session' | 'erased'
}

// ── methods ──────────────────────────────────────────────────────────────
export type Handler<Row = any> = (arg: any, ctx: Ctx<Row>) => unknown
/** A function, or a function with a hint: `near: true` says the argument is the row key this call
 *  is about, `near: 'sku'` says `arg.sku` is. The call then goes to that row's leader. Speed only. */
export type Method<Row = any> = Handler<Row> | { near: true | string; run: Handler<Row> }
export type Methods<Row = any> = Record<string, Method<Row>>
export interface Ctx<Row = any> extends Verbs<Row> {
  readonly data: LiveData<Row>
  readonly rows: Rows<Row>          // this server's rows: one lookup
  readonly peer: string
  readonly claims: Claims | null
  readonly session: string
  readonly once?: string
  now(): Time
  id(): string
  flush(): Promise<void>
  use<R2>(other: Resource<R2, any>): Verbs<R2>
}
type RunOf<H> = H extends { run: infer F } ? F : H
export type Callers<M> = {
  [K in keyof M]: RunOf<M[K]> extends (arg: infer A, ctx: any) => infer R
    ? (...args: undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) => CallOf<R>
    : never
}
type CallOf<R> = unknown extends R ? LiveCall<any> : Awaited<R> extends View<infer T> ? LiveCall<T> : Call<Awaited<R>>
export interface CallOpts {
  /** At most once, from any process: a claim in `#calls`. Three commits in a row. */
  once?: string
  /** v4's: send the call again if its server is lost. No claim, no extra commit. The handler may
   *  run twice, so only for a handler that is safe to run twice. */
  retry?: boolean
  ttl?: Duration
  timeout?: Duration
}
export interface Call<R> extends PromiseLike<R> {}
export interface LiveCall<T> extends Call<T> {
  open(): ReadonlyData<T> & { readonly ready: Promise<void> }
  close(): void
}

export interface Claims { sub: string; follow?: readonly string[]; call?: readonly string[]; write?: readonly string[]; exp?: Time; [claim: string]: unknown }
export interface Who { peer: string; claims: Claims | null; session: string }

// ── cluster and health ───────────────────────────────────────────────────
export interface ClusterView {
  snapshot(): ClusterShape
  tap(fn: () => void): () => void
  readonly writes: WritesView
}
export interface ClusterShape {
  id: string                  // the resource's id, made when it was founded
  writable: boolean
  me: { id: string; role: 'server' | 'client' | 'solo'; listen: string | false; caughtUp: boolean; lag: number; links: string[] }
  members: Record<string, { listen: string; state: 'live' | 'draining' | 'retiring' | 'gone'; up: boolean }>
  groups: Record<string, { voters: string[]; learners: string[]; leader: string | null; lag: number; slots: number }>
  health: HealthRow[]
}
export interface HealthRow { kind: string; severity: 'info' | 'warn' | 'down'; since: Time; message: string; fix: string }
export interface WritesView {
  snapshot(): WriteRow[]
  tap(fn: () => void): () => void
  lookup(id: AttemptId): Promise<WriteRow>
}
export interface WriteRow {
  id: AttemptId
  key: Path
  state: 'pending' | 'committed' | 'refused' | 'unknown'
  stage?: 'received' | 'replicated'   // how far a pending write got
  version?: Version
  code?: Code
}

// ── errors ───────────────────────────────────────────────────────────────
export declare class FeroError extends Error {
  readonly code: Code
  /** Did it commit? 'refused': no, and it never will. 'unknown': it may have. */
  readonly outcome: 'refused' | 'unknown'
  readonly resource: string
  readonly key?: Path
  readonly attempt?: AttemptId
  readonly retryAfter?: number
  readonly current?: Version
  readonly earliest?: Cursor
  readonly path?: readonly PropertyKey[]
  readonly reason?: string
  readonly cause?: Code
  /** One line: the call to make next. */
  readonly hint: string
}
export type Code =
  | 'conflict' | 'fenced' | 'absent-row' | 'absent-path' | 'sparse-hole' | 'invalid-key' | 'unencodable'
  | 'too-large' | 'cross-partition' | 'no-rows' | 'schema' | 'invalid' | 'rule' | 'rule-threw' | 'rule-timeout'
  | 'methods-only' | 'forbidden' | 'call-diverged' | 'read-only' | 'disk-full' | 'backpressure' | 'too-many-keys'
  | 'not-held' | 'expired' | 'bad-cursor' | 'schema-changed'
  | 'no-method' | 'threw' | 'busy'
  | 'timeout' | 'unknown' | 'destroyed' | 'restored'
  | 'locked' | 'limited' | 'no-answerer' | 'no-undo'
  | 'config' | 'config-differs' | 'admin-only' | 'dir-held' | 'wrong-project' | 'wrong-cluster'
  | 'no-server-here' | 'unbound'
  | 'no-leader' | 'moved' | 'retry' | 'end' | 'gap' | 'stale-attempt' | 'empty'

// ── fero's statics ───────────────────────────────────────────────────────
export declare namespace fero {
  function id(): string
  function now(): Time
  /** Open with the row type given and the methods' type worked out: `fero.of<Item>()('shop', { methods })`. */
  function of<Row>(): <M extends Methods<Row>>(name: string, opts?: Options<Row, M>) => Promise<Resource<Row, M>>
  /** An admin act: it needs the admin key. The partition rule and the seed cannot be altered. */
  function alter(name: string, change: Partial<Omit<ResourceOptions<any, any>, 'partition' | 'data'>> | { gate: string | null }): Promise<void>
  function drop(name: string): Promise<void>
  function erase(name: string, partition: Partition): Promise<void>
  function fork(name: string, opts: { as: string; at?: Cursor | string }): Promise<void>
  function token(claims: Claims, opts?: { ttl?: Duration }): string
  function revoke(sub: string): Promise<void>
  function clientKey(secret: string): string
  function spawn(file: string, args?: string[], opts?: { stdin?: 'pipe' | 'ignore' }): Spawned
  function world(opts?: { seed?: number; start?: Time; shuffle?: boolean }): World
  namespace version {
    function toNumber(v: Version): bigint
    function fromNumber(n: bigint): Version
  }
}
export interface Spawned { pid: number; out: string; exited: Promise<number | null>; stop(): Promise<number | null>; write(line: string): void; child: unknown }
export interface World { readonly seed: number; now(): Time; id(): string; advance(by: Duration): Promise<void>; close(): Promise<void> }

// ── libraries: each built only from the verbs above ──────────────────────
/** What a library's resource takes from the open: the role, and where this process is. */
export type LibOpts = Pick<OpenOptions, 'server'> & ProcessOptions
export interface Runner { readonly lag: number; stop(): Promise<void> }

export declare function queue<Job = unknown>(name: string, opts?: LibOpts & { lease?: Duration; deliveries?: number; history?: History }): Promise<Queue<Job>>
export interface Queue<Job> {
  readonly name: string
  /** `key`: the message's own row key, written only if absent. A `cron` schedule needs one: it is
   *  what keeps a second start-up from adding the schedule again. */
  add(job: Job, opts?: { partition?: Partition; key?: string; once?: string; delay?: Duration; at?: Time; cron?: string; priority?: number }): Promise<{ id: string }>
  take(n?: number, opts?: { partitions?: readonly Partition[]; wait?: Duration; lease?: Duration }): Promise<Msg<Job>[]>
  work(fn: (job: Job, msg: Msg<Job>) => unknown, opts?: { concurrency?: number; partitions?: readonly Partition[] }): Runner
}
export interface Msg<Job> {
  readonly id: string
  readonly job: Job
  readonly deliveries: number
  readonly until: Time
  ack(): Promise<void>
  nack(opts?: { delay?: Duration }): Promise<void>
  extend(lease?: Duration): Promise<void>
}

/** A lock's name and token: what `if: { lock }` carries. Tokens rise; they compare with `<`. */
export interface LockRef { readonly name: string; readonly token: Version }
export interface Lock extends LockRef {
  readonly lost: Promise<void>
  renew(): Promise<void>
  release(): Promise<void>
}
export interface LockOpts { lease?: Duration; wait?: Duration | 'forever'; renew?: boolean }
/** Run `fn` under the lock; it is released when `fn` returns or throws. */
export declare function lock<T>(name: string, fn: (l: Lock) => T | Promise<T>): Promise<T>
export declare function lock<T>(name: string, opts: LockOpts, fn: (l: Lock) => T | Promise<T>): Promise<T>
/** Hold the lock until `release()`: for a leader that holds it for its whole life. */
export declare function lock(name: string, opts?: LockOpts): Promise<Lock>

/** Staged writes: they return nothing and commit together with the source mark. */
export interface Out<Row = any> extends OutTo {
  set(key: Key, value: Row | Op, opts?: { ttl?: Duration }): void     // a whole row: checked against Row
  set(key: Path, value: unknown, opts?: { ttl?: Duration }): void     // a field: not checked
  remove(key: Key | Path): void
}
export interface OutTo { use<R2>(target: Resource<R2, any>): Out<R2> }

export declare function consumer<Row>(source: Resource<Row, any>, name: string, opts?: { from?: 'earliest' | 'latest'; lease?: Duration; max?: number; shares?: number }): Promise<Consumer<Row>>
export interface Consumer<Row> extends AsyncIterable<ConsumerBatch<Row>> {
  readonly member: string
  readonly owned: number
  run(fn: (e: Entry<Row>, out: OutTo) => unknown): Runner
  leave(): Promise<void>
}
export interface ConsumerBatch<Row> { readonly entries: Entry<Row>[]; commit(): Promise<void> }

export declare function derive<A, B>(
  source: Resource<A, any>, target: Resource<B, any>,
  fn: (e: Entry<A>, out: Out<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>
export declare function derive<B>(
  sources: readonly Resource<any, any>[], target: Resource<B, any>,
  fn: (e: Entry<any>, out: Out<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>

export declare function saga(steps: readonly Step[], opts?: { once?: string; lease?: Duration }): Promise<Ack[]>
export declare namespace saga { function sweep(opts?: { every?: Duration }): Runner }
export interface Step {
  to: Resource<any, any>
  key: Key | Path
  value?: unknown           // not checked against `to`'s row type: steps name different resources
  remove?: true
  if?: Cond
  undo?: Op | { value: unknown } | { remove: true }
}

export declare function limiter(name: string, opts: LibOpts & { max: number; per: Duration }): Promise<{ take(key: string, n?: number): Promise<{ left: number; reset: Time }> }>
export declare function service<Req = unknown, Res = unknown>(name: string, opts?: LibOpts): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string; concurrency?: number }): Runner
  ask(req: Req, opts?: { timeout?: Duration; group?: string }): Promise<Res>
}
export declare function migrate<A, B>(res: Resource<A, any>, opts: { to: number; fn: (row: A) => B; perSec?: number }): Promise<{ readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }>
export declare function tape<In = unknown, Out = unknown>(name: string, opts?: LibOpts & { window?: Duration }): Promise<{
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
}>
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string }): Promise<{ close(): Promise<void> }>
