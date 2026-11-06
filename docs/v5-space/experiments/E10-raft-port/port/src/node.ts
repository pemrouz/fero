// The types and helpers of go.etcd.io/raft/v3/node.go at c51f010 (SoftState, Ready,
// IsEmptyHardState, IsEmptySnap, confChangeToMsg). The goroutine-driven Node itself is
// not ported: it is channels around RawNode, and a TS host drives RawNode directly.
import {
  HardState, type Snapshot, type Entry, type Message, type ConfChangeI, Message as Msg, Entry as Ent,
  MsgProp, MarshalConfChange,
} from './raftpb.ts'
import type { StateType } from './raft.ts'
import type { ReadState } from './read_only.ts'

export const SnapshotFinish = 1
export const SnapshotFailure = 2
export type SnapshotStatus = number

const emptyState = new HardState()

export class SoftState {
  Lead: number
  RaftState: StateType
  constructor(lead: number, state: StateType) {
    this.Lead = lead
    this.RaftState = state
  }
  equal(b: SoftState): boolean {
    return this.Lead === b.Lead && this.RaftState === b.RaftState
  }
}

export class Ready {
  SoftState: SoftState | null = null
  HardState: HardState | null = null
  ReadStates: ReadState[] = []
  Entries: Entry[] = []
  Snapshot: Snapshot | null = null
  CommittedEntries: Entry[] = []
  Messages: Message[] = []
  MustSync = false
  GetTerm(): number { return this.HardState?.GetTerm() ?? 0 }
  GetVote(): number { return this.HardState?.GetVote() ?? 0 }
  GetCommit(): number { return this.HardState?.GetCommit() ?? 0 }
}

export function isHardStateEqual(a: HardState | null, b: HardState | null): boolean {
  return (a?.GetTerm() ?? 0) === (b?.GetTerm() ?? 0) && (a?.GetVote() ?? 0) === (b?.GetVote() ?? 0) &&
    (a?.GetCommit() ?? 0) === (b?.GetCommit() ?? 0)
}

export function IsEmptyHardState(st: HardState | null | undefined): boolean {
  return !st || isHardStateEqual(st, emptyState)
}

export function IsEmptySnap(sp: Snapshot | null | undefined): boolean {
  return (sp?.Metadata?.Index ?? 0) === 0
}

export function confChangeToMsg(c: ConfChangeI | null): Message {
  const [typ, data] = MarshalConfChange(c)
  return new Msg({ Type: MsgProp, Entries: [new Ent({ Type: typ, Data: data })] })
}

export { emptyState }
