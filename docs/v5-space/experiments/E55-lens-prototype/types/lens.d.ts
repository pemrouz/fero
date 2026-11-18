// file: lens.d.ts — LENS.md's shape as declarations: a sketch on API.md's own declarations ('fero-base' is API.md
// section 6's fero.d.ts, extracted by run.sh exactly as API.md's checker extracts it). Patterns import 'fero'.
import type {
  Op, Ack, Write, Judged, Version, Cursor, Duration, Size, Cond, Time, Partition, History, RowsRule,
  ProcessOptions, ClusterView, CallOpts, Claims, Rec, Step as BaseStep,
} from 'fero-base'
export { op, lock, queue, service, tape, migrate, gateway } from 'fero-base'
export type { Op, Ack, Write, Judged, Version, Cursor, Duration, Size, Cond, Time, Partition, Early, Schema } from 'fero-base'

// ── where a lens points: the root, a partition (depth 2), a row, below a row ──
export type Kind = 'root' | 'part' | 'row' | 'field'
type Down<K extends Kind, D extends 1 | 2> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
/** 'server': this process serves the resource; 'client': it opened one. V4-5: a typed client of a resource
 *  with methods has no writes on its lens. */
export type Role = 'server' | 'client'
type HasMethods<M> = keyof M extends never ? false : true

/** A lens: an address. A property read is a step (a key); a call is a verb on the path before it. A lens is
 *  not a promise (review F3): `await lens` gives the lens back, and `lens.get()` reads once. */
export type Lens<T, M = {}, K extends Kind = 'root', D extends 1 | 2 = 1, R extends Role = 'server'> =
  Flow<T, M, K, D> & Writes<T, M, K, R> & PathCalls<M, K, D> & Operators<RowOf<T, K, D>, M> & Steps<T, M, K, D, R>
type Steps<T, M, K extends Kind, D extends 1 | 2, R extends Role> =
  0 extends 1 & T ? { readonly [key: string]: Lens<any, M, Down<K, D>, D, R> }
  : T extends readonly (infer E)[] ? { readonly [i: number]: Lens<E, M, Down<K, D>, D, R> }
  : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], M, Down<K, D>, D, R> }
  : {}
/** The row type under a lens (what one change of it carries). */
export type RowOf<T, K extends Kind, D extends 1 | 2> =
  0 extends 1 & T ? any : K extends 'row' | 'field' ? T : K extends 'part' ? T[keyof T] : D extends 2 ? T[keyof T][keyof T[keyof T]] : T[keyof T]

// ── writes ──
export interface WriteOpts { if?: Cond; ttl?: Duration; while?: 'session'; once?: string; timeout?: Duration }
type PlainOpts = Omit<WriteOpts, 'if' | 'once'> & { if?: undefined; once?: undefined; from?: undefined }
type JudgedOpts = WriteOpts & ({ if: Cond } | { once: string })
/** A marked write (`{ from: e }`): the write and "source record e is applied" in one log entry. Commit only. */
type MarkOpts = Omit<WriteOpts, 'once'> & { from: Entry<any> }
/** Only a plain whole-row write reports early stages. */
type SetOf<K extends Kind> = K extends 'row' ? Write : Judged
interface WriteVerbs<T, K extends Kind> {
  set(value: Op, opts?: WriteOpts | MarkOpts): Judged
  set(fn: (now: T | undefined) => T | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(value: T, opts: JudgedOpts | MarkOpts): Judged
  set(value: T, opts?: PlainOpts): SetOf<K>
  remove(opts: JudgedOpts): Judged
  remove(opts?: PlainOpts): SetOf<K>
  touch(opts?: { ttl?: Duration; lease?: Duration; if?: Cond }): Judged
}
type Writes<T, M, K extends Kind, R extends Role> =
  K extends 'root' | 'part' ? {} : R extends 'server' ? WriteVerbs<T, K> : HasMethods<M> extends true ? {} : WriteVerbs<T, K>

// ── flow: here, connect, tap, changes, asOf ──
export interface Change<Row> { readonly type: 'add' | 'update' | 'remove'; readonly key: string; readonly row: Row | undefined; readonly prev: Row | undefined }
/** One argument per commit, by reference. `changes` and `now` are made only when read. */
export interface Commit<T, Row = any> {
  readonly first: boolean
  readonly changes: readonly Change<Row>[]
  readonly now: Now<T, Row>
  recs(): readonly Rec[]
  text(): string
}
export interface Now<T, Row> { readonly rows: Readonly<Record<string, Row>>; readonly value: T | undefined }
export interface Link { readonly ready: Promise<void>; close(): void }
export interface Sendable { send(text: string): void }
export interface Flow<T, M, K extends Kind, D extends 1 | 2> {
  /** Read once: here if held on purpose, else one trip. Keeps nothing. */
  get(): Promise<T | undefined>
  /** Hold it here, live. Counted and shared with every equal lens in this process. */
  here(): Held<T, RowOf<T, K, D>, M>
  /** The picture so far, then each commit, into `target`; fero holds `target` weakly and passes it in. */
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T, RowOf<T, K, D>>) => void): Link
  connect<X extends object>(target: X, prop: keyof X & string): Link
  /** A strong sink: until close() or its scope. */
  tap(fn: (c: Commit<T, RowOf<T, K, D>>) => void): Link
  /** Every committed record under this lens, in order. */
  changes(opts?: ChangesOpts): Changes<RowOf<T, K, D>>
  /** This lens as it was. Read-only; folded here. */
  asOf(pos: Version | Cursor | Time): Promise<Past<T, RowOf<T, K, D>>>
  /** A step by a key held in a variable (or a key named `then`). */
  at(...keys: readonly (string | number)[]): Lens<any, M, 'row', D, 'server'>
  /** A method by name: the way out of a clash with a verb. */
  call<N extends keyof M & string>(name: N, ...args: ArgsOf<M[N]>): CallOf<ReturnOf<M[N]>>
}
export interface ChangesOpts { from?: 'earliest' | 'latest' | (string & {}) | PromiseLike<Cursor>; until?: 'latest'; credit?: Size; as?: string }
export interface Entry<Row> { readonly value?: Row; readonly key: readonly (string | number)[]; readonly type: 'add' | 'update' | 'remove'; readonly partition: Partition; readonly version: Version; readonly time: Time; readonly cursor: Cursor }
export interface Changes<Row> extends AsyncIterable<Entry<Row>> { readonly cursor: Cursor; close(): void }

/** What here() gives: read through it. Operators right of here() run here, functions included. */
export interface Held<T, Row, M = {}> extends Link, LocalOps<Row> {
  readonly rows: Readonly<Record<string, Row>>
  readonly value: T | undefined
  tap(fn: (c: Commit<T, Row>) => void): Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T, Row>) => void): Link
  connect<X extends object>(target: X, prop: keyof X & string): Link
}
export interface View<Row> extends Link, LocalOps<Row> {
  readonly rows: Readonly<Record<string, Row>>
  tap(fn: (c: Commit<Record<string, Row>, Row>) => void): Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<Record<string, Row>, Row>) => void): Link
  connect<X extends object>(target: X, prop: keyof X & string): Link
}
interface PlainOps<Row, Out> {
  gt(field: keyof Row & string, v: number | string): Out
  lt(field: keyof Row & string, v: number | string): Out
  gte(field: keyof Row & string, v: number | string): Out
  lte(field: keyof Row & string, v: number | string): Out
  between(field: keyof Row & string, range: readonly [number, number]): Out
  az(field: keyof Row & string, n?: number): Out
  za(field: keyof Row & string, n?: number): Out
  top(n: number): Out
  limit(n: number): Out
  reverse(): Out
}
/** Left of here(): plain data only. A function here does not compile. */
export interface Operators<Row, M = {}> extends PlainOps<Row, Sel<Row, M>> {}
export interface Sel<Row, M = {}> extends Operators<Row, M> {
  here(): View<Row>
  connect<X extends object>(target: X, apply: (target: X, c: Commit<Record<string, Row>, Row>) => void): Link
}
export interface LocalOps<Row> extends PlainOps<Row, View<Row>> {
  filter(fn: (row: Row, key: string) => boolean): View<Row>
  map<U>(fn: (row: Row, key: string) => U): View<U>
}
export interface Past<T, Row> extends LocalOps<Row> {
  readonly rows: Readonly<Record<string, Row>>
  readonly value: T | undefined
  step(n: number): Past<T, Row>
  seek(pos: Version | Cursor | Time): Past<T, Row>
  close(): void
}

// ── methods: declared on the server, called on a path ──
export interface Ctx<T, D extends 1 | 2> {
  /** The lens the call was made on (a row of this resource). */
  readonly at: Lens<RowOf<T, 'root', D>, {}, 'row', D, 'server'>
  readonly data: Lens<T, {}, 'root', D, 'server'>
  readonly peer: string
  readonly claims: Claims | null
  set(path: readonly (string | number)[], value: unknown): Judged
  now(): Time
  id(): string
}
export type Handler<T = any, D extends 1 | 2 = 1> = (arg: any, ctx: Ctx<T, D>) => unknown
/** Where a method may be called (review F8). A bare function: the root only, `f.methods.x(arg)`. On a path the
 *  author says which: `{ at: 'row' | 'partition' | 'any', run }`. The server refuses any other path (`bad-path`). */
export type Where = 'root' | 'partition' | 'row' | 'any'
export type MethodDef<T = any, D extends 1 | 2 = 1> = Handler<T, D> | { readonly at: Where; readonly run: Handler<T, D> }
export type Methods<T = any, D extends 1 | 2 = 1> = Record<string, MethodDef<T, D>>
type RunOf<H> = H extends { run: infer F } ? F : H
type WhereOf<H> = H extends { at: infer W } ? W : 'root'
type ArgsOf<H> = RunOf<H> extends (arg: infer A, ctx: any) => any ? (undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) : never
type ReturnOf<H> = RunOf<H> extends (...a: any[]) => infer R ? R : never
type CallableAt<W, K extends Kind, D extends 1 | 2> =
  W extends 'any' ? true : W extends 'row' ? (K extends 'row' ? true : false) : W extends 'partition' ? (D extends 2 ? (K extends 'part' ? true : false) : (K extends 'row' ? true : false)) : false
export interface Served<Row> extends PromiseLike<Row> { here(): View<Row> }
type CallOf<R> = Awaited<R> extends Sel<infer Row, any> ? Served<Row> : PromiseLike<Awaited<R>>
/** A lens has the methods declared for its kind of path; on a path a call runs at that path's leader. */
export type PathCalls<M, K extends Kind = 'row', D extends 1 | 2 = 1> = { [N in keyof M as CallableAt<WhereOf<M[N]>, K, D> extends true ? N : never]: (...args: ArgsOf<M[N]>) => CallOf<ReturnOf<M[N]>> }

// ── the resource ──
export interface Resource<T = Record<string, any>, M = {}, D extends 1 | 2 = 1, R extends Role = 'server'> {
  readonly name: string
  /** The root lens: the address of everything. */
  readonly data: Lens<T, M, 'root', D, R>
  /** The fast sync read of what is held on purpose (a server, or hold: 'all'). */
  readonly rows: Readonly<T>
  /** The array form of a path write. No Proxy. */
  set: R extends 'client' ? (HasMethods<M> extends true ? never : (path: readonly (string | number)[], value: unknown, opts?: WriteOpts | MarkOpts) => Judged) : (path: readonly (string | number)[], value: unknown, opts?: WriteOpts | MarkOpts) => Judged
  /** The same address as f.data.a.b, with no Proxy. */
  at(...keys: readonly (string | number)[]): Lens<any, M, 'row', D, R>
  /** Calls with no path: any server. */
  readonly methods: { [N in keyof M as WhereOf<M[N]> extends 'root' | 'any' ? N : never]: (...args: ArgsOf<M[N]>) => CallOf<ReturnOf<M[N]>> }
  /** This resource's marks for a reader name, as a cursor for changes({ from }). */
  marks(name: string): PromiseLike<Cursor>
  /** A bare mark: source record e is applied, nothing written. */
  mark(e: Entry<any>): Judged
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
export interface ResourceOptions<T, M, D extends 1 | 2> {
  /** 1 (default): f.data.k is a row and its own partition. 2: f.data.p.k is a row; p its partition. */
  depth?: D
  data?: T
  methods?: M
  history?: History
  rows?: RowsRule<any>
  copies?: 1 | 3 | 5
  server?: boolean
  hold?: 'all' | Size
}
type Tree<Row, D extends 1 | 2> = D extends 2 ? Record<string, Record<string, Row>> : Record<string, Row>
/** A client typed by the server's exported type: `fero<Shop>('shop')`. */
export declare function fero<S extends Resource<any, any, any, any>>(name: string, opts?: ProcessOptions & { hold?: 'all' | Size }): Promise<S extends Resource<infer T, infer M, infer D, any> ? Resource<T, M, D, 'client'> : never>
/** A server with a seed and methods: the tree's type comes from the seed. */
export declare function fero<T extends object, const M extends Methods<T, D>, D extends 1 | 2 = 1>(name: string, opts: ProcessOptions & ResourceOptions<T, M, D> & { data: T; methods: M }): Promise<Resource<T, M, D, 'server'>>
/** Typed by its row type. */
export declare function fero<Row = any, D extends 1 | 2 = 1>(name: string, opts?: ProcessOptions & ResourceOptions<Tree<Row, D>, {}, D>): Promise<Resource<Tree<Row, D>, {}, D, 'server'>>
export declare namespace fero {
  function id(): string
  function now(): Time
  function fork(name: string, opts: { as: string }): Promise<void>
}
export declare function scope(fn?: () => void): { dispose(): void }

// ── libraries over the public calls ──
export declare function derive<A, B>(source: Resource<A, any, any, any>, target: Resource<B, any, any, any>, fn: (e: Entry<A[keyof A]>) => void): Promise<{ stop(): Promise<void> }>
export interface Run<Row> { run(fn: (e: Entry<Row>) => unknown): Promise<void> }
export declare function consumer<Row>(source: Resource<Record<string, Row>, any, any, any>, name: string, opts?: { from?: 'earliest' | 'latest' }): Promise<AsyncIterable<{ readonly entries: Entry<Row>[]; commit(): Promise<void> }>>
export declare function group<Row>(source: Resource<Record<string, Row>, any, any, any>, name: string): Promise<Run<Row>>
/** A saga step takes one lens. */
export interface Step { at: WriteVerbs<any, any>; value: unknown; undo?: unknown }
export declare function saga(steps: readonly Step[], opts?: { once?: string }): Promise<Ack[]>
