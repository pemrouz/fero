// View-synchronous membership: a Paxos-flavoured view-change state machine keeping ownership stable per view.

import { value as VALUE } from '../../data/index.ts'
import { STATUS, type Mesh } from '../transport/index.ts'

// A numbered cluster view: a monotonic epoch + the set of member addresses ownership is computed from.
export type View = { epoch: number; members: string[] }

// ViewManager construction options: identity, mesh seam, reachability source, timers, and L2 commit/writable hooks.
export type ViewOpts = {
  me: string
  mesh: Mesh
  peers: any
  interval?: number
  ackTimeout?: number
  evictAfter?: number
  announce?: number
  now?: () => number
  onCommit?: (view: View) => void
  onWritable?: (writable: boolean) => void
}

// Equality of two already-sorted address lists (members compared in canonical order).
const sortedEqual = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// VIEW_HISTORY_CAP: how many past committed views to retain for L4 introspection — a bounded ring, oldest dropped.
const VIEW_HISTORY_CAP = 16

// Drives the view-change ballot: coordinator proposes, members PREPARE/ACK, quorum commits a new view.
export class ViewManager {
  epoch = 1
  members: string[]
  canWrite = true

  #me: string
  #mesh: Mesh
  #peers: any
  #ackTimeout: number
  #evictAfter: number
  #announce: number
  #lastAnnounce = 0
  #seenEpoch = 0
  #history: View[] = []
  #now: () => number
  #onCommit?: (v: View) => void
  #onWritable?: (w: boolean) => void

  // Ballot state: the highest (epoch, proposer) promised here, plus any proposal we're driving as coordinator.
  #promisedEpoch = 0
  #promisedProposer = ''
  #promiseTimer?: ReturnType<typeof setTimeout>
  #proposal?: { epoch: number; members: string[]; acks: Set<string>; timer?: ReturnType<typeof setTimeout> }
  #highestProposed = 0
  #tick?: ReturnType<typeof setInterval>
  #lastProposable = ''
  #unreachableSince = new Map<string, number>()

  // Boot as a solo view of self, install its ring, and start the coordinator tick.
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
    this.members = [opts.me]
    this.#mesh.installView(this.members)
    this.#tick = setInterval(() => this.#coordinate(), opts.interval ?? 150)
    this.#tick.unref?.()
  }

  // Tear down: stop the tick and clear any in-flight ballot/promise timers.
  destroy() {
    if (this.#tick) clearInterval(this.#tick)
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    if (this.#promiseTimer) clearTimeout(this.#promiseTimer)
    this.#proposal = undefined
  }

  // Reachable members = self + every dialed server peer that is connected and not suspect (V0's verdict).
  #reachable(): string[] {
    const out = new Set<string>([this.#me])
    const snap = this.#peers[VALUE] ?? {}
    for (const addr in snap) {
      const p = snap[addr]
      if (p && p.role === 'server' && p.status === STATUS.connected && !p.suspect) out.add(addr)
    }
    return [...out]
  }

  // The coordinator is the lowest-address reachable node — everyone agrees, so no election is needed.
  #coordinator(reachable: string[]): string {
    let lo = reachable[0]
    for (const a of reachable) if (a < lo) lo = a
    return lo
  }

  // Coordinator tick: recompute the write-gate, then (if coordinator) propose admits/evicts once the set is stable.
  #coordinate() {
    const reachableArr = this.#reachable()
    const reachable = new Set(reachableArr)
    this.#updateWritable(reachable)
    this.#reannounce(reachableArr)
    if (this.#proposal) return
    const now = this.#now()

    // Eviction-grace bookkeeping: track when each member first went unreachable.
    for (const m of this.members) {
      if (reachable.has(m)) this.#unreachableSince.delete(m)
      else if (!this.#unreachableSince.has(m)) this.#unreachableSince.set(m, now)
    }

    if (this.#coordinator(reachableArr) !== this.#me) {
      this.#lastProposable = ''
      return
    }

    // Keep members that are reachable OR still within the eviction grace; drop expired; add new reachable servers.
    const kept = this.members.filter((m) => reachable.has(m) || now - (this.#unreachableSince.get(m) ?? now) < this.#evictAfter)
    const proposed = [...new Set([...kept, ...reachableArr])].sort()
    // Propose on a member-set delta OR on epoch divergence — a higher committed epoch among reachable peers means a split healed and our two views must merge.
    if (sortedEqual(proposed, this.members) && this.#seenEpoch <= this.epoch) {
      this.#lastProposable = ''
      return
    }
    const key = proposed.join(',')
    if (key !== this.#lastProposable) {
      this.#lastProposable = key
      return
    }
    this.#propose(proposed)
  }

  // Re-broadcast our committed view to all reachable peers (throttled) — the backstop for split-brain heal + a dropped VIEW_COMMIT.
  #reannounce(reachableArr: string[]) {
    const now = this.#now()
    if (now - this.#lastAnnounce < this.#announce) return
    let lowestInView: string | undefined
    for (const m of this.members) if (m === this.#me || reachableArr.includes(m)) { if (lowestInView === undefined || m < lowestInView) lowestInView = m }
    if (lowestInView !== this.#me) return
    this.#lastAnnounce = now
    const payload = { epoch: this.epoch, members: this.members }
    for (const a of reachableArr) if (a !== this.#me) this.#mesh.viewCommit(a, payload)
  }

  #propose(members: string[]) {
    // Open a ballot at a fresh epoch, self-promise, PREPARE every member, and arm an abort-on-timeout.
    const epoch = Math.max(this.epoch, this.#promisedEpoch, this.#highestProposed) + 1
    this.#highestProposed = epoch
    this.#promisedEpoch = epoch
    this.#promisedProposer = this.#me
    const proposal = { epoch, members, acks: new Set<string>([this.#me]), timer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.#proposal = proposal
    for (const m of members) if (m !== this.#me) this.#mesh.viewPrepare(m, { epoch, members, proposer: this.#me })
    proposal.timer = setTimeout(() => {
      if (this.#proposal === proposal) this.#proposal = undefined
    }, this.#ackTimeout)
    proposal.timer.unref?.()
    this.#tryCommit()
  }

  // ── inbound view frames (wired to mesh.onViewPrepare/onViewAck/onViewCommit) ──

  // PREPARE handler: promise this ballot iff it's a higher epoch (or same epoch from the same proposer), then ACK.
  onPrepare(value: any) {
    const epoch = value?.epoch
    const members = value?.members
    const proposer = value?.proposer
    if (typeof epoch !== 'number' || !Array.isArray(members) || typeof proposer !== 'string') return
    if (epoch <= this.epoch) return
    if (epoch < this.#promisedEpoch) return
    if (epoch === this.#promisedEpoch && proposer !== this.#promisedProposer) return
    this.#promisedEpoch = epoch
    this.#promisedProposer = proposer
    // Arm a promise-release timer so a dead proposer's ballot can't block this epoch forever.
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

  // ACK handler: record a member's vote for our current ballot, then test for quorum.
  onAck(value: any) {
    const epoch = value?.epoch
    const proposer = value?.proposer
    const member = value?.member
    const p = this.#proposal
    if (!p || p.epoch !== epoch || proposer !== this.#me || typeof member !== 'string') return
    p.acks.add(member)
    this.#tryCommit()
  }

  // Commit once acks form a majority of BOTH old and new views (joint consensus): broadcast COMMIT, then install.
  #tryCommit() {
    const p = this.#proposal
    if (!p) return
    if (!this.#majority(this.members, p.acks)) return
    if (!this.#majority(p.members, p.acks)) return
    for (const m of p.members) if (m !== this.#me) this.#mesh.viewCommit(m, { epoch: p.epoch, members: p.members })
    this.#install(p.epoch, p.members)
  }

  // COMMIT handler: adopt a newer view that INCLUDES us; record the epoch high-water either way.
  onCommit(value: any) {
    const epoch = value?.epoch
    const members = value?.members
    if (typeof epoch !== 'number' || !Array.isArray(members)) return
    if (epoch > this.#seenEpoch) this.#seenEpoch = epoch
    if (epoch <= this.epoch) return
    if (!members.includes(this.#me)) return
    this.#install(epoch, members)
  }

  // JOIN_REQUEST is a no-op in V1b (admission is reachability-driven); it becomes the rejoin path in V1f.
  onJoinRequest() {
  }

  // Adopt a committed view: clear ballot state, set epoch/members, rebuild the DHT ring, fire onCommit.
  #install(epoch: number, members: string[]) {
    if (this.#proposal?.timer) clearTimeout(this.#proposal.timer)
    if (this.#promiseTimer) clearTimeout(this.#promiseTimer)
    this.#proposal = undefined
    this.epoch = epoch
    this.members = members.slice().sort()
    if (!this.#history.length || this.#history[this.#history.length - 1].epoch !== epoch) {
      this.#history.push({ epoch, members: this.members })
      if (this.#history.length > VIEW_HISTORY_CAP) this.#history.shift()
    }
    if (epoch > this.#promisedEpoch) this.#promisedEpoch = epoch
    if (epoch > this.#highestProposed) this.#highestProposed = epoch
    if (epoch > this.#seenEpoch) this.#seenEpoch = epoch
    for (const m of [...this.#unreachableSince.keys()]) if (!this.members.includes(m)) this.#unreachableSince.delete(m)
    this.#mesh.installView(this.members)
    this.#onCommit?.({ epoch: this.epoch, members: this.members })
  }

  // history(): the bounded ring of committed views (current + past), newest last — copies, for L4 introspection (P4).
  history(): View[] {
    return this.#history.map((v) => ({ epoch: v.epoch, members: v.members.slice() }))
  }

  // Strict majority: more than half of `set` appears in `acks`.
  #majority(set: string[], acks: Set<string>): boolean {
    let c = 0
    for (const m of set) if (acks.has(m)) c++
    return c * 2 > set.length
  }

  // Recompute the write-gate: writable iff I reach a majority of my view; a minority side must buffer, not commit.
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
