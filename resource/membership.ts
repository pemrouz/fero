//! View-synchronous membership: a Paxos-flavoured view-change state machine keeping ownership stable per view.
// View-synchronous membership — the view-change state machine (Milestone V).
//
// Membership changes in lockstep: the cluster agrees on a sequence of numbered
// VIEWS ({ epoch, members }), and ownership (the DHT ring) is STABLE within a
// view. This is what makes owner-routed writes (F1) and per-partition sequencing
// (F2) tractable — without it the ring churns on every connect/disconnect and
// nodes transiently disagree on owner(K).
//
// Protocol (V1b — happy-path admit/merge; failover, partition read-only, drain
// and two-cluster merge are layered in V1c–V1f):
//
//   • A soft coordinator — the lowest-address REACHABLE node — proposes view
//     changes. Everyone agrees on "lowest address", so no election is needed
//     within a view; a node never proposes if it isn't the coordinator, which
//     stops two singletons from issuing dueling proposals.
//   • A view change is a single-decree ballot, Paxos-flavoured:
//       PREPARE(epoch, members, proposer) → members PROMISE + VIEW_ACK
//                                         → on quorum, VIEW_COMMIT(epoch, members)
//     PROMISE semantics (a node acks at most ONE proposer per epoch, and never a
//     lower epoch than it has promised) make `epoch` a unique per-view token —
//     two proposers cannot both commit the same epoch, so no split-brain at an
//     identical epoch.
//   • JOINT-CONSENSUS quorum: a commit needs a majority of BOTH the old view and
//     the new view. Two disjoint subsets can't both be a majority of the same
//     set, so at most one view ever commits per epoch even under a partition.
//   • Reachability is the failure detector's verdict (V0): a server peer that is
//     connected and NOT suspect. An un-ackable (asymmetrically-reachable) member
//     simply never acks, so the new-view majority isn't reached and the proposal
//     aborts + retries without it — no explicit bidi handshake needed here.

import { value as VALUE } from '../../data/index.ts'
import { STATUS, type Mesh } from '../transport/index.ts' // L0 public seam — no reach into peer.ts/message.ts internals

//! A numbered cluster view: a monotonic epoch + the set of member addresses ownership is computed from.
export type View = { epoch: number; members: string[] }

//! ViewManager construction options: identity, mesh seam, reachability source, timers, and L2 commit/writable hooks.
export type ViewOpts = {
  me: string
  mesh: Mesh
  peers: any // cluster.peers ViewProxy — reachability is read from it
  interval?: number // coordinator tick (default 150ms)
  ackTimeout?: number // abort a proposal that hasn't reached quorum within this (default 600ms)
  evictAfter?: number // grace before evicting a continuously-unreachable member (default 1500ms)
  announce?: number // re-announce the committed view this often (default 600ms) — split-brain-heal reconcile + missed-commit recovery
  now?: () => number // injectable clock (tests); defaults to Date.now
  onCommit?: (view: View) => void // L2 hook: a new view committed (epoch/members changed)
  onWritable?: (writable: boolean) => void // L2 hook: quorum reachability changed (the write-gate)
}

//! Equality of two already-sorted address lists (members compared in canonical order).
const sortedEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

//! Drives the view-change ballot: coordinator proposes, members PREPARE/ACK, quorum commits a new view.
export class ViewManager {
  epoch = 1
  members: string[]
  canWrite = true // can we currently reach a majority of the view? (the write-gate)

  #me: string
  #mesh: Mesh
  #peers: any
  #ackTimeout: number
  #evictAfter: number
  #announce: number
  #lastAnnounce = 0 // last time we re-announced our committed view (throttle)
  #seenEpoch = 0 // highest committed epoch heard from ANY reachable peer — drives split-brain-heal re-propose
  #now: () => number
  #onCommit?: (v: View) => void
  #onWritable?: (w: boolean) => void

  //! Ballot state: the highest (epoch, proposer) promised here, plus any proposal we're driving as coordinator.
  // Ballot state. `promised` is the highest (epoch, proposer) this node has
  // accepted a PREPARE for — it refuses to ack a different proposer at that epoch.
  #promisedEpoch = 0
  #promisedProposer = ''
  #promiseTimer?: ReturnType<typeof setTimeout> // releases a promise if its ballot never commits (dead proposer)
  #proposal?: { epoch: number; members: string[]; acks: Set<string>; timer?: ReturnType<typeof setTimeout> }
  #highestProposed = 0 // highest epoch we've ever PROPOSED — each new ballot uses a fresh epoch above it
  #tick?: ReturnType<typeof setInterval>
  #lastProposable = '' // debounce: the proposable set seen on the previous tick
  #unreachableSince = new Map<string, number>() // member → when it first went unreachable (eviction grace)

  //! Boot as a solo view of self, install its ring, and start the coordinator tick.
  constructor(opts: ViewOpts) {
    this.#me = opts.me
    this.#mesh = opts.mesh
    this.#peers = opts.peers
    this.#ackTimeout = opts.ackTimeout ?? 600
    this.#evictAfter = opts.evictAfter ?? 1500
    this.#announce = opts.announce ?? 600
    this.#now = opts.now ?? Date.now
    this.#onCommit = opts.onCommit
    this.#onWritable = opts.onWritable
    this.members = [opts.me] // boot as a solo view of self
    this.#mesh.installView(this.members)
    this.#tick = setInterval(() => this.#coordinate(), opts.interval ?? 150)
    this.#tick.unref?.()
  }

  //! Tear down: stop the tick and clear any in-flight ballot/promise timers.
  destroy() {
    if (this.#tick) clearInterval(this.#tick)
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    if (this.#promiseTimer) clearTimeout(this.#promiseTimer)
    this.#proposal = undefined
  }

  //! Reachable members = self + every dialed server peer that is connected and not suspect (V0's verdict).
  // Reachable cluster members: self + every dialed SERVER peer that is connected
  // and not suspect (the V0 failure detector's verdict). An inbound accepted server
  // socket folds into its dialed listen-address row (a receive shadow that owns no
  // row), and a client stays role 'client' — either way we ring only the dialed,
  // listen-keyed server rows, i.e. nodes we can route to by their listen address.
  #reachable(): string[] {
    const out = new Set<string>([this.#me])
    const snap = this.#peers[VALUE] ?? {}
    for (const addr in snap) {
      const p = snap[addr]
      if (p && p.role === 'server' && p.status === STATUS.connected && !p.suspect) out.add(addr)
    }
    return [...out]
  }

  //! The coordinator is the lowest-address reachable node — everyone agrees, so no election is needed.
  #coordinator(reachable: string[]): string {
    let lo = reachable[0]
    for (const a of reachable) if (a < lo) lo = a
    return lo
  }

  //! Coordinator tick: recompute the write-gate, then (if coordinator) propose admits/evicts once the set is stable.
  // Coordinator tick. The coordinator is the lowest-address REACHABLE node, so
  // when it dies the next-lowest takes over automatically (failover) — no separate
  // election. It proposes a view that ADMITS reachable non-members and EVICTS
  // members that have been continuously unreachable past the eviction grace (the
  // grace + the V0 detector's own miss threshold avoid evicting on a brief blip).
  //
  // DEBOUNCE: propose only once the proposable set is STABLE across two ticks.
  // During mesh formation (or a flapping peer) a node briefly sees a subset, and
  // proposing prematurely produces dueling/aborted rounds. Waiting for stability
  // lets the true coordinator propose the settled membership once.
  #coordinate() {
    const reachableArr = this.#reachable()
    const reachable = new Set(reachableArr)
    this.#updateWritable(reachable) // the write-gate — recomputed every tick, for ALL nodes
    this.#reannounce(reachableArr) // gossip our committed view (split-brain-heal reconcile + missed-commit recovery)
    if (this.#proposal) return // a ballot is already in flight
    const now = this.#now()

    //! Eviction-grace bookkeeping: track when each member first went unreachable.
    for (const m of this.members) {
      if (reachable.has(m)) this.#unreachableSince.delete(m)
      else if (!this.#unreachableSince.has(m)) this.#unreachableSince.set(m, now)
    }

    if (this.#coordinator(reachableArr) !== this.#me) {
      this.#lastProposable = ''
      return // not the lowest reachable → not the coordinator
    }

    //! Keep members that are reachable OR still within the eviction grace; drop expired; add new reachable servers.
    // Keep members that are reachable OR still within the eviction grace; drop
    // those unreachable past the grace; add newly-reachable servers.
    const kept = this.members.filter((m) => reachable.has(m) || now - (this.#unreachableSince.get(m) ?? now) < this.#evictAfter)
    const proposed = [...new Set([...kept, ...reachableArr])].sort()
    //! Propose on a member-set delta OR on epoch divergence — a higher committed epoch among reachable peers means a split healed and our two views must merge.
    // The member-set-unchanged early-return used to DEADLOCK a partition heal: after
    // {A,B}|{C,D,E} heals, the merged coordinator A is back at its OLD view {A..E}@1 while
    // {C,D,E} committed @2; A's reachable == its members, so it saw no delta and never
    // re-proposed — two committed epochs forever. #seenEpoch (learned from the re-announce
    // below) lets A detect "a higher view exists" and propose a fresh unifying view even
    // when its own member set is unchanged.
    if (sortedEqual(proposed, this.members) && this.#seenEpoch <= this.epoch) {
      this.#lastProposable = ''
      return // membership unchanged AND no higher epoch to reconcile
    }
    const key = proposed.join(',')
    if (key !== this.#lastProposable) {
      this.#lastProposable = key // first sighting — wait one tick for the set to settle
      return
    }
    this.#propose(proposed)
  }

  //! Re-broadcast our committed view to all reachable peers (throttled) — the backstop for split-brain heal + a dropped VIEW_COMMIT.
  // Sent by the lowest-address reachable member of OUR OWN committed view (so each side of a
  // partition has exactly one announcer — the merged-set coordinator alone wouldn't surface the
  // OTHER side's higher epoch, since that side goes quiet once it sees a lower address). Reuses
  // VIEW_COMMIT (idempotent via onCommit's epoch guard) — no new wire verb. Two effects on the
  // receiver: a member that MISSED the original commit (its socket was momentarily un-writable)
  // adopts the view now (recovery); a node BEHIND a higher epoch records #seenEpoch so its
  // coordinator re-proposes a merge. O(reachable) frames every `announce` ms from ONE node per view.
  #reannounce(reachableArr: string[]) {
    const now = this.#now()
    if (now - this.#lastAnnounce < this.#announce) return
    // announce iff I'm the lowest-address reachable member of my own committed view
    let lowestInView: string | undefined
    for (const m of this.members) if (m === this.#me || reachableArr.includes(m)) { if (lowestInView === undefined || m < lowestInView) lowestInView = m }
    if (lowestInView !== this.#me) return
    this.#lastAnnounce = now
    const payload = { epoch: this.epoch, members: this.members }
    for (const a of reachableArr) if (a !== this.#me) this.#mesh.viewCommit(a, payload)
  }

  #propose(members: string[]) {
    //! Open a ballot at a fresh epoch, self-promise, PREPARE every member, and arm an abort-on-timeout.
    // Fresh ballot ABOVE anything we've committed, promised, or proposed — so a
    // retry or a failover proposal overrides a stuck promise left by a dead
    // proposer at the previous epoch (else same-epoch + different-proposer would
    // be refused by the promise rule and the cluster couldn't make progress).
    const epoch = Math.max(this.epoch, this.#promisedEpoch, this.#highestProposed) + 1
    this.#highestProposed = epoch
    this.#promisedEpoch = epoch
    this.#promisedProposer = this.#me
    const proposal = { epoch, members, acks: new Set<string>([this.#me]), timer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.#proposal = proposal
    for (const m of members) if (m !== this.#me) this.#mesh.viewPrepare(m, { epoch, members, proposer: this.#me })
    // Abort if quorum isn't reached in time → the next tick retries (dropping any
    // member that's gone unreachable in the meantime).
    proposal.timer = setTimeout(() => {
      if (this.#proposal === proposal) this.#proposal = undefined
    }, this.#ackTimeout)
    proposal.timer.unref?.()
    this.#tryCommit() // a single-new-member proposal may already be quorate via self
  }

  //! ── inbound view frames (wired to mesh.onViewPrepare/onViewAck/onViewCommit) ──

  //! PREPARE handler: promise this ballot iff it's a higher epoch (or same epoch from the same proposer), then ACK.
  onPrepare(value: any) {
    const epoch = value?.epoch
    const members = value?.members
    const proposer = value?.proposer
    if (typeof epoch !== 'number' || !Array.isArray(members) || typeof proposer !== 'string') return
    if (epoch <= this.epoch) return // already in this view or beyond
    if (epoch < this.#promisedEpoch) return // promised a higher ballot
    if (epoch === this.#promisedEpoch && proposer !== this.#promisedProposer) return // promised another proposer this epoch
    this.#promisedEpoch = epoch
    this.#promisedProposer = proposer
    //! Arm a promise-release timer so a dead proposer's ballot can't block this epoch forever.
    // Release the promise if this ballot never commits — the proposer may have
    // died mid-2PC. Without this, we'd stay promised to a dead proposer and refuse
    // a new coordinator's ballot at this epoch forever. (A fresh higher ballot also
    // overrides it, but releasing lets a re-proposal at the SAME epoch proceed.)
    if (this.#promiseTimer) clearTimeout(this.#promiseTimer)
    this.#promiseTimer = setTimeout(() => {
      if (this.#promisedEpoch === epoch && this.epoch < epoch) {
        this.#promisedEpoch = this.epoch
        this.#promisedProposer = ''
      }
    }, this.#ackTimeout * 2)
    this.#promiseTimer.unref?.()
    this.#mesh.viewAck(proposer, { epoch, proposer, member: this.#me })
  }

  //! ACK handler: record a member's vote for our current ballot, then test for quorum.
  onAck(value: any) {
    const epoch = value?.epoch
    const proposer = value?.proposer
    const member = value?.member
    const p = this.#proposal
    if (!p || p.epoch !== epoch || proposer !== this.#me || typeof member !== 'string') return
    p.acks.add(member)
    this.#tryCommit()
  }

  //! Commit once acks form a majority of BOTH old and new views (joint consensus): broadcast COMMIT, then install.
  #tryCommit() {
    const p = this.#proposal
    if (!p) return
    if (!this.#majority(this.members, p.acks)) return // majority of the OLD view
    if (!this.#majority(p.members, p.acks)) return // majority of the NEW view (joint consensus)
    for (const m of p.members) if (m !== this.#me) this.#mesh.viewCommit(m, { epoch: p.epoch, members: p.members })
    this.#install(p.epoch, p.members)
  }

  //! COMMIT handler: adopt a newer view that INCLUDES us; record the epoch high-water either way.
  // Doubles as the re-announce receiver (#reannounce reuses VIEW_COMMIT). Always advance
  // #seenEpoch (the divergence signal the coordinator re-proposes on). Install only a higher
  // epoch whose members INCLUDE us: a real ballot commit reaches its new members (the
  // happy path AND the missed-commit re-announce recovery); a node hearing a higher view it's
  // NOT in (the stale side of a healed partition) must NOT self-orphan into it — its
  // coordinator proposes a merge that RE-ADMITS it. (A genuinely-evicted node is unreachable,
  // so it never receives this; the write-gate already holds it read-only.)
  onCommit(value: any) {
    const epoch = value?.epoch
    const members = value?.members
    if (typeof epoch !== 'number' || !Array.isArray(members)) return
    if (epoch > this.#seenEpoch) this.#seenEpoch = epoch
    if (epoch <= this.epoch) return
    if (!members.includes(this.#me)) return // a higher view we're excluded from → let our coordinator merge us back in, don't self-orphan
    this.#install(epoch, members)
  }

  //! JOIN_REQUEST is a no-op in V1b (admission is reachability-driven); it becomes the rejoin path in V1f.
  onJoinRequest() {
    // V1b admits via reachability (the coordinator's tick), so an explicit
    // JOIN_REQUEST is a no-op here; it's the rejoin path in V1f.
  }

  //! Adopt a committed view: clear ballot state, set epoch/members, rebuild the DHT ring, fire onCommit.
  #install(epoch: number, members: string[]) {
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    if (this.#promiseTimer) clearTimeout(this.#promiseTimer)
    this.#proposal = undefined
    this.epoch = epoch
    this.members = members.slice().sort()
    if (epoch > this.#promisedEpoch) this.#promisedEpoch = epoch
    if (epoch > this.#highestProposed) this.#highestProposed = epoch
    if (epoch > this.#seenEpoch) this.#seenEpoch = epoch // keep the divergence high-water at-or-above our own epoch
    // drop eviction-grace tracking for nodes no longer in the view; still-members
    // that remain unreachable keep their timer (the next tick re-evaluates).
    for (const m of [...this.#unreachableSince.keys()]) if (!this.members.includes(m)) this.#unreachableSince.delete(m)
    this.#mesh.installView(this.members) // rebuild the DHT ring to exactly this view
    this.#onCommit?.({ epoch: this.epoch, members: this.members })
  }

  //! Strict majority: more than half of `set` appears in `acks`.
  #majority(set: string[], acks: Set<string>): boolean {
    let c = 0
    for (const m of set) if (acks.has(m)) c++
    return c * 2 > set.length
  }

  //! Recompute the write-gate: writable iff I reach a majority of my view; a minority side must buffer, not commit.
  // Write-gate: can I reach a MAJORITY of my committed view? If not (a partition's
  // minority side, or a quorum-less remnant), writes must NOT commit — they buffer
  // until quorum returns — so two sides can't both accept writes and diverge. A
  // CACHED boolean recomputed only here (every tick) and on commit, so the write
  // path reads one flag (no per-write O(members) scan).
  #updateWritable(reachable: Set<string>) {
    let inView = 0
    for (const m of this.members) if (reachable.has(m)) inView++
    const w = inView * 2 > this.members.length
    if (w !== this.canWrite) {
      this.canWrite = w
      this.#onWritable?.(w)
    }
  }
}
