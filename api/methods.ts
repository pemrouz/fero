//! ── api/methods — the method plane's HOST and CALLER (M5c) ───────────────────
// The kernel routes CALL/SUB/UNSUB/RESULT/SUBREC frames (kernel purity: a user
// handler is arbitrary async code and can never run inside step()); this module
// is both ends of the conversation:
//
//   HOST   — runs on every server: dispatches invokes to user methods, streams
//            live subscriptions, and enforces flush-on-return (a handler's
//            return awaits the commit of every write IT issued — plan §9,
//            BUILT: AsyncLocalStorage attributes writes to the invocation that
//            made them, across awaits, without a wrapper data facade).
//   CALLER — runs on every client: mints rpc ids, settles call promises off
//            RESULT frames, folds SUBREC streams into local $() proxies, and
//            owns the failover policies (v2's OQ2 hole, closed): on a primary
//            change, live subscriptions RE-SUBSCRIBE to the new feeder (a fresh
//            initial snapshot root-replaces the local proxy — views re-render),
//            retry-tagged calls re-dispatch, everything else fails fast with a
//            typed reason instead of waiting out its timeout.
//
// Consumption mode stays return-type dispatch (plan §9): the HOST probes the
// handler's return with isProxy (a ViewProxy is subscribable; a value is a
// value), and the CALLER's Handle picks the mode by how it is touched — await
// (`then`) is a one-shot CALL; any reactive touch opens the live subscription.
// RE-EXECUTION WARNING, stated: a retried CALL runs the handler AGAIN — method
// invocations are not cid-deduped (only the writes they issue are), so retry
// is per-call opt-in and belongs on idempotent methods only.
//
// Subscription streams ride data's RECORD interface (substrate.records): values
// cloned by the substrate, an initial whole-value snapshot on attach for free,
// and data-native string types on the wire (the SUBREC body is an opaque value
// to the kernel). 'move' records (bounded-sort rotations) are SKIPPED with this
// documented consequence: subscribe to the source and sort on the CLIENT proxy
// (operators work there) — a server-side windowed sort is not a streamable
// shape in M5c. A LIVE SCALAR (a handler returning `ctx.data.count`, or a plain
// number on the SUB leg) arrives in the mirror as `{ value }` — mirrors are
// object-born (substrate.applyStreamRec, I-27); the one-shot stays the bare number.

import { AsyncLocalStorage } from 'node:async_hooks'
import { VERB, MAX_DEPTH, encodable, sizeOf, Unsendable } from '../kernel/codec.ts'
import type { Rec } from '../kernel/env.ts'
import type { Runtime } from '../shell/runtime.ts'
import { applyStreamRec, disposeMinted, errText, handlerScope, handlerView, isProxy, mark, proxy, records, snapshot, stopped, unwrap, type Fault } from './substrate.ts'
import { atCap, copyBounded, replyCopy, lostAssignment, type Coords, type Refused } from './data.ts'
import type { ScopedError } from './types.ts'
import { FULL } from '../kernel/codec.ts'

//! settle — flush-on-return's wait (V4-5): every tracked write reaches an outcome; a write the validator
// REFUSED (api/data.ts Refused) fails the handler with the reason — a reply that claims an effect that
// never happened is §9's banned silent partial, and under `methods:` the handler is the client's only
// door. The same rule for a KERNEL outcome (the reply is true): an assignment the node did not commit —
// dropped at queue overflow, superseded, the node destroyed — fails the call with `write <outcome>`, and
// one an owner refused with `write refused`. Only ASSIGNMENTS (api/data.ts lostAssignment): a handler's
// own awaited methods.* write already told it, and its recovery stands.
const OUTCOMES = new Set(['dropped', 'superseded', 'destroyed', 'not-applied'])
const settle = async (tracked: Promise<Coords>[]): Promise<void> => {
  const out = await Promise.allSettled(tracked)
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (r.status !== 'rejected') continue
    if ((r.reason as Refused | null)?.refused === true)
      throw new Error(`write refused (${(r.reason as Refused).key}): ${(r.reason as Refused).reason}`)
    const lost = lostAssignment(tracked[i], r.reason)
    if (lost !== null)
      throw new Error(OUTCOMES.has(lost.outcome) ? `write ${lost.outcome} (${lost.key})` : `write refused (${lost.key}): ${lost.outcome}`)
  }
}

//! answer — a server-local call's result as a client's call decodes it (V4-52): replyCopy (api/data.ts) at the node's
// cap, so what a reply could not carry is refused here too, in the remote reply's words: too big for one frame — by
// the reply's real size — is the same typed 'too-large' (V4-51), anything else 'the result could not be sent: <why>'
// (#invoke derives the same why for a remote reply that failed)
const answer = (m: string, v: unknown, node: Runtime['node'], keyed = false): unknown => {
  try { return replyCopy(v, node.tune.frame) } catch (e) {
    if (e instanceof Unsendable && e.over) throw tooLarge(m, node.replicas, node.tune.frame, 'the answer', keyed)
    throw new Error(`methods.${m}: the result could not be sent: ${(e as Error).message}`)
  }
}

//! NOTHING — no value was being sent (a reply that failed before it began)
const NOTHING = Symbol('nothing')

//! SYSTEM — the reserved method-name prefix (unreachable from fero() opts: the composer rejects it):
// internal RPCs (confirm-over-the-wire) share the method plane without stealing any user name.
export const SYSTEM = '\u0000'

//! tooLarge — the typed refusal of a read too big to send (V4-51). A RESULT or a SUBREC carries ONE value and cannot
// be cut, so a whole read, a live sub's first picture or one of its changes bigger than one frame is refused — never
// cut, never a dropped link, never the untyped 'the result could not be sent'. `scoped: true` makes every caller hand
// it over as-is (rehydrate, below; old clients too: no wire change). `frame` is the answering node's cap.
//! `keyed` — the caller already read one key (methods.read(key), a keyed gather): it is told to read a smaller part of
// the row, never to read one key at a time
export const tooLarge = (m: string, replicas: number, frame: number, what: string, keyed = false): ScopedError => ({
  scoped: true, op: m.startsWith(SYSTEM) ? m.slice(1) : m, reason: 'too-large', replicas,
  hint: keyed
    ? `${what} is bigger than one frame (${sizeOf(frame)}), so fero cannot send it: read a smaller part of the row with a method that returns it`
    : `${what} is bigger than one frame (${sizeOf(frame)}), so fero cannot send it: read one key at a time (methods.read(key)), or use a method that returns a smaller part`,
})
//! isTooLarge — is this thrown value the refusal above (a member's `rows` answer, in the gather)? Every read guarded:
// a rejection can be anything
export const isTooLarge = (e: unknown): boolean => {
  try { return typeof e === 'object' && e !== null && (e as { scoped?: unknown }).scoped === true && (e as { reason?: unknown }).reason === 'too-large' } catch { return false }
}

//! Context — the second argument every handler receives. `data` is the server's own resource surface
// (writes route through the ONE ingest: validation + the write-route join + owner routing all apply); `flush()`
// awaits everything this handler has written SO FAR at 'committed' (the mid-body barrier — the
// implicit one runs at return).
export interface Context {
  data: any
  flush(): Promise<void>
  //! live (M6): true when this invocation opens a SUBSCRIPTION — a dual-mode handler (the scoped
  // default read) returns the live gather proxy on the SUB leg and the one-shot value on CALL.
  live?: boolean
  //! peer (V4-3): the invoking link's uuid — the caller's identity as admitted at HELLO. On a SERVER-local
  // call (host.invokeLocal) it is the server's OWN uuid: the server is the caller, and a handler that stamps
  // `from: ctx.peer` writes the same field either way. The directory host keys registrations by it
  // (api/directory.ts). Undefined only on a wire invoke whose link lost its identity mid-flight.
  peer?: string
}

type Handler = (arg: unknown, ctx: Context) => unknown
//! KEYED — the handlers whose argument names one key: the built-in read and the system plane's read (a member's hop
// to the key's owner). A too-large answer from one, given a key, tells the caller to read a smaller part of the row,
// never to read one key at a time. Marked by the handler, not its name: a program's own `read` replaces the built-in.
const KEYED = new WeakSet<Handler>()
export const takesKey = <F extends Handler>(f: F): F => (KEYED.add(f), f)

//! hosts — every Host in the process that has opened a live stream (a Host whose fero() never finished is
// never added). data runs ONE runtime per process, so a function that throws in one resource's commit can stop
// a view another resource's host serves; reapStopped asks them all.
const hosts = new Set<Host>()
//! reapStopped — end, in every host, the live subs whose view data has stopped. Called when a fault stopped a
// view (the composer) and when a host released views (disposeMinted can release a view another sub shares,
// the I-29 cousin); once per microtask burst, however many asked.
let reaping = false
export const reapStopped = (): void => {
  if (reaping) return
  reaping = true
  queueMicrotask(() => {
    reaping = false
    for (const h of hosts) h.reapStopped()
  })
}

//! the reasons a caller hears when the view it reads has stopped: data disposed it, because a function in it
// threw (the server printed which) or because another call that shared it released it
const STOPPED = 'the view this subscription streams has stopped: data disposed it (a function in it threw, or a call that shared it released it)'
const STOPPED_CALL = 'the view this method returns has stopped: data disposed it (a function in it threw, or a call that shared it released it)'

export class Host {
  #rt: Runtime
  #data: any
  //! #scope — what a handler gets as ctx.data: the surface, with every view a call through it makes
  // wrapped so the collector can tell when the handler let go of it (I-29, substrate.handlerScope)
  #scope: any
  #methods: Record<string, Handler>
  #system: Record<string, Handler>
  #als = new AsyncLocalStorage<Promise<Coords>[]>()
  //! live subscriptions by `link|id` — reaped on UNSUB and on link death (the composer's fold calls
  // reapLink off JK.linkDown; v2's serve-side leak guard, kept)
  #subs = new Map<string, { stop(): void; cancelled: boolean; live: unknown }>()
  //! served (M7 [diagnostics]): the leak-guard scalar — live subscriptions this host currently serves
  get served(): number { return this.#subs.size }

  //! report — the composer's printer for what this host refuses or ends on its own (a result or a record the
  // wire cannot carry): the server's owner sees it once, the caller hears the reason
  #report: (e: unknown, what: string) => void
  constructor(rt: Runtime, data: any, methods: Record<string, Handler>, system: Record<string, Handler>, report: (e: unknown, what: string) => void = () => {}) {
    this.#rt = rt
    this.#data = data
    this.#scope = handlerScope(data)
    this.#methods = methods
    this.#system = system
    this.#report = report
    rt.onInvoke = (link, id, mode, m, a) => this.#invoke(link, id, mode, m, a)
  }

  //! tracked — Bind's flush-on-return seam: whatever invocation context is live gets the coordinate
  // promises of every write made inside it (survives awaits — that is the point of ALS).
  tracked = (): Promise<Coords>[] | undefined => this.#als.getStore()

  #invoke(link: number, id: number, mode: number, m: string, a: unknown) {
    const skey = link + '|' + id
    if (mode === VERB.UNSUB) {
      //! UNSUB may arrive DURING the handler/flush, before the stream opens (M5-review #6): the entry
      // already exists (registered up front below), so mark it cancelled + stop whatever it holds. Once
      // cancelled, the deferred open below sees it and never streams.
      const sub = this.#subs.get(skey)
      if (sub) { sub.cancelled = true; sub.stop(); this.#subs.delete(skey) }
      return
    }
    const fn = m.startsWith(SYSTEM) ? this.#system[m.slice(1)] : this.#methods[m]
    if (!fn) return this.#reply(link, id, false, `unknown method '${m.startsWith(SYSTEM) ? m.slice(1) : m}'`)
    //! a SUB registers its entry BEFORE running the handler (M5-review #2/#6): reapLink (link death) and
    // UNSUB run synchronously off kernel steps and would otherwise miss a sub whose #subs.set sits after
    // the flush-on-return await, permanently leaking the stream. The placeholder holds a no-op stop and
    // a cancelled flag; the deferred open replaces stop and checks cancelled.
    const entry = mode === VERB.SUB ? { stop: () => {}, cancelled: false, live: undefined as unknown } : null
    if (entry) this.#subs.set(skey, entry)
    //! each invocation gets its own write collector; the handler runs OUTSIDE the kernel step (async),
    // and its return implicitly flushes — the reply provably follows its own commits
    const tracked: Promise<Coords>[] = []
    //! the views this handler makes through ctx.data are released when the handler's handle to them is
    // collected (I-29, substrate.handlerScope) — whether it returned a value, returned the view, or kept
    // it. The mark is for a view made some other way (f.data.filter(…) in a closure): that one, when
    // RETURNED, is still disposed once the reply collapsed it or its stream closed (disposeMinted)
    const minted = mark(this.#data)
    const ctx: Context = {
      data: this.#scope,
      flush: () => settle(tracked.splice(0)),
      live: mode === VERB.SUB,
      ...(this.#rt.node.links.get(link)?.uuid ? { peer: this.#rt.node.links.get(link)!.uuid } : {}),
    }
    void (async () => {
      let result: unknown
      //! a handler that returns a plain VALUE does not release its views here: nothing tells a view it
      // dropped from one it cached for its next call (`cached ??= ctx.data.filter(…)`) — the graph holds
      // both alike, and disposing a cached one froze it silently (V4-16). The collector tells them apart.
      try {
        //! NEVER blind-await the handler result: a ViewProxy is THENABLE (data's await-for-snapshot
        // feature), so `await proxy` would collapse the live view to a value before isProxy could see
        // it — the exact bug class that silently degrades a subscription to one frozen frame. Probe
        // first; await only genuine promises. Consequence, stated: an ASYNC handler returning a proxy
        // still collapses (promise adoption unwraps thenables — structural to JS) — return live views
        // from SYNC handlers (`read: (a, ctx) => ctx.data`), compute asynchronously via ctx before.
        result = this.#als.run(tracked, () => fn(a, ctx))
        //! a SYNC handler that wrote nothing has nothing to flush: a SUB opens its stream NOW, inside the
        // step that carried the SUB frame, so the initial snapshot is the state AT RECEIPT (I-28). This
        // runs before the first await, so it is synchronous. Without it the hop to the microtask let the
        // next frame in the same chunk — the caller's CALL that changes the data — commit first, and
        // "open, then act" folded the act into the snapshot instead of streaming it as a delta.
        if (entry && isProxy(result) && tracked.length === 0) return this.#open(entry, skey, link, id, result, minted, m)
        if (!isProxy(result) && result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function')
          result = await result
        await settle(tracked) // flush-on-return — a refused write fails the call (V4-5)
      } catch (err) {
        if (entry && this.#subs.get(skey) === entry) this.#subs.delete(skey)
        //! a sync open that failed after the handler returned a view: the view it minted goes too
        this.#release(result, minted)
        return this.#refuse(link, id, err)
      }
      //! the reply, and a value SUB's one frame, encode the handler's result inside the kernel step: a value
      // the wire cannot carry (a bigint, a getter that throws) threw out of here as an unhandled rejection and
      // ended the server. The caller hears why instead, and the server carries on.
      //! `sent` — the value this reply was encoding, kept for the failure's words: a view minted for the call is
      // disposed before its reply, so the catch below must not read the view again
      let sent: unknown = NOTHING
      try {
        if (mode === VERB.CALL) {
          //! a returned ViewProxy collapses to its snapshot for a one-shot call (v2's forWire, kept;
          // no clone — the reply's codec copies the value into frame bytes synchronously inside step);
          // a view made through ctx.data waits for the collector (the handler may have kept it — a view cached
          // on the first call and returned there); one made another way is dead once collapsed (I-29). A view
          // data has stopped would answer a frozen picture as if it were current: refused instead.
          if (!isProxy(result)) { sent = result; return this.#reply(link, id, true, result) }
          if (stopped(result)) { this.#release(result, minted); return this.#reply(link, id, false, STOPPED_CALL) }
          const value = sent = snapshot(result)
          this.#release(result, minted)
          return this.#reply(link, id, true, value)
        }
        //! the sub may have been UNSUBbed or its link reaped during the handler/flush — the entry is gone
        // or cancelled; do not open a stream nobody is listening to (M5-review #2/#6)
        if (!entry || entry.cancelled || this.#subs.get(skey) !== entry) {
          //! cancelled during the handler or its flush: the view it made is released all the same
          this.#release(result, minted)
          return
        }
        //! SUB: a proxy streams (initial snapshot rides the record interface's attach emit); a plain
        // value degrades to a single-shot stream (one root update) — same consumption shape either way
        if (!isProxy(result)) {
          this.#subs.delete(skey) // a value SUB has no live stream to hold; drop the placeholder
          sent = result
          this.#rt.node.step({ kind: 'subOut', link, id, recs: [{ type: 'update', key: [], value: result } as unknown as Rec] })
          return
        }
        this.#open(entry, skey, link, id, result, minted, m)
      } catch (err) {
        if (entry && this.#subs.get(skey) === entry) { entry.cancelled = true; entry.stop(); this.#subs.delete(skey) }
        this.#release(result, minted)
        //! an answer bigger than one frame (a CALL's value, a value SUB's one frame — V4-51): the typed refusal, and one
        // plain line for the server's owner (the printer's de-duplication: once per resource and method)
        if (err === FULL) {
          const frame = this.#rt.node.tune.frame
          this.#report(FULL, `refused a read whose answer is bigger than one frame, ${sizeOf(frame)} (methods.${m}) — the caller was told to read a smaller part`)
          return this.#reply(link, id, false, tooLarge(m, this.#rt.node.replicas, frame, 'the answer', a != null && KEYED.has(fn)))
        }
        //! the reply's words are the local answer's (answer above): what stopped the value — a plain result or a view's
        // picture — by encodable's walk, asked only here, on the failure, so a reply that encodes pays nothing for it.
        // With no byte bound: the encode failed for something other than its size (FULL is above), and the walk's
        // worst-case charge would answer 'bigger than' first for a value with text before the bigint (the V4-51/52
        // review). At the depth the frame carries the value: a RESULT one level down, a value SUB's SUBREC three.
        let why: string | null = null
        if (sent !== NOTHING) try { why = encodable(sent, { depth: MAX_DEPTH - (mode === VERB.CALL ? 1 : 3), bytes: Infinity }) } catch { why = null }
        this.#report(err, `a method's result could not be sent (methods.${m}) — the call was refused`)
        this.#reply(link, id, false, `the result could not be sent: ${why ?? errText(err)}`)
      }
    })()
  }

  //! #release — the eager release of what a handler returned, for a view made some other way than ctx.data
  // (f.data.filter(…) in a closure): disposeMinted, the release it had before. A handler view (made through
  // ctx.data) waits for the collector instead — the handler may have kept it (I-29). When the eager walk
  // released a view another sub still read, the live subs are checked: one may now stream a stopped view
  // (V4-47). Guarded by handlerView AND by disposeMinted's own `live.has` skip, each backing the other up.
  #release(result: unknown, minted: number) {
    if (isProxy(result) && !handlerView(result) && disposeMinted(result, minted)) reapStopped()
  }

  //! #refuse — reply a handler's failure, whatever it threw. A typed ScopedError ships as the value (M6,
  // rehydrated at the caller); an Error ships its message; anything else ships as text. Every read of the
  // thrown value is guarded and so is the reply: a throw out of here is an unhandled rejection that ends the
  // server (a message getter that throws, a Proxy whose traps throw, a ScopedError carrying a bigint).
  #refuse(link: number, id: number, err: unknown) {
    let value: unknown
    try {
      value = typeof err === 'object' && err !== null && (err as { scoped?: unknown }).scoped === true ? err
        : err instanceof Error && typeof err.message === 'string' ? err.message : errText(err)
    } catch {
      value = errText(err)
    }
    try {
      this.#reply(link, id, false, value)
    } catch {
      //! cut to 1 KiB, so the last resort always fits a frame (a handler's 300 MB message once made it fail too, and the
      // caller waited out its timeout)
      try { this.#reply(link, id, false, `the handler threw a value that could not be sent: ${errText(err).slice(0, 1024)}`) } catch {}
    }
  }

  //! #open — a SUB's live stream over the handler's proxy: the initial snapshot rides the record
  // interface's attach emit, every later change is one SUBREC. Skipped when the sub was UNSUBbed or its
  // link reaped meanwhile (M5-review #2/#6) — the view the handler minted for it is released either way.
  #open(entry: { stop(): void; cancelled: boolean; live: unknown }, skey: string, link: number, id: number, result: unknown, minted: number, m: string) {
    if (entry.cancelled || this.#subs.get(skey) !== entry) { this.#release(result, minted); return }
    //! a view data has already stopped (the handler's own write made a function in it throw) never moves
    // again: fail the sub now, never open a stream over a frozen picture
    if (stopped(result)) {
      this.#subs.delete(skey)
      this.#release(result, minted)
      return this.#reply(link, id, false, STOPPED)
    }
    hosts.add(this)
    //! retain the LIVE proxy on the entry (M5-review #11): records() pins only the leaf FunctionSink
    // via its anchor, NOT the operator chain feeding it — a derived return (ctx.data.filter(...)) is
    // held only by `result`, so without this strong ref the chain is GC'd and the stream goes silent.
    entry.live = result
    //! clone: false — the record is encoded into frame bytes inside subOut at once (substrate.ts records)
    //! first: the attach record — the whole picture — is the first this sink sees; every later one is a change
    let first = true
    const stream = records(result, (rec) => {
      if (rec.type === 'move' || entry.cancelled) return // a move: documented M5c limitation (banner), sort client-side instead
      const picture = first
      first = false
      //! fero's own sink, run by data as the commit closes: a record it cannot send (a value the wire cannot
      // carry) ends this sub loudly — never a throw into data's commit, where it read as a user's tap and left
      // the caller's mirror frozen behind 'live'. (The composer's post-step fold cannot throw through here: its
      // own throws leave from a microtask, api/index.ts.)
      try {
        this.#rt.node.step({ kind: 'subOut', link, id, recs: [rec as unknown as Rec] })
      } catch (err) {
        //! a record bigger than one frame (V4-51): the first picture of a whole read, or one change that grew past it —
        // the sub ends with the typed refusal, and the server's owner hears it once
        if (err === FULL) {
          const frame = this.#rt.node.tune.frame
          this.#report(FULL, picture
            ? `refused a live read whose first picture is bigger than one frame, ${sizeOf(frame)} (methods.${m}) — the caller was told to read a smaller part`
            : `ended a live read: one change is bigger than one frame, ${sizeOf(frame)} (methods.${m})`)
          this.#end(skey, link, id, tooLarge(m, this.#rt.node.replicas, frame, picture ? "this subscription's first picture" : 'a change in this subscription'))
          return
        }
        this.#report(err, `a live subscription ended: a record could not be sent (methods.${m})`)
        this.#end(skey, link, id, `the stream could not send a record: ${errText(err)}`)
      }
    }, { clone: false })
    //! stop = the stream AND the view minted for it (I-29): UNSUB, reapLink and destroy all come here.
    // A view made through ctx.data is released by the collector once this entry lets go of it (the
    // handler may have cached it); one made another way goes now, and only what this invocation minted —
    // `read` returns ctx.data itself, the gather hands out its one shared proxy, a module-level view
    // predates the mark; disposeMinted leaves every one of them.
    entry.stop = () => { stream.stop(); this.#release(result, minted) }
  }

  #reply(link: number, id: number, ok: boolean, value: unknown) {
    this.#rt.node.step({ kind: 'reply', link, id, ok, value })
  }

  //! invokeLocal — a SERVER-side one-shot call (no wire): the SAME flush-on-return + non-blind-await +
  // proxy-collapse discipline as a remote CALL (M5-review #5: the old server-local path used a no-op
  // flush and no ALS, so a handler's writes were NOT awaited before the value returned — local and wire
  // invocation of the same handler gave opposite durability). A returned ViewProxy collapses to a copy of
  // its snapshot (M5-review #10: returning the live proxy value handed the caller a mutable alias of
  // committed kernel state; the wire path serializes to a fresh copy, so local must copy to match).
  //! Both ends are what the wire makes of them (V4-52): the handler gets fero's own copy of the argument, refused
  // as a client's call refuses it, and the caller gets copyOf of the result — a plain value too, which it used
  // to get by reference — with RESULT's limits. structuredClone kept a Date a client gets as {}, kept a lone
  // surrogate UTF-8 turns into U+FFFD, and threw a DataCloneError on a view of Proxies the wire carries as plain
  // objects; a handler changed the caller's own object.
  async invokeLocal(m: string, a: unknown): Promise<unknown> {
    const fn = this.#methods[m]
    if (!fn) throw new Error(`unknown method '${m}'`)
    let arg: unknown
    try { arg = copyBounded(a, atCap(this.#rt.node.tune.frame).arg) } catch (e) { throw new Error(`methods.${m}: the argument cannot be sent: ${(e as Error).message}`) }
    const tracked: Promise<Coords>[] = []
    const minted = mark(this.#data)
    //! peer is this node: a local call's caller IS the server (the Context doc above)
    const ctx: Context = { data: this.#scope, flush: () => settle(tracked.splice(0)), peer: this.#rt.node.uuid }
    let result: unknown = this.#als.run(tracked, () => fn(arg, ctx))
    if (!isProxy(result) && result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function')
      result = await result
    await settle(tracked) // flush-on-return — a refused write fails the call (V4-5)
    const keyed = a != null && KEYED.has(fn)
    if (!isProxy(result)) return answer(m, result, this.#rt.node, keyed) // its views wait for the collector (#invoke's note)
    //! a view data has stopped answers a frozen picture: refused, as for a remote call
    if (stopped(result)) { this.#release(result, minted); throw new Error(`methods.${m}: ${STOPPED_CALL}`) }
    //! a view made another way is dead once copied (I-29), and released even when the copy is refused
    try { return answer(m, snapshot(result), this.#rt.node, keyed) } finally { this.#release(result, minted) }
  }

  //! #end — end one live sub loudly: the caller's handle fails with the reason (Caller.#onResult: mode
  // 'failed', `ready` rejects if it has not framed, onError hears it). Called from inside a kernel step and
  // data's commit, so the stop and the reply wait for a microtask, outside both. The reason is text, or a typed
  // ScopedError the caller hands over as-is (too-large, V4-51).
  #end(skey: string, link: number, id: number, reason: unknown) {
    const sub = this.#subs.get(skey)
    if (sub === undefined) return
    sub.cancelled = true
    this.#subs.delete(skey)
    queueMicrotask(() => {
      sub.stop()
      this.#reply(link, id, false, reason)
    })
  }

  //! endLive — end every live sub streaming `proxy` with `reason` (V4-51): the scoped gather's union could not take a
  // member's share (bigger than one frame), and a live whole read must never show a silent partial (plan §9).
  // Matched by the handle under the surface, not by identity: a handler's whole read returns ctx.data, the scope
  // over the surface (V4-54), while the gather's hook passes the surface itself; both unwrap to one handle, and a
  // derived view (ctx.data.map(…)) unwraps to its own, so its sub streams on.
  endLive(proxy: unknown, reason: unknown) {
    const handle = unwrap(proxy)
    for (const [skey, sub] of this.#subs) {
      if (sub.live === undefined || unwrap(sub.live) !== handle) continue
      const bar = skey.indexOf('|')
      this.#end(skey, Number(skey.slice(0, bar)), Number(skey.slice(bar + 1)), reason)
    }
  }

  //! reapStopped — end every live sub whose view data has stopped since it opened (a function in it, or in a
  // view it reads from, threw): its sink was disposed with it and would never fire again
  reapStopped() {
    for (const [skey, sub] of this.#subs) {
      if (sub.live === undefined || !stopped(sub.live)) continue
      const bar = skey.indexOf('|')
      this.#end(skey, Number(skey.slice(0, bar)), Number(skey.slice(bar + 1)), STOPPED)
    }
  }

  //! reapLink — the caller's link died: stop its streams AND cancel any still opening in a flush window
  // (the composer folds JK.linkDown into this; the cancelled flag makes the deferred open a no-op).
  reapLink(link: number) {
    for (const [key, sub] of this.#subs)
      if (key.startsWith(link + '|')) { sub.cancelled = true; sub.stop(); this.#subs.delete(key) }
  }

  //! reapGone — reapLink for every link that is no longer live: the composer's fold calls it when the
  // journal ring overflowed past its cursor (journal.cap below one step's burst), so a linkDown row it
  // never read cannot leak the streams that link held
  reapGone(live: (link: number) => boolean) {
    for (const [key, sub] of this.#subs) {
      const bar = key.indexOf('|')
      if (bar > 0 && !live(Number(key.slice(0, bar)))) { sub.cancelled = true; sub.stop(); this.#subs.delete(key) }
    }
  }

  destroy() {
    hosts.delete(this)
    for (const [, sub] of this.#subs) sub.stop()
    this.#subs.clear()
  }
}

interface PendingCall {
  m: string
  a: unknown
  retry: boolean
  held: boolean // failed pre-dispatch ('unreachable' = never shipped, never executed) — safe to re-dispatch for EVERY call
  to?: string // M6-review finding 6: a to-routed call has no failover to hold for — it fails fast, typed
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

//! Sub — one live subscription on the caller. `ready` is one ATTEMPT's promise, made EAGERLY: when the sub
// opens, and again when a primary change re-subscribes a sub that had framed (the new primary's answer is a
// new attempt). It resolves (with nothing — the mirror is THENABLE, so resolving with it would collapse it to
// a snapshot) on that attempt's first frame, and rejects when the host fails the SUB or the mirror refuses a
// record. Eager on purpose: a failure nobody handles is an unhandled rejection, which exits the process with
// the reason — as loud as an uncaught call, and after a failover too. `onError` (the handle's option) is the
// one place that hears EVERY failure, before or after a frame; with it set no attempt goes unhandled.
// `error` is set once, when the sub failed; the handle reads it (mode 'failed', every read throws it).
// A sub that ends without a frame (close, destroy) rejects its pending `ready` as handled — not a failure.
export interface Sub {
  id: number
  m: string
  a: unknown
  proxy: any
  ready: Promise<void>
  error: Error | null
  framed: boolean
  onError: ((e: Error) => void) | null
  resolve: () => void
  reject: (e: Error) => void
}

const noop = () => {}

//! arm — a fresh attempt: a new eager `ready`, pre-handled when an onError hears the failures instead
const arm = (sub: Sub): void => {
  sub.framed = false
  sub.ready = new Promise<void>((res, rej) => { sub.resolve = res; sub.reject = rej })
  if (sub.onError !== null) sub.ready.catch(noop)
}

//! end — the sub stopped without failing (close, destroy): a `ready` still waiting rejects with why, marked
// handled — an awaiting caller learns it, a caller who never looked is not stopped by its own shutdown
const end = (sub: Sub, why: string): void => {
  if (sub.framed || sub.error !== null) return
  sub.ready.catch(noop)
  sub.reject(new Error(`methods.${sub.m}: ${why}`))
}

//! Arg — a call's argument as fero's own copy (`v`), or why it cannot be sent (`e`), taken once (Caller.argOf)
type Arg = { v: unknown } | { e: Error }

export class Caller {
  #rt: Runtime
  #seq = 0
  #calls = new Map<number, PendingCall>()
  #subs = new Map<number, Sub>()

  //! fault — where the user's views and taps on a sub's mirror land when they throw as a streamed record
  // folds (substrate.ts Fault): this runs inside the kernel's step, so never up into it
  #fault: Fault | undefined
  constructor(rt: Runtime, fault?: Fault) {
    this.#rt = rt
    this.#fault = fault
    rt.onResult = (id, ok, value, local) => this.#onResult(id, ok, value, local)
    rt.onSubRecs = (id, recs) => this.#onSubRecs(id, recs)
  }

  //! call — one-shot RPC. `retry` re-dispatches on primary failover (idempotent methods ONLY — the
  // banner's re-execution warning); default is fail-fast with a typed reason.
  //! argOf — fero's own copy of a call's argument at the node's cap (ARG), or the refusal in the call's words. A
  // handle takes it once, when it is made (handle below), and hands it to every call and sub it starts.
  argOf(m: string, a: unknown): Arg {
    try { return { v: copyBounded(a, atCap(this.#rt.node.tune.frame).arg) } } catch (e) { return { e: new Error(`methods.${m}: the argument cannot be sent: ${(e as Error).message}`) } }
  }

  call(m: string, a: unknown, opts: { timeout?: number; retry?: boolean; to?: string } = {}, pre?: Arg): Promise<unknown> {
    //! an argument the wire cannot carry is refused here, before the step (V4-48): encoded inside it, it threw
    // out of the kernel — at once, or from a socket handler when a held call replayed on the next primary —
    // and ended the client. What is sent is fero's own copy, taken by the same walk (V4-52): a held call, or a
    // retried one, re-encoded the caller's object when it replayed, so a change made meanwhile was sent, and a
    // change to something fero cannot send (a bigint) threw from the socket handler while the call hung.
    const got = pre ?? this.argOf(m, a)
    if ('e' in got) return Promise.reject(got.e)
    const arg = got.v
    const id = ++this.#seq
    const ms = opts.timeout ?? 10_000
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (!this.#calls.delete(id)) return
        reject(new Error(`methods.${m}: timeout after ${ms}ms`))
      }, ms)
      t.unref?.()
      this.#calls.set(id, {
        m, a: arg, retry: opts.retry === true, held: false,
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      //! `to` (M6): a named member instead of the primary — the scoped gather/remote-read fan-out
      this.#rt.node.step({ kind: 'rpc', id, mode: VERB.CALL, m, a: arg, ...(opts.to !== undefined ? { to: opts.to } : {}) })
    })
  }

  //! subscribe — open a live stream into a fresh local proxy. The id doubles as the subscription
  // identity server-side (keyed by link|id there, so the same id re-used on a NEW primary is clean).
  subscribe(m: string, a: unknown, onError: ((e: Error) => void) | null = null, pre?: Arg): Sub {
    const id = ++this.#seq
    const sub = { id, m, a: undefined, proxy: proxy({}), error: null, onError } as Sub
    arm(sub)
    //! the same question as call(), and the same copy (a re-subscribe on the next primary sends it): a sub whose
    // argument cannot be sent fails at once and nothing is stepped. The handle's touch throws the reason, so its
    // `ready` is marked handled: one failure, told once.
    const got = pre ?? this.argOf(m, a)
    if ('e' in got) {
      sub.ready.catch(noop)
      this.#fail(sub, got.e)
      return sub
    }
    sub.a = got.v
    this.#subs.set(id, sub)
    this.#rt.node.step({ kind: 'rpc', id, mode: VERB.SUB, m, a: sub.a })
    return sub
  }

  //! #fail — the sub is over, loudly: the reason is kept for the handle, `ready` rejects, and the sub
  // leaves #subs so no primary change re-subscribes it into the same failure
  #fail(sub: Sub, e: Error) {
    if (sub.error !== null) return
    sub.error = e
    this.#subs.delete(sub.id)
    sub.reject(e)
    //! a microtask: onError is user code, and this runs inside a kernel step — a throw there is the
    // user's own uncaught error, never a broken step
    const hear = sub.onError
    if (hear !== null) queueMicrotask(() => hear(e))
  }

  unsubscribe(id: number) {
    const sub = this.#subs.get(id)
    if (sub === undefined) return
    this.#subs.delete(id)
    end(sub, 'closed')
    this.#rt.node.step({ kind: 'rpc', id, mode: VERB.UNSUB })
  }

  #onResult(id: number, ok: boolean, value: unknown, local: boolean) {
    const c = this.#calls.get(id)
    if (!c) {
      //! a SUB's only RESULT is a failure: the host's handler threw, or a write it made was refused
      // (V4-5). A LOCAL failure (no primary yet, the frame never shipped) is NOT one: that SUB is held
      // and replayed on the next primary (I-28) — the local bit is load-bearing.
      const sub = this.#subs.get(id)
      if (sub && !ok && !local) this.#fail(sub, rehydrate(sub.m, value))
      return
    }
    //! a LOCAL failure is pre-dispatch (the kernel never shipped the frame ⇒ the handler never ran) —
    // hold it for the next primary (safe for EVERY call — the handler didn't run; the timeout bounds
    // the wait). `local` is the channel bit (M5-review #7): a wire RESULT whose value happens to equal
    // 'unreachable' arrives with local=false and settles as an ordinary handler rejection, never held.
    //! …but ONLY for primary-routed calls. A TO-ROUTED call (M6-review finding 6) names its member —
    // a primary change never makes that member reachable, and the member caller has no
    // onPrimaryChange wired anyway, so "held" would just sit out the full timeout. Reject NOW, typed:
    // the gather's fan-out and the remote-key read turn one dead link into one fast ScopedError
    // instead of an 8s stall per generation.
    if (!ok && local) {
      if (c.to !== undefined) {
        this.#calls.delete(id)
        return c.reject({
          scoped: true, op: c.m.startsWith(SYSTEM) ? c.m.slice(1) : c.m, reason: 'unreachable',
          replicas: this.#rt.node.replicas, missing: [c.to],
          hint: `member ${c.to} has no admitted link — retry when the view heals`,
        } satisfies ScopedError as unknown as Error)
      }
      c.held = true
      return
    }
    this.#calls.delete(id)
    if (ok) c.resolve(value)
    //! M6: a typed ScopedError crosses the wire as the RESULT error value and rehydrates AS-IS —
    // the `scoped: true` discriminant is the contract (api/types.ts); everything else keeps the
    // Error-string wrap
    else c.reject(rehydrate(c.m, value))
  }

  #onSubRecs(id: number, recs: Rec[]) {
    const sub = this.#subs.get(id)
    if (!sub) return
    for (const r of recs) {
      const rejected = applyStreamRec(sub.proxy, r as unknown as { type: string; key?: string[]; value?: unknown; at?: unknown }, this.#fault)
      //! a record the mirror could not fold: the mirror is stale from here on, so the sub fails loudly
      // (and the host stops streaming into it) instead of showing old data as if it were live
      if (rejected !== null) {
        this.#fail(sub, new Error(`methods.${sub.m}: the mirror refused a streamed record — ${(rejected as Error)?.message ?? String(rejected)}`))
        this.#rt.node.step({ kind: 'rpc', id, mode: VERB.UNSUB })
        return
      }
    }
    if (!sub.framed) { sub.framed = true; sub.resolve() }
  }

  //! onPrimaryChange — the failover policies (v2's OQ2, closed): re-subscribe every live sub on the
  // new feeder (same id — server subs are per-link), re-dispatch HELD (never-shipped) and retry-tagged
  // calls, fail the shipped-and-lost rest fast (re-execution is only safe when declared idempotent).
  //! SUBs FIRST (I-28): both ride the same link in order, and a client's fero() resolves before its
  // first link — so "open, then act" right after it is a held SUB and a held CALL. Replaying the CALL
  // first made the view's first frame already hold the call's effect; the delta never rendered.
  onPrimaryChange() {
    for (const [id, sub] of this.#subs) {
      //! a sub that had framed starts a NEW attempt (a fresh eager `ready`): the new primary may fail it,
      // and that must not land on a promise already resolved — silent, the mirror kept as if live
      if (sub.framed) arm(sub)
      this.#rt.node.step({ kind: 'rpc', id, mode: VERB.SUB, m: sub.m, a: sub.a })
    }
    for (const [id, c] of [...this.#calls]) {
      if (c.held || c.retry) {
        c.held = false
        this.#rt.node.step({ kind: 'rpc', id, mode: VERB.CALL, m: c.m, a: c.a })
      } else {
        this.#calls.delete(id)
        c.reject(new Error(`methods.${c.m}: link-down (the connected server died; pass {retry: true} on idempotent calls)`))
      }
    }
  }

  destroy() {
    for (const [, c] of this.#calls) c.reject(new Error(`methods.${c.m}: destroyed`))
    this.#calls.clear()
    for (const [, sub] of this.#subs) end(sub, 'destroyed')
    this.#subs.clear()
  }
}

//! rehydrate — a wire RESULT's error value as the Error the caller throws. M6: a typed ScopedError crosses
// the wire as the value and rehydrates AS-IS (the `scoped: true` discriminant is the contract, api/types.ts);
// everything else is the message string, wrapped and named by its method.
const rehydrate = (m: string, value: unknown): Error =>
  typeof value === 'object' && value !== null && (value as { scoped?: boolean }).scoped === true
    ? value as Error
    : new Error(`methods.${m}: ${String(value)}`)

//! COERCION — property names that are introspection/coercion hooks, NOT reactive reads: touching them
// must never open a subscription (M5-review #8: `String(h)`, template literals, JSON.stringify/toJSON,
// util.inspect, duck-typing all hit the get trap; opening a live sub on any of them leaks a client+
// server subscription with no lifecycle owner). Symbols (Symbol.toPrimitive/toStringTag/iterator, the
// nodejs inspect symbol, etc.) are covered separately by the typeof check.
const COERCION = new Set(['toJSON', 'toString', 'valueOf', 'constructor', 'nodeType', 'length', 'name', 'prototype'])

//! handle — the tagged dual-mode Handle (plan §9): `await` (then) is a one-shot CALL; any reactive
// touch opens the live subscription ONCE and delegates every subsequent trap to the local mirror
// proxy. Reserved surface on a handle: then / catch / finally / open / close / mode / ready — everything
// else is the live view. Writes through a handle throw: subscription results are read-only projections.
//! A FAILED sub (the host threw, a write was refused, the mirror refused a record): `ready` rejects with
// the reason, `mode` reads 'failed', `open()` and every reactive read throw that reason, `close()` is a
// no-op. Passive touches (symbols, coercion hooks) never throw — inspecting a dead handle is not a read.
//! `ready` is the CURRENT attempt (a failover starts a new one, the Sub note); to hear every failure of a
// long-lived sub, pass `{ onError }` (`methods.feed(arg, { onError })`) — then no failure stops the process.
// After close(), `ready` is the closed sub's (rejected 'closed' if it never framed); it never re-opens.
export const handle = (caller: Caller, m: string, a: unknown, opts: { timeout?: number; retry?: boolean; onError?: (e: Error) => void } = {}): any => {
  let live: Sub | null = null
  let last: Sub | null = null // the sub close() ended: `ready` keeps answering from it
  //! the argument as it was when the handle was made (V4-52): fero's own copy, taken HERE, once — not at the await or
  // the first touch, which sent a change the program made in between (a server's own call copies at the call too) —
  // and the same copy for every call and sub this handle starts; a refusal is kept and told at first use. A handle the
  // program keeps holds that copy for as long as it keeps the handle.
  const pre = caller.argOf(m, a)
  const call = (): Promise<unknown> => caller.call(m, a, opts, pre)
  const subscribe = (): Sub => caller.subscribe(m, a, opts.onError ?? null, pre)
  const open = (): Sub => {
    live ??= subscribe()
    if (live.error !== null) throw live.error
    return live
  }
  const reserved = (prop: string | symbol) => prop === 'then' || prop === 'open' || prop === 'close' || prop === 'mode' || prop === 'ready'
  //! a bare touch that is NOT a reactive read (a symbol, a coercion hook) must NOT open the sub. Coercion
  // hooks return a MARKER (so `String(h)`/templates yield '[fero handle]' rather than throwing 'cannot
  // convert to primitive'); toJSON returns undefined (serializes to nothing); every other symbol/passive
  // prop is undefined. If the sub is already live, delegate to the mirror proxy.
  const marker = () => '[fero handle]'
  const passive = (prop: string | symbol): unknown => {
    if (live) return (live.proxy as Record<string | symbol, unknown>)[prop]
    if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return marker
    if (prop === Symbol.toStringTag) return 'FeroHandle'
    if (prop === 'toJSON') return () => undefined
    return undefined
  }
  const isPassive = (prop: string | symbol) => typeof prop === 'symbol' || (typeof prop === 'string' && COERCION.has(prop))
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => call().then(onF, onR)
      //! catch/finally are thenable-adjacent, NOT reactive touches — `methods.x().catch(...)` must
      // behave like a promise, never open a subscription with a 'catch' operator (M6 papercut)
      if (prop === 'catch') return (onR?: (e: unknown) => unknown) => call().catch(onR)
      if (prop === 'finally') return (onD?: () => void) => call().finally(onD)
      if (prop === 'open') return () => open().proxy
      //! `ready` opens the sub (waiting for its first frame IS a reactive intent) and is the same promise
      // for the whole attempt — made when it began, so a failure before anyone looked is still delivered;
      // on a closed handle it is the closed sub's, never a new sub
      if (prop === 'ready') return (live ?? last ?? (live = subscribe())).ready
      if (prop === 'close') return () => { if (live && live.error === null) { caller.unsubscribe(live.id); last = live; live = null } }
      if (prop === 'mode') return live === null ? 'oneshot' : live.error !== null ? 'failed' : 'live'
      if (isPassive(prop)) return passive(prop)
      return open().proxy[prop]
    },
    set() { throw new Error(`methods.${m}: subscription handles are read-only — write via data or methods.update`) },
    //! `has` (the `in` operator, duck-typing) must NEVER open a sub either — report only the reserved
    // surface plus, if already live, the live proxy's keys
    has(_t, prop) { return reserved(prop) || (live ? prop in live.proxy : false) },
    //! `apply` — CALLING the handle is the one-shot call: `h()` returns the promise. The target is a
    // function (so `typeof h === 'function'`), and without this trap `h()` returned undefined — every
    // promise utility that probes for a function and calls it (assert.rejects, retry wrappers …) failed
    // with ERR_INVALID_RETURN_VALUE, so the examples had to write `assert.rejects(async () => { await h })`
    // (rungs 40 and 43). Arguments are ignored: the call's argument was bound when the handle was made.
    apply() { return call() },
  })
}
