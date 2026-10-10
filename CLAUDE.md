# CLAUDE.md

Guide for Claude sessions working in this repo. Read it before making changes.

## What this is

**fero v4** — distributed, replicated reactive resources: `fero(name, opts)` returns `{ name, data, methods, cluster, snapshot, destroy }`. `data` is a live view whose reads, writes (plain assignment) and operators flow through the sibling `data` engine's change records, which are also the wire format. Underneath: a deterministic kernel (per-cell LWW + Lamport clocks, per-origin logs, digest anti-entropy, joint-consensus membership, ring-owned single-writer pipeline, WAL durability), thin I/O shells, and a simulation executive that proves the same kernel bytes on real TCP and on seeded schedules. `f.snapshot` is the sync dense read.

This root IS the v4 tree (branch `v4`, package `fero` 4.0.0, promoted 2026-08-16). The v2 surface and the frozen v3 tree live on `master`. [README.md](README.md) says what fero is and how to run it. [STATUS.md](STATUS.md) is the ONE ledger: where things stand, the open bugs, the ideas, the decisions. [docs/](docs) holds the full decisions record, the design records and the history.

## Rules

- **Performance is a hard requirement.** A change is done when its tests AND its perf pins are green. Never widen a `*.perf.ts` threshold to make a pin pass; investigate. A change on a `data` path fero exercises runs data's perf suite too.
- **Never push or open a PR without the user's explicit instruction.**
- **Speak in simple English.** Short sentences, everyday words, one idea at a time. Say the plain thing first, then the detail. Explain a fero term the first time you use it.
- **Commit granularly**: one logical change per commit, a Conventional-Commits-ish subject, the WHY in the body. Present each change in chat before committing, then commit and keep moving.
- **`npm test` on every change.** A bug fix ships with the regression test that catches it. Perf on every hot-path change.
- **Other sessions share this tree.** Validate in a scratch worktree (with `../data` reachable next to it), commit path-scoped, never reset or stash another session's edits.
- **Keep STATUS.md in sync with the code.** A fixed bug leaves it; a new bug or idea enters it with its evidence; a decision gets one line there and its full record in [docs/DECISIONS.md](docs/DECISIONS.md) (append-only: supersede, never delete).

## Layout

| Dir | What lives there |
|---|---|
| [api/](api) | The public surface. [index.ts](api/index.ts) is the composer: roles by declared act (bare `fero(name)` = a client; `server: true`, `listen`, `dir`, `replicas`, a `data:` seed or `methods:` = a server; `listen: false` = a socketless solo); `methods:` is the door (V4-5: clients change data only through the methods, a relayed plain write is refused `methods-only`); a write shows when it commits (V4-7: no optimistic copy, a refused write never shows, an in-flight write is a `pending` row of `cluster.writes`); Ctrl-C is a clean stop (V4-8, [signals.ts](api/signals.ts)); `fero.spawn(file, args, { stdin })` runs a role as a child process and returns `{ pid, out, exited, stop, write, child }` (V4-9, [spawn.ts](api/spawn.ts)). [substrate.ts](api/substrate.ts) is the ONE seam onto `../../data/api/index.ts`. [config.ts](api/config.ts) is the ONE seam onto `optcascade` (V4-10). [directory.ts](api/directory.ts) is the `#directory` system resource at the per-box rendezvous `127.0.0.1:3376` (V4-3; `FERO_RENDEZVOUS`; the battery runs it `off`). [fold.ts](api/fold.ts) is the gather for scoped reads, [methods.ts](api/methods.ts) the method plane, [diagnostics.ts](api/diagnostics.ts) the Symbol-keyed internals door. |
| [kernel/](kernel) | The deterministic kernel: node, write pipeline, ring, membership (joint-consensus views; a clean `destroy()` LEAVES by ballot, V4-6), journal, codec, confirm, streams, scope (scoped replication), log (compaction), diag, door (the handshake, V4-30: a peer proves it holds the `secret` before it is admitted; the kernel holds no crypto, `NodeOpts.door` is injected). No I/O; everything replayable. |
| [shell/](shell) | The thin I/O runtime: real sockets, timers and the fsync WAL around the kernel. |
| [sim/](sim) | The simulation executive: exec, harness, monitors (the scale harness M1-M10 since V4-32), shrink, sweep, the scoped sweep ([scoped-sweep.ts](sim/scoped-sweep.ts): adversaries A1-A11 and the mutation runner), the leave harness ([leave-harness.ts](sim/leave-harness.ts), V4-37: the membership schedules that broke the parked I-20 branch, pinned on today's kernel), the n≈100 scale tier. Chaos schedules against the SAME kernel bytes the shell runs. |
| [tests/](tests) | Cross-layer scenarios, the real-TCP and real-WAL tiers, the config tier, the baseline gate, and [examples.test.ts](tests/examples.test.ts), which runs every example check under a private rendezvous port with a per-rung budget. |
| [tools/](tools) | debug/ (the capture viewer, the scenario dashboard, the ONE fold model [model.mjs](tools/debug/model.mjs), the ELI5 glossary [eli5.mjs](tools/debug/eli5.mjs), the honesty gate) and perf/ (the persisted absolute baseline, [BASELINE.md](tools/perf/BASELINE.md)). |
| [utils/](utils) | Shared helpers (`#utils`). [battery.ts](utils/battery.ts) pins `FERO_RENDEZVOUS=off` and `FERO_CONFIG=off` for the whole battery. |
| [examples/](examples) | The 28-rung series ([examples/README.md](examples/README.md)): one folder per example, one file per terminal run as plain `node server.ts`, a `check.ts` that starts the roles with `fero.spawn`, asserts, stops them with Ctrl-C and ends `ok <example>`. The rules: a README is the terminals (V4-11: one block per terminal, the command first, the real output, `^C` at column 0, at most three bullets, a `sh` block of scale-it commands, the check as one sentence, `Next:`); a screen is one line per change or one cleared frame headed by the role word in CAPS; a role file on the ladder is about ten lines with no plumbing; a check runs every file its README names. Run a check by hand on a fresh private port (`FERO_CONFIG=off FERO_RENDEZVOUS=127.0.0.1:<free port> node check.ts`), never on 3376. A change to a printed line re-records the README block from a real run. |
| [site/](site) | The website: one page, served by GitHub Pages through the root [index.html](index.html) redirect. `node site/strip.mjs` type-strips the kernel + sim cone into `site/lib/` (rerun after a kernel change); `node site/build.mjs` assembles `site/index.html` from `page.html` + `sections/` in `order.json`. Source of truth for edits is still `~/fero-site/next/`; copy it here to publish. |
| [docs/](docs) | [DECISIONS.md](docs/DECISIONS.md) (append-only), the design records ([DESIGN-M6](docs/DESIGN-M6.md), [M7](docs/DESIGN-M7.md), [DIRECTORY](docs/DESIGN-DIRECTORY.md), [CONFIG](docs/DESIGN-CONFIG.md), [LEAVE](docs/DESIGN-LEAVE.md), [DOOR](docs/DESIGN-DOOR.md), [SCALE](docs/DESIGN-SCALE.md)), [CHECKPOINT.md](docs/CHECKPOINT.md), [HISTORY.md](docs/HISTORY.md). |

Entries: `.` → [api/index.ts](api/index.ts), `./internals` → [internals.ts](internals.ts).

## Commands

| Command | What it does |
|---|---|
| `npm test` | 798 unit/sim/scenario tests (the 28 example checks, the n=100 scale tier, the config tiers, the debugger's DOM and ELI5 gates), then `test:contract`: data's 18-clause SCHEDULE suite from `../data/conformance/schedule.test.ts`. Runs with `--import ./utils/battery.ts`: directory OFF, config layer OFF. |
| `npm run perf` | The 50 perf pins (kernel/api/sim/tests tiers). `perf:absolute` / `perf:pin` / `perf:alloc` for the probe machinery. |
| `npm run sim` / `shrink` / `scenarios` / `debug` / `demo` / `demo:watch` | Sim executive, shrinker, scenario server, debug viewer, the two-terminal demo (= examples/02). |
| `npm run sim:scale` | The n≈100 deep-sweep registry (11 chaos scenarios, 30-200 s each). Script-tier: run it on scale-relevant kernel changes, not per commit. |

Source-served, no build: everything runs via `--experimental-strip-types`. One install step: `npm install` (`optcascade` ≥ 1.1.0; Node ≥ 22.18).

## The two seams

**data.** [api/substrate.ts](api/substrate.ts) imports exactly one data entry, `../../data/api/index.ts`. Nothing else in fero touches data. fero owns the write surface: the lens traps assignment, delete and the write builtins and routes them through `Bind.issue` BEFORE data sees anything. Replication applies fero Recs (`{ type: 0|1|2, key: [rowKey, ...fieldPath], value, at? }`) verbatim through data's hot `lane()`; that shape is a wire-stability surface in BOTH repos. After any seam, kernel or api change run this repo's `npm test` + `npm run perf`; `test:contract` pins data HEAD.

**config.** [api/config.ts](api/config.ts) is the only importer of `optcascade`. Nothing else reads `process.argv`, a `FERO_*` variable or a `fero.opt.*` file. Precedence: `--fero.<key>` > the call > `FERO_<KEY>` > the project `fero.opt.ts|js` > `$HOME/fero.opt.ts|js` > the default; inside every layer the name rung (`--fero.shop.dir`) beats the global. Keys are nested lowercase words (`heartbeat.ms`, never `heartbeatMs`). To add a key: a row in `LEAVES` (which layers may carry it, and why not the others), a coercion case if it needs one, a README table row, a `config.test.ts` case. Every suite that composes a real `fero()` imports [utils/battery.ts](utils/battery.ts) FIRST. Never commit a `fero.opt.*` at the repo root (a guard test refuses it). `FERO_DIAG_TOKEN` is the debug viewer's variable, not fero config. System resources (`#directory`) bypass the layer.
