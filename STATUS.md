# Status

The one ledger for v5: where things stand, what is next, the open bugs and the decisions made on this branch.

## Where things stand

- **2026-11-24: the branch starts.** Nothing is built. The design is settled in V5-1 to V5-24 on the [`design`](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md) branch. The way of working is [BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md): deep first, then wide; a rule ledger tools can read; a map drawn from it; nine gates that bring a decision to the owner.
- **2026-11-24: the first spec pages are in** ([spec/](spec/README.md)). The ledger holds 826 rules: 773 for fero's six layers and 53 for `data` 5, against the plan's top guess of 640 for fero. `node tools/ledger-gate.mjs` checks it; `node tools/grid.mjs` prints the map. The byte shapes are a draft with 30 open questions.
- **2026-11-24: slice 0, probes P1 and P5 ran; neither was killed** ([the sheet](probes/README.md)). P1: etcd's Raft is ported to Rust ([crates/raft](crates/raft/README.md)); all 41 of etcd's test files and 4,000 of 4,000 random scripts equal Go byte for byte, 48 minutes after the start against a line of 10 working days. Its mutant score is about 72.7 % by the files and 86.6 % with the scripts, 1 to 3 points under the TypeScript port's, inside the error. P5: one number per stream passes every complete model run; it saves 7 to 13 ledger rules, or 2 to 5 on the study's finer count, against a line of 3. Four questions wait on the owner (the sheet's list).
- **2026-11-24: slice 0, probes P2 and P6 ran** ([the sheet](probes/README.md)). P2 passed: the simulator ([crates/sim](crates/sim/README.md), built native and as [WASM](crates/wasm/README.md)) runs 200 full-stack seeds, with `data` 4 folding every committed batch, in 287 ms against 1 s; a fresh world takes 0.21 ms at p99 against 5 ms; the two builds give the same bytes on 1,000 of 1,000 seeds (timing provisional, on a shared box). P6 is open on both lines: the rule marker ([crates/rule](crates/rule/src/lib.rs)) costs nothing in a release build, but 75.6 % of the rules can be a switch by BUILD's own list (line 80 %), 86.6 % if a carried field counts; the nightly pass fits 30 minutes only as short runs on several cores. Three more questions go to the owner.

## Next

1. **Slice 0, ground** (BUILD 3.3): seven probes, each with a kill line, timed first on the owner's laptop (V5-24 item 3); the relative pins on every change. Done and passed: P1, P2, P5, P6 (V5-28 to V5-32). P3, P4 and P7 wait for the laptop: they need real timing.
2. **Slice 1's ledger review** before its code starts: the five Raft records P6 found the port does not hold because they are the host's duty (`raft-readindex.4`, `raft-snapshot.1`, `.4`, `.5`, `.8`), and `raft-config.5` and `.6`, which share one expression in the port.

## Open bugs

- **raft: a plain `u64` sum may still panic where Go wraps.** The port keeps overflow checks on; Go's sums wrap. The edge check (`crates/raft-harness/tests/edge_values.rs`) found and fixed the sites one node and four messages deep reach; longer paths are not checked *(reasoned)*. Closed when slice 1 builds `links.7`, which refuses such numbers at the wire (V5-29).
- **raft: some rules have no test that fails without them.** The mutation run ([RESULTS.md](crates/raft-harness/mutate/RESULTS.md)) leaves about 100 live mutants; `maybe_commit` without its term check survived the files and the scripts, as it did in the TypeScript port; since then the edge value check catches it (P6's pass, `raft-commit.6`). P6's pass leaves 4 of 62 marked Raft rules unproven (`raft-snapshot.2`, `.3`, `.9`, `raft-term-vote.3`). Go's unit tests, not ported, would close most *(reasoned)*.

## Decisions on this branch

V5-1 to V5-24 are on the `design` branch. Decisions made from here on are appended to [docs/DECISIONS.md](docs/DECISIONS.md), from V5-25.

- **V5-25** (2026-11-24): the rule budget is the ledger's record count, 826 (773 for fero, 53 for `data` 5), with 5 % of headroom on any layer, slice or the whole; past that, a card. Card 0001, answered A.
- **V5-26** (2026-11-24): the MUSTs the first build does not reach (P-06's `none` rung and PERF-03, P-18, TEST-06, OPS-07, F-18, OPS-13) are restated as after it, each with its reason; F-12's recover command is built in slice 2 (`recover.1` to `recover.3`). The ledger is 829 records.
- **V5-27** (2026-11-24): servers run on Linux from slice 1; macOS and Windows servers come in slice 7.
- **V5-28** (2026-11-25): P1 passes; the Rust port's mutant score (about 72.7 % and 86.6 %) is inside the error of the TypeScript port's (about 74 % and 89 %). The holes stay an open issue, not a block.
- **V5-29** (2026-11-25): a peer's frame with a Raft term, index or commit at or above 2^62 does not decode (`links.7`, slice 1); the Raft crate keeps its overflow checks. The ledger is 830 records.
- **V5-30** (2026-11-25): P5 passes on the ledger's count; its early failed run was the model's setup. One number per stream replaces the marks: 18 records retired, `stream-numbers.1` to `.11` added, 46 rules become 39. The ledger is 823 records.
- **V5-31** (2026-11-25): P2 passes; TEST-01's fresh world is read at p99 of warm worlds, with the largest and the cold first world recorded, not judged. The simulator stays in Rust, native and WASM.
- **V5-32** (2026-11-25): P6 passes. The nightly pass is short runs on a machine with several cores; a rule is a switch when its marker turns it off alone, a carried field the marker can blank included (BUILD 2.6's list amended). Share 85.4 %; time 21 to 28 minutes, provisional.
