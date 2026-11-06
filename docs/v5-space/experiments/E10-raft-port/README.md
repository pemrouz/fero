# E-10: how big etcd's raft is, a faithful TypeScript port, raft-rs's gaps, and npm's Raft libraries

**Question (Q-10).** How big is etcd's raft, how hard is a faithful TypeScript port, and is raft-rs (or a JS library) a better start?

**Decides** (QUESTIONS.md): axis I (`port`, `own`, `raft-rs`, `jslib`); decision 22; DEV-04, DEV-05; MIN against RUST.

**Threshold** (QUESTIONS.md): the slice passes ≥ 90% of its applicable datadriven files and projects to ≤ 80 agent-hours for the whole port → `port` is confirmed (MIN). Below that, or a Go-only construct that blocks a faithful port → RUST with raft-rs moves up, unless raft-rs has a blocking gap. A JS library counts only with a test oracle as strong as the datadriven files.

## The result, first

- **The whole library was ported, not just the slice, and it passes all 41 of etcd's datadriven files byte for byte** (28 interaction files, 4 quorum files, 9 confchange files; 743 directives), run unchanged from etcd's checkout. Measured here: [results/ts-datadriven.txt](results/ts-datadriven.txt). The same files pass on etcd's own Go code on this box: [results/etcd-upstream-go-datadriven.txt](results/etcd-upstream-go-datadriven.txt).
- **It also matches the Go code on 4,000 random scripts**, 280,502 directives, byte for byte. Each script is filled in by etcd's own Go raft and harness, then replayed on the port. 2,000 of them add linearizable reads, and 1,000 of those add crash-restarts, two things no datadriven file does. Measured here: [results/diff-fuzz-run1.txt](results/diff-fuzz-run1.txt), [run2](results/diff-fuzz-run2-readindex.txt), [run3](results/diff-fuzz-run3-readindex-restart.txt).
- **It was fast.** From the first line of Go source read to 41 of 41 green took 16 minutes of this agent's wall time: about 5,700 Go code lines in, about 4,500 TypeScript code lines out. The whole port, with Go's 8,800 lines of unit tests, projects to a few agent-hours. That is far under the 80-hour bar, even with a tenfold margin.
- **Nothing in Go blocked a faithful port.** Seven Go habits needed care (64-bit integers, shared slices, struct copies, proto2 presence, crypto randomness, `fmt`, panics). Each has a small, stated fix, listed below.
- **A mutation run measured the oracle itself.** Of 1,147 mechanical one-rule changes to the port, etcd's 41 files catch 663 and the fuzz 129 more: 792 in all. About 250 of the 355 survivors cannot change behaviour at all (equivalent). So the files alone catch about 74% of the changes that matter, and files plus fuzz about 89% (estimated from a hand-classified sample). What escapes is mostly features the files never switch on (uncommitted-size and byte limits, `Bootstrap`, `CreateSnapshot`) plus a few dozen real gaps. Go's unit tests, not yet ported, are what cover those. Measured here: [results/mutation-run.txt](results/mutation-run.txt) and the files below.
- **raft-rs 0.7.0** (the latest release, 2023-03-06) is 7,350 code lines with its inline tests. It builds on this box (cited: [TOOLS.md](../TOOLS.md), the toolsmith's hello run). Its own test suite could not be run here: the session's safety check refused it. raft-rs has drifted from etcd. It has no interaction test harness, so it runs **0 of etcd's 28 interaction files**. Of etcd's 13 package-level files it carries 12 copies, and only 4 would pass unchanged (reasoned from a file diff). It lacks async storage writes in etcd's form, ForgetLeader, StepDownOnRemoval, in-flight commit tracking, MaxInflightBytes, and etcd's 2024–2026 fixes. None of these blocks using it, but a raft-rs stack cannot use etcd's oracle.
- **npm has no Raft library with an oracle like etcd's.** Of 573 packages in four registry searches, 32 Raft implementations were examined. None runs etcd's tests. The most downloaded real one (`node-raft-redis`, 1,314 downloads a week) has no test script and no dependents. The rest have at most a few hundred downloads a week, or one release.

**Verdict:** `port` is confirmed, and by a wide margin. RUST does not gain on this question: its core would be raft-rs, which is behind etcd and cannot be checked by etcd's files. `jslib` is out.

## Words used here

- **etcd raft** is the Raft library inside etcd, now its own repository (`go.etcd.io/raft/v3`). It is a pure state machine: no I/O, no timers. The host feeds it ticks and messages and reads back a **Ready** (what to save, send and apply).
- **Datadriven files** are etcd's text tests: a script of commands (`campaign 1`, `stabilize`, `deliver-msgs 2`) and, under each, the exact text output expected, log lines included. The **interaction** files drive whole clusters through `rafttest`'s `InteractionEnv`.
- **Byte for byte** means the port's output text equals the expected text exactly.
- **raft-rs** is TiKV's Rust port of etcd raft. **openraft** is a separate Rust design (not examined here; SPACE §2 axis I covers it).
- An **agent-hour** here is an hour of this agent's wall-clock time.
- A **mutant** is a copy of the code with one rule changed. A test suite **catches** it when some test fails on it. An **equivalent** mutant cannot change behaviour, so no test can catch it.
- **Code lines** are lines that are neither blank nor comments.

## Method

### (a) The port

1. Read etcd raft at commit `c51f010` (2026-10-23) in `$SP/dl/raftsrc/raft`, file by file, and wrote one TypeScript file per Go file, keeping Go's names, order and control flow. Everything outside `node.go`'s goroutines and the build-tagged trace hooks was ported: the core package, `quorum`, `tracker`, `confchange`, the hand-written parts of `raftpb`, `rafttest`'s `InteractionEnv` (all 21 handler files) and the `cockroachdb/datadriven` file reader.
2. Ran etcd's 41 datadriven files, unchanged, through the port ([port/test/run_datadriven.ts](port/test/run_datadriven.ts)). As in Go, the first mismatch in a file ends that file.
3. A negative control: three expected outputs were corrupted in a copy. The runner failed exactly those three files, at the corrupted lines ([results/negative-control.txt](results/negative-control.txt)).
4. **Differential fuzz** ([diff/](diff)): [gen_scripts.ts](diff/gen_scripts.ts) writes random scripts in the datadriven format, with 3 to 5 nodes and random options (prevote, checkquorum, async storage writes, inflight limits, step-down on removal, lease reads, a 1-byte apply budget). Each script has 30 to 90 random steps: proposals, conf changes (v1, v2, joint auto, implicit, explicit, leave-joint), deliveries, drops, ticks, campaigns, transfers, forget-leader, unreachable reports, status and log dumps. [zz_e10_diff_test.go](diff/zz_e10_diff_test.go) runs each script on etcd's own Go `InteractionEnv` and writes the real outputs. The port then replays them ([run_ts.ts](diff/run_ts.ts)). One patch makes both sides deterministic: the election jitter (Go's `crypto/rand`) returns 0 on both sides. A script where Go panics is cut before that step, and the port must throw at the same step. Two commands etcd's harness lacks were added on both sides, after the first mutation run showed the gaps: `read-index` (a linearizable read; no datadriven file has one) and `restart` (a crash: the node is rebuilt from its storage, and work queued for its append and apply threads is lost; no datadriven file restarts a node).
5. **Mutation run** ([diff/mutate.ts](diff/mutate.ts)): every one-rule change of the port's nine core files, made mechanically as DEV-10 (d) says, adapted to code: flip each `<`, `<=`, `>`, `>=`; drop each `if` conjunct (a single condition becomes `true`); delete each single-line state update; swap each pair of adjacent updates; and, reported apart, flip each `===` / `!==`. Run 1: each mutant runs the 41 files, and if it survives, the 1,000 fuzz scripts of seed 2. Run 2: run 1's survivors against the 1,000 read-index scripts (seed 5). Run 3: run 2's survivors against the 1,000 read-index and restart scripts (seed 7). Swap survivors are split by a script ([classify_swaps.py](diff/classify_swaps.py)) into independent pairs (equivalent) and the rest; 40 of the other survivors, drawn at random, were classified by hand ([results/mutation-sample-classification.md](results/mutation-sample-classification.md)).
6. A worked multi-group example ([port/test/cluster_smoke.ts](port/test/cluster_smoke.ts)): 4 groups of 3 replicas, one shared tick, 2,000 proposals each, every replica applies the same entries ([results/cluster-smoke.txt](results/cluster-smoke.txt)). It is the starting point for E-11, with [port/USAGE.md](port/USAGE.md).
7. Timed the work by the clock: a marker at the start (10:56:12 UTC), and the first all-green run (11:12:12 UTC).

### (b) raft-rs

1. Fetched raft 0.7.0 from crates.io (crate sha256 `f12688b2…5bae`) and its git history (bare clone, read only).
2. Counted its lines, diffed its datadriven files against etcd's, and read its source for each etcd feature and fix (grep plus reading the relevant functions).
3. Tried `cargo test` on it. The first try compiled about 100 crates and failed on the `time` 0.3.20 crate that its `Cargo.lock` pins, which no longer compiles on Rust 1.97 ([results/raft-rs-build-attempt1.txt](results/raft-rs-build-attempt1.txt)). After `cargo update -p time`, the retry was refused by the session's safety check ("Code from External"). So raft-rs's own tests did not run here. The toolsmith's separate build of raft-rs 0.7.0 (one node elects itself and commits an entry) is cited from [TOOLS.md](../TOOLS.md).

### (c) npm

Registry metadata only: four searches (`raft`, `raft consensus`, `keywords:raft`, `keywords:consensus`; 573 unique packages), then the packument (the registry's metadata document, including the readme) of each of 32 packages that implement or wrap Raft. No tarball was downloaded or run. [npm/survey.py](npm/survey.py) tabulates them ([results/npm-survey.md](results/npm-survey.md), [results/npm-survey.json](results/npm-survey.json)).

## Results

### How big etcd's raft is (measured here, [results/line-counts.txt](results/line-counts.txt))

Code lines are lines that are not blank and not comments.

| Part (etcd raft c51f010) | Physical lines | Code lines | Ported |
|---|---:|---:|---|
| core package (`raft`), non-test | 6,147 | 3,386 | all but `node.go`'s goroutine `Node` (~300 code lines), `state_trace.go` (278) and `doc.go` |
| `quorum` | 357 | 211 | all |
| `tracker` | 788 | 410 | all |
| `confchange` | 574 | 334 | all |
| `raftpb`, hand-written + `.proto` | 351 + 205 | 217 + 103 | all; the 977 generated lines are replaced by plain classes |
| `rafttest` (`InteractionEnv`, 21 files) | 1,781 | 1,100 | all (its goroutine `network.go` and `node.go`, 241 lines, are not) |
| test drivers + datadriven reader | about 800 | about 500 | the parts the 41 files use |
| Go unit tests | 11,971 | 8,838 | none |

**In scope of the port:** about 4,060 Go code lines of library and about 1,600 of harness, so about 5,700. **Written:** 3,300 TypeScript code lines of library ([port/src](port/src), 16 files, including a 156-line subset of Go's `fmt` that Go gets for free) and about 1,200 of harness ([port/rafttest](port/rafttest), [port/test](port/test)). The diff and mutation tools add about 450.

### The port against etcd's oracle

| Suite | Files | Pass byte for byte | Directives |
|---|---:|---:|---:|
| interaction (`testdata/*.txt`) | 28 | 28 | 558 |
| quorum | 4 | 4 | 127 |
| confchange | 9 | 9 | 58 |
| **all** | **41** | **41 (100%)** | **743 of 743** |

Every file applies: async storage writes, prevote, checkquorum, lease reads, joint consensus, leader transfer, forget-leader, snapshots and compaction are all in the port. The whole suite runs in about 0.3 s.

**Differential fuzz** (measured here):

| Run | Seed | Scripts | Extra commands | Match byte for byte | Directives | Go panics, port threw at the same step |
|---|---|---:|---|---:|---:|---|
| [run1](results/diff-fuzz-run1.txt) | 2, 3 | 2,000 | — | 2,000 | 140,346 | 0 |
| [run2](results/diff-fuzz-run2-readindex.txt) | 5 | 1,000 | `read-index` (579 scripts produced ReadStates) | 1,000 | 70,083 | 0 |
| [run3](results/diff-fuzz-run3-readindex-restart.txt) | 7 | 1,000 | `read-index` (2,393), `restart` (1,730) | 1,000 | 70,073 | 2 of 2 |
| **all** | | **4,000** | | **4,000** | **280,502** | **2 of 2** |

Smaller trial runs (seeds 1, 4 and 6: 20, 30 and 40 scripts) also matched. The two panics in run 3 are the same on both sides: `can't leave a non-joint config`. The fuzz's `restart` rebuilds a node from its log and HardState but not from its last applied configuration (MemoryStorage only keeps a ConfState inside a snapshot), so a later leave-joint entry finds the node in the old config. That is etcd's contract, not a bug: **a host must persist the applied ConfState with its applied index**, and fero's storage layer has to (reasoned).

**Mutation run** (measured here, [results/mutation-run.txt](results/mutation-run.txt)):

| Operator | Mutants | Caught by the 41 files | + fuzz (seed 2) | + read-index fuzz | + restart fuzz | Survived |
|---|---:|---:|---:|---:|---:|---:|
| rel (`<` ↔ `<=`, `>` ↔ `>=`) | 123 | 63 | 5 | 1 | 3 | 51 |
| guard (drop an `if` conjunct) | 420 | 302 | 35 | 13 | 3 | 67 |
| drop (delete an update) | 283 | 153 | 24 | 9 | 4 | 93 |
| swap (two adjacent updates) | 131 | 2 | 1 | 1 | 0 | 127 |
| eq (`===` ↔ `!==`, extra) | 190 | 143 | 14 | 16 | 0 | 17 |
| **all** | **1,147** | **663 (57.8%)** | **79** | **40** | **10** | **355** |

How to read the survivors:
- **Swaps:** 122 of the 127 surviving swaps exchange two updates where neither line reads the other's target, so they cannot change anything (equivalent, by script). Swaps are almost all equivalent in this code.
- **The other 228:** a random sample of 40 was read by hand: 23 equivalent (a field default the constructor overwrites, a panic message's text, a function nothing calls), 12 in features the oracle never switches on (the uncommitted-size limit, byte limits on in-flight messages and message size, `Bootstrap`, `CreateSnapshot`), and 5 real gaps: a missing snapshot-index check in the unstable log's `maybeTerm`, a flag left set when a snapshot is restored over another, compaction at exactly the first index, the probe path's commit bookkeeping (`sentCommit` in `MaybeDecrTo`), and a restart whose saved commit equals the snapshot index.
- **Estimate** (reasoned from the sample): about 250 of 1,147 mutants are equivalent. Of the roughly 900 that change behaviour, the 41 files catch about 74%, and files plus fuzz about 89%. About 70 that survive live in unexercised features and about 30 are real gaps (95% interval roughly 10 to 60).
- **The fuzz extensions mattered.** The read-index commands killed 40 survivors (the whole ReadIndex path was invisible to the files), and the restart commands killed 10, including `SetHardState` itself: without restarts, nothing in the files or the plain fuzz checks that the HardState is persisted.
- **What closes the rest:** Go's unit tests (8,838 code lines), which test the limits, `Bootstrap`, storage and flow-control edges directly. Porting them is the main remaining work in the projection below.

### Go constructs and how the port handles them (none blocks a faithful port)

| Go construct | Where it matters | Port |
|---|---|---|
| `uint64` ids, terms, indexes | everywhere | JS numbers: exact below 2^53. `math.MaxUint64` as "no limit" is `Infinity`. `LocalAppendThread` / `LocalApplyThread` (MaxUint64, MaxUint64−1) become the two largest safe integers. No path the files or the fuzz exercise relies on wraparound (reasoned, then fuzzed). |
| shared slices (`append` into a shared backing array) | log, unstable log, Ready | copy on hand-out. Costs allocations, keeps the semantics. |
| struct value copies (`ppr := *pr`, `*pr = Progress{}`, `ProgressTracker` copied into `Changer`) | confchange, reset | explicit `copy()`, in-place reset, `shallow()`; `Inflights` stays shared exactly as in Go |
| proto2 optional fields (pointers) | every message | optional fields plus `GetX()` getters; entry sizes honour presence |
| `crypto/rand` for the election jitter | `resetRandomizedElectionTimeout` | `globalRand.Intn`, replaceable by a seeded source. The sim needs this anyway (DEV-07). |
| `fmt` verbs in log lines | every log line the files compare | `gofmt.ts`, 156 lines: `%d %x %s %v %q %t` and widths |
| panics | invariant checks | thrown `RaftPanic` |
| goroutines and channels | `node.go` only | not ported; a host drives `RawNode` (the shape fero uses) |
| map iteration order | tallies, `IDs()` | Go's order is random and the code never depends on it (results are sorted or counted); the port's insertion order is therefore fine |

### Projected hours for the whole port

| Remaining part | Go code lines | Projection |
|---|---:|---|
| Go unit tests (`raft_test`, paper, snapshot, flow control, log, storage, rawnode, node, tracker, `testing/quick` property tests) | 8,838 | about 0.5 h at the rate measured; 2–3 h allowing for testify, table tests and `testing/quick` |
| `state_trace.go` (TLA+ trace validation, added in 2024) | 278 | under 0.5 h; worth having, since fero's sim could check traces against `etcdraft.tla` |
| goroutine `Node` and `rafttest` network | about 540 | under 0.5 h if wanted; fero drives `RawNode` |

Spent (measured by the clock): 16 minutes to 41/41; about 35 minutes to the first 2,000 fuzz scripts and the multi-group example; about 2.5 hours for all of E-10, (b) and (c) and the three mutation runs included, of which close to an hour was waiting for the shared CPU lock. **Lines ported per agent-hour: about 21,000 Go code lines** (5,700 in 16 minutes). **Projection for the whole port, Go's unit tests included: about 2 to 5 agent-hours** (reasoned from the measured rate). Even ten times that stays under the 80-hour bar. The mutation run says where the unit tests earn their keep: the limits, `Bootstrap`, storage edges and flow control.

**What following upstream costs** (measured from git history, [results/upstream-churn.txt](results/upstream-churn.txt)): in the year to c51f010, 50 non-merge commits touched etcd raft's non-test Go (1,100 lines added, 931 deleted). Most were one mechanical protobuf migration that a TS port does not need. Behaviour fixes in the core were a handful a year (2026: two stale-read-index fixes, unique heartbeat contexts for reads, a bootstrap relaxation). Each sync is checkable by the same 41 files and the fuzz.

### raft-rs 0.7.0 (from source reading and file diffs; its tests were not run here)

- **Size** ([results/raft-rs-line-counts.txt](results/raft-rs-line-counts.txt)): `src/` is 10,664 physical lines, 7,350 code lines, of which about 2,700 physical lines are inline `#[cfg(test)]` modules and about 400 are datadriven test drivers. `raft-proto` adds 443 hand-written lines. The repository's `harness/` adds about 10,000 lines of tests, hand-ported from etcd's older Go unit tests (not on crates.io).
- **Activity:** last release 0.7.0 on 2023-03-06. The default branch has 29 commits since (last 2026-05-13), some of them etcd backports (Match < Next, disable proposal forwarding).
- **Datadriven:** raft-rs runs etcd-style files only for `quorum` and `confchange`, and has no `InteractionEnv`. So **0 of etcd's 28 interaction files** can run on it. Of etcd's 13 package-level files, raft-rs carries 12 copies (`update.txt` is missing). Diffed against etcd's current files: 2 are identical and 2 differ only in a final newline, so **4 of 13 would pass unchanged** (reasoned). 8 differ: in 6 confchange files a new peer's progress starts at `next=0`, where etcd now keeps `next = max(lastIndex, 1)` so that Match < Next always holds (a behaviour difference); in 2 quorum files the `Describe` bar rendering differs (cosmetic, fixed in etcd in 2025-12).
- **What etcd c51f010 has and raft-rs 0.7.0 lacks** (grep plus reading; [results/upstream-churn.txt](results/upstream-churn.txt) lists the etcd commits):

| etcd feature or fix | etcd test file | raft-rs 0.7.0 |
|---|---|---|
| async storage writes (`AsyncStorageWrites`, `MsgStorageAppend` / `MsgStorageApply` to local threads) | async_storage_writes, async_storage_writes_append_aba_race | a different API (`on_persist_ready`, `advance_append_async`): async persistence exists, but not etcd's message contract, so etcd's files and traces do not carry over |
| `ForgetLeader` | forget_leader, forget_leader_prevote_checkquorum, forget_leader_read_only_lease_based | absent |
| `StepDownOnRemoval` | confchange_v1_remove_leader_stepdown, confchange_v2_replace_leader_stepdown | absent |
| `DisableConfChangeValidation` | confchange_disable_validation | absent |
| `MaxInflightBytes` (flow control by bytes) | (unit tests) | absent |
| in-flight commit tracking (`sentCommit`, `CanBumpCommit`, 2024) | lagging_commit | absent |
| leaving snapshot state when an append reply shows the follower caught up (`Match+1 ≥ firstIndex`) | snapshot_succeed_via_app_resp, snapshot_succeed_via_app_resp_behind | older rule (`matched ≥ pending_snapshot`) |
| heartbeat reply unpauses a probing follower | heartbeat_resp_recovers_from_probing | older behaviour (frees one in-flight slot) |
| stale read index fixes (2026-10) and unique heartbeat contexts for reads (2026-03) | (unit tests) | absent |
| TLA+ trace validation hooks (2024) | — | absent |

  raft-rs has extras etcd lacks: priority elections, group commit, request-snapshot, commit index carried on heartbeat replies, and lazy entry fetching.
- **Blocking gap?** None blocks building on raft-rs; TiKV runs it in production. But it is a fork that has drifted for years, and its tests are its own. A raft-rs core could only be checked against etcd's files after porting `InteractionEnv` to Rust and reconciling the differences above.

### npm (registry metadata, [results/npm-survey.md](results/npm-survey.md))

| Package | Latest, last publish | Weekly downloads | Dependents | Test script | Note |
|---|---|---:|---:|---|---|
| node-raft-redis | 0.1.1, 2022-04 | 1,314 | 0 | no | "simplified" Raft over Redis |
| gaggle | 2.1.4, 2016-02 | 664 | 1 | tap | abandoned |
| @markwylde/liferaft | 1.4.0, 2025-04 | 209 | 3 | mocha | fork of liferaft (2018) |
| tinyraft (antietcd) | 1.0.1, 2024-06 | 119 | 1 | yes | leader election only |
| hamok | 2.6.0, 2024-12 | 84 | 0 | jest | object store on Raft |
| zmq-raft | 0.8.0, 2026-05 | 15 | 1 | tap | needs ØMQ |
| raft-logic | 0.3.14, 2026-01 | 15 | 0 | yes | raft-rs compiled to WASM, a promise API |
| @botiroff/bulwark | 0.1.0, 2026-08 | 9 | 0 | vitest | its own seeded simulator and a linearizability check; one release; reads go through the log |
| 24 others | — | ≤ 45 | ≤ 3 | — | one release, or untouched since 2014–2019 |

No readme claims etcd's tests or any byte-level oracle (searched each readme for "etcd", "datadriven", "jepsen", "TLA"). `raft-logic` shows raft-rs can be compiled to WASM and driven from JS (cited from its readme), which is relevant to E-04.

## What this leaves out

- **Speed.** The port's cost per append and per idle group is not measured here; E-02 and E-11 do that ([USAGE.md](port/USAGE.md) is for E-11). `cluster_smoke.ts` prints times, but it is a correctness example on a shared box, not a benchmark.
- **Go's unit tests are not ported.** The mutation run shows what that leaves open: the uncommitted-size and byte limits, `Bootstrap`, `CreateSnapshot` and a few dozen edge cases. The fuzz's own `read-index` and `restart` commands closed the two biggest holes the files leave (reads, and persistence across a restart).
- **The fuzz has limits.** It uses the harness's commands plus `read-index` and `restart`. It never compacts storage at random (Go panics on a bad index), keeps nodes 1 and 2 voters so that no change removes every voter, never sets the size limits, and pins the election jitter to 0 on both sides. Its `restart` does not restore the applied ConfState (see above).
- **Agent-hours are this agent's.** It may know etcd's code from training, so a human, or another model, would be slower. The oracle, not the speed, is what makes the port trustworthy.
- **raft-rs was read, not run.** Its own suite was refused by the session's safety check; its datadriven results are reasoned from file diffs. openraft is out of scope here.
- **npm usage** comes from download counts and dependents in registry metadata, not from code.
- **TypeScript types were not checked by `tsc`** (none is installed here); the code runs under Node's type stripping.

## Files

- [port/](port): the port. [port/USAGE.md](port/USAGE.md) says how to create groups, tick, step messages and read Ready.
- [diff/](diff): the differential fuzz ([gen_scripts.ts](diff/gen_scripts.ts), [zz_e10_diff_test.go](diff/zz_e10_diff_test.go), [run_ts.ts](diff/run_ts.ts), [run_diff.sh](diff/run_diff.sh)) and the mutation runs ([mutate.ts](diff/mutate.ts), [classify_swaps.py](diff/classify_swaps.py)).
- [npm/survey.py](npm/survey.py), [tools/count_lines.py](tools/count_lines.py), [tools/upstream_churn.sh](tools/upstream_churn.sh).
- [fetch.sh](fetch.sh) fetches etcd raft, Go 1.26.10 and its modules, raft-rs, both git histories and the npm metadata. [run.sh](run.sh) re-runs everything.
- [results/](results): raw outputs. Machine: [results/machine.txt](results/machine.txt) (4 vCPU, 16 GB, Node 22.22.0, Go 1.26.10).

Q-10: etcd raft is about 4,100 code lines of library plus 1,600 of test harness; a faithful TypeScript port of all of it passes 41 of 41 datadriven files and 4,000 of 4,000 random Go-filled scripts (with reads and crash-restarts) byte for byte, took 16 agent-minutes to first green (about 21,000 Go lines per agent-hour) and projects to 2–5 agent-hours with Go's unit tests (bar: 80), with no Go construct blocking it; etcd's files catch about 74% of behaviour-changing mutants of the port, files plus fuzz about 89%; raft-rs 0.7.0 cannot run etcd's 28 interaction files and lacks etcd's async-write contract, ForgetLeader, StepDownOnRemoval and the 2024–2026 fixes; no npm library has a comparable oracle. Moves: MIN (and every `port` row: MIN-TS, LEAN, MIN-P, RLOG, DRAFT, CELL, LANE, SPLIT, and SLOG's and ISR's metadata group) up on DEV-04 and DEV-05, and the `ts→rs` rows up on TEST-10 (a byte-for-byte differential against a second implementation is cheap); RUST, EMB-V8, SIDE and SRV's Rust variant (`raft-rs`) down on DEV-04 (a drifted fork without etcd's oracle; not blocked); `jslib` out.
