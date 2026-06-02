# CLAUDE.md

Guide for Claude sessions working in this repo. Read this AND [plan.md](plan.md) before making changes.

## What this is

A from-scratch rewrite of [`fero`](../fero/) — a distributed, replicated reactive resource library — built on top of the [`data`](../data/) reactive collections library (sibling folder). The two libraries compose: `data` provides `$()` proxies with incremental operators; `fero` makes those proxies distributed.

The full design is in [plan.md](plan.md). That is the source of truth — this file orients a fresh session; the plan describes what to build.

## Performance is a hard requirement

**Ultra-performance and low-latency are first-class goals for this repo, not an afterthought.** fero is on the hot path of every read, write, and replication hop — latency here is latency everyone downstream inherits. Treat throughput and tail latency as correctness:

- **Every change must be validated for performance**, the same way it's validated for correctness. A change isn't done until both its tests AND its perf numbers are green.
- **Per-file `*.perf.ts` siblings** for anything on a hot path (wire framing, serialise/deserialise, log append, replication apply, projection deltas). Median-of-5 `performance.now()` + `ok(elapsed < threshold)`, mirroring `data`'s perf style.
- **Never widen a threshold to make a perf test pass** — investigate the regression. Don't undo prior `perf:` work without a measured reason.
- **Prefer the design that's durably faster**, even when a slower one is simpler — call out the trade-off explicitly when you don't. Allocations, copies, and per-message work in the steady state are the usual suspects.
- When a change touches `data` (the sibling lib) on a path fero exercises, run `data`'s perf suite too — fero's latency is bounded by `data`'s.

## Quick orientation

Public API (the whole thing):
```js
fero(name)                            // read-only client
fero(name, { method, …config })       // server
// returns
{ data, methods, cluster, destroy }
```

- `data` — ViewProxy of the resource state. Reads via property access (`sessions.data.user42`), writes via assignment (`sessions.data.user42 = {…}`), reactive operators (`.filter`, `.group`, `.tap`, `.connect`) all work.
- `methods` — RPC + subscriptions. A method returns whatever it wants; the caller's `await`-or-not picks the consumption mode (Promise for value, ViewProxy for live subscription).
- `cluster` — peers / partitions / me, also a ViewProxy so it's queryable and connectable.
- `destroy` — teardown.

Zero events. Zero hooks. Everything reactive flows through `data`'s change records (`{type:'update'|'insert'|'remove', key, value, at?}`), which are also the wire format.

## Layered architecture (internal)

```
L4   tooling: CLI, devtools cluster tab, chaos tests
L3   planner (later — distributed operator graph)
L2   resource: fero(name, opts) — the public API
L1   log + view: per-key change-record log + $() projection
L0   transport: peers, DHT, UDP discovery, INIT/SYNC/DONE
─── data (sibling) ───
```

L0–L2 ship in v1. L3 is the big rethink — deferred. Power users can `import { transport, log, view } from 'fero/internals'`.

## Sibling folders to reference

- [../data/](../data/) — the reactive collections library this builds on. Read its [CLAUDE.md](../data/CLAUDE.md) — change-record shape, ViewProxy semantics, operator dispatch table, and the gotchas (esp. `proxy[value]` vs `proxy.value`, thenable-proxy trick, between/intersect leaving explicit `undefined`).
- [../fero/](../fero/) — the WIP rewrite already started on `data`. Has a partial L0 (Peers/Peer/DHT/handshake/message). Code is messy / mixes ESM and CommonJS, but the shape is informative. Don't extend it; the new code lives here.
- [../fero-old/](../fero-old/) — the original legacy fero. Look at it for: the chaos test harness, the binary message format (lazy-deserialise + length-prefix framing), the UDP multicast discovery, the consistent hashring math. Algorithms port; code style doesn't.

## Build order — centerpiece first

Per `feedback_rethink_not_reskin` and `feedback_serve_for_visual_progress` (carried over from data repo's user feedback), prototype the centerpiece before scaffolding layers.

1. **Day 0 — wire-format prototype.** Two Node processes, one TCP socket, `$()` on A replicating to `$()` on B via raw change records. No fero abstractions; just `proxy.connect(...)` piped over a socket on each side. Proves the foundational hypothesis. If it doesn't round-trip cleanly, every assumption above needs revisiting.
2. **L0 — transport.** Port peer pool + DHT + handshake + multicast discovery from `fero-old/`, modernised to ESM/TS.
3. **L1 — log + view.** Per-partition append-only log + replication. Standalone usable.
4. **L2 — resource.** `fero(name, opts)`. Method dispatch (handler runs on connected server; writes inside handler route to partition owner via DHT). Default `update`/`insert`/`remove`/`read`. Per-client projection machinery for `read`.
5. **L4 — tooling.** CLI + devtools cluster tab + examples + chaos tests.
6. **L3 — planner.** Only once everything below is solid.

## Conventions inherited from data

These apply in spirit, often in letter:

- **TypeScript at source, no built artifacts in tree.** `.ts` is the source of truth. `.gitignore` blanket-ignores `*.js`; build output goes to `dist/`. Tests run TS directly via `node --experimental-strip-types --test` — no compile step.
- **Per-file test + perf siblings.** `foo.ts` → `foo.test.ts` + `foo.perf.ts`. `node:test` + `node:assert`. Perf tests assert thresholds (median-of-5 + `ok(elapsed < N)`); don't widen thresholds to pass.
- **Shared helpers live in [utils/](utils/), named `noun.verb()`.** Don't copy-paste fixtures (free ports, polling, timing, record-apply) between test/perf files — import them via the `#utils` subpath (a Node import map in package.json → [utils/index.ts](utils/index.ts), so no `../../` juggling): `import { ports, until, bench, apply } from '#utils'`. Naming convention: group related operations under a lowercase **noun** namespace and name the method for the **action** — `ports.free()`, `bench.time()` — and keep one-off predicates/actions **flat** — `until()`, `sleep()`, `connected()`, `apply()`. Prefer `ports.free()` over a `freePort`/`free_port` free function: the noun reads as the thing you want, the verb as what to do with it. The perf timing primitive (`bench.time` = one untimed warmup + median-of-5) lives here too, so every `*.perf.ts` measures identically.
- **One logical change per commit. Present before committing.** Surface (a) what changed, (b) why, (c) test results, (d) perf results before running `git commit`. Conventional-Commits-ish prefixes (`feat(transport):`, `fix(log):`, `perf:`).
- **Keep docs in sync with code.** When you change behaviour, public API, or commands, update plan.md and (later) README.md in the same change.
- **Don't undo recent perf work.** Check `git log` for recent `perf:` / `fix:` commits before refactoring hot paths.
- **Run all tests + perf on every change.** Add regression tests for fixes; extend perf tests when a new hot path appears.

## User feedback carried over (from data sessions)

- **Rethink, don't reskin.** The conversation that produced [plan.md](plan.md) explicitly avoided porting the old fero API one-to-one. The new shape (`{data, methods, cluster}`, no events, no hooks, return-type dispatch for methods) is the rethink. Don't drift back toward the legacy shape.
- **Present every commit before running `git commit`.** Review-then-commit protocol; don't skip even on small fixes.
- **Keep momentum across sequenced commits.** Present each commit's diff/tests, then commit and move on; don't ask "shall I continue?" between agreed steps.
- **Serve, share link, stop after.** For UI/visual progress: start a local server, share the URL as `localhost` (NOT `127.0.0.1` — WSL2/VSCode forwarding only resolves under `localhost`), then stop the server once seen.
- **Readable example sources.** Gallery apps showcase the lib; no dense one-liners or imperative paint loops; bind reactively.
- **Flattering benchmark workloads.** When benchmarking against peers (e.g. Kafka, Redis), pick bounded workloads where fero is durably ahead. The ticker example was deleted from data for an insert-rate crossover; don't repeat the lesson.

## Open design questions (from plan.md §11)

These are deliberately unresolved — pick them up as the build hits them:

1. Syntax for fire-and-forget writes inside handlers (default: handler awaits each commit's ack).
2. Re-subscription behaviour on connected-server failover.
3. Cross-partition ordering inside a handler (no atomicity — document, don't paper over).
4. Whether AsyncIterator-returning methods need a path beyond Promise/ViewProxy.
5. `cluster.me` availability before first peer-connect.
6. Reserved top-level keys on the returned object (`data`, `methods`, `cluster`, `destroy`) — keep new surface nested under one of the three reactive surfaces.

## What NOT to do

- Don't extend [../fero/](../fero/). It's the WIP that this rewrite supersedes. Read for context; don't build on it.
- Don't introduce events (`.on('change')`, `.on('connected')`, etc.) on the public API. Everything reactive is a ViewProxy that you `connect` or `tap`.
- Don't add a `verbs:`/`methods:` wrapper key. The opts object's function values ARE the methods; non-function values are config. Recognised by value type, not key name.
- Don't add reserved-name discipline (UPPERCASE verbs, etc.). Methods can be named anything.
- Don't put RPC and subscriptions in separate namespaces. One `methods` namespace; the return type decides consumption mode.
