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
| [api/](api) | The public surface: `fero()` ([index.ts](api/index.ts)), the LENS write trap → `Bind.issue` ([data.ts](api/data.ts); **V4-7: a write shows when it COMMITS** — inside the assignment on the server that owns the cell, as the server's stamped echo on a client; no optimistic copy, a refused write never shows, an in-flight write is only a `pending` row of `cluster.writes`), **[substrate.ts](api/substrate.ts) — the ONE seam onto `../../data/api/index.ts`**, methods/RPC, fold, diagnostics, types. V4-2 role model: bare `fero(name)` = a CLIENT; `server: true`/`listen`/`dir`/`replicas`/a `data:` seed/`methods:` ⇒ server; `listen: false` = socketless solo; `f.snapshot` = the sync dense read. **V4-8: Ctrl-C / SIGTERM is a clean stop built in** (every live instance leaves and tears down, then the process exits 0 unless the app has its own listener; `signals: false` opts out); the cluster view folds in ONE batch so a bare `cluster.tap` fires once with the whole picture. **V4-5: `methods: {…}` is the ONE spelling for hosted methods and THE DOOR** — its presence makes clients change data only through the methods (every relayed plain write is refused 'methods-only' and never shows on the client; a top-level function throws with the pointer); open or protected, nothing in between. Spokes are VIEWS: never teach a server, resync to the cluster's truth (`resync`/`resynced`). **V4-3 discovery: [directory.ts](api/directory.ts)** — the `#directory` system resource at the per-box rendezvous `127.0.0.1:3376` (`FERO_RENDEZVOUS` env / `rendezvous:` config; the battery runs it `off`): a server binds a FREE port and registers, everyone looks the name up live → the kernel's `discover` event. `#` names are reserved. Spec: [DESIGN-DIRECTORY.md](DESIGN-DIRECTORY.md). |
| [kernel/](kernel) | The deterministic kernel: node, write pipeline, ring, membership (joint-consensus views; **V4-6: a clean `destroy()` LEAVES** — the view shrinks by ballot, so a two-member cluster survives a clean stop; a crash still needs three; V4-8 makes Ctrl-C that clean stop), journal/log, codec (frames + runs), confirm, streams, scope, diag. No I/O — everything replayable. |
| [shell/](shell) | The thin I/O runtime (real sockets/timers around the kernel). |
| [sim/](sim) | The simulation executive: exec, harness, monitors, shrink, sweep — chaos schedules against the SAME kernel bytes the shell runs. |
| [tests/](tests) | Cross-layer scenarios: api scenarios, TCP tier, WAL tier, internals entry pin, baseline perf. |
| [tools/](tools) | debug/ (capture viewer, scenario server, honesty checks, the ONE fold model [model.mjs](tools/debug/model.mjs) — `stateAt`/`topologyAt` replay state AND links/streams under time travel, each behind its own `verify*` drift guard that proves the replay reproduces the captured end before the page paints it — the ELI5 tooltip glossary [eli5.mjs](tools/debug/eli5.mjs) — every `data-tip` key on both pages resolves there, gated by eli5.test) + perf/ (absolute probes, BASELINE.md, pin/compare machinery). |
| [utils/](utils) [examples/](examples) | Shared helpers (`#utils` import map); **the graded example series** ([examples/README.md](examples/README.md)): one folder per example, one file per terminal run as plain `node server.ts`, a `check.ts` per folder that proves it (it stops the roles with Ctrl-C and ends with `ok <example>`), plain-Node plumbing in [lib.ts](examples/lib.ts) — every check runs inside `npm test` via [tests/examples.test.ts](tests/examples.test.ts) under a private rendezvous port. |

Entries: `.` → [api/index.ts](api/index.ts), `./internals` →
[internals.ts](internals.ts). Ledger docs: [STATUS.md](STATUS.md) (D-phases +
log), [DECISIONS.md](DECISIONS.md), [ISSUES.md](ISSUES.md) (bugs found,
with evidence — open first, fixed at the bottom), [CHECKPOINT.md](CHECKPOINT.md),
DESIGN-M6/M7, [DESIGN-DIRECTORY.md](DESIGN-DIRECTORY.md) (V4-3).

## Commands

| Command | What it does |
|---|---|
| `npm test` | 405 unit/sim/scenario tests (incl. the examples smoke tier, the n=100 scale tier and the debugger's DOM/ELI5 gates), then `test:contract` — data's 18-clause SCHEDULE suite ridden from `../data/conformance/schedule.test.ts`. |
| `npm run perf` | The 41 perf pins (kernel/api/sim/tests tiers). `perf:absolute` / `perf:pin` / `perf:alloc` for the probe machinery. |
| `npm run sim` / `shrink` / `scenarios` / `debug` / `demo` / `demo:watch` | Sim executive, shrinker, scenario server, debug viewer, the two-terminal demo (= examples/02-server-client's server.ts / client.ts). |
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
- **Speak in simple English.** Short sentences, everyday words, one idea
  at a time. Say the plain thing first, then the detail. Avoid jargon unless
  it is a fero term — and then say what it means the first time.
