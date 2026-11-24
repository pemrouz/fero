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
