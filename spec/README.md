# The spec

Nothing is built yet. These pages are what the build is steered by.

1. [SYSTEM.md](SYSTEM.md): what fero v5 is, on one screen. [SHAPES.md](SHAPES.md): the shapes in bytes, a draft.
2. [ledger.json](ledger.json): every first-build rule, one record each, sorted by layer then id. [later.json](later.json): rules kept for after the first build. [retired.json](retired.json): ids that were given up and are never used again.
3. [slices.json](slices.json): the nine slices, 0 to 8, each with its rule count, its models, its pins and what the owner sees and runs.
4. [budget.json](budget.json): the most rule records each layer, each slice and the whole may hold. It was set by [cards/0001-budget.md](cards/0001-budget.md), the first question for the owner, and accepted as V5-25. The budget is on the margins only; no cell of the grid has one.
5. [NOTES.md](NOTES.md): what the ledger leaves out and why, what was settled when it was put together, and every open question.

## The counts

Counted by the tools from `ledger.json`; the gate fails if these lines drift.

Records by layer: L0 87, L1 221, L2 99, L3 146, L4 107, L5 110, D 53.
Records by slice: S0 0, S1 256, S2 136, S3 48, S4 145, S5 78, S6 84, S7 22, S8 54.

## The bars

The bars are the rows REQUIREMENTS marks MUST *(checked against its last column)*: P-01 to P-22; PERF-01 to PERF-08 and PERF-10 to PERF-14; SC-01 to SC-15 without SC-06 and SC-12; F-01 to F-22; DEV-01 to DEV-03 and DEV-06 to DEV-10; DEP-01 to DEP-14, DEP-16 to DEP-18, DEP-20, DEP-21; TEST-01 to TEST-10, TEST-12, TEST-13; DATA-01 to DATA-09; OPS-01 to OPS-14. SYSTEM.md names the ones the first build does not reach; V5-26 restated them as after the first build. A bar that `slices.json` does not name is not placed in a slice yet.

## The tools

They need only Node 22 and nothing installed. Run them from the repo's root.

```sh
node tools/ledger-gate.mjs     # checks the ledger, the budget, the slices and the pages; ends "ok ledger-gate" or lists what is wrong
node tools/grid.mjs            # prints the map: layers by slices, with counts and budgets
node tools/gate-selftest.mjs   # breaks a copy of the spec in each way the gate must catch, and checks that it does
```

The gate fails when:

- a record is malformed, its text holds more than one sentence, an id repeats, or a retired id comes back;
- a record claims a proof, a code site or a test (nothing is built, and the scan that fills them does not exist yet);
- a record known by `model`, `seeds` or `measured` names no experiment or file, or a record at low 0 names no record it may fold into;
- `budget.json` or `slices.json` is missing; the budget names no card, differs from the line its card holds, or has more than 10 % of headroom; a layer, a slice or the whole passes its budget;
- `slices.json`, `SYSTEM.md`, this page or the open budget card states a count the ledger does not have;
- a page names a rule id, written in backticks like `slot-move.4`, that is not in the ledger.

The grid ends with "gate: FAILED" when the ledger's form is wrong.

## One record

- `id` is the mechanism and a number. It is never reused: a rule that is dropped leaves its id in `retired.json`.
- `layer` is L0 to L5, or D for `data` 5. It is a field, not part of the id.
- `text` is the rule: one plain sentence that stands alone.
- `known` says how the rule is known:
  - `model`: a model checker ran it over every state within its bounds. If the model was of a smaller or an older form of the rule, the evidence starts with "partial model:".
  - `seeds`: seeded random runs of a prototype passed, and a planted bug failed.
  - `spec`: it is read from Raft's own spec or etcd's code, and the port is proved again in slice 0.
  - `code`: v4's TypeScript does it today. V5 keeps none of that code, so the rule is known but must be built again.
  - `measured`: an experiment timed or counted the rule itself, not only the need for it.
  - `reasoned`: argued from the design pages; nothing ran.
- `evidence` names the experiment, model or source that knows it. It is not history.
- `touches` names the state the rule reads or writes.
- `decision` is the rule's why in DECISIONS, or null for the base design's own. The order of the slices is not a why.
- `slice` is the slice that turns the rule on. A rule the Raft port's code carries goes on in slice 1, with the port; a rule fero adds on top goes on at first use.
- `low` and `high` bound the count. **Low is 0 only when a named other record may already hold this rule**; the evidence then says "may fold into" and the id. **High is over 1 when the one sentence may hide more than one rule.**
- `sites` and `tests` are filled by tools, never typed. `proof` is `none-yet(reason)` until a scan and a nightly run exist; then `switch` or `oracle`. A rule is a `switch` when its marker can turn it off alone and the nightly pass sees which tests go red; a field a message carries counts when the marker can blank it, and so does a guard where the marker adds its own off branch (V5-32). The nightly pass is short runs on a machine with several cores; a change runs the full tests of the rules it touches (V5-32).
