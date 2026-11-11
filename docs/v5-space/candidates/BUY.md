# BUY: fero's upper layers on a bought log, NATS JetStream first (a reference row)

**Verdict.** On VERDICT's frame (strict DATA-01, clauses restated, no loss accepted; see the [key of terms][key]), this reference row is out on 27 MUSTs ([SPACE 4.2][s42]). Most fail by structure: the log is someone else's server, so fero's simulator cannot run it, and fero cannot beat what it is built on. By [rule 3][rule]'s counts alone it would beat COMP2, with 0 novel mechanisms against 3, but rule 2 keeps it out. The loose DATA-01 reading moves none of its cells. Accepting JetStream's default test line as a loss changes nothing, since BUY's PERF-04 fails by structure. As worded it fails the same 27 and ranks 19th of 20 ([A.2][oa2]).

## In short

- **Where writes go.** Each resource is one JetStream stream. fero's client publishes to it, and every write passes through the stream's one leader.
- **How replicas agree.** Inside nats-server, by JetStream's own replication. fero owns no step of it.
- **Who heals and moves.** JetStream's own cluster. Killing a stream's leader left writes waiting 5.2 to 7.2 s ([E-44]).
- **What a commit means.** JetStream's: `persisted` is `sync_interval: always`, one fsync per message.
- **Exactly once.** JetStream's dedup by message id, inside a time window, and only until the row's next write ([E-44]).
- **Where rows fold.** `data` folds the stream on the client. fero's sagas run as a library, with fencing by convention.
- **Where it comes from.** SPACE's BUY row: fero's layers L2 to L5 on an outside log, NATS JetStream first ([SPACE 4.1][s41]). Redpanda or FoundationDB would also fit.

## Its line

"Theirs" means the bought log decides it, not fero.

| Axis | Option | In plain words |
|---|---|---|
| R: how replicas agree | `outside` | NATS JetStream replicates |
| G: what one log covers | `theirs` | one stream per resource |
| P: how keys map to groups | `theirs` | JetStream's subjects in one stream |
| K: where write rules live | `lib` | fero's conditions and ops are a library on the client |
| C: who heals and moves | `theirs` | JetStream's cluster |
| V: kinds of replica | `theirs` | JetStream's replicas, each a full copy |
| Q: what a commit means | `theirs` | JetStream's acks; fsync always for `persisted` |
| D: exactly once | `theirs` | JetStream's message-id dedup window |
| O: positions | `theirs` | stream sequences |
| T: time | `theirs` | JetStream's clocks |
| X: writes across partitions | `saga` | fero's saga library (A-24); fencing by convention |
| S: storage | `theirs` | JetStream's file store; no object-store tier |
| F: where rows fold | `all` | `data` folds the stream on each client |
| W: reads | `any` | from the stream, at a position |
| U: where user code runs | `any` | in the app processes |
| H: where fero runs | `srv` | apps are clients of separate nats-server processes |
| L: language | `ts client` | fero is a TypeScript client |
| I: the Raft core | `—` | none of fero's own |
| Y: how a write reaches its leader | `smart` | the client publishes to the stream |
| M: threads | `theirs` | nats-server's |
| Z: storage faults | `theirs` | JetStream's |
| N: tenancy | `theirs` | three NATS servers per project, as priced in [E-41] |

## Its score

From [outcome.json] and [OUTCOME.md][outcome]. Restating and the strict reading change no BUY cell.

| | As worded | Restated |
|---|---|---|
| MUSTs failed | 27 (gap ÷ bar 8.79) | the same 27 |
| MUSTs open | 96 | 96 |
| MUSTs met | 9 | 9 |
| SHOULDs met | 2: DEV-04, DEV-05 | the same 2 |
| Novel mechanisms | 0: its replication is the bought log, judged as one published unit | 0 |
| Interacting pairs | 12 | 12 |
| Rank | 19th of 20 ([A.2][oa2]) | out on 27 MUSTs |

**Against the winner.** Let back in, BUY has 0 novel mechanisms to COMP2's 3. They are 3 apart, so BUY would win at rule 3's first step. That is why rule 3 is only applied to rows still in.

## What fails, and the proof

One line per MUST, from the [scorecard][card]. No restatement and no item of [section 8][s8] saves any of them. SC-03, SC-05 and SC-10 fail restated too.
- **P-06 Pub/sub.** Structural: its `none` rung is core NATS itself, so it cannot beat core NATS.
- **P-10 Locks.** Structural: the client, not a writer, compares the token in one subject's last message.
- **P-11 Counters.** Counterexample, measured: a retried increment was counted again (3 where 2 was right) ([E-44]).
- **P-14 Invariants.** Structural: its only condition is "expected last sequence" of one subject, one row.
- **PERF-02 Redis 7.** Ceiling: JetStream with fsync always tops out at 3,668 messages a second, against Redis's 91,600 SETs a second. Gap 0.96.
- **PERF-03 NATS core.** Structural: core NATS plus fero's client and gateway cannot beat core NATS.
- **PERF-04 NATS JetStream.** Structural: each fero write is one or more JetStream publishes, plus fero's own work.
- **PERF-05 Kafka.** Ceiling: 3,194 messages a second at 1 KiB, against Kafka's 86,344 records a second. Gap 0.96.
- **PERF-06 Redpanda.** Ceiling: 3,194 a second, against Redpanda's 175,420 records a second. Gap 0.98.
- **PERF-07 etcd.** Ceiling: 3,275 acks a second from 16 publishers, against etcd's 22,800 puts a second at 1,000 clients. Gap 0.84.
- **PERF-10 Reads and ops.** Structural: a conditional op is a client read plus a publish, about 4 ms ([E-44]).
- **SC-01 One process, no setup.** Structural: `node app.ts` alone has no log to write to.
- **SC-03 Scale writes up.** Structural: one stream has one leader, so one effective writer against 64. Gap 0.98.
- **SC-05 Scale to zero and back.** Structural: nats-server 2.10.22 has file and memory storage only, no object-store tier.
- **SC-07 Members.** Structural: the simulator cannot run nats-server, so no 100-member sweep can exist.
- **SC-10 Only stated ceilings.** Structural: a ceiling of 1 writer per resource, below 64. Gap 0.98.
- **F-02 Exactly once per attempt.** Counterexample, measured: a retry lands twice once the dedup window has passed ([E-44]).
- **F-05 Failover time.** Ceiling, measured: three leader kills left writes waiting 5.2, 5.4 and 7.2 s against 2.5 s ([E-44]). Gap 1.08.
- **F-19 Overload and storms.** Ceiling: 1,000 streams share JetStream's election timer, so they cannot fail over faster than one. Gap 1.08.
- **DEV-07 Deterministic.** Structural: fero owns no step function for JetStream.
- **DEP-12 Group commit.** Ceiling: fsync always syncs each message alone, 3,668 a second, against 50,000. Gap 0.93.
- **DEP-20 npm.** Structural: `npm install fero` brings no log server.
- **TEST-01 Solo, in process.** Structural: a solo test node must swap the log for a stand-in.
- **TEST-09 App steps in the simulator.** Structural: a seed cannot step nats-server.
- **TEST-10 Same kernel bytes.** Structural: the simulator must run a stand-in, never the server's bytes.
- **TEST-13 Outside checkers.** Structural: Maelstrom's partitions cannot cut nats-server's own TCP routes ([E-46]).
- **OPS-11 Debugging in production.** Structural: fero cannot record nats-server's inputs ([E-42]).

## What it does well

- **F-15 (Outside services) is met here and open for all three leading rows** (COMP2, MIN-P+par and TiKV-TS; computed here: `repro diff BUY COMP2 MIN-P+par TiKV-TS`). No object store sits on any of its paths.
- **The floor for two counts.** It has 0 novel mechanisms, as PD and TiKV's shape do. Its 12 interacting pairs are the fewest of any row ([VERDICT 7.6][v76]).
- **Four patterns in 164 lines.** On JetStream, P-01, P-14, P-10 and P-09 passed their main checks through a leader kill. None of 900 writes was lost, exactly one of two sells won in 100 of 100 tries, and 60 lock acquires never overlapped ([E-44]).
- **It is the yardstick for code size.** A Raft-per-group row is about 49 times its lines, and a log-first row about 82 times ([E-44], an estimate).
- **The cheapest row at high load.** Once the upload to the object store is billed, BUY costs $136 a month at 5,000 writes a second on Fly. It keeps no log in the store ([E-41]'s re-check).

## What would change its verdict

- **Nothing.** It "stays out by construction" ([AMENDMENTS 3][am3]). No reading, loss or restatement saves its 27 failures.
- **No kill criterion of [section 9][s9] bears on it.** Its job is to measure the rest. Every row's DEV-05 is reported as a multiple of its lines ([E-44]).
- **Item 20 would add PERF-08.** With PERF-08's phase read the other way, its open PERF-08 fails too (computed here: `repro tally BUY --worded --choice other`).
- **Nothing is owed to it.** Its scorecard lists a majority-loss recovery run on JetStream as "not planned" ([scorecard][card]).

## Twins and neighbours

- **No row ties it.** The closure search leaves BUY's options out: `tools/closure.py`'s search drops the options `theirs` and `outside`, and never starts from BUY. So it has no judged or searched neighbour.
- **The nearest judged rows** differ from it on 17 of the 22 axes or more (EMB-V8 and SLOG; computed for this report: `repro near BUY`).

## The evidence

- [E-44][]: four patterns run on JetStream in 164 fero-owned lines, but ten gaps need fero's own kernel. Failover took 5.2 to 7.2 s against 2.5 s, and a conditional op wasted 34 % of publishes with 8 writers.
- [E-09b][]: with fsync always, JetStream acks one publisher 1,228 times a second, and takes 3,700 messages a second async. At its default it acks 3,280 a second at p99 0.55 ms.
- [E-41][]: $0.60 asleep, $16.14 a month at 10 writes a second (2.9 to 3.1 times the cheapest), and $136 at 5,000 writes a second.
- [E-46][]: Maelstrom carries every message itself, so its partitions cannot reach a server that opens its own routes.
- [E-42][]: BUY, like V4, cannot get the always-on recorder of kernel inputs.

## Links

- **Computed claims.** A claim marked `repro …` is reproduced by that command, run from `docs/v5-space` once `repro` is defined as [the reports' README](README.md#reproduce-a-computed-claim) shows.
- Scorecard: [judging/rows/BUY.md][card]
- SPACE's row: [SPACE 4.1][s41] and [4.2][s42]; as amended: [AMENDMENTS 3][am3]
- VERDICT: [section 2][v2] (every gap ÷ bar), [section 6][v6] (its one-line standing and DEP-21's written reasons), [7.6][v76] (pairs)

[key]: ../VERDICT.md#key-of-terms
[rule]: ../VERDICT.md#1-the-question-and-the-rule
[v2]: ../VERDICT.md#2-outcome-a-the-requirements-as-worded
[v6]: ../VERDICT.md#6-every-other-row
[v76]: ../VERDICT.md#76-dev-02-and-the-models
[s8]: ../VERDICT.md#8-what-the-user-must-confirm
[s9]: ../VERDICT.md#9-the-next-step
[outcome]: ../judging/OUTCOME.md
[outcome.json]: ../judging/outcome.json
[oa2]: ../judging/OUTCOME.md#a2-the-ranking
[card]: ../judging/rows/BUY.md
[s41]: ../SPACE.md#41-the-matrix
[s42]: ../SPACE.md#42-what-each-one-is-and-why-it-stays
[am3]: ../AMENDMENTS.md#3-the-19-rows-as-amended
[E-09b]: ../experiments/E09b-nats/README.md
[E-41]: ../experiments/E41-hosted-cost/README.md
[E-42]: ../experiments/E42-recorder/README.md
[E-44]: ../experiments/E44-outside-log/README.md
[E-46]: ../experiments/E46-maelstrom-raft/README.md
