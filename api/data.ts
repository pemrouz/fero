//! ── api/data — the $() binding: capture out, apply in, the cid-keyed overlay ──
// The two-surface model that makes v2's echo/re-entrancy flag family structurally
// unnecessary (plan §5 read-your-writes, plan §6 apply-as-output):
//
//   KERNEL STATE (node.state)  = the CONFIRMED fold. Only committed records ever
//                                touch it; it is "beneath" by construction.
//   THE PROXY (this.data)      = confirmed state + the PENDING OVERLAY: the
//                                user's issued-but-uncommitted writes stay
//                                visible on their cells (read-your-writes),
//                                layered over inbound foreign commits, and are
//                                released the moment their own commit applies.
//
// Because the confirmed fold lives in the kernel, the overlay needs NO value
// bookkeeping: an entry is just cell → pending cid. Release re-applies the
// committed record; revert (validation bounce / superseded resolution) re-reads
// node.state — the beneath is always derivable, never tracked.
//
// The write-route join (env.ts Applied): every apply carries the attempt
// identity (iss, cid) when one exists. issue() PRE-creates pending entries under
// the cids the kernel will mint (writes.cid is sampled, mints are contiguous per
// record), so commits that land synchronously inside the write() call settle
// through the same join as commits that echo back seconds later off the owner.
//
// Echo discipline (probed substrate facts — api/substrate.ts banner): applying a
// record fans back to our own capture sink synchronously, possibly VERB-REWRITTEN
// (update→insert), and user writes issued re-entrantly from taps drain INSIDE our
// apply call. So suppression is match-and-consume of exactly ONE expected echo
// (cell + value identity; removes match by type — their echo carries the old
// value), and everything else in the same drain is genuine local work.

import { proxy, applyRec, lens } from './substrate.ts'
import { REC, type Applied, type Rec } from '../kernel/env.ts'
import type { Runtime } from '../shell/runtime.ts'

//! cellOf — the version-key normalization, byte-identical to the kernel's (node.apply): a record's
// LWW cell is its key path, or [at] for a root insert.
export const cellOf = (r: Rec): string => JSON.stringify(r.key.length ? r.key : [r.at ?? ''])

//! Coords — where a write committed (the WriteResolve core).
export interface Coords { origin: string; seq: number; epoch: number; cid?: number }

//! Issued — per-record outcome of one issue() call: a reason string (validation reject) or a promise
// of commit coordinates. Capture-path callers drop the promises (assignments have no await surface);
// methods.* awaits them.
export type Issued = (Promise<Coords> | string)[]

//! Refused — the rejection a validator-refused write leaves in a HANDLER's collector (V4-5): the Host's
// flush-on-return fails the call with it. `refused: true` is the discriminant against the kernel's
// string outcomes ('superseded' | 'dropped' | 'destroyed'), which stay swallowed there.
export interface Refused { refused: true; key: string; reason: string }

interface Pending {
  cell: string
  cid: number
  resolve: (c: Coords) => void
  reject: (reason: string) => void
}

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
  //! pending — 'iss|cid' → the unsettled write; overlay — cell → the NEWEST pending cid holding it
  #pending = new Map<string, Pending>()
  #overlay = new Map<string, number>()
  //! frames — a STACK of in-flight fast-path collectors, one per active issue() call (M5-review #0/#1/#4).
  // The epoch-0 fast path mints no kernel cid and applies synchronously inside rt.write(); a user tap
  // reacting to one of those applies drains a RE-ENTRANT issue() INSIDE the outer one (substrate
  // contract). A single-slot #issuing/#fastApplied let the nested call null the outer's state mid-drain,
  // orphaning the outer promise (never resolved → flush-on-return hung) and mis-rejecting the outer's
  // trailing records as 'superseded'. A stack scopes each call's collection: node.commit applies
  // records sequentially, so while a nested frame is on top ONLY its records apply, and the outer frame
  // is back on top for its own remaining records. #onApply reads the TOP frame.
  #frames: { cells: Set<string>; applied: Applied[] }[] = []
  #destroyed = false
  //! outcomes — the bounded write-outcome ring (cluster.writes source). `n` is a version counter the
  // composer's fold compares (outcomes settle in microtasks — the NEXT step folds them, and writes
  // themselves cause steps, so the lag is one event, not unbounded).
  outcomes = { n: 0, rows: new Map<number, Outcome>() }
  #outSeq = 0
  #outcome(row: Outcome): Outcome {
    const id = ++this.#outSeq
    this.outcomes.rows.set(id, row)
    if (this.outcomes.rows.size > WRITES_KEEP) this.outcomes.rows.delete(this.outcomes.rows.keys().next().value!)
    this.outcomes.n++
    return row
  }

  constructor(rt: Runtime, opts: { validate?: (rec: Rec) => true | string; tracked?: () => Promise<Coords>[] | undefined } = {}) {
    this.#rt = rt
    this.#validate = opts.validate
    this.#tracked = opts.tracked
    this.#iss = rt.node.uuid + '~' + rt.node.incarnation
    //! the two-layer surface (DESIGN-DATA3 §4.1): #handle is the data v4 source holding the
    // projection; data is FERO'S OWN LENS over it — assignment/delete trap straight into
    // issue() (validation, overlay, owner routing) BEFORE data sees anything, so no capture
    // sink exists and the entire v3 echo family (#expected, verb-rewrite matching,
    // #healRoot) is deleted, not ported. A root replace throws PRE-COMMIT in the lens.
    this.#handle = proxy({})
    this.data = lens(this.#handle, [], (recs) => this.#fromLens(recs))
    rt.onApply = (a) => { if (!this.#destroyed) this.#onApply(a) }
  }

  #validate?: (rec: Rec) => true | string
  //! tracked — the flush-on-return attribution seam (M5c): when a method handler is executing, the
  // host exposes its per-invocation collector here (AsyncLocalStorage-backed); every coordinate
  // promise this ingest mints inside that async context is collected, and the handler's return awaits
  // them at 'committed' — plan §9's flush-on-return, BUILT.
  #tracked?: () => Promise<Coords>[] | undefined

  //! issue — THE one local ingest (assignment sugar and methods.* both land here; the seams.validation
  // hook therefore covers both by construction — v2's OQ6). `fromCapture` says the proxy already holds
  // the values (the user's own mutation); direct issues apply them optimistically so
  // methods.update(x) ≡ data.k = x observationally.
  issue(recs: Rec[], fromCapture: boolean): Issued {
    const node = this.#rt.node
    const out: Issued = new Array(recs.length)
    const valid: Rec[] = []
    const t = this.#tracked?.()
    for (let i = 0; i < recs.length; i++) {
      const v = this.#validate ? this.#validate(recs[i]) : true
      if (v !== true) {
        out[i] = v
        this.#outcome({ key: cellOf(recs[i]), state: 'rejected', reason: v })
        //! a rejected assignment BOUNCES: the cell reverts to the confirmed fold (the user sees the
        // write refused, not silently dropped — and never sees it replicate)
        if (fromCapture) this.#revert(cellOf(recs[i]))
        continue
      }
      valid.push(recs[i])
      if (!fromCapture) this.#optimistic(recs[i])
    }
    if (valid.length === 0) return out
    //! pre-create the pending entries under the cids the kernel is ABOUT to mint (contiguous, one per
    // record, in order — kernel/write.ts issue) so a SYNCHRONOUS self-owned commit (epoch ≥ 1) settles
    // through the join (#onApply branch 1) DURING rt.write. `pend` holds our own object refs so the
    // fast-path settle resolves them LOCALLY even if a re-entrant issue clobbered the shared map key
    // (M5-review #0: the epoch-0 fast path re-uses the same predicted cid, so #pending keys collide).
    const c0 = node.writes.cid
    const promises = new Map<Rec, Promise<Coords>>()
    const pend: { cell: string; cid: number; resolve: (c: Coords) => void; reject: (r: string) => void }[] = []
    for (let i = 0; i < valid.length; i++) {
      const rec = valid[i]
      const cid = c0 + 1 + i
      const cell = cellOf(rec)
      const row = this.#outcome({ key: cell, state: 'pending', cid })
      let entry!: { cell: string; cid: number; resolve: (c: Coords) => void; reject: (r: string) => void }
      const pr = new Promise<Coords>((resolve, reject) => {
        entry = { cell, cid, resolve, reject }
        this.#pending.set(this.#iss + '|' + cid, entry)
      })
      //! the ring row settles with its promise (microtask — the version bump makes the next fold see it)
      pr.then(
        (c) => { row.state = 'committed'; row.origin = c.origin; row.seq = c.seq; row.epoch = c.epoch; this.outcomes.n++ },
        (e) => { row.state = 'rejected'; row.reason = String(e); this.outcomes.n++ },
      )
      promises.set(rec, pr)
      pend.push(entry)
      this.#overlay.set(cell, cid)
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
    // (guarded so a nested clobber never cross-deletes another call's pending/overlay).
    if (node.writes.cid === c0) {
      const key = (cid: number) => this.#iss + '|' + cid
      for (let i = 0; i < pend.length; i++) {
        const p = pend[i]
        if (this.#pending.get(key(p.cid)) === p) this.#pending.delete(key(p.cid))
        if (this.#overlay.get(p.cell) === p.cid) this.#overlay.delete(p.cell)
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

  //! onApply — every committed record materializing downstream (live, forwarded-echo, replay alike).
  // Routing: settle the write-route join first; then the overlay policy for foreign records; then the
  // ONE projection into the proxy.
  #onApply(a: Applied) {
    //! 1) the join: an apply carrying an attempt identity we are waiting on IS our commit
    if (a.iss !== undefined) {
      const p = this.#pending.get(a.iss + '|' + a.cid)
      if (p) {
        this.#pending.delete(a.iss + '|' + a.cid)
        if (this.#overlay.get(p.cell) === a.cid) this.#overlay.delete(p.cell)
        p.resolve({ origin: a.origin, seq: a.seq, epoch: a.epoch, cid: a.cid })
        this.#apply(a)
        return
      }
    }
    const cell = cellOf(a)
    //! 2) fast-path settlement capture: an iss-less apply inside our own rt.write() is collected by the
    // TOP frame (the currently-executing issue()); node.commit is sequential, so the top frame is always
    // the call whose rt.write is on the stack when this record applies (M5-review #0/#1/#4).
    const top = this.#frames[this.#frames.length - 1]
    if (top && a.iss === undefined && top.cells.has(cell)) {
      top.applied.push(a)
      this.#apply(a)
      return
    }
    //! 3) the overlay policy: a FOREIGN commit under a cell our pending write holds. While our attempt
    // is still live in the kernel, the pending value stays on top (read-your-writes — our commit will
    // out-stamp this one at the owner). If the kernel no longer holds the attempt, our write either
    // committed without ever surfacing through the join (the cross-epoch LWW-loss race — resolve it
    // from the dedup window's original coordinates) or is unaccounted for (reject) — either way the
    // overlay releases and the confirmed world shows through.
    const holder = this.#overlay.get(cell)
    if (holder !== undefined) {
      const key = this.#iss + '|' + holder
      if (this.#rt.node.writes.pending.has(key)) return // held: ours is still in flight
      const p = this.#pending.get(key)
      if (p) {
        this.#pending.delete(key)
        const c = this.#rt.node.writes.committed(this.#iss, holder)
        if (c) p.resolve({ origin: this.#rt.node.uuid, seq: c.s, epoch: c.e, cid: holder })
        else p.reject('superseded')
      }
      this.#overlay.delete(cell)
    }
    //! 4) the ONE projection: kernel record → proxy, with the echo pre-consumed
    this.#apply(a)
    this.sweep()
  }

  //! apply — project one record into the projection handle (the hot lane, fero's origin).
  // No echo arming: nothing subscribes that could re-issue (the lens routes user writes
  // BEFORE data; data-side sinks never write back).
  #apply(rec: Rec) {
    applyRec(this.#handle, rec)
  }

  //! optimistic — a direct issue (methods.*) makes its value visible immediately, exactly like an
  // assignment already is: the pending layer of the overlay, not a commit claim.
  #optimistic(rec: Rec) { this.#apply(rec) }

  //! shedPartition (M6): the kernel shed partition p — the data lawfully left this node without a
  // remove record existing anywhere. ONE synthesized subtree remove through the one projection, echo
  // pre-consumed (the capture arm swallows the fan-back, so nothing re-issues cluster-wide);
  // downstream operators see an ordinary remove. Overlay cells under p drop with it (their pending
  // records now resolve at the partition's holders, via the apply-stream join as ever).
  shedPartition(p: string) {
    if (this.#destroyed) return
    this.#apply({ type: REC.remove, key: [p] })
    for (const cell of [...this.#overlay.keys()]) if ((JSON.parse(cell) as string[])[0] === p) this.#overlay.delete(cell)
  }

  //! revert — re-project a cell from the CONFIRMED fold (kernel state): the beneath is derivable,
  // never tracked (see the banner).
  #revert(cell: string) {
    const key = JSON.parse(cell) as string[]
    const node = this.#rt.node
    if (node.state.has(cell)) this.#apply({ type: REC.update, key, value: node.state.get(cell) })
    else this.#apply({ type: REC.remove, key })
  }

  //! fromLens — the lens's write sink: every assignment/delete lands here as Recs and rides
  // THE one ingest (issue → validation → optimistic apply → kernel). fromCapture=false:
  // unlike v3's capture (where the user's mutation had already hit the proxy), the lens
  // routes BEFORE data — a validation reject never becomes visible, no bounce-revert needed.
  // Post-destroy, the surface survives as a plain local value (the v3 pin, kept): writes
  // apply to the local projection only, replicating nowhere.
  #fromLens(recs: Rec[]) {
    if (this.#destroyed) {
      for (const r of recs) this.#apply(r)
      return
    }
    //! assignments have no await surface — swallow the coordinate promises (their overlay/journal
    // effects are the observable outcome), but NEVER let a reject become an unhandledRejection
    const out = this.issue(recs, false)
    const t = this.#tracked?.()
    for (let i = 0; i < out.length; i++) {
      const r = out[i]
      if (typeof r !== 'string') { (r as Promise<Coords>).catch(() => {}); continue }
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
  // a plain assignment bounces, methods.* rejects typed, exactly like a local reject. WACK'd-or-
  // replicated ones have dedup-window coordinates (onAck feeds it) — resolve them; the rest are
  // genuinely dropped — reject 'dropped'. Either way the overlay releases and the confirmed fold shows
  // through (the bounce is visible, never silent: counted kernel-side, rejected api-side). Two integer
  // compares when nothing moved; the composer's post-step fold calls it because a WNACK step applies
  // nothing — without that hop the promise would wait for an unrelated apply.
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
        this.#pending.delete(key)
        w.rejected.delete(key) // consumed: the reason has one reader
        p.reject(reason)
        if (this.#overlay.get(p.cell) === p.cid) { this.#overlay.delete(p.cell); this.#revert(p.cell) }
        continue
      }
      //! a reject settles ONLY the entries it names. An un-rejected entry the kernel no longer holds
      // is normally a WACK'd attempt whose commit is about to arrive through the apply join (one socket
      // chunk can carry a WACK and a WNACK in one step) — settling it here from the dedup window would
      // resolve it early and, on a spoke, under the wrong origin. Only a DROP may pre-empt the join.
      if (!drops) continue
      this.#pending.delete(key)
      const c = w.committed(this.#iss, p.cid)
      if (c) p.resolve({ origin: this.#rt.node.uuid, seq: c.s, epoch: c.e, cid: p.cid })
      else {
        p.reject('dropped')
        if (this.#overlay.get(p.cell) === p.cid) { this.#overlay.delete(p.cell); this.#revert(p.cell) }
      }
      if (this.#overlay.get(p.cell) === p.cid && c) this.#overlay.delete(p.cell)
    }
  }

  //! destroy — no applies in after this returns; the lens keeps working as a LOCAL value
  // (writes stop replicating — the v3 post-destroy pin, preserved in #fromLens).
  destroy() {
    this.#destroyed = true
    for (const [, p] of this.#pending) p.reject('destroyed')
    this.#pending.clear()
    this.#overlay.clear()
  }
}
