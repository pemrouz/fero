# CLAUDE.md

Guide for Claude sessions working in this repo. Read this before making changes.

## What this is

**fero v4** — distributed, replicated reactive resources: `fero(name, opts)`
returns `{ name, data, methods, cluster, snapshot, destroy }`, where `data` is a live view
whose reads, writes (plain assignment), and reactive operators all flow
through the sibling [`data`](../data/) engine's change records — which are
also the wire format. Underneath: a **deterministic kernel** (per-cell LWW +
Lamport clocks, per-origin logs, digest anti-entropy, joint-consensus
membership, ring-owned single-writer pipeline, WAL durability), **thin I/O
shells**, and a **simulation executive** that proves the same kernel bytes
both ways (real TCP and simulated schedules, with shrinking).

**This root IS the v4 tree** (promoted 2026-08-16, branch `v4`; package
`fero` 4.0.0). The v2 surface and the frozen v3 tree — including
DESIGN-DATA3.md, plan.md/plan-v3.md, GLOSSARY.md — live on at the **`master`
branch tip**. An uncommitted debug/observe WIP is stashed ("pre-promotion
WIP" — apply it on `master` only). v3's shrunk sim captures sit in
`captures/v3-legacy/` (gitignored).

## Performance is a hard requirement

fero is on the hot path of every read, write, and replication hop. A change
isn't done until its tests AND its perf numbers are green. Per-file
`*.perf.ts` siblings pin anything hot; **never widen a threshold to make a
perf test pass** — investigate. When a change touches `data` on a path fero
exercises, run data's perf suite too.

## Layout

| Dir | What lives there |
|---|---|
| [api/](api) | The public surface: `fero()` ([index.ts](api/index.ts)), the LENS write trap → `Bind.issue` ([data.ts](api/data.ts)), **[substrate.ts](api/substrate.ts) — the ONE seam onto `../../data/api/index.ts`**, methods/RPC, fold, diagnostics, types. V4-2 role model: bare `fero(name)` = a CLIENT on the name-derived port; `server: true`/`listen`/`dir`/`replicas`/a `data:` seed/any method ⇒ server; `listen: false` = socketless solo; `f.snapshot` = the sync dense read. |
| [kernel/](kernel) | The deterministic kernel: node, write pipeline, ring, membership, journal/log, codec (frames + runs), confirm, streams, scope, diag. No I/O — everything replayable. |
| [shell/](shell) | The thin I/O runtime (real sockets/timers around the kernel). |
| [sim/](sim) | The simulation executive: exec, harness, monitors, shrink, sweep — chaos schedules against the SAME kernel bytes the shell runs. |
| [tests/](tests) | Cross-layer scenarios: api scenarios, TCP tier, WAL tier, internals entry pin, baseline perf. |
| [tools/](tools) | debug/ (capture viewer, scenario server, honesty checks, the ELI5 tooltip glossary [eli5.mjs](tools/debug/eli5.mjs) — every `data-tip` key on both pages resolves there, gated by eli5.test) + perf/ (absolute probes, BASELINE.md, pin/compare machinery). |
| [utils/](utils) [examples/](examples) | Shared helpers (`#utils` import map); the two-terminals demo. |

Entries: `.` → [api/index.ts](api/index.ts), `./internals` →
[internals.ts](internals.ts). Ledger docs: [STATUS.md](STATUS.md) (D-phases +
log), [DECISIONS.md](DECISIONS.md), [ISSUES.md](ISSUES.md) (bugs found,
with evidence — open first, fixed at the bottom), [CHECKPOINT.md](CHECKPOINT.md),
DESIGN-M6/M7.

## Commands

| Command | What it does |
|---|---|
| `npm test` | 341 unit/sim/scenario tests (incl. the n=100 scale tier and the debugger's DOM/ELI5 gates), then `test:contract` — data's 18-clause SCHEDULE suite ridden from `../data/conformance/schedule.test.ts`. |
| `npm run perf` | The 41 perf pins (kernel/api/sim/tests tiers). `perf:absolute` / `perf:pin` / `perf:alloc` for the probe machinery. |
| `npm run sim` / `shrink` / `scenarios` / `debug` / `demo` | Sim executive, shrinker, scenario server, debug viewer, two-terminals demo. |
| `npm run sim:scale` | The n≈100 deep-sweep registry (11 chaos scenarios, 30-200s each; `--only <name>`, `--seeds N`). Script-tier — run it on scale-relevant kernel changes, not per-commit. |

Source-served, no build: everything runs via `--experimental-strip-types`.

## The data coupling (the seam discipline)

- [api/substrate.ts](api/substrate.ts) imports **exactly one** data entry:
  `../../data/api/index.ts` (`$`, `value`, `node`, `lane`, `ingest`,
  `DataNode`, `exportContract`). Nothing else in fero touches data directly.
- **fero owns the write surface** (DESIGN-DATA3 §4.1): the lens traps
  assignment/delete/write-builtins and routes through `Bind.issue` BEFORE
  data sees anything — no capture sink, no echo problem, no data-side veto.
- Replication applies fero Recs (`{type:0|1|2, key:[rowKey,...fieldPath],
  value, at?}`) VERBATIM through data's HOT `lane()` — that shape is a
  wire-stability surface in BOTH repos.
- `test:contract` pins data HEAD to the SCHEDULE contract
  (SCHEDULE_VERSION discipline lives data-side). After any data
  seam/kernel/api change, run THIS repo's `npm test` + `npm run perf`;
  data's m3/m4 gates pin the seam budgets from the producer side.

## Working conventions (please follow)

- Keep STATUS.md's ledger/log and this file in sync with the code.
- Commit granularly with detailed Conventional-Commits-ish messages; one
  logical change per commit; explain WHY in the body.
- Present every change in chat before committing (what/why/test/perf), then
  commit and keep moving.
- `npm test` on every change; a bug fix ships with the regression test that
  catches it. Perf on every hot-path change.
- **Never push / open PRs without the user's explicit instruction.**
