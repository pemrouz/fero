// E-46: a Maelstrom node (lin-kv workload) around E-10's TypeScript port of etcd raft.
//
// One process is one raft replica. Maelstrom speaks JSON lines on stdin/stdout.
// The raft log lives in etcd's MemoryStorage (in memory, no disk). The state
// machine is a key-value map with read, write and cas.
//
// Settings come from environment variables (Maelstrom starts every node with
// the JVM's environment):
//   E46_READ   readindex | log | mixed | buggy   (default readindex)
//              buggy = the planted bug: a follower answers reads from its own
//              state at once, with no ReadIndex; the leader still uses ReadIndex.
//   E46_SEED   seed for the election jitter (each node adds its own index)
//   E46_TICK   ms per raft tick (default 50); ElectionTick 10, HeartbeatTick 1
//   E46_COMPACT  0 = never compact (default); n = snapshot + compact the log
//              every n applied entries, keeping E46_KEEP (default 5) entries,
//              so lagging followers get the state machine by MsgSnap
//   E46_PIDDIR if set, the node writes <node_id>.pid there (for the pauser)
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  Config, RawNode, MemoryStorage, IsEmptyHardState, IsEmptySnap, StateLeader,
  discardLogger, globalRand, stateTypeString, SnapshotFinish, pb,
} from '../../E10-raft-port/port/src/index.ts'

const READ = (process.env.E46_READ ?? 'readindex') as 'readindex' | 'log' | 'mixed' | 'buggy'
const SEED = Number(process.env.E46_SEED ?? 1)
const TICK_MS = Number(process.env.E46_TICK ?? 50)
const COMPACT = Number(process.env.E46_COMPACT ?? 0)
const KEEP = Number(process.env.E46_KEEP ?? 5)
const PIDDIR = process.env.E46_PIDDIR

const t0 = Date.now()
const log = (s: string) => process.stderr.write(`${Date.now() - t0} ${s}\n`)
const send = (dest: string, body: any) => process.stdout.write(JSON.stringify({ src: nodeId, dest, body }) + '\n')

// ---------- seeded jitter (the port's only randomness) ----------
let rng = 0
function seedRng(s: number) { rng = (s * 2654435761) >>> 0 || 1 }
globalRand.Intn = (n: number) => {
  // xorshift32
  rng ^= rng << 13; rng >>>= 0
  rng ^= rng >>> 17
  rng ^= rng << 5; rng >>>= 0
  return rng % n
}

// ---------- the wire codec for raft messages (presence kept, bytes as base64) ----------
const b64 = (u: Uint8Array | undefined) => (u === undefined ? undefined : Buffer.from(u).toString('base64'))
const unb64 = (s: string | undefined) => (s === undefined ? undefined : new Uint8Array(Buffer.from(s, 'base64')))
function encEntry(e: pb.Entry): any {
  const o: any = {}
  if (e.Term !== undefined) o.T = e.Term
  if (e.Index !== undefined) o.I = e.Index
  if (e.Type !== undefined) o.Y = e.Type
  if (e.Data !== undefined) o.D = b64(e.Data)
  return o
}
const decEntry = (o: any) => new pb.Entry({ Term: o.T, Index: o.I, Type: o.Y, Data: unb64(o.D) })
function encCS(c: pb.ConfState | undefined): any {
  if (c === undefined) return undefined
  return { V: c.Voters, L: c.Learners, VO: c.VotersOutgoing, LN: c.LearnersNext, A: c.AutoLeave }
}
const decCS = (o: any) => (o === undefined ? undefined
  : new pb.ConfState({ Voters: o.V ?? [], Learners: o.L ?? [], VotersOutgoing: o.VO ?? [], LearnersNext: o.LN ?? [], AutoLeave: o.A }))
function encSnap(s: pb.Snapshot | undefined): any {
  if (s === undefined) return undefined
  const md = s.Metadata
  return { D: b64(s.Data), M: md === undefined ? undefined : { I: md.Index, T: md.Term, C: encCS(md.ConfState) } }
}
const decSnap = (o: any) => (o === undefined ? undefined : new pb.Snapshot({
  Data: unb64(o.D),
  Metadata: o.M === undefined ? undefined : new pb.SnapshotMetadata({ Index: o.M.I, Term: o.M.T, ConfState: decCS(o.M.C) }),
}))
function encMsg(m: pb.Message): any {
  if (m.Responses.length) throw new Error('E46: Responses on a wire message (async writes are off)')
  const o: any = {}
  for (const k of ['Type', 'To', 'From', 'Term', 'LogTerm', 'Index', 'Commit', 'Vote', 'Reject', 'RejectHint'] as const) {
    if (m[k] !== undefined) o[k] = m[k]
  }
  if (m.Entries.length) o.Entries = m.Entries.map(encEntry)
  if (m.Snapshot !== undefined) o.Snapshot = encSnap(m.Snapshot)
  if (m.Context !== undefined) o.Context = b64(m.Context)
  return o
}
function decMsg(o: any): pb.Message {
  return new pb.Message({
    Type: o.Type, To: o.To, From: o.From, Term: o.Term, LogTerm: o.LogTerm, Index: o.Index,
    Commit: o.Commit, Vote: o.Vote, Reject: o.Reject, RejectHint: o.RejectHint,
    Entries: (o.Entries ?? []).map(decEntry), Snapshot: decSnap(o.Snapshot), Context: unb64(o.Context),
  })
}

// ---------- node state ----------
let nodeId = ''
let nodeIds: string[] = []
let raftId = 0
let rn: RawNode | null = null
let storage: MemoryStorage | null = null
let confState: pb.ConfState | null = null
const kv = new Map<string, unknown>() // key: JSON of the Maelstrom key
let applied = 0
let lastSnapIndex = 1
let seq = 0
let msgId = 0
let hash = 2166136261 // FNV-1a over applied entry data, for the cross-node check
type Client = { src: string; msg_id: number; at: number }
const pendingOps = new Map<string, Client>()                      // entry id -> client (write, cas, log read)
const pendingReads = new Map<string, Client & { key: string }>()  // ReadIndex ctx -> client
let waitingApply: { index: number; c: Client; key: string }[] = []  // ReadState seen, waiting for apply
const stats = { prop: 0, propDropped: 0, ri: 0, riNoLeader: 0, riServed: 0, logReads: 0, localReads: 0, snapSent: 0, snapApplied: 0, compactions: 0 }
let lastRole = ''
let mixRng = SEED >>> 0

const idx = (id: string) => nodeIds.indexOf(id) + 1
const nameOf = (rid: number) => nodeIds[rid - 1]
const reply = (c: Client, body: any) => send(c.src, { ...body, in_reply_to: c.msg_id, msg_id: ++msgId })

function init(id: string, ids: string[]) {
  nodeId = id; nodeIds = ids; raftId = idx(id)
  seedRng(SEED * 1000 + raftId)
  storage = new MemoryStorage()
  confState = new pb.ConfState({ Voters: ids.map((_, i) => i + 1) })
  storage.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: confState }) }))
  rn = new RawNode(new Config({
    ID: raftId, ElectionTick: 10, HeartbeatTick: 1, Storage: storage, Applied: 1,
    MaxSizePerMsg: 1 << 16, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger,
  }))
  applied = 1
  if (PIDDIR) writeFileSync(`${PIDDIR}/${id}.pid`, String(process.pid))
  log(`INIT ${id} raft=${raftId} of ${ids.length} read=${READ} seed=${SEED} tick=${TICK_MS} compact=${COMPACT}`)
  setInterval(() => { rn!.Tick(); drain() }, TICK_MS)
  setInterval(housekeeping, 1000)
}

// ---------- the state machine ----------
type Op = { id: string; op: 'write' | 'cas' | 'read'; key: string; value?: unknown; from?: unknown; to?: unknown }
function applyOp(o: Op) {
  const c = pendingOps.get(o.id)
  if (c) pendingOps.delete(o.id)
  if (o.op === 'write') {
    kv.set(o.key, o.value)
    if (c) reply(c, { type: 'write_ok' })
  } else if (o.op === 'cas') {
    if (!kv.has(o.key)) { if (c) reply(c, { type: 'error', code: 20, text: 'key does not exist' }) }
    else if (JSON.stringify(kv.get(o.key)) !== JSON.stringify(o.from)) { if (c) reply(c, { type: 'error', code: 22, text: 'from does not match' }) }
    else { kv.set(o.key, o.to); if (c) reply(c, { type: 'cas_ok' }) }
  } else if (o.op === 'read') {
    if (c) answerRead(c, o.key)
  }
}
function answerRead(c: Client, key: string) {
  if (!kv.has(key)) reply(c, { type: 'error', code: 20, text: 'key does not exist' })
  else reply(c, { type: 'read_ok', value: kv.get(key) })
}
const fnv = (u: Uint8Array) => { for (const b of u) { hash ^= b; hash = Math.imul(hash, 16777619) >>> 0 } }
function snapData(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kv: [...kv], hash }))
}
function restore(s: pb.Snapshot) {
  const o = JSON.parse(new TextDecoder().decode(s.Data))
  kv.clear()
  for (const [k, v] of o.kv) kv.set(k, v)
  hash = o.hash
  applied = s.Metadata!.Index!
  lastSnapIndex = applied
  stats.snapApplied++
  log(`SNAP_APPLIED idx=${applied} term=${s.Metadata!.Term} keys=${kv.size} h=${hash.toString(16)}`)
}

// ---------- the host loop: persist, send, apply, advance ----------
function drain() {
  if (!rn) return
  while (rn.HasReady()) {
    const rd = rn.Ready()
    if (rd.SoftState) {
      const role = `${stateTypeString(rd.SoftState.RaftState)} lead=${rd.SoftState.Lead}`
      if (role !== lastRole) {
        lastRole = role
        log(`ROLE term=${rn.raft.Term} ${role}`)
        // For the pauser, which aims at the leader half of the time.
        if (PIDDIR) writeFileSync(`${PIDDIR}/${nodeId}.role`, `${stateTypeString(rd.SoftState.RaftState)} ${rn.raft.Term}`)
      }
    }
    // 1. persist (in memory; a real host fsyncs here before sending)
    if (!IsEmptyHardState(rd.HardState)) storage!.SetHardState(rd.HardState!)
    if (!IsEmptySnap(rd.Snapshot)) {
      storage!.ApplySnapshot(rd.Snapshot!)
      restore(rd.Snapshot!)
    }
    storage!.Append(rd.Entries)
    // 2. send
    for (const m of rd.Messages) {
      if (m.Type === pb.MsgSnap) {
        stats.snapSent++
        log(`SNAP_SENT to=${m.To} idx=${m.Snapshot?.Metadata?.Index}`)
        send(nameOf(m.To!), { type: 'raft', m: encMsg(m) })
        // The Maelstrom net gives no delivery report. Report it finished: if it was
        // lost, the follower rejects the next append and the leader sends it again.
        rn.ReportSnapshot(m.To!, SnapshotFinish)
      } else {
        send(nameOf(m.To!), { type: 'raft', m: encMsg(m) })
      }
    }
    // 3. apply
    for (const e of rd.CommittedEntries) {
      if (e.GetIndex() <= applied) throw new Error(`E46: re-apply of index ${e.GetIndex()} (applied ${applied})`)
      if (e.GetIndex() !== applied + 1) throw new Error(`E46: gap in apply: ${e.GetIndex()} after ${applied}`)
      applied = e.GetIndex()
      if (e.GetType() === pb.EntryNormal) {
        const d = e.GetData()
        if (d && d.length) { fnv(d); applyOp(JSON.parse(new TextDecoder().decode(d))) }
      } else {
        const cc = e.GetType() === pb.EntryConfChange ? pb.unmarshalConfChangeV1(e.GetData()) : pb.unmarshalConfChangeV2(e.GetData())
        confState = rn.ApplyConfChange(cc)
      }
      if (applied % 50 === 0) log(`APPLIED idx=${applied} term=${e.GetTerm()} h=${hash.toString(16)}`)
    }
    // ReadStates, after this Ready's entries are applied
    for (const rs of rd.ReadStates) {
      const ctx = new TextDecoder().decode(rs.RequestCtx)
      const p = pendingReads.get(ctx)
      if (!p) continue
      pendingReads.delete(ctx)
      waitingApply.push({ index: rs.Index, c: p, key: p.key })
    }
    if (waitingApply.length) {
      const rest: typeof waitingApply = []
      for (const w of waitingApply) {
        if (applied >= w.index) { stats.riServed++; answerRead(w.c, w.key) } else rest.push(w)
      }
      waitingApply = rest
    }
    // 4. advance
    rn.Advance(rd)
    // compaction (optional): snapshot the state machine at `applied`, keep KEEP entries
    if (COMPACT > 0 && applied - lastSnapIndex >= COMPACT) {
      const [, err] = storage!.CreateSnapshot(applied, confState, snapData())
      if (!err) {
        const ci = applied - KEEP
        if (ci > storage!.FirstIndex()[0]) storage!.Compact(ci)
        lastSnapIndex = applied
        stats.compactions++
      }
    }
  }
}

function housekeeping() {
  const now = Date.now()
  for (const [k, c] of pendingOps) if (now - c.at > 10_000) pendingOps.delete(k)
  for (const [k, c] of pendingReads) if (now - c.at > 10_000) pendingReads.delete(k)
  waitingApply = waitingApply.filter(w => now - w.c.at <= 10_000)
  if ((now - t0) % 5000 < 1000) log(`STATS applied=${applied} term=${rn?.raft.Term} ${JSON.stringify(stats)}`)
}

// ---------- client requests ----------
function propose(c: Client, o: Omit<Op, 'id'>) {
  const id = `${nodeId}/${++seq}`
  pendingOps.set(id, c)
  stats.prop++
  const err = rn!.Propose(new TextEncoder().encode(JSON.stringify({ id, ...o })))
  if (err) {
    // ErrProposalDropped: not appended and not forwarded, so a definite refusal.
    pendingOps.delete(id)
    stats.propDropped++
    reply(c, { type: 'error', code: 11, text: `proposal dropped: ${err.message}` })
  }
}

function onRead(c: Client, key: string) {
  let mode = READ
  if (mode === 'mixed') {
    mixRng = (Math.imul(mixRng, 1103515245) + 12345) >>> 0
    mode = ((mixRng >>> 16) & 1) === 0 ? 'readindex' : 'log'
  }
  if (mode === 'buggy') {
    if (rn!.raft.state !== StateLeader) { stats.localReads++; answerRead(c, key); return }   // THE PLANTED BUG
    mode = 'readindex'
  }
  if (mode === 'log') { stats.logReads++; propose(c, { op: 'read', key }); return }
  // ReadIndex
  if (rn!.raft.lead === 0) { stats.riNoLeader++; reply(c, { type: 'error', code: 11, text: 'no leader known' }); return }
  const ctx = `${nodeId}/r${++seq}`
  pendingReads.set(ctx, { ...c, key })
  stats.ri++
  rn!.ReadIndex(new TextEncoder().encode(ctx))
}

function onMessage(msg: any) {
  const b = msg.body
  if (b.type === 'init') {
    init(b.node_id, b.node_ids)
    send(msg.src, { type: 'init_ok', in_reply_to: b.msg_id, msg_id: ++msgId })
    return
  }
  if (!rn) return
  if (b.type === 'raft') {
    rn.Step(decMsg(b.m))
    return
  }
  const c: Client = { src: msg.src, msg_id: b.msg_id, at: Date.now() }
  const key = JSON.stringify(b.key)
  switch (b.type) {
    case 'read': onRead(c, key); break
    case 'write': propose(c, { op: 'write', key, value: b.value }); break
    case 'cas': propose(c, { op: 'cas', key, from: b.from, to: b.to }); break
    default: reply(c, { type: 'error', code: 10, text: `unsupported ${b.type}` })
  }
}

const rl = createInterface({ input: process.stdin })
let scheduled = false
rl.on('line', line => {
  if (!line.trim()) return
  onMessage(JSON.parse(line))
  if (!scheduled) { scheduled = true; setImmediate(() => { scheduled = false; drain() }) }
})
rl.on('close', () => process.exit(0))
