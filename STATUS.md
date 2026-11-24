# Status

The one ledger for v5: where things stand, what is next, the open bugs and the decisions made on this branch.

## Where things stand

- **2026-11-24: the branch starts.** Nothing is built. The design is settled in V5-1 to V5-24 on the [`design`](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md) branch. The way of working is [BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md): deep first, then wide; a rule ledger tools can read; a map drawn from it; nine gates that bring a decision to the owner.
- **2026-11-24: the first spec pages are in** ([spec/](spec/README.md)). The ledger holds 826 rules: 773 for fero's six layers and 53 for `data` 5, against the plan's top guess of 640 for fero. `node tools/ledger-gate.mjs` checks it; `node tools/grid.mjs` prints the map. The byte shapes are a draft with 30 open questions.

## Next

1. **The owner's card 0001, the rule budget** ([spec/cards/0001-budget.md](spec/cards/0001-budget.md)). Until it is answered the budget stays "proposed" and slice 0 does not start.
2. **The MUSTs the first build does not reach** ([spec/NOTES.md](spec/NOTES.md), question A): restate each bar as after the first build, or bring its mechanism back into a slice. An owner's pick, since it changes a bar.
3. **Slice 0, ground** (BUILD 3.3): seven probes, each with a kill line, timed first on the owner's laptop (V5-24 item 3); the relative pins on every change.

## Open bugs

None yet.

## Decisions on this branch

V5-1 to V5-24 are on the `design` branch. Decisions made from here on are appended to [docs/DECISIONS.md](docs/DECISIONS.md), from V5-25.
