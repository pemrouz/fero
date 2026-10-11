//! ── api/data — the $() binding: the lens in, the confirmed fold out, the write-route join ──
// ONE surface (DECISIONS V4-7): the proxy (this.data) IS the confirmed fold — kernel state
// (node.state) projected through data's hot lane, nothing layered on top. A write shows
// when it COMMITS, never before:
//
//   - a server writing a cell it OWNS commits inside the assignment (the kernel's epoch-0
//     fast path, or the self-owned attempt — kernel/write.ts issue/#drain), so the value
//     is there when the assignment returns: read-your-writes by commit, not by a copy;
//   - a FORWARDED write (a client's, or a server's to a cell another server owns) shows
//     when the owner's stamped record echoes back — the same apply every other node sees.
//     Until then the proxy holds what the cluster holds, and the in-flight write is a
//     `pending` row of cluster.writes (V3-18) — delivery state never lives inside `data`.
//
// A refused write — the local validator, a relay's validator, the methods door — never
// shows: nothing to revert, nothing to bounce. v3's optimistic overlay (pending values
// layered over the fold, revert on refusal, foreign commits hidden under an in-flight
// cell) is DELETED, not ported.
//
// What survives of it is a settlement INDEX (#inflight: cell → the newest pending write on
// it), which the write-route join needs for one race: the kernel no longer holds our
// attempt (it was WACK'd) but its commit never surfaces on our apply stream because a
// foreign record out-stamped it (the cross-epoch LWW-loss race). A foreign apply on that
// cell is the probe — resolve from the dedup window's original coordinates, or reject
// 'superseded' — and the foreign record projects either way.
//
// The write-route join (env.ts Applied): every apply carries the attempt identity
// (iss, cid) when one exists. issue() PRE-creates pending entries under the cids the
// kernel will mint (writes.cid is sampled, mints are contiguous per record), so commits
// that land synchronously inside the write() call settle through the same join as
// commits that echo back seconds later off the owner.

import { proxy, applyRec, lens, holeAt, errText, isProxy, SPARSE_HOLE, type Fault } from './substrate.ts'
import { REC, type Applied, type Rec } from '../kernel/env.ts'
import { encodable, MAX_DEPTH, MAX_FRAME, type Limit } from '../kernel/codec.ts'
import type { Runtime } from '../shell/runtime.ts'

//! METHODS_ONLY — the terminal reason a protected server gives a client's plain write (V4-5): it rides
// the relay's WNACK as the validator's "reason" and so lands in the same outcome row and the same
// WriteRejectError as any refused write. Since DESIGN-DOOR §4 a client whose feeder's HELLO carried the
// methods-only hint gives the same reason LOCALLY in issue(), before the round trip. Defined here (the
// composer re-exports it) because issue() is the one place that speaks it on a client.
export const METHODS_ONLY = 'methods-only'

//! UNENCODABLE — the reason issue() gives a record a local write cannot send (V4-48; unsendable says why).
// Asked BEFORE the stamp: a value stamped first failed in every frame that carried it afterwards, and
// replication stopped for good.
export const UNENCODABLE = 'unencodable'

//! WRITE, ARG — what a local write's value, and a method call's argument, may be (kernel/codec.ts encodable).
// The wire carries 64 levels. The built-in reads wrap a stored value in up to four more — a live sub of the
// whole resource ships it inside SUBREC, its recs list, the record and the row; the scoped gather's claim is
// as deep — and a field write's value sits under its row: a value 61 deep was written, replicated, and then
// could not be read back. A CALL frame wraps its argument once. Both leave a MiB under the frame cap for the
// frame's header, the record's key and the envelopes.
export const WRITE: Limit = { depth: MAX_DEPTH - 4, bytes: MAX_FRAME - (1 << 20) }
export const ARG: Limit = { depth: MAX_DEPTH - 1, bytes: MAX_FRAME - (1 << 20) }

//! CARRIES — what fero sends, said once for every refusal of a value (the lens, a methods.* reject, the seed)
export const CARRIES = `fero sends null, undefined, true and false, numbers, strings, Uint8Array, and arrays and objects of these (an object sends its own fields), at most ${WRITE.depth} levels deep counted from the row and ${WRITE.bytes >> 20} MiB in all (a string counts 3 bytes a character)`

//! LIVE_VIEW — the reason for a live view written or passed as a value (`data.b = data.a`, the likely slip): read
// through its traps it sent an empty object for every leaf, to every copy and the writer's own, and the writer's
// copy went on aliasing the source (V4-48 review). Asked of the value itself, not of every part of it.
export const LIVE_VIEW = "a live view, not a value (use a plain copy, such as the resource's snapshot of it)"

//! unsendable — why a local write's record cannot travel every path fero reads it back on, or null (V4-48):
// the value from where it sits in its row (a field write starts one level down), its key and `at` counted
// into the bytes. A remove carries no value: only its key is counted.
export const unsendable = (r: Rec): string | null => {
  let n = r.at === undefined ? 0 : 4 + r.at.length * 3
  for (const k of r.key) n += 4 + k.length * 3
  if (r.type === REC.remove) return encodable(undefined, WRITE, 0, n)
  if (isProxy(r.value)) return LIVE_VIEW
  return encodable(r.value, WRITE, r.key.length > 1 ? r.key.length - 1 : 0, n)
}

//! reasonOf — a validation: rule's refusal as text. A rule answers `true` or the reason; any other answer (false,
// undefined, '', a Symbol) refuses, with its text as the reason. Passed on as it was, it broke the write path,
// which reads a non-string outcome as a commit's promise ("r.then is not a function"), and '' said nothing.
export const reasonOf = (v: unknown): string =>
  typeof v === 'string' && v !== '' ? v : v === '' ? 'the rule returned an empty reason' : `the rule returned ${errText(v)}`

//! SCOPED_FEEDER — does a server's HELLO contract (api/index.ts clusterContract: `v1;heartbeat.ms=…;
// replicas=N;…`) say it is scoped? `replicas=0` is full replication. Read by #local on a client.
const SCOPED_FEEDER = /(?:^|;)replicas=(?:[1-9]\d*)(?:;|$)/

//! cellOf — the version-key normalization, byte-identical to the kernel's (node.apply): a record's
// LWW cell is its key path, or [at] for a root insert.
export const cellOf = (r: Rec): string => JSON.stringify(r.key.length ? r.key : [r.at ?? ''])

//! ancestorKeys — the cell keys of a field path's proper prefixes, shallowest first, built the way the
// kernel's apply() builds them (the #fields index is keyed by them).
const ancestorKeys = (path: string[]): string[] => {
  const out: string[] = []
  let a = '[' + JSON.stringify(path[0])
  for (let d = 1; d < path.length; d++) { out.push(a + ']'); if (d < path.length - 1) a += ',' + JSON.stringify(path[d]) }
  return out
}

//! Coords — where a write committed (the WriteResolve core).
export interface Coords { origin: string; seq: number; epoch: number; cid?: number }

//! Issued — per-record outcome of one issue() call: a reason string (validation reject) or a promise
// of commit coordinates. Lens-path callers drop the promises (assignments have no await surface);
// methods.* awaits them.
export type Issued = (Promise<Coords> | string)[]

//! Refused — the rejection a validator-refused write leaves in a HANDLER's collector (V4-5): the Host's
// flush-on-return fails the call with it. `refused: true` is the discriminant against the kernel's
// string outcomes ('superseded' | 'dropped' | 'destroyed'), which reach settle as bare strings.
export interface Refused { refused: true; key: string; reason: string }

//! ASSIGNED — the coordinate promises of ASSIGNMENTS (the lens path) made inside a handler, with their
// record. issue() puts every write's promise in the handler's collector; an assignment has no await
// surface, so a kernel outcome on it ('dropped' | 'superseded' | 'destroyed', or an owner's refusal) is
// one the handler never saw — flush-on-return fails the call with it (api/methods.ts settle). A methods.*
// write is NOT here: its caller gets the typed reject and decides (a handler that catches it and
// recovers must not be overridden at flush — V4-5's double-report rule). Weak: an entry lives as long as
// the promise; one set per assignment inside a handler, nothing outside one.
const ASSIGNED = new WeakMap<Promise<Coords>, Rec>()
//! lostAssignment — the cell and outcome when `p` is an assignment the node did not commit, else null
export const lostAssignment = (p: Promise<Coords>, why: unknown): { key: string; outcome: string } | null => {
  const rec = ASSIGNED.get(p)
  return rec !== undefined && typeof why === 'string' ? { key: cellOf(rec), outcome: why } : null
}

//! Pending — one unsettled write: its cell, the cid the kernel minted (or will mint) for it, and the
// coordinate promise's settlers.
interface Pending {
  cell: string
  key: string // 'iss|cid' — the #pending key and the kernel's attempt key, built once
  above?: string[] // a FIELD cell's ancestor keys, shallowest first (depth ≥ 2) — the #fields entries it sits in
  cid: number
  resolve: (c: Coords) => void
  reject: (reason: string) => void
}

const NOOP = (): void => {}

//! WRITES_KEEP: the cluster.writes ring bound — the last N write outcomes, oldest evicted.
export const WRITES_KEEP = 64

//! Outcome: one row of cluster.writes — a write's route observed from THIS node (plan Q4, decided:
// pending rows are visible HERE, never marked inside `data` itself — observability is a cluster
// concern, the data surface stays pure value).
export interface Outcome {
  key: string
  state: 'pending' | 'committed' | 'rejected'
  origin?: string
  seq?: number
  epoch?: number
  cid?: number
  reason?: string
}

export class Bind {
  data: any
  #handle: any // the raw data v4 source handle beneath the lens
  #rt: Runtime
  #iss: string
  //! pending — 'iss|cid' → the unsettled write; inflight — cell → the NEWEST pending write on it (the
  // settlement index, see the banner: it decides promises, never what the proxy shows)
  #pending = new Map<string, Pending>()
  #inflight = new Map<string, Pending>()
  //! fields — ancestor key → our in-flight FIELD cells under it (V4-18), keyed by EVERY ancestor like the
  // kernel's deep index: a foreign apply at any depth finds exactly the cells of ours under its own
  // path in one lookup — a row write finds every field of ours in that row, a field write finds only
  // what is deeper than itself (nothing, usually). Keyed by row alone, every foreign field apply on a
  // row copied and scanned the row's whole set: about 8x per apply with 1k of ours in flight.
  //! `at` is the kernel's `released` count when the set was last walked (or made): while the count stands
  // still, every write in the set is still held by the kernel and the probe would settle none of them —
  // so a foreign row apply with 1k of ours in flight and none answered walks nothing (it walked all 1k,
  // about 30x the apply). After the kernel lets any attempt go, the next apply walks the set once.
  #fields = new Map<string, { cells: Set<string>; at: number }>()
  //! frames — a STACK of in-flight fast-path collectors, one per active issue() call (M5-review #0/#1/#4).
  // The epoch-0 fast path mints no kernel cid and applies synchronously inside rt.write(); a user tap
  // reacting to one of those applies drains a RE-ENTRANT issue() INSIDE the outer one (substrate
  // contract). A single-slot collector let the nested call null the outer's state mid-drain, orphaning
  // the outer promise (never resolved → flush-on-return hung) and mis-rejecting the outer's trailing
  // records as 'superseded'. A stack scopes each call's collection: node.commit applies records
  // sequentially, so while a nested frame is on top ONLY its records apply, and the outer frame is back
  // on top for its own remaining records. #onApply reads the TOP frame.
  #frames: { cells: Set<string>; applied: Applied[] }[] = []
  #destroyed = false
  get destroyed(): boolean { return this.#destroyed }
  //! outcomes — the bounded write-outcome ring (the cluster.writes source). A row is created when the
  // write is issued and settles in the SAME call that settles its promise — not a microtask later — and
  // every move (a new row, a settle, an eviction) calls onOutcome with the row's id: the composer
  // publishes the ring from one microtask per burst (api/index.ts), never from the post-step fold.
  outcomes = { rows: new Map<number, Outcome>() }
  #outSeq = 0
  #onOutcome?: (id: number) => void
  #outcome(row: Outcome): number {
    const id = ++this.#outSeq
    const rows = this.outcomes.rows
    rows.set(id, row)
    if (rows.size > WRITES_KEEP) {
      const old = rows.keys().next().value!
      rows.delete(old)
      this.#onOutcome?.(old)
    }
    this.#onOutcome?.(id)
    return id
  }

  constructor(rt: Runtime, opts: { validate?: (rec: Rec) => true | string; tracked?: () => Promise<Coords>[] | undefined; onOutcome?: (id: number) => void; onFault?: Fault } = {}) {
    this.#rt = rt
    this.#validate = opts.validate
    this.#tracked = opts.tracked
    this.#onOutcome = opts.onOutcome
    this.#fault = opts.onFault
    this.#iss = rt.node.uuid + '~' + rt.node.incarnation
    //! the two-layer surface (DESIGN-DATA3 §4.1): #handle is the data v4 source holding the
    // projection; data is FERO'S OWN LENS over it — assignment/delete trap straight into
    // issue() (validation, the join, owner routing) BEFORE data sees anything, so no capture
    // sink exists and the entire v3 echo family (#expected, verb-rewrite matching,
    // #healRoot) is deleted, not ported. A root replace throws PRE-COMMIT in the lens. The
    // lens asks #inflight before swallowing a delete as a no-op: a cell with one of our
    // writes in flight is absent from the fold but NOT absent — `data.k = v; delete data.k`
    // must issue the remove (substrate.ts deleteProperty/remove).
    this.#handle = proxy({})
    this.data = lens(this.#handle, [], (recs) => this.#fromLens(recs), (key) => this.#inflight.has(JSON.stringify(key)) || !this.#local(key[0]))
    rt.onApply = (a) => { if (!this.#destroyed) this.#onApply(a) }
    rt.onLost = (iss, cid, origin, seq, epoch) => { if (!this.#destroyed) this.#lost(iss, cid, origin, seq, epoch) }
    rt.onAcked = (iss, cid, origin, seq, epoch) => { if (!this.#destroyed) this.#lost(iss, cid, origin, seq, epoch) }
  }

  //! #local — does this node's fold speak for partition p? Unscoped: always (every row is here). Armed: only
  // for a partition it HOLDS. A CLIENT of a scoped feeder: never — its fold is the feeder's held shard (the
  // tap filters by the feeder's held set), and it cannot know which partitions those are; the feeder's HELLO
  // contract carries `replicas=N` (api/index.ts clusterContract, read live off the primary link). The lens
  // asks before swallowing a delete of an absent cell as a no-op: on a scoped member or spoke the row may
  // well exist, at its owner, and a delete there is a real remove to forward. (Until the `acked` effect, a
  // non-holder's own write stayed "in flight" for ever, which hid this; the stage-1 skeptic's A1 found the
  // client case: a client's delete of a row it had just written through a non-holder primary went nowhere.)
  // The rule fails TOWARD sending: with no contract known at all (a client before its first HELLO) the fold
  // is empty and says nothing about the server, so a delete is forwarded — at worst a tombstone for a row
  // that was never there, the cost `methods.remove` of an absent key pays today. In an outage the kernel
  // keeps the last primary's contract, so the judgment does not change while the links are down.
  #local(p: string): boolean {
    const n = this.#rt.node
    if (n.client) { const c = n.feederContract; return c !== undefined && !SCOPED_FEEDER.test(c) }
    return !n.armed || n.scope!.held(p)
  }

  //! #lost — the kernel refused a record carrying an attempt identity (V4-18, env.ts lost): it
  // committed at these coordinates and lost its election — to a newer stamp on its own cell, or on an
  // ancestor (our field write under a newer whole-row write). No apply will ever carry it, so the join
  // (#onApply step 1) never fires, and the settlement probe (step 3b) only runs when a LATER foreign
  // write lands on that row — which may be never: before this hook our write stayed `pending` for ever
  // when the newer row reached us before our WACK. The refused record IS our commit: settle committed,
  // on the owner's lane, from its own stamp (the same coordinates the WACK carried).
  //! The same settlement serves `acked` (env.ts, DESIGN-SCALE stage 1): the owner's WACK for a write whose
  // record will never fold here — this node does not hold the partition, or its feeder does not. The WACK's
  // coordinates are the commit's. Idempotent with the join and with each other: whichever lands first
  // settles, the rest find no pending entry.
  #lost(iss: string, cid: number, origin: string, seq: number, epoch: number) {
    if (iss !== this.#iss) return
    const p = this.#pending.get(iss + '|' + cid)
    if (p === undefined) return
    this.#forget(p)
    p.resolve({ origin, seq, epoch, cid })
  }

  #validate?: (rec: Rec) => true | string
  //! tracked — the flush-on-return attribution seam (M5c): when a method handler is executing, the
  // host exposes its per-invocation collector here (AsyncLocalStorage-backed); every coordinate
  // promise this ingest mints inside that async context is collected, and the handler's return awaits
  // them at 'committed' — plan §9's flush-on-return, BUILT.
  #tracked?: () => Promise<Coords>[] | undefined

  //! admit — the one admission rule for a record, here and at the relay: the embedder's validator, then
  // the sparse hole. A remove that names an array's own element is refused SPARSE_HOLE before it is
  // stamped: data would refuse it at apply, so it would commit a tombstone that shows nothing (V4-18's
  // array limit). The lens throws for a local delete first; this catches the spellings that skip the
  // lens (methods.remove({ key: ['g', 0] })) and, as the server's relay predicate, a client's relayed
  // remove (api/index.ts). Reads THIS node's projection: a node that does not hold the row cannot see
  // the array, so a scoped non-holder forwards it as before. One type compare for every other record.
  admit(rec: Rec): true | string {
    const v: unknown = this.#validate ? this.#validate(rec) : true
    if (v !== true) return reasonOf(v)
    return rec.type === REC.remove && rec.key.length > 1 && holeAt(this.#handle, rec.key) ? SPARSE_HOLE : true
  }

  //! hole — the sparse-hole half of admit alone, for the OWNER's re-check of a remove a scoped member
  // forwarded because it could not see the row (kernel NodeOpts.admit, DESIGN-SCALE §11 Q12). The issuer
  // ran the validator already; only the shape question is asked again, here, where the row is held.
  hole(rec: Rec): true | string {
    return rec.type === REC.remove && rec.key.length > 1 && holeAt(this.#handle, rec.key) ? SPARSE_HOLE : true
  }
  //! issue — THE one local ingest (assignment sugar, the lens's write builtins, methods.* and the
  // data: seed all land here; the validation: hook therefore covers every spelling by
  // construction — v2's OQ6). Admit, register the pending entries, hand the records to the kernel;
  // the proxy changes only when a commit applies (#onApply).
  issue(recs: Rec[]): Issued { return this.#issue(recs, false) }
  //! `checked` — the lens's own batch, which #fromLens has already asked (it throws instead, before anything
  // is issued): the one walk per value is not paid twice on the assignment path. Private, so no caller
  // outside skips the question.
  #issue(recs: Rec[], checked: boolean): Issued {
    const node = this.#rt.node
    const out: Issued = new Array(recs.length)
    //! the door, read ONCE per batch (DESIGN-DOOR §4): a CLIENT whose primary said methods-only (`m: 1`
    // in its HELLO) refuses every record of the batch here, before the validator runs — an outcome row
    // `rejected` with the door's reason, nothing shipped, no `pending` row: the same refusal the relay
    // would send back a round trip later (V4-5), so a program cannot tell the two apart except by time.
    // One boolean on servers (node.client), one property read on clients; nothing per record.
    if (node.client && node.feederMethodsOnly) {
      for (let i = 0; i < recs.length; i++) {
        out[i] = METHODS_ONLY
        this.#outcome({ key: cellOf(recs[i]), state: 'rejected', reason: METHODS_ONLY })
      }
      return out
    }
    const valid: Rec[] = []
    const t = this.#tracked?.()
    for (let i = 0; i < recs.length; i++) {
      //! a record that cannot be sent is refused before the user's rule sees it, and before any stamp
      const v = !checked && unsendable(recs[i]) !== null ? UNENCODABLE : this.admit(recs[i])
      if (v !== true) {
        //! refused: an outcome row with the reason, and nothing else — the record never touched the
        // proxy, so there is nothing to undo (a refused write is invisible, not bounced)
        out[i] = v
        this.#outcome({ key: cellOf(recs[i]), state: 'rejected', reason: v })
        continue
      }
      valid.push(recs[i])
    }
    if (valid.length === 0) return out
    //! pre-create the pending entries under the cids the kernel is ABOUT to mint (contiguous, one per
    // record, in order — kernel/write.ts issue) so a SYNCHRONOUS self-owned commit (epoch ≥ 1) settles
    // through the join (#onApply branch 1) DURING rt.write. `pend` holds our own object refs so the
    // fast-path settle resolves them LOCALLY even if a re-entrant issue clobbered the shared map key
    // (M5-review #0: the epoch-0 fast path re-uses the same predicted cid, so #pending keys collide).
    const c0 = node.writes.cid
    const promises = new Map<Rec, Promise<Coords>>()
    const pend: Pending[] = []
    for (let i = 0; i < valid.length; i++) {
      const rec = valid[i]
      const cid = c0 + 1 + i
      const cell = cellOf(rec)
      const row: Outcome = { key: cell, state: 'pending', cid }
      const id = this.#outcome(row)
      let entry!: Pending
      //! the ring row settles IN the settle call, before the promise's own reactions run: a solo write's
      // row reads `committed` in the tick its value applied. The first settle wins, as for the promise.
      const pr = new Promise<Coords>((resolve, reject) => {
        const key = this.#iss + '|' + cid
        entry = {
          cell, key, cid,
          ...(rec.key.length > 1 ? { above: ancestorKeys(rec.key) } : {}),
          resolve: (c) => {
            if (row.state === 'pending') { row.state = 'committed'; row.origin = c.origin; row.seq = c.seq; row.epoch = c.epoch; this.#onOutcome?.(id) }
            resolve(c)
          },
          reject: (e) => {
            if (row.state === 'pending') { row.state = 'rejected'; row.reason = String(e); this.#onOutcome?.(id) }
            reject(e)
          },
        }
        this.#pending.set(key, entry)
      })
      //! the ring row used to settle in a .then with both arms, which also marked the promise handled; keep
      // that: a caller that drops the promise (the data seed, a swallowed assignment) never surfaces a reject
      pr.catch(NOOP)
      promises.set(rec, pr)
      pend.push(entry)
      this.#inflight.set(cell, entry)
      if (entry.above !== undefined)
        for (const ak of entry.above) {
          let under = this.#fields.get(ak)
          if (under === undefined) this.#fields.set(ak, under = { cells: new Set(), at: node.writes.released })
          under.cells.add(cell)
        }
    }
    //! push THIS call's fast-path collector; a nested re-entrant issue pushes its own on top, and node.commit
    // applies sequentially so only the top frame's records apply while it is on top (M5-review #1/#4).
    const frame = { cells: new Set(valid.map(cellOf)), applied: [] as Applied[] }
    this.#frames.push(frame)
    try { this.#rt.write(valid) } finally { this.#frames.pop() }
    this.sweep() // enqueue overflow drops synchronously inside write() — release NOW, not at the next apply
    //! the epoch-0 fast path mints NO cids (kernel/write.ts): commits applied synchronously with no
    // attempt identity — settle positionally from OUR frame (single-threaded step: this frame collected
    // exactly our records, in record order), resolving OUR OWN promise refs (map keys may have been
    // clobbered by a re-entrant fast-path issue re-using the predicted cid), and clean up OUR entries
    // (guarded so a nested clobber never cross-deletes another call's entries).
    if (node.writes.cid === c0) {
      for (let i = 0; i < pend.length; i++) {
        const p = pend[i]
        this.#forget(p)
        const a = frame.applied[i]
        if (a) p.resolve({ origin: a.origin, seq: a.seq, epoch: a.epoch })
        else p.reject('not-applied') // an epoch-0 local commit always applies; defensive, never expected
      }
    }
    let vi = 0
    for (let i = 0; i < recs.length; i++) if (out[i] === undefined) out[i] = promises.get(valid[vi++])!
    if (t) for (const pr of promises.values()) t.push(pr)
    return out
  }

  //! forget — drop one pending entry from both maps, guarded by identity so a nested clobber (same
  // predicted cid, another call's entry under the same key/cell) is never cross-deleted.
  #forget(p: Pending) {
    if (this.#pending.get(p.key) === p) this.#pending.delete(p.key)
    if (this.#inflight.get(p.cell) === p) { this.#inflight.delete(p.cell); if (p.above !== undefined) this.#unfield(p.above, p.cell) }
  }

  //! #unfield — drop a field cell from the in-flight index under each of its ancestors (an emptied set leaves the map).
  #unfield(above: string[], cell: string) {
    for (const ak of above) {
      const under = this.#fields.get(ak)
      if (under !== undefined && under.cells.delete(cell) && under.cells.size === 0) this.#fields.delete(ak)
    }
  }

  //! onApply — every committed record materializing downstream (live, forwarded-echo, replay alike).
  // Routing: settle the write-route join first; then the settlement probe for foreign records; then the
  // ONE projection into the proxy — every apply projects, nothing is ever held back.
  #onApply(a: Applied) {
    //! 1) the join: an apply carrying an attempt identity we are waiting on IS our commit
    if (a.iss !== undefined) {
      const p = this.#pending.get(a.iss + '|' + a.cid)
      if (p) {
        this.#forget(p)
        p.resolve({ origin: a.origin, seq: a.seq, epoch: a.epoch, cid: a.cid })
        this.#apply(a)
        return
      }
    }
    const cell = cellOf(a)
    //! 2) fast-path settlement capture: an iss-less apply inside our own rt.write() is collected by the
    // TOP frame (the currently-executing issue()); node.commit is sequential, so the top frame is always
    // the call whose rt.write is on the stack when this record applies (M5-review #0/#1/#4).
    // A seq-0 apply is a projection repair the kernel made up under its own name (a resync's ghost remove,
    // V4-18's un-vivify after a field remove): never a commit of ours — project it, collect nothing.
    const top = this.#frames[this.#frames.length - 1]
    if (top && a.iss === undefined && top.cells.has(cell)) {
      if (a.seq !== 0) top.applied.push(a)
      this.#apply(a)
      return
    }
    //! 3) the settlement probe: a FOREIGN commit under a cell with one of our writes in flight. While the
    // kernel still holds the attempt nothing is decided (our commit will arrive through the join). If it
    // no longer holds it, our write either committed without ever surfacing here (the cross-epoch
    // LWW-loss race — resolve it from the dedup window's original coordinates) or is unaccounted for
    // (reject 'superseded'). The foreign record projects regardless — the proxy is the fold.
    //! Inside our own issue() (a frame on the stack) nothing that applies is a foreign commit: the kernel
    // commits only our records there, and makes its seq-0 repairs for them (V4-18's un-vivify after a
    // field remove of ours, whose cell — the row — is not in the batch). On the epoch-0 fast path the
    // kernel holds no attempt and the window has no coordinates, so a probe there would reject a write
    // that is committing in this very call as 'superseded'. Both probes wait for a foreign apply.
    if (top !== undefined) { this.#apply(a); return }
    this.#probe(cell)
    //! 3b) the same probe for our in-flight FIELD writes on the cells UNDER this one (V4-18, overlapping
    // cells): a whole-row write or a row remove is a parent of every field cell in the row, and a
    // field write of ours stamped at or below it is swept (or refused) in the kernel — its apply never
    // comes. The #fields index keys by ancestor, so one lookup finds exactly the cells of ours in
    // flight under THIS cell (a field apply finds only what is deeper than itself); with no field
    // write of ours in flight anywhere this is one size check. The set is walked only when the kernel
    // let an attempt go since its last walk (`at`, see #fields): a write the kernel still holds settles
    // through its own echo (the join, or #lost when the echo is refused), so the probe is for the ones
    // WACKed with no echo yet. #probe settles, which deletes from the set being walked — a Set
    // tolerates that, so nothing is copied.
    if (this.#fields.size > 0) {
      const under = this.#fields.get(cell)
      if (under !== undefined) {
        const released = this.#rt.node.writes.released
        if (under.at !== released) {
          under.at = released
          for (const c of under.cells) this.#probe(c)
        }
      }
    }
    //! 4) the ONE projection: kernel record → proxy
    this.#apply(a)
    this.sweep()
  }

  //! #probe — the settlement probe for one cell (step 3 above): settle our in-flight write there if
  // the kernel no longer holds its attempt — from the dedup window's coordinates, or 'superseded'.
  #probe(cell: string) {
    const holder = this.#inflight.get(cell)
    if (holder !== undefined && !this.#rt.node.writes.pending.has(holder.key)) {
      const p = this.#pending.get(holder.key)
      if (p) {
        this.#forget(p)
        const c = this.#rt.node.writes.committed(this.#iss, holder.cid)
        if (c) p.resolve({ origin: c.o ?? this.#rt.node.uuid, seq: c.s, epoch: c.e, cid: holder.cid })
        else p.reject('superseded')
      } else {
        this.#inflight.delete(cell)
        if (holder.above !== undefined) this.#unfield(holder.above, cell)
      }
    }
  }

  //! apply — project one record into the projection handle (the hot lane, fero's origin).
  // No echo arming: nothing subscribes that could re-issue (the lens routes user writes
  // BEFORE data; data-side sinks never write back). This runs inside the kernel's step — between a
  // record's commit and the rest of that step's work — so what the user's views and taps throw here
  // goes to `#fault` (the composer's printer), never up into the step (substrate.ts Fault).
  #fault?: Fault
  #apply(rec: Rec) {
    applyRec(this.#handle, rec, this.#fault)
  }

  //! shedPartition (M6): the kernel shed partition p — the data lawfully left this node without a
  // remove record existing anywhere. ONE synthesized subtree remove through the one projection;
  // downstream operators see an ordinary remove. Index entries under p drop with it (their pending
  // records now resolve at the partition's holders, via the apply-stream join as ever).
  shedPartition(p: string) {
    if (this.#destroyed) return
    this.#apply({ type: REC.remove, key: [p] })
    for (const cell of [...this.#inflight.keys()]) if ((JSON.parse(cell) as string[])[0] === p) this.#inflight.delete(cell)
    for (const ak of [...this.#fields.keys()]) if ((JSON.parse(ak) as string[])[0] === p) this.#fields.delete(ak)
  }

  //! fromLens — the lens's write sink: every assignment/delete lands here as Recs and rides THE one
  // ingest (issue → validation → kernel). Post-destroy, the surface survives as a plain local value
  // (the v3 pin, kept): writes apply to the local projection only, replicating nowhere.
  #fromLens(recs: Rec[]) {
    if (this.#destroyed) {
      for (const r of recs) this.#apply(r)
      return
    }
    //! a record that cannot be sent throws HERE, before anything of the batch is issued (V4-48) — like the
    // lens's root-replace and sparse-hole refusals: a programming error, loud at the assignment, all or nothing
    // for a patch() of several pairs. Nothing is stamped. The kernel keeps the caller's object, though: a value
    // changed after the write is not asked again (STATUS).
    for (const r of recs) {
      const why = unsendable(r)
      if (why !== null) throw new TypeError(`fero: ${JSON.stringify(r.key)} cannot be sent: ${why}\n  ${CARRIES}`)
    }
    //! assignments have no await surface — swallow the coordinate promises (their journal/outcome
    // effects are the observable outcome), but NEVER let a reject become an unhandledRejection
    const out = this.#issue(recs, true)
    const t = this.#tracked?.()
    for (let i = 0; i < out.length; i++) {
      const r = out[i]
      if (typeof r !== 'string') {
        (r as Promise<Coords>).catch(() => {})
        if (t) ASSIGNED.set(r as Promise<Coords>, recs[i]) // the same promise issue() put in the collector
        continue
      }
      //! a refused ASSIGNMENT inside a HANDLER is not allowed to be silent (V4-5): a reply that claims an
      // effect that never happened is §9's banned silent partial, and under `methods:` the handler is the
      // client's only door. The lens path has no await surface of its own, so the refusal is left in the
      // handler's collector as a Refused rejection — flush-on-return fails the call. methods.* callers
      // are NOT reported here: they get their own typed WriteReject and decide (a handler that catches
      // it and recovers must not be overridden at flush — the panel's double-report finding).
      if (t) {
        const p = Promise.reject({ refused: true, key: cellOf(recs[i]), reason: r } satisfies Refused) as Promise<Coords>
        p.catch(() => {})
        t.push(p)
      }
    }
  }

  //! sweep — the kernel-side settlement probe: the MAX_PENDING release (M5b, closes the M5a residual)
  // widened to TERMINAL REJECTS (2026-09-05). When the kernel drops the oldest attempt at overflow
  // (droppedPending grows) or a relay's validator refused one of ours (rejectedPending grows — the
  // WNACK `invalid` path, kernel/write.ts onNack), find our pending entries the kernel no longer
  // holds. A recorded REASON rejects with it — the client sees the server's validation: verbatim:
  // a plain assignment's outcome row reads it, methods.* rejects typed, exactly like a local reject
  // (and exactly as invisible: the value never showed). WACK'd-or-replicated ones have dedup-window
  // coordinates (onAck feeds it) — resolve them; the rest are genuinely dropped — reject 'dropped'.
  // Two integer compares when nothing moved; the composer's post-step fold calls it because a WNACK
  // step applies nothing — without that hop the promise would wait for an unrelated apply.
  #drops = 0
  #rejects = 0
  sweep() {
    const w = this.#rt.node.writes
    const drops = w.droppedPending !== this.#drops
    if (!drops && w.rejectedPending === this.#rejects) return
    this.#drops = w.droppedPending
    this.#rejects = w.rejectedPending
    for (const [key, p] of this.#pending) {
      if (w.pending.has(key)) continue
      const reason = w.rejected.get(key)
      if (reason !== undefined) {
        w.rejected.delete(key) // consumed: the reason has one reader
        this.#forget(p)
        p.reject(reason)
        continue
      }
      //! a reject settles ONLY the entries it names. An un-rejected entry the kernel no longer holds
      // is normally a WACK'd attempt whose commit is about to arrive through the apply join (one socket
      // chunk can carry a WACK and a WNACK in one step) — settling it here from the dedup window would
      // resolve it early and, on a spoke, under the wrong origin. Only a DROP may pre-empt the join.
      if (!drops) continue
      this.#forget(p)
      const c = w.committed(this.#iss, p.cid)
      if (c) p.resolve({ origin: c.o ?? this.#rt.node.uuid, seq: c.s, epoch: c.e, cid: p.cid })
      else p.reject('dropped')
    }
  }

  //! destroy — no applies in after this returns; the lens keeps working as a LOCAL value
  // (writes stop replicating — the v3 post-destroy pin, preserved in #fromLens).
  destroy() {
    this.#destroyed = true
    for (const [, p] of this.#pending) p.reject('destroyed')
    this.#pending.clear()
    this.#inflight.clear()
    this.#fields.clear()
  }
}
