# Past one process: the merger and the other ways

2026-11-21. In v5 a resource's rows hash into 4,096 slots, and Raft groups own the slots (V5-2). Every feature that works over every row rests today on one rule, R0: one process holds every row and folds every write. That stops at one process's memory and speed. V5-18 pick 2 asks that the way past it be designed now, likely for the first build, once the merger and the other ways to do the job are understood, including whether `derive` can work from changes alone, without holding its whole input. The owner took this page's picks on 2026-11-23 as [V5-20](../DECISIONS.md) items 1, 2 and 10 to 12, with question 2 answered another way: no feature keeps a fixed row ceiling, and [EVERYROW.md](EVERYROW.md)'s limits replace the ceiling this page stated (V5-20 item 3 and its Consequences). [E-67](experiments/E67-merge-rule4/README.md) then ran rule 4 on seeds, and [V5-22](../DECISIONS.md) took the form that passed, a rebuilt merger's floor, and the gap through a rebuild. The page now gives these as decided, keeps its first picks as history, and says what is still owed (sections 6 and 7).

**How it was made.** Four ways were built small in [E-64](experiments/E64-past-one-process/README.md), each with a seeded oracle and planted bugs, and timed: O1 the merger, O2 changes alone, O3 pieces by slot, O4 shards by output key. A comparison picked one. A skeptic then checked the comparison against the code and the records. Its findings held, except two numbers in one of them (section 3.5), and are taken in here. The biggest: the merger, as built, breaks when a partial's host fails while a slot move waits (a probe on O1's own code, now in E-64), and `derive`'s view form fits far fewer buckets than the comparison said.

**Marks.** *(measured)*: timed, three runs, each process alone on the box, a range. *(checked)*: a seeded run with an oracle, or a probe, whose output is in E-64, or in [E-67](experiments/E67-merge-rule4/README.md) where it says so. *(counted)*: a count from a run. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. Each mark names its source: O1 to O4 are E-64's parts; (a), (b) and (c) are E-67's forms of rule 4; G5 and the like are items of [GROUPS.md](GROUPS.md); V5-n are entries of [DECISIONS](../DECISIONS.md).

---

## 0. The answer

1. **Today** every feature over every row needs one process that holds every row: about 1e6 to 5e6 rows and about 5 leaders' writes *(GROUPS G5, G6: checked and reasoned)*.
2. **The merger** splits that work: each group works out its own small piece of the answer next to its own rows, and one server adds the pieces up by key. No process holds every row (section 2).
3. **Every way past one process needs one new piece**: on one copy of each group, each changed row before and after the change. `data` already hands this to every fold *(checked, O1, O2, O4)*.
4. **Pick for the first build, decided:** the merger for views with small answers (top k, counts, sums, min, max, filters, `distinct`), `{ pages }` and plain-data reads (V5-20 item 1). This page also picked a stated one-process ceiling for `hold: 'all'`, `connect()` over everything, code over every row and a live median. V5-20 replaced it with [EVERYROW.md](EVERYROW.md)'s limits: no feature has a fixed row ceiling. A sync read of every row is bounded by this process's `memory` (item 3), one-time work over every row is `scan()` (item 4), live code over every row is a fold per group (item 5), and a live median is a sorted column at the merger (item 6).
5. **Next, not now:** O4, which sends each changed row to the process that owns its answer's key, for views with very many keys, such as a total per user *(checked, O4)*. Decided: O4 comes next, beside the merger (V5-20 item 10).
6. **Fixed:** a failed host during a slot move broke the merger (20 rows true, 15 or 25 shown) *(checked: a probe)*. Rule 4 now passes on seeds, in E-67's form (a): a picture names every half of a slot move between its floor and its own place, with rows or not, and the merger installs it with each half's partner, at one cut. 0 of 4,000 seeds failed *(checked, E-67)*. The floor is the merger's place at a takeover, and one cut of the old merger at a rebuild (section 2, rule 4). V5-22 items 1 and 2 decide both. While a group is down, a rebuilt merger serves nothing new until the group is back (V5-22 item 4).
7. **Stated as a limit:** `derive`'s view form fits about 1e5 buckets at 16 groups as checked, not millions *(measured, O1)*. Decided: a stated bucket limit (about 1.6e5 at 16 groups), `derive`'s record form past it, and O4 next (V5-20 item 10).
8. **Can `derive` work from changes alone? Yes, in two ways.** Already decided: the record form with rows, where each runner keeps only its share's rows (V5-15 pick 4). With no rows at all: yes for counts, sums and averages, if each change carries the old and new values it reads *(checked, O2)*.
9. **Not from changes alone:** `min`, `max` and top k need a rescan near the rows when the best row leaves; a live median needs every value. The log as it is cannot do any of it: a field write carries no row *(checked, O2)*.
10. **Cost:** about +11 to +18 builder rules net on 446 to 503 (V5-22 item 6; this page first counted +9 to +14, before rule 4 ran on seeds), two more `data` 5.0.0 items, and about 4 to 7 weeks of models and measures before the build *(reasoned; the weeks are a guess)*.
11. **Seven questions** for the owner end the page, one per line (section 7). V5-20 answered them, and V5-22 answered the questions E-67 left.

---

## 1. Words

- **Slot.** One of a resource's 4,096 fixed hash buckets; a row's key picks its slot.
- **Group.** One Raft log with one leader. It owns some slots. A resource has several (V5-18 pick 1).
- **Copy.** One server's replica of one group: its log and its rows in memory. Every copy folds every write of its group.
- **To fold.** To apply a committed write to the rows in memory.
- **R0.** Today's rule (TRANSFORMS 3.9): a process that does work over every row holds every row and folds every write of every group.
- **Ceiling.** The size or speed past which one process cannot do that work.
- **Partial.** The view run over part of the rows only: one group's (O1), one slot's (O3), one share's (O2).
- **Merger.** What adds the partials up by key into the answer a client sees (E-23's word).
- **Cut.** One position per group. A merged answer is the query over the rows at one cut.
- **Frame.** What one commit changed in a view. **Picture**: a view's whole state at one position, sent when a stream starts or is replaced.
- **Slot move.** A slot handed from group A to group B: A **fences** it (stops taking it), B **opens** it.
- **Half.** A slot move's frame at one group: A's fence, B's open, or A's **unfence** when B gives up the move. **Host**: the copy that runs a group's partial. **Takeover**: another copy becomes the host, at its own place. **Rebuild**: a new merger, with no part. **Floor**: the place a picture's halves start from (E-67's words).
- **Before-and-after feed.** On one copy of each group, each changed row before and after the change. `data` hands each fold the row before (`prev`).
- **Merge class.** How an operator's partials add up: by rows, by adding, by the best, by the top k (section 2). `data` 5.0.0's item C6 states it per call.
- **Shard.** One of K processes that owns some of a view's output keys (O4). **Share**: a fixed set of slots one runner reads (O2).
- **Torn.** A multi-row commit shown only in part, or a row counted twice or not at all.

---

## 2. What "the merger" is

Today, one process does it all:

```
 every group's writes  ──►  ONE PROCESS: holds every row, folds every write, keeps the view  ──►  clients
```

The merger splits the work in two:

```
  group A's copy              group B's copy              group C's copy
  folds A's writes            folds B's writes            folds C's writes
  PARTIAL over A's rows       PARTIAL over B's rows       PARTIAL over C's rows
  (A's top 10, A's sums)      (B's top 10, B's sums)      (C's top 10, C's sums)
        │ what changed               │ what changed              │ what changed
        └──────────────┬─────────────┴──────────────┬────────────┘
                       ▼
              MERGER (one server, picked by a hash)
              holds 3 × 10 rows, and per bucket the sum of the sums
              answer: the best 10 of the 30; per bucket the total
                       │ one frame per change, shared by every client
                       ▼
                    clients
```

- **A partial** lives on one copy of its group, preferring a copy that leads no group of its resource (V5-20 item 13, where served views live). It costs that copy the view's work over its own group's rows only.
- **Only what changed travels.** For a top 10, a frame comes only when a group's own top 10 changes: 0.0008 to 0.05 frames a write over 1e5 rows with random scores, 0.21 to 0.23 with rising scores *(counted, O1)*. For sums, one small frame every write.

**How the pieces add up**, by merge class (E-23; O1 built each one):

| Class | Operators | A partial sends | The merger keeps |
|---|---|---|---|
| rows | filters | rows in and out | the matching rows |
| add | `length`, `sum`, `avg`, per bucket too | (bucket, value, +1 or −1) from each row's before and after | per bucket a count and an exact sum, and each group's own, for a resync |
| best | `min`, `max` | the group's best per bucket | every group's best per bucket |
| window | a top k (`az`/`za` with n) | the group's top k | the union of every group's top k |
| distinct | `distinct` | per value, the group's smallest key | per value, every group's smallest key |
| bool | `some`, `every` | true or false | a count of groups |
| column | `median`, `quantile`, a sort with no n | — | not live in O1; a read of 17 to 39 trips *(measured, O1)*. A live median or quantile is now a sorted column of that one field at the merger, a part per group (V5-20 item 6; EVERYROW.md 3.3) |
| none | `limit`, `reverse` over unordered rows, `reduce` | — | never across groups: arrival order means nothing there |

**Its rules.**
1. **One cut, never back.** Each group's frames are taken in that group's order; a new picture of a group is taken at or past the merger's place for it.
2. **A slot move's two halves are taken together**: A's fence and B's open at one cut. Taken one by one, rows go missing or count twice: 582 and 321 of 1,000 seeds failed *(checked, O1)*. This is E-23's rule 3. Once moves take their three real steps, it has two more parts (V5-22 item 1). The **closure**: a half's partner can sit behind other halves, and each half met on the way to a partner brings its own; without it 211 and 916 of 1,000 seeds failed. **Keys kept apart**: each group's window and filter rows are kept apart, since a join applies several groups' frames at one cut; without it 97 and 478 failed *(checked, E-67)*.
3. **A resync replaces a group's whole part**: its old part out, the new picture in, as one change. Without the "out": 437 and 429 of 1,000 seeds failed *(checked, O1)*. This is E-23's rule 4.
4. **A picture carries the halves it passed** (decided, V5-22 item 1). When a partial's host fails, a new host takes over at its own place, which may be past its half of a queued move, and the old host's queue is gone. Rule 2 can then never take the pair. In a probe on O1's own code the merger showed 15 rows (A failed) or 25 (B failed) where 20 were true. Installing the picture together with the move's other half gave 20 *(checked: a probe, E-64 `probes/move-failover.mjs`)*. O1's seeded run never made this case: it moved a slot at both groups in one step, and never let a resync's picture pass a queued move *(checked: O1's sim code)*. E-67 made it with real three-step moves: under O1's three rules, 114 to 923 of 1,000 seeds failed, every one with a picture that passed a half *(checked, E-67)*.
   - **The form that passed**, E-67's (a): a picture names every half between its floor and its own place, with rows or not, and the merger installs it with each half's partner, at one cut. 0 of 1,000 seeds failed in each of four worlds *(checked, E-67)*. A half with no rows changes no answer, but if the picture does not name it, its partner waits for ever and the merger wedges.
   - **The floor.** At a takeover it is the merger's place. At a rebuild it is one cut of the old merger: each ack carries the merger's whole cut, each group's copies keep the last one acked to them, and the new merger takes the oldest of the up groups' cuts and tells every host before the pictures. A removed group counts as past every half it held (V5-22 item 2). Each group starting from its own place wedges the merger: 107 and 732 of 1,000 seeds failed *(checked, E-67 `mixedfloor`)*.

E-23 also had "each key from exactly one group". O1 found it never fires once a move's two halves are taken together, fence first (0 of 1,000 seeds failed with it off). But with joins across groups, one entry per key fails: A's write puts key k over B's entry, A's fence then drops k, and k is gone though B holds it *(checked, E-67 `keyowner`)*. So keys are kept apart per group instead (rule 2).

**What it showed.** Through 1,085 paired moves, 403 resyncs, 153 outages and 106 merger rebuilds, 282,540 checks found 0 wrong answers, and each rule's planted bug failed 321 to 1,000 of 1,000 seeds *(checked, O1)*. That holds for the world O1 built, which lacks rule 4's case. With rule 4 in form (a) and rule 2's real form, E-67 found 0 wrong answers in 2,066,979 checks through 93,389 moves, 46,257 takeovers, 7,395 outages and 9,061 merger rebuilds, 2,313 of them while a group was down *(checked, E-67)*.

---

## 3. Each way past one process

### 3.1 R0, today (the baseline)

- **What it is.** One process holds every row and folds every write of every group into one store; `data` keeps the view there.
- **Covers.** Every feature, while the resource fits one process.
- **What a client sees.** One cut, never back.
- **Cost.** 303 to 354 B a row *(measured, O2, O4)*; about 1e6 rows of 2 KB to 5e6 small rows, and at most 16,777,216 rows per `data` source today *(checked: GROUPS G5, E-34)*; `data` 5 lifts that cap with a key index in small tables (V5-21 item 2). About 280,000 writes a second with no view, about one leader's worth with a leaderboard *(reasoned on measured parts: GROUPS G6)*. A server that lacks some groups downloads them first (GROUPS G4).
- **Rules.** R0 to R2: +2 (1 to 4) *(reasoned: TRANSFORMS 8.3)*.

### 3.2 O1, the merger (partials by group)

- **What it is.** Section 2.
- **Covers.** Served views whose operators merge (filters, counts, sums, averages, `min`, `max`, top k, `distinct`, `some`, `every`); `{ pages }` and a plain-data read over every row, by asking every group; `derive`'s view form, with the deriver as the merger. Not: `hold: 'all'`, `connect()` over everything, code over every row, a live median *(checked for the classes built; reasoned for the rest)*. [EVERYROW.md](EVERYROW.md) covers those (V5-20 items 3 to 6), and two of its answers run on this merger: a fold per group, and a live median as a sorted column at the merger.
- **What a client sees.** One cut, never back, no commit half shown *(checked, O1; rule 4's case checked by E-67)*. One more network hop: 20 µs p50, 48 µs p99 on one box *(measured: E-01)*. At a slot move, the two groups' part waits for the move's window plus the slower of the two partial streams *(reasoned: O1's sim)*; that wait is decided (V5-20 item 12). The window is aimed at 10 ms (V5-18 pick 4) and is not yet timed with real bytes *(checked: GROUPS H11)*; timing it is owed (V5-22).
  - **A group held by a down group.** A group whose next half needs a half from a group that is down is held too. Both parts stay frozen at one exact cut, and health names the down group and the groups it holds (V5-22 item 3; 354,490 health checks, 0 wrong, *checked, E-67*). The wait ends when any copy of the down group hosts its partial again, a takeover under rule 4. Giving up a pair whose partner is down failed 81 to 611 of 1,000 seeds *(checked, E-67)*, so it is not built (V5-22 item 3).
  - **Through a merger rebuild.** The frozen part lives in the merger's memory. A merger rebuilt while a group is down has no part for that group, so it serves nothing new until the group is back: the view stays at the old merger's last frame, frozen for every group, and health says why (V5-22 item 4; E-67 section 6.2). In E-67 such a merger served again after 40 to 65 steps on average, against 4.8 to 35.2 with every group up *(counted)*. So V5-20 item 2's "keeps serving" holds while the merger that holds the frozen part lives. The gap is stated, not closed, in the first build; a standby merger is studied later (V5-22 item 4).
- **Cost.**
  - The merger's memory: 0.8 MB for a top 10 and 7.4 MB for a top 100 at 256 groups; sums 394 B per (group, bucket), 631 MB at 1e5 buckets and 16 groups *(measured, O1)*.
  - The merger's speed: a top 10 keeps it nearly idle; a top 100 over 256 groups of 1e5 rows, about 0.5 million writes a second; counts and sums, 0.2 to 0.7 million *(measured, with a reasoned 0.7 µs to decode each frame, O1)*. That is about R0's speed, with no rows held. Its frames to clients are not counted, and would lower it *(reasoned)*.
  - At 50,000 writes a second per leader (PERF-09), about 4 to 14 busy leaders reach that sums limit *(arithmetic)*. Frames per commit batch may cut it (not measured).
  - The partial's copy: the view over its own group's rows. For `min`, `max` and `distinct` the prototype rescans a bucket's rows on each write *(checked: O1's code)*: 514 to 559 µs a record at about 2,000 rows a bucket *(measured, E-67)*. A partial whose max and distinct keep an ordered index per bucket, as `data`'s views do, is owed (V5-22).
  - Bytes a write, as JSON: top 10 0.3 B, sums 52 B, a filter 41.5 B, against 74.7 B for the record *(counted, O1)*.
- **Rules.** +7 (6 to 9) as built, +5 to +8 net *(reasoned, O1)*. With what the skeptic found missing (rule 4, a cheaper resync for big sums, a second level for the view selector's model, health per group, a view over one group's rows) and what E-67 found, about **+11 to +18 net** (V5-22 item 6; E-67 section 7) *(reasoned)*. This page first counted +9 to +14, with rule 4 as one rule and "giving up a pair when its partner is down" as another. Giving up is wrong and is struck (V5-22 item 3). Rule 4 counts +2, the rebuild floor +1 to +2, and rule 2's real form (the closure and keys kept apart) +1 to +2. The net is one lower if keys kept apart only replaces E-23's key rule.

### 3.3 O2, from changes alone (runners by share of slots)

- **What it is.** One copy of each group turns each change into "before and after" of the fields a view reads (an **enriched change**). Runners, one per share of slots (16 shares), read only their share, hold **no rows**, and add the changes up into a small target resource with an exact sum.
- **Covers.** Counts, sums and averages, per bucket or not, with filters in front; `derive`'s view form for those; a top k with a buffer and rescans. Not: `{ pages }`, a median, `group`, code, `hold: 'all'`, `connect()` *(checked for counts, sums, top k; reasoned for the rest)*.
- **What a client sees.** Exact at one cut when a view's buckets sit in one target partition. Spread over 8 partitions, each is exact at its own cut, and 0.07 to 0.36 % of rows show twice or nowhere across them *(checked, O2: 15,000 seeds, 0 wrong)*. It trails by one window and one target commit.
- **Cost.** The enricher adds 0.1 to 0.4 µs a record on the copy; a runner takes 1.6 to 2.1 µs an item and holds no rows; 16 runners work side by side *(measured, O2)*. A top k rescans its share's rows when its buffer runs short: 0 to 10 times per 1e6 changes in most workloads, 70 to 2,104 times when the best row is often removed, 31 to 40 ms each at 1e6 rows *(measured, O2)*.
- **Its catch.** The marks form (D1) needs the old values back to its marks after a restart: in the log, +13.9 B a record (+25.6 %), which V5-12 pick 8 and V5-13 keep out of the log, or rebuilt at a copy, which nothing built *(measured; reasoned)*. The replace form (D2) keeps 16 partials a bucket in the target, so it is not `derive`'s one row per bucket *(reasoned)*.
- **Rules.** +6 to +9, and +1 user rule *(reasoned, O2)*.

### 3.4 O3, partials by slot

- **What it is.** Like O1, but each piece is keyed by (slot, view key) and stamped with the slot's place. A move then needs no pairing and no wait, and a failover replaces slots, never a group's whole part.
- **Covers.** O1's list, for views with few buckets *(checked for counts, sums, max, top 10, a filter)*.
- **What a client sees.** One cut per slot, never back; no wait at a move; 0 wrong answers through 498 host failovers in runs with real three-step moves *(checked, O3)*. But a commit of several rows can show in part during a move: 13 to 22 of about 4,000 with fixed groups, 530 to 552 when groups come and go *(counted, O3)*.
- **Cost.** About 240 B a (slot, bucket) cell: 15.8 MB at 16 buckets, 970 MB at 1,000 *(measured, O3)*. A top 10 over 1e5 rows makes 0.55 to 0.63 frames a write by slot, against 0.0009 to 0.05 by group *(counted, O3)*.
- **Rules.** +6 (5 to 7) *(reasoned, O3)*.

### 3.5 O4, shards by output key

- **What it is.** A router on one copy of each group sends each changed row (only the fields the view reads) to the shard that owns its new key, and a "leave" to the shard of its old key. Each shard runs the view's own operators with `data` as it is.
- **Covers.** Views keyed by a field with any number of keys: counts, sums, averages, `min`, `max`, a window or median per key, `distinct`, `group`; `derive`'s view form as K derivers; a join on a field. Not: a view with one output key (a global total or top k) without a second stage; `hold: 'all'`, `connect()`, code *(checked for one keyed view; reasoned for the rest)*.
- **What a client sees.** Each key exact, each shard at its own cut. A read of every key sees 0.22 to 0.70 of every 1,000 rows twice or nowhere, unless it waits for a barrier; with one, exact *(checked, O4: 16,000 seeds, 26,928 barriers, 0 wrong)*.
- **Cost.** The router adds 1.7 to 2.8 µs a record on its copy, messages encoded; a shard of 16 holds 54 to 157 B a row and spends 0.13 to 0.42 µs a source write *(measured, O4)*.
- **Not built.** The front that joins shards for a client, the shard map, ranges of a sort value (for a global top k or `{ pages }`), and a second stage for one-key views.
- **Rules.** +8 to +12, and +1 to +2 user rules. It needs no new verb, but maybe a new option: `{ view, shards }`, or sharding done by fero past the ceiling, and maybe `get({ cut: true })` *(reasoned, O4)*.
- **With one shard, it is a narrow one-process holder.** One process holds only the fields the views read, fed by the routers. Checked: 4 groups and 1 shard, 1,000 seeds, 7,533 slot moves, 0 failed, 0 torn *(checked, O4)*. It fits about 1.3e7 to 1.7e7 rows in about 2 GB, about 3 times R0, capped by `data`'s 16,777,216 rows a source *(arithmetic on measured bytes)*. Any operator works on it, a live median too, at one cut, with no merge rule per class. But it still folds every write in one process, so its speed is R0's: R0 with the same per-user view and its scores in order took 12.9 to 15.9 µs a write over 1e6 rows, most of it the ordered part *(measured, O4)*. (The skeptic quoted 5.0 to 5.7 µs; that was one shard of 16, holding 59,027 rows.)

### 3.6 Already decided: `derive`'s record form with rows

- **What it is.** `derive(source, target, (e, { row, prev }) => …, { rows: true })`, in the first build (V5-15 pick 4). Each runner reads only its share of the source's changes and folds only its share's rows, so `fn` sees each row before and after.
- **Covers.** Any `derive` whose `fn` can say what to write from one row's before and after, at any size: a total per user is two `op.incr` writes per change.
- **What a client sees.** The target, one marked write per source record, trailing by about one commit.
- **Cost.** One fold per record (0.63 to 1.5 µs) and about 330 B a row of its share *(measured: E-57 A1, E-05)*. It needs the source's `history` for restarts. `op.incr` is exact only for whole numbers: over decimals, sums drifted in 1,000 of 1,000 seeds *(checked, O2's planted `float`)*.
- **Rules.** Nothing new here: it is in the first build already, and owed a build (V5-15).

### 3.7 Smaller ideas, not built in E-64

E-67 later built the ring and a part for the moving slot small, as forms (b) and (c) of rule 4.

- **A ring of partial frames on every copy.** Every copy folds the same log, so it can make the same partial frames and keep the last few. A new host then resumes the old stream instead of sending a picture, and the merger could keep merged sums only (373 B a bucket, not 394 B per group and bucket). E-67 ran it as form (b), and it is not the fix (V5-22, REJECTED). It fixes rule 4's case only with (a) behind it, and never at a rebuild, since a new merger always needs pictures: with the picture alone behind the ring, 16 to 583 of 1,000 seeds failed *(checked, E-67)*. Its cost is paid on every record, on every copy: at 50,000 writes a second per leader, two more copies a group spend 20 to 84 ms of CPU a second for sums, and 0.72 to 2.12 s for a top 10 on the prototype partial (63 to 150 ms at a fold's cost) *(measured and reasoned, E-67)*. And in real time 64 frames hold about 1.3 ms of commits, so a ring would rarely reach back over a failover *(arithmetic, E-67 section 4)*.
- **Pieces by blocks of 16 slots.** If a move always moves whole blocks, a block key needs no pairing and cuts O3's cells about 16 times (970 MB to about 61 MB at 1,000 buckets). It needs slots placed in blocks (E-18) *(reasoned)*. Keys by blocks of slots stay the fallback if the move's wait proves too long (V5-20 item 12).
- **A part for the moving slot** (E-67's form (c)). At each fence the slots' rows go to the merger, which holds them as their own part until the move closes, so a fence never waits for its open. It also failed 0 of 1,000 seeds in every world, and groups waited at a move 2.3 to 13 times less than with (a) *(checked and counted, E-67; sim steps)*. It costs about 2 rules more than (a), and three things at every move: each fence sends the slots' rows, or a picture of them, to the merger (1.1 to 830 KB as JSON per move at 4,096 slots, up to 1e6 rows *(measured)*); the merger holds one more part while the move is open; and every copy of the source group keeps the rows until the move is closed at every cut a new merger could start from. It is the second fallback for the move's wait, beside keys by blocks of slots (V5-22 item 5).
- **A threshold for a big top k.** The merger tells each partial the current k-th best; only rows above it travel. It helps when groups × k nears the row count *(from memory: distributed top-k monitoring)*.
- **Clients that merge the groups themselves.** Each client would need a link to every group and all the rules, browsers too. A relay spreads the merger's sending without that *(reasoned)*.

---

## 4. The comparison

N is rows, G groups, K shards.

| Way | Covers past one process | What a client sees | Memory | Speed of the busiest process | Builder rules | Main risk |
|---|---|---|---|---|---|---|
| **R0** (today) | nothing past it | one cut, never back | every row, 303 to 354 B each | about 0.28 M writes/s; one leader's worth with a leaderboard | +2 (1 to 4) | it is the ceiling |
| **O1** merger | views that merge; pages and plain reads by asking every group; `derive`'s view form | one cut, never back, no half commit; a wait at a move; one more hop | merger: 0.8 MB (top 10); sums 394 B per group and bucket | top 10: nearly idle; sums 0.2 to 0.7 M/s | +11 to +18 net (V5-22 item 6) | many buckets; a rebuild while a group is down serves nothing new (rule 4 passed, E-67) |
| **O2** changes alone | counts, sums, averages; top k with rescans | one cut in one partition; across partitions 0.07 to 0.36 % twice or nowhere | no rows anywhere | 16 runners side by side, 0.5 to 0.6 M/s each | +6 to +9 | restart needs old values in the log |
| **O3** by slot | O1's list, few buckets | one cut per slot; no wait at a move; a commit may show in part | 240 B per slot and bucket (970 MB at 1,000) | sums 0.2 to 0.4 M/s (0.6 to 0.85 as deltas, a form no seed checked) | +6 | cells; torn commits |
| **O4** by output key | keyed views with many keys; per-key windows and medians; joins | each key exact; a read of every key needs a barrier | a shard: N / K rows of few fields, 54 to 157 B each | spreads with K | +8 to +12 | front, shard map, ranges unbuilt; hot keys |
| **O4, one shard** | any operator over a few fields, a live median too, up to about 1.7e7 rows | one cut, never back | 54 to 157 B a row | R0's | O4's four routing rules | still one process's speed |

Marks: the "covers" column is checked for what each part built and reasoned for the rest; "what a client sees" is checked (O1, and rule 4's case by E-67); memory and speed are measured (O1's and O3's speeds add a reasoned decode cost); rules are reasoned, and only O1's count includes what the skeptic and E-67 found. Sources: E-64's O1 to O4, E-67 for O1's rule 4, GROUPS G5 and G6 for R0.

**Combinations.**
- **A: O1 + R0 under a ceiling** (this page's pick for the first build). O1's list past one process; R0 for the rest, under a stated ceiling. About +9 to +14 net as first counted, +11 to +18 after E-67 *(reasoned)*. V5-20 took O1 (item 1) and replaced the ceiling with EVERYROW.md's limits (item 3).
- **B: A now, O4 next** (the target). A, plus keyed views with very many keys. O4 takes the same before-and-after feed, so B grows from A without changing A *(reasoned)*. Decided: O4 comes next, beside the merger (V5-20 item 10).
- **C: O2 for sums + O4 for keyed views + O1 for top k.** Three ways of counting each change once, and three things a client may see, for about +20 to +30 rules *(reasoned)*. Its gain, runners side by side for sums, is real: a busy resource can reach O1's sums limit (section 3.2). The cheaper answer is O1 with frames per batch, then O4 for many keys. Not picked.
- **D: O3's slot key for small views + O1 for the rest.** Buys no wait at a move, for +8 to +11 rules and torn commits *(reasoned)*. Not taken: O3's slot key at a move is rejected (V5-20). If the move's wait proves too long, the fallbacks are keys by blocks of slots (3.7; V5-20 item 12) and (c), a part for the moving slot (3.7; V5-22 item 5). (c) needs no slot placement in blocks and never tears a commit. It pays at every fence: the slots' rows sent to the merger, a part held there while the move is open, and the rows kept on every copy until the move is closed at every kept cut. Which one, if either, is chosen on the timed fence-to-open window; neither is in the first build.

---

## 5. The recommendation

### 5.1 The pick

**For the first build, A: the merger for every whole-resource view that merges, and a stated one-process ceiling for the rest. Then O4 for views with very many keys.** Two things were owed first (section 6): rule 4, run on seeds with real three-step moves; and the merger's state for big sums.

**Decided.** The merger ships in the first build for every whole-resource view that merges (V5-20 item 1), and rule 4 has passed its seeded run (E-67; V5-22 item 1). The ceiling for the rest is not taken: EVERYROW.md's limits replace it (V5-20 item 3 and its Consequences). O4 comes next (V5-20 item 10). The merger's state for big sums is still owed (section 6).

Why: the merger covers the most features, keeps today's promise (one cut, never back), holds no rows, and reuses the served-view machinery. Its weak spot, very many buckets, is exactly O4's strength, and both take the same before-and-after feed.

### 5.2 What runs where

- **A partial per group, per merged view**, on one copy of that group, chosen by a hash. This page first said a copy that is not its leader (V5-14 pick 3's rule, per group); V5-20 item 13 now says where served views live: on any server that holds their rows, preferring one that leads no group of the resource, and until `data` builds views in slices a build can stall a leader's writes. A group with one copy serves its own partials (V5-17 Q32).
- **A merger per view** on one server, chosen by a hash. Clients use it exactly as a served view: the entry, the ring, pictures, `seen`, `SYNC`, the caps.
- **`{ pages }`**: an index per group on its partial's host; a page asks every group for its next `size` entries and keeps the first `size` (one round; decided, V5-20 item 11). The two-round form comes once a pinned read exists.
- **`derive`'s view form**: the deriver is a merger. It holds the buckets, never the source rows.
- **A plain-data chain read once over every row** (on a server, or in a handler): every group answers with its partial; the asker merges.
- **R0** stays only for a sync read of every row (`hold: 'all'`, `f.data.connect()` over the whole resource), bounded by this process's `memory` (V5-20 item 3), and for live code that is not a fold ([EVERYROW.md](EVERYROW.md) 5). This page first kept R0 for code over every row and a live median too. Now one-time code over every row is `scan()` (V5-20 item 4), live code that folds is a fold per group on this merger (item 5), and a live median is a sorted column at the merger (item 6).

### 5.3 What the API promises

1. Over every row, a served view, `{ pages }` and a plain-data read run **at any number of rows** when their operators merge (`data`'s C6 says which). `derive`'s view form does too, up to a stated number of buckets (5.4 item 3; V5-20 item 10).
2. The answer is the query over the rows **at one cut**: never back, and equal as values. TRANSFORMS' user rule 4 stays.
3. Across pages, a row whose sort value changed between fetches may show twice or not at all (as today).
4. While a group's partial is unreachable, a live merged view keeps serving with that group's part frozen at its last place, health names the group, and a one-time fresh read waits (decided, V5-20 item 2; this changes V5-18 pick 5 for live merged views). A group whose next half needs the down group is held with it: both parts stay frozen at one exact cut, and health names the down group and the groups it holds (V5-22 item 3). This holds while the merger that holds the frozen part lives. A merger rebuilt while a group is down serves nothing new until the group is back: the view stays at the old merger's last frame and health says why (V5-22 item 4). The gap is stated, not closed, in the first build; a standby merger is studied later.

### 5.4 What the API states as a limit (API.md 7, SC-10)

1. **Superseded by EVERYROW.md's limits** (V5-20 item 3 and its Consequences). This page first stated a fixed one-process ceiling here: `hold: 'all'`, `f.data.connect()` over the whole resource, code over every row (root code, `ctx.data` code) and a live `median` or `quantile` need the resource in one process, about 1e6 rows of 2 KB to 5e6 small rows, at most 16,777,216 rows a `data` source, and about 5 leaders' writes, one with a leaderboard (GROUPS G5, G6), with a warning at 80 % and `not-held` past it (question 2). Now no feature has a fixed row ceiling. A sync read of every row (`hold: 'all'`, a whole-resource `connect()`) is bounded by this process's `memory`, counted as RSS (about 1.4 M small rows a GB). Health warns at 80 %; a hold that will not fit is refused at open; a live hold that passes the line ends `not-held` and its rows are removed. Near the line, whole-resource holds end first, then a server refuses writes `read-only`. One-time code over every row is `scan()`, live code over every row is a fold per group, and a live median is a sorted column at the merger, none with a row ceiling (V5-20 items 4 to 6). [EVERYROW.md](EVERYROW.md) 6 states the limits.
2. **A root `changes()` reader** decodes every record in one loop: about 1.4e6 records a second *(reasoned: E-03's decode)*. Wider through `consumer()` shares.
3. **`derive`'s view form** keeps every group's sums for each bucket: buckets × groups up to about 2.5 million in 1 GB (about 1.6e5 buckets at 16 groups, 1e4 at 256), and about 0.2 million source writes a second at 1e5 buckets *(arithmetic on measured, O1; the 1 GB budget is a guess)*. Each changed bucket is also one target write (0.748 a source commit, TRANSFORMS 8.1). Past it: the record form with rows (3.6), exact for whole-number amounts. Decided: this bucket limit is stated (about 1.6e5 at 16 groups), for `derive`'s view form and for a fold, with the record form past it and O4 next (V5-20 item 10). The merger's state for big sums, owed in section 6, sets its final numbers.
4. **A top k over many groups** costs more as groups × k nears the row count: a top 100 over 256 groups of 1e5 rows, about 0.5 million writes a second.
5. **A `{ pages }` page** asks every group: groups × `size` entries and one trip each. At 256 groups about 5,000 entries and 1.2 to 2.6 ms of work, so about 400 to 860 pages a second per asking process *(measured and arithmetic, O1)*. One round is decided; the two-round form comes once a pinned read exists (V5-20 item 11).
6. **A median read once over every row** is a read of 17 to 39 trips. This page first said a median is not live; a live median or quantile is now a sorted column of that one field at the merger, exact (V5-20 item 6; EVERYROW.md 6, limit 6).
7. **During a slot move**, the merged view's part from the two groups waits for the move's window plus the slower of their two partial streams (O1's pairing, decided, V5-20 item 12). A group with a move queued to or from an unreachable partial waits with it, frozen at one exact cut, and health names the down group and the groups it holds (V5-22 item 3). If the wait proves too long, keys by blocks of slots or (c), a part for the moving slot, is chosen on the timed fence-to-open window (V5-22 item 5); (c) pays at every fence, as combination D says (section 4).

### 5.5 What changes in the decisions (amended, never deleted)

V5-20 item 1 takes the merger, so these amendments stand as this page's reading, with two changes from the later decisions: EVERYROW.md's limits replace the stated ceiling (V5-20 item 3), and V5-20 item 13 sets where served views live.

**V5-14.**
- *The frame*, "Across partitions there is no merger: a process that runs a view over every row keeps one store fed by slot", becomes: across groups, a view over every row whose operators merge is kept as one partial per group, on a copy that holds the group, and merged by key (E-23's merger, with the rules of section 2). One store fed by slot (R0 to R2) stays only for a sync read of every row and live code that is not a fold, under this process's `memory` (V5-20 item 3; EVERYROW.md 7). This page first kept it for code over every row and a live median too, under a stated ceiling.
- *REJECTED "A merger across partitions"* is superseded. Its reason held only while one process could hold every row. TRANSFORMS 3.9 already named the merger the design for this case.
- *Pick 1* (row guards until D8c): per partial, over one group's rows.
- *Pick 2* (64 per copy, weighted): counts each partial on its host and each merger on its server; the numbers need XA-2 rerun.
- *Pick 3* (one copy by hash, never the leader): per group for partials, and one server by hash for the merger. This page said that answers GROUPS V1 and its question 6; V5-20 item 13 answers them instead, and changes pick 3 itself: a served view lives on any server that holds its rows, preferring one that leads no group of its resource (5.2).
- *Pick 4* (`{ pages }`' one shared index): an index per group; a page is a one-round read of every group (V5-20 item 11).
- *Pick 5* (`derive`'s view form): the deriver follows the merged view; its read barrier is a cut (each source group's place, read after the bumps). Bump, version and lock row unchanged. Its stated bucket limit is 5.4 item 3 (V5-20 item 10).
- *Pick 6* (`data` 5.0.0): two more items. C6 becomes something fero reads; an exact sum hands out its whole state, to add and to take away. G7 (rows by slot) is owed already.

**V5-16.**
- *Pick 2*: "on a server or with `hold: 'all'` that handle sends no subscription of its own" holds only on a server that holds every group (GROUPS G3). `f.data.connect()` over the whole resource is bounded by this process's `memory` (V5-20 item 3) and gets `not-held` past its line. Pick 1's `.value` rule does not change.

**Also settled or touched.**
- V5-18 pick 2 is settled by this page; pick 5 changes for live merged views (V5-20 item 2).
- GROUPS question 3 (a live view past the ceiling): a view that merges or folds has no ceiling; a hold past its `memory` line ends `not-held` (V5-20 item 3; EVERYROW.md 7).
- GROUPS question 12 and API.md question 28 (servers that hold some groups): a plain-data chain at a server's root, read once, runs as a read of every group on every server, a spare too, with no download. One-time root code and `ctx.data` loops read by `scan()`, with no download, and live code that folds runs as a served fold; only a sync read of every row downloads what the server lacks, bounded by that server's `memory` (V5-20 items 3 to 5; EVERYROW.md 7). This page first had code over every row download and keep the ceiling. So "the line works on five servers and throws on the sixth" goes for plain-data chains and for one-time code by `scan()` *(reasoned)*.

---

## 6. What is owed

**Before the build, in order** (sizes are guesses: S up to 2 days, M 3 to 5 days, L 1 to 2 weeks, as GROUPS 4 sizes them):
1. **Rule 4 in O1's seeded run (M). Done by [E-67](experiments/E67-merge-rule4/README.md)** (V5-22 items 1 and 2). Real three-step moves; a new host that starts at its own place; a move that gives up; a partial down while a move to its group waits. It picked "a picture carries its moves", form (a), over a ring of frames on every copy (3.7), and found the rebuild floor. Owed from it: the merger on real sockets (item 5), `data`'s views as the partials (item 4), the move's window timed (item 6), a partial whose max and distinct keep an index (item 7), and the standby merger study (below).
2. **The view selector's model, two levels (L).** E-60 modelled the `view` selector at one level (TRANSFORMS XA-14), and V5-20 takes its count. Widen it to a merger over two partials with a paired move, a resync and rule 4.
3. **The merger's state for big sums (M).** Merged sums only, with the ring or a rebuild on resync; and frames per commit batch (O1 U4, U7). This sets 5.4 item 3's numbers.
4. **Where a partial's rows live (S).** A partial needs a view over one group's rows. Either one `data` store per group in a process, or a view over a set of slots, which is not on `data` 5's list. GROUPS G7 asks for one store per resource; the two must agree. `data`'s views as the partials are owed (V5-22).
5. **The seeded tier on real sockets (M).** Partials on other processes, a slow partial host, a merger that falls behind (O1 U1). Owed (V5-22).
6. **The move's wait on real links**, inside the cut move's timing that V5-18 pick 4 already owes (GROUPS H11). Owed (V5-22). The timed fence-to-open window also picks the fallback for the move's wait, if any: keys by blocks of slots or (c) (V5-22 item 5).
7. **The cap's numbers (S to M).** XA-2 rerun with partials and mergers (O1 U5). The partial host's work for `min`, `max`, `distinct` is timed for the prototype: 514 to 559 µs a record at about 2,000 rows a bucket *(measured, E-67)*. A partial whose max and distinct keep an index per bucket is owed (V5-22).

Also owed on this merger, from [EVERYROW.md](EVERYROW.md) 8: the sorted column at the merger and the merger audit for folds (V5-20 items 5 and 6).

**Later:** a read pinned at one position, for two-round pages and medians (O1 U3); the standby merger study, to close the gap through a rebuild while a group is down (V5-22 item 4); GROUPS V8's rule for a `data` upgrade per group, with a merger in the run; GROUPS G4's download measure for a sync read of every row, the one feature over every row that still downloads (V5-20 item 3); and for O4, hot keys, the front, the shard map, ranges and barriers under load.

**Cost.**
- **Builder rules:** about +11 to +18 net on the first build's 446 to 503, about 2 to 4 % (V5-22 item 6; this page first counted +9 to +14, about 2 to 3 %) *(reasoned)*. It overlaps GROUPS' rows V1, G5 and P4.
- **User rules:** net 0. This page proposed one rule ("views that merge run at any size; holding every row, code over every row and a live median need one process") in place of GROUPS G5's ceiling rule. EVERYROW.md's limit 1 replaces G5's rule instead: a whole-resource hold must fit this process's `memory` (V5-20 item 3).
- **`data` 5.0.0:** C6 read by fero; an exact sum's state, 30 to 50 lines; a merge per class, 100 to 300 lines in `data` or about 150 in fero; G7 owed already *(a guess)*.
- **Time:** about 4 to 7 weeks one after the other, 2 to 4 run side by side, part of it shared with GROUPS' owed models *(a guess, from the sizes above)*. Rule 4's part (item 1) is done.

---

## 7. Questions for the owner, one at a time, most important first

The owner answered these on 2026-11-23, one at a time, in [V5-20](../DECISIONS.md): questions 1, 3, 4, 6 and 7 as picked, and question 2 another way. [V5-22](../DECISIONS.md) then answered the questions E-67 left. The questions stand as they were put; each now ends with what was decided.

1. **The merger in the first build?** Pick: yes, for every whole-resource view that merges, once rule 4 passes its run. Other way: keep R0 under a ceiling in the first build and add the merger later. **Decided:** the pick (V5-20 item 1). Rule 4 has passed its run, so the condition is met (V5-22 item 1).
2. **The ceiling for the rest?** Pick: `hold: 'all'`, `connect()` over everything, code over every row and a live median keep a stated one-process ceiling, warned at 80 %, new ones refused and live ones ended `not-held` past it. Other way: live ones keep running with a health warning until memory runs out. **Decided another way:** no feature has a fixed row ceiling (V5-20 item 3; REJECTED: a fixed row ceiling, this question as written, and keeping a live hold past its line with only a warning). A sync read of every row is bounded by this process's `memory`, counted as RSS; health warns at 80 %, a hold that will not fit is refused at open, and a live hold that passes the line ends `not-held`. One-time work is `scan()`, live code a fold per group, and a live median a sorted column at the merger (V5-20 items 4 to 6; [EVERYROW.md](EVERYROW.md)).
3. **`derive`'s view form with very many buckets (a total per user)?** Pick: a stated limit (about 1.6e5 buckets at 16 groups), with the record form with rows past it, and O4 next. Other way: bring O4 into the first build (+8 to +12 rules, with its front, shard map and ranges still unbuilt). **Decided:** the pick, for `derive`'s view form and for a fold (V5-20 item 10).
4. **A group's partial unreachable?** Pick: the merged view keeps serving with that group at its last place, health names it, and reads past it wait; this changes V5-18 pick 5 for live views. Other way: the whole merged view stops moving until the group is back, as pick 5 reads today. **Decided:** the pick: the view keeps serving with that group's part frozen at its last place, health names the group, and a one-time fresh read waits (V5-20 item 2). V5-22 adds that a group held by the down group waits with it, frozen at one exact cut (item 3), and that a merger rebuilt during the outage serves nothing new until the group is back, the view staying at the old merger's last frame (item 4).
5. **A narrow one-process holder (O4 with one shard) in the first build?** Pick: no; it is O4's first step, raises the ceiling about 3 times, and keeps R0's speed. Other way: yes, for `derive`'s view form and a live median, before O4. **Not asked on its own:** V5-20 leaves it no place in the first build. A live median is a sorted column at the merger (item 6), `derive`'s view form takes the record form past its limit, and O4 comes next, not in the first build (item 10).
6. **`{ pages }` as one round to every group?** Pick: yes (groups × `size` entries a page, about 400 to 860 pages a second per asker at 256 groups), the two-round form once a pinned read exists. Other way: an index kept as its own resource, cut by ranges of the sort value (one trip a page, not built). **Decided:** the pick (V5-20 item 11).
7. **At a slot move, wait or tear?** Pick: O1's pairing, where the two groups' part waits about one move window. Other way: O3's slot key, which never waits but may show part of a multi-row commit and keeps about 230 times the cells (970 MB against 4.2 MB at 1,000 buckets and 16 groups). **Decided:** the pick, with keys by blocks of slots as the fallback if the wait proves too long (V5-20 item 12; O3's slot key is rejected). V5-22 item 5 adds (c), a part for the moving slot, as a second fallback beside it; which one, if either, is chosen on the timed fence-to-open window, and neither is in the first build.
