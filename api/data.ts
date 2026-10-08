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
// What survives of it is a settlement INDEX (#inflight: cell → the newest pending cid on
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

import { proxy, applyRec, lens } from './substrate.ts'
import { REC, type Applied, type Rec } from '../kernel/env.ts'
import type { Runtime } from '../shell/runtime.ts'

//! cellOf — the version-key normalization, byte-identical to the kernel's (node.apply): a record's
// LWW cell is its key path, or [at] for a root insert.
export const cellOf = (r: Rec): string => JSON.stringify(r.key.length ? r.key : [r.at ?? ''])

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
  row?: string // the row key when the cell is a FIELD (depth ≥ 2) — the #fields index entry it sits in
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
  //! pending — 'iss|cid' → the unsettled write; inflight — cell → the NEWEST pending cid on it (the
  // settlement index, see the banner: it decides promises, never what the proxy shows)
  #pending = new Map<string, Pending>()
  #inflight = new Map<string, number>()
  //! fields — row key → our in-flight FIELD cells under it (V4-18): a foreign row apply probes exactly
  // these, so the probe costs nothing when no field write of ours is in flight on that row
  #fields = new Map<string, Set<string>>()
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

  constructor(rt: Runtime, opts: { validate?: (rec: Rec) => true | string; tracked?: () => Promise<Coords>[] | undefined; onOutcome?: (id: number) => void } = {}) {
    this.#rt = rt
    this.#validate = opts.validate
    this.#tracked = opts.tracked
    this.#onOutcome = opts.onOutcome
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
    this.data = lens(this.#handle, [], (recs) => this.#fromLens(recs), (key) => this.#inflight.has(JSON.stringify(key)))
    rt.onApply = (a) => { if (!this.#destroyed) this.#onApply(a) }
  }

  #validate?: (rec: Rec) => true | string
  //! tracked — the flush-on-return attribution seam (M5c): when a method handler is executing, the
  // host exposes its per-invocation collector here (AsyncLocalStorage-backed); every coordinate
  // promise this ingest mints inside that async context is collected, and the handler's return awaits
  // them at 'committed' — plan §9's flush-on-return, BUILT.
  #tracked?: () => Promise<Coords>[] | undefined

  //! issue — THE one local ingest (assignment sugar, the lens's write builtins, methods.* and the
  // data: seed all land here; the seams.validation hook therefore covers every spelling by
  // construction — v2's OQ6). Validate, register the pending entries, hand the records to the kernel;
  // the proxy changes only when a commit applies (#onApply).
  issue(recs: Rec[]): Issued {
    const node = this.#rt.node
    const out: Issued = new Array(recs.length)
    const valid: Rec[] = []
    const t = this.#tracked?.()
    for (let i = 0; i < recs.length; i++) {
      const v = this.#validate ? this.#validate(recs[i]) : true
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
        entry = {
          cell, cid,
          ...(rec.key.length > 1 ? { row: JSON.stringify([rec.key[0]]) } : {}),
          resolve: (c) => {
            if (row.state === 'pending') { row.state = 'committed'; row.origin = c.origin; row.seq = c.seq; row.epoch = c.epoch; this.#onOutcome?.(id) }
            resolve(c)
          },
          reject: (e) => {
            if (row.state === 'pending') { row.state = 'rejected'; row.reason = String(e); this.#onOutcome?.(id) }
            reject(e)
          },
        }
        this.#pending.set(this.#iss + '|' + cid, entry)
      })
      //! the ring row used to settle in a .then with both arms, which also marked the promise handled; keep
      // that: a caller that drops the promise (the data seed, a swallowed assignment) never surfaces a reject
      pr.catch(NOOP)
      promises.set(rec, pr)
      pend.push(entry)
      this.#inflight.set(cell, cid)
      if (entry.row !== undefined) {
        let under = this.#fields.get(entry.row)
        if (under === undefined) this.#fields.set(entry.row, under = new Set())
        under.add(cell)
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
    const key = this.#iss + '|' + p.cid
    if (this.#pending.get(key) === p) this.#pending.delete(key)
    if (this.#inflight.get(p.cell) === p.cid) { this.#inflight.delete(p.cell); if (p.row !== undefined) this.#unfield(p.row, p.cell) }
  }

  //! #unfield — drop a field cell from the per-row in-flight index (an emptied row leaves the map).
  #unfield(row: string, cell: string) {
    const under = this.#fields.get(row)
    if (under !== undefined && under.delete(cell) && under.size === 0) this.#fields.delete(row)
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
    this.#probe(cell)
    //! 3b) the same probe for our in-flight FIELD writes on the cells UNDER this one (V4-18, overlapping
    // cells): a whole-row write or a row remove is a parent of every field cell in the row, and a
    // field write of ours stamped at or below it is swept (or refused) in the kernel — its apply never
    // comes. The #fields index keys by row, so only the cells of ours in flight under THIS row are
    // looked at; with no field write of ours in flight anywhere this is one size check.
    if (this.#fields.size > 0) {
      const under = this.#fields.get(a.key.length > 1 ? JSON.stringify([a.key[0]]) : cell)
      if (under !== undefined) {
        const pfx = a.key.length > 1 ? cell.slice(0, -1) + ',' : null
        for (const c of [...under]) if (pfx === null || c.startsWith(pfx)) this.#probe(c) // #probe settles, which edits `under`
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
    if (holder !== undefined && !this.#rt.node.writes.pending.has(this.#iss + '|' + holder)) {
      const p = this.#pending.get(this.#iss + '|' + holder)
      if (p) {
        this.#forget(p)
        const c = this.#rt.node.writes.committed(this.#iss, holder)
        if (c) p.resolve({ origin: c.o ?? this.#rt.node.uuid, seq: c.s, epoch: c.e, cid: holder })
        else p.reject('superseded')
      } else {
        this.#inflight.delete(cell)
        const path = JSON.parse(cell) as string[]
        if (path.length > 1) this.#unfield(JSON.stringify([path[0]]), cell)
      }
    }
  }

  //! apply — project one record into the projection handle (the hot lane, fero's origin).
  // No echo arming: nothing subscribes that could re-issue (the lens routes user writes
  // BEFORE data; data-side sinks never write back).
  #apply(rec: Rec) {
    applyRec(this.#handle, rec)
  }

  //! shedPartition (M6): the kernel shed partition p — the data lawfully left this node without a
  // remove record existing anywhere. ONE synthesized subtree remove through the one projection;
  // downstream operators see an ordinary remove. Index entries under p drop with it (their pending
  // records now resolve at the partition's holders, via the apply-stream join as ever).
  shedPartition(p: string) {
    if (this.#destroyed) return
    this.#apply({ type: REC.remove, key: [p] })
    for (const cell of [...this.#inflight.keys()]) if ((JSON.parse(cell) as string[])[0] === p) this.#inflight.delete(cell)
    this.#fields.delete(JSON.stringify([p]))
  }

  //! fromLens — the lens's write sink: every assignment/delete lands here as Recs and rides THE one
  // ingest (issue → validation → kernel). Post-destroy, the surface survives as a plain local value
  // (the v3 pin, kept): writes apply to the local projection only, replicating nowhere.
  #fromLens(recs: Rec[]) {
    if (this.#destroyed) {
      for (const r of recs) this.#apply(r)
      return
    }
    //! assignments have no await surface — swallow the coordinate promises (their journal/outcome
    // effects are the observable outcome), but NEVER let a reject become an unhandledRejection
    const out = this.issue(recs)
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
  // holds. A recorded REASON rejects with it — the client sees the server's seams.validation verbatim:
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
