# Mutation run on the Rust port: results

This page says how well etcd's 41 test files, and then the random Go-filled scripts, catch a
one-rule change in the Rust port's core. It is the same run the TypeScript experiment did on its
port, so the two can be set side by side.

Words: a **mutant** is the core with one rule changed. A test **catches** it when some test fails.
An **equivalent** mutant cannot change behaviour, so no test can catch it. The **oracle** is the
41 files plus the random scripts whose expected outputs etcd's own Go code wrote.

## The answer

- **Raw (counted):** 836 mutants that compile. The 41 files catch 530 (63.4%). The random scripts
  catch 102 more: 632 in all (75.6%). 204 survive.
- **Among mutants that can change behaviour (estimated):** the files catch about **73%**, files plus
  scripts about **87%**. The TypeScript port's numbers were about 74% and about 89%.
- **So the point estimate is 1 to 3 points under the TypeScript one.** The gap is inside the error
  of both estimates (each rests on a hand-read sample of 40 to 45). It is not a clear pass and not
  a clear fail. The next section says where the gap comes from.

| | Rust port | TypeScript port |
|---|---:|---:|
| Mutants (Rust: those that compile) | 836 | 1,147 |
| Caught by the 41 files, raw | 530 (63.4%) | 663 (57.8%) |
| Caught by files + scripts, raw | 632 (75.6%) | 792 (69.0%) |
| Survivors | 204 | 355 |
| Equivalent, estimated from the sample | about 107 | about 253 |
| Can change behaviour | about 729 | about 894 |
| **Files, among those** | **about 72.7%** | **about 74%** |
| **Files + scripts, among those** | **about 86.6%** | **about 89%** |
| Survivors that can change behaviour | about 97 to 102 | about 102 |

The Rust rows are measured or counted here, except the equivalent estimate (reasoned from the
sample). The TypeScript column is cited from that experiment's write-up.

Error of the Rust estimate (reasoned): 17 of 45 sampled survivors are equivalent; the 95% range
for that share is about 25% to 52%. That gives 70.8% to 75.0% for the files and 84.4% to 89.4%
with the scripts.

A cross-check (reasoned): all 155 non-swap survivors were then read, not only the sample
([CLASSIFICATION.md](CLASSIFICATION.md)). 54 are equivalent. With the 48 independent swaps that is
102 equivalent mutants, 734 that can change behaviour: **72.2%** by the files, **86.1%** with the
scripts. The sample and the full read agree.

## Where the gap comes from

- **The same holes, a smaller pile (reasoned from the counts).** About 100 surviving mutants can
  change behaviour in the Rust port, and about 100 in the TypeScript port. The oracle is the same
  and it misses the same things. But the Rust port gives fewer mutants in all (841 against 1,147),
  so the same 100 are a larger share.
- **Why fewer mutants (counted).** Rust has no field defaults to delete (the TypeScript run had
  many, all equivalent). Go's `switch` became `match` in Rust, so there are fewer `==` and fewer
  `if`. rel 104 against 123, guard 341 against 420, drop 201 against 283, swap 52 against 131,
  eq 143 against 190.
- **Operator by operator, the raw catch rate is the same or higher in Rust (counted).** Files plus
  scripts: rel 59.6% against 58.5%, guard 84.2% against 84.0%, drop 76.0% against 67.1%,
  eq 91.6% against 91.1%. Swaps are almost all equivalent in both.
- **The hand classes here are a little stricter (reasoned).** For example `applied > 0` to
  `applied >= 0` is "equivalent" in the TypeScript notes and "unexercised" here, because a restart
  with applied 0 on a store that holds a snapshot would panic. Reading by the other notes' rule
  moves the numbers by 0.2 points.

## The table

| Operator | Made | Do not compile | Mutants | Caught by the 41 files | + scripts seed 2 | + seed 5 (read-index) | + seed 7 (restart) | Survived |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rel (`<` and `<=`, `>` and `>=`) | 104 | 0 | 104 | 55 (52.9%) | 4 | 1 | 2 | 42 |
| guard (drop an `if` conjunct) | 341 | 0 | 341 | 243 (71.3%) | 28 | 14 | 2 | 54 |
| drop (delete an update) | 201 | 5 | 196 | 118 (60.2%) | 22 | 5 | 4 | 47 |
| swap (two adjacent updates) | 52 | 0 | 52 | 3 (5.8%) | 0 | 0 | 0 | 49 |
| eq (`==` and `!=`, extra) | 143 | 0 | 143 | 111 (77.6%) | 11 | 9 | 0 | 12 |
| **all** | **841** | **5** | **836** | **530 (63.4%)** | **65** | **29** | **8** | **204** |

All measured. Per file, with every survivor listed: [results/mutation-run.txt](results/mutation-run.txt).

- 37 mutants were caught by a timeout: they never end (20 s for the files, 120 s for a corpus;
  the unchanged port needs 0.01 s and 1 s). The 24 seen in the first pass were run again, with the
  same result (measured).
- 5 mutants do not compile: each deletes the only assignment of a variable, and the compiler
  refuses to read a variable that was never set. They are left out of every share. If they are
  counted as caught, the shares move by 0.2 points.

## Survivors

- **Swaps (by script).** 49 swaps survive. 48 swap two updates where neither line names the
  other's target, so the order cannot matter: equivalent. The one other is in the unstable log's
  `stable_to` ([results/swap-classes.txt](results/swap-classes.txt)).
- **The other 155 (by hand).** A seeded sample of 45 ([results/sample-seed10.txt](results/sample-seed10.txt)):
  17 equivalent, 18 in features the oracle never switches on, 10 real gaps. The full read:
  54 equivalent, 59 unexercised, 42 gaps.
- **Unexercised features (reasoned):** the uncommitted-size limit, byte limits on in-flight
  messages, exact-equality edges of the size limits, `CreateSnapshot`, `ReportSnapshot`,
  `WithProgress`, `TickQuiesced`, a heartbeat tick above 1, more than 7 voters, config checks.
- **Gaps worth knowing (reasoned):**
  - `maybe_commit` without its term check survives (log.rs:531). That check is the rule that a
    leader counts only entries of its own term. Nothing in the files or the scripts tells the
    difference. The TypeScript run had the same survivor.
  - Snapshots together with async storage writes: the storage message can lose its snapshot
    (rawnode.rs:426), and the in-progress flag can be wrong (log_unstable.rs:138, 201), unseen.
  - A conflict in the middle of the unstable entries is never tried (log_unstable.rs:209, 224).
  - Restoring a snapshot: a node left out of the config, a learner, old peers kept
    (raft.rs:2313, 2318, 2348).
  - A snapshot message that does not reset the election timer or set the leader (raft.rs:2107, 2108).
  - The sent-commit bookkeeping after rejects (tracker/progress.rs:150, 250, 266).
  - Memory storage edges: compacting at the first index, an out-of-date snapshot.
- **What closes them (reasoned):** Go's unit tests, which are not ported yet. They test the limits,
  the storage edges, snapshots and flow control directly.

## Method

- **The tool:** [mutate.mjs](mutate.mjs), plain Node, about 300 lines. It blanks comments, strings
  and char literals first, so nothing inside a message is changed. It finds operators with white
  space on both sides, so `Vec<u64>`, `->` and `=>` are never touched. An `if` condition runs to
  the first `{` outside brackets, over line breaks; match guards count; a `let` conjunct is never
  dropped. An update is one line of the form `target = value;`, `+=` or `-=`.
- **Files mutated:** the Rust counterparts of the nine core files of the TypeScript run:
  `raft.rs`, `log.rs`, `log_unstable.rs`, `rawnode.rs`, `storage.rs`, `read_only.rs`, and all of
  `tracker/`, `quorum/`, `confchange/`.
- **One build per mutant**, with cargo's incremental build, on scratch copies of the workspace
  (two workers, each with its own copy). The real tree is only read; its files were hashed before
  and after and did not change (checked). A changed build profile in the copy (opt-level 1,
  overflow checks still on) makes a build take about 1 s. Mutation schemata (all mutants compiled
  once, switched by an id) would run faster, but they need each operator rewritten as an
  expression that still type-checks. One build per mutant needs no such rewrite, and every mutant
  is exactly the changed source, so it is the sound choice at this size.
- **Lints are not errors in the copy** (`--cap-lints warn`): a deleted update that leaves a
  variable unused is still a program.
- **Order per mutant:** the 41 files; if it survives, the 1,000 scripts of seed 2; then seed 5
  (with `read-index`); then seed 7 (with `read-index` and `restart`). The full set ran, not a sample.
- **Each test binary runs with a memory cap and a timeout.** A timeout kills the whole process
  group. (A first pass killed only the wrapper and left looping mutants behind; it was stopped,
  the tool was fixed, and every timeout row was run again.)
- **Machine time (measured):** about 45 minutes of wall time on 4 cores with two workers, the
  stopped first pass included.

## Run it again

    WORK=<scratch dir> CORPUS=<dir with seed2, seed5, seed7> node crates/raft-harness/mutate/mutate.mjs run
    WORK=<scratch dir> node crates/raft-harness/mutate/mutate.mjs report
    WORK=<scratch dir> node crates/raft-harness/mutate/mutate.mjs swaps
    WORK=<scratch dir> node crates/raft-harness/mutate/mutate.mjs sample 45 10

`CORPUS` is the work directory of `diff/run_diff.sh corpus`. `run` picks up where a stopped run left off.

## Limits

- The equivalent count is a judgment. One reader made it, on one day.
- The comparison is between two piles of different size. The share is lower in Rust; the count of
  live survivors is the same.
- `while` conditions and `match` arms without a guard are not mutated (the TypeScript run did not
  mutate loops either; it had no `match`).
- Go's unit tests are not ported. The survivors say where they would earn their keep.

## A note on line numbers

The line numbers on this page, in [CLASSIFICATION.md](CLASSIFICATION.md) and under `results/`
are those of the source the run used. A later change (the edge value check, see
[../diff/README.md](../diff/README.md)) made some `+ 1` and `- 1` wrap as in Go and added
comment lines: `tracker/progress.rs` moved down by 6 to 8 lines, `raft.rs` by 1 after line 750,
`log_unstable.rs` by 1 after line 75. The run was not repeated on the changed source.
