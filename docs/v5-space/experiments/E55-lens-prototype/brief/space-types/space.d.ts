// file: space.d.ts — the lens this proposal adds on top of API.md's declarations. Declarations only.
import type { Judged, Op, Entry, Cursor, Key, Cond, Duration, ChangesOpts, Resource } from 'fero'

/** What a tap or a connect callback gets: one commit's changes to this view, by reference. Nothing is copied. */
export interface Change<T> {
  readonly first: boolean                    // true once: the picture so far
  readonly rows: Iterable<Delta<T>>          // what changed in this commit (first: every row, as adds)
  readonly now: T                            // the latest value: the view itself, a lookup, not a copy
  readonly seq: number
}
export type Delta<T> =
  | { type: 'add'; key: Key; row: T[keyof T] }
  | { type: 'remove'; key: Key; prev: T[keyof T] }
  | { type: 'update'; key: Key; row: T[keyof T]; prev: T[keyof T]; path: readonly (string | number)[] }

/** Ends a connect. Also ends with its scope, or when its anchor is collected. */
export interface Link extends Disposable { close(): void }

/** A live answer held in this process. Everything on it runs here. */
export interface Here<T> extends Disposable {
  readonly ready: Promise<void>
  readonly rows: Readonly<T>
  readonly cursor: Cursor
  filter(fn: (row: T[keyof T], key: Key) => boolean): Here<T>
  map<U>(fn: (row: T[keyof T], key: Key) => U): Here<Record<Key, U>>
  gt(field: string, x: number | string): Here<T>
  lt(field: string, x: number | string): Here<T>
  top(n: number, field: string): Here<T>
  last(n: number): Here<T>
  sum(field: string): Here<number>
  tap(fn: (c: Change<T>) => void): Here<T>
  connect<A extends object>(anchor: A, fn: (anchor: A, c: Change<T>) => void): Link
  close(): void
}

/** A place in the resource, and plain-data operators on it. Nothing runs until await, here(), connect() or a write. */
export interface There<T> extends PromiseLike<T | undefined> {
  /** Keep the answer here and up to date. 0 trips if this process already holds what it reads; else one SUB. */
  here(opts?: { linger?: Duration }): Here<T>
  /** here() plus a callback whose life is the anchor's. */
  connect<A extends object>(anchor: A, fn: (anchor: A, c: Change<T>) => void): Link
  /** The log of this path, from a position. */
  changes(opts?: Omit<ChangesOpts, 'of'>): AsyncIterable<Entry<T[keyof T]>> & { readonly cursor: Cursor; close(): void }
  // writes: the same handle f.set returns. `from`: the source mark (section 9)
  set(value: T | Op, opts?: { if?: Cond; once?: string; from?: Entry<any> }): Judged
  remove(opts?: { if?: Cond; once?: string; from?: Entry<any> }): Judged
  // operators that are plain data: they may run on a server. No closures here.
  gt(field: string, x: number | string): There<T>
  lt(field: string, x: number | string): There<T>
  top(n: number, field: string): There<T>
  last(n: number): There<T>
  sum(field: string): There<number>
}
export type Lens<T> = There<T> & (T extends object ? { readonly [K in keyof T]-?: Lens<T[K]> } : unknown)

/** A method called on a path: the path picks the leader. */
export type At<M> = { [K in keyof M]: M[K] extends (arg: infer A, ctx: any) => infer R ? (arg: A, opts?: { once?: string }) => PromiseLike<Awaited<R>> & { here(): Here<any> } : never }

/** The resource with the lens as `data`. `keys: 2`: the first key is the partition, the second the row. */
export interface Lensed<T, M = {}> { readonly name: string; readonly data: Lens<T> & At<M>; marks(reader: string): Cursor | 'earliest' }
export declare function lens<T, M = {}>(r: Resource<any, any>): Lensed<T, M>
