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
// M0 scope (plan-v3.md §11), stated exactly: full broadcast of own writes to
// admitted peers + whole-log replay to every newly-admitted peer (the retransmit
// buffer), gap-tolerant monotone high-water dedup per origin (Lamport seqs are
// NOT contiguous — there is deliberately no hold-back and no reorder tolerance:
// FIFO links are a PROTOCOL REQUIREMENT, provided by TCP and enforced in sim),
// per-cell LWW on lexicographic (epoch, seq, origin), Lamport clock merge-up.
// No membership ballots, no digest anti-entropy, no storage, no owner routing
// yet (M1-M4) — but their seams are shaped: `epoch` rides every frame and every
// LWW cell, ingest() is the single apply path, and streams are per-origin
// descriptor objects (not v2's four parallel string-keyed maps).
//
// The write path IS a function: a 'write' event enters ingest exactly like an
// inbound record does — apply is a downstream EFFECT, so re-entrant capture
// (v2's applying/committingForward/discarding flag family) has no place to
// exist. That whole guard menagerie is deleted by construction, not by care.

import { FrameError, VERB, encodeControl, encodeRuns, type Frame } from './codec.ts'
import { Link, LS, dialedByLower } from './link.ts'
import { JK, Journal } from './journal.ts'
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
}

//! Stream: per-origin ingest state — a single monotone high-water (the `applied` watermark, M0 form).
// Seqs are LAMPORT stamps, so per-origin streams are monotone but NOT contiguous
// (the clock merges up on receipt — a local write after hearing seq 9 stamps 10+).
// Dedup is therefore gap-tolerant: over a FIFO link from the single broadcaster,
// any arrival ≤ seen is a genuine duplicate and any arrival > seen is new — this
// is exactly what the in-order-single-broadcaster protocol requirement licenses
// (plan §5 ordering contract), stated here instead of living as v2 folklore.
// The plan's three-watermark descriptor (applied/shippable/durable) grows FROM
// this object at M1/M4 — one more field each, never one more parallel map
// (v2's seen/marks/persisted/versions constellation is the anti-pattern).
interface Stream {
  seen: number // highest applied-or-skipped seq for this origin — the applied watermark
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
  streams = new Map<string, Stream>()
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
  logs = new Map<string, { rec: Rec; seq: number; epoch: number }[]>()
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
    this.#opts = opts
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
        //! dialed links redial with jittered capped exponential backoff — EXCEPT deliberate closes (dup-link/self-reject), which would just re-create the race
        if (link.dialed && link.to && !link.noRedial) this.#redial(link.to)
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
          //! give-up revival: a target whose final redial attempt FAILED (gaveUp — never merely "tries
          // exhausted": the last armed attempt may still be pending, and dialing over it would fork a
          // second chain) is parked, not dead — each heartbeat re-dials any parked host we hold no link
          // to, with a fresh backoff chain (the M1 re-announce floor; full UDP discovery lands with
          // L0-complete). A live link to the host — including one the PEER dialed — clears the stale
          // give-up instead of dialing into a dup race.
          for (const to of this.#opts.hosts ?? []) {
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
        //! local writes and inbound records share ONE ingest path; a local write is just the stream where origin === me.
        for (const rec of e.recs) {
          const seq = ++this.seq
          this.#logFor(this.uuid).push({ rec, seq, epoch: this.epoch }) // the record is OWNED from here (embedder hands it over)
          this.#apply(rec, this.uuid, seq, this.epoch)
          j.armed && j.emit(JK.writeLocal, seq, rec.key[0] ?? rec.at ?? '')
          for (const link of this.links.values())
            //! live records flow only on SYNCED links (admitted + peer digest received): anything earlier is
            // covered by the digest-triggered suffix ship, and sending it live would leapfrog that suffix on
            // the wire and turn it into permanently-dropped "duplicates" at the receiver (the sweep-found bug)
            if (link.state === LS.admitted && link.synced)
              link.add(rec, { origin: this.uuid, baseSeq: seq, epoch: this.epoch })
        }
        for (const link of this.links.values()) link.flush(this.env.sink, j)
        return
      }
      default: {
        const never: never = e
        throw new Error(`unknown event ${(never as { kind: string }).kind}`)
      }
    }
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
        if (link.to) this.#backoff.delete(link.to) // successful identify resets the redial backoff
        j.armed && j.emit(JK.identified, link.id, v.u, v.i)
        //! digest-on-admit, from BOTH ends (direction-independent — v2's dialer-gated catch-up trap is the
        // counterexample this rule exists for): each side announces what it holds; the peer ships the missing
        // suffixes. Every admit heals — first link, keeper-after-dup-race, reconnect-after-heal.
        this.#sendDigest(link, 1)
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
        for (const rv of f.records()) this.#ingest(rv.origin, rv.seq, rv.epoch, rv)
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
        // high-water. encodeRuns splits Lamport gaps into valid contiguous frames; ship() honours backpressure.
        let shipped = 0
        for (const [origin, entries] of this.logs) {
          const theirs = typeof v.d[origin] === 'number' ? (v.d[origin] as number) : 0
          let lo = entries.length
          while (lo > 0 && entries[lo - 1].seq > theirs) lo-- // entries are seq-ascending; find the missing suffix
          if (lo === entries.length) continue
          const missing = entries.slice(lo).map((e) => ({ rec: e.rec, origin, seq: e.seq, epoch: e.epoch }))
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
      default:
        j.armed && j.emit(JK.frameDrop, link.id, `unknown verb ${f.verb}`)
        return // drop the frame, keep the link — an unknown verb from a newer peer is not a wire fault
    }
  }

  //! #ingest — the single inbound apply path: gap-tolerant monotone dedup, then the LWW election in #apply.
  // The FIFO-link + single-broadcaster requirement means arrival order IS stream
  // order, so one comparison decides duplicate-vs-new; there is no hold-back
  // buffer to bound, drain, or leak. (A record that lost its LWW election still
  // advances `seen` — losing an election is not loss; v2's B1 lesson, kept.)
  #ingest(origin: string, seq: number, epoch: number, rv: { rec(): Rec }) {
    //! Lamport merge-up happens on RECEIPT (even for records that lose LWW) —
    // the clock tracks everything observed, which is what makes the next local write causally newest.
    if (seq > this.seq) this.seq = seq
    const j = this.journal
    let s = this.streams.get(origin)
    if (!s) { s = { seen: 0 }; this.streams.set(origin, s) }
    if (seq <= s.seen) { j.armed && j.emit(JK.dupDrop, origin, seq); return }
    s.seen = seq
    const rec = rv.rec() // ONE copy out of the receive chunk, shared by the log entry and the apply
    //! stored BEFORE the LWW election — losers are logged too (the election re-runs identically at every
    // node, and this copy may be the only one a lagging peer is ever offered via anti-entropy)
    this.#logFor(origin).push({ rec, seq, epoch })
    this.#apply(rec, origin, seq, epoch)
    j.armed && j.emit(JK.applyInbound, origin, seq)
  }

  #logFor(origin: string): { rec: Rec; seq: number; epoch: number }[] {
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

  //! #apply — the ONE record→state function (plan §3.3: exactly one projection path). Runs the per-cell
  // LWW election, mutates the state mirror, and emits the apply effect downstream. A record that loses
  // its election is SKIPPED but its stream watermark still advances (the caller's job) — losing is not loss.
  #apply(rec: Rec, origin: string, seq: number, epoch: number) {
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
  admitted(): string[] {
    const out: string[] = []
    for (const l of this.links.values()) if (l.state === LS.admitted) out.push(l.uuid)
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
