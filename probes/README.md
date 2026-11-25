# Slice 0: the probe sheet

Slice 0 builds no product rule. It runs seven probes. Each probe has a **kill line**: a result that stops the plan for that part and sends it to its fallback. This page is the one page to read: each probe, its kill line, its number and its state. The probes and their kill lines are from the build plan, [BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md) section 3.3.

Each claim is marked: *(measured)* a run here gave the number, *(counted)* counted from files, *(checked)* compared or proven by a tool, *(reasoned)* argued and not run.

**State on 2026-11-25:** four probes ran, all in the cloud. None is marked killed. **P6 stands on its kill lines:** by the plan's own words one of them trips (75.6 % of the rules can be a switch; the line is 80 %), and the other holds only on short runs with several cores (28 minutes; the line is 30). Whether P6 is killed is the owner's call. P2 is under all three of its lines, on provisional timing. P1 passed (the owner ruled its mutant score a pass, V5-28) with one open question. P5 passed with two. Three probes have not run; they wait for the owner's laptop.

## The seven probes

| Probe | What it tests | Kill line | Its number | State |
|---|---|---|---|---|
| **P1** The Rust Raft | Can etcd's Raft be ported to Rust and proven equal to etcd's Go code? | Not 41 of 41 test files plus 4,000 random scripts, byte for byte, within 10 working days. The mutant score must not fall below the TypeScript port's (about 74 % and about 89 %) | 41 of 41 files and 4,000 of 4,000 scripts, 48 minutes after the start *(measured)*. Mutant score about 73 % and about 87 % *(estimated from a sample)* | **Passed** on the files, the scripts and the clock. The mutant score is 1 to 3 points under, inside the error; the owner ruled it a pass (V5-28). See P1 |
| **P2** The kernel in the simulator | Is a Rust simulator fast enough, and do its native and WASM builds give the same bytes? | 200 full-stack seeds take over 1 s, or a fresh world over 5 ms. Or the two builds differ on any of 1,000 seeds | 200 seeds in 287 ms. A fresh world in 0.21 ms at the 99th percentile. 0 of 1,000 seeds differ, and 0 of 1,000 fresh ones *(measured, provisional; the byte check is checked)* | **Passed** on all three lines, on provisional timing. **Open** on what "a fresh world over 5 ms" means: about 1 warm world in 10,000 takes longer, and so does the first world of a new process. See P2 |
| **P3** The time to change | How long from a one-line edit of a Raft rule to 200 seeds run again? | Over 30 s, projected to a kernel of about 10,000 lines | none yet | **Not run yet.** Waits for the owner's laptop: it needs real timing |
| **P4** Judge, cross and fold on one thread | Can one thread judge a write in JavaScript, hand it to Rust, and fold the committed records, fast enough? | Under 500,000 records a second at a million rows. Or over 0.3 ms on the main thread per batch at the 99th percentile | none yet | **Not run yet.** Waits for the owner's laptop |
| **P5** One number for "applied once, in order" | Can one number per stream replace the five high marks and their 32 rules? | No saving of 3 rules or more, or a model fails | No model fails in 25 complete runs *(checked)*. Saving: 7 to 13 rules on the ledger's count, 2 to 5 on the study's count *(counted)* | **Passed** on the models and on the ledger's count. **Open** on the study's count: at the line. See P5 |
| **P6** The markers | Is switching each rule off, one by one, cheap enough to do every night? | Over 30 minutes projected for 640 rules. Or fewer than 80 % of the rules can be a switch | Time: 28 minutes with short runs and 1 worker on 4 cores; 46 minutes on one real core; 6.5 hours with full suites *(measured per rule, then projected; provisional)*. Share: 75.6 % by the plan's own list, 86.6 % if a field carried in a message counts as a switch *(counted)* | **Open, on both lines.** Each line holds on one reading and trips on another. By the plan's own words the share line trips. Not marked killed: the reading is the owner's. See P6 |
| **P7** The commit path on real disks | Does a commit meet its time bar on real, separate disks with no JavaScript in the path? | Commit time at the 99th percentile over the disk's floor plus a round trip plus 0.5 ms | none yet | **Not run yet.** Waits for the owner's laptop |

## What the owner must decide

1. **P1, the mutant score.** The kill line says the score must not fall below the TypeScript port's. The point estimates are below it by 1 to 3 points. The gap is inside the error of both estimates. Is that a pass? **Answered 2026-11-25: a pass** ([V5-28](../docs/DECISIONS.md)).
2. **P1, numbers at the edge.** Go's numbers wrap when they overflow. The port stops with an error instead, unless a line says to wrap. A check found places where a peer's message could stop the port this way; those are fixed. Others may remain on longer paths. The choice: make every sum in the Raft crate wrap as Go does, or refuse absurd numbers where messages are decoded in slice 1. **Answered 2026-11-25: refuse them at the wire** (`links.7`, [V5-29](../docs/DECISIONS.md)); the port keeps its overflow checks.
3. **P5, which count the kill line means.** On the ledger's count the saving is 7 to 13 rules. On the study's own count, the one the "32" is in, it is 2 to 5. The kill line is "no saving of 3 or more".
4. **P5, one run that failed on the way.** An early version of one model broke a property. The cause was read as a mistake in the model's world, not in the design. Two readers agree. The kill line says "or a model fails", so the reading needs a yes.
5. **P2, what "a fresh world over 5 ms" means.** At the 99th percentile a fresh world takes 0.21 ms. But single worlds do go over 5 ms: about 1 warm world in 10,000 (the largest seen was 8.9 ms), and the first world of every new process (6 to 10 ms). Is the bar the 99th percentile, or a hard top? Does the first world of a cold process count?
6. **P6, what the nightly pass is.** With short runs it is 28 minutes with 1 worker on 4 cores, and 46 minutes on one real core. With each layer's full tests for every rule it is 6.5 hours. The kill line is "more than 30 minutes projected for 640 rules". Is the pass made of short runs, on a machine with several cores?
7. **P6, whether a field carried in a message counts as a switch.** The plan lists such a rule as held by an oracle. On that list 75.6 % of the rules are a switch, under the 80 % line. The marker could blank these fields, and tests went red for 6 of the 9. Counted as switches they give 86.6 %. A no here kills P6: the plan then falls back to a rule id typed on each test.

No probe is marked killed, so there is no card yet. P6 is the one that may be: questions 6 and 7 decide it.

## P1: the Rust Raft

**Raft** is the protocol that keeps the copies of a log in agreement. etcd's Raft is the reference, written in Go. The port is in [crates/raft](../crates/raft); its test tooling is in [crates/raft-harness](../crates/raft-harness).

### The result

- **41 of 41 of etcd's own test files pass, byte for byte** *(measured)*. That is 743 steps: 558 in the 28 files that drive whole clusters, 127 in the 4 quorum files, 58 in the 9 membership files.
- **4,000 of 4,000 random scripts equal etcd's Go output, byte for byte** *(measured)*. 280,502 steps over four seeds. Two of the corpora add reads and crash restarts. Go stops with an error in 2 scripts; the port stops at the same step with the same message.
- **The clock.** The kill line allows 10 working days. The files and the scripts were green 48 minutes after the start *(measured: 08:13 to 09:01 UTC)*. With the mutation run P1 took under 2 hours, and the second check 17 minutes more.
- **The mutant score** *(the raw counts are measured; the shares are estimated from a hand-read sample of 45)*. A **mutant** is the port with one rule changed. A test **catches** it when it fails.

| | Rust port | TypeScript port |
|---|---:|---:|
| Mutants that build | 836 | 1,147 |
| Caught by the 41 files | 530 | 663 |
| Caught by the files and the scripts | 632 | 792 |
| Not caught | 204 | 355 |
| Of those, cannot change behaviour (estimated) | about 107 | about 253 |
| **Score by the files**, among mutants that can change behaviour | **about 72.7 %** (range 70.8 to 75.0) | about 74 % |
| **Score by the files and the scripts** | **about 86.6 %** (range 84.4 to 89.4) | about 89 % |

  The Rust score is 1 to 3 points under the TypeScript one. Why *(reasoned from the counts)*: about 100 mutants that can change behaviour get through in each port. The tests are the same, so the holes are the same. Rust gives fewer mutants in all, so the same 100 are a bigger share. Kind by kind, the raw catch rate in Rust is the same or higher. The TypeScript column is that experiment's own estimate, also from a sample.

### How it was checked

- **A second reader tried to break it** *(measured)*. It built from nothing and got 41 of 41. It changed the last expected line of each file in turn: 41 of 41 changes were caught. It ran two new seeds of 500 scripts each: all equal. It corrupted 5 Go outputs: exactly 5 failures.
- **It found one kind of bug the scripts could not see, and fixed it** *(measured)*. A message with a number at the top of the range stopped the port where Go keeps running. A new check sends such messages to one node in Go and in Rust: 1,035,000 single messages and 500,000 runs of four. Before the fix 1,500 lines differed. Now none do. The check is a test in [edge_values.rs](../crates/raft-harness/tests/edge_values.rs).
- **The tests can fail** *(measured)*. Three hand-made mutants each turned the files or the scripts red. One of them is seen only by the restart scripts, one only by the read scripts.
- **The test files are etcd's, unchanged** *(checked by hash and by a file compare against the upstream commit)*.
- **The crate keeps the kernel's rules** *(checked by a test and by reading)*: no standard library, no `unsafe`, no hash maps, no pointer-sized numbers outside one file, no floats. It builds as WASM.
- **The port follows the Go source** *(read)*: eight functions were read side by side with Go. The functions are in Go's order in three of the four big files; in the fourth the free functions sit after the type's methods.
- **The mutation numbers were recomputed from the raw rows** *(checked)*.

### What is not checked

- **Go's unit tests are not ported** (8,575 code lines in Go). They would close most of the holes the mutants found *(reasoned)*.
- **The rule "a leader counts only entries of its own term" can be removed and no test fails** *(measured: the mutant survives the files and the scripts)*. The same was true of the TypeScript port. Probe P6 later found that the edge value check, written after the mutation run, does catch it. Other holes: snapshots with storage writes in flight, a conflict in the middle of entries not yet stored, the edges of restoring a snapshot.
- **The mutation run was not repeated after the edge fix.** Its line numbers are those of the source it ran on.
- **The edge check is one node and four messages deep.** Other plain sums may still stop the port where Go wraps *(reasoned)*.
- **The random scripts have limits** *(reasoned from the generator)*: they never trim the log at random, they keep nodes 1 and 2 as voters, they never set the size limits, and a restart does not bring back the applied membership.
- **Not ported:** Go's threaded `Node` wrapper (the port stops at the single-threaded core it wraps), the trace hooks, and one small function that prints a state as JSON.
- **Speed is not measured.** The port copies entries in places where Go shares them. That belongs with the wire format in slice 1.

### How to run it again

From the repo root. The first command is the one that matters; it ends `ok raft: 41 of 41 etcd files`.

    cargo run -q --release -p raft-harness --bin raft-datadriven
    cargo test --release
    sh crates/raft-harness/scripts/negative-control.sh
    RAFT_SRC=<etcd raft checkout> WORK=<scratch dir> sh crates/raft-harness/diff/run_diff.sh corpus
    WORK=<scratch dir> CORPUS=<the diff work dir> node crates/raft-harness/mutate/mutate.mjs run

The first three need only Rust. The fourth makes the 4,000 scripts again and needs Go and a checkout of etcd raft; without Go, `cargo test --release` still replays the kept samples. The fifth is the mutation run, about 45 minutes on 4 cores. More: [the harness](../crates/raft-harness/README.md), [the script check](../crates/raft-harness/diff/README.md), [the mutation results](../crates/raft-harness/mutate/RESULTS.md).

### The licence

etcd raft is Copyright The etcd Authors, under the Apache License 2.0. The port is a derived work and says so:

- [crates/raft/LICENSE](../crates/raft/LICENSE) is the licence text, byte-equal to upstream's *(checked)*.
- [crates/raft/NOTICE](../crates/raft/NOTICE) names the source, the commit (`c51f010c851edd0dada5af41bafbf68e54617767`), what was changed and what was left out.
- Each source file says which Go file it ports.
- [crates/raft/testdata/PROVENANCE.md](../crates/raft/testdata/PROVENANCE.md) says where the 41 test files come from, with a hash of each.

### The size

Code lines are lines that are neither blank nor comments *(counted by [count-lines.mjs](count-lines.mjs))*.

| Part | Go (etcd) | Rust port | TypeScript port |
|---|---:|---:|---:|
| The core package | 2,736 | 3,346 | 2,036 |
| `node` (Go: all of it; the ports: only the types the core needs) | 352 | 58 | 49 |
| `quorum` | 211 | 246 | 115 |
| `tracker` | 410 | 432 | 305 |
| `confchange` | 334 | 331 | 211 |
| The message types, hand written | 217 | 665 | 428 |
| Helpers Go gets from its standard library | 0 | 147 | 168 |
| **The library** | **4,260** | **5,225** | **3,312** |
| The cluster test driver (`rafttest`) | 1,101 | 1,213 | 643 |
| The file runners and the test-file reader | 263 | 846 | 528 |

- The Rust library is about 1.2 times Go's and about 1.6 times the TypeScript port's.
- Go's message types look small because Go generates 977 more lines from a schema. The ports write them by hand.
- Go's test-file reader is an outside package and is not in Go's 263.
- Left out of both ports, in Go: the package's doc file and trace hooks (298), the threaded test network (240), the unit tests (8,575).
- Beside the Rust port: the script check (196) and the tests (784).

To count again: `node probes/count-lines.mjs <etcd raft checkout> <the TypeScript port folder>`. The TypeScript port is on the `design` branch, in the Raft port experiment's `port/` folder.

**How much of the Raft layer is fero's own is not known yet.** Today all of it is the port. fero's own Raft code (many groups on one server, the links, the storage behind it) starts in slice 1. The share by line count can be given then.

## P2: the kernel in the simulator

The **simulator** runs servers that are not real: a seeded scheduler, a fake network, crashes, and a clock that only moves in ticks. A **seed** is one run; it fixes every random choice, so a run replays exactly. The plan wants one simulator, written in Rust and built twice: native, with no Node, and as WASM under Node, where `data` folds the committed records as steps of the same seed. The simulator is in [crates/sim](../crates/sim), the WASM boundary in [crates/wasm](../crates/wasm), the native runner in [crates/sim-run](../crates/sim-run). The full page is [p2/README.md](p2/README.md).

**Every time in this section is provisional.** It was taken on a shared cloud box, not on the quiet machine where bars are judged.

### The result

**No kill line is crossed** *(measured, provisional; the byte check is checked)*. Two readers measured with the same method. Where they differ, the second reader's numbers are the ones in the table at the top; both are here.

| The kill line | The second reader | The builder |
|---|---:|---:|
| 200 full-stack seeds take over 1,000 ms | **286.9 ms** (284.6 to 313.0) | 302.9 ms (296.5 to 339.0) |
| A fresh world takes over 5 ms, at the 99th percentile | **0.211 ms** (0.200 to 0.271) | 0.250 ms (0.185 to 0.263) |
| The two builds differ on any of 1,000 seeds | **0 of 1,000**, on fresh seeds | 0 of 1,000 |

Each time is the median of three runs' medians, five repeats each after a warm-up. The range is across the three runs.

- **"Full-stack" here** means three simulated servers, two Raft groups, and `data` 4 folding each committed batch. No other TypeScript layer exists yet.
- **Where the 287 ms goes** *(measured, provisional)*. The native build with no Node takes 170 ms. The WASM build under Node with the fold off takes 222 to 237 ms. The fold and its check are the rest.
- **A seed is 2,061 events** *(counted by the run)*. An **event** is one call into one copy of a group: a tick, a message, a client write or a restart. That is about 700 ns per event with the fold and 413 ns native.
- **Messages stay in Rust** *(counted)*. A seed sends 1,376 messages and calls JavaScript 112 times, once per committed batch. This is the point of the design: experiment E-04 lost its speed by packing every message to cross the line.
- **One instance, reset in place** *(measured, provisional)*. A new WASM instance per world sits on the line: 4.5 to 5.0 ms at the 99th percentile. E-04 found the same rule.
- **The fresh-world tail** *(measured, provisional)*. About 1 warm world in 1,000 takes 3 to 4 ms, and about 1 in 10,000 goes over 5 ms. The largest of 30,000 was 8.9 ms. The cause is the JavaScript engine collecting garbage that the fold makes, not Rust *(measured once: 12 collections in 2,200 worlds, the longest 6.8 ms)*.
- **A cold process** *(measured, provisional)*. The first fresh world of a new Node process takes 6 to 10 ms, because nothing is compiled yet. The second takes under 1 ms. A new process that loads `data`, compiles the module and runs 200 seeds takes 420 to 530 ms in all.
- **The module is 317,659 bytes** *(measured)*. The plan's guess for the whole WASM kernel is under 500 KB. Raft and the simulator alone are already 64 % of that.

### How it was checked

- **The byte check** *(checked)*. For each seed three lines are made: by the native runner, by the WASM build with the fold on, and by the WASM build with the fold off. A line is the seed, its event count and a 64-bit hash of every step and of every copy's end state. The three lists are equal for seeds 1 to 1,000 (2,067,731 events) and for seeds 100,001 to 101,000 (2,054,706 events). So are 20 seeds around 2^32, 20 just under 2^53, and seeds 0 to 2.
- **The check can fail** *(checked)*. A planted trap hashes one machine-sized number into the trace: 1,000 of 1,000 seeds then differ between the two builds. The second reader planted two more: an address in the hash, and a sum in machine-sized wrapping maths. Each made 1,000 of 1,000 differ.
- **A second reader built everything from nothing** *(measured)*. The tests, the lints and the format check are green. The run script ends `ok p2` and writes the kept result files again, byte for byte the same.
- **The full stack is real** *(counted, on the fresh seeds)*. Rust made 112,274 batches with 175,094 committed entries. JavaScript took 112,274 calls with 175,094 entries. `data` folded 153,505 records. Each of the run's 9,541 `data` values equals a plain object fed the same records. One instance of the module served all 1,000 seeds.
- **The chaos happens** *(counted, per seed on average)*: 2.5 crashes, 2.6 cut links, 72 lost messages (5 %), 3.2 elections won. Of 78 client writes 56 are taken.
- **Planted bugs turn seeds red** *(measured, on scratch copies, not kept)*.

| The planted bug | Seeds that stop |
|---|---:|
| One copy is enough to commit | 191 of 1,000 |
| A vote is granted without the "is the log up to date" test | 90 of 1,000 |
| A server restarts with an empty disk | 776 of 1,000 |
| The saved term and vote are not written | 115 of 500 |
| One server folds one record wrong in JavaScript | 52 of 200, and 156 of 1,000 for a second such bug |

- **The crates keep the kernel's rules** *(checked by a test and by reading)*. `crates/sim` has no standard library, no `unsafe`, no outside crate and no hash map; machine-sized numbers are named in one file only. A test scans the source for these; it caught one real slip while the crate was written.
- **The port's own check still passes** *(checked)*: `ok raft: 41 of 41 etcd files`.

### What is not checked

- **The time bars.** The box was shared, with a load of 1.6 to 5.5 during the timed runs. The quiet machine must judge them.
- **This is not a safety checker** *(measured)*. Three planted bugs stay green. A vote not saved across a crash: 0 of 2,000 seeds stop. A leader that commits an entry of an old term by counting copies: 0 of 31,000 stop, and no hash even changes. A follower that commits all it appends: 0 of 1,000; with three voters that one is not a bug *(reasoned)*. This small world does not reach those paths. Raft's safety rests on P1, not on this.
- **The world is a stand-in.** It is the ported Raft on a memory disk. There is no kernel, no wire format, no journal, no membership change. The real kernel will do more work per event. What carries over is the shape: messages stay in Rust, and JavaScript is called once per batch *(reasoned)*.
- **A crash never falls inside a step.** A copy saves everything before it sends, so nothing is ever unsaved when a server crashes. No torn disk write was tried.
- **The fold check runs at the end of a seed,** and only between copies that stand at the same applied index: 2,677 of 4,000 possible pairs in 1,000 seeds *(counted)*.
- **The timed fresh worlds are warm.** The bench runs 200 worlds first, so its numbers hide the first world of a process.
- **Only the Node engine was measured.** No browser. Seeds stop at 130 ticks; longer runs were not tried.
- **An event costs more than expected** *(measured, provisional)*: 413 ns native, against 59 ns for E-04's small kernel. The faithful port allocates on every step; the allocator is about 12 % of one profile *(measured once)*.
- **Three choices made here, accepted as build-level calls** *(checked by reading)*. The WASM crate uses the standard library, for the allocator and to keep a monitor's message. It needs `unsafe` to name its exports and its one import: 9 places, each with its reason. So it cannot take the workspace's lint list, which forbids `unsafe`; it carries a copy that only denies it. And `crates/sim-run` is a crate the plan's list does not have.
- **The payload and the batch format are the probe's own.** The real byte shapes come with the wire format in slice 1.

### If it had been killed

The plan's fallback is to keep the scheduler in TypeScript, as E-04 ran it (102 to 384 ms for 200 seeds *(measured there)*), with the Rust kernel as WASM under it. It is not needed on these numbers.

### How to run it again

From the repo root. It needs Rust with the pinned toolchain, Node 22.18 or later, and a checkout of `data` at commit `63fea66`.

    DATA_DIR=<data checkout> sh probes/p2/run.sh           # build, the byte check, the trap; ends `ok p2`
    DATA_DIR=<data checkout> sh probes/p2/run.sh timing    # the measures, three runs
    sh probes/p2/run.sh summary                            # the tables
    cargo test --release -p sim                            # the simulator's own tests

`WORK=<scratch dir>` puts the builds elsewhere. More: [the probe's page](p2/README.md), [the tables](p2/results/tables.md), [the seed list](p2/results/seeds-1-1000.txt).

### The size

Code lines, as in P1's table; each file's unit tests are left out *(counted, by two readers)*.

| Part | Code lines |
|---|---:|
| The executive: the seeded generator, the scheduler, the fake network, crashes, the trace | 423 |
| The P2 world: three servers, two groups, the monitors, the probe's payload | 552 |
| The WASM boundary | 97 |
| The native runner | 48 |
| The Node side: load once, the hook, decode, fold, check | 121 |
| The seed lines, the bench, the tables, the run script | 211 |

The executive knows nothing about Raft. A world plugs in through one interface. The real kernel takes the P2 world's place in slice 1.

## P6: the markers

A **rule** is one record of the ledger. A **marker** wraps the code that holds a rule and carries the rule's id. A test build can **switch one rule off**: the marked code is not run, and a stated value stands in. The **switch-off pass** does that for each rule in turn and records which tests go red. A rule that no test catches is **unproven**. The marker is in [crates/rule](../crates/rule), the scan in [tools/rule-scan.mjs](../tools/rule-scan.mjs). The full page is [p6/README.md](p6/README.md).

**P6 is not marked killed, and it is not a clean pass.** Each of its two kill lines holds on one reading and trips on another. By the plan's own words the share line trips. The choice is the owner's (questions 6 and 7).

**Every time in this section is provisional.** It was taken on a shared cloud box with 4 cores, not on the quiet machine.

### The result

**Kill line 1: more than 30 minutes projected for 640 rules.**

The pass costs the number of rules times the tests' own time. The marker adds nothing that can be measured. 30 minutes over 640 rules is 2.8 seconds of one core per rule *(reasoned)*.

| Reading | Projected for 640 rules | Against 30 minutes |
|---|---:|---|
| Short runs, 4 workers on 4 cores | 20.7 minutes | under |
| Short runs, 1 worker on 4 cores | 28.4 minutes | under, by 5 % |
| Short runs, held to one real core | 45.7 minutes | **over** |
| Each layer's full tests, 4 workers on 4 cores | 249 minutes | **over** |
| Each layer's full tests, 1 worker on 4 cores | 388 minutes | **over** |

All *(measured per rule, then projected; provisional)*.

- **The split.** 237 rules at the cost of a Raft rule and 403 at the cost of a TypeScript rule, as the ledger's layers split *(counted: 37 % of the records are in the two Rust layers)*.
- **A short run** is etcd's 41 files plus 400 random scripts for Raft, and 26 checks with 3 seeds each, in one Node process, for TypeScript.
- **Per rule** *(measured, provisional)*. Raft, short: 0.30 s with 1 worker, 0.08 s with 4, 0.33 s on one core. TypeScript, short: 4.05 s with 1 worker, 3.04 s with 4, 6.61 s on one core.
- **The builder's page first called the 28 minutes "1 core". The second reader showed it is 1 worker on a box with 4 cores:** a Node process uses about 1.7 cores. Held to one real core the same reading is 46 minutes. The second reader's number wins, and the probe's page now says so.
- **The TypeScript side carries the number.** 403 rules at 4.05 s are 27 of the 28 minutes. That cost comes from nine marked rules of a study prototype. One of the nine nearly loops when it is off and doubles the mean; the median is 1.97 s.
- **Why short runs are a fair reading** *(reasoned)*: the plan budgets this tier as "about 500 short runs". Short runs lose little: Raft proves 55 rules with short runs and 58 with everything.

**Kill line 2: fewer than 80 % of the rules can be a switch.**

Sorted: the ledger's 80 Raft rules (the plan says 64; the ledger holds 80) and ten rules of layer L2, marked in the API prototype of the design record. Eight of the Raft rules have no code in the port and are left out of the base. That leaves 82 rules.

| Reading | Raft (72) | TypeScript (10) | Both (82) | Against 80 % |
|---|---:|---:|---:|---|
| The plan's own list: a field carried in a message is held by an oracle | 77.8 % | 60 % | **75.6 %** (62 of 82) | **under** |
| The same, with two rules that share one expression counted once | 76.4 % | 60 % | 74.4 % (61 of 82) | **under** |
| The same, at its most generous: two judgment calls moved to "switch" | | | 78.0 % (64 of 82) | **under** |
| A carried field counts as a switch | 86.1 % | 90 % | **86.6 %** (71 of 82) | over |
| The same, with the two rules that share one expression counted once | 84.7 % | 90 % | 85.4 % (70 of 82) | over |

All *(counted from the probe's sorting; the second reader read all 90 records against the marked code)*.

- **Nine of the 82 rules are a carried field.** The plan's section on markers lists that kind as held by an oracle. The marker's value form could blank the field, the pass ran them, and tests went red for 6 of the 9.
- **So the line holds only if the plan's own definition is widened.** That is the plain summary of both readers.
- **Six more rules are soft** *(checked by reading)*. They do switch off one at a time, but by code the marker adds, not by a block that is skipped. Without them the strict Raft share is 69.4 %.

**The marker's cost.**

- **Rust: none in a release build** *(checked)*. The marked and the unmarked port were built at one path. The code, the constants and the unwind tables are byte-equal: 671,155 bytes of code, 0 differ. Only 62 bytes differ, the line numbers that panic messages name. Against the port with no marker crate at all the code is the same function by function, laid out in another order *(checked by the second reader)*.
- **TypeScript: about half a nanosecond per marker in a hot loop**, about 1 ns in a test run with another rule off *(measured, provisional, noisy at this scale)*.

**What the pass proves.**

- **Raft: 58 of the 62 marked rules, 93.5 %** *(measured)*. The plan's gate for this tier is 85 %. Unproven: two rules no test reaches (making a snapshot in the memory store), one that tests reach and stay green, one the test tooling makes equal by fixing the random part of a timeout.
- **TypeScript: 5 of the 9 marked rules, 56 %** *(measured)*. That is under the gate. The prototype's checks were written to check patterns, not rules. It is a sample of nine.
- **The same holes show as in P1's mutation run** *(checked)*. One is closed: the rule "a leader counts only entries of its own term" is now caught, by the edge value check alone.

### How it was checked

- **A second reader ran it all again** *(measured)*. The patch applies to the port with no reject and gives 41 of 41. The per-rule times came out the same (0.31 against 0.30 s; 4.11 against 4.05 s). All 144 verdicts of a sample of 12 Raft rules equal the builder's.
- **Switching off switches off one rule only** *(checked)*. For each of the ledger's 829 ids: switch it off, then ask every marker whether it is on. Exactly one is off each time.
- **The real port is unmarked** *(checked)*. The marking is a patch, applied to a throwaway copy. The repo's own check still ends `ok raft: 41 of 41 etcd files`. A normal build ignores the switch.
- **The scan finds every site and fails on a made-up id** *(checked)*: 75 sites in the marked Rust copy, 10 in the marked TypeScript; two planted ids gave two failures.
- **The second reader found four ways the scan went wrong, and fixed them** *(checked)*. A Rust raw string with a quote inside hid a real marker later on the line. A marker that was only text in a string was counted. So was a commented marker after a regular expression with a quote in it, and a `rule(` call on some other object.
- **The sorting was read twice** *(checked by reading)*. No rule sorted as an oracle is really a block. One hard disagreement: two rules are one expression wrapped twice.
- **The marker crate keeps the kernel's rules** *(checked)*: no standard library, no outside crate, no `unsafe`. It builds for WASM. The switch that reads an environment variable uses the standard library and is for test builds only.

### What is not checked

- **The time bars.** Provisional, and the real suites do not exist yet.
- **The 640.** Raft's cost stands in for every Rust rule, and a study prototype's for every TypeScript rule. fero's own kernel rules will be tested by the simulator, which this probe did not run.
- **The TypeScript sample is small:** ten rules sorted, nine marked.
- **The sorting is a judgment.** Four more switches lift the strict share over 80 %. Six fewer drop the wide share under it.
- **A proven rule is proven coarsely.** A whole rule off is caught more easily than one wrong edge. P1's mutation run stays the finer net.
- **Timeouts.** A run that loops is cut at 30 s and counted as caught. Six such cuts are a quarter of the full Raft pass. A timeout tied to the green time was not tried.
- **The scan reads source text by hand, not with a parser.** A marker it misses is missed in silence. Other odd source text may still fool it.
- **The ledger does not say that 5 more Raft rules are the host's duty** *(checked by reading)*. The ledger's tools name 3 Raft rules that sit on top of the port. The probe found 5 more with no code in the ported core. The ledger was not edited.
- **Not tried:** one process that walks all rules; the type checker in strict mode on the marked prototype; the switch under WASM tests; the plan's second net, the one-line changes to unmarked lines.

### If it is killed

The plan's fallback is the way it first turned down: a rule id typed on each test. The map's "proven" then rests on a typed link, and the map says so. The second net stays either way.

What stands whatever the answer *(reasoned)*: the marker costs nothing in a release build, a marked crate keeps the kernel's rules, and the pass needs short tests per rule, one process per rule, and the full suites only for a rule a change touches. One test in the Raft tooling ("raft has no outside crates") must learn that the marker crate is the workspace's own; fero's kernel crates will need the same.

### How to run it again

From the repo root. `WORK` is a scratch folder; nothing is written into the repo.

    node tools/rule-scan.mjs                           # the repo's own markers; ends "ok rule-scan: ..."
    cargo test --release -p rule --features switch     # the marker, switching
    WORK=<scratch dir> sh probes/p6/run.sh marked      # the marked copy of the port, built both ways
    WORK=<scratch dir> sh probes/p6/run.sh bytes       # the machine code check; ends "ok bytes: ..."
    WORK=<scratch dir> CORPUS=<the diff work dir> sh probes/p6/run.sh raft-short   # the pass, short runs
    WORK=<scratch dir> E22=<the API prototype folder> DATA=<data checkout> sh probes/p6/run.sh ts-short

The full list of steps, the rules one by one and every per-rule time are on [the probe's page](p6/README.md).

## P5: one number for "applied once, in order"

A **stream** is one writer's writes to one slot. A **high mark** is the highest number a copy of the slot has taken from a stream. Today five mechanisms each keep a mark of their own, so that a write is applied once and in order. The probe asks whether one number can do the work of all five. It is a model study; it builds no product code. The full page is [p5/README.md](p5/README.md).

### The result

- **The form.** Each write carries its own number and the number before it. The leader takes a write only if `before <= high mark < number`. That one pair gives once, in order and no gap, for a client's 1, 2, 3 and for a deriver's numbers with holes. A slot that moves carries one table of marks.
- **No model fails** *(checked)*. Two TLA+ models, 25 complete runs: 22 that check every reachable state at their bounds, and 3 that check a goal state can be reached. The largest has 25 million states. The longest took 33 minutes.
- **The rules saved** *(counted)*:

| Count | Today | After | Saving |
|---|---:|---:|---:|
| The ledger, as the probe cut it | 46 | 33 | 13 |
| The ledger, the second reader's strict cut | 46 | 37 to 39 | 7 to 9 |
| The study's count (the "32") | 32 | 27 to 30 | 2 to 5 |

  The ledger's rules are sentences. The study counts one guard or one update as one rule, which is finer. The kill line's "32" is the study's count; the build's rule budget is the ledger's.

### How it was checked

- **Planted mistakes** *(measured)*. One-line mistakes were put into copies of the models. 27 of 28 on the new form's rules were caught. 9 of 9 on today's rules that stay were caught. The one miss shows that "send in order" is not a safety rule; it only saves a round trip.
- **A second reader ran everything again** *(measured)*: every run gave the same state counts. It planted nine more mistakes on lines the first list had skipped: 8 caught.
- **It found two holes in the bounds and filled them** *(checked)*. No run had a dropped log tail come back beside a restart, and no small run had a retry beside a restart. Six new bounds cover these; all pass. One of its nine mistakes was caught only by a new bound.
- **It counted the rules again and was stricter** *(reasoned)*. That is where 7 to 9 and 2 to 5 come from.

### What is not checked

- **One run failed on the way.** An early version of the client model broke a property in 7 steps. The model had let a relay forward a copy twice, which a rule of today forbids. With that rule in the model every run passes. The failing trace uses no part of the new form *(reasoned; both readers agree)*.
- **The biggest mix did not finish.** It was stopped after one hour and 97 million states. Nothing had failed in the part it reached. It is not counted as a pass.
- **Stalls.** The models check safety. A mistake that only makes a client wait for ever could pass; one such planted mistake did.
- **Not modelled:** once names beyond the one-write case, recovery after an unclean stop, the one-commit slot move, real Raft, a session lapse that has not committed.
- **Small bounds.** Up to 3 writes, 3 copies, 2 leader changes and 3 lives, never all at once.
- **The mistakes were listed by hand,** not made by a tool from the whole model.
- **Nothing was timed.** The cost on the wire and in memory is reasoned.

### How to run it again

From `probes/p5`. It needs Java and the TLA+ tools jar.

    TLA_JAR=<the tools jar> ./run.sh            # the small bounds, about 35 minutes (d-move is 26 of them)
    TLA_JAR=<the tools jar> ./run.sh big        # all counted bounds, about two hours
    TLA_JAR=<the tools jar> ./run.sh mutants    # every planted mistake

Each run prints one line and the script ends `ok p5` when all pass.

## The clock

All on 2026-11-24, in the cloud, on one box with 4 cores shared by two jobs *(measured by time stamps)*.

| Work | Wall time |
|---|---|
| P1: the port, to 41 of 41 | 43 minutes |
| P1: the 4,000 scripts | 5 minutes |
| P1: the mutation run | 1 hour 10 minutes |
| P1: the second check, with the edge fix | 17 minutes |
| P5: the study | 3 hours 25 minutes |
| P5: the second check | 1 hour 24 minutes |
| P2: the simulator, the byte check and the timed runs (13:34 to 14:36 UTC) | 1 hour 2 minutes, about 20 of them waiting for the machine |
| P2: the second check (14:36 to 14:55 UTC) | 19 minutes |
| P6: the marker, the scan, the pass and the timed runs (13:34 to 14:55 UTC) | 1 hour 21 minutes, about 37 of them timed runs |
| P6: the second check (14:56 to 15:25 UTC) | 29 minutes |

These are times of automated work, not of a person. P2 and P6 ran at the same time. No time bar of the product was judged here: those are judged only on the quiet machine. Every time P2 and P6 give is provisional for the same reason.
