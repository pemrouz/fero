# The brief and the three proposals behind LENS.md

These files are what [LENS.md](../../../LENS.md) was first written from, before E-55 built the shape. They were made in a scratch folder on 2026-11-17 and copied here in the review (finding F18), so the repo can show where LENS.md's "measured (brief)", "measured (lens-first)", "measured (cost-first)" and "checked (space)" marks point. Nothing here was changed except paths: `$SP` stands for the scratch folder the study ran in, `$TREE` for E-50's scratch copy of fero's seam and data (made by `../../E06-fork-rewind/tree.sh`), and `./` for this folder.

| File or folder | What it is |
|---|---|
| [brief.md](brief.md) | the facts brief all three designers got: fero v2, v4 and v5 as they stand, data's handle, what the owner asked. Facts only, each marked |
| [lens-first.md](lens-first.md) | the proposal that took the owner's lens as far as it goes |
| [cost-first.md](cost-first.md) | the proposal that priced every construct and doubted the lens |
| [space.md](space.md) | the proposal that mapped every place a computation can run |
| [bench/](bench) | the brief's benches and their raw lines: `nest-cost` (a message as a field against a row), `path-step` and `mem-step2` (data's handle today), `tap-cost`, `anchor-life` |
| [cost-bench/](cost-bench) | cost-first's: `fin-time` (when finalizers run), `path-fan` (K path subscriptions on data today), and its type sketches |
| [lensfirst/](lensfirst) | lens-first's prototype (`run/lens-proto.mjs` and its raw lines) and type sketches |
| [space-types/](space-types), [typeof/](typeof) | space's type sketches; the first `import type` checks |

Every run used Node v22.22.0 and TypeScript 6.0.2. The benches read `$TREE`; to rerun one, make that tree first and set `TREE`. **Where E-55 measured the same thing on the real shape, LENS.md quotes E-55**; these files are kept as the record of what the recommendation was first based on. They are proposals, not decisions: LENS.md's section 4.1 says what was taken from each, and what the build and the review then changed.
