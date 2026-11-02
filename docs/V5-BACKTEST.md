# v5 backtest: every hard case v4 met, and v5's own

Companion to [DESIGN-V5.md](DESIGN-V5.md). Part 1 maps every hard case recorded in v4's DECISIONS, STATUS, design records and HISTORY to v5. Part 2 lists the hard cases the log-first design brings that v4 never had. Every row becomes a named test in phase 1 (DESIGN-V5 §11).

**Verdicts.** `gone`: the mechanism that caused it does not exist in v5, and the row says what replaces it. `same`: the need is real in any design; the row names v5's mechanism and layer. `open`: v5 needs a decision or a design not yet in DESIGN-V5. `n/a`: tooling, wording or process with no kernel consequence.

## Part 2: hard cases v5 brings

These are the cases a log-first design (a metadata Raft group, BookKeeper-style loglets, and Delos-style chains, with disposable servers) is known to get wrong when built carelessly. Each is a property the TLA+ specs check (phase 1) and a monitor the simulator runs (phase 2). The earlier list, written for in-sync sets, is in git history (commit 9e6f7b8).

| id | Case | v5's answer (DESIGN-V5) |
|---|---|---|
| L-01 | Two servers both try to take over shard 7 (a stale controller decision, or a partition) | Taking over is seal, recover, then a compare-and-swap of the chain in the metadata; exactly one swap succeeds, and the loser's loglet is sealed, so its appends fail (4.2) |
| L-02 | An old writer, cut off, keeps appending | Once E − Q + 1 log nodes have sealed its loglet, no append can reach Q acknowledgements; its in-flight writes were never answered (4.2, 4.3 "no answer before commit") |
| L-03 | A seal races an append in flight | Recovery reads the sealed nodes and re-writes to Q every batch any of them holds, so a committed batch is never lost; an uncommitted one may survive, and a retry finds it by dedup (4.2) |
| L-04 | A batch reached one log node only, then the writer died | Recovery keeps it if a sealed node holds it (re-written to Q), or drops it if none does; either way its writer was never told it committed |
| L-05 | A log node dies during recovery | Recovery needs E − Q + 1 sealed nodes and their reads; with fewer, the shard waits, and `fero recover --unclean` is the only way on, reporting what may be lost (4.2) |
| L-06 | A reader sees a record that recovery later drops | Readers only see records up to the committed point, which only commits make move, and recovery never drops a committed batch |
| L-07 | The metadata group is down | Writers keep appending to their open loglets; only changes (a new writer, a split, a join) wait (4.2 "What the metadata is not") |
| L-08 | The controller fails over in the middle of reassigning shards | Each decision is a metadata entry, and each takeover is a compare-and-swap, so a repeated or stale decision costs one extra handover, never two writers |
| L-09 | A slow but alive server's session lapses | Its loglets are sealed; its next append is refused, so it learns it lost the shard; its pending answers are `unknown`; it re-registers with a new session epoch (4.2) |
| L-10 | A shard splits while writes, subscribers and consumers are in flight | The parent's loglet is sealed at X; writes to it are refused `moved` with the children; cursors resolve through the chain; children inherit the snapshot at X, dedup outcomes and fence tokens (4.2) |
| L-11 | Two shards merge while readers hold cursors on both | Both are sealed; the merged shard continues both offset ranges in the chain; a cursor resolves to its range |
| L-12 | The object store is down or slow | Uploads wait; log nodes keep sealed loglets longer; a log node near full refuses new loglets and they go elsewhere; an alarm says so |
| L-13 | A snapshot is named before its upload finished, or a loglet is deleted before the snapshot covering it is safe | A snapshot is named in the metadata only after its put is confirmed; a loglet copy is deleted only after it is uploaded or covered by a named snapshot (4.1) |
| L-14 | A cold server takes over a large shard | It loads the snapshot and reads the tail before it writes, so writes pause for that long; the controller prefers warm followers, and `standbys` keeps them warm (4.2) |
| L-15 | A log node comes back without its disk | Its identity includes the disk incarnation, so it is a new log node; the loglets it held are re-copied from their other copies or the object store (4.2) |
| L-16 | A fork points at a snapshot that retention later deletes | Forks hold references in the metadata; nothing referenced is deleted |
| L-17 | Writer time jumps on a change of writer | `t = max(last t in the log, clock)`, and a server more than `skew.max` off the controller's clock is not given shards (4.2) |
| L-18 | A retry reaches the new writer after a takeover | The outcomes are in the shard's state, so the new writer has them once it has folded the recovered tail; forwards from a fenced session epoch are refused (4.3) |
| L-19 | Two machines, one crashes | Each loglet has E = 2, Q = 2; the survivor seals (it needs one sealed node: itself) and re-opens each loglet with one copy, which needs the metadata, so two machines need a witness voter (4.2) |
| L-20 | A server that is also a log node crashes, taking both roles at once | Its loglets elsewhere lose one copy each and keep writing at Q; its own shards are sealed using the remaining copies (E − Q + 1 of them) and taken over |
| L-21 | Restart-all of a cluster whose servers are its log nodes | The metadata group re-forms; each open loglet is sealed and recovered as its log nodes return, in any order, as long as a metadata majority and E − Q + 1 copies of each loglet come back |
| L-22 | A noisy project on fero deploy's shared log tier | Per-project quotas on the log tier; each project has its own metadata group, so one project's trouble stays its own |
| L-23 | A `none` resource's writer changes | Its records were never stored, so they are gone; its cursors carry the writer's epoch, and a subscriber whose epoch is gone resumes at `latest` and is told so (3.2) |
| L-24 | A planned handover meets in-flight writes | The old writer stops taking writes, waits for its in-flight batches to commit, then seals at that end; writes that arrive meanwhile get `moved` with the new writer |
| L-25 | Placement keeps choosing a slow server | Placement is a policy over load and latency, not a fixed hash; the controller hands a slow writer's shards over, one at a time |
| L-26 | A server reading old offsets from the object store gets stale data | Segment and snapshot files are written once under unique names and never overwritten, so a read is either the file or nothing |
| L-27 | A split or merge storm under load | The controller changes one shard at a time and paces splits and merges by a budget per minute |

## Part 1: v4's hard cases

Every hard case v4 recorded, with v4's mechanism and v5's answer, is in one file per source:

| File | Source | Rows |
|---|---|---|
| [v5-backtest/decisions.md](v5-backtest/decisions.md) | docs/DECISIONS.md, plus its 102 invariants against v5 | 414 |
| [v5-backtest/status-leave-door.md](v5-backtest/status-leave-door.md) | STATUS.md, docs/DESIGN-LEAVE.md, docs/DESIGN-DOOR.md | 306 |
| [v5-backtest/scale-m6-m7.md](v5-backtest/scale-m6-m7.md) | docs/DESIGN-SCALE.md, DESIGN-M6.md, DESIGN-M7.md, CHECKPOINT.md, plus v4's measured scale numbers | 259 |
| [v5-backtest/history-config-monitors.md](v5-backtest/history-config-monitors.md) | docs/HISTORY.md, DESIGN-DIRECTORY.md, DESIGN-CONFIG.md, sim/monitors.ts, data's SCHEDULE, plus the 36 monitors and 20 clauses against v5 | 334 |

The summary, and the third draft's answers to the rows the second draft left open, are in DESIGN-V5 section 7.
