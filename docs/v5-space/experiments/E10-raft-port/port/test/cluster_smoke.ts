// A worked example and a smoke test of the RawNode API: G groups of 3 replicas in
// one process, one shared tick, messages handed between replicas in memory.
// Each group elects a leader, takes N proposals, and every replica must apply the
// same entries in the same order. Usage: node test/cluster_smoke.ts [groups] [proposals]
import { Config, RawNode, MemoryStorage, IsEmptyHardState, IsEmptySnap, StateLeader, discardLogger, globalRand, pb } from '../src/index.ts'

const G = Number(process.argv[2] ?? 4)
const N = Number(process.argv[3] ?? 2000)
let seed = 7
globalRand.Intn = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }

type Replica = { id: number; rn: RawNode; storage: MemoryStorage; applied: string[] }
type Group = { replicas: Replica[]; inbox: pb.Message[] }

function newGroup(): Group {
  const replicas: Replica[] = []
  for (const id of [1, 2, 3]) {
    const storage = new MemoryStorage()
    // Start every replica from the same snapshot that names the voters (as etcd's harness does).
    storage.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: new pb.ConfState({ Voters: [1, 2, 3] }) }) }))
    const cfg = new Config({ ID: id, ElectionTick: 10, HeartbeatTick: 1, Storage: storage, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, Applied: 1, Logger: discardLogger, PreVote: true, CheckQuorum: true })
    replicas.push({ id, rn: new RawNode(cfg), storage, applied: [] })
  }
  return { replicas, inbox: [] }
}

// handleReady is the whole host loop for one replica: persist, send, apply, advance.
function handleReady(g: Group, r: Replica): boolean {
  if (!r.rn.HasReady()) return false
  const rd = r.rn.Ready()
  if (!IsEmptyHardState(rd.HardState)) r.storage.SetHardState(rd.HardState!)
  if (!IsEmptySnap(rd.Snapshot)) r.storage.ApplySnapshot(rd.Snapshot!)
  r.storage.Append(rd.Entries)              // (a real host fsyncs here, before sending)
  for (const m of rd.Messages) g.inbox.push(m)
  for (const e of rd.CommittedEntries) {
    if (e.GetType() === pb.EntryNormal && e.GetData()?.length) r.applied.push(new TextDecoder().decode(e.GetData()))
    else if (e.GetType() !== pb.EntryNormal) {
      const cc = e.GetType() === pb.EntryConfChange ? pb.unmarshalConfChangeV1(e.GetData()) : pb.unmarshalConfChangeV2(e.GetData())
      r.rn.ApplyConfChange(cc)
    }
  }
  r.rn.Advance(rd)
  return true
}

function deliver(g: Group): boolean {
  if (g.inbox.length === 0) return false
  const msgs = g.inbox
  g.inbox = []
  for (const m of msgs) g.replicas[m.GetTo() - 1].rn.Step(m)
  return true
}

const groups = Array.from({ length: G }, newGroup)
const t0 = performance.now()
const leaderOf = (g: Group) => g.replicas.find(r => r.rn.raft.state === StateLeader)
// Tick until every group has a leader.
for (let t = 0; t < 1000 && groups.some(g => !leaderOf(g)); t++) {
  for (const g of groups) {
    for (const r of g.replicas) r.rn.Tick()
    let busy = true
    while (busy) {
      busy = false
      for (const r of g.replicas) busy = handleReady(g, r) || busy
      busy = deliver(g) || busy
    }
  }
}
if (groups.some(g => !leaderOf(g))) throw new Error('a group elected no leader')
const tElect = performance.now()
for (let i = 0; i < N; i++) {
  for (const g of groups) leaderOf(g)!.rn.Propose(new TextEncoder().encode(`v${i}`))
  if (i % 64 === 63 || i === N - 1) {
    for (const g of groups) {
      let busy = true
      while (busy) {
        busy = false
        for (const r of g.replicas) busy = handleReady(g, r) || busy
        busy = deliver(g) || busy
      }
    }
  }
}
// A few heartbeats so followers learn the final commit index.
for (let t = 0; t < 3; t++) for (const g of groups) {
  for (const r of g.replicas) r.rn.Tick()
  let busy = true
  while (busy) {
    busy = false
    for (const r of g.replicas) busy = handleReady(g, r) || busy
    busy = deliver(g) || busy
  }
}
const tDone = performance.now()
for (const [gi, g] of groups.entries()) {
  const ref = g.replicas[0].applied.join(',')
  for (const r of g.replicas) {
    if (r.applied.length !== N) throw new Error(`group ${gi} replica ${r.id} applied ${r.applied.length} of ${N}`)
    if (r.applied.join(',') !== ref) throw new Error(`group ${gi} replica ${r.id} diverged`)
  }
}
console.log(`ok: ${G} groups x 3 replicas elected in ${(tElect - t0).toFixed(0)} ms; ${N} proposals each applied identically on every replica in ${(tDone - tElect).toFixed(0)} ms (not a benchmark: no disk, no network, shared machine)`)
