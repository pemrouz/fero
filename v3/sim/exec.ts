//! ── sim/exec — the simulation executive: virtual time, seeded chaos, monitors ─
// One event queue holds every pending timer and in-flight message across ALL
// simulated nodes; a seeded PRNG drives every random choice (delays, drops,
// dups, jitter — and, via Env.rng, the kernel's own backoff jitter); virtual
// time jumps discretely between events. Consequences, which are the whole point
// (plan-v3.md §6):
//
//   - run(seed, scenario) is fully reproducible: a failure IS its repro command.
//   - There are no sleeps, so a thousand whole-cluster trajectories cost
//     milliseconds — CI sweeps seeds instead of accepting a red baseline.
//   - Quiescence ("queue empty") is a QUERY, so negative assertions are exact —
//     the sleep(300)-and-hope class (29 bare sleeps in v2's resource tests
//     alone) does not exist here.
//   - Invariant monitors run after EVERY event, not at scenario end — a
//     violating interleaving is caught at the event that violated it.
//
// Fault vocabulary (per unordered pair): delivery-delay range, duplication
// probability, and partition/heal. Stated exactly (two review rounds shaped
// this): links are FIFO BY CONSTRUCTION (the #lastAt clamp) because FIFO is a
// kernel protocol REQUIREMENT — within-link reorder is deliberately
// unschedulable, and the kernel does NOT tolerate it. There is deliberately NO
// per-frame drop fault either: TCP never drops a frame mid-stream on a live
// connection — real loss is TAIL loss at link death, which is exactly what
// partition()/close() model (in-flight frames may or may not land, the rest
// die) and exactly what suffix-only digest anti-entropy heals. A per-frame
// dropP would manufacture interior gaps no real shell can produce and no
// suffix digest can heal — a fault model for a network that doesn't exist.

import { Node, type NodeOpts } from '../kernel/node.ts'
import type { BootRecord, EffectSink, Event } from '../kernel/env.ts'

//! mulberry32 — the seeded PRNG. Tiny, splittable-enough, deterministic across platforms.
export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

//! Task: one queue entry. `seq` breaks same-time ties by insertion order — total order, so trajectories are deterministic.
interface Task { at: number; seq: number; run: () => void }

//! Fault: the per-pair network personality. delay is [min,max) ms; dupP is a per-frame duplication probability.
export interface Fault { delay?: [number, number]; dupP?: number }

//! StoreFault: the per-node STORAGE personality (M4b, plan §4 sim table) — delay is fsync latency;
// lieP is the FSYNC LIE (the batch resolves, but its rows do not survive a crash — firmware/page-cache
// betrayal); failP surfaces a persistFail. Torn writes need no probability: any batch still UNRESOLVED
// at crash time is the torn tail, dropped by restart()'s harvest.
export interface StoreFault { delay?: [number, number]; lieP?: number; failP?: number }

//! SimStore: one node's disk — the boot record + the WAL rows exactly as persisted (bytes + the
// per-origin chain link). Survives restart() (it IS the disk); rows lost to torn tails / fsync lies
// are dropped at harvest, like a real recovery — the chain links are how replay notices the holes.
// swapLied models a snapshot swap whose RENAME evaporates at crash: every append after it lands in
// the phantom new file (doomed with it), while the old rows quietly return at harvest.
export interface SimStore {
  boot: BootRecord | null
  wal: { batch: number; bytes: Uint8Array; prev: number; resolved: boolean; lied: boolean }[]
  swapLied?: boolean
}

//! Violation: what a monitor returns to fail a trajectory — event-indexed so the shrink/debug loop starts AT the violation.
export interface Violation { event: number; monitor: string; detail: string }

export class Sim {
  now = 0
  rng: () => number
  events = 0
  //! trace: stateHash of the stepped node after every event — the determinism canary diffs two same-seed runs over this
  trace: number[] = []
  violations: Violation[] = []
  monitors: { name: string; check: (sim: Sim) => string | null }[] = []
  nodes = new Map<string, Node>()
  #byListen = new Map<string, string>()
  #queue: Task[] = []
  #seq = 0
  #linkSeq = 0
  //! `delivered` is per END: a partition installed while a dial is IN FLIGHT must not deliver linkDown before
  // linkUp (the kernel would ignore the unknown linkDown, then the late linkUp would mint a zombie link that
  // never dies and never redials — adversarial-review finding). Pending ends convert to a refused dial instead.
  #links = new Map<number, { owner: string; peer: string; peerLink: number; up: boolean; delivered: boolean; to?: string }>()
  //! per-directed-link FIFO floor: TCP never reorders WITHIN a stream, so delivery times are clamped monotone
  // per link — without this the sim models a link no shell will ever provide, and "tolerates reorder" becomes
  // an untestable lie the kernel pays for (the dedup high-water would silently drop leapfrogged records).
  #lastAt = new Map<number, number>()
  #faults = new Map<string, Fault>()
  #partitioned = new Set<string>()
  #defaultFault: Fault
  //! M4b storage: one SimStore per uuid (the "disk" — retained across restart()), per-node store faults,
  // and the original NodeOpts so restart() can rebuild the node the way the scenario built it
  stores = new Map<string, SimStore>()
  #storeFaults = new Map<string, StoreFault>()
  #nodeOpts = new Map<string, NodeOpts>()
  //! per-store FIFO fsync clock (the disk twin of #lastAt): a real WAL resolves batches IN APPEND ORDER
  // (the shell's io-queue serializes write+fsync per row), so resolution times are clamped monotone per
  // store — without this the sim manufactures resolved-rows-past-an-unresolved-row, an "interior hole"
  // no honest disk can produce, and the kernel's hole-means-lie verdict would condemn honest restores.
  #storeAt = new Map<string, number>()
  //! M4c: every confirm probe posted through the executive is tracked to its answer — the
  // no-confirmed-write-lost check (monitors.confirmedIntact) walks the ok-resolved ones at end-of-run
  confirms = new Map<string, { uuid: string; id: number; origin: string; seq: number; level: number; ok?: boolean; count?: number }>()
  //! M5c rpc recorders (no api host in sim): per-node inboxes the Tier-2 suites assert against.
  rpcInbox = new Map<string, { link: number; id: number; mode: number; m: string; a: unknown }[]>()
  rpcResults = new Map<string, { id: number; ok: boolean; value: unknown; local: boolean }[]>()
  rpcSubRecs = new Map<string, { id: number; recs: unknown[] }[]>()
  seed: number

  constructor(seed: number, defaults: Fault = {}) {
    this.seed = seed
    this.rng = mulberry32(seed)
    this.#defaultFault = { delay: [1, 5], ...defaults }
  }

  //! add — create a node whose Env is this executive. The kernel cannot tell it isn't on a real network; that is the design.
  add(opts: NodeOpts): Node {
    const sink = this.#sinkFor(opts.uuid)
    const node = new Node(opts, { now: () => this.now, rng: this.rng, sink })
    this.nodes.set(opts.uuid, node)
    this.#nodeOpts.set(opts.uuid, opts)
    if (!this.stores.has(opts.uuid)) this.stores.set(opts.uuid, { boot: null, wal: [] })
    if (opts.listen) this.#byListen.set(opts.listen, opts.uuid)
    return node
  }

  //! storeFault — install a storage personality for a node (fsync delay, lie probability, fail probability).
  storeFault(uuid: string, f: StoreFault) { this.#storeFaults.set(uuid, f) }

  //! restart — crash + recover a node FROM ITS DISK (M4b): destroy it mid-flight, harvest the store the
  // way a real recovery would (unresolved batches are the torn tail — gone; fsync-lied batches are gone
  // and their lie is only discovered now), then boot a fresh incarnation from the boot record and replay
  // the surviving WAL through source=replay, before 'start' brings the network up. Returns the new node.
  restart(uuid: string): Node {
    const old = this.nodes.get(uuid)!
    const opts = this.#nodeOpts.get(uuid)!
    old.destroy()
    const store = this.stores.get(uuid)!
    store.wal = store.wal.filter((r) => r.resolved && !r.lied)
    store.swapLied = false // the new life reopens the REAL file; the phantom died with the crash
    const b = store.boot
    const reborn = this.add({
      ...opts,
      incarnation: old.incarnation + 1,
      boot: b ? {
        epoch: b.epoch, members: b.members, lamport: b.lamport, votedFor: b.votedFor,
        //! M6 (armed lives only): the held/dirty ledgers ride the restart like the shell's restoreOpts
        ...(b.heldPartitions ? { heldPartitions: b.heldPartitions } : {}),
        ...(b.dirtyParts ? { dirtyParts: b.dirtyParts } : {}),
      } : opts.boot,
    })
    for (const row of store.wal) this.post(uuid, { kind: 'replay', bytes: row.bytes, prev: row.prev }, 0)
    this.post(uuid, { kind: 'start' }, 0)
    return reborn
  }

  //! post — deliver an event to a node after `delay` virtual ms.
  post(uuid: string, ev: Event, delay = 0) {
    if (ev.kind === 'confirm')
      this.confirms.set(uuid + '|' + ev.id, { uuid, id: ev.id, origin: ev.origin, seq: ev.seq, level: ev.level })
    this.#schedule(delay, () => this.#step(uuid, ev))
  }

  //! at — schedule arbitrary chaos (partition/heal/fault changes) at a virtual time, so fault windows are part
  // of the seeded trajectory instead of applying at whatever `now` the scenario code happened to run.
  at(delay: number, fn: () => void) { this.#schedule(delay, fn) }

  //! directed one-shot frame traps: sever the pair INSTEAD of delivering the nth matching-verb frame.
  #severOn = new Map<string, { verb: number; n: number }>()

  //! fault / partition / heal — install network personality between a pair (both directions; unordered key).
  fault(a: string, b: string, f: Fault) { this.#faults.set(pairKey(a, b), f) }

  //! severOnFrame — the LOST-ACK primitive (plan §4 sim table), doctrine-clean: TCP never drops a frame
  // mid-stream, but a link CAN die with a frame in the kernel buffer — pure tail loss. This models
  // exactly that: when the nth frame with `verb` is about to leave a→b, the pair severs and the frame
  // dies unsent. Deterministic (frame-triggered, not time-triggered), so schedules like "the WACK for
  // that write never arrives" hold across seeds. The pair is NOT partitioned afterwards: redials
  // reconnect (a transient reset) — add partition() alongside when the outage should persist.
  severOnFrame(from: string, to: string, verb: number, nth = 1) {
    this.#severOn.set(from + '>' + to, { verb, n: nth })
  }
  partition(a: string, b: string) {
    this.#partitioned.add(pairKey(a, b))
    //! sever existing links between the pair — both ends observe linkDown, exactly like a real cable cut
    for (const [id, l] of this.#links) if (l.up && pairKey(l.owner, l.peer) === pairKey(a, b)) this.#sever(id, 'partition')
  }
  heal(a: string, b: string) { this.#partitioned.delete(pairKey(a, b)) }

  //! run — drain the queue (to quiescence) or until a horizon; monitors run after every event; returns violations.
  run(opts: { until?: number; maxEvents?: number } = {}): Violation[] {
    const max = opts.maxEvents ?? 1_000_000
    let n = 0 // per-CALL budget — the cumulative counter would trip a later phase for the sins of an earlier one
    while (this.#queue.length) {
      if (opts.until !== undefined && this.#queue[0].at > opts.until) break
      const t = this.#pop()
      this.now = t.at
      t.run()
      this.events++
      if (++n > max) throw new Error(`sim runaway: >${max} events in one run() (seed ${this.seed})`)
      for (const m of this.monitors) {
        const bad = m.check(this)
        if (bad) this.violations.push({ event: this.events, monitor: m.name, detail: bad })
      }
    }
    return this.violations
  }

  //! quiesced — the exact negative-assertion primitive: nothing in flight, nothing pending.
  get quiesced(): boolean { return this.#queue.length === 0 }

  #step(uuid: string, ev: Event) {
    const node = this.nodes.get(uuid)
    if (!node) return
    node.step(ev)
    this.trace.push(node.stateHash)
  }

  #schedule(delay: number, run: () => void) {
    const t = { at: this.now + delay, seq: this.#seq++, run }
    //! binary min-heap ordered by (at, seq) — same-time events fire in insertion order, keeping trajectories total-ordered
    const q = this.#queue
    q.push(t)
    let i = q.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (q[p].at < t.at || (q[p].at === t.at && q[p].seq < t.seq)) break
      q[i] = q[p]; i = p
    }
    q[i] = t
  }
  #pop(): Task {
    const q = this.#queue
    const top = q[0]
    const last = q.pop()!
    if (q.length) {
      q[0] = last
      const lt = (a: Task, b: Task) => a.at < b.at || (a.at === b.at && a.seq < b.seq)
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < q.length && lt(q[l], q[m])) m = l
        if (r < q.length && lt(q[r], q[m])) m = r
        if (m === i) break
        const tmp = q[i]; q[i] = q[m]; q[m] = tmp
        i = m
      }
    }
    return top
  }

  #faultFor(a: string, b: string): Fault { return this.#faults.get(pairKey(a, b)) ?? this.#defaultFault }

  #sever(id: number, reason: string) {
    const l = this.#links.get(id)
    if (!l || !l.up) return
    const r = this.#links.get(l.peerLink)!
    l.up = false; r.up = false
    const d = this.#faultFor(l.owner, l.peer).delay ?? [1, 5]
    //! linkDown goes only to ends that already saw linkUp; a pending end's linkUp task converts itself
    // to a refused dial (dialer) or silence (acceptor) when it fires and finds up=false
    if (l.delivered) this.post(l.owner, { kind: 'linkDown', link: id, reason }, d[0])
    if (r.delivered) this.post(l.peer, { kind: 'linkDown', link: l.peerLink, reason }, d[0])
  }

  #sinkFor(me: string): EffectSink {
    const sim = this
    return {
      connect(to: string) {
        const target = sim.#byListen.get(to)
        const fault = target ? sim.#faultFor(me, target) : sim.#defaultFault
        const [dMin, dMax] = fault.delay ?? [1, 5]
        const delay = dMin + sim.rng() * (dMax - dMin)
        if (!target || sim.#partitioned.has(pairKey(me, target))) {
          //! refused/unreachable: a FAILED dial — linkDown with `to` and no prior linkUp, so the kernel's backoff redial engages
          const id = ++sim.#linkSeq
          sim.post(me, { kind: 'linkDown', link: id, reason: 'refused', to }, delay)
          return
        }
        const aLink = ++sim.#linkSeq
        const bLink = ++sim.#linkSeq
        const a = { owner: me, peer: target, peerLink: bLink, up: true, delivered: false, to }
        const b = { owner: target, peer: me, peerLink: aLink, up: true, delivered: false }
        sim.#links.set(aLink, a)
        sim.#links.set(bLink, b)
        //! delivery-time recheck: a partition installed while the dial is in flight turns the dialer's linkUp
        // into a refused dial (so backoff redial engages) and the acceptor's into silence — never a zombie
        sim.#schedule(delay, () => {
          if (a.up) { a.delivered = true; sim.#step(me, { kind: 'linkUp', link: aLink, dialed: true, to }) }
          else sim.#step(me, { kind: 'linkDown', link: aLink, reason: 'refused', to })
        })
        sim.#schedule(delay, () => {
          if (b.up) { b.delivered = true; sim.#step(target, { kind: 'linkUp', link: bLink, dialed: false }) }
        })
      },
      send(link: number, bytes: Uint8Array) {
        const l = sim.#links.get(link)
        if (!l || !l.up) return // send into a dead link goes nowhere — exactly like a closed socket
        if (sim.#partitioned.has(pairKey(l.owner, l.peer))) return
        //! frame trap (severOnFrame): the nth matching frame dies IN the kernel buffer as the link severs —
        // byte [2] of a framed message is the verb (MAGIC | flags | verb), so the peek costs nothing
        const trip = sim.#severOn.get(l.owner + '>' + l.peer)
        if (trip && bytes[2] === trip.verb && --trip.n <= 0) {
          sim.#severOn.delete(l.owner + '>' + l.peer)
          sim.#sever(link, 'sever-on-frame')
          return
        }
        const f = sim.#faultFor(l.owner, l.peer)
        const [dMin, dMax] = f.delay ?? [1, 5]
        const deliver = () => {
          const at = Math.max(sim.now + dMin + sim.rng() * (dMax - dMin), sim.#lastAt.get(link) ?? 0)
          sim.#lastAt.set(link, at)
          sim.post(l.peer, { kind: 'bytesIn', link: l.peerLink, bytes }, at - sim.now)
        }
        deliver()
        //! duplication: the same frame delivered again, still FIFO (a dup can never leapfrog its original)
        if (f.dupP && sim.rng() < f.dupP) deliver()
      },
      close(link: number, reason: string) { sim.#sever(link, reason) },
      timer(id: number, tag: number, ms: number) { sim.post(me, { kind: 'timer', id, tag }, ms) },
      cancel() { /* fires are ignored by the kernel's live-id check; leaving them queued costs one no-op event */ },
      apply() { /* downstream state is read via node.state in sim; the api layer binds here in M5 */ },
      //! M4b storage: append the row, then resolve (or fail) on the fsync clock with the node's store
      // personality. A LIED batch resolves normally — the kernel advances durable, the row silently
      // will not survive a crash: exactly the betrayal the M4e proof must catch.
      persist(batch: number, bytes: Uint8Array, prev: number) {
        const store = sim.stores.get(me)!
        const f = sim.#storeFaults.get(me) ?? {}
        //! rows appended after a LIED swap live in the phantom new file — doomed with it at crash
        const row = { batch, bytes, prev, resolved: false, lied: store.swapLied === true }
        store.wal.push(row)
        //! FIFO fsync clock (see #storeAt): every echo — resolve OR fail — lands in append order
        const [dMin, dMax] = f.delay ?? [1, 3]
        const at = Math.max(sim.now + dMin + sim.rng() * (dMax - dMin), sim.#storeAt.get(me) ?? 0)
        sim.#storeAt.set(me, at)
        if (f.failP && sim.rng() < f.failP) {
          store.wal.pop() // a failed batch never reached the disk
          sim.post(me, { kind: 'persistFail', batch, reason: 'io' }, at - sim.now)
          return
        }
        if (f.lieP && sim.rng() < f.lieP) row.lied = true
        sim.#schedule(at - sim.now, () => {
          row.resolved = true
          sim.#step(me, { kind: 'persisted', batch })
        })
      },
      //! M4e snapshot+swap: the store contract is SYNCHRONOUS-durable (the shell writes tmp + fsync +
      // rename before returning), so the swap lands at effect time and its rows enter RESOLVED — a
      // crash before the echo under-claims (durable never advanced) but loses nothing. The fault rolls:
      // failP = the swap failed outright (old file untouched; persistFail latches the WAL dead); lieP =
      // the RENAME evaporates at crash — the old rows return at harvest and every append after the
      // swap dies with the phantom new file. That degradation is PURE TAIL LOSS by construction (the
      // old file is a self-consistent superset of the snapshot: the swap only removes redundancy), so
      // no hole detection is needed — suffix anti-entropy heals it like any other tail.
      snapshot(batch: number, rows: { bytes: Uint8Array; prev: number }[]) {
        const store = sim.stores.get(me)!
        const f = sim.#storeFaults.get(me) ?? {}
        const [dMin, dMax] = f.delay ?? [1, 3]
        const at = Math.max(sim.now + dMin + sim.rng() * (dMax - dMin), sim.#storeAt.get(me) ?? 0) // same FIFO clock as appends
        sim.#storeAt.set(me, at)
        if (f.failP && sim.rng() < f.failP) {
          sim.post(me, { kind: 'persistFail', batch, reason: 'io' }, at - sim.now)
          return
        }
        if (f.lieP && sim.rng() < f.lieP) store.swapLied = true
        else {
          store.wal = rows.map((r) => ({ batch, bytes: r.bytes, prev: r.prev, resolved: true, lied: false }))
          store.swapLied = false
        }
        sim.#schedule(at - sim.now, () => sim.#step(me, { kind: 'persisted', batch }))
      },
      boot(record) { sim.stores.get(me)!.boot = record },
      confirm(id, ok, count) {
        const c = sim.confirms.get(me + '|' + id)
        if (c) { c.ok = ok; c.count = count }
      },
      //! M5c method plane: the sim has no api host — rpc effects record into per-node inboxes so
      // Tier-2 tests can assert routing; nothing is executed (handlers are impure by definition).
      invoke(link, id, mode, m, a) { (sim.rpcInbox.get(me) ?? sim.rpcInbox.set(me, []).get(me)!).push({ link, id, mode, m, a }) },
      result(id, ok, value, local) { (sim.rpcResults.get(me) ?? sim.rpcResults.set(me, []).get(me)!).push({ id, ok, value, local }) },
      subRecs(id, recs) { (sim.rpcSubRecs.get(me) ?? sim.rpcSubRecs.set(me, []).get(me)!).push({ id, recs }) },
    }
  }
}

export const pairKey = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a)
