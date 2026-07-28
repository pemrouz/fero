# The absolute baseline — reading it, re-pinning it, and the escape hatch

This directory holds the persisted absolute tier (plan §7.3): `results/baseline.json`
(tracked — medians, throughput, wire counts, runner identity) and
`results/latest.json` (gitignored — every run's raw output). The comparison policy
is ONE pure module ([compare.ts](compare.ts)) consumed by both the CLI
(`npm run perf:absolute`) and the gate (`tests/baseline.perf.ts` inside
`npm run perf`), so it cannot fork.

## Reading a gate report

- **COUNT DRIFT** — a wire-structural law moved (bytes per canonical record, frames
  per burst/forward/run). Real on ANY machine: either a regression, or a deliberate
  wire change that must land with a DECISIONS record and a re-pin in the same
  change. Never both silent.
- **skip: "no baseline for this runner"** — the honest third state. The ms tier
  exists only on the box whose fingerprint (host + OS type + CPU model×count +
  Node MAJOR) pinned it. A skip is not a pass and not a failure; the per-file
  tripwires in the perf siblings remain the hard backstop everywhere.
- **advisory deltas** — printed, never asserted. This baseline was recorded on a
  WSL2 dev box (`runner.posture: "advisory"`): its wall numbers are information,
  not law. Only a `posture: "pinned"` baseline (recordable only on a quiet
  non-VM box — the CLI refuses otherwise) enforces `msTolerancePct`.
- **PROBE-ERROR** — the probe declared its own run invalid (formation flake after
  one retry, a mid-run backpressure shed, a convergence miss). No number exists;
  nothing is compared or pinnable. A flake never masquerades as drift.
- **improved … re-pin candidate** — faster past tolerance is DATA, never a
  failure; recalibration is data-driven (plan §7.3).

## Re-pinning (the escape hatch — the ONLY sanctioned way a ceiling moves)

Legitimate triggers: hardware change; OS reinstall or hostname change; Node MAJOR
upgrade; a deliberate cost-model change **recorded in DECISIONS before the re-pin
commit**; a workload change (which is a NEW probe id — `….v2` — never a quiet
mutation of an old one).

Procedure:
1. **Same box, same session, A/B first**: run `npm run perf:absolute` on HEAD and
   on the last green parent. If HEAD is slower on unchanged hardware and Node,
   the hatch is CLOSED — that is a regression to fix, not a baseline to move.
2. `npm run perf:pin -- --runner=<label> --reason "<trigger>"` (add `--pinned`
   only on the provisioned quiet runner — refused on WSL/VM release strings).
   The pin refuses when the tracked baseline differs from HEAD's copy (another
   session moved it — reconcile first), and when the socket probe was invalid.
3. Commit `results/baseline.json` ALONE: `perf(baseline): re-pin — <trigger>`.
   The old pin survives in git and in the new file's `supersedes`.

## FORBIDDEN (each of these is the never-widen rule wearing a disguise)

- Re-pinning to green a red gate on unchanged hardware + Node.
- Widening any `*.perf.ts` threshold — investigate the regression instead.
- Raising `msTolerancePct` past the validated cap (10–50; the machinery's own
  test enforces it), or raising it at all without its own DECISIONS record.
- Hand-editing `baseline.json` — the CLI is the only writer.
- Renaming the runner id to dodge a fingerprint mismatch.
- `--pinned` from a WSL/VM or any shared/noisy box.
- Comparing ms across different runner fingerprints — in tooling, or by eyeball
  in a commit message.
