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
import { STATUS } from '../transport/peer.ts'
import { VERB } from '../transport/message.ts'
import type { Mesh } from '../transport/index.ts'

export type View = { epoch: number; members: string[] }

export type ViewOpts = {
  me: string
  mesh: Mesh
  peers: any // cluster.peers ViewProxy — reachability is read from it
  interval?: number // coordinator tick (default 150ms)
  ackTimeout?: number // abort a proposal that hasn't reached quorum within this (default 1000ms)
  onCommit?: (view: View) => void // L2 hook: a new view committed (epoch/members changed)
}

const sortedEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export class ViewManager {
  epoch = 1
  members: string[]

  #me: string
  #mesh: Mesh
  #peers: any
  #ackTimeout: number
  #onCommit?: (v: View) => void

  // Ballot state. `promised` is the highest (epoch, proposer) this node has
  // accepted a PREPARE for — it refuses to ack a different proposer at that epoch.
  #promisedEpoch = 0
  #promisedProposer = ''
  #proposal?: { epoch: number; members: string[]; acks: Set<string>; timer?: ReturnType<typeof setTimeout> }
  #tick?: ReturnType<typeof setInterval>
  #lastProposable = '' // debounce: the proposable set seen on the previous tick

  constructor(opts: ViewOpts) {
    this.#me = opts.me
    this.#mesh = opts.mesh
    this.#peers = opts.peers
    this.#ackTimeout = opts.ackTimeout ?? 600
    this.#onCommit = opts.onCommit
    this.members = [opts.me] // boot as a solo view of self
    this.#mesh.installView(this.members)
    this.#tick = setInterval(() => this.#coordinate(), opts.interval ?? 150)
    this.#tick.unref?.()
  }

  destroy() {
    if (this.#tick) clearInterval(this.#tick)
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    this.#proposal = undefined
  }

  // Reachable cluster members: self + every dialed SERVER peer that is connected
  // and not suspect (the V0 failure detector's verdict). Inbound accepted sockets
  // are role 'client' (and keyed by an ephemeral port), so they're excluded — we
  // only ring nodes we can route to by their listen address.
  #reachable(): string[] {
    const out = new Set<string>([this.#me])
    const snap = this.#peers[VALUE] ?? {}
    for (const addr in snap) {
      const p = snap[addr]
      if (p && p.role === 'server' && p.status === STATUS.connected && !p.suspect) out.add(addr)
    }
    return [...out]
  }

  #coordinator(reachable: string[]): string {
    let lo = reachable[0]
    for (const a of reachable) if (a < lo) lo = a
    return lo
  }

  // Coordinator tick: if I'm the lowest reachable address and there are reachable
  // servers not yet in the committed view, propose to admit them. (V1b only ADDS
  // members — eviction/failover is V1c.)
  //
  // DEBOUNCE: propose only once the proposable set is STABLE across two ticks.
  // During mesh formation a node briefly sees a subset of peers (e.g. B sees C
  // before discovering the lower-addressed A) and would propose prematurely —
  // producing dueling proposals that the promise rule refuses, each wasting an
  // abort timeout. Waiting for stability lets the true coordinator emerge and
  // propose the full membership once, so the common case is a single clean round.
  #coordinate() {
    if (this.#proposal) return // a ballot is already in flight
    const reachable = this.#reachable()
    if (this.#coordinator(reachable) !== this.#me) {
      this.#lastProposable = ''
      return // not the coordinator
    }
    const proposed = [...new Set([...this.members, ...reachable])].sort()
    if (sortedEqual(proposed, this.members)) {
      this.#lastProposable = ''
      return // nothing new to admit
    }
    const key = proposed.join(',')
    if (key !== this.#lastProposable) {
      this.#lastProposable = key // first sighting — wait one tick for the set to settle
      return
    }
    this.#propose(proposed)
  }

  #propose(members: string[]) {
    const epoch = this.epoch + 1
    this.#promisedEpoch = epoch
    this.#promisedProposer = this.#me
    const proposal = { epoch, members, acks: new Set<string>([this.#me]), timer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.#proposal = proposal
    for (const m of members) if (m !== this.#me) this.#mesh.viewSend(m, VERB.VIEW_PREPARE, { epoch, members, proposer: this.#me })
    // Abort if quorum isn't reached in time → the next tick retries (dropping any
    // member that's gone unreachable in the meantime).
    proposal.timer = setTimeout(() => {
      if (this.#proposal === proposal) this.#proposal = undefined
    }, this.#ackTimeout)
    proposal.timer.unref?.()
    this.#tryCommit() // a single-new-member proposal may already be quorate via self
  }

  // ── inbound view frames (wired to mesh.onViewPrepare/onViewAck/onViewCommit) ──

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
    this.#mesh.viewSend(proposer, VERB.VIEW_ACK, { epoch, proposer, member: this.#me })
  }

  onAck(value: any) {
    const epoch = value?.epoch
    const proposer = value?.proposer
    const member = value?.member
    const p = this.#proposal
    if (!p || p.epoch !== epoch || proposer !== this.#me || typeof member !== 'string') return
    p.acks.add(member)
    this.#tryCommit()
  }

  #tryCommit() {
    const p = this.#proposal
    if (!p) return
    if (!this.#majority(this.members, p.acks)) return // majority of the OLD view
    if (!this.#majority(p.members, p.acks)) return // majority of the NEW view (joint consensus)
    for (const m of p.members) if (m !== this.#me) this.#mesh.viewSend(m, VERB.VIEW_COMMIT, { epoch: p.epoch, members: p.members })
    this.#install(p.epoch, p.members)
  }

  onCommit(value: any) {
    const epoch = value?.epoch
    const members = value?.members
    if (typeof epoch !== 'number' || !Array.isArray(members)) return
    if (epoch <= this.epoch) return
    this.#install(epoch, members)
  }

  onJoinRequest() {
    // V1b admits via reachability (the coordinator's tick), so an explicit
    // JOIN_REQUEST is a no-op here; it's the rejoin path in V1f.
  }

  #install(epoch: number, members: string[]) {
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    this.#proposal = undefined
    this.epoch = epoch
    this.members = members.slice().sort()
    if (epoch > this.#promisedEpoch) this.#promisedEpoch = epoch
    this.#mesh.installView(this.members) // rebuild the DHT ring to exactly this view
    this.#onCommit?.({ epoch: this.epoch, members: this.members })
  }

  #majority(set: string[], acks: Set<string>): boolean {
    let c = 0
    for (const m of set) if (acks.has(m)) c++
    return c * 2 > set.length
  }
}
