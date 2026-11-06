// Port of go.etcd.io/raft/v3/raftpb (raft.proto plus confchange.go, confstate.go,
// util.go, alias.go) at c51f010. Messages are proto2: a field is "present" when it
// is not undefined, exactly as the Go code's pointer fields; GetX() returns the zero
// value when absent. Only ConfChange and ConfChangeV2 are ever marshalled (they ride
// inside entries); Entry needs only its encoded size.

export const EntryType = { EntryNormal: 0, EntryConfChange: 1, EntryConfChangeV2: 2 } as const
export type EntryType = number
export const EntryTypeName = ['EntryNormal', 'EntryConfChange', 'EntryConfChangeV2']
export const EntryNormal = 0
export const EntryConfChange = 1
export const EntryConfChangeV2 = 2

export const MessageTypeName = [
  'MsgHup', 'MsgBeat', 'MsgProp', 'MsgApp', 'MsgAppResp', 'MsgVote', 'MsgVoteResp', 'MsgSnap',
  'MsgHeartbeat', 'MsgHeartbeatResp', 'MsgUnreachable', 'MsgSnapStatus', 'MsgCheckQuorum',
  'MsgTransferLeader', 'MsgTimeoutNow', 'MsgReadIndex', 'MsgReadIndexResp', 'MsgPreVote',
  'MsgPreVoteResp', 'MsgStorageAppend', 'MsgStorageAppendResp', 'MsgStorageApply',
  'MsgStorageApplyResp', 'MsgForgetLeader',
]
export type MessageType = number
export const MessageTypeValue: Record<string, number> = Object.fromEntries(MessageTypeName.map((n, i) => [n, i]))
export const MsgHup = 0
export const MsgBeat = 1
export const MsgProp = 2
export const MsgApp = 3
export const MsgAppResp = 4
export const MsgVote = 5
export const MsgVoteResp = 6
export const MsgSnap = 7
export const MsgHeartbeat = 8
export const MsgHeartbeatResp = 9
export const MsgUnreachable = 10
export const MsgSnapStatus = 11
export const MsgCheckQuorum = 12
export const MsgTransferLeader = 13
export const MsgTimeoutNow = 14
export const MsgReadIndex = 15
export const MsgReadIndexResp = 16
export const MsgPreVote = 17
export const MsgPreVoteResp = 18
export const MsgStorageAppend = 19
export const MsgStorageAppendResp = 20
export const MsgStorageApply = 21
export const MsgStorageApplyResp = 22
export const MsgForgetLeader = 23

export function msgTypeName(t: number): string {
  return MessageTypeName[t] ?? String(t)
}
export function entryTypeName(t: number): string {
  return EntryTypeName[t] ?? String(t)
}

export const ConfChangeTransitionName = ['ConfChangeTransitionAuto', 'ConfChangeTransitionJointImplicit', 'ConfChangeTransitionJointExplicit']
export const ConfChangeTransitionAuto = 0
export const ConfChangeTransitionJointImplicit = 1
export const ConfChangeTransitionJointExplicit = 2

export const ConfChangeTypeName = ['ConfChangeAddNode', 'ConfChangeRemoveNode', 'ConfChangeUpdateNode', 'ConfChangeAddLearnerNode']
export const ConfChangeAddNode = 0
export const ConfChangeRemoveNode = 1
export const ConfChangeUpdateNode = 2
export const ConfChangeAddLearnerNode = 3

export class Entry {
  Term?: number
  Index?: number
  Type?: number
  Data?: Uint8Array
  constructor(init?: { Term?: number; Index?: number; Type?: number; Data?: Uint8Array }) {
    if (init) Object.assign(this, init)
  }
  GetTerm(): number { return this.Term ?? 0 }
  GetIndex(): number { return this.Index ?? 0 }
  GetType(): number { return this.Type ?? 0 }
  GetData(): Uint8Array | undefined { return this.Data }
}

export class ConfState {
  Voters: number[] = []
  Learners: number[] = []
  VotersOutgoing: number[] = []
  LearnersNext: number[] = []
  AutoLeave?: boolean
  constructor(init?: Partial<ConfState>) {
    if (init) Object.assign(this, init)
  }
  GetAutoLeave(): boolean { return this.AutoLeave ?? false }
  // Equivalent returns null when the two are equal after sorting, else an error.
  Equivalent(cs2: ConfState | undefined): Error | null {
    if (!cs2) return new Error(`cannot compare ConfState: nil input (left=false, right=true)`)
    const norm = (c: ConfState) => [
      [...c.Voters].sort((a, b) => a - b), [...c.Learners].sort((a, b) => a - b),
      [...c.VotersOutgoing].sort((a, b) => a - b), [...c.LearnersNext].sort((a, b) => a - b), c.GetAutoLeave(),
    ]
    const a = JSON.stringify(norm(this))
    const b = JSON.stringify(norm(cs2))
    if (a !== b) return new Error(`ConfStates not equivalent after sorting:\n${a}\n${b}`)
    return null
  }
}

export class SnapshotMetadata {
  ConfState?: ConfState
  Index?: number
  Term?: number
  constructor(init?: Partial<SnapshotMetadata>) {
    if (init) Object.assign(this, init)
  }
  GetConfState(): ConfState | undefined { return this.ConfState }
  GetIndex(): number { return this.Index ?? 0 }
  GetTerm(): number { return this.Term ?? 0 }
}

export class Snapshot {
  Data?: Uint8Array
  Metadata?: SnapshotMetadata
  constructor(init?: Partial<Snapshot>) {
    if (init) Object.assign(this, init)
  }
  GetMetadata(): SnapshotMetadata | undefined { return this.Metadata }
  GetData(): Uint8Array | undefined { return this.Data }
}

// Getter helpers that, like Go's generated getters, accept a nil receiver.
export const metaOf = (s: Snapshot | undefined): SnapshotMetadata | undefined => s?.Metadata
export const snapIndex = (s: Snapshot | undefined): number => s?.Metadata?.Index ?? 0
export const snapTerm = (s: Snapshot | undefined): number => s?.Metadata?.Term ?? 0

export class HardState {
  Term?: number
  Vote?: number
  Commit?: number
  constructor(init?: Partial<HardState>) {
    if (init) Object.assign(this, init)
  }
  GetTerm(): number { return this.Term ?? 0 }
  GetVote(): number { return this.Vote ?? 0 }
  GetCommit(): number { return this.Commit ?? 0 }
}

export class Message {
  Type?: number
  To?: number
  From?: number
  Term?: number
  LogTerm?: number
  Index?: number
  Entries: Entry[] = []
  Commit?: number
  Vote?: number
  Snapshot?: Snapshot
  Reject?: boolean
  RejectHint?: number
  Context?: Uint8Array
  Responses: Message[] = []
  constructor(init?: Partial<Message>) {
    if (init) Object.assign(this, init)
    if (!this.Entries) this.Entries = []
    if (!this.Responses) this.Responses = []
  }
  GetType(): number { return this.Type ?? 0 }
  GetTo(): number { return this.To ?? 0 }
  GetFrom(): number { return this.From ?? 0 }
  GetTerm(): number { return this.Term ?? 0 }
  GetLogTerm(): number { return this.LogTerm ?? 0 }
  GetIndex(): number { return this.Index ?? 0 }
  GetEntries(): Entry[] { return this.Entries }
  GetCommit(): number { return this.Commit ?? 0 }
  GetVote(): number { return this.Vote ?? 0 }
  GetSnapshot(): Snapshot | undefined { return this.Snapshot }
  GetReject(): boolean { return this.Reject ?? false }
  GetRejectHint(): number { return this.RejectHint ?? 0 }
  GetContext(): Uint8Array | undefined { return this.Context }
  GetResponses(): Message[] { return this.Responses }
}

export class ConfChangeSingle {
  Type?: number
  NodeId?: number
  constructor(init?: Partial<ConfChangeSingle>) {
    if (init) Object.assign(this, init)
  }
  GetType(): number { return this.Type ?? 0 }
  GetNodeId(): number { return this.NodeId ?? 0 }
}

export interface ConfChangeI {
  AsV2(): ConfChangeV2
  AsV1(): [ConfChange | null, boolean]
}

export class ConfChange implements ConfChangeI {
  Type?: number
  NodeId?: number
  Context?: Uint8Array
  Id?: number
  constructor(init?: Partial<ConfChange>) {
    if (init) Object.assign(this, init)
  }
  GetType(): number { return this.Type ?? 0 }
  GetNodeId(): number { return this.NodeId ?? 0 }
  AsV2(): ConfChangeV2 {
    return new ConfChangeV2({
      Changes: [new ConfChangeSingle({ Type: this.GetType(), NodeId: this.GetNodeId() })],
      Context: this.Context,
    })
  }
  AsV1(): [ConfChange | null, boolean] { return [this, true] }
}

export class ConfChangeV2 implements ConfChangeI {
  Transition?: number
  Changes: ConfChangeSingle[] = []
  Context?: Uint8Array
  constructor(init?: Partial<ConfChangeV2>) {
    if (init) Object.assign(this, init)
    if (!this.Changes) this.Changes = []
  }
  GetTransition(): number { return this.Transition ?? 0 }
  GetChanges(): ConfChangeSingle[] { return this.Changes }
  AsV2(): ConfChangeV2 { return this }
  AsV1(): [ConfChange | null, boolean] { return [null, false] }
  // EnterJoint returns [autoLeave, ok].
  EnterJoint(): [boolean, boolean] {
    if (this.GetTransition() !== ConfChangeTransitionAuto || this.Changes.length > 1) {
      let autoLeave = false
      switch (this.GetTransition()) {
        case ConfChangeTransitionAuto:
          autoLeave = true
          break
        case ConfChangeTransitionJointImplicit:
          autoLeave = true
          break
        case ConfChangeTransitionJointExplicit:
          break
        default:
          throw new Error(`unknown transition: ${this.GetTransition()}`)
      }
      return [autoLeave, true]
    }
    return [false, false]
  }
  LeaveJoint(): boolean {
    return this.GetTransition() === ConfChangeTransitionAuto && this.Changes.length === 0
  }
}

// ---- protobuf wire helpers (only what the core needs) ----

export function sov(x: number): number {
  let n = 1
  while (x >= 128) {
    x = Math.floor(x / 128)
    n++
  }
  return n
}

function putVarint(out: number[], x: number): void {
  while (x >= 128) {
    out.push((x % 128) | 0x80)
    x = Math.floor(x / 128)
  }
  out.push(x)
}

function readVarint(b: Uint8Array, pos: { i: number }): number {
  let x = 0
  let mul = 1
  for (;;) {
    if (pos.i >= b.length) throw new Error('unexpected EOF')
    const c = b[pos.i++]
    x += (c & 0x7f) * mul
    if (c < 0x80) return x
    mul *= 128
  }
}

// proto.Size of an Entry with proto2 presence (fields 1 type, 2 term, 3 index, 4 data).
export function entrySize(e: Entry): number {
  let n = 0
  if (e.Type !== undefined) n += 1 + sov(e.Type)
  if (e.Term !== undefined) n += 1 + sov(e.Term)
  if (e.Index !== undefined) n += 1 + sov(e.Index)
  if (e.Data !== undefined) n += 1 + sov(e.Data.length) + e.Data.length
  return n
}

export function marshalConfChangeV1(c: ConfChange): Uint8Array {
  const out: number[] = []
  if (c.Id !== undefined) { out.push(0x08); putVarint(out, c.Id) }
  if (c.Type !== undefined) { out.push(0x10); putVarint(out, c.Type) }
  if (c.NodeId !== undefined) { out.push(0x18); putVarint(out, c.NodeId) }
  if (c.Context !== undefined) { out.push(0x22); putVarint(out, c.Context.length); out.push(...c.Context) }
  return Uint8Array.from(out)
}

export function marshalConfChangeV2(c: ConfChangeV2): Uint8Array {
  const out: number[] = []
  if (c.Transition !== undefined) { out.push(0x08); putVarint(out, c.Transition) }
  for (const ch of c.Changes) {
    const inner: number[] = []
    if (ch.Type !== undefined) { inner.push(0x08); putVarint(inner, ch.Type) }
    if (ch.NodeId !== undefined) { inner.push(0x10); putVarint(inner, ch.NodeId) }
    out.push(0x12)
    putVarint(out, inner.length)
    out.push(...inner)
  }
  if (c.Context !== undefined) { out.push(0x1a); putVarint(out, c.Context.length); out.push(...c.Context) }
  return Uint8Array.from(out)
}

function readBytes(b: Uint8Array, pos: { i: number }): Uint8Array {
  const n = readVarint(b, pos)
  const v = b.slice(pos.i, pos.i + n)
  pos.i += n
  return v
}

export function unmarshalConfChangeV1(b: Uint8Array | undefined): ConfChange {
  const c = new ConfChange()
  if (!b) return c
  const pos = { i: 0 }
  while (pos.i < b.length) {
    const tag = readVarint(b, pos)
    switch (tag) {
      case 0x08: c.Id = readVarint(b, pos); break
      case 0x10: c.Type = readVarint(b, pos); break
      case 0x18: c.NodeId = readVarint(b, pos); break
      case 0x22: c.Context = readBytes(b, pos); break
      default: throw new Error(`proto: unknown tag ${tag}`)
    }
  }
  return c
}

export function unmarshalConfChangeV2(b: Uint8Array | undefined): ConfChangeV2 {
  const c = new ConfChangeV2()
  if (!b) return c
  const pos = { i: 0 }
  while (pos.i < b.length) {
    const tag = readVarint(b, pos)
    switch (tag) {
      case 0x08: c.Transition = readVarint(b, pos); break
      case 0x12: {
        const inner = readBytes(b, pos)
        const ch = new ConfChangeSingle()
        const p2 = { i: 0 }
        while (p2.i < inner.length) {
          const t2 = readVarint(inner, p2)
          if (t2 === 0x08) ch.Type = readVarint(inner, p2)
          else if (t2 === 0x10) ch.NodeId = readVarint(inner, p2)
          else throw new Error(`proto: unknown tag ${t2}`)
        }
        c.Changes.push(ch)
        break
      }
      case 0x1a: c.Context = readBytes(b, pos); break
      default: throw new Error(`proto: unknown tag ${tag}`)
    }
  }
  return c
}

// MarshalConfChange returns [type, data].
export function MarshalConfChange(c: ConfChangeI | null): [number, Uint8Array | undefined] {
  if (c === null) return [EntryConfChangeV2, undefined]
  const [ccv1, ok] = c.AsV1()
  if (ok && ccv1) return [EntryConfChange, marshalConfChangeV1(ccv1)]
  return [EntryConfChangeV2, marshalConfChangeV2(c.AsV2())]
}

export function ConfChangesFromString(s: string): [ConfChangeSingle[], Error | null] {
  const ccs: ConfChangeSingle[] = []
  let toks: string[] = s.trim().split(' ')
  if (toks[0] === '') toks = []
  for (const tok of toks) {
    if (tok.length < 2) return [[], new Error(`unknown token ${tok}`)]
    const cc = new ConfChangeSingle()
    switch (tok[0]) {
      case 'v': cc.Type = ConfChangeAddNode; break
      case 'l': cc.Type = ConfChangeAddLearnerNode; break
      case 'r': cc.Type = ConfChangeRemoveNode; break
      case 'u': cc.Type = ConfChangeUpdateNode; break
      default: return [[], new Error(`unknown input: ${tok}`)]
    }
    if (!/^\d+$/.test(tok.slice(1))) return [[], new Error(`strconv.ParseUint: parsing "${tok.slice(1)}": invalid syntax`)]
    cc.NodeId = Number(tok.slice(1))
    ccs.push(cc)
  }
  return [ccs, null]
}

export function ConfChangesToString(ccs: ConfChangeSingle[]): string {
  let buf = ''
  ccs.forEach((cc, i) => {
    if (i > 0) buf += ' '
    switch (cc.GetType()) {
      case ConfChangeAddNode: buf += 'v'; break
      case ConfChangeAddLearnerNode: buf += 'l'; break
      case ConfChangeRemoveNode: buf += 'r'; break
      case ConfChangeUpdateNode: buf += 'u'; break
      default: buf += 'unknown'
    }
    buf += String(cc.GetNodeId())
  })
  return buf
}

// ---- Ensure* and cloning (proto.Clone) ----

export function EnsureConfState(cs: ConfState | undefined): ConfState {
  if (!cs) cs = new ConfState()
  if (cs.AutoLeave === undefined) cs.AutoLeave = false
  return cs
}

export function EnsureSnapshotMetadata(m: SnapshotMetadata | undefined): SnapshotMetadata {
  if (!m) m = new SnapshotMetadata()
  const cs = EnsureConfState(m.ConfState)
  if (!m.ConfState) m.ConfState = cs
  if (m.Index === undefined) m.Index = 0
  if (m.Term === undefined) m.Term = 0
  return m
}

export function EnsureSnapshot(s: Snapshot | undefined): Snapshot {
  if (!s) s = new Snapshot()
  const md = EnsureSnapshotMetadata(s.Metadata)
  if (!s.Metadata) s.Metadata = md
  return s
}

export function cloneConfState(cs: ConfState): ConfState {
  return new ConfState({
    Voters: [...cs.Voters], Learners: [...cs.Learners], VotersOutgoing: [...cs.VotersOutgoing],
    LearnersNext: [...cs.LearnersNext], AutoLeave: cs.AutoLeave,
  })
}

export function cloneSnapshot(s: Snapshot): Snapshot {
  const out = new Snapshot()
  if (s.Data !== undefined) out.Data = s.Data.slice()
  if (s.Metadata) {
    out.Metadata = new SnapshotMetadata({ Index: s.Metadata.Index, Term: s.Metadata.Term })
    if (s.Metadata.ConfState) out.Metadata.ConfState = cloneConfState(s.Metadata.ConfState)
  }
  return out
}

export function cloneEntry(e: Entry): Entry {
  return new Entry({ Term: e.Term, Index: e.Index, Type: e.Type, Data: e.Data })
}

function bytesEq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  const x = a ?? new Uint8Array(0)
  const y = b ?? new Uint8Array(0)
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

// proto.Equal for snapshots, as used by the interaction harness.
export function snapshotEqual(a: Snapshot, b: Snapshot): boolean {
  if (!bytesEq(a.Data, b.Data)) return false
  const ma = a.Metadata
  const mb = b.Metadata
  if (!ma || !mb) return !ma && !mb
  if (ma.Index !== mb.Index || ma.Term !== mb.Term) return false
  const ca = ma.ConfState
  const cb = mb.ConfState
  if (!ca || !cb) return !ca && !cb
  const eq = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i])
  return eq(ca.Voters, cb.Voters) && eq(ca.Learners, cb.Learners) && eq(ca.VotersOutgoing, cb.VotersOutgoing) &&
    eq(ca.LearnersNext, cb.LearnersNext) && ca.AutoLeave === cb.AutoLeave
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
