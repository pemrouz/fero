// file: fero.d.ts — a sketch of the owner's one `connect` (E-56 probes, item 5). Docs only; nothing here is fero.
// Two variants, picked by the second type argument of fero():
//   'a'  the handle is thenable: `await lens.connect(...)` gives the first state (V-a)
//   'b'  the handle has no `then`; `lens.get()` reads once and returns a promise (V-b, the default)
// I10/I11: `get` is two things, told apart by its argument: get() or get(opts) reads once; get(key) is the step by a
// key from input (today's f.at(key)).

export type Variant = 'a' | 'b'
declare const brand: unique symbol
/** A row's place in its partition's log: opaque text, compared with < (API.md section 6). */
export type Version = string & { readonly [brand]: 'version' }
/** One position per slot it reads (API.md section 6). */
export type Cursor = string & { readonly [brand]: 'cursor' }

/** Things that say they closed, and can say whether they already have (READS.md 2.2's three shapes). */
export interface NodeClosable { once(ev: 'close', fn: () => void): unknown; readonly destroyed: boolean }
export interface WsClosable { once(ev: 'close', fn: () => void): unknown; readonly readyState: number }
export interface WebSocketClosable { addEventListener(ev: 'close', fn: () => void, o?: { once?: boolean }): void; readonly readyState: number }
export type Closable = NodeClosable | WsClosable | WebSocketClosable

/** A wire record: [type, path, value]. */
export type Rec = readonly [0 | 1 | 2, readonly string[], unknown?]
/** One row's change in one commit. `prev` is the row before it; `version` is the row's place in its log. */
export interface Change<Row> {
  readonly op: 'add' | 'update' | 'remove'
  readonly key: string
  readonly row: Readonly<Row> | undefined
  readonly prev: Readonly<Row> | undefined
  readonly version: Version
}
/** One argument per commit, by reference: the first call carries the picture as adds. */
export interface Commit<Row> {
  readonly first: boolean
  readonly diff: readonly Change<Row>[]
  readonly version: Version
  recs(): readonly Rec[]
  text(): string
}
/** What a `for await` turn gets. */
export interface Turn<S, Row> { readonly state: S; readonly commit: Commit<Row> }

export interface ConnectOpts {
  /** Start at a position: every commit from there, in order (the log). Without it: the state, merged (live). */
  readonly from?: Version | Cursor | Date | 'now'
  /** End the link when this closes. */
  readonly until?: Closable
  /** End the link when this aborts. */
  readonly signal?: AbortSignal
  /** End the link after its first call. */
  readonly once?: boolean
}
export interface GetOpts { readonly signal?: AbortSignal }

/** A live link. disconnect and close are bound, so `return h.disconnect` works as a cleanup. */
export interface Link<S, Row> extends AsyncIterable<Turn<S, Row>> {
  readonly disconnect: () => void
  readonly close: () => void
  /** Settles once the first picture is here. */
  readonly ready: Promise<void>
  /** The state now, a sync read. */
  readonly state: S
}
/** V-a: the same, and thenable: `await` gives the first state. */
export interface ThenableLink<S, Row> extends Link<S, Row>, PromiseLike<S> {}
type LinkOf<S, Row, V extends Variant> = V extends 'a' ? ThenableLink<S, Row> : Link<S, Row>

/** The rows of a partition or of the whole resource: one live view, the same object at every commit. */
export type Rows<Row> = { readonly [key: string]: Readonly<Row> }

type Kind = 'root' | 'row' | 'field'
type StateOf<T, K extends Kind> = K extends 'root' ? Rows<T[keyof T]> : Readonly<T>

interface Flow<S, Row, V extends Variant> {
  /** fn(state, commit): the picture first (commit.first), then once per commit, a microtask after connect() returns. */
  connect(fn: (state: S, commit: Commit<Row>) => void, opts?: ConnectOpts): LinkOf<S, Row, V>
  /** No function: a handle to read (`state`) or to loop over (`for await`). */
  connect(opts?: ConnectOpts): LinkOf<S, Row, V>
  /** Read once: connect({ once }) as a promise. */
  get(opts?: GetOpts): Promise<S>
}
/** I10: get(key) is the step by a key held in a variable. */
interface KeyStep<T, Row, K extends Kind, V extends Variant> {
  get<P extends keyof T & string>(key: P): Lens<T[P], K extends 'root' ? T[P] : Row, K extends 'root' ? 'row' : 'field', V>
}
interface Writes<T> { set(value: T): Promise<void> }
type Steps<T, Row, K extends Kind, V extends Variant> =
  T extends object ? { readonly [P in keyof T & string]-?: Lens<T[P], K extends 'root' ? T[P] : Row, K extends 'root' ? 'row' : 'field', V> } : {}

/** A lens: an address. A step is a property; a call is a verb. A lens is never a promise. */
export type Lens<T, Row, K extends Kind, V extends Variant> =
  Flow<StateOf<T, K>, Row, V> & KeyStep<T, Row, K, V> & (K extends 'root' ? {} : Writes<T>) & Steps<T, Row, K, V>

export interface Resource<T, V extends Variant> {
  readonly name: string
  readonly data: Lens<T, T[keyof T], 'root', V>
  /** Today's step by a key from input (API.md 3.9). */
  at<P extends keyof T & string>(key: P): Lens<T[P], T[P], 'row', V>
}
export declare function fero<T, V extends Variant = 'b'>(name: string): Resource<T, V>
