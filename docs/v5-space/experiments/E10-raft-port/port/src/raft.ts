// Port of go.etcd.io/raft/v3/raft.go at c51f010. The state-trace hooks
// (state_trace.go) are the no-op build and are left out.
import {
  Entry, Message, HardState, type Snapshot, type ConfChangeI, type ConfChangeV2, type ConfState,
  MsgHup, MsgBeat, MsgProp, MsgApp, MsgAppResp, MsgVote, MsgVoteResp, MsgSnap, MsgHeartbeat, MsgHeartbeatResp,
  MsgUnreachable, MsgSnapStatus, MsgCheckQuorum, MsgTransferLeader, MsgTimeoutNow, MsgReadIndex, MsgReadIndexResp,
  MsgPreVote, MsgPreVoteResp, MsgStorageAppendResp, MsgStorageApplyResp, MsgForgetLeader,
  EntryNormal, EntryConfChange, EntryConfChangeV2, msgTypeName, cloneEntry, EnsureSnapshot, EnsureConfState,
  unmarshalConfChangeV1, unmarshalConfChangeV2, utf8,
} from './raftpb.ts'
import { type Logger, getLogger } from './logger.ts'
import { type raftLog, newLogWithSize, noLimit } from './log.ts'
import { type Storage, ErrSnapshotTemporarilyUnavailable } from './storage.ts'
import { Changer, Restore } from './confchange.ts'
import { VoteWon, VoteLost, type VoteResult, jointIDs } from './quorum.ts'
import {
  ProgressTracker, Progress, Inflights, type Config as TrackerConfig, type ProgressMap,
  StateReplicate, StateProbe, StateSnapshot,
} from './tracker.ts'
import { readOnly, type ReadState, ReadOnlySafe, ReadOnlyLeaseBased, type ReadOnlyOption } from './read_only.ts'
import { SoftState, IsEmptyHardState, IsEmptySnap, confChangeToMsg } from './node.ts'
import {
  IsLocalMsgTarget, voteRespMsgType, entsSize, payloadsSize, assertConfStatesEquivalent, DescribeConfChange,
} from './util.ts'
import { type entryID, logSlice } from './types.ts'
import { sprintf } from './gofmt.ts'

export const None = 0
// Go uses math.MaxUint64 and math.MaxUint64-1; a JS number cannot tell those
// apart, so the port uses the two largest safe integers (ids stay below them).
export const LocalAppendThread = Number.MAX_SAFE_INTEGER
export const LocalApplyThread = Number.MAX_SAFE_INTEGER - 1

export const StateFollower = 0
export const StateCandidate = 1
export const StateLeader = 2
export const StatePreCandidate = 3
export type StateType = number
const stmap = ['StateFollower', 'StateCandidate', 'StateLeader', 'StatePreCandidate']
export function stateTypeString(st: StateType): string { return stmap[st] }

export { ReadOnlySafe, ReadOnlyLeaseBased }

type CampaignType = string
const campaignPreElection: CampaignType = 'CampaignPreElection'
const campaignElection: CampaignType = 'CampaignElection'
const campaignTransfer: CampaignType = 'CampaignTransfer'

export const ErrProposalDropped = new Error('raft proposal dropped')

// globalRand.Intn: Go uses crypto/rand. The port lets a host (or a deterministic
// simulator) swap the source; the default is Math.random.
export const globalRand = { Intn: (n: number): number => Math.floor(Math.random() * n) }

export class Config {
  ID = 0
  ElectionTick = 0
  HeartbeatTick = 0
  Storage: Storage | null = null
  Applied = 0
  AsyncStorageWrites = false
  MaxSizePerMsg = 0
  MaxCommittedSizePerReady = 0
  MaxUncommittedEntriesSize = 0
  MaxInflightMsgs = 0
  MaxInflightBytes = 0
  CheckQuorum = false
  PreVote = false
  ReadOnlyOption: ReadOnlyOption = ReadOnlySafe
  Logger: Logger | null = null
  DisableProposalForwarding = false
  DisableConfChangeValidation = false
  StepDownOnRemoval = false
  constructor(init?: Partial<Config>) {
    if (init) Object.assign(this, init)
  }
  clone(): Config { return new Config(this) }

  validate(): Error | null {
    if (this.ID === None) return new Error('cannot use none as id')
    if (IsLocalMsgTarget(this.ID)) return new Error('cannot use local target as id')
    if (this.HeartbeatTick <= 0) return new Error('heartbeat tick must be greater than 0')
    if (this.ElectionTick <= this.HeartbeatTick) return new Error('election tick must be greater than heartbeat tick')
    if (!this.Storage) return new Error('storage cannot be nil')
    if (this.MaxUncommittedEntriesSize === 0) this.MaxUncommittedEntriesSize = noLimit
    if (this.MaxCommittedSizePerReady === 0) this.MaxCommittedSizePerReady = this.MaxSizePerMsg
    if (this.MaxInflightMsgs <= 0) return new Error('max inflight messages must be greater than 0')
    if (this.MaxInflightBytes === 0) this.MaxInflightBytes = noLimit
    else if (this.MaxInflightBytes < this.MaxSizePerMsg) return new Error('max inflight bytes must be >= max message size')
    if (!this.Logger) this.Logger = getLogger()
    if (this.ReadOnlyOption === ReadOnlyLeaseBased && !this.CheckQuorum) {
      return new Error('CheckQuorum must be enabled when ReadOnlyOption is ReadOnlyLeaseBased')
    }
    return null
  }
}

type stepFunc = (r: raft, m: Message) => Error | null

export class raft {
  id: number
  Term = 0
  Vote = 0
  readStates: ReadState[] = []
  raftLog: raftLog
  maxMsgSize: number
  maxUncommittedSize: number
  trk: ProgressTracker
  state: StateType = StateFollower
  isLearner = false
  msgs: Message[] = []
  msgsAfterAppend: Message[] = []
  lead = None
  leadTransferee = None
  pendingConfIndex = 0
  disableConfChangeValidation: boolean
  uncommittedSize = 0
  readOnly: readOnly
  electionElapsed = 0
  heartbeatElapsed = 0
  checkQuorum: boolean
  preVote: boolean
  heartbeatTimeout: number
  electionTimeout: number
  randomizedElectionTimeout = 0
  disableProposalForwarding: boolean
  stepDownOnRemoval: boolean
  tick: () => void = () => {}
  step: stepFunc = stepFollower
  logger: Logger
  pendingReadIndexMessages: Message[] = []

  constructor(c: Config) {
    const err = c.validate()
    if (err) throw new Error(err.message)
    const raftlog = newLogWithSize(c.Storage!, c.Logger!, c.MaxCommittedSizePerReady)
    const [hs, cs, e2] = c.Storage!.InitialState()
    if (e2) throw e2
    this.id = c.ID
    this.raftLog = raftlog
    this.maxMsgSize = c.MaxSizePerMsg
    this.maxUncommittedSize = c.MaxUncommittedEntriesSize
    this.trk = new ProgressTracker(c.MaxInflightMsgs, c.MaxInflightBytes)
    this.electionTimeout = c.ElectionTick
    this.heartbeatTimeout = c.HeartbeatTick
    this.logger = c.Logger!
    this.checkQuorum = c.CheckQuorum
    this.preVote = c.PreVote
    this.readOnly = new readOnly(c.ReadOnlyOption)
    this.disableProposalForwarding = c.DisableProposalForwarding
    this.disableConfChangeValidation = c.DisableConfChangeValidation
    this.stepDownOnRemoval = c.StepDownOnRemoval

    const lastID = this.raftLog.lastEntryID()
    const [cfg, trk, e3] = Restore(new Changer(this.trk, lastID.index), cs)
    if (e3) throw e3
    assertConfStatesEquivalent(this.logger, cs, this.switchToConfig(cfg, trk!))
    if (!IsEmptyHardState(hs)) this.loadState(hs!)
    if (c.Applied > 0) raftlog.appliedTo(c.Applied, 0)
    this.becomeFollower(this.Term, None)
    const nodesStrs = this.trk.VoterNodes().map(n => n.toString(16))
    this.logger.Infof('newRaft %x [peers: [%s], term: %d, commit: %d, applied: %d, lastindex: %d, lastterm: %d]',
      this.id, nodesStrs.join(','), this.Term, this.raftLog.committed, this.raftLog.applied, lastID.index, lastID.term)
  }

  hasLeader(): boolean { return this.lead !== None }
  softState(): SoftState { return new SoftState(this.lead, this.state) }
  hardState(): HardState {
    return new HardState({ Term: this.Term, Vote: this.Vote, Commit: this.raftLog.committed })
  }

  send(m: Message): void {
    if (m.GetFrom() === None) m.From = this.id
    const t = m.GetType()
    if (t === MsgVote || t === MsgVoteResp || t === MsgPreVote || t === MsgPreVoteResp) {
      if (m.GetTerm() === 0) this.logger.Panicf('term should be set when sending %s', msgTypeName(t))
    } else {
      if (m.GetTerm() !== 0) this.logger.Panicf('term should not be set when sending %s (was %d)', msgTypeName(t), m.GetTerm())
      if (t !== MsgProp && t !== MsgReadIndex) m.Term = this.Term
    }
    if (t === MsgAppResp || t === MsgVoteResp || t === MsgPreVoteResp) {
      this.msgsAfterAppend.push(m)
    } else {
      if (m.GetTo() === this.id) this.logger.Panicf('message should not be self-addressed when sending %s', msgTypeName(t))
      this.msgs.push(m)
    }
  }

  sendAppend(to: number): void {
    this.maybeSendAppend(to, true)
  }

  maybeSendAppend(to: number, sendIfEmpty: boolean): boolean {
    const pr = this.trk.Progress.get(to)!
    if (pr.IsPaused()) return false
    const prevIndex = pr.Next - 1
    const [prevTerm, err] = this.raftLog.term(prevIndex)
    if (err) return this.maybeSendSnapshot(to, pr)
    let ents: Entry[] = []
    let err2: Error | null = null
    if (pr.State !== StateReplicate || !pr.Inflights!.Full()) {
      ;[ents, err2] = this.raftLog.entries(pr.Next, this.maxMsgSize)
    }
    if (ents.length === 0 && !sendIfEmpty) return false
    if (err2) return this.maybeSendSnapshot(to, pr)
    this.send(new Message({
      To: to, Type: MsgApp, Index: prevIndex, LogTerm: prevTerm, Entries: ents, Commit: this.raftLog.committed,
    }))
    pr.SentEntries(ents.length, payloadsSize(ents))
    pr.SentCommit(this.raftLog.committed)
    return true
  }

  maybeSendSnapshot(to: number, pr: Progress): boolean {
    if (!pr.RecentActive) {
      this.logger.Debugf('ignore sending snapshot to %x since it is not recently active', to)
      return false
    }
    const [snapshot, err] = this.raftLog.snapshot()
    if (err) {
      if (err === ErrSnapshotTemporarilyUnavailable) {
        this.logger.Debugf('%x failed to send snapshot to %x because snapshot is temporarily unavailable', this.id, to)
        return false
      }
      throw err
    }
    if (IsEmptySnap(snapshot)) throw new Error('need non-empty snapshot')
    const sindex = snapshot!.Metadata!.GetIndex()
    const sterm = snapshot!.Metadata!.GetTerm()
    this.logger.Debugf('%x [firstindex: %d, commit: %d] sent snapshot[index: %d, term: %d] to %x [%s]',
      this.id, this.raftLog.firstIndex(), this.raftLog.committed, sindex, sterm, to, pr)
    pr.BecomeSnapshot(sindex)
    this.logger.Debugf('%x paused sending replication messages to %x [%s]', this.id, to, pr)
    this.send(new Message({ To: to, Type: MsgSnap, Snapshot: snapshot! }))
    return true
  }

  sendHeartbeat(to: number, ctx: Uint8Array | undefined): void {
    const pr = this.trk.Progress.get(to)!
    const commit = Math.min(pr.Match, this.raftLog.committed)
    this.send(new Message({ To: to, Type: MsgHeartbeat, Commit: commit, Context: ctx }))
    pr.SentCommit(commit)
  }

  bcastAppend(): void {
    this.trk.Visit(id => {
      if (id === this.id) return
      this.sendAppend(id)
    })
  }

  bcastHeartbeat(): void {
    this.bcastHeartbeatWithCtx(this.readOnly.heartbeatCtx())
  }

  bcastHeartbeatWithCtx(ctx: Uint8Array | undefined): void {
    this.trk.Visit(id => {
      if (id === this.id) return
      this.sendHeartbeat(id, ctx)
    })
  }

  appliedTo(index: number, size: number): void {
    const oldApplied = this.raftLog.applied
    const newApplied = Math.max(index, oldApplied)
    this.raftLog.appliedTo(newApplied, size)
    if (this.trk.Config.AutoLeave && newApplied >= this.pendingConfIndex && this.state === StateLeader) {
      const m = confChangeToMsg(null)
      const err = this.Step(m)
      if (err) {
        this.logger.Debugf('not initiating automatic transition out of joint configuration %s: %v', this.trk.Config, err)
      } else {
        this.logger.Infof('initiating automatic transition out of joint configuration %s', this.trk.Config)
      }
    }
  }

  appliedSnap(snap: Snapshot): void {
    const index = snap.Metadata?.GetIndex() ?? 0
    this.raftLog.stableSnapTo(index)
    this.appliedTo(index, 0)
  }

  maybeCommit(): boolean {
    return this.raftLog.maybeCommit({ term: this.Term, index: this.trk.Committed() })
  }

  reset(term: number): void {
    if (this.Term !== term) {
      this.Term = term
      this.Vote = None
    }
    this.lead = None
    this.electionElapsed = 0
    this.heartbeatElapsed = 0
    this.resetRandomizedElectionTimeout()
    this.abortLeaderTransfer()
    this.trk.ResetVotes()
    this.trk.Visit((id, pr) => {
      // *pr = tracker.Progress{...}: reset every field in place.
      const isLearner = pr.IsLearner
      Object.assign(pr, new Progress({
        Match: 0,
        Next: this.raftLog.lastIndex() + 1,
        Inflights: new Inflights(this.trk.MaxInflight, this.trk.MaxInflightBytes),
        IsLearner: isLearner,
      }))
      if (id === this.id) pr.Match = this.raftLog.lastIndex()
    })
    this.pendingConfIndex = 0
    this.uncommittedSize = 0
    this.readOnly = new readOnly(this.readOnly.option)
  }

  appendEntry(...es: Entry[]): boolean {
    let li = this.raftLog.lastIndex()
    const cloned: Entry[] = es.map((e, i) => {
      const c = cloneEntry(e)
      c.Term = this.Term
      c.Index = li + 1 + i
      return c
    })
    if (!this.increaseUncommittedSize(cloned)) {
      this.logger.Warningf('%x appending new entries to log would exceed uncommitted entry size limit; dropping proposal', this.id)
      return false
    }
    li = this.raftLog.append(...cloned)
    this.send(new Message({ To: this.id, Type: MsgAppResp, Index: li }))
    return true
  }

  tickElection(): void {
    this.electionElapsed++
    if (this.promotable() && this.pastElectionTimeout()) {
      this.electionElapsed = 0
      const err = this.Step(new Message({ From: this.id, Type: MsgHup }))
      if (err) this.logger.Debugf('error occurred during election: %v', err)
    }
  }

  tickHeartbeat(): void {
    this.heartbeatElapsed++
    this.electionElapsed++
    if (this.electionElapsed >= this.electionTimeout) {
      this.electionElapsed = 0
      if (this.checkQuorum) {
        const err = this.Step(new Message({ From: this.id, Type: MsgCheckQuorum }))
        if (err) this.logger.Debugf('error occurred during checking sending heartbeat: %v', err)
      }
      if (this.state === StateLeader && this.leadTransferee !== None) this.abortLeaderTransfer()
    }
    if (this.state !== StateLeader) return
    if (this.heartbeatElapsed >= this.heartbeatTimeout) {
      this.heartbeatElapsed = 0
      const err = this.Step(new Message({ From: this.id, Type: MsgBeat }))
      if (err) this.logger.Debugf('error occurred during checking sending heartbeat: %v', err)
    }
  }

  becomeFollower(term: number, lead: number): void {
    this.step = stepFollower
    this.reset(term)
    this.tick = () => this.tickElection()
    this.lead = lead
    this.state = StateFollower
    this.logger.Infof('%x became follower at term %d', this.id, this.Term)
  }

  becomeCandidate(): void {
    if (this.state === StateLeader) throw new Error('invalid transition [leader -> candidate]')
    this.step = stepCandidate
    this.reset(this.Term + 1)
    this.tick = () => this.tickElection()
    this.Vote = this.id
    this.state = StateCandidate
    this.logger.Infof('%x became candidate at term %d', this.id, this.Term)
  }

  becomePreCandidate(): void {
    if (this.state === StateLeader) throw new Error('invalid transition [leader -> pre-candidate]')
    this.step = stepCandidate
    this.trk.ResetVotes()
    this.tick = () => this.tickElection()
    this.lead = None
    this.state = StatePreCandidate
    this.logger.Infof('%x became pre-candidate at term %d', this.id, this.Term)
  }

  becomeLeader(): void {
    if (this.state === StateFollower) throw new Error('invalid transition [follower -> leader]')
    this.step = stepLeader
    this.reset(this.Term)
    this.tick = () => this.tickHeartbeat()
    this.lead = this.id
    this.state = StateLeader
    const pr = this.trk.Progress.get(this.id)!
    pr.BecomeReplicate()
    pr.RecentActive = true
    this.pendingConfIndex = this.raftLog.lastIndex()
    const emptyEnt = new Entry({ Data: undefined })
    if (!this.appendEntry(emptyEnt)) this.logger.Panic('empty entry was dropped')
    this.logger.Infof('%x became leader at term %d', this.id, this.Term)
  }

  hup(t: CampaignType): void {
    if (this.state === StateLeader) {
      this.logger.Debugf('%x ignoring MsgHup because already leader', this.id)
      return
    }
    if (!this.promotable()) {
      this.logger.Warningf('%x is unpromotable and can not campaign', this.id)
      return
    }
    if (this.hasUnappliedConfChanges()) {
      this.logger.Warningf('%x cannot campaign at term %d since there are still pending configuration changes to apply', this.id, this.Term)
      return
    }
    this.logger.Infof('%x is starting a new election at term %d', this.id, this.Term)
    this.campaign(t)
  }

  hasUnappliedConfChanges(): boolean {
    if (this.raftLog.applied >= this.raftLog.committed) return false
    let found = false
    const lo = this.raftLog.applied + 1
    const hi = this.raftLog.committed + 1
    const pageSize = this.raftLog.maxApplyingEntsSize
    const errBreak = new Error('break')
    const err = this.raftLog.scan(lo, hi, pageSize, ents => {
      for (const e of ents) {
        if (e.GetType() === EntryConfChange || e.GetType() === EntryConfChangeV2) {
          found = true
          return errBreak
        }
      }
      return null
    })
    if (err && err !== errBreak) this.logger.Panicf('error scanning unapplied entries [%d, %d): %v', lo, hi, err)
    return found
  }

  campaign(t: CampaignType): void {
    if (!this.promotable()) this.logger.Warningf('%x is unpromotable; campaign() should have been called', this.id)
    let term: number
    let voteMsg: number
    if (t === campaignPreElection) {
      this.becomePreCandidate()
      voteMsg = MsgPreVote
      term = this.Term + 1
    } else {
      this.becomeCandidate()
      voteMsg = MsgVote
      term = this.Term
    }
    const ids = [...jointIDs(this.trk.Voters)].sort((a, b) => a - b)
    for (const id of ids) {
      if (id === this.id) {
        this.send(new Message({ To: id, Term: term, Type: voteRespMsgType(voteMsg) }))
        continue
      }
      const last = this.raftLog.lastEntryID()
      this.logger.Infof('%x [logterm: %d, index: %d] sent %s request to %x at term %d',
        this.id, last.term, last.index, msgTypeName(voteMsg), id, this.Term)
      let ctx: Uint8Array | undefined
      if (t === campaignTransfer) ctx = utf8(t)
      this.send(new Message({ To: id, Term: term, Type: voteMsg, Index: last.index, LogTerm: last.term, Context: ctx }))
    }
  }

  poll(id: number, t: number, v: boolean): [number, number, VoteResult] {
    if (v) this.logger.Infof('%x received %s from %x at term %d', this.id, msgTypeName(t), id, this.Term)
    else this.logger.Infof('%x received %s rejection from %x at term %d', this.id, msgTypeName(t), id, this.Term)
    this.trk.RecordVote(id, v)
    return this.trk.TallyVotes()
  }

  Step(m: Message | null): Error | null {
    if (!m) return new Error('nil message')
    if (m.GetTerm() === 0) {
      // local message
    } else if (m.GetTerm() > this.Term) {
      if (m.GetType() === MsgVote || m.GetType() === MsgPreVote) {
        const force = bytesEqual(m.GetContext(), utf8(campaignTransfer))
        const inLease = this.checkQuorum && this.lead !== None && this.electionElapsed < this.electionTimeout
        if (!force && inLease) {
          const last = this.raftLog.lastEntryID()
          this.logger.Infof('%x [logterm: %d, index: %d, vote: %x] ignored %s from %x [logterm: %d, index: %d] at term %d: lease is not expired (remaining ticks: %d)',
            this.id, last.term, last.index, this.Vote, msgTypeName(m.GetType()), m.GetFrom(), m.GetLogTerm(), m.GetIndex(), this.Term, this.electionTimeout - this.electionElapsed)
          return null
        }
      }
      if (m.GetType() === MsgPreVote) {
        // Never change our term in response to a PreVote
      } else if (m.GetType() === MsgPreVoteResp && !m.GetReject()) {
        // We send pre-vote requests with a term in our future.
      } else {
        this.logger.Infof('%x [term: %d] received a %s message with higher term from %x [term: %d]',
          this.id, this.Term, msgTypeName(m.GetType()), m.GetFrom(), m.GetTerm())
        if (m.GetType() === MsgApp || m.GetType() === MsgHeartbeat || m.GetType() === MsgSnap) {
          this.becomeFollower(m.GetTerm(), m.GetFrom())
        } else {
          this.becomeFollower(m.GetTerm(), None)
        }
      }
    } else if (m.GetTerm() < this.Term) {
      if ((this.checkQuorum || this.preVote) && (m.GetType() === MsgHeartbeat || m.GetType() === MsgApp)) {
        this.send(new Message({ To: m.From, Type: MsgAppResp }))
      } else if (m.GetType() === MsgPreVote) {
        const last = this.raftLog.lastEntryID()
        this.logger.Infof('%x [logterm: %d, index: %d, vote: %x] rejected %s from %x [logterm: %d, index: %d] at term %d',
          this.id, last.term, last.index, this.Vote, msgTypeName(m.GetType()), m.GetFrom(), m.GetLogTerm(), m.GetIndex(), this.Term)
        this.send(new Message({ To: m.From, Term: this.Term, Type: MsgPreVoteResp, Reject: true }))
      } else if (m.GetType() === MsgStorageAppendResp) {
        if (m.GetIndex() !== 0) {
          this.logger.Infof('%x [term: %d] ignored entry appends from a %s message with lower term [term: %d]',
            this.id, this.Term, msgTypeName(m.GetType()), m.GetTerm())
        }
        if (m.GetSnapshot()) this.appliedSnap(m.GetSnapshot()!)
      } else {
        this.logger.Infof('%x [term: %d] ignored a %s message with lower term from %x [term: %d]',
          this.id, this.Term, msgTypeName(m.GetType()), m.GetFrom(), m.GetTerm())
      }
      return null
    }

    switch (m.GetType()) {
      case MsgHup:
        if (this.preVote) this.hup(campaignPreElection)
        else this.hup(campaignElection)
        break
      case MsgStorageAppendResp:
        if (m.GetIndex() !== 0) this.raftLog.stableTo({ term: m.GetLogTerm(), index: m.GetIndex() })
        if (m.GetSnapshot()) this.appliedSnap(m.GetSnapshot()!)
        break
      case MsgStorageApplyResp:
        if (m.GetEntries().length > 0) {
          const ents = m.GetEntries()
          const index = ents[ents.length - 1].GetIndex()
          this.appliedTo(index, entsSize(ents))
          this.reduceUncommittedSize(payloadsSize(ents))
        }
        break
      case MsgVote:
      case MsgPreVote: {
        const canVote = this.Vote === m.GetFrom() ||
          (this.Vote === None && this.lead === None) ||
          (m.GetType() === MsgPreVote && m.GetTerm() > this.Term)
        const lastID = this.raftLog.lastEntryID()
        const candLastID: entryID = { term: m.GetLogTerm(), index: m.GetIndex() }
        if (canVote && this.raftLog.isUpToDate(candLastID)) {
          this.logger.Infof('%x [logterm: %d, index: %d, vote: %x] cast %s for %x [logterm: %d, index: %d] at term %d',
            this.id, lastID.term, lastID.index, this.Vote, msgTypeName(m.GetType()), m.GetFrom(), candLastID.term, candLastID.index, this.Term)
          this.send(new Message({ To: m.From, Term: m.Term, Type: voteRespMsgType(m.GetType()) }))
          if (m.GetType() === MsgVote) {
            this.electionElapsed = 0
            this.Vote = m.GetFrom()
          }
        } else {
          this.logger.Infof('%x [logterm: %d, index: %d, vote: %x] rejected %s from %x [logterm: %d, index: %d] at term %d',
            this.id, lastID.term, lastID.index, this.Vote, msgTypeName(m.GetType()), m.GetFrom(), candLastID.term, candLastID.index, this.Term)
          this.send(new Message({ To: m.From, Term: this.Term, Type: voteRespMsgType(m.GetType()), Reject: true }))
        }
        break
      }
      default: {
        const err = this.step(this, m)
        if (err) return err
      }
    }
    return null
  }

  handleAppendEntries(m: Message): void {
    const a = logSliceFromMsgApp(m)
    if (a.prev.index < this.raftLog.committed) {
      this.send(new Message({ To: m.From, Type: MsgAppResp, Index: this.raftLog.committed }))
      return
    }
    const [mlastIndex, ok] = this.raftLog.maybeAppend(a, m.GetCommit())
    if (ok) {
      this.send(new Message({ To: m.From, Type: MsgAppResp, Index: mlastIndex }))
      return
    }
    this.logger.Debugf('%x [logterm: %d, index: %d] rejected MsgApp [logterm: %d, index: %d] from %x',
      this.id, this.raftLog.zeroTermOnOutOfBounds(this.raftLog.term(m.GetIndex())), m.GetIndex(), m.GetLogTerm(), m.GetIndex(), m.GetFrom())
    let hintIndex = Math.min(m.GetIndex(), this.raftLog.lastIndex())
    let hintTerm: number
    ;[hintIndex, hintTerm] = this.raftLog.findConflictByTerm(hintIndex, m.GetLogTerm())
    this.send(new Message({
      To: m.From, Type: MsgAppResp, Index: m.GetIndex(), Reject: true, RejectHint: hintIndex, LogTerm: hintTerm,
    }))
  }

  handleHeartbeat(m: Message): void {
    this.raftLog.commitTo(m.GetCommit())
    this.send(new Message({ To: m.From, Type: MsgHeartbeatResp, Context: m.GetContext() }))
  }

  handleSnapshot(m: Message): void {
    const s = EnsureSnapshot(m.GetSnapshot())
    const sindex = s.Metadata!.GetIndex()
    const sterm = s.Metadata!.GetTerm()
    if (this.restore(s)) {
      this.logger.Infof('%x [commit: %d] restored snapshot [index: %d, term: %d]', this.id, this.raftLog.committed, sindex, sterm)
      this.send(new Message({ To: m.From, Type: MsgAppResp, Index: this.raftLog.lastIndex() }))
    } else {
      this.logger.Infof('%x [commit: %d] ignored snapshot [index: %d, term: %d]', this.id, this.raftLog.committed, sindex, sterm)
      this.send(new Message({ To: m.From, Type: MsgAppResp, Index: this.raftLog.committed }))
    }
  }

  restore(s: Snapshot): boolean {
    if ((s.Metadata?.GetIndex() ?? 0) <= this.raftLog.committed) return false
    if (this.state !== StateFollower) {
      this.logger.Warningf('%x attempted to restore snapshot as leader; should never happen', this.id)
      this.becomeFollower(this.Term + 1, None)
      return false
    }
    const cs = EnsureConfState(s.Metadata!.ConfState)
    let found = false
    for (const set of [cs.Voters, cs.Learners, cs.VotersOutgoing]) {
      if (set.includes(this.id)) {
        found = true
        break
      }
    }
    if (!found) {
      this.logger.Warningf('%x attempted to restore snapshot but it is not in the ConfState %v; should never happen', this.id, cs)
      return false
    }
    const id: entryID = { term: s.Metadata!.GetTerm(), index: s.Metadata!.GetIndex() }
    if (this.raftLog.matchTerm(id)) {
      const last = this.raftLog.lastEntryID()
      this.logger.Infof('%x [commit: %d, lastindex: %d, lastterm: %d] fast-forwarded commit to snapshot [index: %d, term: %d]',
        this.id, this.raftLog.committed, last.index, last.term, id.index, id.term)
      this.raftLog.commitTo(s.Metadata!.GetIndex())
      return false
    }
    this.raftLog.restore(s)
    this.trk = new ProgressTracker(this.trk.MaxInflight, this.trk.MaxInflightBytes)
    const [cfg, trk, err] = Restore(new Changer(this.trk, this.raftLog.lastIndex()), cs)
    if (err) throw new Error(sprintf('unable to restore config %+v: %s', cs, err))
    assertConfStatesEquivalent(this.logger, cs, this.switchToConfig(cfg, trk!))
    const last = this.raftLog.lastEntryID()
    this.logger.Infof('%x [commit: %d, lastindex: %d, lastterm: %d] restored snapshot [index: %d, term: %d]',
      this.id, this.raftLog.committed, last.index, last.term, id.index, id.term)
    return true
  }

  promotable(): boolean {
    const pr = this.trk.Progress.get(this.id)
    return !!pr && !pr.IsLearner && !this.raftLog.hasNextOrInProgressSnapshot()
  }

  applyConfChange(cc: ConfChangeV2): ConfState {
    const changer = new Changer(this.trk, this.raftLog.lastIndex())
    let res
    if (cc.LeaveJoint()) {
      res = changer.LeaveJoint()
    } else {
      const [autoLeave, ok] = cc.EnterJoint()
      res = ok ? changer.EnterJoint(autoLeave, ...cc.Changes) : changer.Simple(...cc.Changes)
    }
    const [cfg, trk, err] = res
    if (err) throw err
    return this.switchToConfig(cfg, trk!)
  }

  switchToConfig(cfg: TrackerConfig, trk: ProgressMap): ConfState {
    this.trk.Config = cfg
    this.trk.Progress = trk
    this.logger.Infof('%x switched to configuration %s', this.id, this.trk.Config)
    const cs = this.trk.ConfState()
    const pr = this.trk.Progress.get(this.id)
    const ok = pr !== undefined
    this.isLearner = ok && pr!.IsLearner
    if ((!ok || this.isLearner) && this.state === StateLeader) {
      if (this.stepDownOnRemoval) this.becomeFollower(this.Term, None)
      return cs
    }
    if (this.state !== StateLeader || cs.Voters.length === 0) return cs
    if (this.maybeCommit()) {
      this.bcastAppend()
    } else {
      this.trk.Visit(id => {
        if (id === this.id) return
        this.maybeSendAppend(id, false)
      })
    }
    const tOK = jointIDs(this.trk.Config.Voters).has(this.leadTransferee)
    if (!tOK && this.leadTransferee !== 0) this.abortLeaderTransfer()
    return cs
  }

  loadState(state: HardState): void {
    if (state.GetCommit() < this.raftLog.committed || state.GetCommit() > this.raftLog.lastIndex()) {
      this.logger.Panicf('%x state.commit %d is out of range [%d, %d]', this.id, state.GetCommit(), this.raftLog.committed, this.raftLog.lastIndex())
    }
    this.raftLog.committed = state.GetCommit()
    this.Term = state.GetTerm()
    this.Vote = state.GetVote()
  }

  pastElectionTimeout(): boolean {
    return this.electionElapsed >= this.randomizedElectionTimeout
  }

  resetRandomizedElectionTimeout(): void {
    this.randomizedElectionTimeout = this.electionTimeout + globalRand.Intn(this.electionTimeout)
  }

  sendTimeoutNow(to: number): void {
    this.send(new Message({ To: to, Type: MsgTimeoutNow }))
  }

  abortLeaderTransfer(): void {
    this.leadTransferee = None
  }

  committedEntryInCurrentTerm(): boolean {
    return this.raftLog.zeroTermOnOutOfBounds(this.raftLog.term(this.raftLog.committed)) === this.Term
  }

  responseToReadIndexReq(req: Message, readIndex: number): Message {
    if (req.GetFrom() === None || req.GetFrom() === this.id) {
      this.readStates.push({ Index: readIndex, RequestCtx: req.GetEntries()[0].GetData() })
      return new Message()
    }
    return new Message({ Type: MsgReadIndexResp, To: req.From, Index: readIndex, Entries: req.GetEntries() })
  }

  increaseUncommittedSize(ents: Entry[]): boolean {
    const s = payloadsSize(ents)
    if (this.uncommittedSize > 0 && s > 0 && this.uncommittedSize + s > this.maxUncommittedSize) return false
    this.uncommittedSize += s
    return true
  }

  reduceUncommittedSize(s: number): void {
    if (s > this.uncommittedSize) this.uncommittedSize = 0
    else this.uncommittedSize -= s
  }
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  const x = a ?? new Uint8Array(0)
  if (x.length !== b.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false
  return true
}

export function newRaft(c: Config): raft {
  return new raft(c)
}

function stepLeader(r: raft, m: Message): Error | null {
  switch (m.GetType()) {
    case MsgBeat:
      r.bcastHeartbeat()
      return null
    case MsgCheckQuorum:
      if (!r.trk.QuorumActive()) {
        r.logger.Warningf('%x stepped down to follower since quorum is not active', r.id)
        r.becomeFollower(r.Term, None)
      }
      r.trk.Visit((id, pr) => {
        if (id !== r.id) pr.RecentActive = false
      })
      return null
    case MsgProp: {
      if (m.GetEntries().length === 0) r.logger.Panicf('%x stepped empty MsgProp', r.id)
      if (!r.trk.Progress.get(r.id)) return ErrProposalDropped
      if (r.leadTransferee !== None) {
        r.logger.Debugf('%x [term %d] transfer leadership to %x is in progress; dropping proposal', r.id, r.Term, r.leadTransferee)
        return ErrProposalDropped
      }
      const ents = m.GetEntries()
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i]
        let cc: ConfChangeI | null = null
        if (e.GetType() === EntryConfChange) cc = unmarshalConfChangeV1(e.GetData())
        else if (e.GetType() === EntryConfChangeV2) cc = unmarshalConfChangeV2(e.GetData())
        if (cc) {
          const alreadyPending = r.pendingConfIndex > r.raftLog.applied
          const alreadyJoint = (r.trk.Config.Voters[1]?.size ?? 0) > 0
          const wantsLeaveJoint = cc.AsV2().Changes.length === 0
          let failedCheck = ''
          if (alreadyPending) {
            failedCheck = sprintf('possible unapplied conf change at index %d (applied to %d)', r.pendingConfIndex, r.raftLog.applied)
          } else if (alreadyJoint && !wantsLeaveJoint) {
            failedCheck = 'must transition out of joint config first'
          } else if (!alreadyJoint && wantsLeaveJoint) {
            failedCheck = 'not in joint state; refusing empty conf change'
          }
          if (failedCheck !== '' && !r.disableConfChangeValidation) {
            r.logger.Infof('%x ignoring conf change %s at config %s: %s', r.id, DescribeConfChange(cc), r.trk.Config, failedCheck)
            ents[i] = new Entry({ Type: EntryNormal })
          } else {
            r.pendingConfIndex = r.raftLog.lastIndex() + i + 1
          }
        }
      }
      if (!r.appendEntry(...ents)) return ErrProposalDropped
      r.bcastAppend()
      return null
    }
    case MsgReadIndex:
      if (!r.committedEntryInCurrentTerm()) {
        r.pendingReadIndexMessages.push(m)
        return null
      }
      sendMsgReadIndexResponse(r, m)
      return null
    case MsgForgetLeader:
      return null
  }

  const pr = r.trk.Progress.get(m.GetFrom())
  if (!pr) {
    r.logger.Debugf('%x no progress available for %x', r.id, m.GetFrom())
    return null
  }
  switch (m.GetType()) {
    case MsgAppResp:
      pr.RecentActive = true
      if (m.GetReject()) {
        r.logger.Debugf('%x received MsgAppResp(rejected, hint: (index %d, term %d)) from %x for index %d',
          r.id, m.GetRejectHint(), m.GetLogTerm(), m.GetFrom(), m.GetIndex())
        let nextProbeIdx = m.GetRejectHint()
        if (m.GetLogTerm() > 0) nextProbeIdx = r.raftLog.findConflictByTerm(m.GetRejectHint(), m.GetLogTerm())[0]
        if (pr.MaybeDecrTo(m.GetIndex(), nextProbeIdx)) {
          r.logger.Debugf('%x decreased progress of %x to [%s]', r.id, m.GetFrom(), pr)
          if (pr.State === StateReplicate) pr.BecomeProbe()
          r.sendAppend(m.GetFrom())
        }
      } else {
        if (pr.MaybeUpdate(m.GetIndex()) || (pr.Match === m.GetIndex() && pr.State === StateProbe)) {
          if (pr.State === StateProbe) {
            pr.BecomeReplicate()
          } else if (pr.State === StateSnapshot && pr.Match + 1 >= r.raftLog.firstIndex()) {
            r.logger.Debugf('%x recovered from needing snapshot, resumed sending replication messages to %x [%s]', r.id, m.GetFrom(), pr)
            pr.BecomeProbe()
            pr.BecomeReplicate()
          } else if (pr.State === StateReplicate) {
            pr.Inflights!.FreeLE(m.GetIndex())
          }
          if (r.maybeCommit()) {
            releasePendingReadIndexMessages(r)
            r.bcastAppend()
          } else if (r.id !== m.GetFrom() && pr.CanBumpCommit(r.raftLog.committed)) {
            r.sendAppend(m.GetFrom())
          }
          if (r.id !== m.GetFrom()) {
            while (r.maybeSendAppend(m.GetFrom(), false)) { /* loop */ }
          }
          if (m.GetFrom() === r.leadTransferee && pr.Match === r.raftLog.lastIndex()) {
            r.logger.Infof('%x sent MsgTimeoutNow to %x after received MsgAppResp', r.id, m.GetFrom())
            r.sendTimeoutNow(m.GetFrom())
          }
        }
      }
      break
    case MsgHeartbeatResp: {
      pr.RecentActive = true
      pr.MsgAppFlowPaused = false
      if (pr.Match < r.raftLog.lastIndex() || pr.State === StateProbe) r.sendAppend(m.GetFrom())
      if (r.readOnly.option !== ReadOnlySafe || (m.GetContext()?.length ?? 0) === 0) return null
      r.readOnly.recvAck(m.GetFrom(), m.GetContext())
      const rss = r.readOnly.maybeAdvance(r.trk.Voters)
      for (const rs of rss) {
        const resp = r.responseToReadIndexReq(rs.req, rs.index)
        if (resp.GetTo() !== None) r.send(resp)
      }
      break
    }
    case MsgSnapStatus:
      if (pr.State !== StateSnapshot) return null
      if (!m.GetReject()) {
        pr.BecomeProbe()
        r.logger.Debugf('%x snapshot succeeded, resumed sending replication messages to %x [%s]', r.id, m.GetFrom(), pr)
      } else {
        pr.PendingSnapshot = 0
        pr.BecomeProbe()
        r.logger.Debugf('%x snapshot failed, resumed sending replication messages to %x [%s]', r.id, m.GetFrom(), pr)
      }
      pr.MsgAppFlowPaused = true
      break
    case MsgUnreachable:
      if (pr.State === StateReplicate) pr.BecomeProbe()
      r.logger.Debugf('%x failed to send message to %x because it is unreachable [%s]', r.id, m.GetFrom(), pr)
      break
    case MsgTransferLeader: {
      if (pr.IsLearner) {
        r.logger.Debugf('%x is learner. Ignored transferring leadership', r.id)
        return null
      }
      const leadTransferee = m.GetFrom()
      const lastLeadTransferee = r.leadTransferee
      if (lastLeadTransferee !== None) {
        if (lastLeadTransferee === leadTransferee) {
          r.logger.Infof('%x [term %d] transfer leadership to %x is in progress, ignores request to same node %x',
            r.id, r.Term, leadTransferee, leadTransferee)
          return null
        }
        r.abortLeaderTransfer()
        r.logger.Infof('%x [term %d] abort previous transferring leadership to %x', r.id, r.Term, lastLeadTransferee)
      }
      if (leadTransferee === r.id) {
        r.logger.Debugf('%x is already leader. Ignored transferring leadership to self', r.id)
        return null
      }
      r.logger.Infof('%x [term %d] starts to transfer leadership to %x', r.id, r.Term, leadTransferee)
      r.electionElapsed = 0
      r.leadTransferee = leadTransferee
      if (pr.Match === r.raftLog.lastIndex()) {
        r.sendTimeoutNow(leadTransferee)
        r.logger.Infof('%x sends MsgTimeoutNow to %x immediately as %x already has up-to-date log', r.id, leadTransferee, leadTransferee)
      } else {
        r.sendAppend(leadTransferee)
      }
      break
    }
  }
  return null
}

function stepCandidate(r: raft, m: Message): Error | null {
  const myVoteRespType = r.state === StatePreCandidate ? MsgPreVoteResp : MsgVoteResp
  switch (m.GetType()) {
    case MsgProp:
      r.logger.Infof('%x no leader at term %d; dropping proposal', r.id, r.Term)
      return ErrProposalDropped
    case MsgApp:
      r.becomeFollower(m.GetTerm(), m.GetFrom())
      r.handleAppendEntries(m)
      break
    case MsgHeartbeat:
      r.becomeFollower(m.GetTerm(), m.GetFrom())
      r.handleHeartbeat(m)
      break
    case MsgSnap:
      r.becomeFollower(m.GetTerm(), m.GetFrom())
      r.handleSnapshot(m)
      break
    case myVoteRespType: {
      const [gr, rj, res] = r.poll(m.GetFrom(), m.GetType(), !m.GetReject())
      r.logger.Infof('%x has received %d %s votes and %d vote rejections', r.id, gr, msgTypeName(m.GetType()), rj)
      if (res === VoteWon) {
        if (r.state === StatePreCandidate) {
          r.campaign(campaignElection)
        } else {
          r.becomeLeader()
          r.bcastAppend()
        }
      } else if (res === VoteLost) {
        r.becomeFollower(r.Term, None)
      }
      break
    }
    case MsgTimeoutNow:
      r.logger.Debugf('%x [term %d state %v] ignored MsgTimeoutNow from %x', r.id, r.Term, stateTypeString(r.state), m.GetFrom())
      break
  }
  return null
}

function stepFollower(r: raft, m: Message): Error | null {
  switch (m.GetType()) {
    case MsgProp:
      if (r.lead === None) {
        r.logger.Infof('%x no leader at term %d; dropping proposal', r.id, r.Term)
        return ErrProposalDropped
      } else if (r.disableProposalForwarding) {
        r.logger.Infof('%x not forwarding to leader %x at term %d; dropping proposal', r.id, r.lead, r.Term)
        return ErrProposalDropped
      }
      m.To = r.lead
      r.send(m)
      break
    case MsgApp:
      r.electionElapsed = 0
      r.lead = m.GetFrom()
      r.handleAppendEntries(m)
      break
    case MsgHeartbeat:
      r.electionElapsed = 0
      r.lead = m.GetFrom()
      r.handleHeartbeat(m)
      break
    case MsgSnap:
      r.electionElapsed = 0
      r.lead = m.GetFrom()
      r.handleSnapshot(m)
      break
    case MsgTransferLeader:
      if (r.lead === None) {
        r.logger.Infof('%x no leader at term %d; dropping leader transfer msg', r.id, r.Term)
        return null
      }
      m.To = r.lead
      r.send(m)
      break
    case MsgForgetLeader:
      if (r.readOnly.option === ReadOnlyLeaseBased) {
        r.logger.Error('ignoring MsgForgetLeader due to ReadOnlyLeaseBased')
        return null
      }
      if (r.lead !== None) {
        r.logger.Infof('%x forgetting leader %x at term %d', r.id, r.lead, r.Term)
        r.lead = None
      }
      break
    case MsgTimeoutNow:
      r.logger.Infof('%x [term %d] received MsgTimeoutNow from %x and starts an election to get leadership.', r.id, r.Term, m.GetFrom())
      r.hup(campaignTransfer)
      break
    case MsgReadIndex:
      if (r.lead === None) {
        r.logger.Infof('%x no leader at term %d; dropping index reading msg', r.id, r.Term)
        return null
      }
      m.To = r.lead
      r.send(m)
      break
    case MsgReadIndexResp:
      if (m.GetEntries().length !== 1) {
        r.logger.Errorf('%x invalid format of MsgReadIndexResp from %x, entries count: %d', r.id, m.GetFrom(), m.GetEntries().length)
        return null
      }
      r.readStates.push({ Index: m.GetIndex(), RequestCtx: m.GetEntries()[0].GetData() })
      break
  }
  return null
}

function logSliceFromMsgApp(m: Message): logSlice {
  return new logSlice(m.GetTerm(), { term: m.GetLogTerm(), index: m.GetIndex() }, m.GetEntries())
}

function releasePendingReadIndexMessages(r: raft): void {
  if (r.pendingReadIndexMessages.length === 0) return
  if (!r.committedEntryInCurrentTerm()) {
    r.logger.Error('pending MsgReadIndex should be released only after first commit in current term')
    return
  }
  const msgs = r.pendingReadIndexMessages
  r.pendingReadIndexMessages = []
  for (const m of msgs) sendMsgReadIndexResponse(r, m)
}

function sendMsgReadIndexResponse(r: raft, m: Message): void {
  if (r.trk.IsVoter(r.id) && r.trk.IsSingleton()) {
    const resp = r.responseToReadIndexReq(m, r.raftLog.committed)
    if (resp.GetTo() !== None) r.send(resp)
    return
  }
  switch (r.readOnly.option) {
    case ReadOnlySafe:
      r.readOnly.addRequest(r.raftLog.committed, m)
      r.readOnly.recvAck(r.id, r.readOnly.heartbeatCtx())
      r.bcastHeartbeat()
      break
    case ReadOnlyLeaseBased: {
      const resp = r.responseToReadIndexReq(m, r.raftLog.committed)
      if (resp.GetTo() !== None) r.send(resp)
      break
    }
  }
}

// Test hook, as raft_test.go's setRandomizedElectionTimeout.
export function setRandomizedElectionTimeout(r: raft, v: number): void {
  r.randomizedElectionTimeout = v
}
