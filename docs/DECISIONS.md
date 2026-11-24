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
