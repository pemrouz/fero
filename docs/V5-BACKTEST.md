# v5 backtest: every hard case v4 met, and v5's own

Companion to [DESIGN-V5.md](DESIGN-V5.md). Part 1 maps every hard case recorded in v4's DECISIONS, STATUS, design records and HISTORY to v5. Part 2 lists the hard cases v5 brings that v4 never had. Every row becomes a named test in phase 1 (DESIGN-V5 §11).

**Verdicts.** `gone`: the mechanism that caused it does not exist in v5, and the row says what replaces it. `same`: the need is real in any design; the row names v5's mechanism and layer. `open`: v5 needs a decision or a design not yet in DESIGN-V5. `n/a`: tooling, wording or process with no kernel consequence.

## Part 2: hard cases v5 brings

These are the cases a per-shard quorum log with a controller is known to get wrong when built carelessly. Each is a property the TLA+ model checks (phase 1) and a monitor the simulator runs (phase 2).

| id | Case | v5's answer |
|---|---|---|
| N-01 | The controller fails during a shard leader change or an in-sync change | Every controller decision is a metadata record; a new leader acts only after the record that names it commits, with the epoch it carries |
| N-02 | A partitioned old shard leader keeps accepting writes | It cannot commit: commit needs every in-sync replica, and only the controller can shrink the set. With `minInSync: 1` and the set already `{leader}`, the controller cannot elect another leader without an unclean election, which is off. Both sides cannot commit |
| N-03 | A new leader's high-water mark starts below the old one | Subscribers carry cursors; a server answers a cursor only once its own high-water mark has reached it, so nobody sees a position go backwards (Kafka KIP-101/279/320 cases are in the model) |
| N-04 | A follower truncates a record that was committed | Truncation happens only at a divergence point (KIP-101/279/320), and a leader is only chosen from the eligible replicas. A replica that restarted is out of the in-sync set until it has re-fetched (KIP-903). For a `persisted` resource the high-water mark counts only fsynced records, so "a committed record is in every later leader's log" holds even after a power loss; for `committed`, it holds unless the whole in-sync set loses power (DESIGN-V5 §3.2) |
| N-05 | A fresh read served by a deposed leader | `read(key, { fresh: true })` uses the read-index: the leader confirms it is still leader with the in-sync set before answering (DESIGN-V5 §4.5). Local reads are stale by contract, but never older than the reader's own last-seen offsets (§4.4) |
| N-06 | A retried write whose first attempt committed, under a new leader | The attempt id is in the log, so the new leader's dedup window has it and answers with the original offsets |
| N-07 | A retried conditional write is judged again and refused by its own effect | Dedup comes before conditions (DESIGN-V5 §4.3), over the leader's whole log including its uncommitted tail. A refusal is never appended, so a refused attempt is judged afresh on retry; it had no effect |
| N-08 | The dedup window evicts an attempt before the issuer stops retrying | Per issuer and shard, the leader keeps the last 1,024 outcomes, and the issuer keeps at most 1,024 attempts outstanding per shard from its oldest unacknowledged one; every attempt carries a time budget that each hop spends, ending well inside the 5-minute horizon after which a silent issuer is forgotten (DESIGN-V5 §4.3) |
| N-09 | Leader time goes backwards on a leader change, or jumps forward with skew | `t = max(previous t, clock)` per shard, carried in the log; forward skew can expire a TTL early by the skew; leases are fenced (N-15), so skew costs availability, never safety |
| N-10 | A snapshot taken while appends continue is not a state at one offset | Snapshots are taken from a persistent (copy-on-write) state at an offset; the snapshot names its offset and the fold resumes after it |
| N-11 | A follower behind retention can never catch up | It installs a snapshot, then fetches; retention never waits on a replica outside the in-sync set |
| N-12 | Retention deletes a segment a subscriber still reads | A `log` subscriber past retention is refused `expired` with the earliest cursor; a `state` subscriber gets a fresh snapshot |
| N-13 | A shard splits while writers, subscribers and consumers are mid-flight | The split is a record at an offset in the parent; the parent refuses writes after it (`moved`, with the children); the children continue its offsets and inherit its dedup window and fence tokens; cursors resolve through the lineage (phase 5) |
| N-14 | A follow set changes while the shard's leader or replicas move | A subscription is to a member for a set of partitions; when the member stops serving a partition it ends that part of the subscription with the cursor, and the client resubscribes elsewhere |
| N-15 | A lock holder pauses past its lease and writes after the next holder | Writes under a lock carry `if: { fence: token }`; each partition's leader refuses a token below the highest it has seen |
| N-16 | A session lapses during a partition while its client is alive | Its `while: 'session'` rows go, by contract; the client re-creates them on reconnect and is told its session ended |
| N-17 | Two members create the same resource with different options at once | Creation is a metadata record; the second creator's options must hash equal or it is refused with the difference |
| N-18 | A roll runs two code versions; a rule tightened in v2 is bypassed by v1 writers until the roll ends | Stated, not prevented: both hashes are allowed during a roll. A deploy that tightens a rule can ask for a stop-the-world roll instead |
| N-19 | A member returns with an empty or older disk under its old identity | Identity includes the disk's incarnation (v4's boot record). As a replica, it rejoins as a new one and catches up; as a voter, it joins as a learner and the controller replaces its old incarnation by two single-voter changes, so it never votes twice (DESIGN-V5 §4.2) |
| N-20 | fsync fails or a disk lies | The member stops acknowledging (v4's fsyncgate latch) and leaves every in-sync set; the controller moves its shards |
| N-21 | The metadata log grows without bound | Raft snapshots of the metadata state |
| N-22 | Thousands of resources times shards overload the controller | Controller decisions are batched; each member holds a bounded number of replicas; the scale tier (n ≈ 100) pins it |
| N-23 | A relay feeds another relay in a loop | Relays subscribe upstream only to members |
| N-24 | A witness becomes a shard leader | Never: a witness holds no shard replicas by construction |
| N-25 | A clean stop of a shard leader loses its in-flight writes | Controlled shutdown: within `leave.ms`, the leader hands each shard to an in-sync follower (Kafka's) and answers its pending writes `moved`. With no reachable controller, the stop goes like a crash and says so: `destroy()` resolves `false` and the journal records why (DESIGN-V5 §4.2) |

## Part 1: v4's hard cases

Every hard case v4 recorded, with v4's mechanism and v5's answer, is in one file per source:

| File | Source | Rows |
|---|---|---|
| [v5-backtest/decisions.md](v5-backtest/decisions.md) | docs/DECISIONS.md, plus its 102 invariants against v5 | 414 |
| [v5-backtest/status-leave-door.md](v5-backtest/status-leave-door.md) | STATUS.md, docs/DESIGN-LEAVE.md, docs/DESIGN-DOOR.md | 306 |
| [v5-backtest/scale-m6-m7.md](v5-backtest/scale-m6-m7.md) | docs/DESIGN-SCALE.md, DESIGN-M6.md, DESIGN-M7.md, CHECKPOINT.md, plus v4's measured scale numbers | 259 |
| [v5-backtest/history-config-monitors.md](v5-backtest/history-config-monitors.md) | docs/HISTORY.md, DESIGN-DIRECTORY.md, DESIGN-CONFIG.md, sim/monitors.ts, data's SCHEDULE, plus the 36 monitors and 20 clauses against v5 | 334 |

The summary, and the third draft's answers to the rows the second draft left open, are in DESIGN-V5 section 7.
