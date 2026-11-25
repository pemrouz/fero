# Probe P2: the kernel in the simulator

The **simulator** runs servers that are not real: a seeded scheduler, a fake network, crashes, and a clock that only moves in ticks. A **seed** is one run; the seed fixes every random choice, so a run replays exactly.

The plan wants one simulator, written in Rust and built twice ([BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md) section 2.1). Built native, it runs with no Node. Built as WASM, the same code runs under Node, and `data` folds the committed records as steps of the same seed. This probe asks two things. Is that fast enough? Do the two builds give the same bytes?

Each claim is marked: *(measured)* a run here gave the number, *(counted)* counted from files, *(checked)* compared by a tool, *(reasoned)* argued and not run.

**All times here are provisional.** They were taken on a shared cloud machine. Bars are judged only on the quiet machine.

## The kill line

- 200 full-stack seeds take over 1 s, **or**
- a fresh world takes over 5 ms (TEST-01), **or**
- the native and the WASM build give different bytes on any of 1,000 seeds.

"Full-stack" here means: three simulated servers, two Raft groups, and `data` 4 folding each committed batch. No other TypeScript layer exists yet.

If killed, the plan keeps the scheduler in TypeScript, with the Rust kernel as WASM under it.

## The result

No line is crossed. *(measured, provisional)*

| What | Number | The line |
|---|---:|---:|
| 200 full-stack seeds, WASM under Node, one instance, `data` folding | **303 ms** (297 to 339) | 1,000 ms |
| A fresh world plus a scenario, 99th percentile | **0.25 ms** (0.19 to 0.26) | 5 ms |
| Seeds where the native and the WASM build differ, of 1,000 | **0** | 0 |

Each time is the median of three runs' medians; the range is across the three runs. Each run repeats a measure five times after a warm-up.

### 200 seeds *(measured, provisional)*

| How | ms for 200 seeds | Range | ns per event |
|---|---:|---|---:|
| **WASM under Node, one instance, `data` folding** | **302.9** | 296.5 to 339.0 | 735 |
| WASM under Node, one instance, no fold | 221.9 | 220.6 to 227.2 | 538 |
| Native, no Node, no fold | 169.7 | 169.3 to 189.9 | 412 |
| WASM under Node, a new instance per seed, `data` folding | 369.2 | 360.9 to 383.6 | 895 |

- A seed is 2,061 events on average: 412,276 events in 200 seeds *(counted by the run)*. An **event** is one call into one replica: a tick, a message, a client write or a restart.
- One pass of 200 seeds calls JavaScript 22,453 times, once per committed batch per replica. The batches hold 35,159 entries; 32,511 are client writes *(counted by the run)*.
- The fold and its check cost about 81 ms of the 303 *(measured: the difference of two rows)*.
- WASM under Node is about 1.3 times the native build *(measured: 221.9 against 169.7)*.

### A fresh world plus a scenario *(measured, provisional)*

The scenario: reset to three servers and two groups; tick until both groups have a leader; three client writes (set, incr, set) to one group; `data` folds each applied entry on each replica; one read of the folded row on each server; destroy. 2,000 worlds per repeat. A world is 231 events *(counted by the run)*.

| How | p50 ms | p99 ms | Range of p99 | p99.9 ms | Max ms (median of runs) | Largest max |
|---|---:|---:|---|---:|---:|---:|
| **One instance, reset in place** | **0.113** | **0.250** | 0.185 to 0.263 | 3.33 | 3.84 | 7.03 |
| A new instance per world | 0.372 | 5.03 | 4.77 to 5.63 | 39.2 | 41.2 | 100.7 |

- **The rule from experiment E-04 holds again: one instance, reset in place.** A new instance per world sits on the 5 ms line at the 99th percentile.
- **The tail is the JavaScript engine collecting garbage.** About 1 world in 1,000 takes 3 to 7 ms. In a run with the engine's collections recorded, 2,200 worlds saw 12 small collections, the longest 6.8 ms *(measured once, without the timing lock)*. The garbage is the six fold values each world makes *(reasoned)*.

### The module *(measured)*

- Size: 317,659 bytes, a plain release build with no size pass. The plan's guess for the whole WASM kernel is under 500 KB; Raft and the simulator alone are already 64 % of it.
- Compile: about 50 microseconds (the engine compiles lazily). Make an instance: about 350 microseconds.
- The instance's memory after 200 seeds: 1,245,184 bytes.

### One more build, for reference *(measured, one run, provisional)*

The same code built with whole-program optimisation (`lto = "fat"`, one codegen unit). The repo's profile was not changed for it.

| How | Plain release | Whole-program |
|---|---:|---:|
| 200 full-stack seeds | 303 ms | 255 ms |
| 200 seeds, no fold | 222 ms | 174 ms |
| 200 seeds, native | 170 ms | 138 ms |
| Fresh world, p99 | 0.25 ms | 0.16 ms |
| Module size | 317,659 bytes | 296,911 bytes |

Its hashes for seeds 1 to 1,000 equal the plain build's, native and WASM *(checked)*. It builds more slowly, which matters to probe P3.

Full tables: [results/tables.md](results/tables.md). Raw lines: [results/timing.jsonl](results/timing.jsonl).

## The byte check

For seeds 1 to 1,000, three lists of `seed events hash` lines are made:

1. the native runner, with no Node and no fold;
2. the WASM build under Node, with `data` folding;
3. the WASM build under Node, with the fold off.

**All three lists are equal** *(checked: 1,000 of 1,000 lines, 2,067,731 events; [results/check.txt](results/check.txt), the list is [results/seeds-1-1000.txt](results/seeds-1-1000.txt))*.

The **trace hash** of a seed is FNV-1a, 64 bits, over every step in order: the event, what the replica did because of it (what it saved, sent and applied), and the fate of each message it sent. At the end comes the state of every replica: its saved term, vote and commit, a hash of its saved log, what it applied, and its state in memory if it is up. Numbers go in as varints, so their bytes do not depend on the machine. The hook into JavaScript returns nothing, so nothing JavaScript does can reach the hash.

**The check can fail** *(checked)*. A cargo feature, `trap-width`, hashes one machine-sized number (a length as `usize`) into the trace. That number is 4 bytes in the WASM build and 8 in the native one. With it, **1,000 of 1,000 seeds differ** between native and WASM ([results/trap.txt](results/trap.txt)). The feature is off in every normal build; only `./run.sh trap` turns it on.

## What was built

| Part | Where | Code lines |
|---|---|---:|
| The executive: the seeded generator, the scheduler, the fake network, crashes, the trace | [crates/sim](../../crates/sim): `rng.rs`, `exec.rs`, `net.rs`, `trace.rs`, `num.rs`, `lib.rs` | 423 |
| The P2 world: three servers, two groups, each replica the ported `RawNode`; the monitors; the probe's payload | [crates/sim](../../crates/sim): `p2.rs`, `payload.rs` | 552 |
| The WASM boundary: a byte ABI, no outside crates | [crates/wasm](../../crates/wasm) | 97 |
| The native runner | [crates/sim-run](../../crates/sim-run) | 48 |
| The Node side: load once, the hook, decode, fold, check | [sim.mjs](sim.mjs) | 121 |
| The seed lines, the bench, the tables, the run script | [lines.mjs](lines.mjs), [bench.mjs](bench.mjs), [summarize.mjs](summarize.mjs), [run.sh](run.sh) | 211 |

Code lines are lines that are neither blank nor comments *(counted)*. The Rust counts leave out each file's unit tests (127 lines) and the source scan (60 lines).

- **`crates/sim`** has no `std`, no `unsafe` and no outside crate. It depends on `crates/raft` only. A test reads its source and fails on a hashed container, a float, or a machine-sized integer outside `num.rs` *(checked: the test caught one while this was written)*.
- **The executive knows nothing about Raft.** A world plugs in through one trait (`exec::World`): tick, deliver, client write, crash, restart, dump. The real kernel takes the P2 world's place in slice 1.
- **`crates/wasm`** uses `unsafe` only to name its exports and its one import, 9 places, each with its reason. The import is declared `safe`. The world lives in a thread-local cell, so no `static mut` is needed.
- **Messages between simulated servers stay in Rust.** They are never packed and never cross into JavaScript.

### The chaos

After experiment E-04's shape. 130 ticks. Each tick: a 2 % chance to crash one server for 3 to 12 ticks; a 2 % chance to cut one server's links for 5 to 14 ticks. 5 % of messages are lost; the rest take 1 to 3 ticks. A client write in 60 % of ticks, to a random group, proposed at a random server. A follower forwards it to the leader, as etcd does; it is dropped if the server is down or knows no leader. Election tick 10, heartbeat tick 1, PreVote and CheckQuorum on.

A crash drops the replica and keeps what it saved: the hard state, the entries and the snapshot. A restart builds a new replica on that, which applies its committed entries again from the first one.

Chances are whole parts per 1,000. The generator is splitmix64. There is no float anywhere on the Rust side.

### The monitors, in Rust

- In each group, every replica applies the same entry bytes at the same index.
- A term has at most one leader.

A seed that breaks one panics. Under Node the call traps, and the runner prints the monitor's message.

### The payload (probe only)

The real byte shapes come with the `wire` crate in slice 1. Until then a client write is:

| Field | Bytes | What |
|---|---|---|
| op | 1 | 0 set, 1 incr, 2 del |
| request id | varint | unsigned LEB128; from 2^32 up in a tenth of the seeds |
| key | varint + n | the length in bytes, then UTF-8 |
| value | 8 | an IEEE-754 double, little end first; absent for del |

- Keys: `a`, `b`, `c`, `user:1`, `user:2`, and five that are not ASCII: accented (`café`, `naïve`), fullwidth (U+FF5A), an emoji (U+1F600, outside the first plane), and U+FFE6 between two letters. All valid UTF-8.
- Values come from a fixed table of bit patterns: small whole numbers and -1, fractions (0.125, 0.5, 1.5, 2.75, 7.875, 0.1), numbers from 2^32 up, and numbers around 2^53. Rust only copies the 8 bytes. JavaScript reads them as a number; `incr` adds there.

### The ABI

A 64-bit number crosses as two 32-bit halves, low half first.

- Import `fero.batch(server, group, first_lo, first_hi, ptr, len)`: one batch of committed entries of one replica. Each entry is a varint length, then that many payload bytes. Length zero is the empty entry a new leader writes. Entry `i` has the log index `first + i`. A batch that starts at or before what the fold already holds means the replica restarted: the fold starts again from nothing.
- Exports: `p2_reset(seed)`, `p2_run_seed(seed) -> events`, `p2_fresh(seed) -> events`, `p2_destroy()`, `p2_hash_lo()`, `p2_hash_hi()`, `p2_panic_ptr()`, `p2_panic_len()`.

### The fold, in JavaScript

One `data` value per replica per group: six. `set` and `incr` become an update record, `del` a remove record, through `data`'s `lane()`. At the end of every seed, replicas of one group that stand at the same applied index must hold the same value. Down replicas are compared too. In 1,000 seeds 2,679 pairs were compared *(counted by the run)*.

## How it was checked

- **The same seed twice gives the same run, also after another seed ran in the same world** *(checked by a test)*.
- **The apply monitor fires in a real run** *(measured, on a scratch copy, not kept)*. With the Raft rule "a majority must hold an entry before it commits" changed to "one copy is enough", 191 of 1,000 seeds stop with the apply monitor's message.
- **The fold check fires** *(measured, on a scratch copy, not kept)*. With one server folding one `set` wrong, 52 of 200 seeds stop with the fold check's message.
- **Two more planted mistakes stop the run inside the Raft port itself** *(measured, not kept)*: the hard state not saved (115 of 500 seeds), and one server dropping saved entries (396 of 500).
- **Both monitors have a unit test that makes them fail** *(checked)*.
- **The rest of the tree is as it was** *(checked)*: `cargo run -q --release -p raft-harness --bin raft-datadriven` ends `ok raft: 41 of 41 etcd files`; `cargo test --release`, `cargo clippy --release --all-targets` and `cargo fmt --check` are clean for the three new crates.

## Checked a second time

A second pass built everything from nothing and tried to break the claims above. The source was not changed, apart from one comment in `net.rs`.

- **Fresh seeds agree too** *(checked)*. Seeds 100,001 to 101,000: the three lists are equal, 1,000 of 1,000 lines, 2,054,706 events. So are 20 seeds around 2^32, 20 seeds just under 2^53, and seeds 0 to 2.
- **Two more traps make the check fail** *(checked, on a scratch copy, not kept)*. An address hashed into the final state: 1,000 of 1,000 seeds differ, and two native runs differ from each other. A sum done in machine-sized wrapping maths: 1,000 of 1,000 seeds differ.
- **The fold is real** *(counted, seeds 100,001 to 101,000)*. Rust made 112,274 batches with 175,094 entries; JavaScript took 112,274 calls with 175,094 entries. `data` folded 153,505 records. Every one of the 9,541 `data` values of the run equals a plain object fed the same records.
- **Messages stay in Rust** *(counted)*. A seed sends 1,376 messages on average and delivers 1,232. It calls JavaScript 112 times, once per batch. One instance of the module serves all 1,000 seeds.
- **The chaos happens** *(counted, per seed on average)*: 2.5 crashes, 2.6 cuts, 72 lost messages (5.0 %), 119 messages dropped at a cut link or a down server, 3.2 elections won. Of 78 client writes, 56 are taken, 19 are refused because the server knows no leader, and 4 hit a server that is down.
- **A planted Raft bug goes red** *(measured, on a scratch copy, not kept)*. Votes granted without the "is the log up to date" test: 90 of 1,000 seeds stop, 52 on the apply monitor and 38 on the port's own panic. A server that restarts with an empty disk: 776 of 1,000 stop, 25 on the apply monitor, 5 on the leader monitor, the rest on the port's own panics. A fold that skips one `del` on one server: 156 of 1,000 stop on the fold check.
- **Two planted bugs stay green** *(measured)*. A leader that commits an old-term entry by counting copies: 0 of 31,000 seeds stop, and the hashes do not even change. A follower that commits all it appends: 0 of 1,000. With three voters the second is not a bug *(reasoned: two copies are a majority)*, and the first needs a schedule this small world almost never makes.
- **The times agree** *(measured, provisional, the same method)*: 200 full-stack seeds 286.9 ms (284.6 to 313.0); fresh world p50 0.113 ms, p99 0.211 ms (0.200 to 0.271), largest of 30,000 worlds 8.9 ms.
- **A cold process is slower, and still under the bars** *(measured, provisional)*. A new Node process that loads `data`, compiles the module and runs 200 seeds with no warm-up takes 420 to 530 ms in all. The first fresh world of a new process takes 6 to 10 ms, because nothing is compiled yet; the second takes under 1 ms. With no warm-up the p99 of 2,000 worlds is 0.6 to 1.1 ms.

## What is not checked

- **The times are provisional.** A shared cloud machine; the load average was 1.6 to 2.4 at the start of the timed runs. The quiet machine must judge the bars.
- **This is not a safety checker.** One planted mistake survived: with the vote not saved across a crash, 0 of 2,000 seeds failed *(measured)*. The schedule that needs is rarer than these seeds make. Raft's safety rests on etcd's files and scripts (probe P1), not on this.
- **The world is a stand-in.** It is the ported Raft with a memory disk. There is no kernel, no wire format, no journal, no snapshot in use, no membership change, no torn disk write. The real kernel will do more work per event. What carries over is the shape: messages stay in Rust, and JavaScript is called once per batch.
- **Only the Node engine was measured.** The site would run the module in a browser.
- **The disk never fails.** A replica saves everything in a step before it sends; a crash comes between steps, never inside one.
- **Only one fold layer.** `data` 4's `lane()` folds plain keyed rows. No view, no subscriber and no other TypeScript layer runs.
- **The fold check runs at the end of a seed,** not at every step.
- **The timed fresh worlds are warm.** The bench runs 200 worlds first. The first world of a new process takes 6 to 10 ms *(measured, provisional)*; the owner ruled that TEST-01's bar does not count it; it is recorded ([V5-31](../../docs/DECISIONS.md)).
- **Cut links are looked at when a message is due,** not when it is sent, as in E-04.
- **The two builds were made by one compiler version on one machine.**
- **Seeds stop at 130 ticks.** Longer runs and bigger worlds were not tried.

## What cost more than expected

- **An event costs 412 ns native** *(measured, provisional)*. E-04's small kernel took 59 ns. The faithful Raft port allocates for every step: in a profile of the WASM run, the allocator alone is about 12 % *(measured once)*. The profile is flat otherwise. The probe sheet already says the port copies where Go shares.
- **Two groups make a seed bigger**: 2,061 events against E-04's 1,420 for one group.
- **The module is 318 KB** before any kernel exists.
- **The fresh-world tail** comes from garbage in JavaScript, not from Rust.

## How to run it again

From the repo root. It needs Rust with the pinned toolchain, Node 22.18 or later, and a checkout of `data` at commit `63fea66`: set `DATA_DIR`, or put it in `data` next to this repo.

    DATA_DIR=<data checkout> sh probes/p2/run.sh           # build, the byte check, the trap; ends `ok p2`
    DATA_DIR=<data checkout> sh probes/p2/run.sh timing    # the measures, three runs
    sh probes/p2/run.sh summary                            # results/tables.md
    cargo test --release -p sim                            # the simulator's own tests

`WORK=<scratch dir>` puts the builds elsewhere (default `target/p2`). On a shared machine `HEAVY=<a lock wrapper>` and `TIMING=<a lock wrapper>` wrap the heavy and the timed steps.

By hand:

    cargo run -q --release -p sim-run -- seeds 1 5         # native: seed, events, hash
    node probes/p2/lines.mjs <the .wasm> 1 5 fold          # the same lines from WASM, with the fold

## The clock

On 2026-11-24, in the cloud *(measured by time stamps)*: 13:34 UTC start; 13:44 the first equal list of 1,000 seeds; 13:49 the first timed run; 14:05 the timed runs kept here, after a ten-minute wait for the machine; 14:36 the last full check, after a second wait. About one hour in all, of automated work; about a third of it was waiting for the shared machine.
