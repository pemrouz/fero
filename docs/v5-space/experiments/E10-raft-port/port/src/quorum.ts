// Port of go.etcd.io/raft/v3/quorum (quorum.go, majority.go, joint.go,
// voteresult_string.go) at c51f010. A Go MajorityConfig (map[uint64]struct{},
// possibly nil) is a Set<number> or null here; a JointConfig is a pair of them.
import { sprintf } from './gofmt.ts'

export type Index = number // math.MaxUint64 is Infinity
export const IndexMax = Infinity

export function indexString(i: Index): string {
  if (i === Infinity) return '∞'
  return String(i)
}

export interface AckedIndexer {
  AckedIndex(voterID: number): [Index, boolean]
}

export class MapAckIndexer implements AckedIndexer {
  m = new Map<number, Index>()
  AckedIndex(id: number): [Index, boolean] {
    const v = this.m.get(id)
    return v === undefined ? [0, false] : [v, true]
  }
}

export const VotePending = 1
export const VoteLost = 2
export const VoteWon = 3
export type VoteResult = number
export function voteResultString(v: VoteResult): string {
  return ['VotePending', 'VoteLost', 'VoteWon'][v - 1] ?? `VoteResult(${v})`
}

export type MajorityConfig = Set<number> | null

const sortNum = (a: number, b: number) => a - b

export function majorityString(c: MajorityConfig): string {
  const sl = c ? [...c].sort(sortNum) : []
  return '(' + sl.map(id => id.toString(16)).join(' ') + ')'
}

export function majorityDescribe(c: MajorityConfig, l: AckedIndexer): string {
  if (!c || c.size === 0) return '<empty majority quorum>'
  type Tup = { id: number; idx: Index; ok: boolean; bar: number }
  const n = c.size
  const info: Tup[] = []
  for (const id of c) {
    const [idx, ok] = l.AckedIndex(id)
    info.push({ id, idx, ok, bar: 0 })
  }
  info.sort((a, b) => (a.idx !== b.idx ? (a.idx < b.idx ? -1 : 1) : a.id - b.id))
  for (let i = 1; i < info.length; i++) {
    if (info[i - 1].idx < info[i].idx) info[i].bar = i
    else info[i].bar = info[i - 1].bar
  }
  info.sort((a, b) => a.id - b.id)
  let buf = ' '.repeat(n) + '    idx\n'
  for (const t of info) {
    const bar = t.bar
    if (!t.ok) buf += '?' + ' '.repeat(n)
    else buf += 'x'.repeat(bar) + '>' + ' '.repeat(n - bar)
    buf += sprintf(' %5d    (id=%x)\n', t.idx, t.id)
  }
  return buf
}

export function majoritySlice(c: MajorityConfig): number[] {
  return c ? [...c].sort(sortNum) : []
}

export function majorityCommittedIndex(c: MajorityConfig, l: AckedIndexer): Index {
  const n = c ? c.size : 0
  if (!c || n === 0) return IndexMax
  const srt: number[] = new Array(n).fill(0)
  let i = n - 1
  for (const id of c) {
    const [idx, ok] = l.AckedIndex(id)
    if (ok) {
      srt[i] = idx
      i--
    }
  }
  srt.sort(sortNum)
  const pos = n - (Math.floor(n / 2) + 1)
  return srt[pos]
}

export function majorityVoteResult(c: MajorityConfig, votes: Map<number, boolean>): VoteResult {
  if (!c || c.size === 0) return VoteWon
  let votedCnt = 0
  let missing = 0
  for (const id of c) {
    const v = votes.get(id)
    if (v === undefined) {
      missing++
      continue
    }
    if (v) votedCnt++
  }
  const q = Math.floor(c.size / 2) + 1
  if (votedCnt >= q) return VoteWon
  if (votedCnt + missing >= q) return VotePending
  return VoteLost
}

export type JointConfig = [MajorityConfig, MajorityConfig]

export function jointString(c: JointConfig): string {
  if (c[1] && c[1].size > 0) return majorityString(c[0]) + '&&' + majorityString(c[1])
  return majorityString(c[0])
}

export function jointIDs(c: JointConfig): Set<number> {
  const m = new Set<number>()
  for (const cc of c) if (cc) for (const id of cc) m.add(id)
  return m
}

export function jointDescribe(c: JointConfig, l: AckedIndexer): string {
  return majorityDescribe(jointIDs(c), l)
}

export function jointCommittedIndex(c: JointConfig, l: AckedIndexer): Index {
  const idx0 = majorityCommittedIndex(c[0], l)
  const idx1 = majorityCommittedIndex(c[1], l)
  return idx0 < idx1 ? idx0 : idx1
}

export function jointVoteResult(c: JointConfig, votes: Map<number, boolean>): VoteResult {
  const r1 = majorityVoteResult(c[0], votes)
  const r2 = majorityVoteResult(c[1], votes)
  if (r1 === r2) return r1
  if (r1 === VoteLost || r2 === VoteLost) return VoteLost
  return VotePending
}
