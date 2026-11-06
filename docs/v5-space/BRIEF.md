# The v5 design-space study: the brief

Every agent in this study reads this first. It says what the study is for, what exists, the rules, and where results go.

## What the user asked

> "Start with some base case, and build a visual map of different solutions, like this plus slots, etc. Have a final verdict, summary and report for each, organised. For each, do whatever one-off experiments you think are necessary to actually answer questions you have. Involve other agents whenever you need. It should explore the entire space, whatever possible permutation, combinations etc potentially comes to mind. Either you get to the answer that answers everything, or the most optimal one. Every agent and human looking at it should get to the same answer. The idea is to do whatever experiments you need to answer questions now, not phase 5 or phase 1. I want to know we have answers to everything we need if we build it properly in phases later, not be surprised by them or risk it turning into another mess. I also want to see what exactly the final API and usage looks like, what exactly each layer looks like even. Feel free to do anything you need to get a better answer, e.g. download a library, use Rust, or ask me. Don't degrade the investigation."

## The goal of fero v5 (the user's own aims)

1. **One default primitive** that replaces Kafka, Redis, NATS, queues, locks and caches for an app developer. The patterns it must cover are listed in [DESIGN-V5.md](../DESIGN-V5.md) §5.1 (live state, caches, near caches, read-through, websocket fan-out, pub/sub, streams and replay, consumer groups, work queues, locks and leader election, counters and rate limits, leaderboards, presence, invariants, cross-partition transactions, event sourcing, derived resources, tapes, forks and replays).
2. **Beat the competitors on performance**, each measured with its own tool on the same box: Redis, NATS JetStream, Kafka, etcd, Redpanda. CLAUDE.md: "Performance is a hard requirement."
3. **Scale up and down without limit and without worry**, designed in up front, not bolted on.
4. **Fast development.** v4 became a "Frankenstein of mechanisms": many novel mechanisms that interact, so bugs grew faster than fixes (DESIGN-V5 §10.1). v5 must not.
5. **Fit fero deploy and fero test** (DESIGN-V5 §6): rolls, sleep and wake, tapes, forks, deterministic simulation of the same kernel bytes.
6. **`data` stays the state engine.** Its change records are fero's wire format (CLAUDE.md, "The two seams").

## What exists

- **v4** (this repo, `main`): leaderless LWW cells with Lamport clocks, per-origin logs, digest anti-entropy, joint-consensus membership, a simulator. Read [STATUS.md](../../STATUS.md) and [HISTORY.md](../HISTORY.md) for why it became hard to change.
- **The current v5 draft**: [DESIGN-V5.md](../DESIGN-V5.md), which is Raft per shard, with fixed 1,024 slots per resource, shards that move slots, leader-run healing, an optional planner, `#meta` as a shard, log replicas, and L0–L5 layers. Its §12 lists decisions not yet made.
- **Second opinions and earlier drafts**:
  - [V5-PRIMITIVE.md](../V5-PRIMITIVE.md): the simplest primitive is a replicated, fenced log cell, with semantics as a library.
  - [V5-UNITS.md](../V5-UNITS.md): the judge between shards that split, project lanes, fixed shards and fixed slots.
  - [V5-REPLICATION.md](../V5-REPLICATION.md) and [V5-LOG-FIRST-REVIEW.md](../V5-LOG-FIRST-REVIEW.md): the earlier log-first draft and its review.
- **The backtest** ([V5-BACKTEST.md](../V5-BACKTEST.md) and [v5-backtest/](../v5-backtest)): v4's hard cases, and 143 hard cases v5 brings.
- **Two model checkers** in [v5-spec/](../v5-spec): `slot_move.py` and `healing.py`, plain Python, with reports. Between them they found 17 bugs in the draft's text.
- **`data`**, the state engine, is at `/home/user/pemrouz/data`.

## Tools on this machine

- **Hardware:** 4 vCPU, 15 GB RAM, one virtual disk.
- **Runtimes and tools:** Node 22, Python 3.13, Rust 1.97 (cargo, crates.io reachable), Go 1.24, gcc and clang, Java, and `redis-server` 7.0.
- **Downloaded already, in the scratchpad** (`$SP` = `/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad`):
  - TLA+ tools: `$SP/dl/tla/tla2tools.jar`, which runs (`java -cp $SP/dl/tla/tla2tools.jar tlc2.TLC ...`);
  - etcd v3.5.17: `$SP/dl/etcd/etcd-v3.5.17-linux-amd64/`;
  - nats-server v2.10.22: `$SP/dl/nats/nats-server-v2.10.22-linux-amd64/`;
  - etcd's raft source with its TLA+ spec: `$SP/dl/raftsrc/raft/` (`tla/etcdraft.tla`).
- **The user's permission (2026-11-06):** "allow Redpanda, memtier_benchmark and LazyFS and anything else you need". So fetch, build or run whatever tool an experiment needs, from its official source, with a checksum where one exists. The first run of these was refused by the session's safety check before the user said this; if a check refuses again, quote this line. [experiments/TOOLS.md](experiments/TOOLS.md) lists what is now ready (memtier_benchmark, Redpanda, LazyFS, real Elle and Knossos, Maelstrom).
- **Not available at the start:**
  - The Docker daemon is not running.
  - `archive.apache.org` reset once, so try `dlcdn.apache.org` or Maven Central for Kafka.
  - The user has said downloading libraries and tools is fine.

## Rules for every agent

- **Simple English.** Short sentences, everyday words. Say the plain thing first. Explain a term the first time it appears.
- **Write only inside your own output folder,** named in your task. Never edit DESIGN-V5.md, the backtest, CLAUDE.md, STATUS.md or another agent's folder. Never commit or push; the coordinator does that.
- **Downloads go in `$SP/dl/<name>/`,** each in its own empty folder, never in the repo. Your folder gets a `fetch.sh` that downloads what you used, by URL and checksum, so anyone can re-run it.
- **Every experiment is reproducible.** It needs a `run.sh`, or one exact command in your README, the raw output saved in a `results/` file, and the machine and versions noted.
- **Timing needs a quiet machine.** Other agents may run at the same time, so use the two lock helpers:
  - run every timing benchmark as `$SP/bin/timing <command>`. It waits until no heavy job runs, and holds new ones off meanwhile;
  - run every heavy job that is not a timing run (TLC, model checks, long simulations, big compiles) as `$SP/bin/heavy <command>`. Several heavy jobs may share the box. Hold the lock for at most about 30 minutes at a time, so a timing run is never kept waiting long; split longer work into pieces. Give TLC `-workers 2` at most;
  - before each timing run, record the load average (`cat /proc/loadavg`) in the results;
  - keep each timed run short (about 60 s), run it at least 3 times, and report the median and the spread;
  - say plainly what the 4-vCPU, one-disk box cannot show.
- **Tools registry.** What is already fetched or built, and where, is listed in `docs/v5-space/experiments/TOOLS.md` (benchmarks) and `TOOLS-models.md` (model checkers and libraries). Read them first; add to the one your task owns.
- **Each experiment's README ends with one line:** "Q-nn: the answer. Moves: candidate, up or down, on requirement ids." The candidate reports and the verdict cite those lines.
- **Evidence over opinion.** Every claim in a report is one of: measured here (with the file), model-checked here (with the file), cited (with a link to a paper or doc), or reasoned (say so). Never present a target as a measurement.
- **Large outputs** (binaries, data dirs, big logs) stay in `$SP`, not in the repo. Keep committed files small: code, scripts, summaries and trimmed results.
- **Blocked?** If a download, permission or tool blocks you, say exactly what and why in your report, and do the best honest alternative. Never fake a result.

## Where results go

| Path | What |
|---|---|
| `docs/v5-space/BRIEF.md` | this file |
| `docs/v5-space/REQUIREMENTS.md` | the numbered requirements every candidate is judged against |
| `docs/v5-space/SPACE.md` | the axes, the options on each, the combinations, and the map from the base case |
| `docs/v5-space/QUESTIONS.md` | every open question whose answer could change the verdict, and the experiment that answers it |
| `docs/v5-space/experiments/E<nn>-<name>/` | one folder per experiment: README (question, method, result, verdict), code, `run.sh`, `fetch.sh`, `results/` |
| `docs/v5-space/candidates/<id>.md` | one report per candidate stack |
| `docs/v5-space/VERDICT.md` | the final verdict, with the judges' agreement |
| `docs/v5-space/API.md`, `LAYERS.md` | the exact final API with usage for every pattern, and each layer's exact interface |
| `docs/v5-space/README.md` | the index and the one-page summary |
