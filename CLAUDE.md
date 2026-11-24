# CLAUDE.md

Guide for coding sessions working on this branch. Read it before making changes.

## What this is

**fero v5, being built.** A Rust native core (the journal, Raft, the links, replication, the wire and the fan-out of committed bytes) under TypeScript layers (rows in `data`, which folds every record on every copy; the lens, methods, served views and the libraries) and TypeScript clients, the browser included. The line is V5-23 item 1: JavaScript runs once per decision, never once per delivery; bytes cross the line in batches.

This branch holds only v5's spec and code. The design record (decisions V5-1 to V5-24, the study pages, the experiments, [READY.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/READY.md) and the build plan [BUILD.md](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md)) is on the `design` branch. v4 is on `main`. [STATUS.md](STATUS.md) is the one ledger: where things stand, what is next, the open bugs.

## Rules

- **The spec steers.** A change to behaviour changes the spec first: the system page, the layer page and the rule ledger, then the code. Every rule has an id; the code that holds it carries the id. A rule budget, a speed bar, a fixed byte shape or anything a user sees changes only through the owner's gate (BUILD 1.3). Everything else is decided here and logged in one line.
- **Performance is a hard requirement.** A change is done when its tests AND its pins are green. Never loosen a pin to make it pass; investigate. Absolute bars are judged only on the quiet machine (V5-23 item 6, V5-24 item 3); relative pins run on every change.
- **The kernel has no I/O.** Everything below the shell is deterministic and replayable; the simulator runs the same kernel code on seeded schedules. No `unsafe` in the kernel; `unsafe` only at the boundary with Node, each block with its reason.
- **Never push or open a PR without the owner's explicit instruction.**
- **This repo is public.** Never copy the owner's messages into it, not even a phrase: say what was asked in your own words. Keep out how the assistant's sessions run (permissions, scheduling, tooling), AI product names, personal data and scratch paths.
- **Speak in simple English.** Short sentences, everyday words, one idea at a time. Say the plain thing first, then the detail. Explain a fero term the first time you use it.
- **Commit granularly**: one logical change per commit, a Conventional-Commits-ish subject, the WHY in the body. Present each change in chat before committing, then commit and keep moving.
- **Commits name no tool.** No co-author or session trailers in a message. Sessions commit as `fero-bot <2184177+pemrouz@users.noreply.github.com>`.
- **A bug fix ships with the regression test that catches it.**
- **Other sessions share this tree.** Commit path-scoped; never reset or stash another session's edits.
- **Keep STATUS.md in sync with the code.** A fixed bug leaves it; a new bug enters it with its evidence. A decision gets one line in STATUS.md and its full record in [docs/DECISIONS.md](docs/DECISIONS.md) (append-only, from V5-25: supersede, never delete).
- **Copy nothing from v4 up front** (V5-24 item 5). A small TypeScript piece (the config layer, the clean Ctrl-C stop, `fero.spawn`, the example-check harness) is copied from `main` only when a slice needs it, with its tests.

## Layout

Nothing is built yet. The code's shape follows BUILD 2.1 as each slice starts.

| Dir | What lives there |
|---|---|
| [spec/](spec/README.md) | The spec (V5-23 item 7): [SYSTEM.md](spec/SYSTEM.md), the whole system on one screen; [ledger.json](spec/ledger.json), every first-build rule; [slices.json](spec/slices.json); [budget.json](spec/budget.json); [SHAPES.md](spec/SHAPES.md), the bytes (a draft); [NOTES.md](spec/NOTES.md), the open questions; `cards/`, the owner's questions. |
| [tools/](tools) | `ledger-gate.mjs` (run it on every spec change; it must end `ok ledger-gate`), `grid.mjs` (the map), `gate-selftest.mjs`. Plain Node, nothing installed. |
