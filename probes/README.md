# Slice 0: the probe sheet

Slice 0 builds no product rule. It runs seven probes. Each probe has a **kill line**: a result that stops the plan for that part and sends it to its fallback. This page is the one page to read: each probe, its kill line, its number and its state. The probes and their kill lines are from the build plan, [BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md) section 3.3.

Each claim is marked: *(measured)* a run here gave the number, *(counted)* counted from files, *(checked)* compared or proven by a tool, *(reasoned)* argued and not run.

**State on 2026-11-24:** two probes ran, both in the cloud. Neither was killed. Each leaves one question that is the owner's to answer. Five probes have not run.

## The seven probes

| Probe | What it tests | Kill line | Its number | State |
|---|---|---|---|---|
| **P1** The Rust Raft | Can etcd's Raft be ported to Rust and proven equal to etcd's Go code? | Not 41 of 41 test files plus 4,000 random scripts, byte for byte, within 10 working days. The mutant score must not fall below the TypeScript port's (about 74 % and about 89 %) | 41 of 41 files and 4,000 of 4,000 scripts, 48 minutes after the start *(measured)*. Mutant score about 73 % and about 87 % *(estimated from a sample)* | **Passed** on the files, the scripts and the clock. **Open** on the mutant score: 1 to 3 points under, inside the error. See P1 |
| **P2** The kernel in the simulator | Is a Rust simulator fast enough, and do its native and WASM builds give the same bytes? | 200 full-stack seeds take over 1 s, or a fresh world over 5 ms. Or the two builds differ on any of 1,000 seeds | none yet | **Not run yet.** Next, in the cloud |
| **P3** The time to change | How long from a one-line edit of a Raft rule to 200 seeds run again? | Over 30 s, projected to a kernel of about 10,000 lines | none yet | **Not run yet.** Waits for the owner's laptop: it needs real timing |
| **P4** Judge, cross and fold on one thread | Can one thread judge a write in JavaScript, hand it to Rust, and fold the committed records, fast enough? | Under 500,000 records a second at a million rows. Or over 0.3 ms on the main thread per batch at the 99th percentile | none yet | **Not run yet.** Waits for the owner's laptop |
| **P5** One number for "applied once, in order" | Can one number per stream replace the five high marks and their 32 rules? | No saving of 3 rules or more, or a model fails | No model fails in 25 complete runs *(checked)*. Saving: 7 to 13 rules on the ledger's count, 2 to 5 on the study's count *(counted)* | **Passed** on the models and on the ledger's count. **Open** on the study's count: at the line. See P5 |
| **P6** The markers | Is switching each rule off, one by one, cheap enough to do every night? | Over 30 minutes projected for 640 rules. Or fewer than 80 % of the rules can be a switch | none yet | **Not run yet.** Next, in the cloud |
| **P7** The commit path on real disks | Does a commit meet its time bar on real, separate disks with no JavaScript in the path? | Commit time at the 99th percentile over the disk's floor plus a round trip plus 0.5 ms | none yet | **Not run yet.** Waits for the owner's laptop |

## What the owner must decide

1. **P1, the mutant score.** The kill line says the score must not fall below the TypeScript port's. The point estimates are below it by 1 to 3 points. The gap is inside the error of both estimates. Is that a pass?
2. **P1, numbers at the edge.** Go's numbers wrap when they overflow. The port stops with an error instead, unless a line says to wrap. A check found places where a peer's message could stop the port this way; those are fixed. Others may remain on longer paths. The choice: make every sum in the Raft crate wrap as Go does, or refuse absurd numbers where messages are decoded in slice 1.
3. **P5, which count the kill line means.** On the ledger's count the saving is 7 to 13 rules. On the study's own count, the one the "32" is in, it is 2 to 5. The kill line is "no saving of 3 or more".
4. **P5, one run that failed on the way.** An early version of one model broke a property. The cause was read as a mistake in the model's world, not in the design. Two readers agree. The kill line says "or a model fails", so the reading needs a yes.

No probe was killed, so there is no card yet.

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
- **The rule "a leader counts only entries of its own term" can be removed and no test fails** *(measured: the mutant survives the files and the scripts)*. The same was true of the TypeScript port. Other holes: snapshots with storage writes in flight, a conflict in the middle of entries not yet stored, the edges of restoring a snapshot.
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

These are times of automated work, not of a person. No time bar of the product was judged here: those are judged only on the quiet machine.
