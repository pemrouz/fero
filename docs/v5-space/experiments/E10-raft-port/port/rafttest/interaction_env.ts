// Port of go.etcd.io/raft/v3/rafttest's InteractionEnv (interaction_env*.go) at
// c51f010: the harness that runs etcd's testdata/*.txt files. One TS file for the
// 21 Go files; each handler keeps its Go name.
import { sprintf, sprintln, sprint, MaxUint64 } from '../src/gofmt.ts'
import {
  type Message, Message as Msg, HardState, type Snapshot, type Entry, ConfChange, ConfChangeV2,
  MsgStorageAppend, MsgStorageApply, MsgSnap, MessageTypeValue, EntryConfChange, EntryConfChangeV2,
  ConfChangeTransitionAuto, ConfChangeTransitionJointImplicit, ConfChangeTransitionJointExplicit,
  EnsureSnapshot, cloneSnapshot, snapshotEqual, unmarshalConfChangeV1, unmarshalConfChangeV2,
  ConfChangesFromString, type ConfChangeI, type ConfState, utf8,
} from '../src/raftpb.ts'
import { Config, ReadOnlySafe, ReadOnlyLeaseBased, setRandomizedElectionTimeout, stateTypeString } from '../src/raft.ts'
import { RawNode } from '../src/rawnode.ts'
import { MemoryStorage, type Storage } from '../src/storage.ts'
import { IsEmptyHardState, IsEmptySnap } from '../src/node.ts'
import { DescribeMessage, DescribeReady, DescribeEntries, IsLocalMsgTarget } from '../src/util.ts'
import { type Logger, RaftPanic } from '../src/logger.ts'
import { progressMapString } from '../src/tracker.ts'
import { jointIDs } from '../src/quorum.ts'
import { type TestData, type CmdArg, scanInt, scanBool } from './datadriven.ts'
import { goQuote } from '../src/gofmt.ts'

// ---- interaction_env_logger.go ----

const lvlNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'NONE']

export class RedirectLogger implements Logger {
  Builder = { s: '' }
  Lvl = 0
  private printf(lvl: number, format: string, ...args: unknown[]): void {
    if (this.Lvl <= lvl) {
      this.WriteString(lvlNames[lvl] + ' ')
      this.WriteString(sprintf(format, ...args))
      if (format.length > 0 && format[format.length - 1] !== '\n') this.WriteString('\n')
    }
  }
  private print(lvl: number, ...args: unknown[]): void {
    if (this.Lvl <= lvl) {
      this.WriteString(lvlNames[lvl] + ' ')
      this.WriteString(sprintln(...args))
    }
  }
  Debug(...v: unknown[]): void { this.print(0, ...v) }
  Debugf(f: string, ...v: unknown[]): void { this.printf(0, f, ...v) }
  Info(...v: unknown[]): void { this.print(1, ...v) }
  Infof(f: string, ...v: unknown[]): void { this.printf(1, f, ...v) }
  Warning(...v: unknown[]): void { this.print(2, ...v) }
  Warningf(f: string, ...v: unknown[]): void { this.printf(2, f, ...v) }
  Error(...v: unknown[]): void { this.print(3, ...v) }
  Errorf(f: string, ...v: unknown[]): void { this.printf(3, f, ...v) }
  Fatal(...v: unknown[]): never { this.print(4, ...v); throw new RaftPanic(sprint(...v)) }
  Fatalf(f: string, ...v: unknown[]): never { this.printf(4, f, ...v); throw new RaftPanic(sprintf(f, ...v)) }
  Panic(...v: unknown[]): never { this.print(4, ...v); throw new RaftPanic(sprint(...v)) }
  Panicf(f: string, ...v: unknown[]): never { this.printf(4, f, ...v); throw new RaftPanic(sprintf(f, ...v)) }
  Quiet(): boolean { return this.Lvl === lvlNames.length - 1 }
  WriteString(s: string): void { if (!this.Quiet()) this.Builder.s += s }
  Reset(): void { this.Builder.s = '' }
  Len(): number { return this.Builder.s.length }
  String(): string { return this.Builder.s }
}

// ---- interaction_env.go ----

class SnapOverrideStorage implements Storage {
  inner: MemoryStorage
  snapshotOverride: (() => [Snapshot | null, Error | null]) | null
  constructor(inner: MemoryStorage, o: () => [Snapshot | null, Error | null]) {
    this.inner = inner
    this.snapshotOverride = o
  }
  InitialState() { return this.inner.InitialState() }
  Entries(lo: number, hi: number, maxSize: number) { return this.inner.Entries(lo, hi, maxSize) }
  Term(i: number) { return this.inner.Term(i) }
  LastIndex() { return this.inner.LastIndex() }
  FirstIndex() { return this.inner.FirstIndex() }
  Snapshot(): [Snapshot | null, Error | null] {
    if (this.snapshotOverride) return this.snapshotOverride()
    return this.inner.Snapshot()
  }
  SetHardState(st: HardState) { return this.inner.SetHardState(st) }
  ApplySnapshot(s: Snapshot) { return this.inner.ApplySnapshot(s) }
  Compact(i: number) { return this.inner.Compact(i) }
  Append(ents: Entry[]) { return this.inner.Append(ents) }
}

export class Node {
  RawNode: RawNode
  Storage: SnapOverrideStorage
  Config: Config
  AppendWork: Message[] = []
  ApplyWork: Message[] = []
  History: Snapshot[]
  constructor(rn: RawNode, s: SnapOverrideStorage, cfg: Config, history: Snapshot[]) {
    this.RawNode = rn
    this.Storage = s
    this.Config = cfg
    this.History = history
  }
}

export type InteractionOpts = {
  OnConfig?: (c: Config) => void
  SetRandomizedElectionTimeout?: (node: RawNode, timeout: number) => void
}

function raftConfigStub(): Config {
  return new Config({ ElectionTick: 3, HeartbeatTick: 1, MaxSizePerMsg: MaxUint64, MaxInflightMsgs: 2147483647 })
}

const defaultEntryFormatter = (b: Uint8Array | undefined): string => goQuote(b ?? null)

type Recipient = { ID: number; Drop: boolean }

export class InteractionEnv {
  Options: InteractionOpts
  Nodes: Node[] = []
  Messages: Message[] = []
  Output = new RedirectLogger()

  constructor(opts?: InteractionOpts) {
    this.Options = opts ?? {}
  }

  withIndent(f: () => void): void {
    const orig = this.Output.Builder
    this.Output.Builder = { s: '' }
    try {
      f()
    } finally {
      const text = this.Output.Builder.s
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      for (const l of lines) orig.s += '  ' + l.replace(/\r$/, '') + '\n'
      this.Output.Builder = orig
    }
  }

  // ---- interaction_env_handler.go ----
  Handle(d: TestData): string {
    this.Output.Reset()
    let err: Error | null = null
    switch (d.Cmd) {
      case '_breakpoint': break
      case 'add-nodes': err = this.handleAddNodes(d); break
      case 'campaign': err = this.Nodes[firstAsNodeIdx(d)].RawNode.Campaign(); break
      case 'compact': err = this.handleCompact(d); break
      case 'deliver-msgs': err = this.handleDeliverMsgs(d); break
      case 'process-ready': err = this.handleProcessReady(d); break
      case 'process-append-thread': err = this.handleProcessAppendThread(d); break
      case 'process-apply-thread': err = this.handleProcessApplyThread(d); break
      case 'log-level': err = this.LogLevel(d.CmdArgs[0].Key); break
      case 'raft-log': err = this.RaftLog(firstAsNodeIdx(d)); break
      case 'raft-state': err = this.handleRaftState(); break
      case 'set-randomized-election-timeout': err = this.handleSetRandomizedElectionTimeout(d); break
      case 'stabilize': err = this.handleStabilize(d); break
      case 'status': err = this.Status(firstAsNodeIdx(d)); break
      case 'tick-election': { const idx = firstAsNodeIdx(d); err = this.Tick(idx, this.Nodes[idx].Config.ElectionTick); break }
      case 'tick-heartbeat': { const idx = firstAsNodeIdx(d); err = this.Tick(idx, this.Nodes[idx].Config.HeartbeatTick); break }
      case 'transfer-leadership': err = this.handleTransferLeadership(d); break
      case 'forget-leader': this.Nodes[firstAsNodeIdx(d)].RawNode.ForgetLeader(); break
      case 'send-snapshot': this.handleSendSnapshot(d); break
      case 'propose': err = this.handlePropose(d); break
      case 'propose-conf-change': err = this.handleProposeConfChange(d); break
      case 'report-unreachable': err = this.handleReportUnreachable(d); break
      default: err = new Error('unknown command')
    }
    if (err) {
      if (this.Output.Quiet()) return err.message
      this.Output.WriteString(err.message)
    }
    if (this.Output.Len() === 0) return 'ok'
    return this.Output.String()
  }

  // ---- interaction_env_handler_add_nodes.go ----
  handleAddNodes(d: TestData): Error | null {
    const n = firstAsInt(d)
    const snap = EnsureSnapshot(undefined)
    const cfg = raftConfigStub()
    for (const arg of d.CmdArgs.slice(1)) {
      for (let i = 0; i < arg.Vals.length; i++) {
        switch (arg.Key) {
          case 'voters': snap.Metadata!.ConfState!.Voters.push(scanInt(arg, i)); break
          case 'learners': snap.Metadata!.ConfState!.Learners.push(scanInt(arg, i)); break
          case 'inflight': cfg.MaxInflightMsgs = scanInt(arg, i); break
          case 'index': {
            snap.Metadata!.Index = scanInt(arg, i)
            cfg.Applied = snap.Metadata!.GetIndex()
            break
          }
          case 'content': snap.Data = utf8(arg.Vals[i]); break
          case 'async-storage-writes': cfg.AsyncStorageWrites = scanBool(arg, i); break
          case 'prevote': cfg.PreVote = scanBool(arg, i); break
          case 'checkquorum': cfg.CheckQuorum = scanBool(arg, i); break
          case 'max-committed-size-per-ready': cfg.MaxCommittedSizePerReady = scanInt(arg, i); break
          case 'disable-conf-change-validation': cfg.DisableConfChangeValidation = scanBool(arg, i); break
          case 'read-only':
            switch (arg.Vals[i]) {
              case 'safe': cfg.ReadOnlyOption = ReadOnlySafe; break
              case 'lease-based': cfg.ReadOnlyOption = ReadOnlyLeaseBased; break
              default: return new Error(sprintf('invalid read-only option %q', arg.Vals[i]))
            }
            break
          case 'step-down-on-removal': cfg.StepDownOnRemoval = scanBool(arg, i); break
        }
      }
    }
    return this.AddNodes(n, cfg, snap)
  }

  AddNodes(n: number, cfgIn: Config, snap: Snapshot): Error | null {
    const emptySnapshot = EnsureSnapshot(undefined)
    snap = EnsureSnapshot(snap)
    const bootstrap = !snapshotEqual(snap, emptySnapshot)
    for (let i = 0; i < n; i++) {
      const id = 1 + this.Nodes.length
      const s = new SnapOverrideStorage(new MemoryStorage(), () => {
        const snaps = this.Nodes[id - 1].History
        return [snaps[snaps.length - 1], null]
      })
      if (bootstrap) {
        if (snap.Metadata!.GetIndex() <= 1) return new Error('index must be specified as > 1 due to bootstrap')
        snap.Metadata!.Term = 1
        const err = s.ApplySnapshot(snap)
        if (err) return err
        const [fi, e2] = s.FirstIndex()
        if (e2) return e2
        const exp = snap.Metadata!.GetIndex() + 1
        if (fi !== exp) return new Error(sprintf('failed to establish first index %d; got %d', exp, fi))
      }
      const cfg = cfgIn.clone()
      cfg.ID = id
      cfg.Storage = s
      if (this.Options.OnConfig) {
        this.Options.OnConfig(cfg)
        if (cfg.ID !== id) return new Error('OnConfig must not change the ID')
      }
      if (cfg.Logger) return new Error('OnConfig must not set Logger')
      cfg.Logger = this.Output
      const rn = new RawNode(cfg)
      this.Nodes.push(new Node(rn, s, cfg, [snap]))
    }
    return null
  }

  // ---- interaction_env_handler_compact.go ----
  handleCompact(d: TestData): Error | null {
    const idx = firstAsNodeIdx(d)
    const key = d.CmdArgs[1].Key
    if (!/^\d+$/.test(key)) return new Error(`strconv.ParseUint: parsing "${key}": invalid syntax`)
    const err = this.Nodes[idx].Storage.Compact(Number(key))
    if (err) return err
    return this.RaftLog(idx)
  }

  // ---- interaction_env_handler_deliver_msgs.go ----
  handleDeliverMsgs(d: TestData): Error | null {
    let typ = -1
    const rs: Recipient[] = []
    for (const arg of d.CmdArgs) {
      if (arg.Vals.length === 0) rs.push({ ID: parseUintOrThrow(arg.Key), Drop: false })
      for (let i = 0; i < arg.Vals.length; i++) {
        switch (arg.Key) {
          case 'drop': {
            const id = scanInt(arg, i)
            if (rs.some(r => r.ID === id)) throw new Error(`can't both deliver and drop msgs to ${id}`)
            rs.push({ ID: id, Drop: true })
            break
          }
          case 'type': {
            const s = arg.Vals[i]
            const v = MessageTypeValue[s]
            if (v === undefined) throw new Error(`unknown message type ${s}`)
            typ = v
            break
          }
        }
      }
    }
    if (this.DeliverMsgs(typ, ...rs) === 0) this.Output.WriteString('no messages\n')
    return null
  }

  DeliverMsgs(typ: number, ...rs: Recipient[]): number {
    let n = 0
    for (const r of rs) {
      const [msgs, rest] = splitMsgs(this.Messages, r.ID, typ, r.Drop)
      this.Messages = rest
      n += msgs.length
      for (const msg of msgs) {
        if (r.Drop) this.Output.WriteString('dropped: ')
        this.Output.WriteString(DescribeMessage(msg, defaultEntryFormatter) + '\n')
        if (r.Drop) continue
        const toIdx = msg.GetTo() - 1
        const err = this.Nodes[toIdx].RawNode.Step(msg)
        if (err) this.Output.WriteString(err.message + '\n')
      }
    }
    return n
  }

  // ---- interaction_env_handler_log_level.go ----
  LogLevel(name: string): Error | null {
    for (let i = 0; i < lvlNames.length; i++) {
      if (lvlNames[i].toLowerCase() === name.toLowerCase()) {
        this.Output.Lvl = i
        return null
      }
    }
    return new Error(sprintf('log levels must be either of %v', lvlNames))
  }

  // ---- interaction_env_handler_process_ready.go ----
  handleProcessReady(d: TestData): Error | null {
    const idxs = nodeIdxs(d)
    for (const idx of idxs) {
      let err: Error | null = null
      if (idxs.length > 1) {
        this.Output.WriteString(sprintf('> %d handling Ready\n', idx + 1))
        this.withIndent(() => { err = this.ProcessReady(idx) })
      } else {
        err = this.ProcessReady(idx)
      }
      if (err) return err
    }
    return null
  }

  ProcessReady(idx: number): Error | null {
    const n = this.Nodes[idx]
    const rd = n.RawNode.Ready()
    this.Output.WriteString(DescribeReady(rd, defaultEntryFormatter))
    if (!n.Config.AsyncStorageWrites) {
      let err = processAppend(n, rd.HardState, rd.Entries, rd.Snapshot)
      if (err) return err
      err = processApply(n, rd.CommittedEntries)
      if (err) return err
    }
    for (const m of rd.Messages) {
      if (IsLocalMsgTarget(m.GetTo())) {
        if (!n.Config.AsyncStorageWrites) throw new Error('unexpected local msg target')
        switch (m.GetType()) {
          case MsgStorageAppend: n.AppendWork.push(m); break
          case MsgStorageApply: n.ApplyWork.push(m); break
          default: throw new Error(`unexpected message type ${m.GetType()}`)
        }
      } else {
        this.Messages.push(m)
      }
    }
    if (!n.Config.AsyncStorageWrites) n.RawNode.Advance(rd)
    return null
  }

  // ---- interaction_env_handler_process_append_thread.go ----
  handleProcessAppendThread(d: TestData): Error | null {
    const idxs = nodeIdxs(d)
    for (const idx of idxs) {
      let err: Error | null = null
      if (idxs.length > 1) {
        this.Output.WriteString(sprintf('> %d processing append thread\n', idx + 1))
        this.withIndent(() => { err = this.ProcessAppendThread(idx) })
      } else {
        err = this.ProcessAppendThread(idx)
      }
      if (err) return err
    }
    return null
  }

  ProcessAppendThread(idx: number): Error | null {
    const n = this.Nodes[idx]
    if (n.AppendWork.length === 0) {
      this.Output.WriteString('no append work to perform')
      return null
    }
    const m = n.AppendWork.shift()!
    const resps = m.GetResponses()
    m.Responses = []
    this.Output.WriteString('Processing:\n')
    this.Output.WriteString(DescribeMessage(m, defaultEntryFormatter) + '\n')
    const st = new HardState({ Term: m.GetTerm(), Vote: m.GetVote(), Commit: m.GetCommit() })
    const snap = m.GetSnapshot()
    let cloned: Snapshot | undefined
    if (snap) cloned = cloneSnapshot(snap)
    cloned = EnsureSnapshot(cloned)
    const err = processAppend(n, st, m.GetEntries(), cloned)
    if (err) return err
    this.Output.WriteString('Responses:\n')
    for (const r of resps) this.Output.WriteString(DescribeMessage(r, defaultEntryFormatter) + '\n')
    this.Messages.push(...resps)
    return null
  }

  // ---- interaction_env_handler_process_apply_thread.go ----
  handleProcessApplyThread(d: TestData): Error | null {
    const idxs = nodeIdxs(d)
    for (const idx of idxs) {
      let err: Error | null = null
      if (idxs.length > 1) {
        this.Output.WriteString(sprintf('> %d processing apply thread\n', idx + 1))
        this.withIndent(() => { err = this.ProcessApplyThread(idx) })
      } else {
        err = this.ProcessApplyThread(idx)
      }
      if (err) return err
    }
    return null
  }

  ProcessApplyThread(idx: number): Error | null {
    const n = this.Nodes[idx]
    if (n.ApplyWork.length === 0) {
      this.Output.WriteString('no apply work to perform')
      return null
    }
    const m = n.ApplyWork.shift()!
    const resps = m.GetResponses()
    m.Responses = []
    this.Output.WriteString('Processing:\n')
    this.Output.WriteString(DescribeMessage(m, defaultEntryFormatter) + '\n')
    const err = processApply(n, m.GetEntries())
    if (err) return err
    this.Output.WriteString('Responses:\n')
    for (const r of resps) this.Output.WriteString(DescribeMessage(r, defaultEntryFormatter) + '\n')
    this.Messages.push(...resps)
    return null
  }

  // ---- interaction_env_handler_propose.go ----
  handlePropose(d: TestData): Error | null {
    const idx = firstAsNodeIdx(d)
    if (d.CmdArgs.length !== 2 || d.CmdArgs[1].Vals.length > 0) throw new Error('expected exactly one key with no vals')
    return this.Nodes[idx].RawNode.Propose(utf8(d.CmdArgs[1].Key))
  }

  // ---- interaction_env_handler_propose_conf_change.go ----
  handleProposeConfChange(d: TestData): Error | null {
    const idx = firstAsNodeIdx(d)
    let v1 = false
    let transition = ConfChangeTransitionAuto
    for (const arg of d.CmdArgs.slice(1)) {
      for (const val of arg.Vals) {
        switch (arg.Key) {
          case 'v1':
            v1 = scanBool({ Key: 'v1', Vals: [val] }, 0)
            break
          case 'transition':
            switch (val) {
              case 'auto': transition = ConfChangeTransitionAuto; break
              case 'implicit': transition = ConfChangeTransitionJointImplicit; break
              case 'explicit': transition = ConfChangeTransitionJointExplicit; break
              default: return new Error(`unknown transition ${val}`)
            }
            break
          default:
            return new Error(`unknown command ${arg.Key}`)
        }
      }
    }
    const [ccs, err] = ConfChangesFromString(d.Input)
    if (err) return err
    let c: ConfChangeI
    if (v1) {
      if (ccs.length > 1 || transition !== ConfChangeTransitionAuto) {
        return new Error('v1 conf change can only have one operation and no transition')
      }
      c = new ConfChange({ Type: ccs[0].GetType(), NodeId: ccs[0].GetNodeId() })
    } else {
      c = new ConfChangeV2({ Transition: transition, Changes: ccs })
    }
    return this.Nodes[idx].RawNode.ProposeConfChange(c)
  }

  // ---- interaction_env_handler_raft_log.go ----
  RaftLog(idx: number): Error | null {
    const s = this.Nodes[idx].Storage
    const [fi, e1] = s.FirstIndex()
    if (e1) return e1
    const [li, e2] = s.LastIndex()
    if (e2) return e2
    if (li < fi) {
      this.Output.WriteString(sprintf('log is empty: first index=%d, last index=%d', fi, li))
      return null
    }
    const [ents, e3] = s.Entries(fi, li + 1, MaxUint64)
    if (e3) return e3
    this.Output.WriteString(DescribeEntries(ents, defaultEntryFormatter))
    return null
  }

  // ---- interaction_env_handler_raftstate.go ----
  handleRaftState(): Error | null {
    for (const n of this.Nodes) {
      const st = n.RawNode.Status()
      const voterStatus = jointIDs(st.Config.Voters).has(st.ID) ? '(Voter)' : '(Non-Voter)'
      this.Output.WriteString(sprintf('%d: %s %s Term:%d Lead:%d\n', st.ID, stateTypeString(st.RaftState), voterStatus, st.GetTerm(), st.Lead))
    }
    return null
  }

  // ---- interaction_env_handler_report_unreachable.go ----
  handleReportUnreachable(d: TestData): Error | null {
    const sl = nodeIdxs(d)
    if (sl.length !== 2) return new Error('must specify exactly two node indexes: node on which to report, and reported node')
    this.Nodes[sl[0]].RawNode.ReportUnreachable(this.Nodes[sl[1]].Config.ID)
    return null
  }

  // ---- interaction_env_handler_send_snapshot.go ----
  handleSendSnapshot(d: TestData): Error | null {
    const idxs = nodeIdxs(d)
    if (idxs.length !== 2) throw new Error('send-snapshot needs two nodes')
    return this.SendSnapshot(idxs[0], idxs[1])
  }

  SendSnapshot(fromIdx: number, toIdx: number): Error | null {
    const [snap, err] = this.Nodes[fromIdx].Storage.Snapshot()
    if (err) return err
    const from = fromIdx + 1
    const to = toIdx + 1
    const fromStatus = this.Nodes[fromIdx].RawNode.BasicStatus()
    const msg = new Msg({ Type: MsgSnap, Term: fromStatus.GetTerm(), From: from, To: to, Snapshot: snap! })
    this.Messages.push(msg)
    this.Output.WriteString(DescribeMessage(msg, null))
    return null
  }

  // ---- interaction_env_handler_set_randomized_election_timeout.go ----
  handleSetRandomizedElectionTimeout(d: TestData): Error | null {
    const idx = firstAsNodeIdx(d)
    const timeout = d.ScanArgInt('timeout')
    if (timeout === 0) throw new Error('timeout must not be zero')
    const set = this.Options.SetRandomizedElectionTimeout ?? ((rn: RawNode, v: number) => setRandomizedElectionTimeout(rn.raft, v))
    set(this.Nodes[idx].RawNode, timeout)
    return null
  }

  // ---- interaction_env_handler_stabilize.go ----
  handleStabilize(d: TestData): Error | null {
    const idxs = nodeIdxs(d)
    let restore: number | null = null
    try {
      for (const arg of d.CmdArgs) {
        for (let i = 0; i < arg.Vals.length; i++) {
          if (arg.Key === 'log-level') {
            if (restore === null) restore = this.Output.Lvl
            const err = this.LogLevel(arg.Vals[i])
            if (err) return err
          }
        }
      }
      return this.Stabilize(...idxs)
    } finally {
      if (restore !== null) this.Output.Lvl = restore
    }
  }

  Stabilize(...idxs: number[]): Error | null {
    const nodes: Node[] = idxs.length !== 0 ? idxs.map(i => this.Nodes[i]) : [...this.Nodes]
    for (;;) {
      let done = true
      for (const rn of nodes) {
        if (rn.RawNode.HasReady()) {
          const idx = rn.RawNode.Status().ID - 1
          this.Output.WriteString(sprintf('> %d handling Ready\n', idx + 1))
          let err: Error | null = null
          this.withIndent(() => { err = this.ProcessReady(idx) })
          if (err) return err
          done = false
        }
      }
      for (const rn of nodes) {
        const id = rn.RawNode.Status().ID
        const [msgs] = splitMsgs(this.Messages, id, -1, false)
        if (msgs.length > 0) {
          this.Output.WriteString(sprintf('> %d receiving messages\n', id))
          this.withIndent(() => { this.DeliverMsgs(-1, { ID: id, Drop: false }) })
          done = false
        }
      }
      for (const rn of nodes) {
        const idx = rn.RawNode.Status().ID - 1
        if (rn.AppendWork.length > 0) {
          this.Output.WriteString(sprintf('> %d processing append thread\n', idx + 1))
          while (rn.AppendWork.length > 0) {
            let err: Error | null = null
            this.withIndent(() => { err = this.ProcessAppendThread(idx) })
            if (err) return err
          }
          done = false
        }
      }
      for (const rn of nodes) {
        const idx = rn.RawNode.Status().ID - 1
        if (rn.ApplyWork.length > 0) {
          this.Output.WriteString(sprintf('> %d processing apply thread\n', idx + 1))
          while (rn.ApplyWork.length > 0) this.withIndent(() => { this.ProcessApplyThread(idx) })
          done = false
        }
      }
      if (done) return null
    }
  }

  // ---- interaction_env_handler_status.go ----
  Status(idx: number): Error | null {
    const st = this.Nodes[idx].RawNode.Status()
    this.Output.WriteString(progressMapString(st.Progress))
    return null
  }

  // ---- interaction_env_handler_tick.go ----
  Tick(idx: number, num: number): Error | null {
    for (let i = 0; i < num; i++) this.Nodes[idx].RawNode.Tick()
    return null
  }

  // ---- interaction_env_handler_transfer_leadership.go ----
  handleTransferLeadership(d: TestData): Error | null {
    const from = d.ScanArgInt('from')
    const to = d.ScanArgInt('to')
    if (from === 0 || from > this.Nodes.length) throw new Error('expected valid "from" argument')
    if (to === 0 || to > this.Nodes.length) throw new Error('expected valid "to" argument')
    this.Nodes[from - 1].RawNode.TransferLeader(to)
    return null
  }
}

function processAppend(n: Node, st: HardState | null, ents: Entry[], snap: Snapshot | null | undefined): Error | null {
  const s = n.Storage
  if (!IsEmptyHardState(st)) {
    const err = s.SetHardState(st!)
    if (err) return err
  }
  if (!IsEmptySnap(snap)) {
    if (ents.length > 0) return new Error("can't apply snapshot and entries at the same time")
    return s.ApplySnapshot(snap!)
  }
  return s.Append(ents)
}

function processApply(n: Node, ents: Entry[]): Error | null {
  for (const ent of ents) {
    let update: Uint8Array | undefined
    let cs: ConfState | null = null
    switch (ent.GetType()) {
      case EntryConfChange: {
        const cc = unmarshalConfChangeV1(ent.GetData())
        update = cc.Context
        cs = n.RawNode.ApplyConfChange(cc)
        break
      }
      case EntryConfChangeV2: {
        const cc = unmarshalConfChangeV2(ent.GetData())
        cs = n.RawNode.ApplyConfChange(cc)
        update = cc.Context
        break
      }
      default:
        update = ent.GetData()
    }
    const lastSnap = n.History[n.History.length - 1]
    const snap = EnsureSnapshot(undefined)
    const data = [...(lastSnap.Data ?? []), ...(update ?? [])]
    if (lastSnap.Data !== undefined || update !== undefined) snap.Data = Uint8Array.from(data)
    snap.Metadata!.Index = ent.GetIndex()
    snap.Metadata!.Term = ent.GetTerm()
    if (!cs) cs = n.History[n.History.length - 1].Metadata?.ConfState ?? null
    snap.Metadata!.ConfState = cs ?? undefined
    n.History.push(snap)
  }
  return null
}

function splitMsgs(msgs: Message[], to: number, typ: number, drop: boolean): [Message[], Message[]] {
  const toMsgs: Message[] = []
  const rmdr: Message[] = []
  for (const msg of msgs) {
    if (msg.GetTo() === to && !(drop && isLocalMsg(msg)) && (typ < 0 || msg.GetType() === typ)) toMsgs.push(msg)
    else rmdr.push(msg)
  }
  return [toMsgs, rmdr]
}

function isLocalMsg(msg: Message): boolean {
  return msg.GetFrom() === msg.GetTo() || IsLocalMsgTarget(msg.GetFrom()) || IsLocalMsgTarget(msg.GetTo())
}

function parseUintOrThrow(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`strconv.ParseUint: parsing "${s}": invalid syntax`)
  return Number(s)
}

function firstAsInt(d: TestData): number {
  const k = d.CmdArgs[0].Key
  if (!/^-?\d+$/.test(k)) throw new Error(`strconv.Atoi: parsing "${k}": invalid syntax`)
  return Number(k)
}

function firstAsNodeIdx(d: TestData): number {
  return firstAsInt(d) - 1
}

function nodeIdxs(d: TestData): number[] {
  const ints: number[] = []
  for (const a of d.CmdArgs as CmdArg[]) {
    if (a.Vals.length !== 0) continue
    if (!/^-?\d+$/.test(a.Key)) throw new Error(`strconv.Atoi: parsing "${a.Key}": invalid syntax`)
    ints.push(Number(a.Key) - 1)
  }
  return ints
}

export { Msg as MessageCtor }
