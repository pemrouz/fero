//! ── api/fold — the distributed gather: whole-resource read() under scoping ────
// M6 slice 4 (DESIGN-M6 C5, carrying v2's Q3 decision). Under scoping no node
// holds the whole resource; `read()` (no key) becomes an ACTUAL gather — the
// O(N) download is visible in the code, exactly the v2 framing. The mechanism
// is per-key STAMPED CLAIMS with PARKING, which is where the v2 Q3a bug class
// dies by construction:
//
//   partial   — each member answers the system `rows` call with stamped claims
//               over its held ∪ unshed-orphan scope: {cell: {v, st, t?}}. An
//               orphan KEEPS CLAIMING until its shed proves the new holders
//               cover it (descope is silent — no retraction exists to race).
//   merge     — the coordinator folds per-key by the SAME lexicographic
//               (epoch, seq, origin) order the kernel's LWW election uses; a
//               dominating tombstone claim removes the key. Idempotent under
//               R-fold double-claim (two holders claiming a key land it once).
//   parking   — a key whose claimant set EMPTIES without a dominating
//               tombstone is PARKED: the last value stands. This is the Q3a
//               fix: v2's root-replace union transiently LOST a key when the
//               old owner's partial re-scoped before the new owner's arrived
//               (zero-claim). Here zero-claim is unrepresentable — a key
//               leaves the union only via a tombstone or the coverage sweep.
//   coverage  — a parked key drops once every CURRENT holder of its partition
//               answered in this generation and none claims it: absence
//               attested by the full holder set is a real (possibly
//               tombstone-GC'd) delete, not a handover window.
//
// The LIVE variant re-gathers on every view install and on a paced tick while
// subscribed (the api is the impure host — timers live here, never in the
// kernel); the registry carries claims ACROSS refreshes, so a mid-handover
// refresh can only add or lawfully-remove keys, never blink one. A push-based
// per-member claim stream is a wire optimization, tracked in IDEAS.

import { proxy, snapshot, applyStreamRec } from './substrate.ts'
import type { Runtime } from '../shell/runtime.ts'
import type { ScopedError } from './types.ts'

//! one member's claim for one cell: the value, its LWW stamp, tombstone flag.
export interface Claim { v?: unknown; st: [number, number, string]; t?: number }
export type Claims = Record<string, Claim>

//! rowsPartial — the member-side answer (the system `rows` handler): stamped claims over this node's
// held ∪ orphan scope. Tombstones ride from the versions map (a removed cell's stamp without a live
// value); acquiring partitions contribute nothing (their base is not yet this node's to attest).
export const rowsPartial = (rt: Runtime): Claims => {
  const node = rt.node
  const out: Claims = {}
  const scope = node.scope
  const mine = (cell: string): boolean => {
    if (!node.armed || !scope) return true // unscoped: the whole fold is local truth
    const p = (JSON.parse(cell) as string[])[0] ?? ''
    const e = scope.entries.get(p)
    return e !== undefined && e.state !== 2 // held (1) and orphan (3) claim; acquiring (2) does not
  }
  for (const [cell, st] of node.versions) {
    if (!mine(cell)) continue
    if (node.state.has(cell)) out[cell] = { v: node.state.get(cell), st: [st.epoch, st.seq, st.origin] }
    else out[cell] = { st: [st.epoch, st.seq, st.origin], t: 1 }
  }
  return out
}

//! newer — the kernel's LWW total order (epoch, seq, origin), verbatim.
const newer = (a: [number, number, string], b: [number, number, string]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

//! Gather — the coordinator: a claims registry + a result proxy. One instance per node (memoized by
// the composer — v2's M3 leak); one-shot and live consumption share the registry and the refresh.
export class Gather {
  #rt: Runtime
  #call: (uuid: string, timeoutMs: number) => Promise<Claims>
  //! cell → member uuid → claim (the registry: claims survive across refreshes — parking's substrate)
  #registry = new Map<string, Map<string, Claim>>()
  proxy: any = proxy({})
  #timer: ReturnType<typeof setInterval> | null = null
  #gen = 0

  constructor(rt: Runtime, call: (uuid: string, timeoutMs: number) => Promise<Claims>) {
    this.#rt = rt
    this.#call = call
  }

  //! refresh — one gather generation: fan out to every view member (self in-process), replace each
  // answerer's claim set wholesale, then fold. An unreachable member fails the ONE-SHOT caller typed
  // (never a silent partial — plan §5/§9); the LIVE path keeps the last-good claims (parking) and
  // retries on its cadence, which is the availability-honest reading of the same rule.
  async refresh(rt: Runtime, opts: { throwOnPartial: boolean; timeoutMs?: number }): Promise<unknown> {
    const node = this.#rt.node
    const gen = ++this.#gen
    const members = node.membership.view.members.map((m) => m[0])
    const mine = rowsPartial(this.#rt)
    const answered = new Map<string, Claims>([[node.uuid, mine]])
    const missing: string[] = []
    await Promise.all(members.filter((u) => u !== node.uuid).map(async (u) => {
      try { answered.set(u, await this.#call(u, opts.timeoutMs ?? 8000)) }
      catch { missing.push(u) }
    }))
    if (missing.length && opts.throwOnPartial)
      throw {
        scoped: true, op: 'gather', reason: 'unreachable', replicas: node.replicas, missing,
        hint: 'some members are unreachable — the whole-resource read would be a silent partial; retry when the view heals',
      } satisfies ScopedError
    if (gen !== this.#gen) return snapshot(this.proxy) // a newer refresh superseded this one mid-flight
    //! merge: replace each answerer's claims wholesale, keep everyone else's (parking substrate)
    const touched = new Set<string>([...this.#registry.keys()])
    for (const [uuid, claims] of answered) {
      for (const cell of Object.keys(claims)) touched.add(cell)
      for (const [cell, per] of this.#registry) { per.delete(uuid); if (!per.size) void cell } // wholesale replace below
      for (const [cell, claim] of Object.entries(claims)) {
        let per = this.#registry.get(cell)
        if (!per) { per = new Map(); this.#registry.set(cell, per) }
        per.set(uuid, claim)
      }
    }
    //! fold + project the delta into the result proxy
    const ring = node.writes.ring
    if (node.epoch > 0 && ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    for (const cell of touched) {
      const per = this.#registry.get(cell)
      const key = JSON.parse(cell) as string[]
      let win: Claim | null = null
      if (per) for (const c of per.values()) if (win === null || newer(c.st, win.st)) win = c
      if (win === null || win.t === 1) {
        //! zero-claim or tombstone: a tombstone is a real delete; zero-claim drops ONLY when every
        // current holder answered this generation and none claims it (the coverage sweep) — else the
        // key PARKS: the last projected value stands until the handover settles (the Q3a fix)
        const p = key[0] ?? ''
        const holders = node.armed ? ring.holders(p, node.replicas) : node.membership.view.members.map((m) => m[0])
        const covered = win?.t === 1 || holders.every((h) => answered.has(h))
        if (covered) {
          if (per) this.#registry.delete(cell)
          applyCell(this.proxy, key, undefined, true)
        }
        continue
      }
      applyCell(this.proxy, key, win.v, false)
    }
    return snapshot(this.proxy)
  }

  //! live — arm the paced re-gather (the composer also refreshes on every view install). Idempotent.
  live(intervalMs: number) {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.refresh(this.#rt, { throwOnPartial: false }).catch(() => {}) }, intervalMs)
    this.#timer.unref?.()
  }

  destroy() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
    this.#gen++
  }
}

//! applyCell — project one folded cell into the result proxy through the ONE substrate seam.
const applyCell = (p: any, key: string[], v: unknown, remove: boolean) =>
  applyStreamRec(p, remove ? { type: 'remove', key } : { type: 'update', key, value: v })
