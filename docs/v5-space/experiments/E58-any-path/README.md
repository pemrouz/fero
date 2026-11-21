# E-58: writes at any path, readers of any part

**The question, in our words.** In `data`, and in fero before v5, you could write at almost any level of a resource: a row, a field, a field inside a field, often the whole thing, or remove any of them (today's `data` already refuses a whole-store update: data:api/index.ts:250-252, *checked*). And code that watched any part of the resource got that part's state and its changes right, whatever level the write came at. That made the protocol small and easy to compose. v5's design talks a lot about rows, because rows decide partitions. Does v5 keep the any-level property everywhere? Or do the rows bring traps or special cases? Where v5 differs from `data`: must it, what does it cost a user, and what should change?

This experiment gives the evidence. [ANYPATH.md](../../ANYPATH.md) weighs it and makes the picks; where the two differ on what to do, ANYPATH.md decides. Revised after a review: the edge and merge runs, the client's counts, the probes and the quick mode are new.

**The short answer.**
1. **The property holds in v5 inside a partition, if every state form takes `data`'s rule.** On `data`'s real engine, 2,000 seeds of mixed writes (the root, a partition and a row replaced; fields and nested fields set and removed; types flipped; ops; batches) gave 0 wrong states, 0 missed changes and 0 wrong "before" values, at every lens level, on the server and on a client that holds only some partitions *(checked, part 1 and 2)*.
2. **v5's own word for the log breaks it.** `changes()` "gives those under the lens", and a whole-row write is above a field, not under it: that reading misses every change a whole-row write makes to a field *(reasoned)*, **74 % to 78 %** of the changes below a row in this mix *(checked, part 1)*. v5's pages state no rule for when a field link runs; the prototypes (E-55, and E-56's `connect` on top) call it **2.3 to 2.6 times per change**, on writes beside the field too *(checked, part 1)*.
3. **`-N` has no single meaning, not even at a row.** A count by key and `data`'s callback land on different commits at `-5` in 28 % to 30 % of lenses at a row or above, and in 64 % to 96 % below a row *(checked, part 1)*. CONNECT.md says it counts "as a callback sees", but the server counts by reading keys.
4. **The rules v5 must keep are the partition rules, and they break nothing inside a partition.** There is no order across partitions, so a write across them lands in pieces, and a reader of two rows sees one changed before the other *(reasoned)*. Part 3 shows it in every one of 20,000 root replaces and 20,000 moves, which follows from how it is built; a loop that wakes every 1 to 4 commits saw it in 63 % and 39 % *(checked, part 3)*.
5. **Three row rules are choices, and each costs users who write fields.** The record form sees no row: a filter on the record alone left the final set wrong in **58 %** of seeds *(checked, part 4)*. A version per row refused **8 % to 45 %** of guarded field writes (11 % to 63 % of its refusals) only because a sibling field changed *(checked, part 5)*. And a room has no plain replace, though one batch does it with 0 half-done states *(checked, part 3)*.
6. **Some shapes v5 is silent on break the state or the wire, and three get past `data`'s own rule** *(checked, shape and edge runs, probes)*: a field write on a string row (spread into the row), holes or named fields in arrays (lost by JSON), a read through a string, an array's `length`, and a key named `__proto__`.
7. **On every copy but the leader, a link on an object value runs again after a whole-row write that left it equal**, since records crossing JSON are new objects. `op.merge` sent as field records removes the case it makes *(checked, merge runs, probe F)*.

## Words

- **Resource**: one named, replicated object. **Root**: the whole of it.
- **Row**: one entry of a resource, a key and a JSON-like value. **Field**: a key inside a row's value. **Nested field**: a field inside a field.
- **Partition**: the rows one leader keeps in one order. With **`depth: 1`** each row is its own partition; with **`depth: 2`** the first key is the partition (a **room**), the second the row.
- **Lens**: an address in a resource, such as `shop.data.w.stock`. A **lens level** is where the address points: the root, a partition, a row, a field, a nested field, an array element, or a path not there yet.
- **Record**: one change on the log, a key path and a value. **Commit**: one leader's batch of records. **The log**: every record, in order (`changes()` reads it).
- **Above, at, below, beside**: where a write lands, seen from a lens. For a lens on `w.stock`, a write to `w` is **above**, to `w.stock` **at**, to `w.stock.x` **below**, to `w.price` **beside**.
- **data's rule**: how `data`'s own per-path reader treats a write (data:api/index.ts:164-224). At or below the lens: a record relative to the lens. Above it: compare the lens's value before and after, by reference; send an update or a remove, or nothing when it is the same object. Beside it: nothing.
- **E-55's rule**: E-55's link calls a row or field lens on every commit that touches its **row** (E-55 proto/lens.mjs:438-442). E-56's `connect` is built on that link (E-56 proto/connect.mjs:86).
- **"under"** and **"near"**: two ways to pick a log reader's records with a key test. "under" takes records at or below the lens (API.md:641 as written). "near" takes records at, above or below it, never beside. "near" is only this experiment's label; it is not the `near` hint that V5-12 removed from the API. ANYPATH.md calls it "on the path".
- **`-N`**: "N commits back", as a start for `changes()` and `past()`.
- **Model**: the truth, a plain JavaScript object kept by this experiment's own code, not by `data` (sim/common.mjs).
- **Road 1, road 2**: two ways to send a commit to a client. Road 1 sends the log records as written. Road 2 sends E-55's `c.recs()`, `data`'s merged change per row.
- **A picture**: what a client that joins now gets: here, the server's row through JSON.

**Marks.** *(measured)*: timed, three runs, each process alone on the box under the timing lock; the range over the runs. *(checked)*: a seeded run, a probe, or a read of the source; the run's line is in `results/`. *(reasoned)*: an argument, nothing ran it. *(a guess)*: nobody measured it. **The mix of writes is made up**: the shares depend on it; the zeros, the holes and the planted-bug failures do not. `API.md:NNN` names a line of API.md at commit ca36cf8, before it was rewritten for V5-13 to V5-15 (`git show ca36cf8:docs/v5-space/API.md`); `CONNECT.md:NNN` and `TRANSFORMS.md:NNN` name lines of those pages as they stand.

## What was built

About 1,450 lines, on `data` 4.0.0 at commit `63fea66` (read only, imported from its TypeScript source as E-55 does) and E-55's prototype store (imported, never edited). Node 22.22.0, on a 4-CPU box ([results/versions.txt](results/versions.txt)).

| File | What it does |
|---|---|
| [sim/common.mjs](sim/common.mjs) | a seeded random source, a deep equality that tells a hole from `undefined`, and the model's write rules, written without `data` |
| [sim/oracle.mjs](sim/oracle.mjs) | parts 1 and 2: random writes at every level, a stand-in leader, and every lens checked after every commit, on the server and on two client folds; modes main, shape, edge and merge |
| [sim/split.mjs](sim/split.mjs) | part 3: a write across partitions, landing one commit per partition |
| [sim/filter.mjs](sim/filter.mjs) | part 4: a filter on the record alone, against one that sees the row |
| [sim/versions.mjs](sim/versions.mjs) | part 5: guarded writes on one field, under three kinds of guard |
| [sim/run.mjs](sim/run.mjs) | runs one part over N seeds and prints one JSON line |
| [bench/replace.mjs](bench/replace.mjs), [bench/rule.mjs](bench/rule.mjs) | the two timings, T1 and T2 |
| [probes/data-v2.mjs](probes/data-v2.mjs) | `data` v2 (the published `data@2.0.0`, used by fero v2 and v3): writes at every level and what each subscriber gets |
| [probes/data-edges.mjs](probes/data-edges.mjs) | `data` v4: an array's `length`, a `__proto__` key, and `op.merge` on a client, each shown once |
| [run.sh](run.sh), [summarize.mjs](summarize.mjs) | runs everything under the locks; writes [results/summary.md](results/summary.md) and [results/probes.txt](results/probes.txt) |

## How each claim was measured

- **The oracle (part 1).** A seed builds a resource at depth 1 or 2 on E-55's store and makes 120 commits. Each write is one of: a row added, replaced, replaced by an equal copy, or turned into a number and back; a field or nested field set; an array element set; a field turned from an object into a primitive and back; a field set to an equal copy; a field, nested field or row removed; `op.incr` on a field and `op.merge` on a row (the leader computes, then appends a plain value: the whole merged row); a batch of 2 to 4 writes inside one partition; a field write on a missing row; an array element removed; and the levels v5 refuses but `data` takes: the root replaced (through `data`'s whole-value `ingest`), and at depth 2 a partition replaced or emptied. A stand-in leader judges each write by v5's refusals (`absent-row`, `sparse-hole`, all or none for a batch) and keeps the log: the records as written. Then 13 lenses are checked: the root, a partition (depth 2), rows (one absent at first), fields, nested fields, an array element, a field inside an element, and paths not there yet. For each lens after each commit:
  - **state**: the engine's value equals the model's;
  - **data's reader** (`data`'s per-path `connect` on a row or below; a raw sink on the root or a partition): it must fire on every change; its records, applied to a copy of the lens's value, must give the model's value; a remove must carry the value before. Each time it fired with an unchanged value is counted by cause and by the write that caused it;
  - **E-55's tap** on the same lens: when it was called, and why when the value had not changed;
  - **the log**: does a change have a record "under" the lens? one "near" it? A log reader that folds only its own lens from the "near" records must keep the model's value;
  - **`-N`**: at the end of the seed, where `-1` and `-5` land under each reading.
- **The wire (part 2).** After each commit, the records go through JSON, are split by partition, and are applied with `data`'s hot lane (data:seam/index.ts:371) on a client fold with its own runtime. The client holds rows `r0` and `r3` at depth 1, and rooms `p0` and `p2` at depth 2. Its lenses (data's readers on the client) are checked against the model the same way, and each time a client reader ran with an unchanged value is counted by cause and by write. Road 2 is checked for state.
- **The shape run.** The same oracle, plus shapes v5 does not define: a field write on a number or string row, an index past an array's end, a named field on an array, and a string where a list stood (so a lens on `list.1` reads a character). Here a broken rule is counted by the write that caused it, not failed, and the model then takes `data`'s rows.
- **The edge run** (added after the review). The main run's writes plus three edges, counted the same way: an element appended at an array's end, read by a lens on `r0.list.length`; a write to `list.length` itself; and a field write at the key `__proto__`, at the row (read by a lens on `r0.p`) or under a field `q` (read by `r0.q.z`). It also checks a client that would join now: its picture is the server's row through JSON.
- **The merge run** (added after the review). The main run exactly (the same seeds give the same writes and the same states), but the leader appends a row's `op.merge` as one field record per merged key when the row exists, and the whole row only when it does not.
- **Parts 3 to 5** are described with their results below.
- **The probes.** [probes/data-v2.mjs](probes/data-v2.mjs) runs on the published `data@2.0.0`, fetched with `npm pack` by `run.sh probes`; [probes/data-edges.mjs](probes/data-edges.mjs) runs on `data` at `63fea66`. Their output is [results/probes.txt](results/probes.txt).
- **Seeds.** 1,000 seeds per run; a seed gives the same run every time.
- **Planted bugs.** Every check has a switch (`E58_MUTATE`) that breaks a rule on purpose, run on the same 1,000 seeds. A check counts only if its real code has 0 failures and its planted bug fails at least 100 seeds.
- **Timing.** T1 and T2 ran three times, each process alone under the timing lock. Inside a process the ways interleave round by round, and a cell is the median of 15 rounds. Load averages at process start: 1.12 to 1.31 *(checked, the `loadavg` fields of [timing.jsonl](results/timing.jsonl))*. The seeded runs are not timed.

## Results

Raw lines: [sims.jsonl](results/sims.jsonl), [mutants.jsonl](results/mutants.jsonl), [timing.jsonl](results/timing.jsonl). Every table, with each lens level apart: [summary.md](results/summary.md). A run made again appends a line; the summary uses the newest line of each run and compares it with the first.

### Part 1: writes at every level, readers at every level

120,000 commits per depth (156,762 records at depth 1, 179,149 at depth 2), 13 lenses each. Among the writes made: 3,991 and 3,962 root replaces, 2,591 partition replaces and 1,400 partitions emptied (depth 2), and about 16,000 batches per depth *(checked)*.

| | depth 1 | depth 2 |
|---|---|---|
| seeds that broke any checked rule (state, data's reader, the "near" fold, the client) | 0 of 1,000 | 0 of 1,000 |
| changes to a lens below a row (field, nested, element, not there yet) | 107,300 | 42,838 |
| data's reader fired | 125,102 | 50,428 |
| of which the value had not changed: a row added without that part (a phantom `undefined`) | 14,886 | 6,475 |
| of which the value had not changed: a new object equal to the old one | 2,916 | 1,115 |
| data's reader missed a change | 0 | 0 |
| E-55's tap called | 278,551 (2.60 per change) | 99,540 (2.32 per change) |
| of which on a write beside the lens | 104,247 | 34,747 |
| of which on a write at, above or below that left the value equal | 67,004 | 21,955 |
| times E-55 handed a row or field lens a commit holding other rows of its room | n/a | 52,493 |
| the "under" reading: changes with no record under the lens | 79,368 (74.0 %) | 33,497 (78.2 %) |
| the "near" reading: changes with no record near the lens | 0 | 0 |
| the "near" reading: hits that left the value equal | 72,971 of 180,271 | 24,988 of 67,826 |

*(checked: [summary.md](results/summary.md), part 1.)* At the row, partition and root levels, every reading saw every change, and data's reader fired with an unchanged value only for a new object equal to the old one (a row written again with the same content).

- **data's rule holds at every level here**, including when the write is at the root or a partition, which v5 refuses. Its records always rebuilt the right value, and every remove carried the value before. The edge run finds three holes in it (below).
- **Its two warts are costs, not wrong answers.** A row add sends `undefined` to a lens whose part the new row lacks (data:api/index.ts:198-201). And it compares by reference, so a new equal object fires (part 2 shows what that costs on a client).
- **The "under" reading is wrong, not just costly.** A row replace or a row remove changes a field but has no record under the field. A log reader that keeps a field from "under" records goes stale.
- **The "near" reading is exact.** A reader that folds only its lens from "near" records matched the model after all 240,000 commits. Its cost: 37 % to 40 % of its hits leave the value equal, and a record above the lens holds a whole row, so the reader must fold.
- **E-55's 2.3 to 2.6 calls per change are the prototype's choice.** v5's pages state no rule for when a field link runs.

**`-N`.** Pairs of (seed, lens) where the readings land on different commits *(checked)*:

| N | depth | lenses | data vs value changed | E-55 vs data | near vs data | under vs data | near vs value changed |
|---|---|---|---|---|---|---|---|
| 5 | 1 | at a row or above | 26.3 % | 0.0 % | 27.6 % | 27.6 % | 47.1 % |
| 5 | 2 | at a row or above | 20.1 % | 0.0 % | 29.8 % | 29.8 % | 44.0 % |
| 1 | 1 | below a row | 22.5 % | 51.8 % | 39.4 % | 88.1 % | 46.0 % |
| 5 | 1 | below a row | 53.3 % | 95.9 % | 78.4 % | 95.5 % | 86.3 % |
| 1 | 2 | below a row | 23.6 % | 43.8 % | 36.6 % | 89.8 % | 43.5 % |
| 5 | 2 | below a row | 39.8 % | 85.9 % | 64.3 % | 72.6 % | 73.7 % |

So "`-5` counts commits as a callback on the same lens sees them" (CONNECT.md:60, 215) holds only if the server counts with the callback's own rule. A key test, which is what the server can do cheaply (CONNECT.md:217), lands elsewhere even at a row or above, where "under" and "near" are the same: 28 % to 30 % of lenses at `-5`.

### Part 2: the same records over a stand-in wire

- Road 1 sent 75,620 records (depth 1) and 117,241 (depth 2) to the client; 81,142 and 61,908 records of partitions it does not hold stayed back. Road 2 sent 58,365 and 101,006 *(checked)*.
- **0 failures** on the client: state, firing and records at every held lens, on both depths, on both roads; 0 lane rejects *(checked)*.
- So a client that holds only some partitions, fed the log records as written, keeps every lens exact. No wire change is needed for any reader rule here.
- **But it runs more often than the server** *(checked, the main and merge runs; added after the review)*. data's rule compares by reference, and a record that crossed JSON is a new object. Below a row, the client's reader ran for a new equal object **3,454** (depth 1) and **1,220** (depth 2) times, against 2,916 and 1,115 on the server; 947 and 221 of the client's came right after an `op.merge` sent as the whole merged row. In the merge run, with `op.merge` sent as field records, the client and the server ran the same: 2,550 and 1,068, and 2 and 4 after an `op.merge` (a merge on a missing row is still a whole row). The merge run broke no check: 0 of 1,000 seeds at each depth. Probe F shows it once: 100 merges of `{ b }` on a client ran a link on the unchanged `r0.a` 100 times as whole rows, 0 times as field records. The same holds on every server copy but the leader, since it too applies records that crossed the wire *(reasoned)*.

### Shapes v5 does not define

*(checked, the shape runs, 1,000 seeds per depth)*

- **A field write on a string row** (304 made alone over both depths, and 87 batches holding one): `data` spread the string into the row in all 304, and in 53 of the 87 batches (in the others a later write in the batch replaced the row): `'abc'` became `{0:'a',1:'b',2:'c',x:…}` on the server and on every client (data:kernel/node.ts:277: clause 10c cleans parents, not the row itself). A field write on a number row (1,555 writes plus 480 in batches) made a clean `{x:…}`, as the model did.
- **A hole or a named field on an array** (2,098 writes past an array's end, 2,169 named fields, plus about 1,800 in batches) replicated fine as field records. They broke the client only when a whole row holding them crossed JSON later. On road 1, a client lens newly differed from the server 191 times (depth 1) and 157 (depth 2), each right after a whole-row write (`op.merge` or an equal copy) of a row that held one. On road 2, 392 and 424 times, also after batches, whose field writes road 2 merges into whole rows. A remove at a hole was a no-op on the server but threw `sparse-hole` on the client, where JSON had made the hole a `null`: 3 times per depth.
- **A lens that reads through a string** (`list.1` when `list` is `'abc'`): when a sibling write turned the string into an object, the character went away with no record at, above or below the lens. data's reader missed 34 such changes, and the "near" log reader 37. This is the first of three holes in data's rule found here.

### Edges of data's rule (added after the review)

*(checked, the edge runs, 1,000 seeds per depth; [probes/data-edges.mjs](probes/data-edges.mjs) A to E)* Each is a change with no record at, above or below the lens, so data's reader and the "near" log reader both miss it.

| | depth 1 | depth 2 |
|---|---|---|
| writes: an element appended at the end; a write to `length`; a `__proto__` key at the row; under `q` (alone + in batches) | 322 + 158; 665 + 307; 1,058 + 467; 1,109 + 472 | 308 + 143; 592 + 309; 1,092 + 471; 1,044 + 508 |
| a lens on `r0.list.length` missed an append | 80 | 35 |
| a lens on an element missed a cut by a write to `length` | 259 | 67 |
| a lens on `r0.p` missed the value a `__proto__` write gave | 242 | 125 |
| the same lens missed it going away at the row's next ordinary write (`data` copies only the row's own keys) | 141 | 86 |
| a lens on `r0.q.z` missed a write at `q.__proto__` | 219 | 96 |
| a client joining now (its picture through JSON) read another value than the server, on `r0.p` and on `r0.q.z` | 266, 258 | 147, 116 |

- **An array's `length`** is the second hole: an append at the end is beside a lens on `length`. A write to `length` is a named field on an array, which DESIGN-V5.md:1134 already refuses.
- **A key `__proto__`** is the third: `data`'s copy-on-write assigns it (data:kernel/node.ts:292), which sets the copy's prototype. The row's own keys do not change, so JSON drops the value. Nothing outside the row changes, since `data` copies on write (probe D: `({}).p` stays `undefined`).
- Inside a batch, `data` merges a row's writes into one change, often at the row itself, and then the diff above the lens catches some of these: that is why the batch counts are lower.

### Part 3: a write across partitions

*(checked, 1,000 seeds)*

- **A. A root replace at depth 1** over 2 to 8 partitions, landing one commit per partition in a random order with other writes in between: 20,000 replaces. A callback on two rows saw a half-done state in **20,000 (100 %)**. That share follows from how the run is built: both rows always change, in separate commits *(reasoned; the run shows it)*. A loop that wakes after 1 to 4 commits (a made-up interval) saw one in 12,629 (63.1 %). A whole-resource callback saw 106,128 half-done states, 5.31 per replace.
- **B. A row moved between two rooms** (a remove in one, an add in the other): 20,000 moves. A callback on both rooms saw the row in both or in neither in **20,000 (100 %)**, again by construction; the loop in 7,818 (39.1 %).
- **C. A room replaced as one batch** inside the room: 20,000 replaces, **0** half-done states (planted: row by row, 1,000 of 1,000 seeds fail).

### Part 4: a filter on the record alone

8 rows `{ stock, price, name }`, 200 records a seed: 117,305 of 200,000 records are field-only *(checked, 1,000 seeds)*.

| filter | rows entering the filter it never saw | rows leaving it never saw | seeds with a wrong final set | records the "docs" form misjudged (of the field-only records) |
|---|---|---|---|---|
| `stock > 0` | 11,549 of 41,096 (28 %) | 15,267 of 38,493 (40 %) | 582 of 1,000 | 76,291 (65.0 %) |
| `stock > 0 && price < 50` | 12,385 of 29,761 (42 %) | 14,220 of 28,440 (50 %) | 584 of 1,000 | 37,914 (32.3 %) |

- The "docs" form is `if (e.value && filter(e.value))`, the shape P-16, P-17 and `derive`'s record form use (API.md:646; TRANSFORMS.md:209, 432). It never misjudged a whole-row record or a row remove; every miss was a field record.
- **The set-level columns show the harm.** "Misjudged" counts every field record after which the filter holds, since the docs form says "no" to all of them; a consumer of that form ignores field records rather than taking the row out. So that column mostly measures how often the filter is true, which is why the tighter filter scores lower.
- The pages already say to write each fact whole, once (API.md:703, 2181; TRANSFORMS.md:209, 432). Nothing checks it.
- **Two fixes, both exact (0 misjudged in 1,000 seeds).** One folds the row (the record form with rows, TRANSFORMS 3.4). The other keeps only the fields the filter reads, per row key, from the records: 3,423 and 7,167 values kept at the end of all 1,000 seeds, against whole rows.

### Part 5: a version per row

3 rows, 400 steps a seed, about 118,600 guarded writes per run. A guarded writer reads `stock` and its version, then writes 1 to 6 commits later *(checked, 1,000 seeds per share; a model of the leader's guard)*.

| share of other writes that hit a sibling field | guarded writes | row guard refused | refused only because a sibling changed: of the guarded writes (of the refusals) | a field guard refused | `if: { equals }` on the field refused |
|---|---|---|---|---|---|
| 20 % | 118,637 | 84,986 (71.6 %) | 9,162: 7.7 % (10.8 %) | 75,824 | 60,278 |
| 50 % | 118,554 | 85,089 (71.8 %) | 27,566: 23.3 % (32.4 %) | 57,523 | 45,338 |
| 80 % | 119,097 | 85,424 (71.7 %) | 54,021: 45.4 % (63.2 %) | 31,403 | 24,313 |

- The field guard (a version moved by writes at, above or below the field) refused exactly the true conflicts and never let one through. Planted: not moved by whole-row writes, it let a lost update through in 1,000 of 1,000 seeds.
- `equals` passed 7,090 to 15,546 writes after the field changed and changed back. That is safe for a write computed only from the field's value, as `set(fn)` on a field is *(reasoned)*.

### Planted bugs

All 17 planted bugs failed **1,000 of 1,000** seeds *(checked, [mutants.jsonl](results/mutants.jsonl))*: a row write merged into the old row (how fero v2 and v3 let a row write and a field write "merge", the bug V4-18 fixed), a field changed in place, a reader that keeps only "under" commits, a remove without its value before, a log reader that takes a beside record as its own, a wire that drops field records (each at depth 1 and 2); a room replace row by row; a filter that reads the row before the record; a field version not moved by whole-row writes; and, in the merge run, a remove without its value before and a wire that drops field records. The merged-row bug breaks the server's own fold against the model; with one process and one order, this experiment cannot show copies drifting apart.

### Timing

*(measured, [summary.md](results/summary.md))*

**T1: a room replaced as one batch, or row by row**, on `data` with one link on the room and one on a field. This times `data`'s fold only: "row by row" is one local `data` commit per row. In v5, writes made together already leave in one frame and share disk syncs (API.md:132), and a `batch` that names the keys costs what a room write costs. So T1 is not the gain of a room write; knowing the keys at the leader is *(reasoned)*.

| rows | one batch | row by row | ratio | link calls (batch, row by row) |
|---|---|---|---|---|
| 10 | 2.07 to 2.99 µs | 9.01 to 10.77 µs | 3.6 to 4.4 | 1, 10 |
| 100 | 16.3 to 23.0 µs | 91.7 to 126.1 µs | 5.5 to 5.9 | 1, 100 |
| 1,000 | 535 to 558 µs | 1,241 to 1,504 µs | 2.3 to 2.7 | 1, 1,000 |

**T2: what data's rule costs a field link**, on E-55's tap, one row of 20 number fields, each commit writing one field at random.

| links | per link per commit, E-55's rule | per link per commit, data's rule | data's minus E-55's | callbacks per commit (E-55, data's rule) |
|---|---|---|---|---|
| 10 | 20.9 to 38.3 ns | 28.9 to 38.7 ns | −2.6 to +8.0 ns | 10, 0.59 |
| 100 | 15.6 to 17.5 ns | 24.1 to 27.5 ns | +6.7 to +11.2 ns | 100, 5 |

So data's rule costs at most about 11 ns a link a commit over E-55's, and calls the user's function far less often here. The fields are numbers: an object field on a client also runs for writes above it that left it equal (part 2).

## Where v5 differs from data, and what to do

The "What to do" column is this experiment's reading; [ANYPATH.md](../../ANYPATH.md) makes the picks, and decides where the two differ.

| # | Where v5 differs | Must it? | What it costs a user | What to do |
|---|---|---|---|---|
| 1 | No write at the root (API.md:271) | **yes**: the root spans partitions, which share no order. A split write lands in pieces (part 3 A, B) | little: `data` refuses a whole-store `update` too (data:api/index.ts:250-252) | keep it. Give the type error a message that names the way |
| 2 | No write at a partition at depth 2 (API.md:271) | no: a room is one partition, so one batch replaces it with 0 half-done states (part 3 C) | "replace this room" or "empty this room" needs known keys or the admin act `fero.erase` | add `room.set(rows)` and `room.remove()` as one batch the leader expands: the leader knows the keys, one link call (ANYPATH P3) |
| 3 | `changes()` gives records "under the lens" (API.md:641; question 19 at API.md:2312) | no | **wrong answers** below a row: every change a whole-row write makes (part 1) | give every record at, above or below the lens ("near", which ANYPATH calls "on the path"), exact; or stop the log forms at the row, where "under" is exact. ANYPATH P2 first took the second; the owner chose the first ([V5-15](../../../DECISIONS.md) pick 2) |
| 4 | No stated rule for a link below a row (CONNECT.md:7, 176 speak of rows) | no | the prototype calls a field link 2.3 to 2.6 times per change (part 1) | write data's rule into API 3.10 for `connect(fn)`, a loop turn and `past`'s values: +7 to +11 ns a link a commit (T2); say "changed" means a new object (part 2) |
| 5 | `-N` "as a callback sees" (CONNECT.md:60, 215), counted by keys (CONNECT.md:217) | no | `-5` lands elsewhere than the callback's unit in 28 % to 30 % of lenses at a row or above, 64 % to 78 % below (part 1) | say plainly that `-N` is a key count; drop "the unit a callback sees" |
| 6 | `e.value` only for a whole-row write (API.md:646) | no | a filter on the record left 58 % of final sets wrong (part 4) | the record form with rows, or the filtered fields per key (exact, part 4); at least warn when a field record meets `if (e.value)` |
| 7 | A version per row only (API.md:61) | the row version, yes; a field has none by choice | 8 % to 45 % of guarded field writes refused for a sibling change (part 5) | say that `if: { equals }` on a field compares the field, and use it for field guards; a field version is possible but costs a write per ancestor *(reasoned)* |
| 8 | `absent-path` for a missing parent field (API.md:1742; DESIGN-V5.md:589) | no: under one leader, filling in is ordered and deterministic *(reasoned)* | 13,420 and 14,386 field writes here that `data` fills in would be refused, about 1 in 9 commits of this mix *(checked)* | ANYPATH P6 keeps it, for H-192's reason: a write under a removed field must not bring it back silently |
| 9 | Silent on a field write under a string, number or `null`, a hole, a named field on an array, `length`, and `__proto__` (API.md:1648, 1737-1743) | no | the row turns to junk on every copy; JSON loses holes, named fields and `__proto__` values; three edges get past data's rule (shape and edge runs) | ANYPATH P6: refuse each at the write (`bad-shape` for a parent that is not an object and for a step on an array that is not an index; `bad-key` for `__proto__`); report the string row, `length` and `__proto__` to `data` |
| 10 | A diff entry, early stages, a `ttl` and a size limit per row | the diff entry, yes: `data` gives one change per row per commit (SCHEDULE clause 8); early stages, yes (V5-11 ruling 6); the rest by choice, with reasons in API.md 3.2 and 3.5 | not part of this experiment | — |

None of these needs a wire change: the first build sends whole partitions (API.md:125), and part 2 kept every client lens exact from the log records as written *(checked)*. Sending `op.merge` as field records only changes which records the leader appends.

## Limits

- One process: the leader is a stand-in that judges and orders writes; there is no Raft, no loss, no reordering on the wire. Part 2 checks the rules for what crosses, not the network. One order by construction: nothing here can show copies drifting apart.
- The mix of writes is made up. The rates in parts 1, 4 and 5 (how often a write is beside, how often a parent is missing) depend on it; the zeros, the holes and the planted-bug failures do not.
- In the merge run the stand-in leader builds a merged row from the model's objects, not the engine's, so the server's counts there include new objects a real leader would not make; the client's counts do not depend on it.
- `-N` is counted at the end of each seed only, on a log kept whole (no `history` limit).
- Part 5 is a model of the leader's guard, not a run on `data`: versions are the leader's, not `data`'s.
- T2 runs the rule inside the user's callback; built into the link it would skip the call too, so the real cost is likely lower *(a guess)*. T2's fields are numbers.

## How to run

```sh
SP=<a scratch folder of your own holding bin/timing and bin/heavy> ./run.sh            # everything: about 4 minutes of runs plus the lock waits
SP=… ./run.sh quick                                                                     # every seeded run and planted bug at 100 seeds, into $SP/e58/quick only
SP=… ./run.sh sims                                                                      # or: mutants, timing, probes, review, summary, clean
cd sim && node --experimental-strip-types run.mjs oracle 1 100 edge                    # one part by hand; E58_MUTATE=<bug> to plant one
```

`DATA` names `data`'s folder (default: the checkout at `63fea66`, read only). `run.sh probes` needs `npm` and the registry to fetch `data@2.0.0`. Every process runs with a 3,000 MB heap cap; none had more than 81 MB of heap in use at its end *(checked, the `heapMB` fields)*.

**Q: does v5 keep "write at any level, read any part exactly"? Yes inside a partition: on data's engine 2,000 seeds of root, partition, row, field, nested and array writes gave 0 wrong states, 0 missed changes and 0 wrong values-before at every lens level, on the server and on a client holding some partitions. But v5's words break it in places: `changes()` "under the lens" misses every change a whole-row write makes to a field (74-78 % of changes below a row in this mix), `-5` has no single meaning even at a row, and v5 states no rule for when a field link runs (the prototypes run it 2.3-2.6 times per change). Three edges get past data's own rule (a read through a string, an array's `length`, a `__proto__` key), and a link on an object value runs again on a client after any whole-row write that left it equal. Moves, picked in ANYPATH.md and decided in V5-15: data's rule for the state forms; the log forms take the records on the lens's path, a field too (ANYPATH first picked "stop at the row"; the owner chose this); keep the root refused (a split write lands in pieces) but let `room.set(rows)` and `room.remove()` be one batch (0 half-done); give the record form the row (58 % of filtered sets wrong today); make `if: { equals }` the field guard (the row version refused 8-45 % of guarded field writes for a sibling change); refuse the silent shapes at the write; send `op.merge` as field records.**
