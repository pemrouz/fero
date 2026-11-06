# Using the TypeScript port of etcd raft

This folder is a line-by-line TypeScript port of etcd's raft library at commit `c51f010` (2026-10-23). It runs on plain Node 22 with type stripping: no build step, no dependencies. E-10's README says how faithful it is and how it was checked.

It is the same design as etcd's raft: a pure state machine. It does no I/O and keeps no timers. Your code (the **host**) owns the clock, the disk and the network. You feed it ticks and messages, and you read back a **Ready**: the batch of things to persist, send and apply.

## Import

```ts
import { Config, RawNode, MemoryStorage, IsEmptyHardState, IsEmptySnap, StateLeader, discardLogger, globalRand, pb } from './port/src/index.ts'
```

`pb` holds the message types (`pb.Message`, `pb.Entry`, `pb.HardState`, `pb.Snapshot`, `pb.ConfState`, `pb.ConfChange`, `pb.ConfChangeV2`) and the constants (`pb.MsgApp`, `pb.EntryNormal`, ...). Fields are optional, as in proto2: read them with the getters (`m.GetTerm()`, `e.GetData()`), which return 0 or empty when a field is absent.

## Create one group (one replica of it)

Every replica of a group has its own `RawNode` and its own `Storage`. Start all replicas of a new group from the same snapshot that names the voters (this is how etcd's own test harness starts a group):

```ts
const storage = new MemoryStorage()
storage.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({
  Index: 1, Term: 1, ConfState: new pb.ConfState({ Voters: [1, 2, 3] }) }) }))
const rn = new RawNode(new Config({
  ID: 1,                    // this replica's id within the group, never 0
  ElectionTick: 10,         // ticks without a leader before an election
  HeartbeatTick: 1,         // leader heartbeat, in ticks
  Storage: storage,
  Applied: 1,               // the snapshot's index
  MaxSizePerMsg: 1 << 20,   // bytes of entries per append message
  MaxInflightMsgs: 256,     // append messages in flight per follower
  PreVote: true, CheckQuorum: true,
  Logger: discardLogger,    // or your own Logger; the default prints to stderr
}))
```

`RawNode.Bootstrap(peers)` also works, as in etcd. For many groups, make one `RawNode` per replica per group; nothing is shared between them. Group ids are your business: route a message to a group by your own envelope (`{ group, msg }`), and inside the group by `msg.GetTo()`.

## Drive it

```ts
rn.Tick()                          // call on every tick of your clock (one timer for all groups)
rn.Step(msg)                       // a message that arrived from a peer of this group
rn.Propose(bytes)                  // on the leader; a follower forwards it to the leader
rn.ProposeConfChange(new pb.ConfChangeV2({ Changes: [new pb.ConfChangeSingle({ Type: pb.ConfChangeAddNode, NodeId: 4 })] }))
rn.Campaign()                      // start an election now
rn.TransferLeader(2)               // ask the leader to hand over to replica 2
rn.ReadIndex(ctx)                  // a linearizable read; the answer comes back in Ready.ReadStates
```

`Step`, `Propose` and the others return an `Error` or `null` (Go's error values; `ErrProposalDropped` when there is no leader).

## Handle a Ready

After ticks and steps, ask whether there is work, then do it in this order:

```ts
if (rn.HasReady()) {
  const rd = rn.Ready()
  // 1. Persist. Fsync before step 2 if you want etcd's guarantees.
  if (!IsEmptyHardState(rd.HardState)) storage.SetHardState(rd.HardState!)
  if (!IsEmptySnap(rd.Snapshot)) storage.ApplySnapshot(rd.Snapshot!)
  storage.Append(rd.Entries)
  // 2. Send. Each message names its peer in msg.GetTo().
  for (const m of rd.Messages) send(m)
  // 3. Apply committed entries to your state machine.
  for (const e of rd.CommittedEntries) {
    if (e.GetType() === pb.EntryNormal) apply(e.GetData())
    else rn.ApplyConfChange(e.GetType() === pb.EntryConfChange
      ? pb.unmarshalConfChangeV1(e.GetData()) : pb.unmarshalConfChangeV2(e.GetData()))
  }
  // 4. Tell raft you are done.
  rn.Advance(rd)
}
```

Persist the `ConfState` that `ApplyConfChange` returns together with your applied index, and give both back on restart (in a snapshot, or through your `Storage.InitialState`). E-10's restart fuzz shows why: a node restarted from its log and HardState alone comes back in its old configuration and later panics on a leave-joint entry (`can't leave a non-joint config`). etcd's Go code does exactly the same; it is the host's job.

`rd.SoftState` (leader and role) is set when they changed. `rn.raft.state === StateLeader` and `rn.Status()` give the role and progress at any time.

With `AsyncStorageWrites: true` in the config, persistence and apply happen off the Ready path: `rd.Messages` then also carries `MsgStorageAppend` / `MsgStorageApply` work items addressed to `LocalAppendThread` / `LocalApplyThread`; do the work, then `Step` their `Responses` back in, and do not call `Advance`. `rafttest/interaction_env.ts` (`ProcessAppendThread`, `ProcessApplyThread`) is a working example.

## Determinism

The election jitter is the only randomness. etcd uses `crypto/rand`; the port reads `globalRand.Intn`, which a simulator can replace with a seeded generator:

```ts
globalRand.Intn = n => myRng.int(n)
```

Nothing else reads a clock or a random source, so a seeded host replays exactly.

## A worked example

`test/cluster_smoke.ts` runs G groups of three replicas in one process with one shared tick, elects a leader in each, proposes N entries per group and checks that every replica applied the same entries in the same order:

```sh
node test/cluster_smoke.ts 4 2000
```

## Checks

```sh
node test/run_datadriven.ts <etcd raft checkout>   # etcd's 41 datadriven files, unchanged
node test/cluster_smoke.ts                          # the multi-group example above
../diff/run_diff.sh 1000 7 readindex,restart        # 1,000 random scripts against etcd's Go code
```

Run a change to the port through all three. The datadriven files catch about three quarters of behaviour-changing one-line mistakes, and the fuzz brings that to about nine in ten (E-10's mutation runs).

## What is not here

- `node.go`'s goroutine `Node` (channels around `RawNode`). A host drives `RawNode` directly.
- `state_trace.go` (the TLA+ trace-validation hooks, a build-tagged feature in Go).
- `rafttest`'s goroutine `network.go` and `node.go`, used only by Go's own unit tests.
- Go's unit tests (`*_test.go`, about 8,800 code lines). The port is checked by the datadriven files and by a differential fuzz against the Go code instead (see E-10's README).
- A real `Storage`. `MemoryStorage` is the in-memory one from etcd; a durable one implements the same six-method `Storage` interface.

## Differences from Go you might hit

- Numbers are JS numbers. Ids, terms and indexes must stay below 2^53 − 2. `LocalAppendThread` and `LocalApplyThread` are `Number.MAX_SAFE_INTEGER` and that minus 1, not Go's `MaxUint64` values. "No limit" sizes are `Infinity`.
- Go returns `(value, error)`; the port returns `[value, Error | null]`. Go panics become thrown `RaftPanic` errors.
- Arrays handed out (`Ready.Entries`, `Ready.Messages`) are copies. Go hands out slices that share memory.
