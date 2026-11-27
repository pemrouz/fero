# Decisions

Append-only: a later decision supersedes an earlier one by name; nothing is deleted.

V5-1 to V5-24, the design study's decisions, are on the `design` branch: [docs/DECISIONS.md](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md). The ones that set up this branch are [V5-23](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md#v5-23--rust-from-the-start-below-the-fold-no-move-from-v4-a-first-build-in-ordered-slices-a-quiet-machine-for-timing-and-a-short-spec-to-steer-by-2026-11-24-readymd-section-5-asked-one-at-a-time) (Rust from the start, ordered slices, a quiet machine, a short spec) and [V5-24](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md#v5-24--how-the-build-is-steered-its-order-what-it-is-timed-on-and-where-v5-starts-2026-11-24-buildmd-section-62-asked-one-at-a-time) (steering, the order of slices, timing, this branch).

Decisions made while building start at V5-25 below.

## V5-25 — The rule budget is the ledger's own count, with 5 % of headroom on any line (2026-11-24; spec/cards/0001-budget.md, asked as one card)

Context: the first spec pages (V5-23 item 7) wrote every first-build rule as one record in `spec/ledger.json`: 826 records, 773 for fero's six layers and 53 for `data` 5. The two older guesses were smaller: LAYERS 0.2 said 500 to 592 for fero and BUILD 3.4 and 3.5 said 501 to 640, and neither counted `data`. The gap is mostly the surface's promises, never listed one by one before (L4, +71), the libraries' promises (L5, +41), and items the older sums left out (L0 to L3, +69). 37 base rules wait for after the first build, the other way. 168 records may hide more than one rule; if all split, the ledger reaches 1,012. Card 0001 asked the owner to pick the budget, the most records each layer, each slice and the whole may hold before a change comes to them.

Decision:
1. The budget is the ledger's record count today. Layers: L0 86, L1 218, L2 106, L3 146, L4 107, L5 110, D 53. Slices: S0 0, S1 257, S2 132, S3 54, S4 145, S5 78, S6 84, S7 22, S8 54. The whole: 826.
2. Any line, a layer, a slice or the whole, may hold its number plus 5 %, rounded down (the whole at most 867). Past that the ledger gate fails, and the change waits for an owner's card.
3. A new record, or a record that splits because its sentence hid two rules, is a counted change and shows in the weekly digest. The gate refuses a record of more than one sentence, so the budget cannot be met by packing rules together.
4. The budget is on the margins only. No cell of the grid, one layer in one slice, has a budget of its own.
5. `spec/budget.json` is marked accepted by card 0001; the card keeps a copy of the numbers as one line and the gate checks the two agree.

REJECTED: a budget on the high count, 1,012 with no headroom (it holds room for every unsure sentence to split, 186 rules over today, so growth reaches no card until late); holding BUILD's 640 for fero (at least 133 rules out before slice 0, most likely whole features moved past the first build, one to two weeks); leaving the budget open (no number to measure later cards against, and slice 0 would not start); a budget on the low count (after the recount, low is 0 on only 9 records, so it is no second size).

Consequences: the first build is accepted as about 21 % larger than BUILD's top guess for fero (773 against 640), and up to 46 % larger if every unsure sentence splits. BUILD's sizes in weeks were guessed from the smaller count, so they are likely low too *(reasoned)*. Slice 0 may start once the MUSTs the first build does not reach are settled (spec/NOTES.md, question A), since that pick changes bars.

## V5-26 — The MUSTs the first build does not reach are restated as after it; the recover command is built in slice 2 (2026-11-24; spec/NOTES.md question A, asked one at a time)

Context: the first spec pages left some of REQUIREMENTS' MUSTs with no slice, because the mechanism each needs waits until after the first build. P-06 requires a `none` rung of pub/sub (no disk, best effort), and PERF-03, the race against NATS core, is judged on it; the rung waits with relays. P-18 and TEST-06 need forks, and OPS-07 needs restore; both wait with the object-store tier (BUILD 3.5). F-18 needs a slow leader to give up the lead by itself; that rule was never built or modelled, and slice 2's watchdog catches only a stuck main thread *(reasoned)*. OPS-13 (erase) has no rule on any page. F-12, the operator's command after a group loses its majority, had four rules in the ledger but no slice that builds the command. A bar changes only through the owner.

Decision:
1. P-06's `none` rung with PERF-03, P-18, TEST-06, OPS-07, F-18 and OPS-13 are restated as "after the first build". Each keeps its reason on the system page and in the notes, so no bar is dropped without being said. They stay MUSTs for the release that follows.
2. F-12 is met in the first build. The operator's recover command is built in slice 2, where groups heal, and slice 2 pins F-12. Three rules hold it: it lists the writes that may be lost before it changes anything (`recover.1`), it refuses while any voter it would drop still answers (`recover.2`), and it restarts the group on the copies that answer, from the longest log any of them holds, as a new config (`recover.3`). The raised incarnation (`meta-directory.2`) and the refusal of stale cursors (`subscribe.35`) were already rules.

REJECTED: restating F-12 too (a group that loses most of its servers would stay stuck until someone edits files by hand); bringing the `none` rung and the slow-leader rule back into a slice (about 7 to 20 more rules, past the 5 % headroom on some lines, so a budget card would follow); keeping all the bars as MUSTs unchanged (the first build would end with them knowingly unmet and red on the map).

Consequences: the ledger grows by three records, to 829 (L1 221, slice 2 135), inside V5-25's headroom. How the command compares the answering copies' logs, and how it shows what may be lost, are settled at the start of slice 2. With V5-25 and V5-26 answered, slice 0 may start.

## V5-27 — Servers run on Linux first; macOS and Windows servers come in slice 7 (2026-11-24; spec/NOTES.md question 35, asked one at a time)

Context: the design record names no server platform. The Rust core touches the disk (fsync) and sockets directly, and both behave differently on Linux, macOS and Windows, so each platform adds tests and speed pins to keep green. Clients (the browser and Node) are not affected. V5-24 item 3 times the absolute bars on dedicated Linux machines from slice 1, and the owner's laptop runs slice 0's probes as provisional.

Decision:
1. fero's servers target Linux from slice 1. The tests, the pins and the absolute bars run there.
2. macOS and Windows servers come in slice 7, with the tools, the prebuilt binaries and the rival runs.
3. Slice 0's probes may still run on the owner's laptop, whatever it runs, with their times marked provisional (V5-24 item 3).

REJECTED: Linux and macOS servers from slice 1 (about twice the disk and socket test matrix from the start, and macOS's fsync differs, so its pins could be relative only); Linux only, for good (a developer could not run a native server on a Mac or Windows laptop).

Consequences: until slice 7, a developer on macOS or Windows runs a server in a Linux container or virtual machine. The shell's disk and socket code may use Linux's calls first, behind one seam, so the other platforms add an implementation and not a rewrite *(reasoned)*.

## V5-28 — P1 passes: the Rust port's mutant score is inside the error of the TypeScript port's (2026-11-25; probes/README.md question 1, asked one at a time)

Context: probe P1's kill line (BUILD 3.3) asks for 41 of 41 etcd test files and 4,000 random scripts byte for byte against etcd's Go code within 10 working days, and a mutant score not below the TypeScript port's (about 74 % by the files, about 89 % with the scripts, both estimated from a hand-read sample). The Rust port met the files, the scripts and the clock (48 minutes). Its score is about 72.7 % by the files (70.8 to 75.0) and about 86.6 % with the scripts (84.4 to 89.4): 1 to 3 points under, inside the error of both estimates *(measured counts; the shares are estimated)*. About 100 live mutants survive in each port; the tests are the same, so the holes are the same, and Rust makes fewer mutants in all (836 against 1,147), so the same 100 are a bigger share *(reasoned from the counts)*.

Decision:
1. P1 passes. The gap is read as noise of two sampled estimates, not as a weaker oracle.
2. The holes the mutants found stay listed as an open issue in STATUS.md (Go's unit tests, not ported, would close most). They do not block slice 1.

REJECTED: pass, but port Go's unit tests for the core (about 8,600 Go lines) and rerun the mutants before slice 1 (a few days for a gap the estimates cannot tell from zero); a fail on the literal reading (it would send P1 to a card with no ready fallback, over a difference inside the error).

Consequences: the Raft port is the base for slice 1. Its proof stays etcd's 41 files, the 4,000 scripts against Go, the edge value check and the mutant run. Since the mutant run, the rule "a leader counts only its own term's entries" (raft-commit.6) is caught by the edge value check (P6's pass), so one known hole is closed *(measured)*.

## V5-29 — Absurd Raft numbers are refused at the wire; the port keeps its overflow checks (2026-11-25; probes/README.md question 2, asked one at a time)

Context: etcd's Go code wraps its `uint64` sums at the top of the range. The Rust port keeps overflow checks on, so a peer's message with a term or index near 2^64 could stop the port where Go goes on. P1's edge value check found such sites one node and four messages deep and fixed them by wrapping as Go does; longer paths are not checked *(reasoned)*. No honest peer sends such a number: a peer proves it holds the secret before it is admitted (the door, slice 7), and until then a server listens only on its own machine (`links.6`). So the number means a bug or damage, not a normal input.

Decision:
1. `links.7` (L0, slice 1): a peer's frame that carries any Raft term or log index at or above 2^62 does not decode: a message's term, log term, index, commit and reject hint, each entry's term and index, and a snapshot's last index and term. It closes its link as `links.3` says and never reaches Raft. The bound, 2^62, is this branch's pick.
2. The Raft crate keeps overflow checks on. A sum that still overflows is a loud stop and a bug to fix, not a value to carry on with. The wraps already made stay; they match Go.
3. The decoder's fuzz test (BUILD 2.5 T7) sends such values.

REJECTED: wrap every sum in the Raft crate, as Go does (closest to etcd byte for byte, but an overflow would then corrupt state silently, as in Go); both (the most code to change and the hardest port to read, for a value no honest peer can send).

Consequences: the ledger gains one record and holds 830. 2^62 is far past any real log: at a million writes a second it is about 146,000 years of writes *(reasoned)*. A sum of a few wire terms or indexes under 2^62 cannot overflow, so those sums are safe behind the wire *(reasoned; not checked site by site)*. Sums with a local size limit (the port uses the top `u64` as "no limit") and plain subtractions are not covered by this rule; the overflow checks stay on for them.

## V5-30 — P5 passes: one number per stream replaces the marks, counted as the ledger counts rules (2026-11-25; probes/README.md questions 3 and 4, asked one at a time)

Context: probe P5 asked whether one number per stream can do the work of the five mechanisms that keep a write applied once and in order: issue order, the slot sequence, client sessions, caller keys and the source high marks (32 rules on the study's count, 46 in the ledger). A **stream** is one writer's writes to one slot. In the new form, a write carries its number and the number before it, and the leader takes it only if before <= the stream's high mark < number. Kill line: no saving of 3 rules or more, or a model fails. Two TLA+ models pass 25 complete bounds; planted mistakes are caught: 27 of 28 on the new form's rules, 9 of 9 on today's rules that stay, and 8 of 9 on lines with no mark *(checked)*. The saving is 7 to 13 ledger rules, or 2 to 5 on the study's finer count, one guard or update per rule *(counted)*. One early run failed: a relay forwarded a copy twice, which `client-sessions.14` forbids today; the failing trace uses no part of the form, and with that rule in the model every bound passes *(checked; two readers agree)*.

Decision:
1. The kill line is read in the ledger's count, the one the budget and the map use. P5 passes.
2. The early failure was a mistake in the model's setup, not in the form. It shows `client-sessions.14` is needed, and that rule stays.
3. Follow-through, decided here: the ledger takes the form on the second reader's stricter count, the one that retires fewest rules. Retired (18): `issue-order.1` to `.4`; `client-sessions.3`, `.4`, `.6`, `.8`, `.10` to `.13`; `srchi-marks.2` to `.5`, `.7`, `.8`. Added (11): `stream-numbers.1` to `.11` (L2; `.1` to `.9` in slice 1, `.10` and `.11` with the slot move in slice 3). Kept: `slot-sequence.2` (the slot's own number has no number before; the leader stamps it), and `caller-keys.10` and `.11` until `once` names are modelled (a `once` name is a caller's key that makes a call apply one time). So 46 records become 39, a saving of 7, the low end of the range.

REJECTED: the study's count (2 to 5, at the line; it would keep five mechanisms where one number does the work and every model passes); pass on the ledger's count but have a second person recount the study's count first (the record already carries both counts and both readers' cuts).

Consequences: the ledger holds 823 records (L2 99; slice 1 256, slice 3 49). With the retired records go: the floor as a guard on taking a write (it now only says which answers are kept, `stream-numbers.9`), the carried floors of a slot move (P5's probe x01: not carrying them breaks nothing), and the `stale` answer (a copy below the floor answers `skipped`). A writer's numbers are now per slot, where `issue-order` numbered them per partition; many partitions share a slot, so a gap holds back the writer's other partitions in that slot *(reasoned)*. The pages that named the old parts (`slot-move.15`, `judging-state.1`, `writer-judging.7`, SHAPES) say the stream table now. The budget is not changed; the saving shows as headroom. A write's wire form carries its stream, its number, the number before it and the floor (the writer's lowest number not yet answered), where the draft had a session's attempt id and an issue number; SHAPES question 9's first half is settled and its fields stay a draft for slice 1's codec. Still owed: a model of once names, the one-commit slot move (READY M6; `stream-numbers.10` and `.11` are a partial model), a session lapse that has not committed, and a stall check in the client model. P5's two models run again on every change to `stream-numbers` (slice 1's model list).

## V5-31 — P2 passes: TEST-01's fresh world is read at p99 of warm worlds (2026-11-25; probes/README.md question 5, asked one at a time)

Context: probe P2 runs the Rust simulator natively and as WASM under Node, with `data` 4 folding every committed batch. Its kill line is TEST-01's: 200 full-stack seeds over 1 s, or a fresh world over 5 ms, or the two builds giving different bytes on any of 1,000 seeds. Measured, provisional (a shared machine; the second reader's run, where the builder's gave 303 ms and 0.25 ms): 200 seeds in 287 ms; a fresh world in 0.21 ms at p99; 0 of 1,000 seeds different, and 0 of 1,000 fresh ones *(measured; the byte check checked)*. But single worlds do go over 5 ms: about 1 warm world in 10,000 (the largest 8.9 ms, a garbage collection of the fold's objects), and the first world of every new process (6 to 10 ms, while the code warms) *(measured)*. E-04, where the bar's numbers come from, measured the 99th percentile of warm worlds.

Decision:
1. "A fresh world over 5 ms" is read at the 99th percentile of warm worlds in one process. P2 passes on all three lines.
2. The largest world and the first world of a process are recorded beside the pin, not judged.
3. The simulator's executive stays in Rust, built native and as WASM (BUILD 2.1). P2's fallback, the TypeScript executive, is not needed.

REJECTED: p99, with the first world of a cold process also under 5 ms (today 6 to 10 ms; it would need a warm-up step or a snapshot before slice 1, for a cost a developer pays once per run); a hard top on every world (P2 would fail today on rare pauses that a test run does not feel).

Consequences: slice 1's TEST-01 pin measures warm worlds at p99, as E-04 did, and records the largest and the cold first world as advisory numbers. The absolute numbers are judged on the quiet machine; today's are provisional. The simulator is a speed and identity harness, not a safety checker: Raft's safety rests on P1.

## V5-32 — P6 passes: the nightly pass is short runs on several cores, and a field the marker can blank is a switch (2026-11-25; probes/README.md questions 6 and 7, asked one at a time)

Context: a rule is a **switch** when a test build can turn it off alone. Probe P6 built the rule marker (`crates/rule`), its scan (`tools/rule-scan.mjs`) and the switch-off pass, which turns each rule off in turn and records which tests go red. It sorted the ledger's 80 Raft rules and ten L2 rules, and marked 62 of the first in a throwaway copy of the port and 9 of the second in E-22's TypeScript prototype; eight Raft rules have no code in the port, so the base is 82. Kill lines: more than 30 minutes projected for 640 rules, or fewer than 80 % of the rules can be a switch. Time, provisional: with short runs per rule (a seeded subset of each layer's tests), 28 minutes with 1 worker and 21 with 4 on a 4-core box; 46 minutes held to one real core; 6.5 hours with each layer's full suite *(measured per rule, then projected)*. Share: BUILD 2.6 lists a field carried in a message as held by an oracle, which gives 75.6 % (62 of 82); the marker's value form could blank such fields, and tests went red for 6 of 9, which gives 86.6 % *(counted)*. A second reader found that `raft-config.5` and `.6` share one expression (85.4 % with them as one), and that for 6 Raft rules the marker wraps a plain `true` and adds its own off branch; they still switch one rule off alone (64 of 82, 78.0 %, without them) *(counted)*. The marker costs nothing in a release build: the same functions, sizes and instruction counts as the port with no marker crate *(checked)*.

Decision:
1. The nightly pass is short runs on a machine with several cores, as BUILD 2.5 T4 words it ("about 500 short runs"). A change still runs the full tests of the rules it touches. P6's time line holds: 21 to 28 minutes.
2. A rule is a switch when its marker can turn it off alone and the pass can run with it off. A field a message carries counts when the marker can blank it; so does a guard where the marker adds its own off branch. BUILD 2.6's list is amended to this.
3. P6 passes at 85.4 % (70 of 82). The markers stay the link between the ledger and the code; no rule id is typed on a test. The real Raft port stays unmarked (BUILD 2.6).

REJECTED: short runs judged on one core (46 minutes, over the line); full suites every night (6.5 hours); fields as switches but not the marker's own off branches (78.0 %, a kill); BUILD's list as written (75.6 %, a kill, and the fallback of rule ids typed on tests, which go stale by hand).

Consequences: `proof` in spec/README.md is `switch` by this test. The quiet machine runs the nightly pass on several cores. The projection rests mostly on nine TypeScript rules of a study prototype; one of them nearly loops when it is off and doubles the mean. It is measured again on `server/` once it exists. On that sample the pass proved 5 of 9 TypeScript rules, under T4's gate of 85 % *(measured)*. A kernel crate that uses `rule` needs its "no outside crates" test to allow the workspace's own `rule` crate. P6 also found five Raft records that the port does not hold because they are the host's duty (`raft-readindex.4`, `raft-snapshot.1`, `.4`, `.5`, `.8`); STATUS lists them for slice 1.

## V5-33 — The models' text fixes that add no rule are taken (2026-11-27; card 0002 question 1, asked one at a time)

Context: slice 0 ran two models the design owed: the slot move in one commit ([models/slot-move](../models/slot-move/README.md)) and founding with several groups ([models/founding](../models/founding/README.md)). A second reader checked each. The card's eleven rows change twelve records, so that each says what the models needed for a property to hold. Most fixes have a planted mistake that fails without them *(checked)*. `slot-move.3` names what every bound already used, and `slot-move.12`, `.16` and `.17` drop what no property needs. None adds a record.

Decision: the texts change as card 0002 lists them.
1. `meta-catalog.5`: a group takes up a settings version only once the home log has committed it, and an alter counts only take-ups that have committed (mistakes s01 to s05).
2. `slot-table.6`: the table, every copy and every client keep only the newest row of a slot; a row's version is its number in the home log, then its step (u51, h03, h12, h13). `route-smart.1` says the same for a client on `moved`: it takes the new owner only from a newer row (h13).
3. `genesis-conditional-create.4` and `.8`: the founding entry holds the slot table for every group and applies no seed row of another group's slots; each group opens only its own share and applies its own seed rows (f10 to f12). The home group may apply its own share in the first entry (bound f-homefirst holds).
4. `growth.5`: the group record is written once, and only the machine it names makes the group (f06, f07, f21). Who it names is V5-38.
5. `selection.1`: a whole selection is ready only once a picture covers every slot (probe c-asread, c12).
6. `slot-move.3`: a move is named by the number of its row in the slot table.
7. `slot-move.12`: the target reports where its copy reached (u42). That the source waits for the report is a speed choice, not a rule: every property holds without it.
8. `slot-move.13`: the fence names where the delta starts, and the target takes the final copy only if its early copy stands there (u28, u29).
9. `slot-move.17` and `.16`: only the target gives a move up, and it may do so before the fence too (m23); `.16` keeps only "a target that gave a move up drops its unseen copy".
10. `slot-move.22`: voters are counted in the newest membership in the leader's log, committed or not (n09). V5-39 adds to it.

REJECTED: going through each fix alone (each is what a model needed, and none changes a count); holding them until slices 2 and 3.

Consequences: the records' evidence names the models. `growth.5` moves from slice 3 to slice 2: founding with several groups in slice 2 makes its groups by these records, and a rule fero adds goes on at first use ([spec/README](../spec/README.md)). Slice 2 then holds 136 records, inside its 5 % headroom of 138.
