// Port of go.etcd.io/raft/v3/confchange (confchange.go, restore.go) at c51f010.
import { sprintf } from './gofmt.ts'
import { type MajorityConfig, jointIDs } from './quorum.ts'
import {
  type ConfChangeSingle, ConfChangeSingle as CCS, ConfState, ConfChangeAddNode, ConfChangeAddLearnerNode,
  ConfChangeRemoveNode, ConfChangeUpdateNode, ConfChangeTypeName,
} from './raftpb.ts'
import { Config, Progress, ProgressTracker, type ProgressMap, Inflights } from './tracker.ts'

export type Result = [Config, ProgressMap | null, Error | null]

const incoming = (c: Config): MajorityConfig => c.Voters[0]
const outgoing = (c: Config): MajorityConfig => c.Voters[1]
const joint = (c: Config): boolean => (outgoing(c)?.size ?? 0) > 0

function nilAwareAdd(cfg: Config, key: 'Learners' | 'LearnersNext', id: number): void {
  if (cfg[key] === null) cfg[key] = new Set()
  cfg[key]!.add(id)
}

function nilAwareDelete(cfg: Config, key: 'Learners' | 'LearnersNext', id: number): void {
  const m = cfg[key]
  if (m === null) return
  m.delete(id)
  if (m.size === 0) cfg[key] = null
}

function symdiff(l: MajorityConfig, r: MajorityConfig): number {
  let n = 0
  for (const [a, b] of [[l, r], [r, l]] as const) {
    if (!a) continue
    for (const id of a) if (!(b?.has(id) ?? false)) n++
  }
  return n
}

function checkInvariants(cfg: Config, trk: ProgressMap): Error | null {
  for (const ids of [jointIDs(cfg.Voters), cfg.Learners, cfg.LearnersNext]) {
    if (!ids) continue
    for (const id of ids) if (!trk.has(id)) return new Error(sprintf('no progress for %d', id))
  }
  if (cfg.LearnersNext) {
    for (const id of cfg.LearnersNext) {
      if (!(outgoing(cfg)?.has(id) ?? false)) return new Error(sprintf('%d is in LearnersNext, but not Voters[1]', id))
      if (trk.get(id)!.IsLearner) return new Error(sprintf('%d is in LearnersNext, but is already marked as learner', id))
    }
  }
  if (cfg.Learners) {
    for (const id of cfg.Learners) {
      if (outgoing(cfg)?.has(id) ?? false) return new Error(sprintf('%d is in Learners and Voters[1]', id))
      if (incoming(cfg)?.has(id) ?? false) return new Error(sprintf('%d is in Learners and Voters[0]', id))
      if (!trk.get(id)!.IsLearner) return new Error(sprintf('%d is in Learners, but is not marked as learner', id))
    }
  }
  if (!joint(cfg)) {
    if (outgoing(cfg) !== null) return new Error('cfg.Voters[1] must be nil when not joint')
    if (cfg.LearnersNext !== null) return new Error('cfg.LearnersNext must be nil when not joint')
    if (cfg.AutoLeave) return new Error('AutoLeave must be false when not joint')
  }
  return null
}

function checkAndReturn(cfg: Config, trk: ProgressMap): Result {
  const err = checkInvariants(cfg, trk)
  if (err) return [new Config({ Voters: [null, null] }), new Map(), err]
  return [cfg, trk, null]
}

export class Changer {
  Tracker: ProgressTracker
  LastIndex: number
  constructor(tracker: ProgressTracker, lastIndex: number) {
    // Go copies the ProgressTracker struct into the Changer.
    this.Tracker = tracker.shallow()
    this.LastIndex = lastIndex
  }

  private err(err: Error): Result {
    return [new Config({ Voters: [null, null] }), null, err]
  }

  private checkAndCopy(): Result {
    const cfg = this.Tracker.Config.Clone()
    const trk: ProgressMap = new Map()
    for (const [id, pr] of this.Tracker.Progress) trk.set(id, pr.copy())
    return checkAndReturn(cfg, trk)
  }

  EnterJoint(autoLeave: boolean, ...ccs: ConfChangeSingle[]): Result {
    const [cfg, trk, err] = this.checkAndCopy()
    if (err) return this.err(err)
    if (joint(cfg)) return this.err(new Error('config is already joint'))
    if ((incoming(cfg)?.size ?? 0) === 0) return this.err(new Error("can't make a zero-voter config joint"))
    cfg.Voters[1] = new Set()
    for (const id of incoming(cfg) ?? []) cfg.Voters[1].add(id)
    const e2 = this.apply(cfg, trk!, ...ccs)
    if (e2) return this.err(e2)
    cfg.AutoLeave = autoLeave
    return checkAndReturn(cfg, trk!)
  }

  LeaveJoint(): Result {
    const [cfg, trk, err] = this.checkAndCopy()
    if (err) return this.err(err)
    if (!joint(cfg)) return this.err(new Error("can't leave a non-joint config"))
    for (const id of cfg.LearnersNext ?? []) {
      nilAwareAdd(cfg, 'Learners', id)
      trk!.get(id)!.IsLearner = true
    }
    cfg.LearnersNext = null
    for (const id of outgoing(cfg) ?? []) {
      const isVoter = incoming(cfg)?.has(id) ?? false
      const isLearner = cfg.Learners?.has(id) ?? false
      if (!isVoter && !isLearner) trk!.delete(id)
    }
    cfg.Voters[1] = null
    cfg.AutoLeave = false
    return checkAndReturn(cfg, trk!)
  }

  Simple(...ccs: ConfChangeSingle[]): Result {
    const [cfg, trk, err] = this.checkAndCopy()
    if (err) return this.err(err)
    if (joint(cfg)) return this.err(new Error("can't apply simple config change in joint config"))
    const e2 = this.apply(cfg, trk!, ...ccs)
    if (e2) return this.err(e2)
    if (symdiff(this.Tracker.Voters[0], incoming(cfg)) > 1) {
      return [new Config({ Voters: [null, null] }), null, new Error('more than one voter changed without entering joint config')]
    }
    return checkAndReturn(cfg, trk!)
  }

  private apply(cfg: Config, trk: ProgressMap, ...ccs: ConfChangeSingle[]): Error | null {
    for (const cc of ccs) {
      if (cc.GetNodeId() === 0) continue
      switch (cc.GetType()) {
        case ConfChangeAddNode: this.makeVoter(cfg, trk, cc.GetNodeId()); break
        case ConfChangeAddLearnerNode: this.makeLearner(cfg, trk, cc.GetNodeId()); break
        case ConfChangeRemoveNode: this.remove(cfg, trk, cc.GetNodeId()); break
        case ConfChangeUpdateNode: break
        default: return new Error(sprintf('unexpected conf type %d', cc.GetType()))
      }
    }
    if ((incoming(cfg)?.size ?? 0) === 0) return new Error('removed all voters')
    return null
  }

  private makeVoter(cfg: Config, trk: ProgressMap, id: number): void {
    const pr = trk.get(id)
    if (!pr) {
      this.initProgress(cfg, trk, id, false)
      return
    }
    pr.IsLearner = false
    nilAwareDelete(cfg, 'Learners', id)
    nilAwareDelete(cfg, 'LearnersNext', id)
    incoming(cfg)!.add(id)
  }

  private makeLearner(cfg: Config, trk: ProgressMap, id: number): void {
    const pr = trk.get(id)
    if (!pr) {
      this.initProgress(cfg, trk, id, true)
      return
    }
    if (pr.IsLearner) return
    this.remove(cfg, trk, id)
    trk.set(id, pr)
    if (outgoing(cfg)?.has(id) ?? false) {
      nilAwareAdd(cfg, 'LearnersNext', id)
    } else {
      pr.IsLearner = true
      nilAwareAdd(cfg, 'Learners', id)
    }
  }

  private remove(cfg: Config, trk: ProgressMap, id: number): void {
    if (!trk.has(id)) return
    incoming(cfg)?.delete(id)
    nilAwareDelete(cfg, 'Learners', id)
    nilAwareDelete(cfg, 'LearnersNext', id)
    if (!(outgoing(cfg)?.has(id) ?? false)) trk.delete(id)
  }

  private initProgress(cfg: Config, trk: ProgressMap, id: number, isLearner: boolean): void {
    if (!isLearner) incoming(cfg)!.add(id)
    else nilAwareAdd(cfg, 'Learners', id)
    trk.set(id, new Progress({
      Match: 0,
      Next: Math.max(this.LastIndex, 1),
      Inflights: new Inflights(this.Tracker.MaxInflight, this.Tracker.MaxInflightBytes),
      IsLearner: isLearner,
      RecentActive: true,
    }))
  }
}

export function Describe(...ccs: ConfChangeSingle[]): string {
  return ccs.map(cc => sprintf('%s(%d)', ConfChangeTypeName[cc.GetType()], cc.GetNodeId())).join(' ')
}

// ---- restore.go ----

function toConfChangeSingle(cs: ConfState): [ConfChangeSingle[], ConfChangeSingle[]] {
  const out: ConfChangeSingle[] = []
  const inn: ConfChangeSingle[] = []
  for (const id of cs.VotersOutgoing) out.push(new CCS({ Type: ConfChangeAddNode, NodeId: id }))
  for (const id of cs.VotersOutgoing) inn.push(new CCS({ Type: ConfChangeRemoveNode, NodeId: id }))
  for (const id of cs.Voters) inn.push(new CCS({ Type: ConfChangeAddNode, NodeId: id }))
  for (const id of cs.Learners) inn.push(new CCS({ Type: ConfChangeAddLearnerNode, NodeId: id }))
  for (const id of cs.LearnersNext) inn.push(new CCS({ Type: ConfChangeAddLearnerNode, NodeId: id }))
  return [out, inn]
}

type Op = (chg: Changer) => Result

function chain(chg: Changer, ...ops: Op[]): Result {
  for (const op of ops) {
    const [cfg, trk, err] = op(chg)
    if (err) return [new Config({ Voters: [null, null] }), null, err]
    chg.Tracker.Config = cfg
    chg.Tracker.Progress = trk!
  }
  return [chg.Tracker.Config, chg.Tracker.Progress, null]
}

export function Restore(chgIn: Changer, cs: ConfState): Result {
  // Go passes the Changer by value.
  const chg = new Changer(chgIn.Tracker, chgIn.LastIndex)
  const [outgoingCCs, incomingCCs] = toConfChangeSingle(cs)
  const ops: Op[] = []
  if (outgoingCCs.length === 0) {
    for (const cc of incomingCCs) ops.push(c => c.Simple(cc))
  } else {
    for (const cc of outgoingCCs) ops.push(c => c.Simple(cc))
    ops.push(c => c.EnterJoint(cs.GetAutoLeave(), ...incomingCCs))
  }
  return chain(chg, ...ops)
}
