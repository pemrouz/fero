//! ── kernel/node — the deterministic core: step(event) → effects ──────────────
// This file is v3's answer to v2's 1604-line fero() closure. All protocol state
// is explicit fields on a class; the ONLY way the world moves it is
// node.step(event) (a single fail-closed dispatch site); the ONLY way it moves
// the world is the typed EffectSink. No timers, no sockets, no Date.now, no
// Math.random (kernel/purity.test.ts enforces it) — which is why the same bytes
// run under seeded simulation (sim/) and real TCP (shell/) unchanged, and why
// every distributed regression is a reproducible seed instead of a wall-clock
// race.
//
// Scope by milestone: M0 broadcast + dedup + LWW, M1 digest anti-entropy +
// heartbeat floor, M2 membership (committed views, ballots, the write-gate),
// M3 the write pipeline (owner routing via the view-derived ring, forwarded
// attempts, cid dedup, typed NACKs — kernel/write.ts). Still ahead: storage/
// durability (M4), the public api layer (M5), scoped replication (M6).
// Per-origin seqs are LAMPORT stamps, NOT contiguous — there is deliberately no
// hold-back and no reorder tolerance: FIFO links are a PROTOCOL REQUIREMENT,
// provided by TCP and enforced in sim. Streams are per-origin descriptor
// objects (not v2's four parallel string-keyed maps).
//
// The write path IS a function: a 'write' event enters ingest exactly like an
// inbound record does — apply is a downstream EFFECT, so re-entrant capture
// (v2's applying/committingForward/discarding flag family) has no place to
// exist. That whole guard menagerie is deleted by construction, not by care.

import { FrameError, VERB, encodeControl, encodeRuns, type AttemptRun, type Frame } from './codec.ts'
import { Link, LS, dialedByLower } from './link.ts'
import { JK, Journal } from './journal.ts'
import { Membership } from './membership.ts'
import { Writes } from './write.ts'
import { Streams } from './streams.ts'
import { REC, TAG, type Env, type Event, type Rec } from './env.ts'

//! NodeOpts: explicit boot facts — no config-shape sniffing (v2's hasPeers heuristic is banned by plan §9).
export interface NodeOpts {
  uuid: string
  listen?: string        // my dialable address, gossiped in HELLO
  hosts?: string[]       // static discovery targets to dial on start
  incarnation?: number   // bumped per restart (M2 fences flappers with it; carried in HELLO from day 0)
  heartbeatMs?: number   // 0 = off (EXPLICIT protocol mode, not a magic duration)
  redialMs?: number      // backoff base; cap = 32x base
  journalCap?: number    // diagnostics ring size — captures that want full-history time-travel raise it
  //! boot record seam (plan §5 boot modes; persistence itself lands with M4's WAL): a restored view.
  // A node booted with epoch > 0 is REJOINING — read-only until a committed view ≥ this epoch installs.
  boot?: { epoch: number; members: [string, string][] }
}

//! MAX_REDIALS: bounded dial persistence per target — after this, give up loudly (JK.giveUp). With
// heartbeats on, the heartbeat tick revives given-up targets (JK.revive) — give-up is a cool-down.
export const MAX_REDIALS = 10

export class Node {
  readonly uuid: string
  readonly listen: string
  readonly incarnation: number
  journal: Journal
  //! links by env-minted id; byUuid enforces one-logical-link-per-pair (kernel/link.ts keeper rule)
  links = new Map<number, Link>()
  byUuid = new Map<string, number>()
  //! replication state — explicit fields, not closure captures.
  // `seq` IS the Lamport clock: it merges up on every inbound record and
  // increments on every local write, so a local write is always causally newest
  // (v2 DECISIONS A, kept). Convergence then follows from per-cell LWW below.
  seq = 0
  epoch = 0
  //! membership (M2): committed views, ballots, the write-gate. The data plane below stays open —
  // membership gates COMMITS and majority math, never replication (an evicted node still converges).
  membership: Membership
  //! writes (M3): THE single write ingress — attempts, cid dedup, owner routing/forwarding, the ONE
  // bounded pending queue. Local 'write' events, forwarded WRITE frames, and inbound RECORDS all
  // enter the system through this object (kernel/write.ts is the stamp-site module).
  writes = new Writes()
  //! streams (M4a): per-origin descriptors carrying the watermark ladder {applied, shippable, durable}
  // (kernel/streams.ts). Seqs are LAMPORT stamps — monotone per origin but NOT contiguous (the clock
  // merges up on receipt), so dedup on `applied` is gap-tolerant: over a FIFO link from the single
  // broadcaster, any arrival ≤ applied is a genuine duplicate and any arrival > applied is new (the
  // plan §5 ordering contract, stated here instead of living as v2 folklore).
  streams = new Streams()
  //! versions: per-cell LWW stamps, lexicographic (epoch, seq, origin) — the ONE conflict-resolution rule (plan §5).
  // Cells are full key paths (field-granular); a remove leaves its stamp as a
  // tombstone so a slower concurrent update cannot resurrect the value. Tombstone
  // GC ties to compaction at M4 — bounded growth is a KNOWN M0 debt, journal-visible in size.
  versions = new Map<string, { epoch: number; seq: number; origin: string }>()
  //! per-origin record logs: the retransmit buffer (plan §5: "the log IS the retransmit buffer").
  // EVERY arrived record is stored (LWW losers included — a loser here may be the
  // only copy a lagging peer ever gets offered, and the election re-runs
  // identically everywhere), seq-ascending per origin because ingest is monotone.
  // Anti-entropy is digest-gated: on admit (and after a drop-under-backpressure)
  // peers exchange {origin: highestHeldSeq} digests and ship ONLY the missing
  // suffixes. Suffix-only healing is sound because loss is always TAIL loss —
  // FIFO links cannot create interior gaps; a died link loses a suffix, a
  // dropped-oldest queue loses a suffix of what that link would have sent.
  // This closes the dial-race loss window the adversarial review proved (a write
  // flushed only on the dup-loser link died with it) and removes the form-first
  // constraint: whatever a doomed link swallowed, the digest exchange on the
  // surviving link re-ships. Unbounded in M0; M4's compaction bounds it.
  // Entries retain the ATTEMPT identity (iss/cid) of committed forwarded writes
  // so anti-entropy re-ships it — a healed or future owner rebuilds its dedup
  // window from the log stream itself (M3's ownership-move exactly-once story).
  logs = new Map<string, { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number }[]>()
  //! M0 downstream state: a flat path→value map + an order-insensitive rolling hash.
  // The api layer binds a $() proxy to sink.apply() later (M5); the kernel keeps
  // this mirror so sim monitors and the replay/state-hash check (plan §3.1) can
  // interrogate state without reaching through a proxy.
  state = new Map<string, unknown>()
  #entryHash = new Map<string, number>()
  #hash = 0
  //! timers — kernel-minted ids; fired ids not in #timers are stale (cancel raced the fire) and ignored
  #timerSeq = 0
  #timers = new Map<number, { tag: number; to?: string }>()
  //! gaveUp distinguishes "parked after the final attempt FAILED" from "the final attempt is still
  // pending" — tries increments at ARM time, so tries alone cannot tell them apart, and a revival
  // during the pending window would orphan the live timer into a second concurrent dial chain
  // (adversarial-review finding: forked chains, doubled dial traffic, starved giveUp).
  #backoff = new Map<string, { ms: number; tries: number; gaveUp?: boolean }>()
  #hbTimer = -1
  destroyed = false
  env: Env
  #opts: NodeOpts

  constructor(opts: NodeOpts, env: Env) {
    this.env = env
    this.journal = new Journal(opts.journalCap)
    this.uuid = opts.uuid
    this.listen = opts.listen ?? ''
    this.incarnation = opts.incarnation ?? 1
    this.membership = new Membership(opts.boot)
    this.epoch = this.membership.view.epoch // a restored node stamps at its restored epoch, never below it
    this.#opts = opts
  }

  //! hosts — the static discovery targets (membership's genesis quorum + the revival loop read it).
  get hosts(): string[] { return this.#opts.hosts ?? [] }

  //! dialing — is a backoff chain still actively trying this target? Membership holds eviction while
  // true: an un-exhausted dial means reachability is UNKNOWN (e.g. the pending-redial window right
  // after a heal), and evicting then is churn a one-tick wait avoids. Give-up ends the hold.
  dialing(to: string): boolean {
    const b = this.#backoff.get(to)
    return !!b && !b.gaveUp
  }

  //! #revivable — the give-up revival target set: static hosts ∪ committed-view member listens (a
  // joiner learned via a VIEW is as entitled to revival as a configured host — it may OWN partitions).
  #revivable(): Set<string> {
    const targets = new Set(this.#opts.hosts ?? [])
    for (const [u, listen] of this.membership.view.members) if (u !== this.uuid && listen) targets.add(listen)
    return targets
  }

  //! step — the single dispatch site. Unknown event kinds fail closed (throw): an unrecognised stimulus is a harness bug, never something to guess at.
  step(e: Event) {
    if (this.destroyed) return
    const j = this.journal
    switch (e.kind) {
      case 'start': {
        j.armed && j.emit(JK.start)
        for (const to of this.#opts.hosts ?? []) if (to !== this.listen) {
          j.armed && j.emit(JK.dial, to)
          this.env.sink.connect(to)
        }
        if ((this.#opts.heartbeatMs ?? 0) > 0) this.#armHeartbeat()
        return
      }
      case 'linkUp': {
        const link = new Link(e.link, e.dialed, e.to)
        this.links.set(e.link, link)
        j.armed && j.emit(JK.linkUp, e.link, e.dialed ? 1 : 0)
        //! both sides open with HELLO — identity first, before anything routes
        link.ship(encodeControl(VERB.HELLO, { u: this.uuid, i: this.incarnation, l: this.listen }), this.env.sink, j)
        return
      }
      case 'bytesIn': {
        const link = this.links.get(e.link)
        if (!link || link.dead) return // raced close — ids are never reused, so late chunks are safely ignored
        //! the FrameError net covers BOTH framing AND dispatch: decode is LAZY, so a crc-valid frame with a
        // malformed body (bad vt, overrun count, trailing bytes) throws inside #dispatch when a getter first
        // touches it — outside this catch it would crash the node on one hostile frame (adversarial-review
        // critical finding). FrameError → drop the link; any other throw is a real bug and rethrows unmasked.
        try {
          for (const f of link.framer.push(e.bytes)) {
            this.#dispatch(link, f)
            if (link.dead) break
          }
        } catch (err) {
          if (!(err instanceof FrameError)) throw err
          j.armed && j.emit(JK.frameDrop, e.link, err.message)
          link.dead = true
          this.env.sink.close(e.link, 'wire-fault')
          return
        }
        link.flush(this.env.sink, j) // one frame per link per step, even when a chunk carried many inbound frames
        return
      }
      case 'linkDown': {
        const link = this.links.get(e.link)
        j.armed && j.emit(JK.linkDown, e.link, e.reason)
        if (!link) {
          //! a dial that FAILED before linkUp: no link entry exists, but `to` rides on the event — still schedule the redial
          if (e.to) this.#redial(e.to)
          return
        }
        this.links.delete(e.link)
        if (this.byUuid.get(link.uuid) === e.link) this.byUuid.delete(link.uuid)
        //! BOTH sides redial a lost peer (jittered capped backoff) — the dialer via its target, the
        // acceptor via the peer's gossiped listen. The acceptor-side chain is what arms the eviction
        // dialing-hold symmetrically (review: a 3-tick blip once evicted a live member from the acceptor
        // side, which held no chain) — crossing dials collapse via the one-link-per-pair dedup as usual.
        // Deliberate closes (dup-link/self-reject) never redial: that would just re-create the race.
        const redialTo = link.noRedial ? '' : link.dialed ? link.to ?? '' : link.listen
        if (redialTo) this.#redial(redialTo)
        //! a lost member link can flip the write-gate to minority — journal the transition NOW, not at the next tick
        if (link.state === LS.admitted) this.membership.settle(this)
        return
      }
      case 'pause': {
        const link = this.links.get(e.link)
        if (link) { link.paused = true; j.armed && j.emit(JK.pause, e.link) }
        return
      }
      case 'drain': {
        const link = this.links.get(e.link)
        if (!link) return
        link.drain(this.env.sink, j)
        //! drop-under-backpressure left the peer with a tail hole in our stream — follow the drain with a
        // digest exchange so the loss heals within two round-trips instead of lingering until the next admit
        if (link.droppedWhilePaused && link.state === LS.admitted) {
          link.droppedWhilePaused = false
          this.#sendDigest(link, 1)
        }
        return
      }
      case 'timer': {
        const meta = this.#timers.get(e.id)
        if (!meta) return // cancelled — the raced fire is ignored by id, per the Env contract
        this.#timers.delete(e.id)
        if (meta.tag === TAG.redial && meta.to) { j.armed && j.emit(JK.dial, meta.to); this.env.sink.connect(meta.to) }
        else if (meta.tag === TAG.heartbeat) {
          for (const link of this.links.values())
            //! lower-uuid side originates PINGs (halves N² probe traffic — v2's rule, kept). Paused links
            // are SKIPPED entirely: control frames queued into a drop-oldest queue are doomed work, and a
            // drain would flush every stale r=1 digest at once, each triggering a duplicate suffix ship
            // from the peer at the exact moment backpressure cleared (adversarial-review finding). The
            // drain path has its own digest re-sync; a paused link needs no floor.
            if (link.state === LS.admitted && !link.paused && this.uuid < link.uuid) {
              link.ship(encodeControl(VERB.PING), this.env.sink, j)
              j.armed && j.emit(JK.ping, link.id)
              //! the periodic AE floor (plan §5 "periodic floor in ALL modes"): the same reciprocal digest
              // exchange that heals admits and drains, on the heartbeat cadence — belt-and-braces against
              // any loss mode WITHOUT a reconnect/drain signal (transport bugs, future non-TCP shells).
              // One r=1 digest from the PING side covers both directions: the reply ships our gaps, and
              // receiving their digest ships theirs. Nothing missing ⇒ nothing shipped (idempotent).
              this.#sendDigest(link, 1)
            }
          //! membership acts on the heartbeat clock too (explicit protocol mode): genesis, suspicion,
          // eviction/join ballots, stale pulls, rejoin nudges — all only when heartbeats are on.
          this.membership.tick(this)
          //! the write pipeline's retry clock: in-flight attempts whose ACK/NACK never arrived re-park
          // after RETRY_TICKS and re-resolve + re-forward (cid dedup makes every retransmit safe).
          this.writes.tick(this)
          //! give-up revival: a target whose final redial attempt FAILED (gaveUp — never merely "tries
          // exhausted": the last armed attempt may still be pending, and dialing over it would fork a
          // second chain) is parked, not dead — each heartbeat re-dials any parked target we hold no link
          // to, with a fresh backoff chain (the M1 re-announce floor; full UDP discovery lands with
          // L0-complete). Targets are the static hosts PLUS the committed view's member listens
          // (adversarial-review wedge: a view-learned member — a joiner never in `hosts` — whose chain
          // gave up was parked FOREVER, stranding every attempt owner-routed to it). A live link to the
          // target — including one the PEER dialed — clears the stale give-up instead of dialing into a
          // dup race.
          for (const to of this.#revivable()) {
            if (to === this.listen) continue
            if (!this.#backoff.get(to)?.gaveUp) continue // never failed, or the redial chain still owns it
            let held = false
            for (const l of this.links.values()) if (!l.dead && (l.to === to || l.listen === to)) { held = true; break }
            this.#backoff.delete(to)
            if (held) continue
            j.armed && j.emit(JK.revive, to)
            this.env.sink.connect(to)
          }
          this.#armHeartbeat()
        }
        return
      }
      case 'write': {
        //! source=local into the single ingress (M3): epoch 0 + open gate is the M0/M1 fast path
        // (straight to commit); otherwise attempts are minted {cid, attemptEpoch, issuer} and routed —
        // committed here if we own the partition, forwarded to the owner if not, parked in the ONE
        // bounded queue if the gate is closed or the owner unreachable (kernel/write.ts).
        this.writes.issue(this, e.recs)
        return
      }
      default: {
        const never: never = e
        throw new Error(`unknown event ${(never as { kind: string }).kind}`)
      }
    }
  }

  //! commit — THE stamp site: {origin: me, seq: ++lamport, epoch: committed view}, then log, apply,
  // broadcast. Returns the FIRST stamped seq (a batch stamps contiguously — the write pipeline's
  // run-ACK coordinates derive from it). Called ONLY by kernel/write.ts (the single-ingress rule;
  // purity.test.ts lints the call sites) — local writes and inbound records share ONE ingest shape,
  // a local write being just the stream where origin === me. When the batch originated as a
  // forwarded/relayed ATTEMPT run, its identity (issuer, contiguous cids from baseCid) is logged and
  // broadcast with the records (FLAG_ATTEMPT), so replication feeds every node's cid-dedup window —
  // exactly-once then survives an ownership move (adversarial-review critical).
  commit(recs: Rec[], attempt?: AttemptRun): number {
    const j = this.journal
    const s0 = this.seq + 1
    for (let k = 0; k < recs.length; k++) {
      const rec = recs[k]
      const seq = ++this.seq
      const entry: { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number } = { rec, seq, epoch: this.epoch }
      if (attempt) { entry.iss = attempt.issuer; entry.cid = attempt.baseCid + k }
      this.logFor(this.uuid).push(entry) // the record is OWNED from here (embedder hands it over)
      this.apply(rec, this.uuid, seq, this.epoch)
      j.armed && j.emit(JK.writeLocal, seq, rec.key[0] ?? rec.at ?? '')
      //! the own stream's ladder advances at the stamp site: applied+shippable together (logged and
      // applied in this same step); durable waits for the M4b storage batch to resolve
      const d = this.streams.for(this.uuid)
      d.applied = d.shippable = seq
      for (const link of this.links.values())
        //! live records flow only on SYNCED links (admitted + peer digest received): anything earlier is
        // covered by the digest-triggered suffix ship, and sending it live would leapfrog that suffix on
        // the wire and turn it into permanently-dropped "duplicates" at the receiver (the sweep-found bug)
        if (link.state === LS.admitted && link.synced)
          link.add(rec, { origin: this.uuid, baseSeq: seq, epoch: this.epoch },
            attempt ? { issuer: attempt.issuer, baseCid: attempt.baseCid + k } : undefined)
    }
    for (const link of this.links.values()) link.flush(this.env.sink, j)
    return s0
  }

  #armHeartbeat() {
    const id = ++this.#timerSeq
    this.#hbTimer = id
    this.#timers.set(id, { tag: TAG.heartbeat })
    this.env.sink.timer(id, TAG.heartbeat, this.#opts.heartbeatMs!)
  }

  //! #redial — jittered capped exponential backoff per target, BOUNDED attempts; jitter comes from env.rng so trajectories stay seed-reproducible.
  // The give-up after MAX_REDIALS is what keeps a refused target from keeping the
  // sim's event queue (and a real process's timer wheel) alive forever; it is
  // journal-visible, and the heartbeat tick revives a given-up target (so with
  // heartbeats on, one exhausted chain re-arms per heartbeat interval, bounded).
  // A successful identify resets the counter.
  #redial(to: string) {
    if (this.destroyed) return
    const base = this.#opts.redialMs ?? 100
    const b = this.#backoff.get(to) ?? { ms: base, tries: 0 }
    if (b.tries >= MAX_REDIALS) {
      //! the final ARMED attempt has now FAILED — only here does the target become truly parked
      if (!b.gaveUp) {
        b.gaveUp = true
        this.#backoff.set(to, b)
        this.journal.armed && this.journal.emit(JK.giveUp, to)
      }
      return
    }
    this.#backoff.set(to, { ms: Math.min(b.ms * 2, base * 32), tries: b.tries + 1 })
    const delay = b.ms + Math.floor(this.env.rng() * base)
    const id = ++this.#timerSeq
    this.#timers.set(id, { tag: TAG.redial, to })
    this.env.sink.timer(id, TAG.redial, delay)
    this.journal.armed && this.journal.emit(JK.redial, delay, to)
  }

  //! #dispatch — per-frame verb routing; fails closed (journal + drop) on unknown verbs so control can never fall into the data path.
  #dispatch(link: Link, f: Frame) {
    const j = this.journal
    switch (f.verb) {
      case VERB.HELLO: {
        const v = f.value as { u?: unknown; i?: unknown; l?: unknown }
        if (typeof v?.u !== 'string' || typeof v.i !== 'number' || typeof v.l !== 'string') {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed hello')
          link.dead = true
          return this.env.sink.close(link.id, 'malformed-hello')
        }
        if (v.u === this.uuid) {
          //! self-reject by uuid — a gossip loop or misconfig dialled ourselves; never redial a self-loop
          j.armed && j.emit(JK.selfReject, link.id)
          link.dead = link.noRedial = true
          return this.env.sink.close(link.id, 'self')
        }
        const existingId = this.byUuid.get(v.u)
        if (existingId !== undefined && existingId !== link.id) {
          const existing = this.links.get(existingId)!
          //! one-logical-link-per-pair: keep the link dialed by the lower uuid; both ends compute the same winner.
          // The loser is marked dead+noRedial and closed — its linkDown echo cleans the map; deleting it here
          // would make the echo look like a failed dial and re-dial the pair back into the race.
          if (dialedByLower(link, this.uuid, v.u) && !dialedByLower(existing, this.uuid, v.u)) {
            existing.dead = existing.noRedial = true
            this.env.sink.close(existingId, 'dup-link')
            j.armed && j.emit(JK.dupLink, existingId, link.id)
          } else {
            link.dead = link.noRedial = true
            this.env.sink.close(link.id, 'dup-link')
            j.armed && j.emit(JK.dupLink, link.id, existingId)
            return
          }
        }
        link.uuid = v.u; link.incarnation = v.i; link.listen = v.l
        link.state = LS.admitted
        this.byUuid.set(v.u, link.id)
        //! successful identify resets the redial backoff — by OUR dial target AND by the peer's gossiped
        // listen: when the peer dialed us while our own chain to it was mid-backoff (or a dup-race left
        // our dialed link the loser), the listen-keyed entry would otherwise orphan with gaveUp unset,
        // reporting dialing() forever and permanently holding eviction (review finding)
        if (link.to) this.#backoff.delete(link.to)
        if (v.l) this.#backoff.delete(v.l)
        j.armed && j.emit(JK.identified, link.id, v.u, v.i)
        //! digest-on-admit, from BOTH ends (direction-independent — v2's dialer-gated catch-up trap is the
        // counterexample this rule exists for): each side announces what it holds; the peer ships the missing
        // suffixes. Every admit heals — first link, keeper-after-dup-race, reconnect-after-heal.
        this.#sendDigest(link, 1)
        //! view-on-admit (symmetric with digest-on-admit): announce the committed view so a healed peer's
        // membership converges even when no epoch-stamped records flow; then settle — an admitted member
        // can flip the gate back to majority, flushing any parked writes
        this.membership.onAdmit(this, link)
        this.membership.settle(this)
        return
      }
      case VERB.RECORDS: {
        //! identity before admission, ENFORCED (link.ts's claim, adversarial review caught it unguarded):
        // records on a link that has not completed HELLO are a protocol violation — close, don't ingest.
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'records before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'records-before-hello')
        }
        const prov = f.prov()
        if (!prov) {
          //! M0: every RECORDS frame carries provenance; an un-stamped one is a protocol violation, not data
          j.armed && j.emit(JK.frameDrop, link.id, 'records without prov')
          return
        }
        //! the epoch-staleness contract (plan §5): a record stamped above my committed view epoch is
        // evidence of a view I missed — close the gate NOW and pull the view on this same link
        if (prov.epoch > this.epoch) this.membership.staleObserved(this, prov.epoch, link)
        for (const rv of f.records()) this.writes.inbound(this, rv.origin, rv.seq, rv.epoch, rv)
        return
      }
      //! M3 write pipeline — WRITE (a forwarded attempt run / a client relay), WACK (commit
      // coordinates), WNACK (typed rejection). Identity-before-admission like everything else;
      // handlers live in kernel/write.ts. settle() runs after: an ACK/NACK can move the pending
      // queue, and a NACK's staleness evidence can flip the gate.
      case VERB.WRITE: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'write before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'write-before-hello')
        }
        this.writes.onWrite(this, link, f)
        this.membership.settle(this)
        return
      }
      case VERB.WACK:
      case VERB.WNACK: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'write-ack before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'write-ack-before-hello')
        }
        const v = f.value as Record<string, unknown>
        if (f.verb === VERB.WACK) this.writes.onAck(this, link, v)
        else this.writes.onNack(this, link, v)
        this.membership.settle(this)
        return
      }
      case VERB.PING:
        return link.ship(encodeControl(VERB.PONG), this.env.sink, j)
      case VERB.PONG:
        return // proof of life; liveness accounting lands with M2 membership
      case VERB.DIGEST: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'digest before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'digest-before-hello')
        }
        const v = f.value as { d?: Record<string, unknown>; r?: number }
        if (typeof v?.d !== 'object' || v.d === null) {
          j.armed && j.emit(JK.frameDrop, link.id, 'malformed digest')
          return
        }
        j.armed && j.emit(JK.digestIn, link.id)
        //! a PAUSED link cannot deliver: serialising the missing suffix into its drop-oldest queue is
        // O(suffix) work per digest that overflow then discards (adversarial-review finding — the peer's
        // heartbeat floor would trigger it every tick for the whole pause). Mark the debt instead; the
        // drain-time digest exchange re-announces on a FLOWING link and ships once. synced deliberately
        // untouched: an unsynced link stays unsynced (live writes withheld) until a real exchange lands.
        if (link.paused) {
          link.droppedWhilePaused = true
          return
        }
        //! ship every suffix the peer's digest shows missing: for each origin I hold, everything past their
        // high-water. encodeRuns splits Lamport gaps into valid contiguous frames (attempt identity rides
        // along, so a healed peer rebuilds its cid-dedup window too); ship() honours backpressure.
        let shipped = 0
        for (const [origin, entries] of this.logs) {
          const theirs = typeof v.d[origin] === 'number' ? (v.d[origin] as number) : 0
          let lo = entries.length
          while (lo > 0 && entries[lo - 1].seq > theirs) lo-- // entries are seq-ascending; find the missing suffix
          if (lo === entries.length) continue
          const missing = entries.slice(lo).map((e) => ({ rec: e.rec, origin, seq: e.seq, epoch: e.epoch, iss: e.iss, cid: e.cid }))
          for (const bytes of encodeRuns(missing)) link.ship(bytes, this.env.sink, j)
          shipped += missing.length
        }
        if (shipped) j.armed && j.emit(JK.aeShip, link.uuid, shipped)
        //! the peer's digest is what SYNCS the link: the suffix just shipped covers everything up to this
        // instant, and every record from here on has a higher seq — per-origin monotonicity holds on the wire
        link.synced = true
        //! r=1 means "answer with yours" — the reply carries r=0, so the exchange is two-legged, never a loop
        if (v.r === 1) this.#sendDigest(link, 0)
        return
      }
      //! M2 membership control plane — identity-before-membership: all five verbs require admission,
      // like DIGEST (a pre-admission membership frame is a protocol violation → close). Handlers live
      // in kernel/membership.ts; settle() runs after each so gate transitions journal and buffered
      // writes flush the moment a frame opens the gate.
      case VERB.JOIN:
      case VERB.PROPOSE:
      case VERB.VOTE:
      case VERB.VIEW:
      case VERB.PULL: {
        if (link.state !== LS.admitted) {
          j.armed && j.emit(JK.frameDrop, link.id, 'membership before hello')
          link.dead = true
          return this.env.sink.close(link.id, 'membership-before-hello')
        }
        const v = f.value as Record<string, unknown>
        if (f.verb === VERB.JOIN) this.membership.onJoin(this, link, v)
        else if (f.verb === VERB.PROPOSE) this.membership.onPropose(this, link, v)
        else if (f.verb === VERB.VOTE) this.membership.onVote(this, link, v)
        else if (f.verb === VERB.VIEW) this.membership.onView(this, link, v)
        else this.membership.onPull(this, link, v)
        this.membership.settle(this)
        return
      }
      default:
        j.armed && j.emit(JK.frameDrop, link.id, `unknown verb ${f.verb}`)
        return // drop the frame, keep the link — an unknown verb from a newer peer is not a wire fault
    }
  }

  //! logFor — per-origin log accessor (get-or-create). Kernel-internal: called by commit above and by
  // the write module's inbound ingest (source=inbound lives in kernel/write.ts with the other sources).
  logFor(origin: string): { rec: Rec; seq: number; epoch: number; iss?: string; cid?: number }[] {
    let l = this.logs.get(origin)
    if (!l) { l = []; this.logs.set(origin, l) }
    return l
  }

  //! #sendDigest — announce {origin: highestHeldSeq} (the log tails: exactly what this node can serve).
  #sendDigest(link: Link, r: 0 | 1) {
    const d: Record<string, number> = {}
    for (const [origin, entries] of this.logs) if (entries.length) d[origin] = entries[entries.length - 1].seq
    link.ship(encodeControl(VERB.DIGEST, { d, r }), this.env.sink, this.journal)
    this.journal.armed && this.journal.emit(JK.digestOut, link.id, r)
  }

  //! apply — the ONE record→state function (plan §3.3: exactly one projection path). Runs the per-cell
  // LWW election, mutates the state mirror, and emits the apply effect downstream. A record that loses
  // its election is SKIPPED but its stream watermark still advances (the caller's job) — losing is not
  // loss. Kernel-internal: called by commit and by the write module's inbound ingest, nothing else.
  apply(rec: Rec, origin: string, seq: number, epoch: number) {
    const k = JSON.stringify(rec.key.length ? rec.key : [rec.at ?? '']) // unambiguous internal key — wire keys stay length-prefixed
    //! LWW: lexicographic (epoch, seq, origin), identical on every node — apply iff strictly newer than the held stamp
    const cur = this.versions.get(k)
    if (cur && (epoch < cur.epoch || (epoch === cur.epoch && (seq < cur.seq || (seq === cur.seq && origin <= cur.origin))))) {
      this.journal.armed && this.journal.emit(JK.lwwSkip, origin, seq)
      return
    }
    this.versions.set(k, { epoch, seq, origin }) // a remove leaves this as a tombstone deliberately
    const old = this.#entryHash.get(k)
    if (old !== undefined) { this.#hash = (this.#hash - old) | 0 }
    if (rec.type === REC.remove) {
      this.state.delete(k)
      this.#entryHash.delete(k)
    } else {
      this.state.set(k, rec.value)
      const h = fnv(k + '' + stable(rec.value))
      this.#entryHash.set(k, h)
      this.#hash = (this.#hash + h) | 0
    }
    this.env.sink.apply({ type: rec.type, key: rec.key, value: rec.value, at: rec.at, origin, seq, epoch })
  }

  //! stateHash — order-insensitive rolling hash over entries: O(1) per apply, comparable per event (the sim's convergence + replay-determinism checks key off it).
  get stateHash(): number { return this.#hash | 0 }

  //! admitted — identified peer uuids (harness predicate: cluster formed ⇔ everyone admits everyone).
  // Dead links are EXCLUDED even before their linkDown echo: a dup-race loser is marked dead
  // synchronously, and counting it double-counted its uuid in genesis membership (review finding —
  // a committed view with a duplicated member permanently poisons majority arithmetic).
  admitted(): string[] {
    const out: string[] = []
    for (const l of this.links.values()) if (l.state === LS.admitted && !l.dead) out.push(l.uuid)
    return out
  }

  //! destroy — tear down every link and timer via effects (the env echoes linkDowns which are then ignored).
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const id of this.links.keys()) this.env.sink.close(id, 'destroy')
    for (const id of this.#timers.keys()) this.env.sink.cancel(id)
    this.#timers.clear()
  }
}

//! fnv — fnv-1a over a string; the per-entry hash the rolling state hash sums.
const fnv = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h | 0
}
//! stable — deterministic stringify (sorted object keys, NaN- and bytes-aware) for hashing and state
// comparison only; never on the wire path. Exported so sim monitors diff values with the SAME notion of
// equality the hash uses (JSON.stringify can't tell NaN from null — a diff that lies is worse than none).
export const stable = (v: unknown): string => {
  if (v === undefined) return 'u'
  if (v === null || typeof v !== 'object') return typeof v + ':' + String(v)
  if (v instanceof Uint8Array) return 'b:' + Array.from(v).join(',')
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => k + '=' + stable((v as Record<string, unknown>)[k])).join(',') + '}'
}
