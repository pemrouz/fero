// Port of go.etcd.io/raft/v3/status.go at c51f010.
import type { HardState } from './raftpb.ts'
import { type Config, type Progress } from './tracker.ts'
import { type raft, StateLeader, stateTypeString } from './raft.ts'
import { SoftState } from './node.ts'
import { sprintf, goQuote } from './gofmt.ts'
import { progressStateString } from './tracker.ts'

export class BasicStatus {
  ID = 0
  HardState: HardState | null = null
  SoftState: SoftState = new SoftState(0, 0)
  Applied = 0
  LeadTransferee = 0
  GetTerm(): number { return this.HardState?.GetTerm() ?? 0 }
  GetVote(): number { return this.HardState?.GetVote() ?? 0 }
  GetCommit(): number { return this.HardState?.GetCommit() ?? 0 }
  get Lead(): number { return this.SoftState.Lead }
  get RaftState(): number { return this.SoftState.RaftState }
}

export class Status extends BasicStatus {
  Config!: Config
  Progress: Map<number, Progress> = new Map()
  MarshalJSON(): string {
    let j = sprintf('{"id":"%x","term":%d,"vote":"%x","commit":%d,"lead":"%x","raftState":%s,"applied":%d,"progress":{',
      this.ID, this.GetTerm(), this.GetVote(), this.GetCommit(), this.Lead, goQuote(stateTypeString(this.RaftState)), this.Applied)
    if (this.Progress.size === 0) {
      j += '},'
    } else {
      for (const [k, v] of this.Progress) {
        j += sprintf('"%x":{"match":%d,"next":%d,"state":%s},', k, v.Match, v.Next, goQuote(progressStateString(v.State)))
      }
      j = j.slice(0, -1) + '},'
    }
    j += sprintf('"leadtransferee":"%x"}', this.LeadTransferee)
    return j
  }
  String(): string { return this.MarshalJSON() }
}

function getProgressCopy(r: raft): Map<number, Progress> {
  const m = new Map<number, Progress>()
  r.trk.Visit((id, pr) => {
    const p = pr.copy()
    p.Inflights = pr.Inflights!.Clone()
    m.set(id, p)
  })
  return m
}

function fillBasicStatus(s: BasicStatus, r: raft): void {
  s.ID = r.id
  s.LeadTransferee = r.leadTransferee
  s.HardState = r.hardState()
  s.SoftState = r.softState()
  s.Applied = r.raftLog.applied
}

export function getBasicStatus(r: raft): BasicStatus {
  const s = new BasicStatus()
  fillBasicStatus(s, r)
  return s
}

export function getStatus(r: raft): Status {
  const s = new Status()
  fillBasicStatus(s, r)
  if (s.RaftState === StateLeader) s.Progress = getProgressCopy(r)
  s.Config = r.trk.Config.Clone()
  return s
}
