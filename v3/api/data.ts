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

import { proxy, applyRec, capture, type Capture } from './substrate.ts'
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
  #rt: Runtime
  #cap: Capture
  #iss: string
  //! pending — 'iss|cid' → the unsettled write; overlay — cell → the NEWEST pending cid holding it
  #pending = new Map<string, Pending>()
  #overlay = new Map<string, number>()
  //! expected — the one echo the in-flight applyRec call may fan back (consume-once)
  #expected: { cell: string; ref: unknown; remove: boolean } | null = null
  //! issuing — cells of the batch currently inside rt.write(): their synchronous applies must never
  // be held by their own overlay marks (fast-path commits carry no iss to join on)
  #issuing: Set<string> | null = null
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
    this.data = proxy({})
    rt.onApply = (a) => { if (!this.#destroyed) this.#onApply(a) }
    this.#cap = capture(this.data, (recs) => this.#captured(recs))
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
    // record, in order — kernel/write.ts issue) so synchronous commits settle through the same join
    const c0 = node.writes.cid
    const promises = new Map<Rec, Promise<Coords>>()
    const settledFast: Applied[] = []
    for (let i = 0; i < valid.length; i++) {
      const rec = valid[i]
      const cid = c0 + 1 + i
      const cell = cellOf(rec)
      const row = this.#outcome({ key: cell, state: 'pending', cid })
      const pr = new Promise<Coords>((resolve, reject) => {
        this.#pending.set(this.#iss + '|' + cid, { cell, cid, resolve, reject })
      })
      //! the ring row settles with its promise (microtask — the version bump makes the next fold see it)
      pr.then(
        (c) => { row.state = 'committed'; row.origin = c.origin; row.seq = c.seq; row.epoch = c.epoch; this.outcomes.n++ },
        (e) => { row.state = 'rejected'; row.reason = String(e); this.outcomes.n++ },
      )
      promises.set(rec, pr)
      this.#overlay.set(cell, cid)
    }
    this.#issuing = new Set([...promises.keys()].map(cellOf))
    const fast = settledFast
    this.#fastApplied = fast
    try { this.#rt.write(valid) } finally { this.#issuing = null; this.#fastApplied = null }
    this.#sweepDrops() // enqueue overflow drops synchronously inside write() — release NOW, not at the next apply
    //! the epoch-0 fast path mints NO cids (kernel/write.ts): commits applied synchronously with no
    // attempt identity — settle positionally (single-threaded step: every iss-less apply inside our
    // own write() call is ours, in record order) and clear the predicted entries
    if (node.writes.cid === c0) {
      let pos = 0
      for (let i = 0; i < valid.length; i++) {
        const key = this.#iss + '|' + (c0 + 1 + i)
        const p = this.#pending.get(key)
        if (!p) continue // already settled (should not happen on the fast path, but never hang)
        this.#pending.delete(key)
        if (this.#overlay.get(p.cell) === p.cid) this.#overlay.delete(p.cell)
        const a = fast[pos++]
        if (a) p.resolve({ origin: a.origin, seq: a.seq, epoch: a.epoch })
        else p.reject('not-applied') // an epoch-0 local commit always applies; defensive, never expected
      }
    }
    let vi = 0
    for (let i = 0; i < recs.length; i++) if (out[i] === undefined) out[i] = promises.get(valid[vi++])!
    const t = this.#tracked?.()
    if (t) for (const pr of promises.values()) t.push(pr)
    return out
  }
  #fastApplied: Applied[] | null = null

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
    //! 2) fast-path settlement capture: iss-less applies inside our own write() call are ours in order
    if (this.#fastApplied && a.iss === undefined && this.#issuing?.has(cell)) {
      this.#fastApplied.push(a)
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
    this.#sweepDrops()
  }

  //! apply — project one record into the proxy, arming the expected-echo consume for the synchronous
  // fan-back. Ref-equal updates are filtered by the substrate (no echo — the arm just expires).
  #apply(rec: Rec) {
    this.#expected = { cell: cellOf(rec), ref: rec.value, remove: rec.type === REC.remove }
    try { applyRec(this.data, rec) } finally { this.#expected = null }
  }

  //! optimistic — a direct issue (methods.*) makes its value visible immediately, exactly like an
  // assignment already is: the pending layer of the overlay, not a commit claim.
  #optimistic(rec: Rec) { this.#apply(rec) }

  //! revert — re-project a cell from the CONFIRMED fold (kernel state): the beneath is derivable,
  // never tracked (see the banner).
  #revert(cell: string) {
    const key = JSON.parse(cell) as string[]
    const node = this.#rt.node
    if (node.state.has(cell)) this.#apply({ type: REC.update, key, value: node.state.get(cell) })
    else this.#apply({ type: REC.remove, key })
  }

  //! captured — the write-capture sink: consume the one expected echo of an in-flight apply; issue
  // everything else as local writes. (A re-entrant user write drained inside our apply call arrives
  // here as its own batch and falls through to issue() — the probed substrate contract.)
  #captured(recs: Rec[]) {
    if (this.#destroyed) return
    const e = this.#expected
    if (e && recs.length === 1) {
      const r = recs[0]
      if (cellOf(r) === e.cell && (e.remove ? r.type === REC.remove : r.value === e.ref)) {
        this.#expected = null
        return
      }
    }
    //! assignments have no await surface — swallow the coordinate promises (their overlay/journal
    // effects are the observable outcome), but NEVER let a reject become an unhandledRejection
    for (const r of this.issue(recs, true)) if (typeof r !== 'string') (r as Promise<Coords>).catch(() => {})
  }

  //! sweepDrops — the MAX_PENDING release (M5b, closes the M5a residual): when the kernel drops the
  // oldest attempt at overflow (droppedPending grows), find our pending entries the kernel no longer
  // holds. WACK'd-or-replicated ones have dedup-window coordinates (onAck feeds it) — resolve them;
  // the rest are genuinely dropped — reject, release the overlay, and let the confirmed fold show
  // through (the bounce is visible, never silent: counted kernel-side, rejected api-side).
  #drops = 0
  #sweepDrops() {
    const w = this.#rt.node.writes
    if (w.droppedPending === this.#drops) return
    this.#drops = w.droppedPending
    for (const [key, p] of this.#pending) {
      if (w.pending.has(key)) continue
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

  //! destroy — synchronous detach (substrate contract): no capture after this returns, no applies in.
  destroy() {
    this.#destroyed = true
    this.#cap.detach()
    for (const [, p] of this.#pending) p.reject('destroyed')
    this.#pending.clear()
    this.#overlay.clear()
  }
}
