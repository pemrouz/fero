// Port of quorum/datadriven_test.go and the alternative committed-index check
// from quorum/quick_test.go at c51f010.
import { sprintf } from '../src/gofmt.ts'
import {
  type AckedIndexer, type Index, type MajorityConfig, MapAckIndexer, IndexMax, indexString,
  majorityCommittedIndex, majorityDescribe, jointCommittedIndex, jointDescribe, jointIDs,
  majorityVoteResult, jointVoteResult, voteResultString,
} from '../src/quorum.ts'
import { type TestData, scanInt } from './datadriven.ts'

function alternativeMajorityCommittedIndex(c: MajorityConfig, l: AckedIndexer): Index {
  if (!c || c.size === 0) return IndexMax
  const idToIdx = new Map<number, Index>()
  for (const id of c) {
    const [idx, ok] = l.AckedIndex(id)
    if (ok) idToIdx.set(id, idx)
  }
  const idxToVotes = new Map<Index, number>()
  for (const idx of idToIdx.values()) idxToVotes.set(idx, 0)
  for (const idx of idToIdx.values()) {
    for (const idy of idxToVotes.keys()) {
      if (idy > idx) continue
      idxToVotes.set(idy, idxToVotes.get(idy)! + 1)
    }
  }
  const q = Math.floor(c.size / 2) + 1
  let maxQuorumIdx = 0
  for (const [idx, n] of idxToVotes) if (n >= q && idx > maxQuorumIdx) maxQuorumIdx = idx
  return maxQuorumIdx
}

export function quorumHandle(d: TestData): string {
  let joint = false
  const ids: number[] = []
  const idsj: number[] = []
  const idxs: Index[] = []
  const votes: Index[] = []
  for (const arg of d.CmdArgs) {
    for (let i = 0; i < arg.Vals.length; i++) {
      switch (arg.Key) {
        case 'cfg': ids.push(scanInt(arg, i)); break
        case 'cfgj':
          joint = true
          if (arg.Vals[i] === 'zero') {
            if (arg.Vals.length !== 1) throw new Error("cannot mix 'zero' into configuration")
          } else idsj.push(scanInt(arg, i))
          break
        case 'idx': {
          let n = 0
          if (arg.Vals[i] !== '_') {
            n = scanInt(arg, i)
            if (n === 0) throw new Error('cannot use 0 as idx')
          }
          idxs.push(n)
          break
        }
        case 'votes': {
          const s = arg.Vals[i]
          if (s === 'y') votes.push(2)
          else if (s === 'n') votes.push(1)
          else if (s === '_') votes.push(0)
          else throw new Error(`unknown vote: ${s}`)
          break
        }
        default: throw new Error(`unknown arg ${arg.Key}`)
      }
    }
  }
  const c: Set<number> = new Set(ids)
  const cj: Set<number> = new Set(idsj)
  const makeLookuper = (idxs: Index[], ids: number[], idsj: number[]): MapAckIndexer => {
    const l = new MapAckIndexer()
    let p = 0
    for (const id of [...ids, ...idsj]) {
      if (l.m.has(id)) continue
      if (p < idxs.length) {
        l.m.set(id, idxs[p])
        p++
      }
    }
    for (const [id, v] of [...l.m]) if (v === 0) l.m.delete(id)
    return l
  }
  {
    const input = d.Cmd === 'vote' ? votes : idxs
    const voters = jointIDs([c, cj])
    if (voters.size !== input.length) return sprintf('error: mismatched input (explicit or _) for voters %v: %v', voters, input)
  }
  let buf = ''
  switch (d.Cmd) {
    case 'committed': {
      const l = makeLookuper(idxs, ids, idsj)
      if (!joint) {
        const idx = majorityCommittedIndex(c, l)
        buf += majorityDescribe(c, l)
        let a = alternativeMajorityCommittedIndex(c, l)
        if (a !== idx) buf += `${indexString(a)} <-- via alternative computation\n`
        a = jointCommittedIndex([c, new Set()], l)
        if (a !== idx) buf += `${indexString(a)} <-- via zero-joint quorum\n`
        a = jointCommittedIndex([c, c], l)
        if (a !== idx) buf += `${indexString(a)} <-- via self-joint quorum\n`
        const overlay = (c: Set<number>, l: AckedIndexer, id: number, idx: Index): AckedIndexer => {
          const ll = new MapAckIndexer()
          for (const iid of c) {
            if (iid === id) ll.m.set(iid, idx)
            else {
              const [x, ok] = l.AckedIndex(iid)
              if (ok) ll.m.set(iid, x)
            }
          }
          return ll
        }
        for (const id of c) {
          const [iidx] = l.AckedIndex(id)
          if (idx > iidx && iidx > 0) {
            let lo = overlay(c, l, id, iidx - 1)
            let aIdx = majorityCommittedIndex(c, lo)
            if (aIdx !== idx) buf += sprintf('%s <-- overlaying %d->%d', indexString(aIdx), id, iidx)
            lo = overlay(c, l, id, 0)
            aIdx = majorityCommittedIndex(c, lo)
            if (aIdx !== idx) buf += sprintf('%s <-- overlaying %d->0', indexString(aIdx), id)
          }
        }
        buf += indexString(idx) + '\n'
      } else {
        const idx = jointCommittedIndex([c, cj], l)
        buf += jointDescribe([c, cj], l)
        const a = jointCommittedIndex([cj, c], l)
        if (a !== idx) buf += `${indexString(a)} <-- via symmetry\n`
        buf += indexString(idx) + '\n'
      }
      break
    }
    case 'vote': {
      const ll = makeLookuper(votes, ids, idsj)
      const l = new Map<number, boolean>()
      for (const [id, v] of ll.m) l.set(id, v !== 1)
      if (!joint) {
        buf += voteResultString(majorityVoteResult(c, l)) + '\n'
      } else {
        const r = jointVoteResult([c, cj], l)
        const ar = jointVoteResult([cj, c], l)
        if (ar !== r) buf += `${voteResultString(ar)} <-- via symmetry\n`
        buf += voteResultString(r) + '\n'
      }
      break
    }
    default: throw new Error(`unknown command: ${d.Cmd}`)
  }
  return buf
}
