# fero v4 — status

*fero v4 = fero v3 migrated onto data v4 (the sibling repo's `v4/` tree = data
v3 + the W1–W17 wishlist). Scaffolded 2026-08-01 as a full copy of `v3/`
(fero-v2 tip `1d94ad6`), package renamed `fero-v4`. v3 stays frozen-green as
the A/B reference. Plan of record: [../v3/DESIGN-DATA3.md](../v3/DESIGN-DATA3.md)
§4 (design decisions) + §5 (D0–D5); this file tracks the D-phases.*

Run from this directory: `npm test` / `npm run perf` (self-contained package).

## Migration ledger (D-phases, per DESIGN-DATA3 §5)

| Phase | Scope | State |
|---|---|---|
| D0 | Pin data v4 imports (substrate `../../../data/v4/...`), cross-version symbol grep, schedule suite wired into CI entry, perf baselines snapshotted under joint methodology | open |
| D1 | Substrate swap: source mint, W7 hot-lane ingest (batched per frame-run), origin tokens, W2 native sink, W9 reads; restore-from-WAL → batched ingest + W11 pre-promote; cluster fold off bare assignment | open |
| D2 | Delete warts: echo machinery, frames stack, #healRoot (+ index.test.ts root-replace probe), fold armor → W3 contract; mirrors mint v4 sources + whole-value-diff resubscribe + order/move streaming; OPERATORS set → exportContract() | open |
| D3 | Public surface re-point: fero-owned write-trap proxy (§4.1), RESERVED collision routing via get(), await semantics re-pinned | open |
| D4 | Perf close-out: full suite + alloc-gate extension over the seam (W8 numbers); mint restore/replay + fold/gather gates; fresh-values methodology audit; baseline re-pin | open |
| D5 | Ledger close: DECISIONS record, IDEAS residue, README | open |

## Baseline

- Scaffold copy: 292 tests inherited from v3 (still consuming data v2 via the
  copied `../../../data/index.ts` import — that is the pre-migration baseline
  by design; D0 repoints it).

## Log

- 2026-08-01 — scaffold: `cp -r v3 v4`, package rename. No source changes yet.
