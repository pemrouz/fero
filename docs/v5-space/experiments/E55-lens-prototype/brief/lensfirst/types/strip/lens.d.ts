// file: lens.d.ts — the lens-first surface as declarations (a sketch; it reuses API.md's own types from 'fero')
import type {
  Op, Write, Judged, Ack, Version, Cursor, Duration, Size, Cond, Time, Partition,
  ProcessOptions, History, RowsRule, ClusterView, CallOpts, LockRef, Claims,
} from 'fero'

// ── where a lens points ──────────────────────────────────────────────────
/** root: the resource. part: a partition of a `depth: 2` resource. row: a row. field: below a row. */
export type Kind = 'root' | 'part' | 'row' | 'field'
type Down<K extends Kind, D extends 1 | 2> =
  K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'

/** A lens: an address (a resource and a path) with verbs in the call space.
 *  A property read is a step and does no work. A call is a verb on the path before it. */
export type Lens<T, M = {}, K extends Kind = 'root', D extends 1 | 2 = 1> =
  Verbs<T, K> & Flow<T, M, K, D> & PathCalls<M> & Steps<T, M, K, D>
type Steps<T, M, K extends Kind, D extends 1 | 2> =
  0 extends 1 & T ? { readonly [key: string]: Lens<any, M, any, D> }      // an untyped tree: any path
  : T extends readonly (infer E)[] ? { readonly [i: number]: Lens<E, M, Down<K, D>, D> }
  : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], M, Down<K, D>, D> }
  : {}

// ── reads and writes ─────────────────────────────────────────────────────
export interface WriteOpts { if?: Cond; ttl?: Duration; while?: 'session'; once?: string; timeout?: Duration }
type PlainOpts = Omit<WriteOpts, 'if' | 'once'> & { if?: undefined; once?: undefined }
type JudgedOpts = WriteOpts & ({ if: Cond } | { once: string })
/** A plain whole-row write reports early stages (a Write). Everything else answers at its commit. */
type SetOf<K extends Kind> = K extends 'row' ? Write : Judged

export interface Verbs<T, K extends Kind> extends PromiseLike<T | undefined> {
  /** Here if held; else one trip to a copy. It keeps nothing. `fresh`: at the leader. */
  get(opts: { version: true; fresh?: boolean }): Promise<{ value: T; version: Version } | undefined>
  get(opts?: { fresh?: boolean; timeout?: Duration }): Promise<T | undefined>
  /** Here only: one lookup, the frozen value by reference. Throws 'not-held'. Never a trip. */
  peek(): T | undefined
  set(value: Op, opts?: WriteOpts): Judged
  set(fn: (now: T | undefined) => T | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(value: T, opts: JudgedOpts): Judged
  set(value: T, opts?: PlainOpts): SetOf<K>
  remove(opts: JudgedOpts): Judged
  remove(opts?: PlainOpts): SetOf<K>
  touch(opts?: { ttl?: Duration; lease?: Duration; if?: Cond }): Judged
  /** A step by a key held in a variable, or a key that is a verb's name. */
  at(key: string | number): Lens<any, any, any, any>
}

// ── flow: connect, here, tap, changes, as-of ─────────────────────────────
/** What a sink gets, once per commit. Both members are lazy: reading neither costs nothing. */
export interface Commit<T> {
  /** True for the first call: `changes` is then the picture so far, as adds. */
  readonly first: boolean
  /** The value at this lens after the commit: by reference, frozen. Never a copy. */
  readonly value: T | undefined
  /** The commit's changes under this lens, by reference. `prev` is the value before, free here. */
  readonly changes: Iterable<Change>
}
export interface Change { type: 'add' | 'update' | 'remove'; key: readonly (string | number)[]; value?: unknown; prev?: unknown }
export interface Link {
  /** Resolves when the first picture has been handed to the target. */
  readonly ready: Promise<void>
  readonly cursor: Cursor
  /** Ends it now. It also ends when the target is collected, or its scope is disposed. */
  close(): void
}
export interface ConnectOpts { life?: 'target' | 'scope' | 'manual'; credit?: Size }
/** A target fero knows how to feed without a function. */
export interface Sendable { send(text: string): void }

export interface Flow<T, M, K extends Kind, D extends 1 | 2> extends Operators<T, M> {
  /** Pipe the picture so far, then each commit, into `target`. fero holds `target` weakly. */
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X, opts?: ConnectOpts): Link
  connect(target: Sendable, opts?: ConnectOpts): Link
  /** A resource as the target: every record, each output marked with its source position. */
  connect<T2, M2, D2 extends 1 | 2>(target: Lens<T2, M2, 'root', D2>, apply: (out: Out<T2, D2>, e: LogEntry<Leaf<T, K, D>>) => void, opts?: { as?: string; from?: 'earliest' | 'latest' }): Link
  /** A strong sink: it lives until `close()` or its scope ends. */
  tap(fn: (c: Commit<T>) => void): Link
  /** The boundary. What is left of it runs where the rows live; what is right of it runs here. */
  here(): Held<T, M, K, D>
  /** Every committed record under this lens, in order, from a position. */
  changes(opts?: { from?: 'earliest' | 'latest' | (string & {}); until?: 'latest'; credit?: Size; as?: string }): Log<Leaf<T, K, D>>
  /** This lens as it was at a version, a cursor or a writer time. Read-only. */
  asOf(pos: Version | Cursor | Time): Past<T>
}
/** The row type under a lens, for log entries. */
type Leaf<T, K extends Kind, D extends 1 | 2> =
  K extends 'row' | 'field' ? T : K extends 'part' ? T[keyof T] : D extends 2 ? T[keyof T][keyof T[keyof T]] : T[keyof T]
export type Held<T, M, K extends Kind, D extends 1 | 2> = Lens<T, M, K, D> & Link
export interface Past<T> extends PromiseLike<T | undefined> { peek(): T | undefined; get(): Promise<T | undefined>; step(n: number): Past<T> }

export interface LogEntry<Row> { value?: Row; prev?: Row; key: readonly (string | number)[]; type: 'add' | 'update' | 'remove'; partition: Partition; version: Version; time: Time; source: string }
export interface Log<Row> extends AsyncIterable<LogEntry<Row>> {
  readonly cursor: Cursor
  close(): void
  connect<X extends object>(target: X, apply: (target: X, e: LogEntry<Row>) => void): Link
  connect<T2, M2, D2 extends 1 | 2>(target: Lens<T2, M2, 'root', D2>, apply: (out: Out<T2, D2>, e: LogEntry<Row>) => void, opts?: { from?: 'earliest' | 'latest' }): Link
}
/** A derive's output side: the target's lens, where a write returns nothing and carries the mark. */
export type Out<T, D extends 1 | 2> = OutNode<T, 'root', D>
type OutNode<T, K extends Kind, D extends 1 | 2> =
  { set(value: T | Op): void; remove(): void; at(key: string): OutNode<any, any, D> }
  & (T extends object ? { readonly [P in keyof T]-?: OutNode<T[P], Down<K, D>, D> } : {})

// ── operators: data's, as lens steps in the call space ───────────────────
/** Plain-data operators can run on a server (left of `here()`). */
export interface Operators<T, M> {
  gt(field: string, v: number | string): ViewLens<T, M>
  lt(field: string, v: number | string): ViewLens<T, M>
  between(field: string, lo: number | string, hi: number | string): ViewLens<T, M>
  az(field: string, n?: number): ViewLens<T, M>
  za(field: string, n?: number): ViewLens<T, M>
  top(n: number): ViewLens<T, M>
  pick(keys: readonly string[]): ViewLens<T, M>
  prefix(text: string): ViewLens<T, M>
  sum(field: string): ViewLens<number, M>
  length(): ViewLens<number, M>
  /** Functions run where the function is: here. Left of `here()` on rows not held: 'not-held'. */
  filter(fn: (row: T[keyof T], key: string) => boolean): ViewLens<T, M>
  map<U>(fn: (row: T[keyof T], key: string) => U): ViewLens<Record<string, U>, M>
  group(fn: (row: T[keyof T]) => string): ViewLens<Record<string, T>, M>
}
export interface ViewLens<T, M = {}> extends Operators<T, M>, PromiseLike<T | undefined> {
  get(): Promise<T | undefined>
  peek(): T | undefined
  here(): ViewLens<T, M> & Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X, opts?: ConnectOpts): Link
  connect(target: Sendable, opts?: ConnectOpts): Link
  tap(fn: (c: Commit<T>) => void): Link
}

// ── methods: declared on the server, called on a path ────────────────────
/** A handler gets its argument and a ctx. `ctx.at` is the lens the call was made on. */
export interface Ctx<T, D extends 1 | 2> {
  readonly at: Lens<any, {}, any, D>
  readonly data: Lens<T, {}, 'root', D>
  readonly peer: string
  readonly claims: Claims | null
  now(): Time
  id(): string
}
export type Handler<T = any, D extends 1 | 2 = 1> = (arg: any, ctx: Ctx<T, D>) => unknown
export type Methods<T = any, D extends 1 | 2 = 1> = Record<string, Handler<T, D>>
type CallOf<R> = Awaited<R> extends ViewLens<infer V, any> ? ViewLens<V> : PromiseLike<Awaited<R>>
/** Every lens has the resource's methods. A call on a path runs at that path's leader. */
export type PathCalls<M> = {
  [N in keyof M]: M[N] extends (arg: infer A, ctx: any) => infer R
    ? (...args: undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) => CallOf<R>
    : never
}

// ── the resource ─────────────────────────────────────────────────────────
export interface Resource<T, M = {}, D extends 1 | 2 = 1> {
  readonly name: string
  /** The root lens. */
  readonly data: Lens<T, M, 'root', D>
  /** The fast sync read: `f.rows.k` is one lookup, as in API.md. */
  readonly rows: Readonly<T>
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
export interface ResourceOptions<T, M, D extends 1 | 2> {
  /** 1 (default): `f.data.k` is a row and its own partition. 2: `f.data.p.k` is a row; `p` is its partition. */
  depth?: D
  data?: T
  methods?: M & Methods<T, D>
  history?: History
  rows?: boolean | RowsRule<any>
  copies?: 1 | 3 | 5
  server?: boolean
  hold?: 'all' | 'asked' | Size
  load?: (key: string) => unknown
}
/** A server: the tree type comes from the seed or the type argument, the methods are worked out. */
export declare function fero<T = Record<string, any>, const M extends Methods<T, D> = {}, D extends 1 | 2 = 1>(
  name: string, opts?: ProcessOptions & ResourceOptions<T, M, D>,
): Promise<Resource<T, M, D>>
/** A client typed by the server's exported type: `fero.as<Shop>('shop')`. */
export declare namespace fero {
  function as<R extends Resource<any, any, any>>(name: string, opts?: ProcessOptions & { hold?: 'all' | 'asked' | Size; token?: string; hosts?: readonly string[] }): Promise<R>
  function id(): string
  function now(): Time
}

// ── libraries that take an address now take a lens ───────────────────────
export declare function saga(steps: readonly { at: Verbs<any, any>; value: unknown; undo?: unknown }[], opts?: { once?: string }): Promise<Ack[]>
export type { LockRef }
