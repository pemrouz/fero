# fero v4 — status

*fero v4 = fero v3 migrated onto data v4 (the sibling `data` repo = data v3 +
the W1–W17 wishlist, ALL LANDED — see ../data/STATUS.md). Scaffolded
2026-08-01 as a full copy of `v3/` (fero-v2 tip `1d94ad6`); PROMOTED TO THE
REPO ROOT 2026-08-16 (package `fero` 4.0.0; the v2 surface + frozen v3 tree
live on at the `master` branch tip — v3 stays the A/B reference there). Plan
of record: DESIGN-DATA3.md §4 (design decisions) + §5 (D0–D5), at the
`master` tip under `v3/`; this file tracks the D-phases.*

Run from the repo root: `npm test` (299 + the 18-clause data contract ride) /
`npm run perf` (self-contained package).

## Migration ledger (D-phases, per DESIGN-DATA3 §5)

| Phase | Scope | State |
|---|---|---|
| D0 | data v4 pinned (substrate imports data's ONE api entry — since both root promotions: `../../data/api/index.ts`); the SCHEDULE suite rides fero CI (`test:contract` chained into `npm test` — now 18 clauses vs data HEAD); cross-version symbol audit clean (the one v2-symbol probe modernized) | DONE |
| D1 | Substrate swap: v4 handle mint, [value] snapshot (fresh-container semantics), applyRec = the HOT LANE (fero Recs verbatim, zero reshape, ORPHAN-CELL VIVIFY preserving v2's auto-vivify replication semantics), records() = connect(anchor, fn) with REAL synchronous dispose, applyStreamRec = tolerant seam ingest (whole-value diff resubscribe rides legally) | DONE |
| D2 | Warts DELETED, not ported: the capture sink, #expected echo match-and-consume, verb-rewrite matching, #healRoot (root replace now throws PRE-COMMIT in the lens); no-op delete filter kept (leaf-read, absence ≡ undefined per clause 10c); scoped facade's hand-copied OPERATORS set → data's exportContract(); fold armor retained (now mostly moot under clause 10) | DONE |
| D3 | The LENS (DESIGN-DATA3 §4.1): fero OWNS the write surface — assignment/delete trap into Bind.issue BEFORE data sees anything (validation covers both by construction, OQ6 kept); reads/operators/RESERVED delegate to the v4 handle; children are nested lenses; v2-parity thenable kept; post-destroy local-value pin kept; cluster fold on .set() (methods-only writes) | DONE |
| D4 | Perf close-out: fero perf suite 36/36 PASS at the v3-era thresholds (api tripwires, alloc gates, absolute probes); the data-side m3 replication gate pins the seam shape (0.171× at frame-16 vs fero's v2 terminal apply) | DONE |
| D5 | Ledger close: DECISIONS record, IDEAS residue, README | open |

## The frames-stack note (D2 review outcome)

The v3 #frames stack SURVIVES — it guards FERO-kernel re-entrancy (a nested
issue() during rt.write's synchronous apply drain), which is independent of
data's clause-5 queue. What died with the substrate swap is only the DATA-side
re-entrancy pathology (the c870bde class): a tap-issued write now defers to the
next data commit (clause 5, pinned by the contract ride) instead of draining
inside the outer apply.

## Known residue (IDEAS candidates, D5)

- Windowed-sort subscription streaming ('move' records) stays client-side-sort:
  the DATA side now supports move round-trips (W1/W3), but fero mirrors are
  keyed (object-born) — positional mirror identity is a mirror-keying redesign,
  not a seam question. Both skips (serve + apply) kept, documented.
- Inbound applies ride the lane per-record (batch-of-1). The m3 gate measured
  even that at 0.547× of the v2 path, so frame-batched apply is an OPTIMIZATION
  (shell frame boundaries → one lane call), not a correctness need.
- fold.ts cell-isolation armor is now mostly moot (clause 10d isolates in-lane);
  kept as defense-in-depth, slimming is cosmetic.

## Baseline

- Post-migration: **297/297 tests + 16/16 contract clauses** (suite unchanged in
  count from the v3 inherit: every behavioral pin — sim sweeps, Q3A hunts ×2,
  TCP/WAL tiers, scoped fault schedules — passes on data v4).
- Migration findings worth naming: (1) the substrate reject-slot needed
  save/restore (effect-phase re-entrancy corrupted it — caught by the M5-review
  re-entrancy pins); (2) the gather's parent-tombstone-then-live-child
  projection (Q3a seed-0 shape) needed the orphan-cell vivify in
  applyStreamRec too; (3) data's registry filter fail-fast had been bypassed by
  W10's dep routing — restored loud (fixed data-side).

## Log

- 2026-08-01 — scaffold: `cp -r v3 v4`, package rename. No source changes yet.
- 2026-08-01 — D0–D3 landed: substrate rewritten onto data v4 (one seam file,
  one import), Bind on the lens architecture, cluster fold on .set(), facade on
  exportContract(), contract ride wired. 297/297 + 16/16.
- 2026-08-03..16 — D4/D5 closed (perf 36/36 at the v3-era thresholds; ledger
  close), then the cross-repo ADVERSARIAL RE-EVALUATION's fero-side fixes:
  the lens write-builtin backdoor closed (set/update/patch/remove route
  through issue(); insert/ingest/raf/dispose throw fero-shaped;
  first()/last() wrap as lenses) and the ./internals entry repaired (the
  deleted capture sink was still re-exported). 299/299 + 18/18 (data's
  contract grew two clauses-worth of pins, SCHEDULE_VERSION 4).
- 2026-08-16 — data promoted its v4 tree to its repo root; substrate
  re-pointed one hop shorter. Then THE FERO ROOT PROMOTION (same day): this
  tree moved to the repo root (package `fero` 4.0.0), the v2 surface + frozen
  v3 tree retired to the `master` branch tip, seam paths flattened
  (substrate `../../data/api/index.ts`, contract ride
  `../data/conformance/schedule.test.ts`). Full battery green post-move:
  299/299 + 18/18 + perf 36/36.
