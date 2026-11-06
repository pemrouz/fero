// Port of go.etcd.io/raft/v3/tracker (inflights.go, progress.go, state.go,
// tracker.go) at c51f010.
import { sprintf } from './gofmt.ts'
import {
  type JointConfig, type MajorityConfig, type AckedIndexer, type Index, type VoteResult,
  jointString, majorityString, majoritySlice, jointIDs, jointCommittedIndex, jointVoteResult, VoteWon,
} from './quorum.ts'
import { ConfState } from './raftpb.ts'

// ---- inflights.go ----

type Inflight = { index: number; bytes: number }

export class Inflights {
  start = 0
  count = 0
  bytes = 0
  size: number
  maxBytes: number
  buffer: Inflight[] = []
  constructor(size: number, maxBytes: number) {
    this.size = size
    this.maxBytes = maxBytes
  }
  Clone(): Inflights {
    const ins = new Inflights(this.size, this.maxBytes)
    ins.start = this.start
    ins.count = this.count
    ins.bytes = this.bytes
    ins.buffer = this.buffer.map(x => ({ ...x }))
    return ins
  }
  Add(index: number, bytes: number): void {
    if (this.Full()) throw new Error('cannot add into a Full inflights')
    let next = this.start + this.count
    const size = this.size
    if (next >= size) next -= size
    if (next >= this.buffer.length) this.grow()
    this.buffer[next] = { index, bytes }
    this.count++
    this.bytes += bytes
  }
  private grow(): void {
    let newSize = this.buffer.length * 2
    if (newSize === 0) newSize = 1
    else if (newSize > this.size) newSize = this.size
    const nb: Inflight[] = new Array(newSize)
    for (let i = 0; i < newSize; i++) nb[i] = this.buffer[i] ?? { index: 0, bytes: 0 }
    this.buffer = nb
  }
  FreeLE(to: number): void {
    if (this.count === 0 || to < this.buffer[this.start].index) return
    let idx = this.start
    let i: number
    let bytes = 0
    for (i = 0; i < this.count; i++) {
      if (to < this.buffer[idx].index) break
      bytes += this.buffer[idx].bytes
      const size = this.size
      if (++idx >= size) idx -= size
    }
    this.count -= i
    this.bytes -= bytes
    this.start = idx
    if (this.count === 0) this.start = 0
  }
  Full(): boolean {
    return this.count === this.size || (this.maxBytes !== 0 && this.bytes >= this.maxBytes)
  }
  Count(): number { return this.count }
  reset(): void {
    this.start = 0
    this.count = 0
    this.bytes = 0
  }
}

// ---- state.go ----

export const StateProbe = 0
export const StateReplicate = 1
export const StateSnapshot = 2
export type StateType = number
export const prstmap = ['StateProbe', 'StateReplicate', 'StateSnapshot']
export function progressStateString(st: StateType): string { return prstmap[st] }

// ---- progress.go ----

export class Progress {
  Match = 0
  Next = 0
  sentCommit = 0
  State: StateType = StateProbe
  PendingSnapshot = 0
  RecentActive = false
  MsgAppFlowPaused = false
  Inflights: Inflights | null = null
  IsLearner = false
  constructor(init?: Partial<Progress>) {
    if (init) Object.assign(this, init)
  }
  // copy is Go's `ppr := *pr`: a shallow copy that shares Inflights.
  copy(): Progress {
    const p = new Progress()
    Object.assign(p, this)
    return p
  }
  ResetState(state: StateType): void {
    this.MsgAppFlowPaused = false
    this.PendingSnapshot = 0
    this.State = state
    this.Inflights!.reset()
  }
  BecomeProbe(): void {
    if (this.State === StateSnapshot) {
      const pendingSnapshot = this.PendingSnapshot
      this.ResetState(StateProbe)
      this.Next = Math.max(this.Match + 1, pendingSnapshot + 1)
    } else {
      this.ResetState(StateProbe)
      this.Next = this.Match + 1
    }
    this.sentCommit = Math.min(this.sentCommit, this.Next - 1)
  }
  BecomeReplicate(): void {
    this.ResetState(StateReplicate)
    this.Next = this.Match + 1
  }
  BecomeSnapshot(snapshoti: number): void {
    this.ResetState(StateSnapshot)
    this.PendingSnapshot = snapshoti
    this.Next = snapshoti + 1
    this.sentCommit = snapshoti
  }
  SentEntries(entries: number, bytes: number): void {
    switch (this.State) {
      case StateReplicate:
        if (entries > 0) {
          this.Next += entries
          this.Inflights!.Add(this.Next - 1, bytes)
        }
        this.MsgAppFlowPaused = this.Inflights!.Full()
        break
      case StateProbe:
        if (entries > 0) this.MsgAppFlowPaused = true
        break
      default:
        throw new Error(`sending append in unhandled state ${progressStateString(this.State)}`)
    }
  }
  CanBumpCommit(index: number): boolean {
    return index > this.sentCommit && this.sentCommit < this.Next - 1
  }
  SentCommit(commit: number): void {
    this.sentCommit = commit
  }
  MaybeUpdate(n: number): boolean {
    if (n <= this.Match) return false
    this.Match = n
    this.Next = Math.max(this.Next, n + 1)
    this.MsgAppFlowPaused = false
    return true
  }
  MaybeDecrTo(rejected: number, matchHint: number): boolean {
    if (this.State === StateReplicate) {
      if (rejected <= this.Match) return false
      this.Next = this.Match + 1
      this.sentCommit = Math.min(this.sentCommit, this.Next - 1)
      return true
    }
    if (this.Next - 1 !== rejected) return false
    this.Next = Math.max(Math.min(rejected, matchHint + 1), this.Match + 1)
    this.sentCommit = Math.min(this.sentCommit, this.Next - 1)
    this.MsgAppFlowPaused = false
    return true
  }
  IsPaused(): boolean {
    switch (this.State) {
      case StateProbe: return this.MsgAppFlowPaused
      case StateReplicate: return this.MsgAppFlowPaused
      case StateSnapshot: return true
      default: throw new Error('unexpected state')
    }
  }
  String(): string {
    let buf = sprintf('%s match=%d next=%d', progressStateString(this.State), this.Match, this.Next)
    if (this.IsLearner) buf += ' learner'
    if (this.IsPaused()) buf += ' paused'
    if (this.PendingSnapshot > 0) buf += sprintf(' pendingSnap=%d', this.PendingSnapshot)
    if (!this.RecentActive) buf += ' inactive'
    const n = this.Inflights!.Count()
    if (n > 0) {
      buf += sprintf(' inflight=%d', n)
      if (this.Inflights!.Full()) buf += '[full]'
    }
    return buf
  }
}

export type ProgressMap = Map<number, Progress>

export function progressMapString(m: ProgressMap): string {
  const ids = [...m.keys()].sort((a, b) => a - b)
  let buf = ''
  for (const id of ids) buf += sprintf('%d: %s\n', id, m.get(id)!)
  return buf
}

// ---- tracker.go ----

export class Config {
  Voters: JointConfig = [new Set(), null]
  AutoLeave = false
  Learners: MajorityConfig = null
  LearnersNext: MajorityConfig = null
  constructor(init?: Partial<Config>) {
    if (init) Object.assign(this, init)
  }
  String(): string {
    let buf = sprintf('voters=%s', jointString(this.Voters))
    if (this.Learners !== null) buf += sprintf(' learners=%s', majorityString(this.Learners))
    if (this.LearnersNext !== null) buf += sprintf(' learners_next=%s', majorityString(this.LearnersNext))
    if (this.AutoLeave) buf += ' autoleave'
    return buf
  }
  // Clone, like Go's, leaves AutoLeave at false.
  Clone(): Config {
    const clone = (m: MajorityConfig): MajorityConfig => (m === null ? null : new Set(m))
    return new Config({
      Voters: [clone(this.Voters[0]), clone(this.Voters[1])],
      Learners: clone(this.Learners),
      LearnersNext: clone(this.LearnersNext),
    })
  }
}

class MatchAckIndexer implements AckedIndexer {
  m: ProgressMap
  constructor(m: ProgressMap) { this.m = m }
  AckedIndex(id: number): [Index, boolean] {
    const pr = this.m.get(id)
    if (!pr) return [0, false]
    return [pr.Match, true]
  }
}

// ProgressTracker is a value type in Go (embedded in raft, copied into Changer).
// shallow() is that copy: the maps are shared, the fields are not.
export class ProgressTracker {
  Config: Config
  Progress: ProgressMap
  Votes: Map<number, boolean>
  MaxInflight: number
  MaxInflightBytes: number
  constructor(maxInflight: number, maxBytes: number) {
    this.MaxInflight = maxInflight
    this.MaxInflightBytes = maxBytes
    this.Config = new Config({ Voters: [new Set(), null], Learners: null, LearnersNext: null })
    this.Votes = new Map()
    this.Progress = new Map()
  }
  shallow(): ProgressTracker {
    const p = new ProgressTracker(this.MaxInflight, this.MaxInflightBytes)
    p.Config = this.Config
    p.Progress = this.Progress
    p.Votes = this.Votes
    return p
  }
  get Voters(): JointConfig { return this.Config.Voters }
  get Learners(): MajorityConfig { return this.Config.Learners }
  get LearnersNext(): MajorityConfig { return this.Config.LearnersNext }
  get AutoLeave(): boolean { return this.Config.AutoLeave }

  ConfState(): ConfState {
    return new ConfState({
      Voters: majoritySlice(this.Voters[0]),
      VotersOutgoing: majoritySlice(this.Voters[1]),
      Learners: majoritySlice(this.Learners),
      LearnersNext: majoritySlice(this.LearnersNext),
      AutoLeave: this.AutoLeave,
    })
  }
  IsSingleton(): boolean {
    return (this.Voters[0]?.size ?? 0) === 1 && (this.Voters[1]?.size ?? 0) === 0
  }
  IsVoter(id: number): boolean {
    return (this.Voters[0]?.has(id) ?? false) || (this.Voters[1]?.has(id) ?? false)
  }
  Committed(): number {
    return jointCommittedIndex(this.Voters, new MatchAckIndexer(this.Progress))
  }
  Visit(f: (id: number, pr: Progress) => void): void {
    const ids = [...this.Progress.keys()].sort((a, b) => a - b)
    for (const id of ids) f(id, this.Progress.get(id)!)
  }
  QuorumActive(): boolean {
    const votes = new Map<number, boolean>()
    this.Visit((id, pr) => {
      if (pr.IsLearner) return
      votes.set(id, pr.RecentActive)
    })
    return jointVoteResult(this.Voters, votes) === VoteWon
  }
  VoterNodes(): number[] {
    return [...jointIDs(this.Voters)].sort((a, b) => a - b)
  }
  LearnerNodes(): number[] | null {
    if (!this.Learners || this.Learners.size === 0) return null
    return [...this.Learners].sort((a, b) => a - b)
  }
  ResetVotes(): void {
    this.Votes = new Map()
  }
  RecordVote(id: number, v: boolean): void {
    if (!this.Votes.has(id)) this.Votes.set(id, v)
  }
  TallyVotes(): [number, number, VoteResult] {
    let granted = 0
    let rejected = 0
    for (const [id, pr] of this.Progress) {
      if (pr.IsLearner) continue
      const v = this.Votes.get(id)
      if (v === undefined) continue
      if (v) granted++
      else rejected++
    }
    return [granted, rejected, jointVoteResult(this.Voters, this.Votes)]
  }
}
