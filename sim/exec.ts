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
import { foldInto, type Folded } from './fold.ts'

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
// at crash time is the torn tail, dropped by restart()'s harvest. bootFailP fails a BOOT record (I-36,
// the shell's EIO/EACCES/ENOSPC on boot.json): the record never lands, the store is condemned, and
// persistFail is posted once — the shell's boot() catch, mirrored.
export interface StoreFault { delay?: [number, number]; lieP?: number; failP?: number; bootFailP?: number }

//! SimStore: one node's disk — the boot record + the WAL rows exactly as persisted (bytes + the
// per-origin chain link). Survives restart() (it IS the disk); rows lost to torn tails / fsync lies
// are dropped at harvest, like a real recovery — the chain links are how replay notices the holes.
// swapLied models a snapshot swap whose RENAME evaporates at crash: every append after it lands in
// the phantom new file (doomed with it), while the old rows quietly return at harvest.
export interface SimStore {
  boot: BootRecord | null
  //! condemned (I-36): a boot record failed while the node lived on and kept voting from memory, so `boot`
  // is stale — the shell's `condemned` marker on disk. restart() refuses such a store.
  condemned?: boolean
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
  //! V4-18: what reached each node's sink, folded into the object a screen would show (sim/fold.ts) —
  // the downstream half of the object oracle (monitors.ts projected()). Reset with each life (add()).
  folds = new Map<string, Folded>()
  //! V4-6: the graceful-leave outcome per uuid (the kernel's `left` effect) — a scenario destroys the node after it
  left = new Map<string, boolean>()
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
  confirms = new Map<string, { uuid: string; id: number; origin: string; seq: number; level: number; part?: string; ok?: boolean; count?: number }>()
  //! M5c rpc recorders (no api host in sim): per-node inboxes the Tier-2 suites assert against.
  rpcInbox = new Map<string, { link: number; id: number; mode: number; m: string; a: unknown }[]>()
  rpcResults = new Map<string, { id: number; ok: boolean; value: unknown; local: boolean }[]>()
  rpcSubRecs = new Map<string, { id: number; recs: unknown[] }[]>()
  //! raw endpoints (the door family, DESIGN-DOOR §9): a hand-written relay, a replayer, a stranger with a
  // socket — an endpoint that is NOT a kernel node. Dialable at its listen, able to dial, fed the same
  // Events a node would see (linkUp / bytesIn / linkDown) and answering through the same sink. Never in
  // sim.nodes (the monitors see kernel nodes only), never traced. Empty on every other run: one size
  // check per step.
  #raws = new Map<string, (ev: Event) => void>()
  //! tap (the door family's frame oracle): sees every frame the moment a node ships it onto a live link —
  // owner, peer, this end's link id, the peer's, whether this end dialed, the bytes. Null by default,
  // zero cost on every other run.
  tap: ((from: string, to: string, link: number, peerLink: number, dialed: boolean, bytes: Uint8Array) => void) | null = null
  //! watch (DESIGN-SCALE §6, stage 0): the scale monitors are installed (sim/monitors.ts armScale) — only then are
  // `stepped` and `inflight` kept. False on every other run: one boolean read per event and per frame, so every
  // golden, sweep and counted pin runs exactly the code it ran before.
  watch = false
  //! stepped (stage 0): the uuids of the nodes that stepped since the last monitor pass. A
  // per-event monitor that walks STATE (cells, versions, floors) walks only these — state changes only inside
  // step(), so the walk is complete and costs one node per event instead of every node (STATUS: "every new
  // per-event monitor walks only the node that stepped"). Under checkEvery sampling it holds every node that
  // stepped in the window. Cleared by the monitor pass itself.
  stepped = new Set<string>()
  //! inflight (stage 0, monitor M6): every frame between a send and its bytesIn delivery, by task id — the
  // wire as the sim can see it and no shell can. M6 reads it at a tombstone release to prove nothing
  // older than the released stamp is still on its way to a holder. One Map set/delete per delivered frame.
  inflight = new Map<number, { from: string; to: string; bytes: Uint8Array }>()
  //! g5 (stage 0, monitor M5): uuids whose restart dropped rows the disk had LIED about (StoreFault lieP, a
  // lied swap). Their durable floors overclaim by those rows — the DESIGN-SCALE §5 G5 residual, documented and
  // not a monitor's finding. M5 skips a life restored from such a disk.
  g5 = new Set<string>()
  //! restoring (stage 0): uuids between restart() and their `start` event — the replay rows fold one event at a
  // time, so a state monitor (M1, M3, M5) that read the node mid-replay would see a half-folded fold and a seed
  // floor the rows have not caught up with yet. They wait for `start`, then read the whole restored fold at once.
  restoring = new Set<string>()
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
    this.folds.set(opts.uuid, {})
    this.#nodeOpts.set(opts.uuid, opts)
    if (!this.stores.has(opts.uuid)) this.stores.set(opts.uuid, { boot: null, wal: [] })
    if (opts.listen) this.#byListen.set(opts.listen, opts.uuid)
    return node
  }

  //! storeFault — install a storage personality for a node (fsync delay, lie probability, fail probability).
  storeFault(uuid: string, f: StoreFault) { this.#storeFaults.set(uuid, f) }

  //! raw — register a raw endpoint (see #raws): `id` names it in the queue, `listen` makes it dialable (null
  // = it only dials), `handler` gets every Event addressed to it and the sink to answer with. Returns the sink.
  raw(id: string, listen: string | null, handler: (ev: Event, sink: EffectSink) => void): EffectSink {
    const sink = this.#sinkFor(id)
    this.#raws.set(id, (ev) => handler(ev, sink))
    if (listen) this.#byListen.set(listen, id)
    return sink
  }

  //! restart — crash + recover a node FROM ITS DISK (M4b): destroy it mid-flight, harvest the store the
  // way a real recovery would (unresolved batches are the torn tail — gone; fsync-lied batches are gone
  // and their lie is only discovered now), then boot a fresh incarnation from the boot record and replay
  // the surviving WAL through source=replay, before 'start' brings the network up. Returns the new node.
  // A CONDEMNED store (I-36) is refused before anything is touched, like the shell's restoreOpts: its boot
  // record is stale, and booting from it could vote twice in one epoch.
  restart(uuid: string): Node {
    const store = this.stores.get(uuid)!
    if (store.condemned) throw new Error(`restart: ${uuid} is a store that failed mid-life — its boot record is stale; refusing to restore from it`)
    const old = this.nodes.get(uuid)!
    const opts = this.#nodeOpts.get(uuid)!
    old.destroy()
    if (store.wal.some((r) => r.resolved && r.lied)) this.g5.add(uuid) // the disk lied: its durable floors may overclaim (G5)
    store.wal = store.wal.filter((r) => r.resolved && !r.lied)
    store.swapLied = false // the new life reopens the REAL file; the phantom died with the crash
    const b = store.boot
    const reborn = this.add({
      ...opts,
      incarnation: old.incarnation + 1,
      boot: b ? {
        epoch: b.epoch, members: b.members, lamport: b.lamport, votedFor: b.votedFor,
        //! M6 (armed lives only): the held/orphan/dirty ledgers + the floor seed ride the restart
        // like the shell's restoreOpts — dropping orphanParts here silently un-listed a frozen
        // orphan from the replay authority (the M6 fix-round H1 regression: its rows never folded)
        ...(b.heldPartitions ? { heldPartitions: b.heldPartitions } : {}),
        ...(b.orphanParts ? { orphanParts: b.orphanParts } : {}),
        ...(b.dirtyParts ? { dirtyParts: b.dirtyParts } : {}),
        ...(b.floors ? { floors: b.floors } : {}),
      } : opts.boot,
    })
    for (const row of store.wal) this.post(uuid, { kind: 'replay', bytes: row.bytes, prev: row.prev }, 0)
    this.restoring.add(uuid)
    this.#schedule(0, () => { this.restoring.delete(uuid); this.#step(uuid, { kind: 'start' }) })
    return reborn
  }

  //! post — deliver an event to a node after `delay` virtual ms.
  post(uuid: string, ev: Event, delay = 0) {
    if (ev.kind === 'confirm')
      this.confirms.set(uuid + '|' + ev.id, { uuid, id: ev.id, origin: ev.origin, seq: ev.seq, level: ev.level, part: ev.part })
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
  // stopOnViolation (M7 shrinker, DESIGN-M7 §2): freeze the trajectory AT the first violating event —
  // sim.events === violations[first].event and every journal is cut at the violation instant, so the
  // capture opens AT the violation by construction (no scrubber machinery, no Violation shape change).
  //! checkEvery (scale tier): run the monitor pass every K events instead of every event, plus ONCE
  // when the loop exits — the full per-event pass is O(nodes × lanes) even when nothing changed, which
  // at n=100 costs more than the trajectory itself. The log-cursor monitors (log-monotone,
  // single-writer, attempt-exactly-once) lose NOTHING under sampling (cursors scan every appended
  // entry exactly once regardless of K); state-snapshot monitors coarsen to sampled + at-exit.
  // Violation.event is then the DETECTION event — at most checkEvery past the violating one.
  run(opts: { until?: number; maxEvents?: number; stopOnViolation?: boolean; checkEvery?: number } = {}): Violation[] {
    const max = opts.maxEvents ?? 1_000_000
    const every = opts.checkEvery ?? 1
    const v0 = this.violations.length // stop on violations pushed by THIS call, not an earlier phase's
    let n = 0 // per-CALL budget — the cumulative counter would trip a later phase for the sins of an earlier one
    let unchecked = false // events have run since the last monitor pass — the exit check owes one
    const check = (): void => {
      unchecked = false
      for (const m of this.monitors) {
        const bad = m.check(this)
        if (bad) this.violations.push({ event: this.events, monitor: m.name, detail: bad })
      }
      this.stepped.clear()
    }
    while (this.#queue.length) {
      if (opts.until !== undefined && this.#queue[0].at > opts.until) break
      const t = this.#pop()
      this.now = t.at
      t.run()
      this.events++
      if (++n > max) throw new Error(`sim runaway: >${max} events in one run() (seed ${this.seed})`)
      unchecked = true
      if (n % every === 0) check()
      if (opts.stopOnViolation && this.violations.length > v0) return this.violations
    }
    if (unchecked) check() // the final sub-K tail is always checked at the exit state
    return this.violations
  }

  //! quiesced — the exact negative-assertion primitive: nothing in flight, nothing pending.
  get quiesced(): boolean { return this.#queue.length === 0 }

  #step(uuid: string, ev: Event) {
    if (this.#raws.size !== 0) { const raw = this.#raws.get(uuid); if (raw !== undefined) return raw(ev) }
    const node = this.nodes.get(uuid)
    if (!node) return
    node.step(ev)
    if (this.watch) this.stepped.add(uuid)
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
        if (sim.tap !== null) sim.tap(l.owner, l.peer, link, l.peerLink, l.to !== undefined, bytes)
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
          //! watched runs: the frame is on the wire until its bytesIn fires (M6 reads sim.inflight). The same one
          // task either way, so the event count and the seq order are identical with or without the watch
          if (!sim.watch) return sim.post(l.peer, { kind: 'bytesIn', link: l.peerLink, bytes }, at - sim.now)
          const id = sim.#seq
          sim.inflight.set(id, { from: l.owner, to: l.peer, bytes })
          sim.#schedule(at - sim.now, () => { sim.inflight.delete(id); sim.#step(l.peer, { kind: 'bytesIn', link: l.peerLink, bytes }) })
        }
        deliver()
        //! duplication: the same frame delivered again, still FIFO (a dup can never leapfrog its original)
        if (f.dupP && sim.rng() < f.dupP) deliver()
      },
      close(link: number, reason: string) { sim.#sever(link, reason) },
      timer(id: number, tag: number, ms: number) { sim.post(me, { kind: 'timer', id, tag }, ms) },
      cancel() { /* fires are ignored by the kernel's live-id check; leaving them queued costs one no-op event */ },
      apply(rec) { foldInto(sim.folds.get(me)!, rec) }, // the downstream object (V4-18); the api layer binds its proxy here
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
      //! boot: synchronous-durable like the shell's. bootFailP (I-36) fails it: the record never lands, the
      // store is condemned and takes no later record (the shell's #bootFailed latch), and persistFail is
      // posted as its own event — the shell posts it on a microtask, never as a nested step. The rng is
      // drawn only when the fault is set, so every existing trajectory is unchanged.
      boot(record) {
        const store = sim.stores.get(me)!
        if (store.condemned) return
        const f = sim.#storeFaults.get(me)
        if (f?.bootFailP && sim.rng() < f.bootFailP) {
          store.condemned = true
          sim.post(me, { kind: 'persistFail', batch: 0, reason: 'io' }, 0)
          return
        }
        store.boot = record
      },
      confirm(id, ok, count) {
        const c = sim.confirms.get(me + '|' + id)
        if (c) { c.ok = ok; c.count = count }
      },
      //! M5c method plane: the sim has no api host — rpc effects record into per-node inboxes so
      // Tier-2 tests can assert routing; nothing is executed (handlers are impure by definition).
      invoke(link, id, mode, m, a) { (sim.rpcInbox.get(me) ?? sim.rpcInbox.set(me, []).get(me)!).push({ link, id, mode, m, a }) },
      result(id, ok, value, local) { (sim.rpcResults.get(me) ?? sim.rpcResults.set(me, []).get(me)!).push({ id, ok, value, local }) },
      subRecs(id, recs) { (sim.rpcSubRecs.get(me) ?? sim.rpcSubRecs.set(me, []).get(me)!).push({ id, recs }) },
      left(clean) { sim.left.set(me, clean) },
    }
  }
}

export const pairKey = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a)
