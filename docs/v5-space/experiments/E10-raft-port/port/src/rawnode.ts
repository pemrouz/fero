// Port of go.etcd.io/raft/v3/rawnode.go and bootstrap.go at c51f010.
import {
  Message, Entry, ConfChange, type HardState, type ConfChangeI, type ConfState,
  MsgHup, MsgProp, MsgStorageAppend, MsgStorageAppendResp, MsgStorageApply, MsgStorageApplyResp,
  MsgUnreachable, MsgSnapStatus, MsgTransferLeader, MsgForgetLeader, MsgReadIndex,
  EntryConfChange, ConfChangeAddNode, marshalConfChangeV1,
} from './raftpb.ts'
import { type Config, type raft, newRaft, LocalAppendThread, LocalApplyThread, None } from './raft.ts'
import { Ready, SoftState, IsEmptyHardState, IsEmptySnap, isHardStateEqual, confChangeToMsg, SnapshotFailure, emptyState, type SnapshotStatus } from './node.ts'
import { IsLocalMsg, IsLocalMsgTarget, IsResponseMsg, entsSize } from './util.ts'
import { type BasicStatus, type Status, getStatus, getBasicStatus } from './status.ts'
import type { Progress } from './tracker.ts'

export const ErrStepLocalMsg = new Error('raft: cannot step raft local message')
export const ErrStepPeerNotFound = new Error('raft: cannot step as peer not found')

export const ProgressTypePeer = 0
export const ProgressTypeLearner = 1

export type Peer = { ID: number; Context?: Uint8Array }

export class RawNode {
  raft: raft
  asyncStorageWrites: boolean
  prevSoftSt: SoftState
  prevHardSt: HardState
  stepsOnAdvance: Message[] = []

  constructor(config: Config) {
    const r = newRaft(config)
    this.raft = r
    this.asyncStorageWrites = config.AsyncStorageWrites
    this.prevSoftSt = r.softState()
    this.prevHardSt = r.hardState()
  }

  Tick(): void { this.raft.tick() }
  TickQuiesced(): void { this.raft.electionElapsed++ }

  Campaign(): Error | null {
    return this.raft.Step(new Message({ Type: MsgHup }))
  }

  Propose(data: Uint8Array | undefined): Error | null {
    return this.raft.Step(new Message({ Type: MsgProp, From: this.raft.id, Entries: [new Entry({ Data: data })] }))
  }

  ProposeConfChange(cc: ConfChangeI): Error | null {
    return this.raft.Step(confChangeToMsg(cc))
  }

  ApplyConfChange(cc: ConfChangeI): ConfState {
    return this.raft.applyConfChange(cc.AsV2())
  }

  Step(m: Message): Error | null {
    if (IsLocalMsg(m.GetType()) && !IsLocalMsgTarget(m.GetFrom())) return ErrStepLocalMsg
    if (IsResponseMsg(m.GetType()) && !IsLocalMsgTarget(m.GetFrom()) && !this.raft.trk.Progress.get(m.GetFrom())) {
      return ErrStepPeerNotFound
    }
    return this.raft.Step(m)
  }

  Ready(): Ready {
    const rd = this.readyWithoutAccept()
    this.acceptReady(rd)
    return rd
  }

  readyWithoutAccept(): Ready {
    const r = this.raft
    const rd = new Ready()
    rd.Entries = r.raftLog.nextUnstableEnts()
    rd.CommittedEntries = r.raftLog.nextCommittedEnts(this.applyUnstableEntries())
    rd.Messages = r.msgs.slice()
    const softSt = r.softState()
    if (!softSt.equal(this.prevSoftSt)) rd.SoftState = softSt
    const hardSt = r.hardState()
    if (!isHardStateEqual(hardSt, this.prevHardSt)) rd.HardState = hardSt
    if (r.raftLog.hasNextUnstableSnapshot()) rd.Snapshot = r.raftLog.nextUnstableSnapshot()
    if (r.readStates.length !== 0) rd.ReadStates = r.readStates
    rd.MustSync = MustSync(r.hardState(), this.prevHardSt, rd.Entries.length)
    if (this.asyncStorageWrites) {
      if (needStorageAppendMsg(r, rd)) rd.Messages.push(newStorageAppendMsg(r, rd))
      if (needStorageApplyMsg(rd)) rd.Messages.push(newStorageApplyMsg(r, rd))
    } else {
      for (const m of r.msgsAfterAppend) if (m.GetTo() !== r.id) rd.Messages.push(m)
    }
    return rd
  }

  acceptReady(rd: Ready): void {
    if (rd.SoftState) this.prevSoftSt = rd.SoftState
    if (!IsEmptyHardState(rd.HardState)) this.prevHardSt = rd.HardState!
    if (rd.ReadStates.length !== 0) this.raft.readStates = []
    if (!this.asyncStorageWrites) {
      if (this.stepsOnAdvance.length !== 0) this.raft.logger.Panicf('two accepted Ready structs without call to Advance')
      for (const m of this.raft.msgsAfterAppend) if (m.GetTo() === this.raft.id) this.stepsOnAdvance.push(m)
      if (needStorageAppendRespMsg(this.raft, rd)) this.stepsOnAdvance.push(newStorageAppendRespMsg(this.raft, rd))
      if (needStorageApplyRespMsg(rd)) this.stepsOnAdvance.push(newStorageApplyRespMsg(this.raft, rd.CommittedEntries))
    }
    this.raft.msgs = []
    this.raft.msgsAfterAppend = []
    this.raft.raftLog.acceptUnstable()
    if (rd.CommittedEntries.length > 0) {
      const ents = rd.CommittedEntries
      const index = ents[ents.length - 1].GetIndex()
      this.raft.raftLog.acceptApplying(index, entsSize(ents), this.applyUnstableEntries())
    }
  }

  applyUnstableEntries(): boolean { return !this.asyncStorageWrites }

  HasReady(): boolean {
    const r = this.raft
    if (!r.softState().equal(this.prevSoftSt)) return true
    const hardSt = r.hardState()
    if (!IsEmptyHardState(hardSt) && !isHardStateEqual(hardSt, this.prevHardSt)) return true
    if (r.raftLog.hasNextUnstableSnapshot()) return true
    if (r.msgs.length > 0 || r.msgsAfterAppend.length > 0) return true
    if (r.raftLog.hasNextUnstableEnts() || r.raftLog.hasNextCommittedEnts(this.applyUnstableEntries())) return true
    if (r.readStates.length !== 0) return true
    return false
  }

  Advance(_rd?: Ready): void {
    if (this.asyncStorageWrites) this.raft.logger.Panicf('Advance must not be called when using AsyncStorageWrites')
    const steps = this.stepsOnAdvance
    this.stepsOnAdvance = []
    for (const m of steps) this.raft.Step(m)
  }

  Status(): Status { return getStatus(this.raft) }
  BasicStatus(): BasicStatus { return getBasicStatus(this.raft) }

  WithProgress(visitor: (id: number, typ: number, pr: Progress) => void): void {
    this.raft.trk.Visit((id, pr) => {
      const typ = pr.IsLearner ? ProgressTypeLearner : ProgressTypePeer
      const p = pr.copy()
      p.Inflights = null
      visitor(id, typ, p)
    })
  }

  ReportUnreachable(id: number): void {
    this.raft.Step(new Message({ Type: MsgUnreachable, From: id }))
  }

  ReportSnapshot(id: number, status: SnapshotStatus): void {
    const rej = status === SnapshotFailure
    this.raft.Step(new Message({ Type: MsgSnapStatus, From: id, Reject: rej }))
  }

  TransferLeader(transferee: number): void {
    this.raft.Step(new Message({ Type: MsgTransferLeader, From: transferee }))
  }

  ForgetLeader(): Error | null {
    return this.raft.Step(new Message({ Type: MsgForgetLeader }))
  }

  ReadIndex(rctx: Uint8Array): void {
    this.raft.Step(new Message({ Type: MsgReadIndex, Entries: [new Entry({ Data: rctx })] }))
  }

  // bootstrap.go
  Bootstrap(peers: Peer[]): Error | null {
    if (peers.length === 0) return new Error('must provide at least one peer to Bootstrap')
    const [lastIndex, err] = this.raft.raftLog.storage.LastIndex()
    if (err) return err
    if (lastIndex !== 0) return new Error("can't bootstrap a nonempty Storage")
    this.prevHardSt = emptyState
    this.raft.becomeFollower(1, None)
    const ents = peers.map((peer, i) => {
      const cc = new ConfChange({ Type: ConfChangeAddNode, NodeId: peer.ID, Context: peer.Context })
      return new Entry({ Type: EntryConfChange, Term: 1, Index: i + 1, Data: marshalConfChangeV1(cc) })
    })
    this.raft.raftLog.append(...ents)
    this.raft.raftLog.committed = ents.length
    for (const peer of peers) this.raft.applyConfChange(new ConfChange({ NodeId: peer.ID, Type: ConfChangeAddNode }).AsV2())
    return null
  }
}

export function NewRawNode(config: Config): [RawNode, Error | null] {
  return [new RawNode(config), null]
}

export function MustSync(st: HardState, prevst: HardState, entsnum: number): boolean {
  return entsnum !== 0 || st.GetVote() !== prevst.GetVote() || st.GetTerm() !== prevst.GetTerm()
}

function needStorageAppendMsg(r: raft, rd: Ready): boolean {
  return rd.Entries.length > 0 || !IsEmptyHardState(rd.HardState) || !IsEmptySnap(rd.Snapshot) || r.msgsAfterAppend.length > 0
}

function needStorageAppendRespMsg(r: raft, rd: Ready): boolean {
  return r.raftLog.hasNextOrInProgressUnstableEnts() || !IsEmptySnap(rd.Snapshot)
}

function newStorageAppendMsg(r: raft, rd: Ready): Message {
  const m = new Message({ Type: MsgStorageAppend, To: LocalAppendThread, From: r.id, Entries: rd.Entries })
  if (!IsEmptyHardState(rd.HardState)) {
    m.Term = rd.GetTerm()
    m.Vote = rd.GetVote()
    m.Commit = rd.GetCommit()
  }
  if (!IsEmptySnap(rd.Snapshot)) m.Snapshot = rd.Snapshot!
  m.Responses = r.msgsAfterAppend.slice()
  if (needStorageAppendRespMsg(r, rd)) m.Responses.push(newStorageAppendRespMsg(r, rd))
  return m
}

function newStorageAppendRespMsg(r: raft, rd: Ready): Message {
  const m = new Message({ Type: MsgStorageAppendResp, To: r.id, From: LocalAppendThread, Term: r.Term })
  if (r.raftLog.hasNextOrInProgressUnstableEnts()) {
    const last = r.raftLog.lastEntryID()
    m.Index = last.index
    m.LogTerm = last.term
  }
  if (!IsEmptySnap(rd.Snapshot)) m.Snapshot = rd.Snapshot!
  return m
}

function needStorageApplyMsg(rd: Ready): boolean { return rd.CommittedEntries.length > 0 }
function needStorageApplyRespMsg(rd: Ready): boolean { return needStorageApplyMsg(rd) }

function newStorageApplyMsg(r: raft, rd: Ready): Message {
  const ents = rd.CommittedEntries
  return new Message({
    Type: MsgStorageApply, To: LocalApplyThread, From: r.id, Term: 0, Entries: ents,
    Responses: [newStorageApplyRespMsg(r, ents)],
  })
}

function newStorageApplyRespMsg(r: raft, ents: Entry[]): Message {
  return new Message({ Type: MsgStorageApplyResp, To: r.id, From: LocalApplyThread, Term: 0, Entries: ents })
}
