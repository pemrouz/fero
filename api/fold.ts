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
//               Then ACROSS DEPTH (V4-18): a field cell at or below an
//               ancestor's winning stamp is hidden, and what survives projects
//               shallow→deep — the kernel's own fold of overlapping cells; a
//               level only a removed field had made up is taken back
//               (the kernel's un-vivify), so the object does not depend on
//               which generations the gather happened to see.
//   parking   — a key whose claimant set EMPTIES without a dominating
//               tombstone is PARKED: the last value stands. This is the Q3a
//               fix: v2's root-replace union transiently LOST a key when the
//               old owner's partial re-scoped before the new owner's arrived
//               (zero-claim). Here zero-claim is unrepresentable — a key
//               leaves the union only via a tombstone or the coverage sweep.
//   coverage  — a parked key drops once every CURRENT holder of its partition
//               answered in this generation, ATTESTS the partition (the answer
//               carries the member's attestation set — an acquiring or
//               post-shed answerer attests nothing for it, M6-review findings
//               0/28/53), and none claims it: absence attested by the full
//               holder set is a real (possibly tombstone-GC'd) delete, not a
//               handover window.
//
// The LIVE variant re-gathers on every view install and on a paced tick while
// subscribed (the api is the impure host — timers live here, never in the
// kernel); the registry carries claims ACROSS refreshes, so a mid-handover
// refresh can only add or lawfully-remove keys, never blink one. A push-based
// per-member claim stream is a wire optimization, tracked in IDEAS.

import { isTooLarge, sizeOf } from './methods.ts'
import { proxy, snapshot, applyStreamRec, type Fault } from './substrate.ts'
import type { Runtime } from '../shell/runtime.ts'
import type { ScopedError } from './types.ts'

//! one member's claim for one cell: the value, its LWW stamp, tombstone flag.
export interface Claim { v?: unknown; st: [number, number, string]; t?: number }
export type Claims = Record<string, Claim>
//! Rows — one member's `rows` answer: the claims PLUS the attestation set `att` — the partitions this
// member can attest ABSENCE for at answer time (held ∪ unshed-orphan, exactly the scope the claims
// come from; null = ALL, the unscoped sentinel). M6-review findings 0/28/53: without it the coverage
// sweep read "answered this generation" as absence attestation — but an ACQUIRING answerer lawfully
// claims nothing mid-latch and a post-shed answerer claims nothing at all, so one skewed generation
// (early-acquiring + late-post-shed answers) blinked a key the kernel fold held (the P4/H6 violation).
export interface Rows { c: Claims; att: string[] | null }

//! rowsPartial — the member-side answer (the system `rows` handler): stamped claims over this node's
// held ∪ orphan scope, plus the attestation set for the coverage sweep. Tombstones ride from the
// versions map (a removed cell's stamp without a live value); acquiring partitions contribute
// nothing (their base is not yet this node's to attest) and are NOT attested.
export const rowsPartial = (rt: Runtime): Rows => {
  const node = rt.node
  const out: Claims = {}
  const scope = node.scope
  //! the attestation set is computed ONCE per answer from the same entries the claims filter reads —
  // answer-time atomicity is the point: whatever scope this member claims from, it attests, no more
  const att = !node.armed || !scope ? null : new Set<string>()
  if (att !== null) for (const [p, e] of scope!.entries) if (e.state !== 2) att.add(p) // held (1) + orphan (3); acquiring (2) never
  const mine = (cell: string): boolean => {
    if (att === null) return true // unscoped: the whole fold is local truth
    const p = (JSON.parse(cell) as string[])[0] ?? ''
    return att.has(p)
  }
  for (const [cell, st] of node.versions) {
    if (!mine(cell)) continue
    const v = node.state.get(cell)
    //! EXPLICIT-undefined cells ship as tombstone-equivalent: the wire codec drops undefined values
    // and the union's update path cannot materialize them — the gather's contract is "keys with
    // values"; the explicit-undefined representability question rides the open value-codec ticket
    // (plan §14.1, noted in the M6 record).
    if (node.state.has(cell) && v !== undefined) out[cell] = { v, st: [st.epoch, st.seq, st.origin] }
    else out[cell] = { st: [st.epoch, st.seq, st.origin], t: 1 }
  }
  return { c: out, att: att === null ? null : [...att] }
}

//! newer — the kernel's LWW total order (epoch, seq, origin), verbatim.
const newer = (a: [number, number, string], b: [number, number, string]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

//! Gather — the coordinator: a claims registry + a result proxy. One instance per node (memoized by
// the composer — v2's M3 leak); one-shot and live consumption share the registry and the refresh.
export class Gather {
  #rt: Runtime
  #call: (uuid: string, timeoutMs: number) => Promise<Rows>
  //! cell → member uuid → claim (the registry: claims survive across refreshes — parking's substrate)
  #registry = new Map<string, Map<string, Claim>>()
  proxy: any = proxy({})
  #timer: ReturnType<typeof setInterval> | null = null
  #gen = 0

  //! fault — where the user's views and taps on the union land when they throw as a cell projects (substrate.ts
  // Fault). The per-cell catches below are for a cell that cannot materialize; without this they swallowed a
  // user's throw too, silently.
  #fault: Fault | undefined
  //! refused (V4-51) — the last generation's typed refusal when a member's share was bigger than one frame (its
  // `rows` answer refused 'too-large'), null once a generation gathered every share. A new live read fails with it
  // at once (api/index.ts read); onRefused ends the live reads already open (Host.endLive): never a silent partial.
  refused: ScopedError | null = null
  #onRefused: ((r: ScopedError) => void) | undefined
  constructor(rt: Runtime, call: (uuid: string, timeoutMs: number) => Promise<Rows>, fault?: Fault, onRefused?: (r: ScopedError) => void) {
    this.#rt = rt
    this.#call = call
    this.#fault = fault
    this.#onRefused = onRefused
  }

  //! refresh — one gather generation, SERIALIZED: concurrent callers (a one-shot read racing the
  // fold's install/shed-triggered re-gather) queue behind each other instead of interleaving the
  // registry's wholesale-replace or returning a mid-projection snapshot (the flake the Tier-3 suite
  // caught: `await data` racing a shed re-gather answered with a partial union).
  #chain: Promise<unknown> = Promise.resolve()
  refresh(rt: Runtime, opts: { throwOnPartial: boolean; timeoutMs?: number }): Promise<unknown> {
    const next = this.#chain.then(() => this.#refresh(rt, opts), () => this.#refresh(rt, opts))
    this.#chain = next.catch(() => {}) // the chain never rejects; each caller sees its own outcome
    return next
  }

  //! #refresh — one generation: fan out to every view member (self in-process), replace each
  // answerer's claim set wholesale, then fold. An unreachable member fails the ONE-SHOT caller typed
  // (never a silent partial — plan §5/§9); the LIVE path keeps the last-good claims (parking) and
  // retries on its cadence, which is the availability-honest reading of the same rule.
  async #refresh(rt: Runtime, opts: { throwOnPartial: boolean; timeoutMs?: number }): Promise<unknown> {
    const node = this.#rt.node
    const gen = ++this.#gen
    const members = node.membership.view.members.map((m) => m[0])
    const mine = rowsPartial(this.#rt)
    const answered = new Map<string, Rows>([[node.uuid, mine]])
    const missing: string[] = [], tooBig: string[] = []
    await Promise.all(members.filter((u) => u !== node.uuid).map(async (u) => {
      try { answered.set(u, await this.#call(u, opts.timeoutMs ?? 8000)) }
      catch (e) { (isTooLarge(e) ? tooBig : missing).push(u) }
    }))
    //! a member whose claims are bigger than one frame (V4-51) refused its `rows` answer 'too-large': reachable, and
    // retrying cannot help, so it is never filed as unreachable — the one-shot read rejects too-large (it wins over
    // unreachable when both happen), and the live union ends its subscribers instead of parking that member silently
    if (tooBig.length) {
      const r: ScopedError = {
        scoped: true, op: 'gather', reason: 'too-large', replicas: node.replicas, missing: tooBig,
        hint: `the rows ${tooBig.join(', ')} ${tooBig.length === 1 ? 'holds are' : 'hold are'} bigger than one frame (${sizeOf(node.tune.frame)}), so the whole-resource read cannot gather them: read one key at a time (methods.read(key))`,
      }
      this.refused = r
      if (opts.throwOnPartial) throw r
      this.#onRefused?.(r)
    } else this.refused = null
    if (missing.length && opts.throwOnPartial)
      throw {
        scoped: true, op: 'gather', reason: 'unreachable', replicas: node.replicas, missing,
        hint: 'some members are unreachable — the whole-resource read would be a silent partial; retry when the view heals',
      } satisfies ScopedError
    //! superseded mid-flight by a newer refresh — answer a CLONE, never the live union root
    // (M6-review finding 8: the one-shot paths hand this value to user code)
    if (gen !== this.#gen) return structuredClone(snapshot(this.proxy))
    //! per-generation attestations: uuid → the partitions that member attests (null = ALL). Built
    // from the answers of THIS generation only — attestation never survives a refresh (findings 0/28/53)
    const att = new Map<string, Set<string> | null>()
    for (const [uuid, rows] of answered) att.set(uuid, rows.att === null ? null : new Set(rows.att))
    //! merge: replace each answerer's claims wholesale, keep everyone else's (parking substrate)
    const touched = new Set<string>([...this.#registry.keys()])
    for (const [uuid, rows] of answered) {
      const claims = rows.c
      for (const cell of Object.keys(claims)) touched.add(cell)
      for (const [cell, per] of this.#registry) { per.delete(uuid); if (!per.size) void cell } // wholesale replace below
      for (const [cell, claim] of Object.entries(claims)) {
        let per = this.#registry.get(cell)
        if (!per) { per = new Map(); this.#registry.set(cell, per) }
        per.set(uuid, claim)
      }
    }
    //! reap the registry rows of every uuid NO LONGER IN THE COMMITTED VIEW (M6-review findings
    // 1/22/52): a departed/evicted member is never fanned out to again, so its ghost claims would
    // otherwise assert a value forever (win never null ⇒ the sweep can never even run) and leak one
    // registry entry per dead uuid for the node's lifetime. Members merely MISSING this generation
    // keep their claims — that is lawful parking, not departure.
    const alive = new Set(members)
    for (const [, per] of this.#registry)
      for (const uuid of per.keys()) if (!alive.has(uuid)) per.delete(uuid)
    //! fold the touched cells — the winner per cell by the kernel's stamp order — then ACROSS DEPTH
    // (V4-18, overlapping cells): a field cell whose winning stamp is at or below an ancestor's winning
    // stamp is the older fact that ancestor's whole-row write carried (or its remove erased) — it is
    // dropped, exactly as the kernel's apply refuses or sweeps it. What survives projects in TWO
    // PHASES: the coverage drops first (a parked cell nobody claims any more — unstamped, so it says
    // nothing against a live ancestor's own value, which the next phase re-projects whole), then the
    // stamped cells shallow→deep, a live cell set and a tombstone deleted at its depth. Shallow-first
    // is what makes the fold order-free: a parent tombstone under a NEWER live field projects before
    // the field re-makes the row on top of it (plan §5's cross-hierarchy shape, the Q3a hunt's seed-0
    // finding), and a field remove NEWER than its row deletes the field after the row's update put the
    // whole value there — the same object the kernel's own sink shows (sim/monitors.ts projected()).
    const ring = node.writes.ring
    if (node.epoch > 0 && ring.epoch !== node.epoch) ring.build(node.epoch, node.membership.view.members)
    const wins = new Map<string, Claim | null>()
    for (const cell of touched) {
      const per = this.#registry.get(cell)
      let win: Claim | null = null
      if (per) for (const c of per.values()) if (win === null || newer(c.st, win.st)) win = c
      wins.set(cell, win)
    }
    const dropped: string[][] = []
    const stamped: { key: string[]; v: unknown; t: boolean }[] = []
    const shown = new Map<string, unknown>() // the live cells that project this generation (not hidden), with their values
    for (const [cell, win] of wins) {
      const key = JSON.parse(cell) as string[]
      if (win === null) {
        //! zero-claim: drops ONLY when every current holder answered this generation AND ATTESTED the
        // partition and none claims it (the coverage sweep) — else the key PARKS: the last projected
        // value stands until the handover settles (the Q3a fix). The attestation qualifier (M6-review
        // findings 0/28/53) is what makes "answered" mean "attested absence": an answer taken while the
        // holder was still ACQUIRING (or under epoch skew, before it even knew it was assigned) carries
        // no att for p and counts for nothing — DESIGN-M6 C5's "answered, current-epoch subscription".
        const p = key[0] ?? ''
        const holders = node.armed ? ring.holders(p, node.replicas) : node.membership.view.members.map((m) => m[0])
        const covered = holders.every((h) => {
          const a = att.get(h)
          return a !== undefined && (a === null || a.has(p)) // undefined = did not answer this generation
        })
        if (covered) {
          this.#registry.delete(cell)
          dropped.push(key)
        }
        continue
      }
      //! the across-depth check: every proper prefix with a stamped winner at or above this one hides it
      let hidden = false
      for (let d = 1; d < key.length && !hidden; d++) {
        const a = wins.get(JSON.stringify(key.slice(0, d)))
        if (a != null && !newer(win.st, a.st)) hidden = true
      }
      if (!hidden) { stamped.push({ key, v: win.v, t: win.t === 1 }); if (win.t !== 1) shown.set(cell, win.v) }
    }
    //! a DEEP remove into an absent subtree is a no-op — and must be skipped: the substrate's
    // deep-remove crashes on missing intermediates, and one doomed remove aborts the whole
    // projection transact (the hunt's seed-13 finding: every later refresh re-threw on the same
    // registry cell and the union froze stale)
    const present = (root: Record<string, unknown>, key: string[]): boolean => {
      let cur: unknown = root
      for (let i = 0; i < key.length - 1; i++) {
        if (cur === null || typeof cur !== 'object') return false
        cur = (cur as Record<string, unknown>)[key[i]]
      }
      return cur !== null && typeof cur === 'object'
    }
    //! …and every cell projects in ISOLATION: the substrate's deep ops crash on null/scalar
    // intermediates (field-granular LWW lawfully nests a live cell under a null parent — the
    // seed-41 finding: ONE such cell aborted the whole projection transact and every other key
    // went stale as collateral). A cell that cannot materialize is skipped — its top-level key
    // still shows through whatever of its siblings/parent projected (the kernel's own flat fold
    // holds both cells; nesting-under-null is the documented §5 materialization ambiguity).
    let root = snapshot(this.proxy) as Record<string, unknown>
    const emptied: string[][] = [] // the deep cells deleted this generation — their parent levels may be made-up ones
    for (const key of dropped)
      if (key.length === 1 || present(root, key)) { try { applyCell(this.proxy, key, undefined, true, this.#fault); if (key.length > 1) emptied.push(key) } catch { /* absent subtree */ } }
    stamped.sort((a, b) => a.key.length - b.key.length)
    let depth = 1
    for (const s of stamped) {
      if (!s.t) { try { applyCell(this.proxy, s.key, s.v, false, this.#fault) } catch { /* blocked intermediate */ } continue }
      //! a deep tombstone looks at the object as the shallower cells left it (one fresh read per depth)
      if (s.key.length > depth) { root = snapshot(this.proxy) as Record<string, unknown>; depth = s.key.length }
      if (s.key.length === 1 || present(root, s.key)) { try { applyCell(this.proxy, s.key, undefined, true, this.#fault); if (s.key.length > 1) emptied.push(s.key) } catch { /* absent subtree */ } }
    }
    //! UN-VIVIFY (V4-18, the kernel's #unvivify for the gather): the projection makes `{}` up for the
    // levels a field lands in (applyStreamRec's orphan-cell vivify), so after a field's tombstone (or
    // its coverage drop) deletes it, a row or level that only that field had made up is left behind as
    // an empty object — where the node's own screen shows nothing, and where a gather that first saw
    // the history AFTER the remove shows nothing either. So, walking up from each deleted deep cell's
    // parent: a level with its own live claim projected whole (an empty object the user wrote stays);
    // a PARKED level keeps its last value (conservative — parking is the handover window); an object
    // with anything in it stays (the fields keep it, on every node); an empty object held by the
    // nearest projected ancestor's own value was never made up; any other empty object was — it goes,
    // and the level above is asked the same question.
    for (const key of emptied) this.#unvivify(key, shown, wins)
    //! the one-shot answer is a CLONE (M6-review finding 8): snapshot() is the proxy's live internal
    // root — `await data` and local methods.read() hand this value straight to user code, and a
    // mutation there must never write through into the union every live subscriber shares. The wire
    // path copies into frame bytes anyway; local must match. (The live SUB path hands out `proxy`
    // itself — a read-only projection by contract — and stays as-is.)
    return structuredClone(snapshot(this.proxy))
  }

  //! #unvivify — take back the levels a deleted field cell alone had made up (see the projection above).
  #unvivify(key: string[], shown: Map<string, unknown>, wins: Map<string, Claim | null>) {
    for (let j = key.length - 1; j >= 1; j--) {
      const level = key.slice(0, j)
      const lk = JSON.stringify(level)
      if (shown.has(lk)) return // its own stamped value projected whole, `{}` included
      if (wins.get(lk) === null && this.#registry.has(lk)) return // parked: the last value stands
      let cur: unknown = snapshot(this.proxy)
      for (const k of level) cur = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || Object.keys(cur as object).length > 0) return
      //! an empty object nobody claims: the nearest projected ancestor's own value says whether it was made up
      let held = false
      for (let i = j - 1; i >= 1; i--) {
        const ak = JSON.stringify(key.slice(0, i))
        if (shown.has(ak)) {
          let v = shown.get(ak)
          for (let d = i; d < j && v !== null && typeof v === 'object'; d++) v = (v as Record<string, unknown>)[key[d]]
          held = v !== null && typeof v === 'object'
          break
        }
        const aw = wins.get(ak)
        if (aw === null && this.#registry.has(ak)) { held = true; break } // a parked ancestor: its last value stands
        if (aw != null && aw.t === 1) break // a row remove at this level: whatever is under it was re-made by a field
      }
      if (held) return
      try { applyCell(this.proxy, level, undefined, true, this.#fault) } catch { return }
    }
  }

  //! live — arm the paced re-gather (the composer also refreshes on every view install). Idempotent.
  // Callers compute intervalMs via liveCadence() — never hand a raw heartbeat multiple in here.
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
const applyCell = (p: any, key: string[], v: unknown, remove: boolean, fault: Fault | undefined) =>
  applyStreamRec(p, remove ? { type: 'remove', key } : { type: 'update', key, value: v }, fault)

//! liveCadence — the live gather's re-poll interval: 4× the heartbeat with a 1s FLOOR (M6-review
// finding 9: heartbeatMs: 0 is the composer's documented heartbeat opt-out — without the floor it
// armed setInterval(…, 0), a continuous full-cluster rows fan-out on the serialized refresh chain).
// Normal configs keep the existing default: liveCadence(undefined) === liveCadence(500) === 2000.
export const liveCadence = (heartbeatMs?: number): number => Math.max(1000, (heartbeatMs ?? 500) * 4)
