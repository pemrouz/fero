// A sketch of the cost-first lens, to see that it types. Declarations only.
import type { Write, Judged, Op, Resource, Methods, Callers, Cursor } from 'fero'
/** One commit's changes, by reference. Never cloned. */
export interface Delta<Row> { readonly op: 'add' | 'update' | 'remove'; readonly key: string; readonly row?: Row; readonly prev?: Row; readonly path?: readonly (string | number)[] }
export interface Changes<Row> { readonly first: boolean; readonly rows: readonly Delta<Row>[] }
/** What connect() gives: the rows it holds, live. Operators here run in this process. */
export interface Live<T> {
  readonly ready: Promise<void>
  readonly value: T | undefined            // by reference, frozen
  readonly cursor: Cursor
  tap(fn: (changes: Changes<T extends Record<string, infer R> ? R : T>, now: Live<T>) => void): this
  filter(fn: (row: T extends Record<string, infer R> ? R : never, key: string) => boolean): Live<T>
  close(): void
  [Symbol.dispose](): void
}
export interface Sub { readonly ready: Promise<void>; close(): void; [Symbol.dispose](): void }
/** An address: a path into a resource. Building one sends nothing. */
export interface Lens<T, M> {
  at<K extends keyof T & string>(k: K): Dot<T[K], M>
  set(value: T): Write
  set(value: Op): Judged
  remove(): Judged
  connect(): Live<T>
  connect<A extends object>(target: A, prop: keyof A): Sub
  connect<A extends object>(target: A, fn: (target: A, changes: Changes<T extends Record<string, infer R> ? R : T>, now: Live<T>) => void): Sub
  /** The resource's methods, sent to this path's leader. */
  readonly methods: Callers<M>
}
type Verb = keyof Lens<any, any>
/** Dot sugar: `lens.k` is `lens.at('k')`, except for a key that is spelled like a verb. */
export type Dot<T, M> = Lens<T, M> & (T extends object ? { readonly [K in keyof T as K extends Verb ? never : K]: Dot<T[K], M> } : {})
export declare function lens<Row, M extends Methods<any>>(r: Resource<Row, M>): Dot<Record<string, Row>, M>
