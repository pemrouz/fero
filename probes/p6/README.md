# Probe P6: the markers

A **rule** is one record of the ledger ([spec/ledger.json](../../spec/ledger.json)). A **marker** wraps the code that holds a rule and carries the rule's id. A test build can **switch one rule off**: the marked code is not run. The **switch-off pass** does that for each rule in turn and records which tests go red. A rule that no test catches is **unproven**.

The build plan leans on this (BUILD 2.6 and 3.3) and nobody had timed it. This probe builds the marker for Rust and for TypeScript, the scan and the pass, marks real code, and measures.

Each claim is marked: *(measured)* a run here gave the number, *(counted)* counted from files, *(checked)* compared by a tool, *(reasoned)* argued and not run.

**All times are provisional.** They were taken on a shared cloud box with 4 cores, not on the quiet machine where bars are judged. Each timed run held a lock that keeps other heavy work off the box.

## The kill lines, and where they stand

The probe has two kill lines. Whether a line trips is not this page's call. It gives each reading and says which one it takes.

| Kill line | The reading this page takes | Other readings |
|---|---|---|
| **More than 30 minutes projected for 640 rules** | **28 minutes with 1 worker, 21 with 4 workers**, on a box with 4 cores *(measured per rule, then projected)*: short runs, as BUILD 2.5 T4 words it ("about 500 short runs"), with rules split between Rust and TypeScript as the ledger's layers are. Under the line, with 5 % to spare | The same short runs held to **one real core: 46 minutes**. Over the line *(measured per rule, then projected)*. Full suites for every rule: **6.5 hours with 1 worker, 4.1 hours with 4**. Over the line by far. Raft's rules alone, the 41 files only: 8 seconds |
| **Fewer than 80 % of the rules can be a switch** | **86.6 %** (71 of 82) *(counted)*: a field that a message carries counts as a switch, because the marker's value form switched such fields off here and tests went red for 6 of the 9 | By BUILD 2.6's own list, where a carried field is held by an oracle: **75.6 %** (62 of 82). Under the line |

So each line holds on one reading and trips on another. The two choices are the owner's. **Answered 2026-11-25: short runs on several cores, and a carried field counts as a switch; P6 passes** ([V5-32](../../docs/DECISIONS.md)). With `raft-config.5` and `.6` counted as one switch, the share is 85.4 % (70 of 82).

1. **Is the nightly pass made of short runs, on a machine with several cores?** If every rule must run its layer's full suite, the pass does not fit 30 minutes at 640 rules on any number of cores tried here. With short runs it fits on 4 cores and does not fit on one. The budget is plain arithmetic: 30 minutes over 640 rules is **2.8 seconds of one core per rule** *(reasoned)*. The short runs use 4.4 seconds of CPU per rule in this split *(measured)*.
2. **Does a carried field count as a switch?** 9 of the 82 rules sorted here are of that kind.

## What was built

| Piece | Where | What it is |
|---|---|---|
| The Rust marker | [crates/rule](../../crates/rule/src/lib.rs) | A macro, `rule!`. No standard library, no outside crate, no `unsafe`. 92 code lines, most of them the test-only switch *(counted)* |
| The TypeScript marker | [rule.ts](rule.ts), [rule-env.ts](rule-env.ts) | One function, `rule(id, body, off)`. The second file is the test side: it reads which rule to switch off |
| The scan | [tools/rule-scan.mjs](../../tools/rule-scan.mjs) | Lists every marker site in `crates/` and in TypeScript sources. Fails on an id the ledger does not hold |
| The pass | [pass.mjs](pass.mjs) | Runs the tests with each rule off, one at a time. Writes one line per run, and a report |
| The marked Raft | [raft-markers.patch](raft-markers.patch) | The marking, as a patch on `crates/raft` and `crates/raft-harness`. The real port stays unmarked |
| The marked TypeScript | [l2-markers.patch](l2-markers.patch) | Ten L2 rules marked in the API prototype of the design record (experiment E-22, `proto/l2.ts`) |
| The sorting | [rules.json](rules.json) | Each rule's kind and the reason, for the tables below |
| The runner | [run.sh](run.sh), [raft.suite.json](raft.suite.json), [all-checks.ts](all-checks.ts) | Makes the throwaway copies in a scratch folder and runs each step. The suite file names Raft's tests. The last file runs the prototype's checks in one process |
| The bench | [bench.ts](bench.ts) | The TypeScript marker's cost |

### What "switched off" means

It means one thing in both languages: **the marked code is not run, and a stated value stands in for it.**

    rule!("raft-term-vote.5", { self.vote = self.id; });                    // a block: off skips it
    if rule!("raft-log.5", !self.match_term(prev), off = false) { .. }      // a guard: off lets all through
    let c = rule!("raft-commit.7", min(matched, committed), off = committed);  // a value: off gives the plain value

- A **block** returns nothing. Off, it is skipped.
- A **guard** is a test that refuses something. Its `off` value is the answer that lets everything through.
- A **value** is a number or a choice the rule shapes (a cap, a plus one, a position in a list). Its `off` value is the plain input.
- The `off` expression is written at the site, so a reader sees what the code does without the rule.

### How a rule is switched off in Rust

- A normal build has no switch. The macro expands to its first expression and nothing else. The id and the `off` expression are gone before the compiler sees them.
- A test build turns on the crate's `switch` feature. Each marker then loads one 64-bit number and compares it with the hash of its id. The hash is made while compiling (FNV-1a).
- `rule::switch_off("id")` sets the number. No rebuild is needed between rules.
- With the `switch-env` feature the first marker reached reads the id from the `RULE_OFF` environment variable. So no test program needs a line of code. This feature uses the standard library; it is for test builds only.
- The scan checks that no two ledger ids share a hash *(checked: 829 ids, none do)*.

### Where the TypeScript marker lives

It is in this folder for now, because the server's TypeScript tree does not exist yet. It moves to `server/` (BUILD 2.1) when slice 1 makes that tree. The scan reads every `.ts` file in the repo, so nothing in the scan changes then.

## The switch share

**What was sorted.** BUILD says "Raft's 64". Today's ledger holds **80** Raft records (ids `raft-*` and `learners.*`, layer L1). All 80 were sorted, and ten L2 records.

**The ten L2 rules.** They are the first rule with code in the prototype's `l2.ts`, from each rule family of layer L2 in the ledger's order, until there were ten. They were not picked for being easy to switch.

**The kinds.**

- **switch (block)**, **switch (guard)**, **switch (value)**: as above.
- **field**: the rule is a field carried in a message or a record. BUILD 2.6 lists this kind as held by an oracle. The marker's value form can blank the field, so the pass ran these too. They are counted apart.
- **oracle**: no code to switch. The rule is held by something being absent, by a type, or by an order that an interface fixes.
- **not in the port**: the rule has no code in the ported core. It is fero's own (3 rules), or the host's duty (5 rules: the journal, the link, the fold). Sorted by reasoning only, and left out of the shares.

| | Raft (80) | TypeScript (10) | Both |
|---|---:|---:|---:|
| switch (block) | 15 | 0 | 15 |
| switch (guard) | 29 | 6 | 35 |
| switch (value) | 12 | 0 | 12 |
| **switch, all three** | **56** | **6** | **62** |
| field | 6 | 3 | 9 |
| oracle | 10 | 1 | 11 |
| not in the port | 8 | 0 | 8 |
| Rules with code (the base of the share) | 72 | 10 | 82 |
| **Share, a field is an oracle** (BUILD's list) | **77.8 %** | **60 %** | **75.6 %** |
| **Share, a field is a switch** | **86.1 %** | **90 %** | **86.6 %** |

All *(counted)* from [rules.json](rules.json).

- **With the 8 rules that are not in the port** *(reasoned)*: 5 would be guards or blocks when built, 2 would be orders held by an oracle, 1 is not sorted. Raft is then 61 of 79 (77.2 %), or 67 of 79 (84.8 %) with fields.
- **The ledger says 3 Raft rules sit on top of the port.** This probe found 5 more with no code in the ported core *(checked by reading)*: `raft-readindex.4`, `raft-snapshot.1`, `raft-snapshot.4`, `raft-snapshot.5`, `raft-snapshot.8`. They are the host's duty. The ledger's records do not say so.
- **Three groups of rules share one block** *(counted)*. Four rules are one test on a message's term, split by the kind of message. Two are one test on the pending-change mark. Two are one test on where an answer waits. Each has its own marker, and each was switched off alone.
- **One rule is smeared** by the scan's count *(counted)*: `raft-term-vote.14` has 4 sites. They are 2 places, each written twice because the marker sits inside another marker's two arms.

## The time

One run of the pass starts each test once per rule, with that rule off. So the pass costs **rules times the tests' own time**. The marker adds nothing that can be measured: the 41 files take 10 ms with the switch build, as without *(measured)*.

### Per rule

Wall time is the pass's wall clock over the number of rules. CPU time is user plus system time of the test processes.

| Suite | Tests per rule | Wall per rule, 1 worker | CPU per rule | Wall per rule, 4 workers | Rules proven |
|---|---|---:|---:|---:|---:|
| Raft, files only | The 41 etcd files | 0.01 s | 0.01 s | | 37 of 62 |
| **Raft, short** | The 41 files and 400 random scripts | **0.30 s** | 0.29 s | **0.08 s** | 55 of 62 |
| Raft, files and scripts | The 41 files and the 4,000 scripts | 5.55 s | 5.47 s | 2.20 s | 56 of 62 |
| Raft, everything | Files, the harness's own tests, 4,000 scripts | 11.71 s | 15.52 s | 4.11 s | 58 of 62 |
| **TypeScript, short, one process** | 26 checks, 3 seeds each, in one process | **4.05 s** (median 1.97) | 6.77 s | **3.04 s** | 5 of 9 |
| TypeScript, short | 27 checks, 3 seeds each, one process per check | 10.02 s | 18.81 s | 5.86 s | 5 of 9 |
| TypeScript, everything | 27 checks at their own 20 to 200 seeds | 50.88 s (median 26.5) | 79.22 s | 34.67 s | 5 of 9 |

All *(measured)*, provisional. Notes:

- **Raft, files only** and the 1-worker column of **Raft, files and scripts** are read from the "everything" run, test by test. The 4-worker number of files and scripts is a run of its own; six runs cut at 30 s hold it back.
- **The Raft suites are 62 marked rules; the TypeScript ones are 9.** With 9 rules, one slow rule moves the mean a lot: `row-version.1` switched off makes two checks nearly loop. That is why the median is given.
- **Timeouts cost real time.** A run that loops is cut and counted as caught. In "Raft, everything" 6 runs of 744 were cut at 30 s; they are 2.9 s of the 11.71 s per rule. In "TypeScript, everything" one run was cut at 120 s.
- **The harness's own tests** are dominated by one test: the edge value check takes 5.3 s and uses 3 threads. That is why 4 workers give only 2.85 times the speed.
- **Node uses about 2 cores per process** (CPU is 1.6 to 1.9 times wall). So 4 TypeScript workers on 4 cores are short of cores; the 4-worker numbers for TypeScript would be better on a bigger machine *(reasoned)*.
- **So "1 worker" is not "1 core" for TypeScript.** A second run held the whole pass to one core (`taskset`) *(measured, provisional)*: "TypeScript, short, one process" then takes **6.61 s per rule** (median 3.87), not 4.05. "Raft, short" takes 0.33 s, nearly the same as before, because the Raft test programs use one thread.
- **A red run is slower than a green one** for the scripts: each failing script prints its first difference.

### Projected to 640 rules

The projection needs a split between Rust and TypeScript rules. This page splits as the ledger's layers do *(counted)*: L0 and L1 are 307 of 829 records, 37 %. So 237 rules in Rust at Raft's cost and 403 in TypeScript at the prototype's cost.

| Reading | 1 worker | 4 workers |
|---|---:|---:|
| All 640 at the cost of Raft, files only | 8 s | |
| All 640 at the cost of Raft, short | 3.2 min | 0.9 min |
| All 640 at the cost of Raft, files and 4,000 scripts | 59.2 min | 23.5 min |
| All 640 at the cost of Raft, everything | 124.9 min | 43.9 min |
| All 640 at the cost of TypeScript, short, one process | 43.2 min | 32.4 min |
| All 640 at the cost of TypeScript, everything | 543 min | 370 min |
| **The split, short runs** (Raft short; TypeScript short in one process) | **28.4 min** | **20.7 min** |
| The split, short runs, the pass held to one real core (0.33 s and 6.61 s per rule) | 45.7 min | |
| The split, short runs, counted in CPU time (0.29 s and 6.77 s per rule) | 46.6 min of one core | 11.7 min at best |
| The split, short runs, with TypeScript's median in place of its mean | 14.4 min | |
| The split, everything | 388 min | 249 min |

All *(projected from the measured per-rule times)*. Both columns are on a box with 4 cores. The "1 worker" column is not one core: a TypeScript worker uses about 1.7 cores. The two rows for one real core say what one core gives.

**The reading this page takes: the split, short runs.** Why:

- BUILD 2.5 budgets T4 as "about 500 short runs". A short run here is the 41 files plus 100 scripts from each of the four corpora for Raft, and every check with 3 seeds for TypeScript.
- Short runs lose little. Raft proves 55 rules with short runs and 58 with everything. TypeScript proves the same 5 either way.
- The full suites stay useful for a touched rule on a change, and for a weekly deep run.

**What the reading rests on, said plainly.**

- It is under the line by 5 % with 1 worker on 4 cores. That is thin for a provisional timing. On one real core it is over the line: 46 minutes. With 4 workers on 4 cores it is 21 minutes.
- The TypeScript side carries it: 403 rules at 4.05 s are 27 of the 28 minutes. The 4.05 s is 26 checks of a study prototype, each a whole simulated cluster. Slice 1's real L2 tests may cost more or less.
- One process per rule matters. With one process per check, starting Node 27 times costs 8 s per rule, and the split is 69 minutes.
- Two more cuts are measured and not used in the reading. Stopping a rule at its first red test brings "Raft, everything" from 11.71 s to 1.90 s per rule. Running only the tests that reach the rule's marker brings "TypeScript, everything" from 50.9 s to 35.2 s. The first loses the full list of red tests for a proven rule.

## The marker's cost

**Rust: none in a release build** *(checked)*. The unmarked port and the marked port were built at one path, with the same manifests and no `switch` feature. Then the two programs were compared section by section.

| Section | `raft-datadriven` | `raft-diff` |
|---|---|---|
| The code (`.text`) | 671,155 bytes, 0 differ | 617,459 bytes, 0 differ |
| The constants (`.rodata`) | 42,240 bytes, 0 differ | 41,024 bytes, 0 differ |
| The unwind tables (`.eh_frame`) | 60,728 bytes, 0 differ | 57,604 bytes, 0 differ |
| Relocated data (`.data.rel.ro`) | 16,600 bytes, 62 differ | 16,096 bytes, 62 differ |

- **Against the port with no marker crate at all** *(checked, a second run)*: the port was also built at the same path with its own manifest, with no `rule` dependency. Then the bytes of `.text` differ in place (42,413 of 671,155), though the size is the same. The functions are laid out in another order, because the manifest changes the crate's hash. Function by function it is the same code: both programs have the same list of functions with the same sizes (1,241 and 1,192 functions), the same count of instructions (164,659 and 152,001) and the same count of each instruction kind.
- The 62 bytes are the line and column numbers that a panic message names. The markers moved the lines *(reasoned from where the bytes sit: 24 bytes apart, the size of one source location)*.
- The marked port also builds for WASM, with no standard library *(checked)*.
- The marked port passes the workspace's strict lints and `cargo fmt --check`, with the switch and without *(checked)*.

**TypeScript: about half a nanosecond per marker in a hot loop** *(measured, provisional)*. [bench.ts](bench.ts) runs a small loop bare and with three markers, 20 million passes, best of 7 rounds, three runs.

| | ns per pass |
|---|---:|
| The bare loop | 0.88 to 0.97 |
| The loop with three markers | 2.38 to 2.60 |
| **One marker, more than the bare block** | **0.47 to 0.57** |
| One marker, in a test run with another rule off | 0.96 to 1.06 |

- This is the cost after the engine has inlined the marker and its closure. It is the right number for a hot path *(reasoned)*. A cold path pays a real call and a closure, and does not matter.
- The loop is tiny, so the marker shows as 2.5 times the loop. Against real work per call (a map lookup is tens of nanoseconds) it is small *(reasoned)*.

## What the pass proves

**Raft: 58 of the 62 marked rules are proven** *(measured)*. That is 93.5 %. BUILD's gate for T4 is 85 %.

- By kind: 54 of the 56 switches, and 4 of the 6 fields.
- **Unproven, 4:**
  - `raft-snapshot.2` and `raft-snapshot.3`: no test reaches them. The code is the in-memory store's "make a snapshot", which no file and no script calls.
  - `raft-snapshot.9`: tests reach it and stay green. Dropping the whole log where it could be kept changes nothing a test prints.
  - `raft-term-vote.3`: equal by construction. The harness pins the random part of the timeout to 0, so off and on are the same program.
- **Caught by one test only:** `raft-commit.6` and `raft-snapshot.7` are caught only by the edge value check. Eight rules are caught only by the random scripts, never by the 41 files: `raft-config.2`, `.5`, `.6`, `.8`, `.11`, `raft-leader-transfer.5`, `.6` and `raft-readindex.1`.
- **Caught by the timeout:** `raft-log.4`, `raft-log.6` and `raft-term-vote.6` make some script runs loop. Each is also caught by a plain failure in another test.

**Beside the mutation run** ([RESULTS.md](../../crates/raft-harness/mutate/RESULTS.md)).

| | Switch-off pass | Mutation run |
|---|---|---|
| What is changed | One whole rule, off | One operator or one line |
| How many | 62 | 836 |
| One build per change | No: one build, 62 runs | Yes: 836 builds |
| Machine time | 12 minutes with 1 worker for everything | About 45 minutes on 4 cores |
| Caught by the 41 files | 37 of 62 (59.7 %) | 530 of 836 (63.4 %) |
| Caught by files and scripts | 56 of 62 (90.3 %) | 632 of 836 (75.6 %) |

- **The same holes show** *(checked)*. The mutation run listed "make a snapshot" as never used, and the edges of restoring a snapshot as a gap. The pass finds the same three rules unproven.
- **One hole is closed.** The mutation run's best-known survivor was the rule "a leader counts only entries of its own term". Here it is `raft-commit.6`, and it is caught, by the edge value check alone. That check was written after the mutation run.
- **The pass is coarser.** A whole rule off is a big change, so it is caught more often than a one-operator change. A proven rule is not a rule whose every edge is tested. The mutation run stays the finer net, as BUILD 2.6 says.

**TypeScript: 5 of the 9 marked rules are proven** *(measured)*. That is 56 %, under the 85 % gate. The prototype's checks were written to check patterns, not rules.

- `leader-code.1` and `shape-rule.1`: no check reaches them.
- `field-guards.1` and `judging-state.1`: checks reach them and stay green.

## The rules, one by one

In the last column a number in brackets is how many files, scripts or test functions failed. "harness tests" are the harness's own `cargo test` programs. The runs are the full suites.

### Raft

| Rule | Kind | Why | Tests that go red |
|---|---|---|---|
| `learners.1` | oracle | Held by absence: the commit count walks the voter set, and a learner is not in it. No line says "skip learners" | (not run: no marker) |
| `learners.2` | oracle | Held by absence: the send loop walks every tracked copy and has no filter for learners | (not run: no marker) |
| `learners.3` | not in the port | fero's own rule; etcd does not check it. When built it is a guard, so a switch (reasoned) | (not run: no marker) |
| `raft-commit.1` | switch (block) | `reset`: the loop that sets each follower's progress. Off: the old progress stays | files (11); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-commit.2` | switch (guard) | `step`: the stale-term gate, for an append ack. Off: an ack from an older term is counted | harness tests: diff; scripts: seed2 (442), seed3 (444), seed5 (408), seed7 (355) |
| `raft-commit.3` | switch (block) | `Progress::maybe_update`: the line that raises the match index. Off: it never rises | files (27); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-commit.4` | oracle | An order held by the message path: the leader's own ack is a message that comes back after the write. Switching it off needs new code, not a skipped block | (not run: no marker) |
| `raft-commit.5` | switch (value) | `MajorityConfig::committed_index`: the position of the majority in the sorted acks. Off: the highest ack of any voter | files (17); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-commit.6` | switch (guard) | `RaftLog::maybe_commit`: the term match. Off: an entry of an older term is counted | harness tests: edge_values (3) |
| `raft-commit.7` | switch (value) | `send_heartbeat`: the smaller of match and commit. Off: the plain commit index | files (5); harness tests: datadriven, edge_values; scripts: seed2 (75), seed3 (94), seed5 (176), seed7 (104) |
| `raft-commit.8` | switch (value) | `maybe_append`: the smaller of the leader's commit and the last new entry. Off: the leader's commit | harness tests: unit-raft, edge_values (2); scripts: seed2 (13), seed3 (9), seed5 (11), seed7 (5) |
| `raft-config.1` | oracle | Held by a type: the vote count walks the voter set of the configuration. No block to skip | (not run: no marker) |
| `raft-config.2` | switch (block) | `become_leader`: the line that sets the pending-change mark. Off: it stays 0 | scripts: seed2, seed3 (2) |
| `raft-config.3` | switch (guard) | `become_leader`: the empty entry. Off: none is appended | files (27); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-config.4` | oracle | Held by absence: only the leader's step has code that appends. A follower forwards, a candidate drops | (not run: no marker) |
| `raft-config.5` | switch (guard) | `step_leader`: the pending-change test. Off: a second change is taken at once | scripts: seed2 (156), seed3 (139), seed5 (147), seed7 (102) |
| `raft-config.6` | switch (guard) | The same test as raft-config.5 (the mark is compared with the applied index). One block, two ids | scripts: seed2 (156), seed3 (139), seed5 (147), seed7 (102) |
| `raft-config.7` | oracle | Held by a type: a change is an entry of the conf-change type | (not run: no marker) |
| `raft-config.8` | switch (block) | `step_leader`: the line that sets the mark on a proposal. Off: not set | scripts: seed2 (170), seed3 (143), seed5 (161), seed7 (110) |
| `raft-config.9` | switch (block) | `switch_to_config`: the two lines that put the new configuration in force. Off: the old one stays | files (28); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-config.10` | switch (guard) | `switch_to_config`: step down when removed. Off: the leader stays | files (2); harness tests: datadriven; scripts: seed2 (23), seed3 (15), seed5 (25), seed7 (18) |
| `raft-config.11` | switch (guard) | `hup`: the unapplied-change test. Off: it stands anyway | scripts: seed2 (34), seed3 (37), seed5 (36), seed7 (17) |
| `raft-config.12` | switch (guard) | `promotable`: not a learner, and in the configuration. Off: anyone may stand | files (3); harness tests: datadriven; scripts: seed2 (66), seed3 (46), seed5 (53), seed7 (38) |
| `raft-config.13` | oracle | An order held by the interface: a configuration changes only through `apply_conf_change`, which the host calls for a committed entry | (not run: no marker) |
| `raft-config.14` | oracle | Held by absence: the vote code has no test for a learner | (not run: no marker) |
| `raft-config.15` | not in the port | fero's own rule (placement). Not sorted | (not run: no marker) |
| `raft-leader-transfer.1` | switch (guard) | `step_leader`: a write during a transfer. Off: it is taken | harness tests: diff, edge_values; scripts: seed2 (331), seed3 (348), seed5 (321), seed7 (237) |
| `raft-leader-transfer.2` | switch (value) | `step_leader`: the refusal that is returned. Off: the write is dropped with no word. The target's name is fero's own part and is not in the port | harness tests: diff, edge_values; scripts: seed2 (331), seed3 (348), seed5 (321), seed7 (237) |
| `raft-leader-transfer.3` | switch (guard) | `step_leader`, two places: the target holds the whole log. Off: TimeoutNow goes out at once | harness tests: diff, edge_values (2); scripts: seed2 (306), seed3 (316), seed5 (295), seed7 (212) |
| `raft-leader-transfer.4` | switch (block) | `step_follower`: stand on TimeoutNow. Off: the message is ignored | files; harness tests: datadriven, diff, edge_values (2); scripts: seed2 (273), seed3 (269), seed5 (273), seed7 (216) |
| `raft-leader-transfer.5` | switch (guard) | `step`: a transfer's vote request passes the lease. Off: it is treated as any other | scripts: seed2 (130), seed3 (119), seed5 (120), seed7 (88) |
| `raft-leader-transfer.6` | switch (guard) | `tick_heartbeat`: give the transfer up after an election timeout. Off: never | scripts: seed2 (38), seed3 (40), seed5 (30), seed7 (22) |
| `raft-log.1` | oracle | Held by absence: only the leader's step has code that appends | (not run: no marker) |
| `raft-log.2` | field | `append_entry`: the line that stamps the term on a new entry. Off: no term | files (27); harness tests: datadriven, diff, edge_values; scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-log.3` | field | `maybe_send_append`: the two fields of the append message. Off: both empty | files (26); harness tests: datadriven, diff; scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-log.4` | switch (guard) | `step`: the stale-term gate, for an append or a snapshot. Off: it is taken | harness tests: diff, edge_values; scripts: seed2 (546), seed3 (cut by the timeout), seed5 (520), seed7 (427) |
| `raft-log.5` | switch (guard) | `maybe_append`: the match test on the entry before. Off: always a match | files (11); harness tests: unit-raft, datadriven, edge_values (2); scripts: seed2 (274), seed3 (290), seed5 (267), seed7 (224) |
| `raft-log.6` | switch (block) | `Unstable::truncate_and_append` and `MemoryStorage::append`: the cut. Off: nothing is cut | files (2); harness tests: datadriven; scripts: seed2 (cut by the timeout), seed3 (cut by the timeout), seed5 (cut by the timeout), seed7 (cut by the timeout) |
| `raft-log.7` | switch (value) | `maybe_append`: the first index that differs. Off: the first entry of the message, so everything is written again | files (2); harness tests: datadriven; scripts: seed2 (236), seed3 (260), seed5 (272), seed7 (217) |
| `raft-log.8` | switch (guard) | `send`: an append ack to another node waits for the write. Off: it goes out at once | files (2); harness tests: datadriven, diff; scripts: seed2 (751), seed3 (719), seed5 (807), seed7 (736) |
| `raft-log.9` | field | `handle_append_entries`: the index field of the ack. Off: empty | files (23); harness tests: datadriven, diff; scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-log.10` | switch (guard) | `step_leader`: step back after a refusal. Off: the refusal is ignored | files (11); harness tests: datadriven, edge_values (2); scripts: seed2 (265), seed3 (266), seed5 (253), seed7 (214) |
| `raft-prevote-checkquorum.1` | switch (guard) | `step`: stand with a pre-vote first. Off: a plain election | files (3); harness tests: datadriven, diff; scripts: seed2 (490), seed3 (472), seed5 (498), seed7 (500) |
| `raft-prevote-checkquorum.2` | switch (guard) | `step`: record a vote only for a real vote. Off: a pre-vote records one too | files (3); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (490), seed3 (472), seed5 (498), seed7 (500) |
| `raft-prevote-checkquorum.3` | switch (guard) | `step`: the lease test. Off: a vote request is never ignored | files (3); harness tests: datadriven; scripts: seed2 (458), seed3 (470), seed5 (469), seed7 (425) |
| `raft-prevote-checkquorum.4` | switch (value) | `step_candidate`: the count of pre-votes. Off: a pre-candidate has won at the first reply | files (3); harness tests: datadriven, diff; scripts: seed2 (490), seed3 (472), seed5 (498), seed7 (500) |
| `raft-prevote-checkquorum.5` | switch (block) | `step_leader`, two places: note the follower as heard. Off: not noted | files (8); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (523), seed3 (537), seed5 (537), seed7 (473) |
| `raft-prevote-checkquorum.6` | switch (guard) | `step_leader`: step down with no majority heard. Off: never | files; harness tests: datadriven; scripts: seed2 (33), seed3 (36), seed5 (44), seed7 (28) |
| `raft-prevote-checkquorum.7` | not in the port | fero's own rule (link pings). When built it is a block, so a switch (reasoned) | (not run: no marker) |
| `raft-readindex.1` | switch (guard) | `step_leader`: wait for an entry of the own term. Off: answer at once | scripts: seed5, seed7 (4) |
| `raft-readindex.2` | field | `send_msg_read_index_response`: the commit index kept with the read. Off: 0 | harness tests: diff; scripts: seed5 (519), seed7 (389) |
| `raft-readindex.3` | switch (value) | `send_msg_read_index_response`: the mode. Off: the lease mode, which answers with no round | harness tests: diff, edge_values (2); scripts: seed5 (707), seed7 (543) |
| `raft-readindex.4` | not in the port | The host's duty (the fold). The port only hands the read index out. When built it is a guard, so a switch (reasoned) | (not run: no marker) |
| `raft-snapshot.1` | not in the port | The host's duty (the journal cuts the snapshot). When built it is a guard, so a switch (reasoned) | (not run: no marker) |
| `raft-snapshot.2` | field | `MemoryStorage::create_snapshot`: the index and term fields. Off: not set | **unproven**: no test reaches it |
| `raft-snapshot.3` | field | `MemoryStorage::create_snapshot`: the configuration field. Off: not set | **unproven**: no test reaches it |
| `raft-snapshot.4` | not in the port | The host's duty (the journal). An order of two writes, so an oracle (reasoned) | (not run: no marker) |
| `raft-snapshot.5` | not in the port | The host's duty (the journal). When built it is a guard, so a switch (reasoned) | (not run: no marker) |
| `raft-snapshot.6` | switch (value) | `maybe_send_append`, two places: send a snapshot. Off: nothing is sent | files (10); harness tests: datadriven, edge_values (3) |
| `raft-snapshot.7` | switch (guard) | `restore`: at or below the commit index. Off: it is used | harness tests: edge_values (2) |
| `raft-snapshot.8` | not in the port | The host's duty (the link and the journal). An order, so an oracle (reasoned) | (not run: no marker) |
| `raft-snapshot.9` | switch (guard) | `restore`: the log holds the last entry. Off: the whole log is dropped every time | **unproven**: reached, every test green |
| `raft-snapshot.10` | switch (block) | `restore`: reset the log from the snapshot. Off: the log is left | files (10); harness tests: datadriven, edge_values (2) |
| `raft-term-vote.1` | switch (guard) | `send`: a vote reply waits for the write. Off: it goes out at once. The candidate's own requests are the host's duty | files (2); harness tests: datadriven, diff; scripts: seed2 (605), seed3 (616), seed5 (635), seed7 (592) |
| `raft-term-vote.2` | switch (guard) | `tick_election`: the timer ran out. Off: never | files; harness tests: datadriven, diff; scripts: seed2 (817), seed3 (830), seed5 (815), seed7 (842) |
| `raft-term-vote.3` | switch (value) | `reset_randomized_election_timeout`: the random part. Off: 0 | **unproven**: reached, every test green |
| `raft-term-vote.4` | switch (value) | `become_candidate`: term plus one. Off: the same term | files (28); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.5` | switch (block) | `become_candidate`: vote for itself. Off: no vote | files (21); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.6` | switch (block) | `reset` and `become_pre_candidate`: clear the tally. Off: kept | files (4); harness tests: datadriven, diff, edge_values; scripts: seed2 (711), seed3 (cut by the timeout), seed5 (705), seed7 (657) |
| `raft-term-vote.7` | switch (guard) | `step`: the stale-term gate, for a vote request. Off: it is judged | harness tests: edge_values; scripts: seed2 (172), seed3 (188), seed5 (183), seed7 (168) |
| `raft-term-vote.8` | switch (guard) | `step`: has not voted, or voted for the same one. Off: always free to vote | harness tests: diff, edge_values (2); scripts: seed2 (321), seed3 (344), seed5 (313), seed7 (370) |
| `raft-term-vote.9` | switch (guard) | `step`: the candidate's log is up to date. Off: any log | files (4); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (563), seed3 (568), seed5 (557), seed7 (485) |
| `raft-term-vote.10` | switch (block) | `step`: record the vote. Off: not recorded | files (15); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.11` | switch (guard) | `step`: the stale-term gate, for a vote reply. Off: it is counted | harness tests: edge_values; scripts: seed2 (214), seed3 (218), seed5 (215), seed7 (232) |
| `raft-term-vote.12` | switch (block) | `poll`: add the vote to the tally. Off: not added | files (28); harness tests: datadriven, diff, edge_values (3); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.13` | oracle | Held by absence: a follower's step has no arm for a vote reply | (not run: no marker) |
| `raft-term-vote.14` | switch (value) | `step`: the term to take. Off: the own term | files (25); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.15` | switch (value) | `step`: become a follower. Off: only take the term | files (17); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (1000), seed3 (1000), seed5 (1000), seed7 (1000) |
| `raft-term-vote.16` | switch (block) | `reset`: clear the vote. Off: kept | files (8); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (726), seed3 (749), seed5 (713), seed7 (773) |
| `raft-term-vote.17` | switch (block) | `step_candidate`, three places: become the leader's follower. Off: stay a candidate | files (2); harness tests: datadriven, diff, edge_values (2); scripts: seed2 (446), seed3 (432), seed5 (461), seed7 (385) |

### TypeScript (the API prototype, `proto/l2.ts`)

| Rule | Kind | Why | Tests that go red |
|---|---|---|---|
| `client-sessions.3` | switch (guard) | `handle`: look the attempt up among the outcomes. Off: never found, so it is applied again | core: core-exactly-once, core-reader, p14; patterns: p02, p05, p07, p08, p11, p15, p16, p17, p20 |
| `fence-tokens.1` | switch (guard) | `#cond`: the token is below the highest seen. Off: never | core: core-features; patterns: p08, p10 |
| `field-guards.1` | switch (guard) | `#cond`: equals, on the field's value. Off: always passes | **unproven**: reached, every test green |
| `fold-all.1` | oracle | An order held by the log's index and one fold loop. No block to skip | (not run: no marker) |
| `judged-writes.1` | switch (guard) | `#judgeWrites`: test the condition. Off: no condition fails | core: core-features; patterns: cts, p04, p08, p09, p10 |
| `judging-state.1` | field | `dump`: the outcomes and the fence table in the snapshot. Off: both empty | **unproven**: reached, every test green |
| `leader-code.1` | switch (guard) | `handle`: a rule that throws becomes a refusal. Off: the error goes up | **unproven**: no test reaches it |
| `presence-rows.4` | field | `#judgeWrites`: the session id on the row. Off: not set | core: core-features; patterns: p08, p13, p17 |
| `row-version.1` | field | `apply`: the version of the last write. Off: the old version stays | core: core-features; patterns: cts, p08, p09, p17 (cut by the timeout), p22 |
| `shape-rule.1` | switch (guard) | `#judgeWrites`: a missing parent field. Off: never refused | **unproven**: no test reaches it |

## How to run it again

From the repo root. `WORK` is a scratch folder; nothing is written into the repo.

    node tools/rule-scan.mjs                           # the repo's own markers; ends "ok rule-scan: ..."
    cargo test --release -p rule                       # the marker, a normal build
    cargo test --release -p rule --features switch     # the marker, switching
    WORK=<scratch dir> sh probes/p6/run.sh marked      # the marked copy of the Raft port, built both ways
    WORK=<scratch dir> sh probes/p6/run.sh bytes       # the machine code check; ends "ok bytes: ..."
    WORK=<scratch dir> CORPUS=<the diff work dir> sh probes/p6/run.sh raft         # the pass, everything
    WORK=<scratch dir> CORPUS=<the diff work dir> sh probes/p6/run.sh raft-short   # the pass, short runs
    WORK=<scratch dir> E22=<the API prototype folder> DATA=<data checkout> sh probes/p6/run.sh ts
    WORK=<scratch dir> E22=<the API prototype folder> DATA=<data checkout> sh probes/p6/run.sh ts-short
    WORK=<scratch dir> DATA=<data checkout> sh probes/p6/run.sh ts-one             # after ts or ts-short
    WORK=<scratch dir> sh probes/p6/run.sh bench       # the TypeScript marker's cost
    node probes/p6/pass.mjs report <scratch dir>/raft-pass-j1.jsonl --rules probes/p6/rules.json --md

- `CORPUS` is the folder that `crates/raft-harness/diff/run_diff.sh corpus` fills: `seed2`, `seed3`, `seed5` and `seed7`, each with `in/` and `out/`.
- `E22` is the folder `docs/v5-space/experiments/E22-api-prototype` on the `design` branch. `DATA` is `data` at commit `63fea66`, the one that experiment used.
- `JOBS=4` runs four rules at a time. `TIMING=<a lock wrapper>` is put in front of each timed run.
- The scan reads a marked copy when it is given the path: `node tools/rule-scan.mjs <scratch dir>/marked/crates`. Without a path it reads only the repo, so it never sees a throwaway copy.
- Each pass ends `ok pass: ...`. It stops at the start if a test is red with no rule off.

## What is not checked

- **The time bars.** Every time on this page is provisional. The 30-minute line needs the quiet machine and the real suites.
- **The 640.** The projection takes two per-rule costs and one split. Raft's cost stands in for every Rust rule, and a study prototype's for every TypeScript rule. fero's own kernel rules will be tested by the simulator, which this probe did not run.
- **The TypeScript sample is ten rules, nine with a marker.** One slow rule moves its mean from 2 s to 4 s. The share of 60 % or 90 % rests on ten rules.
- **A second reading of the sorting** *(checked by reading all 80 Raft rules and the ten TypeScript ones against the marked code)* found no oracle that is a block, and no switch that cannot be switched. It found these soft spots:
  - `raft-config.5` and `raft-config.6` are one expression with two markers. Off, they are the same program, and the pass gives the same red tests for both. Only one of the two is a switch of its own. That takes the strict share to 55 of 72 (76.4 %) and the wide one to 61 of 72 (84.7 %).
  - Six rules are switched by code that the marker adds, not by a block that is skipped: the marked body is the plain word `true`, and the `off` arm tests the kind of message (`raft-commit.2`, `raft-log.4`, `raft-log.8`, `raft-term-vote.1`, `.7`, `.11`). They do switch, one at a time. But they are not "a macro around the block". Without them the strict share is 50 of 72 (69.4 %).
  - `raft-readindex.2` is sorted as a field. It could as well be a value, like `raft-commit.7`. `row-version.1` could be a block.
  - Two kinds are named loosely: `raft-config.3` and `raft-snapshot.6` are blocks (a call that is skipped), not a guard and a value. The share does not move.
- **The sorting is one reader's.** A second reader could move a rule between "value", "field" and "oracle". The line between a value the rule shapes and a field it carries is a judgment. Four more switches lift the strict share over 80 %. Six fewer drop the wide share under it.
- **A proven rule is proven coarsely.** A whole rule off is caught more easily than one wrong edge. Eight of the rules share a block with another rule, so one test may be proving two ids.
- **Some `off` values are a choice.** For `raft-term-vote.15` the off arm calls another function of the port. For `raft-log.7` it writes every entry again. Another honest choice could turn other tests red.
- **Rules caught by a crash.** A test that stops with a panic counts as red. The pass does not say whether the panic is the rule's own check or a later knock-on.
- **The marker in WASM, switched.** The marked port builds for WASM with no switch. The marker crate's `switch` feature builds for WASM too *(checked)*, but no test was run there.
- **The TypeScript marker under the type checker.** The marked prototype runs with Node's type stripping. `tsc --strict` was not run on it.
- **One process for the whole pass.** The switch is a number that can be set while the program runs, so one process could walk all rules. The pass starts a process per test, which is simpler and safe against state left behind. The faster way was not tried.
- **The scan reads source text by hand, not with a parser.** It walks comments, strings, Rust raw strings and TypeScript regular-expression literals. A second reading found, and fixed, four ways it went wrong: a Rust raw string with a quote inside hid a marker later on the line; a marker that was only text in a string was counted; a regular-expression literal with a quote in it made a commented marker count; `x.rule('id', ...)` on some other object was counted. Other odd source text may still fool it. A marker it wrongly finds fails loudly (an unknown id). A marker it misses is silent.
- **The second net.** BUILD 2.6's mechanical changes to lines outside every marker are not part of this probe.

## What this means for the build (reasoned)

- **The markers can live under the kernel's rules.** The marker crate has no standard library, no outside crate and no `unsafe`, and a marked crate keeps byte-equal code.
- **A check in the harness must learn the marker crate.** The test "raft has no outside crates" failed on the marked copy, because it reads any dependency as an outside one. The patch teaches it that `rule` is in the workspace. fero's own kernel crates will need the same line.
- **The pass needs short tests per rule.** The budget is 2.8 seconds of one core per rule. The cheap way to keep it: one process per rule, a few seeds, and the full suites only for a touched rule.
- **A timeout should follow the green time.** A looping run was cut at 30 s, for a test that takes 1 s when green. Six such cuts were half of the scripts' cost.
- **The ledger's `proof` and `tests` fields can be filled by the pass.** Its report names, per rule, the tests that went red. Nothing here writes the ledger yet.

## The clock

On 2026-11-24, in the cloud, on one box with 4 cores shared by two jobs *(measured by time stamps)*: about 1 hour 20 minutes from the start to this page (13:34 to 14:55 UTC). About 37 minutes of it were timed runs under the lock: 12 and 4 minutes for Raft's full pass at 1 and 4 workers, 8 and 5 for TypeScript's, 2 for the files-and-scripts run, and 6 for the short runs and the bench.
