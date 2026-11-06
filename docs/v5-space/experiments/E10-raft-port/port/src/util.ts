// Port of go.etcd.io/raft/v3/util.go at c51f010.
import { sprintf, goQuote } from './gofmt.ts'
import {
  type Entry, type Message, type HardState, type ConfState, type Snapshot, type ConfChangeI,
  MsgHup, MsgBeat, MsgUnreachable, MsgSnapStatus, MsgCheckQuorum, MsgStorageAppend, MsgStorageAppendResp,
  MsgStorageApply, MsgStorageApplyResp, MsgAppResp, MsgVoteResp, MsgHeartbeatResp, MsgReadIndexResp,
  MsgPreVoteResp, MsgVote, MsgPreVote, EntryNormal, EntryConfChange, EntryConfChangeV2,
  msgTypeName, entryTypeName, entrySize, ConfChangesToString, unmarshalConfChangeV1, unmarshalConfChangeV2,
  ConfChangeTransitionName, ConfChangeTypeName,
} from './raftpb.ts'
import { None, LocalAppendThread, LocalApplyThread, stateTypeString } from './raft.ts'
import { type Ready, type SoftState, IsEmptyHardState, IsEmptySnap } from './node.ts'
import type { Logger } from './logger.ts'

const isLocalMsgArr: boolean[] = []
for (const t of [MsgHup, MsgBeat, MsgUnreachable, MsgSnapStatus, MsgCheckQuorum, MsgStorageAppend,
  MsgStorageAppendResp, MsgStorageApply, MsgStorageApplyResp]) isLocalMsgArr[t] = true
const isResponseMsgArr: boolean[] = []
for (const t of [MsgAppResp, MsgVoteResp, MsgHeartbeatResp, MsgUnreachable, MsgReadIndexResp,
  MsgPreVoteResp, MsgStorageAppendResp, MsgStorageApplyResp]) isResponseMsgArr[t] = true

export function IsLocalMsg(t: number): boolean { return isLocalMsgArr[t] === true }
export function IsResponseMsg(t: number): boolean { return isResponseMsgArr[t] === true }
export function IsLocalMsgTarget(id: number): boolean { return id === LocalAppendThread || id === LocalApplyThread }

export function voteRespMsgType(t: number): number {
  switch (t) {
    case MsgVote: return MsgVoteResp
    case MsgPreVote: return MsgPreVoteResp
    default: throw new Error(`not a vote message: ${msgTypeName(t)}`)
  }
}

export function DescribeHardState(hs: HardState): string {
  let buf = sprintf('Term:%d', hs.GetTerm())
  if (hs.GetVote() !== 0) buf += sprintf(' Vote:%d', hs.GetVote())
  buf += sprintf(' Commit:%d', hs.GetCommit())
  return buf
}

export function DescribeSoftState(ss: SoftState): string {
  return sprintf('Lead:%d State:%s', ss.Lead, stateTypeString(ss.RaftState))
}

export function DescribeConfState(state: ConfState): string {
  return sprintf('Voters:%v VotersOutgoing:%v Learners:%v LearnersNext:%v AutoLeave:%v',
    state.Voters, state.VotersOutgoing, state.Learners, state.LearnersNext, state.GetAutoLeave())
}

export function DescribeSnapshot(snap: Snapshot): string {
  const m = snap.Metadata
  return sprintf('Index:%d Term:%d ConfState:%s', m?.GetIndex() ?? 0, m?.GetTerm() ?? 0,
    DescribeConfState(m?.ConfState ?? ({ Voters: [], VotersOutgoing: [], Learners: [], LearnersNext: [], GetAutoLeave: () => false } as unknown as ConfState)))
}

export type EntryFormatter = ((data: Uint8Array | undefined) => string) | null

export function DescribeReady(rd: Ready, f: EntryFormatter): string {
  let buf = ''
  if (rd.SoftState) buf += DescribeSoftState(rd.SoftState) + '\n'
  if (!IsEmptyHardState(rd.HardState)) buf += sprintf('HardState %s', DescribeHardState(rd.HardState!)) + '\n'
  if (rd.ReadStates.length > 0) buf += sprintf('ReadStates %v\n', rd.ReadStates.map(r => ({ Index: r.Index, RequestCtx: r.RequestCtx ?? new Uint8Array(0) })))
  if (rd.Entries.length > 0) {
    buf += 'Entries:\n'
    buf += DescribeEntries(rd.Entries, f)
  }
  if (!IsEmptySnap(rd.Snapshot)) buf += sprintf('Snapshot %s\n', DescribeSnapshot(rd.Snapshot!))
  if (rd.CommittedEntries.length > 0) {
    buf += 'CommittedEntries:\n'
    buf += DescribeEntries(rd.CommittedEntries, f)
  }
  if (rd.Messages.length > 0) {
    buf += 'Messages:\n'
    for (const msg of rd.Messages) buf += DescribeMessage(msg, f) + '\n'
  }
  if (buf.length > 0) return sprintf('Ready MustSync=%t:\n%s', rd.MustSync, buf)
  return '<empty Ready>'
}

export function DescribeMessage(m: Message, f: EntryFormatter): string {
  return describeMessageWithIndent('', m, f)
}

function describeMessageWithIndent(indent: string, m: Message, f: EntryFormatter): string {
  let buf = sprintf('%s%s->%s %v Term:%d Log:%d/%d', indent, describeTarget(m.GetFrom()), describeTarget(m.GetTo()),
    msgTypeName(m.GetType()), m.GetTerm(), m.GetLogTerm(), m.GetIndex())
  if (m.GetReject()) buf += sprintf(' Rejected (Hint: %d)', m.GetRejectHint())
  if (m.GetCommit() !== 0) buf += sprintf(' Commit:%d', m.GetCommit())
  if (m.GetVote() !== 0) buf += sprintf(' Vote:%d', m.GetVote())
  const ents = m.GetEntries()
  if (ents.length === 1) {
    buf += sprintf(' Entries:[%s]', DescribeEntry(ents[0], f))
  } else if (ents.length > 1) {
    buf += ' Entries:['
    for (const e of ents) buf += sprintf('\n%s  ', indent) + DescribeEntry(e, f)
    buf += sprintf('\n%s]', indent)
  }
  const s = m.GetSnapshot()
  if (s && !IsEmptySnap(s)) buf += sprintf('\n%s  Snapshot: %s', indent, DescribeSnapshot(s))
  if (m.GetResponses().length > 0) {
    buf += ' Responses:['
    for (const r of m.GetResponses()) buf += '\n' + describeMessageWithIndent(indent + '  ', r, f)
    buf += sprintf('\n%s]', indent)
  }
  return buf
}

function describeTarget(id: number): string {
  switch (id) {
    case None: return 'None'
    case LocalAppendThread: return 'AppendThread'
    case LocalApplyThread: return 'ApplyThread'
    default: return sprintf('%x', id)
  }
}

export function DescribeEntry(e: Entry, f: EntryFormatter): string {
  if (!f) f = data => goQuote(data ?? null)
  const formatConfChange = (cc: ConfChangeI) => ConfChangesToString(cc.AsV2().Changes)
  let formatted = ''
  switch (e.GetType()) {
    case EntryNormal:
      formatted = f(e.GetData())
      break
    case EntryConfChange:
      try { formatted = formatConfChange(unmarshalConfChangeV1(e.GetData())) } catch (err) { formatted = (err as Error).message }
      break
    case EntryConfChangeV2:
      try { formatted = formatConfChange(unmarshalConfChangeV2(e.GetData())) } catch (err) { formatted = (err as Error).message }
      break
  }
  if (formatted !== '') formatted = ' ' + formatted
  return sprintf('%d/%d %s%s', e.GetTerm(), e.GetIndex(), entryTypeName(e.GetType()), formatted)
}

export function DescribeConfChange(cc: ConfChangeI): string {
  const cv2 = cc.AsV2()
  let b = sprintf('transition:%v', ConfChangeTransitionName[cv2.GetTransition()])
  for (const c of cv2.GetChanges()) b += sprintf(' changes:{type:%v node_id:%d}', ConfChangeTypeName[c.GetType()], c.GetNodeId())
  if (cv2.Context && cv2.Context.length > 0) b += sprintf(' context:%q', cv2.Context)
  return b
}

export function DescribeEntries(ents: Entry[], f: EntryFormatter): string {
  let buf = ''
  for (const e of ents) buf += DescribeEntry(e, f) + '\n'
  return buf
}

export function entsSize(ents: Entry[]): number {
  let size = 0
  for (const e of ents) size += entrySize(e)
  return size
}

// limitSize returns a prefix of ents (always at least one entry).
export function limitSize(ents: Entry[], maxSize: number): Entry[] {
  if (ents.length === 0) return ents
  let size = entrySize(ents[0])
  for (let limit = 1; limit < ents.length; limit++) {
    size += entrySize(ents[limit])
    if (size > maxSize) return ents.slice(0, limit)
  }
  return ents
}

export function payloadSize(e: Entry): number { return e.GetData()?.length ?? 0 }

export function payloadsSize(ents: Entry[]): number {
  let s = 0
  for (const e of ents) s += payloadSize(e)
  return s
}

export function assertConfStatesEquivalent(l: Logger, cs1: ConfState, cs2: ConfState): void {
  const err = cs1.Equivalent(cs2)
  if (err === null) return
  l.Panic(err)
}

export function extend(dst: Entry[], vals: Entry[]): Entry[] {
  return dst.concat(vals)
}
