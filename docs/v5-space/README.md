# The v5 design-space study

Start here. This folder asks one question: which design should fero v5 be? The study is finished (2026-11-11). Part 1 is the short answer. Part 2 lists every file in the order to read them. Words follow VERDICT's [key of terms](VERDICT.md#key-of-terms).

## Part 1: the summary

**The question.** The user wants one default primitive that replaces Kafka, Redis, NATS, queues, locks and caches for an app developer. It must beat Redis, NATS JetStream, Kafka, etcd and Redpanda on speed, each timed with its own tool on the same box. It must scale up and down without limit, keep `data` as the state engine (BRIEF item 6), and fit fero deploy and fero test. And it must be quick to build right: few **novel mechanisms**, unlike v4 ([BRIEF.md](BRIEF.md)). A **mechanism** is a piece of stored or replicated state plus the rules that write it. It is novel when no paper or production system has it.

### The answer

**Aim for COMP2: build MIN-P+par's shape first, and add the `memory` rung only if it passes its kill test** ([VERDICT 0](VERDICT.md#0-the-answer)). [API.md](API.md) is its API as first built, and [LAYERS.md](LAYERS.md) its layers.

> **After the owner's answers (2026-11-12).** The owner chose the loose DATA-01 reading and accepts a named test line as a loss when the trade buys something real. On that frame the arithmetic picks **TiKV-persisted**: TiKV's shape with only the `persisted` rung (0 / 5 / 233), with MIN-P+par as the fallback. A `memory` option comes second, behind a timing gate, for one-row writes only ([MEMORY.md](MEMORY.md)). [VERDICT 11.6](VERDICT.md#116-the-owners-answers-2026-11-12) has the detail. The rest of Part 1 still reads on VERDICT's own frame.

- **COMP2 in short.** Raft groups owned by the project hold fixed slots of many resources. One loop on `#meta`'s leader heals replicas and moves slots. `data` folds the rows on every full replica. (A **group** is one Raft log with one leader. A **slot** is a fixed share of a resource's keys. `#meta` is the project's own system group. To **fold** is to turn the log's change records into rows.)
- **MIN-P+par is COMP2 without the `memory` rung.** A **rung** is what a commit means: `persisted` is on disk at a majority, `memory` is in memory at a majority. So the first build always commits to disk.
- **The kill test.** With one write in flight, the `memory` rung needs p99 under about 0.30 ms and at least about 4,340 acks a second. That beats NATS JetStream's default (p99 0.55 ms, 3,280 acks a second, [E-09b](experiments/E09b-nats/README.md)) by more than its spread.

### How sure

- A **MUST** is a requirement part a row must meet. One failed MUST puts the row out. **Open** means not shown either way. A **SHOULD** is a part a row ought to meet.
- **Rule 3** ranks the rows still in. Fewer novel mechanisms wins when they are 2 apart, then more SHOULDs, then fewer **interacting pairs** (two mechanisms that touch the same state).
- **DATA-01** asks that `data` fold the rows the same everywhere. A **loss** is a rival's test line the user lets fero lose, by name (PERF-01). The requirements are read **restated**: AMENDMENTS 1.3 rewrites the clauses that the evidence shows no row can meet as written. Read as written, every row is out.

| DATA-01 reading ([VERDICT 3.2](VERDICT.md#32-all-31-judged-rows-the-matrix); entries: novel / SHOULDs / pairs, open MUSTs) | No loss accepted | JetStream's default test line accepted as a loss |
|---|---|---|
| strict: only `data`'s own code folds the rows on servers | **COMP2**, tied with its twin COMP2 V=full (3 / 6 / 277, 99 open) | MIN-P+par (3 / 6 / 264, 96 open) |
| loose, in force: another engine may fold once a test proves it equals `data` | TiKV-TS (0 / 4 / 244, 122 open) | TiKV-persisted (0 / 5 / 233, 121 open) |

- **VERDICT departs from the reading in force.** The cells as settled follow the loose reading, so rule 3 names TiKV-TS (TiKV's shape). VERDICT names COMP2 because BRIEF item 6 says `data` stays the state engine, and on TiKV's servers it does not ([VERDICT 3.3](VERDICT.md#33-which-data-01-reading-the-brief-supports)). TiKV-TS also leaves 23 more MUSTs open, which rule 3 never counts.
- **What was judged.** 31 rows (whole designs) against 148 requirement parts (132 MUST, 16 SHOULD): 4,588 cells. The 20 **study rows** came first: SPACE's 19 named designs and COMP, their composite. Two blind judges scored each of seven requirement groups, and a referee ruled on every difference. The judges agreed on 88.9 % of those 2,960 cells. The 11 **closure rows** came next: the best mixes of judged options a code search found, plus a few built by hand. Blind judges scored 72 of their cells; the other 1,556 are predicted from the judged rows. So 3,032 cells were judged.
- **What was searched.** 381,087 mixes, on the strict reading. COMP2 rests on no **guessed cell** (a cell no judged row backs). Every mix that beats it has 4 or more. From 4 up, rule 3 goes round in a circle: no row beats all the others ([VERDICT 4.8](VERDICT.md#48-so-could-an-unjudged-mix-beat-comp2)). On the loose reading it circles from 1 guessed cell. At 10 and 11 the only unbeaten rows are TiKV-shaped and rest on 10 or 11 guesses: one row at 10, seven at 11 ([VERDICT 4.4](VERDICT.md#44-step-3-rows-far-from-any-judged-row-win-only-on-guesses)).
- **The lead is thin.** One judged SHOULD (F-22, a damaged log entry) over COMP and MIN-P+m, and 5 pairs over a twin with a separate controller, which rest on one ruling. Three options no judged row holds (D `keys`, X `rampv`, R `vsr`) could still beat it once tested and judged ([VERDICT 4.7](VERDICT.md#47-the-options-no-judged-row-holds)).

### User choices that change the answer

VERDICT's frame is the strict DATA-01 reading, the clauses restated, and no loss accepted. On that frame, the bold items of [VERDICT 8](VERDICT.md#8-what-the-user-must-confirm) below change the answer. Items 3, 16 and 19 (SHOULDs first, open MUSTs counted, F-17's "connected majority") change it only on another frame: the loose reading, the loss, or as worded.

- **Item 15, DATA-01 read loosely:** [TiKV-TS](candidates/TiKV-TS.md) wins, TiKV's shape with 0 novel mechanisms.
- **Item 2, accept losing JetStream's default single-publisher test line (PERF-01):** [MIN-P+par](candidates/MIN-P+par.md) wins, without the rung (TiKV-persisted on the loose reading).
- **Item 5, F_w (writers a resource must reach, 64 now) above 135:** [SPLIT](candidates/SPLIT.md) wins.
- **Item 11, F-15 kept as worded** (a slot move may not wait while the object store is down): SPLIT wins, but only because SPLIT's restore mark has no home in the store yet. The item is mostly about where COMP2's mark lives, which nobody modelled.
- **Item 17, DEP-21's free bar judged awake all month, and the volume ruled structural** (a fail that follows from the design's shape): SPLIT wins. The bar is $2.19 a month for a free project. Awake all month, COMP2's shape costs $2.34, its disk volume $0.15 over; price alone fails no cell.
- **Items 5, 7 and 20 as worded** (SC-03 and SC-10; F-17; or F-07, P-02 or P-13 read the other way): every row is out.

### Risks that could overturn it

The **kill table** ([VERDICT 9](VERDICT.md#9-the-next-step)) lists the results that would overturn the verdict. Here are its first rows, and the F-14 row found after the verdict ([VERDICT 11.5](VERDICT.md#115-after-the-verdict-what-the-layer-write-up-found)):

| Step | The result that kills | What follows |
|---|---|---|
| 6b | the `memory` rung misses the kill test, in TypeScript and native | COMP2 fails PERF-04 (the JetStream line); only an accepted loss keeps a row in: MIN-P+par on the strict reading |
| 2b | the rung inside Raft breaks a MUST that no rule fixes | the rung goes: MIN-P+par, which then needs the PERF-01 loss |
| 2a | `par` fails a MUST with a voter change or on one journal | MIN-P+m (COMP2 with wipe-and-rejoin) |
| 2c | the controller needs 2 or more novel mechanisms, or 19 or more pairs, that leader healing does not | COMP with `par` (each leader heals its group) |
| 2, 5 | a slot move meets a membership change at two member faults and breaks | every slot row at once, COMP2 among them |
| 6a, F-14 | E-07's 5 s main-thread stall, rerun with writes judged on the main thread: writes stop, or commit p99 goes over 5.73 ms | If writes stop, F-14 (user code never stops fero) fails for COMP2 on the strict reading, and for every row that judges writes on `data`'s rows. If p99 goes over 5.73 ms (the 6a row's bar), P-01 and PERF-08 fail in TS. Two untested ways back: a referee ruling, or a watchdog that moves a stalled server's leaderships. If neither works, the strict reading has no row left |

### The next step

1. Get the user's answers to VERDICT 8's bold items. The DATA-01 reading decides the most. Items 2 and 15 are answered ([VERDICT 11.6](VERDICT.md#116-the-owners-answers-2026-11-12)).
2. Write the models COMP2 rests on, with no judging: `par` (2a), the controller (2c) and the slot move (2d). The `memory` rung's model (2b) waits until its spike passes. A **spike** is a quick trial build, made to time one thing.
3. Run the critic's four experiments: D `keys`, X `rampv`, Y `proxy` and R `vsr`. A lead that passes needs a judging pass.
4. Build the thin slice in TypeScript, MIN-P+par's shape: etcd's Raft ported, one controller loop, one journal per process, a 4,096-slot table, client sessions and the `persisted` rung. `par` repairs a damaged journal entry from a peer. `data` folds the rows, with a full copy on every full replica. The `memory` rung is only a spike on it.
5. Break it under chaos: 1,000-seed sim sweeps, Maelstrom and Elle, partial partitions, and LazyFS power cuts. LazyFS is a file system that drops unsynced writes, as a power cut does.
6. Time it against each rival with the rival's own tool on the same box. Step 6b decides whether the rung stays. Also time one fero test rerun with the kernel's state rewound (TEST-07).
7. Time failover and slot moves on three processes.
8. Go native (`ts→rs`) only for the test lines TypeScript does not win.

## Part 2: every file, in reading order

Short on time? Read Part 1, then [VERDICT 0](VERDICT.md#0-the-answer), the [COMP2 report](candidates/COMP2.md) and [API.md](API.md).

| # | File | What it is | When to read it |
|---|---|---|---|
| 1 | [BRIEF.md](BRIEF.md) | the user's request, their six aims, and the rules every agent followed | first: why the study exists |
| 2 | [REQUIREMENTS.md](REQUIREMENTS.md) | the 140 requirements (148 parts) every row is judged against, and the judging rule | to know what "met", "open" and "fails" mean for a cell |
| 3 | [SPACE.md](SPACE.md) | the map: the base case, the 22 axes and their options, the named rows, and how axes constrain each other | to read a row's name or an axis letter |
| 4 | [QUESTIONS.md](QUESTIONS.md) | every open question (Q-01 to Q-46) and the experiment that answers it | before an experiment, to see why it ran |
| 5 | [EVIDENCE.md](EVIDENCE.md) | each experiment's closing answer, word for word, and the experiments that name each requirement | to find the evidence behind one requirement |
| 6 | [AMENDMENTS.md](AMENDMENTS.md) | what the evidence changed in the map: fixes (A-nn), the 19 rows as amended, the composite row COMP, crossings (K-nn) and gaps (G-nn) | when a report cites A-nn, K-nn or G-nn |
| 7 | [MECHANISMS.md](MECHANISMS.md) | the mechanism catalogue: two blind counts of novel mechanisms (DEV-01) and the interacting pairs (DEV-02); its section 2 counts predate the re-rulings RM-01 to RM-08 | when a mechanism count matters |
| 8 | [VERDICT.md](VERDICT.md) | the answer, the arithmetic, the search, how sure, what the user must confirm, the next step, and the skeptics | after Part 1, for the full case |
| 9 | [API.md](API.md) | the public API of COMP2 as first built: every declaration, error and config key, and the code for every pattern | to see what an app developer writes |
| 10 | [LAYERS.md](LAYERS.md) | what each layer, L0 to L5, keeps, does and still owes, with walk-throughs | to see how the design works inside |
| 11 | [MEMORY.md](MEMORY.md) | whether to offer a `memory` option on TiKV's shape: what it buys, what a lost tail breaks, the forms, the rules and the API | after the owner's answers, to see the speed trade |
| 12 | [candidates/](candidates/README.md) | one report per judged row (28 reports for 31 rows), an index, and the `repro` script | to see why any row won or lost |
| 13 | [experiments/](#experiments) | 58 experiment folders, listed below | to check a measurement or a model |
| 14 | [judging/](#judging) | the judges' files, the referee's rulings and the arithmetic, listed below | to check a cell or a count |
| 15 | [tools/](#tools) | the scripts that build every output, listed below | to rebuild a number |

### experiments/

Each folder's README asks one question and has a verdict line ("Q-nn: the answer. Moves: ..."). E-41's README adds a price re-check after its verdict line. All but E-32 have a `run.sh` and a `results/` folder, and 51 have a `fetch.sh`. [TOOLS.md](experiments/TOOLS.md) lists the benchmark tools on the study box; [tools-fetch.sh](experiments/tools-fetch.sh) fetches them again, and [tools/](experiments/tools) holds their smoke test (`smoke.sh`), its sources and its output.

**Floors, language and the fold**
- [E-01 floors](experiments/E01-floors/README.md): this box's fsync and round-trip times. The study's commit bar C is 0.73 ms: a three-writer fsync p99 of 676 µs plus a round-trip p99 of 58 µs (a sum of two p99s, not a floor).
- [E-02 pipeline](experiments/E02-pipeline/README.md): how fast a replication pipeline is in TypeScript, Rust and Go. A TS kernel is viable: p99 4.3 ms at 50,000 appends a second, against a 5.7 ms bar.
- [E-03 napi-cost](experiments/E03-napi-cost/README.md): what a call between JavaScript and Rust costs. 107 ns inside a napi call; under 1 ns a record to hand a 256-record batch to `data`.
- [E-05 fold-cost](experiments/E05-fold-cost/README.md): what `data`'s fold costs. Affordable on every replica: 0.22-1.90 µs a record in 256-record batches.
- [E-07 gc-worker](experiments/E07-gc-worker/README.md): GC pauses, and a kernel on a worker thread. The worker kept write p99 at 4 ms or less through a 5 s main-thread stall.
- [E-43 fold-versions](experiments/E43-fold-versions/README.md): do two `data` versions and two Node versions fold the same? Node 22 and 26 do; two `data` commits that both say SCHEDULE_VERSION 4 do not.

**The competitors on this box**
- [E-09a redis](experiments/E09a-redis/README.md): Redis 7.0 with redis-benchmark. At PERF-02's matched setting (fsync always), SET 88,600 a second at p99 4.6 ms.
- [E-09a2 redis-memtier](experiments/E09a2-redis-memtier/README.md): Redis with memtier_benchmark. It agrees with redis-benchmark within 7 % at pipeline 1; the bar is the memtier Redis row timed in the same session.
- [E-09b nats](experiments/E09b-nats/README.md): NATS 2.10, core and JetStream. JetStream's default acks 3,280 a second at p99 0.55 ms with one client: the line the `memory` rung must beat.
- [E-09c kafka](experiments/E09c-kafka/README.md): Kafka 4.4 with its own tools. 240,043 records of 1 KiB a second at its default; 86,344 matched.
- [E-09d redpanda](experiments/E09d-redpanda/README.md): Redpanda 26.2. 175,420 records of 1 KiB a second, only 1.62 × under E-02's TS ceiling: the thinnest matched margin.
- [E-09e etcd](experiments/E09e-etcd/README.md): etcd 3.5.17 with its own benchmark. 1,118 puts a second at one client, p99 1.73 ms.
- [E-44 outside-log](experiments/E44-outside-log/README.md): how much of fero runs on an outside log (JetStream). Four patterns in 164 lines, but ten gaps need fero's own kernel.
- [E-45 drivers](experiments/E45-drivers/README.md): can each rival's own tool drive fero? Yes for every PERF-02 to PERF-07 line but those named not comparable, through four gateways (RESP, NATS, Kafka, etcd gRPC) in about 1,300 lines of TypeScript.

**The Raft core and its failures**
- [E-10 raft-port](experiments/E10-raft-port/README.md): how big etcd's raft is, and a TypeScript port. The port passes 41 of 41 datadriven files and 4,000 of 4,000 random scripts byte for byte.
- [E-11 many-groups](experiments/E11-many-groups/README.md): the cost of 10 to 10,000 Raft groups in one process. With quiet groups, 2,000 idle groups cost 0.04 % (Rust) to 0.15 % (TS) of a core.
- [E-12 journal](experiments/E12-journal/README.md): one shared journal or one log file per group? The shared journal wins on commit latency from 256 groups up.
- [E-13 handover](experiments/E13-handover/README.md): handover, failover, catch-up, and a slot move's unwritable window (16.7 ms p99 for three commits at 10,000 writes a second).
- [E-37 bad-entry](experiments/E37-bad-entry/README.md): one damaged entry on a voter. Raft as published can lose a committed write; `rejoin` fixes it in 2 rules, `par` in 7.
- [E-38 raft-gray-failures](experiments/E38-raft-gray-failures/README.md): etcd's Raft under partial partitions. Stuck with a connected majority in 5 of 280 cases, and never steps down for slowness.
- [E-38c etcd-iptables](experiments/E38c-etcd-iptables/README.md): three real etcd members with links cut by iptables. Never flapped in 24 runs; a slow leader kept its place for 20 election timeouts.
- [E-46 maelstrom-raft](experiments/E46-maelstrom-raft/README.md): E-10's port as a key-value store under Maelstrom. Linearizable in all 26 clean runs; the planted bug caught in 8 of 8.

**Membership, healing, slot moves and crossings (models)**
- [E-14 membership-on-commit](experiments/E14-membership-on-commit/README.md): membership changes that take effect on commit, checked with TLC. Yes, with one more rule.
- [E-14b membership-liveness](experiments/E14b-membership-liveness/README.md): the same, finished. Yes from three voters up, with one stated limit and two more rules.
- [E-14c membership-completion](experiments/E14c-membership-completion/README.md): the same, completed. Yes, if healing grows the group before it shrinks it.
- [E-15 slot-move-tla](experiments/E15-slot-move-tla/README.md): the slot move in TLA+. It agrees with `slot_move.py` on all 74 runs, but catches only 39 % of the mechanical mutants that change anything (bar 85 %).
- [E-16 controller-loop](experiments/E16-controller-loop/README.md): one controller loop on `#meta`'s leader, or each leader heals its group? The loop is neither smaller nor safer (18 rules against 14).
- [E-17 partitioning](experiments/E17-partitioning/README.md): how many rules each way of mapping partitions onto groups needs. Slot moves need the fewest.
- [E-17b partitioning-part2](experiments/E17b-partitioning-part2/README.md): `pslot`, split + merge, and lanes + range moves on the same harness. Slot moves stay the smallest.
- [E-17c partitioning-rerun](experiments/E17c-partitioning-rerun/README.md): a second agent's rerun. The counts reproduce exactly; on the same footing slot moves and `pslot` both need 28 rules.
- [E-18 slot-balance](experiments/E18-slot-balance/README.md): do 1,024 slots spread load well enough? Use 4,096: 135 effective writers in the worst draw, against 72.
- [E-19 slot-positions](experiments/E19-slot-positions/README.md): what slot-shaped positions cost. +3.9 B a record; a whole-resource cursor is 1.0-3.3 KB delta-coded.
- [E-32 composition](experiments/E32-composition/README.md): does the design hold where its mechanisms meet? The pair list, and one model of the riskiest crossing; DEV-02's MUST stays open for every row.
- [E-33 genesis-restore](experiments/E33-genesis-restore/README.md): does founding make exactly one cluster, and does a restore stay honest? Not as drafted. `fero init` (3 rules) and a conditional create in the object store (4 rules) each hold. A restore stays honest with an epoch above an outside high-water mark and a fresh session generation (8 rules).

**Semantics**
- [E-20 dedup](experiments/E20-dedup/README.md): which dedup option holds exactly once with the fewest rules? Client sessions: 13 rules, against the draft's window at 17.
- [E-21 time](experiments/E21-time/README.md): which time rule gives correct TTLs and safe leases? Writer time as the median of the members' clocks, plus the fence for locks: 7 rules.
- [E-22 api-prototype](experiments/E22-api-prototype/README.md): the API on five kernel operations, under faults. All 22 patterns, after three rules the checkers forced.
- [E-22b real-elle](experiments/E22b-real-elle/README.md): E-22's histories re-checked with real Elle and real Knossos. They confirm E-22's verdicts.
- [E-23 merged-views](experiments/E23-merged-views/README.md): can live views over several groups be merged exactly? Not today; yes with a merge contract in `data`.
- [E-24 sagas-ramp](experiments/E24-sagas-ramp/README.md): sagas with fenced locks, and RAMP. Sagas meet P-15's MUST, but not as drafted; RAMP-Fast leaves fractured reads for fero's operations.
- [E-30 derived-once](experiments/E30-derived-once/README.md): derived outputs exactly once across a long restart. No dedup option alone does it; the cursor kept beside the outputs does (5 rules).
- [E-31 subscribe](experiments/E31-subscribe/README.md): the subscribe protocol across failover, slot moves and relays. Yes, after one rule change.
- [E-47 memory-rung](experiments/E47-memory-rung/README.md): the `memory` rung losing its unsynced tail, on TiKV's shape. Without rules it breaks P-15, P-10 and F-02. Two rule sets fix every break at the model's bounds: refusing transactions, fenced writes and lock rows on memory resources ({R2}), or {R1s, R3, R2.claim}.

**Scale, hosting and client links**
- [E-08 relay-fanout](experiments/E08-relay-fanout/README.md): deliveries a second from one relay core. 0.57-1.50 million in Node with no added wait, and 20.6-32.3 million with 10 ms rounds, against core NATS's 5.8 million per core.
- [E-25 idle-fd](experiments/E25-idle-fd/README.md): the idle failure detector at 100 members. 0.95 % of a core in Node and 0.33 % in Rust, with quiet groups.
- [E-26 dormant-groups](experiments/E26-dormant-groups/README.md): dormant groups for 1,000 sleeping projects. 57 B of memory a group, awake again in 3.3-3.5 ms.
- [E-27 idle-links](experiments/E27-idle-links/README.md): 10,000 idle client links in one Node server. Over TLS 538 MB and 1.63 % of a core, just over the bar.
- [E-34 wake-10gb](experiments/E34-wake-10gb/README.md): waking 10 GB of rows. No for 10 GB of 2 KB rows: 86-122 s in one Node process.
- [E-35 neighbours](experiments/E35-neighbours/README.md): big records and a busy tenant on a shared journal. A 1 MiB record 10 times a second raises others' p99 1.18-1.26 × (bar 1.2 ×).
- [E-36 many-resources](experiments/E36-many-resources/README.md): a project with 100,000 small resources. About 86 KB per idle resource as drafted, 0.4-1.2 KB with MIN-P.
- [E-39 overload-storm](experiments/E39-overload-storm/README.md): twice capacity, and a reconnect storm. Queues and backoff collapse; a client credit window keeps 79-82 % goodput in TS.
- [E-40 browser-client](experiments/E40-browser-client/README.md): a browser or edge worker as a full client. Yes: `data` plus a client is 27.9 KB gzip.
- [E-41 hosted-cost](experiments/E41-hosted-cost/README.md): what each candidate costs the hosted platform. On Fly, after the 2026-11-10 price re-check, $5.17 to $7.89 a month at 10 writes a second for every row that runs inside the app ($7.52 to $7.89 for MIN's and COMP2's shape).

**fero test and durability tiers**
- [E-04 wasm-kernel](experiments/E04-wasm-kernel/README.md): one Rust kernel in WASM for the sim. It meets TEST-01, and a TS and a Rust twin stayed byte-identical over 1,000 seeds.
- [E-06 fork-rewind](experiments/E06-fork-rewind/README.md): fork and rewind for fero test. Yes, by undoing records, not copying: 0.03-0.05 ms at every size.
- [E-28 minio-log](experiments/E28-minio-log/README.md): an object store as the log. A real store puts p99 above 10 × C, so it is a storage tier only.
- [E-29 power-loss-disk-full](experiments/E29-power-loss-disk-full/README.md): the power-loss tier, and a full disk. LazyFS ran 2,640 power cuts with 0 acknowledged batches lost.
- [E-42 recorder](experiments/E42-recorder/README.md): an always-on recorder of kernel inputs. 1.1-1.7 % of a core at 50,000 appends a second; 18 of 18 recordings replayed byte for byte.

### judging/

How every cell was scored, settled and counted. The tools build the outputs; nobody edits them by hand.

- [OUTCOME.md](judging/OUTCOME.md): the outcome as arithmetic for the 20 study rows: the judges' agreement, outcome A (as worded) and outcome B (restated). [outcome.json](judging/outcome.json) holds the same numbers as data. Both are built by `judging.py verdict`.
- [rows/](judging/rows): one scorecard per study row, 20 files: every cell as settled, and whether the judges agreed or a referee ruled. Built by `judging.py rows`.
- **Seven groups, six files each** (P, PERF-DATA, SC, F, DEV, DEP, TEST-OPS): `GROUP.j1.json` and `GROUP.j2.json` (the two blind judges), `GROUP.diff.json` and `GROUP.diff.md` (where they differ, for example [SC.diff.md](judging/SC.diff.md)), `GROUP.rulings.json` (the referee's rulings) and `GROUP.settled.json` (the settled cells).
- [requirements.json](judging/requirements.json): REQUIREMENTS.md parsed into its 148 parts.
- **Mechanisms:** [mechanism-list.json](judging/mechanism-list.json) (each unit, its state and rules), [mechanisms.a.json](judging/mechanisms.a.json) and [mechanisms.b.json](judging/mechanisms.b.json) (the two blind counters), [mechanisms.json](judging/mechanisms.json) (the referee's settlement), and [pairs.json](judging/pairs.json) with [PAIRS.md](judging/PAIRS.md) (the interacting pairs).
- [closure/](judging/closure/README.md): the closure pass, which let code search the mixes between the judged rows. Read its README first.
  - [axes.json](judging/closure/axes.json) writes each row as one option per axis; [attrib/](judging/closure/attrib) says which axes decide each cell; [mechanisms.json](judging/closure/mechanisms.json) and [constraints.json](judging/closure/constraints.json) do the same for mechanisms and for options that force or forbid others.
  - [rerulings.cells.json](judging/closure/rerulings.cells.json) (RR-nn) and [rerulings.mech.json](judging/closure/rerulings.mech.json) (RM-nn, RF-nn): the referee's later re-rulings, applied on top of the settled files.
  - [hybrids/](judging/closure/hybrids): the 11 closure rows. Families A and B each have two blind judges' files and a settled file; [cards.json](judging/closure/hybrids/cards.json) holds each row's full card.
  - [results/](judging/closure/results): [matrix.md](judging/closure/results/matrix.md) (the winner under each mix of the user's choices), 11 `ladder-*.md` files (rule 3 as more guessed cells are allowed, for example [the strict ladder](judging/closure/results/ladder-restated-DATA-01_reading.md)), [frontier.json](judging/closure/results/frontier.json) (the 11 rows sent to blind judges, as the search priced them) and [critic-unheld-options.md](judging/closure/results/critic-unheld-options.md) (the options no judged row holds).
- **The reviews of VERDICT:** [VERDICT.review.json](judging/VERDICT.review.json) (draft 2: skeptics, a price re-check and a fresh reader, V-01 to V-18), [VERDICT.review3.json](judging/VERDICT.review3.json) (draft 3: the referee's summary and file list, the four skeptics' findings A1 to A10, F1 to F8, S1 to S12 and I-1 to I-7, the reviser's summary, and the fresh reader's R1 to R14) and [VERDICT.review4.json](judging/VERDICT.review4.json) (the final recheck, FR1 to FR10, with the referee's and the editor's summaries before it).

### tools/

Run every script from `docs/v5-space`. Python 3, no packages to install. (`tools/__pycache__/` is Python's own cache, ignored by git.)

| Script | What it does | Command |
|---|---|---|
| [judging.py](tools/judging.py) | parses the requirements, checks and compares the judges' files, settles them, counts mechanisms and pairs, and builds OUTCOME and the scorecards | `python3 tools/judging.py verdict` (also `requirements`, `check FILE`, `diff GROUP`, `settle GROUP`, `mechanisms`, `pairs`, `rows`) |
| [closure.py](tools/closure.py) | the closure model: checks the attribution against every judged cell, predicts a row's cells and counts, and runs the search and the ladders | `python3 tools/closure.py check-all` (also `check GROUP`, `check-mech`, `check-cons`, `row`, `card`, `mechrow`, `ladder`, `search`) |
| [closure_matrix.py](tools/closure_matrix.py) | writes the decision matrix over the 31 judged rows | `python3 tools/closure_matrix.py` |
| [closure_ladders.py](tools/closure_ladders.py) | writes the 11 ladder files, one per mix of choices | `python3 tools/closure_ladders.py` |
| [closure_cards.py](tools/closure_cards.py) | builds `hybrids/cards.json` from the two families' settled files | `python3 tools/closure_cards.py` |
| [evidence.py](tools/evidence.py) | builds EVIDENCE.md from each experiment's README | `python3 tools/evidence.py` |

## How to check any number

Every number in this study comes from a file or a tool. These are the commands [VERDICT 10](VERDICT.md#10-how-this-page-was-made-and-what-changed) gives. Run them from `docs/v5-space`. All but `check-all` and `mechrow` rewrite files, so run those on a scratch copy and compare it with the repo:

```sh
python3 tools/closure.py check-all              # 4,588 cells, 0 mismatches, 36 overrides; 112 mechanism entries; 54 constraints
python3 tools/closure_matrix.py                 # rebuilds judging/closure/results/matrix.md
python3 tools/judging.py verdict                # rebuilds judging/OUTCOME.md and outcome.json
python3 tools/closure.py mechrow 'Z=par' COMP              # COMP with par: 296 pairs
python3 tools/closure.py mechrow 'C=cent-co,Z=par' COMP    # COMP2: 277 pairs
python3 tools/closure_ladders.py                # rebuilds the 11 ladder files (slow: about 15 minutes here)
```

`mechrow` reads only the 20 study rows, so it starts from COMP; `row '' COMP2` and `card '' COMP2` read the closure rows too. The other outputs rebuild the same way: `python3 tools/judging.py rows` (the scorecards), `python3 tools/closure_cards.py` (cards.json) and `python3 tools/evidence.py` (EVIDENCE.md).

On 2026-11-11, on a scratch copy, `check-all` and `mechrow` gave those counts, and the matrix, the 11 ladder files, OUTCOME.md, outcome.json, the scorecards, cards.json and EVIDENCE.md rebuilt byte for byte.

**The candidates' `repro` script** checks any claim a candidate report marks "computed". It only calls `tools/closure.py`. Define it in a shell in `docs/v5-space`, then ask:

```sh
repro() { python3 -c "$(awk '/^```python repro$/{f=1;next} /^```$/{f=0} f' candidates/README.md)" "$@"; }
repro rank --strict              # rule 3 among the rows that are in, on VERDICT's frame
repro tally COMP2 TiKV-TS        # a row's failed, open and met MUSTs, SHOULDs and three counts
```

[candidates/README.md](candidates/README.md#reproduce-a-computed-claim) lists every command and flag.
