# E-64 O4: a view sharded by its output key

**Question.** Can a view over every row be split by its **output key** (the bucket a row's answer lands in) across processes, so that each change is routed to the process that owns its new key (and a "leave" to the owner of its old key), with no process holding every row or folding every write? Is what each shard shows exact, through slot moves, router failover, shard moves and rebuilds, a source group down, and late or reordered messages? What does a whole-view read see across shards, and what makes it exact at one cut? What do the routing step and a shard cost?

**Short answer.** Yes, for views whose answer is keyed by a field, and each shard is exact at its own cut; a read of every key is exact at one cut only with a barrier.
- **Exact per shard** *(checked)*: 16 configurations of 1,000 seeds (1 to 16 groups, 1 to 16 shards, both wire forms, a group down, barriers, float and dirty values): 0 seeds failed in 496,000 checks of 178 million rows, through 106,643 slot moves, 79,722 router crashes (26,436 batches lost, 27,362 applied late from a dead router), 26,551 shard crashes and 34,429 shard moves. Three long runs of 50,000 writes each also passed (3,003 checks, 710 slot moves, 474 router crashes, 400 barriers).
- **Each rule is needed** *(checked)*: each planted bug failed 453 to 1,000 of 1,000 seeds (no leave, no chain, skipping a gap, a picture that removes nothing, no hello, shards that pass the barrier, the lean form without barrier markers). One planted rule was **not** needed: re-applying, inside a part that chains, the messages at or below the shard's position (0 of 1,000 seeds failed), since messages carry whole values over a contiguous range.
- **A read of every key without a barrier** sees each shard at its own cut: 0.22 to 0.70 of every 1,000 rows checked were counted twice or nowhere, in 7 to 21 % of checks (0 with one shard). **With the barrier**, 26,928 barriers, 0 wrong; the wait was 5 to 9 steps on average (at most 135 to 199) with every group up, and up to 823 steps while a group was down.
- **Costs** *(measured)*: the router adds 0.35 to 1.3 µs a record on its copy, and 1.7 to 2.8 µs with its messages encoded. A shard of 16 holds 54 to 157 B a row (three fields) against R0's 303 to 354 B a whole row, and takes 1.8 to 5.7 µs a message, decode included, for 0.073 messages a source record: about 0.13 to 0.42 µs of a shard's time per source write, against R0's 2.6 to 15.9 µs (decode not included). The messages are 37 to 38 B a source record over all 16 shards, against 54.7 B for the log record.

## Words

- **Output key.** The key of one piece of a view's answer. Here the view is "per `user`: the row count, the exact sum of `cents`, the largest numeric `score` and the top 3 keys by score", so the output key is the user (a typed bucket key: the number `1` and the string `'1'` are two users).
- **Shard.** One of K processes that own the users hashed to them. A shard holds **every row of its users**, but only the three fields the view reads, in its own `data` store, and keeps each user's answer from `data`'s row deltas.
- **Router.** A `data` sink on a copy of each source group. `data` hands every fold the row before and after (`prev`, data `contract/delta.ts`; E-54). For each changed row the router sends `leave(key)` to the shard of the old user and `row(key, fields)` to the shard of the new user.
- **Part, chain, gap.** A router sends batches; for each source slot a batch covers, it carries a **part**: the range of that slot's positions it covers (from, to] and the messages for this shard (maybe none). A shard applies a part that starts at or below its own position for the slot (it **chains**); a part that starts past it is a **gap**.
- **Picture.** One source slot's rows as its owner copy holds them now, cut down to one shard's users, at the slot's position. It replaces that slot's rows in the shard.
- **Hello.** An empty part at the position the router has routed a slot to (the head, after a restart), sent on every new link and when a slot opens in a group.
- **Full and lean wire forms.** In the **full** form every batch carries a part for every slot it covers to **every** shard, with or without messages for it. In the **lean** form a part goes only to shards with messages, and starts where the last part of that slot sent to that shard ended; empty parts go only as **markers**: when a slot leaves a group (fence) or opens in one, on hello, and for a barrier once the router has routed past its cut.
- **Barrier.** A cut c of the source (one position per slot). Each shard applies up to c and holds the rest; a picture past c raises c for its slot. When every shard is at c, their union is the view at c.
- **Torn.** A row that a whole-view read without a barrier counts twice (two shards hold it) or nowhere (no shard holds it, though it has a user at every shard's cut): shards stand at different cuts.

## Method

All code is in `src/`, JavaScript run by Node 22.22.0, against data at `63fea66` (read only, imported from `../data` next to this repo) and fero v4's codec (`kernel/codec.ts`, read only) for bytes. The exact sum, the total order, typed bucket keys and the numeric projection are E-57 group B's (`../../E57-transforms/b-merge/src/lib.mjs`), already checked there. The row mix is E-64 O2's, so the two options run the same writes.

**The world** (`src/world.mjs`). One source resource of 1,024 slots (E-57's count; fewer slots put more rows in each, the harder case) over G groups. Each group has a log and **one copy: a data store holding only that group's slots' rows**, so no process holds every row. A write is a log entry of 1 to 3 records on one of 600 keys (a whole row, an insert, a field write of the user, the cents, the score or a field the view does not read, a field delete, a row remove), in the dirty domain: users that mix 20 strings with the numbers `1`, `2`, `3` and the strings `'1'`, `'2'`, `'3'`, and rows with no user (in no shard); cents and scores that mix integers, decimals, `null`, strings, `-0`, `NaN` and the infinities. One move in 200 steps hands a slot to another group: a fence entry at the old group, an open entry at the new one, the rows dropped and taken at the copies with the router off. The truth keeps each key's history by slot position, so the oracle can ask for the rows at any cut.

**The sim** (`src/sim.mjs`). Each step: maybe a slot move, one write, faults, each router (with probability 0.7) routes a window of 1 to 8 entries (full form: one batch to every shard; lean form: one batch to each shard that has a part), each link delivers 0 to 2 batches in order, picture requests are served late at the owner copy as it is then, pictures arrive late and out of order. Faults from the seed:
- a **router crash** (1 in 300 steps): its links' queued batches are cut at a random point; the part before arrives later from a dead life, at random times (**zombies**), the rest is lost; the router restarts at the **head** of its group's log with no history and says hello;
- a **shard crash** (1 in 900): its state, its held parts and everything on its way to it are lost; it asks for a picture of every slot, and every router says hello;
- a **shard move** (1 in 700): its state is handed to a new process, but what was on its way to the old one is lost; every router says hello;
- with `--down=1`, **group 0 is down** for the middle half of the run: no writes to its slots, its router stops, its links break (what was sent may still arrive), and picture requests for its slots wait; on return it says hello;
- with `--barrier=250`, a **barrier** every 250 steps, while writes go on;
- with `--wire=lean`, the lean form; at the end of a run each router sends a marker for every slot it holds (a read at the head), since in this form a shard's position on a slot moves only when a part for it arrives.

**The oracle**, written without data except for reading each store's rows: every 50 steps, each shard's rows must equal the true rows at the shard's own cut whose user hashes to it, and each user's count, exact sum, max and top 3 must equal a pure query over those rows. At each barrier, once every shard is at the cut, the union of the shards' rows and answers must equal the view at the cut. At the end, after a drain with no faults, every shard must be at the head of every slot and the union must equal the view; the copies must hold exactly the truth. A seed fails on any mismatch. The run also counts **torn** rows at each periodic check, and how many positions each shard is behind the head.

**Planted bugs** (each must fail at least 100 of 1,000 seeds, else the rule is shown not needed): `noleave` (no leave to the old user's shard), `nochain` (apply every part), `skipgap` (on a gap, apply and jump), `mergepic` (a picture adds rows but removes none), `nohello` (no empty part at the head, on new links or when a slot opens), `barrierpass` (shards do not hold at the barrier's cut), `nobmark` (lean form: no markers for a barrier's cut; a barrier still open after the final drain fails the seed), `nofilter` (a part that chains re-applies the messages at or below the shard's position).

**Costs** (`src/bench.mjs`; three runs, each process alone under the timing lock, as a range). Rows of eight fields (about 100 B encoded), 1,000 users, E-64 O2's mix (25 % whole rows, 30 % cents, 12 % user, 13 % score, 8 % a field the view does not read, 3 % cents deleted, 9 % removes).
- `route`: a copy with 1e5 or 1e6 rows folds 1e6 records in lanes of 256: plain; with the router (K = 16 shards, messages kept as objects); with the messages encoded in fero v4's codec, one frame per shard per lane (`encode`) or one frame per shard once it holds 256 messages (`encode256`). ns a record.
- `r0`: R0's way: one store with every whole row folding every record, with the view kept from data's deltas: count and exact sum per user (`sum`), or also each user's scores in order, for the max and the top 3 (`full`). ns a record; heap a row.
- `shard`: shard 0 of K = 16 (and of K = 4 for `sum`): a store with only its users' rows (three fields), the same view, fed shard 0's frames of 2e6 routed source records, decoded and folded in lanes of about 256 messages. ns a message; heap a row.
- `scan`: a picture's scan at a copy: every row of the store, keep the rows of shard 0 of 16. ns a row.
- `bytes` (not timed): the log in fero v4's codec, frames of 256 records, against the routed messages in frames of 256 per shard, for K = 1, 4, 16, 64.

To re-run: `./run.sh` (sims, mutants, long, bytes, timing, summary), or one part: `./run.sh sims`, `mutants`, `long`, `timing`, `bytes`, `summary`; `./run.sh quick` is a one-minute smoke test with no locks. `SP` names a scratch folder holding `bin/timing` and `bin/heavy`; without it the locks are skipped. `DATA` overrides data's folder.

## Results

The full tables, with every count, are in [results/summary.md](results/summary.md); the raw lines are in `results/*.jsonl`.

### 1. The design: 16 configurations of 1,000 seeds of 1,500 writes (checked)

| wire | groups | shards | domain | group down | barrier every | seeds failed | rows counted twice or nowhere, per 1,000 checked (share of checks with any) | batches a write | pictures a seed (rows) | barriers done / wrong, wait mean and max (steps) |
|---|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 4 | dirty | no | — | 0 of 1,000 | 0.70 (21 %) | 2.79 | 573 (167) | — |
| full | 4 | 1 | dirty | no | — | 0 of 1,000 | 0.00 (0 %) | 0.91 | 502 (566) | — |
| full | 4 | 4 | dirty | no | — | 0 of 1,000 | 0.40 (14 %) | 3.66 | 535 (151) | — |
| full | 4 | 16 | dirty | no | — | 0 of 1,000 | 0.48 (16 %) | 14.62 | 562 (41) | — |
| full | 16 | 4 | dirty | no | — | 0 of 1,000 | 0.37 (13 %) | 3.92 | 505 (144) | — |
| full | 16 | 16 | dirty | no | — | 0 of 1,000 | 0.43 (15 %) | 15.69 | 547 (37) | — |
| full | 4 | 4 | dirty | yes | — | 0 of 1,000 | 0.44 (14 %) | 3.60 | 518 (147) | — |
| full | 4 | 4 | float | no | — | 0 of 1,000 | 0.40 (14 %) | 3.66 | 498 (145) | — |
| full | 4 | 4 | dirty | no | 250 | 0 of 1,000 | 0.40 (13 %) | 3.66 | 533 (151) | 6,000 / 0, 5.0 and 177 |
| full | 16 | 16 | dirty | no | 250 | 0 of 1,000 | 0.43 (15 %) | 15.69 | 543 (37) | 6,000 / 0, 6.8 and 199 |
| full | 4 | 4 | dirty | yes | 250 | 0 of 1,000 | 0.32 (10 %) | 3.60 | 681 (201) | 4,946 / 0, 81.4 and 771 |
| lean | 4 | 4 | dirty | no | — | 0 of 1,000 | 0.27 (9 %) | 1.11 | 1120 (199) | — |
| lean | 16 | 16 | dirty | no | — | 0 of 1,000 | 0.24 (8 %) | 1.30 | 1456 (54) | — |
| lean | 4 | 16 | dirty | yes | — | 0 of 1,000 | 0.35 (11 %) | 1.25 | 4449 (101) | — |
| lean | 4 | 4 | dirty | no | 250 | 0 of 1,000 | 0.35 (12 %) | 1.19 | 848 (188) | 6,000 / 0, 8.8 and 135 |
| lean | 16 | 16 | dirty | yes | 250 | 0 of 1,000 | 0.22 (7 %) | 4.59 | 1211 (152) | 3,982 / 0, 174.9 and 823 |

Over all 16: 16,000 seeds, 24 million writes, 496,000 checks of 178 million rows, 106,643 slot moves, 79,722 router crashes (26,436 batches lost, 27,362 applied late from a dead router), 26,551 shard crashes rebuilt from pictures, 34,429 shard moves with what was on its way lost, 26,928 barriers. **0 seeds failed, 0 barriers wrong, 0 barriers stuck.**

- "Pictures a seed" counts pictures applied; most come from shard rebuilds (one per slot, most of them empty). The lean form takes 1.6 to 8 times as many as the full form: after a router restart every shard behind on one of its slots asks, and an open marker that beats its fence marker causes one more.
- In the lean form a shard's position on a slot moves only when a part for that shard arrives, so "positions behind" in the summary is large (93 to 563) though the shard's rows are as fresh as in the full form: nothing it lacks is for it.

### 2. Planted bugs (1,000 seeds each, 4 groups, 4 shards)

| planted | what it breaks | seeds failed of 1,000 | first failure |
|---|---|---|---|
| `noleave` | no leave to the old user's shard | 1,000 | a periodic check (seed 1, write 100) |
| `nochain` | every part applied, in any order | 981 | a periodic check |
| `skipgap` | on a gap, apply and jump | 983 | a periodic check |
| `mergepic` | a picture adds rows but removes none | 453 | a periodic check |
| `nohello` | no empty part on a new link or when a slot opens | 658 | the end: a shard behind the head |
| `barrierpass` | shards do not hold at the barrier's cut (barrier every 250) | 999 | the barrier's union |
| `nobmark` | lean form: no markers for a barrier's cut | 1,000 | the barrier never completes |
| `nofilter` | inside a part that chains, re-apply messages at or below the shard's position | **0**: not needed | — |

### 3. Long runs (one seed of 50,000 writes each)

| wire | groups | shards | group down | barrier every | failed | checks | slot moves | router crashes | shard crashes | shard moves | barriers done / wrong, wait mean and max | rows counted twice or nowhere, per 1,000 checked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | 4 | 4 | no | 250 | 0 | 1,001 | 222 | 141 | 55 | 67 | 200 / 0, 6.4 and 105 | 0.41 |
| full | 16 | 16 | yes | — | 0 | 1,001 | 231 | 171 | 62 | 74 | — | 0.46 |
| lean | 16 | 16 | no | 250 | 0 | 1,001 | 257 | 162 | 60 | 91 | 200 / 0, 13.4 and 96 | 0.44 |

### 4. Timed costs (three runs, each process alone under the timing lock; ranges over the runs)

A source copy's fold in lanes of 256 records, ns a record, with the router for K = 16 shards:

| rows | plain fold | + router | + router, encoded, a frame per shard per lane | + router, encoded, a frame per 256 messages | router minus plain, paired by run | encoded minus plain, paired by run |
|---|---|---|---|---|---|---|
| 1e5 | 1,321 to 1,728 | 1,931 to 2,080 | 3,024 to 3,652 | 3,402 to 3,752 | +352 to +623 | +1,702 to +2,172 |
| 1e6 | 1,944 to 2,188 | 2,862 to 3,325 | 3,686 to 4,016 | 4,336 to 4,747 | +850 to +1,322 | +1,742 to +2,804 |

One shard of 16 against R0's one store, for the same view:

| rows of the resource | view | R0: ns a record, fold and view (fold alone) | R0: heap a row (+ view) | shard: ns a message, decode included | shard: rows held | shard: heap a row, view included | shard: messages a source record |
|---|---|---|---|---|---|---|---|
| 1e5 | count, exact sum | 2,614 to 2,734 (1,401 to 1,683) | 354 (+4) | 1,842 to 2,649 | 5,848 | 76 to 82 | 0.073 |
| 1e5 | + scores in order | 5,070 to 5,404 (1,547 to 1,710) | 354 (+74) | 2,574 to 2,958 | 5,848 | 154 to 157 | 0.073 |
| 1e6 | count, exact sum | 3,209 to 3,534 (1,953 to 2,275) | 303 (+0) | 2,803 to 3,233 | 59,027 | 54 to 55 | 0.074 |
| 1e6 | + scores in order | 12,906 to 15,867 (2,130 to 2,267) | 303 (+71) | 4,964 to 5,663 | 59,027 | 127 to 128 | 0.074 |

A shard of 4 (count and exact sum): 2,209 to 2,541 ns a message at 1e5 rows (67 to 69 B a row), 2,819 to 3,567 at 1e6 (47 B a row). A picture's scan at a copy (every row, keep one shard's of 16): 8.9 to 11.5 ms at 1e5 rows and 84.7 to 90.4 ms at 1e6, **85 to 115 ns a row**. One-minute load average at process start: 1.02 to 2.43.

### 5. Bytes a source record (fero v4's codec)

| shards | the log record | the routed messages, over all shards | messages a record | of them, a row moving to another shard's key |
|---|---|---|---|---|
| 1 | 54.7 | 33.6 | 0.923 | 0 |
| 4 | 54.7 | 36.4 | 1.179 | 0.256 |
| 16 | 54.7 | 37.1 | 1.243 | 0.320 |
| 64 | 54.7 | 37.3 | 1.259 | 0.336 |

## What it means

- **A view keyed by a field can be split by that key and stay exact per shard**, with four rules (route, chain, picture, hello) and no history: a router that loses its place restarts at the head, and shards that lost something take a picture of one slot, cut for them.
- **The source's copies already have what the router needs.** `data` hands every fold the row before and after, so the leave to the old key costs nothing extra to learn. Without it a router would have to tell every shard, or every shard would keep a directory of where every row is.
- **No marks are needed across the hop** for a view: messages carry whole values, so a replay of a contiguous range is harmless (`nofilter` found the per-message filter not needed), and the chain plus a picture keep each change applied once per shard. Marks come back only for a log re-keyed by another key (the record form).
- **The price of the split is the cut.** Each shard stands at its own cut, so a read of every key counts a moving row twice or not at all, rarely (0.22 to 0.70 per 1,000 rows here). A barrier makes it exact at one cut, at the cost of a wait and of holding what is past the cut.
- **The router is the new cost on the write side**: 0.35 to 1.3 µs a record on one copy of each group, 1.7 to 2.8 µs with its messages encoded. A shard's work per source write is small (0.13 to 0.42 µs at 16 shards), and its memory is the few fields of its own rows (54 to 157 B a row).
- **The lean wire form** (parts only where there are messages) sends 3 to 12 times fewer batches than the full one and takes 1.6 to 8 times as many pictures; it needs markers for a barrier (`nobmark`).

## What this cannot show

- **No network, no Raft, no threads.** Groups are lists in one process, links are queues, a crash is a seeded event, and a step is not a unit of time. A router, the copies and the shards are objects in one process.
- **The wire forms were counted, not timed.** Both forms ran in the sim; their batches, markers and pictures are counts there. The bench timed the router's messages and frames, not the parts' headers or markers on a link. A short wait before a shard asks for a picture, which may remove many of the lean form's extra pictures *(reasoned)*, was not tried.
- **One view, one output field.** Ranges of a sort value (for a global top k or `{ pages }`), a second stage for a view with one output key, a sharded `derive` writing a target resource, and the front that unions shards for a served view are reasoned, not built.
- **Faults are drawn, not exhaustive.** The rules are seeded, not model-checked.
- **Timing quality.** One 4-vCPU VM shared with other studies; the load averages are in the timing file. Differences inside the ranges are not claims.

## Files

- `src/lib.mjs`: the slot and shard hashes, the view's per-user state (`Bucket`, `SumBucket`), the pure view, the row generator.
- `src/world.mjs`: groups, copies on data with their row deltas, slot moves, the truth.
- `src/sim.mjs`: routers, shards, links, faults, the barrier, the oracle; one JSON line per configuration.
- `src/bench.mjs`: the timed costs and the bytes. `src/summarize.mjs`: `results/summary.md`.
- `results/sims.jsonl`, `mutants.jsonl`, `long.jsonl`, `timing.jsonl`, `bytes.jsonl`: one JSON line per run, each after a line with its command and load average. `results/summary.md`: the tables.
