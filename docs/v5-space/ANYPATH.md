# Reads and writes at any path

Written 2026-11-20, and revised the same day after a skeptic's review. Docs only; nothing here is built. **What was asked, in our words:** in `data` and in earlier fero, a write could land at any level of a resource, and code that watched any part of it got that part's state and changes right, whatever level the write came at. That kept the protocol small and easy to compose. v5's pages talk a lot about rows, because rows decide partitions. Does v5 keep the property everywhere, or do rows bring traps and special cases? Where v5 differs: must it, what does it cost a user, and what should change? The evidence is [E-58](experiments/E58-any-path/README.md), run on `data`'s real engine, and the sources named on each line.

**Words.** A **resource** is one named, replicated map of rows; its **root** is the whole of it. A **row** is one entry: a key and a JSON-like value. A **field** is a key inside a row's value; a **nested field** is a field inside a field. A **partition** is the rows one **leader** (one server) keeps in one order: at **depth 1** (the default) each row is its own partition; at **depth 2** the first key is the partition, here called a **room**, and the second key the row. A **copy** is a server's full replica; a **client** only uses the resource. A **lens** is an address, such as `shop.data.w.stock`. A **link** is a live connection from a lens into this process (`connect`); its **picture** is the state it gets first. A **record** is one change on the log: a key path and a value. A **commit** is one leader's batch of records. **The log** is every record, in order (`changes()`). To **fold** is to apply records to rows. A **version** is a record's place in its partition's log; a row's version is that of its last write. **`c.diff`** is a link's list of changed rows in one commit, one entry per row, each with `prev`, the row before. **`e.value`** is, on a log entry, the value the record wrote, set only for a whole-row write. **`-N`** is "N commits back", a start for `changes()` and `past()`; **`past(pos)`** is a lens as it was. The **record form** of `derive` runs a function on each source record ([TRANSFORMS.md](TRANSFORMS.md) 3.4). A **`batch`** is several changes to one partition, all or none. A **saga** is a change across partitions made of ordinary writes, one step at a time. A **tombstone** is a kept note that a row was removed. **E-55** and **E-56** are small working prototypes, on `data`'s engine, of the lens and of `connect`.

**Where a write lands, seen from a lens.** On a lens `w.stock`: a write to `w` is **above**, to `w.stock` **at**, to `w.stock.x` **below**, to `w.price` **beside**. **data's rule** is how `data`'s own per-path reader treats a write (data:api/index.ts:164-224): at or below the lens, a record relative to the lens; above it, compare the lens's value before and after, then send an update, a remove, or nothing when they are the same object; beside it, nothing. **Under** means at or below only: the word [API.md](API.md):641 uses today.

**Marks.** *(measured, source)*: timed, three runs, each process alone on the box; the range over the runs. *(checked, source)*: a seeded run, a probe, a tsc run in section 8, or a read of the source at the line given. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. `data:` is the sibling `data` repo at commit 63fea66. A pair of numbers from E-58 is depth 1, then depth 2, each 1,000 seeds. **E-58's shares come from a made-up mix of writes**; its zeros, its holes and its planted bugs do not depend on the mix.

---

## 0. What to review

**The answer, in five sentences.**
1. **Inside one partition, v5 can keep the property, by writing down the rule `data` already uses.** On `data`'s engine, 2,000 seeds of writes at every level gave 0 wrong states and 0 missed changes on 13 lenses, on a server and on a client *(checked, E-58 parts 1 and 2)*.
2. **Where v5 breaks it today is its words for the log.** `changes()` takes the records "under" a lens, so on a field it misses every change that a whole-row write makes *(reasoned; E-58 part 1 shows it)*.
3. **One row rule is a must: a write cannot span partitions,** because partitions share no order. Split into one write per partition, a root write shows a half-done state to any reader that watches two rows *(reasoned; E-58 part 3 shows it)*.
4. **Four row rules are choices, and code that writes fields pays for each:** no plain way to replace a room, `e.value` only for whole rows, one version per row, and `absent-path` where `data` fills in *(checked, E-58 parts 1, 4 and 5)*.
5. **Five shapes slip through today, and three of them get past `data`'s own rule:** a field write under a string, a hole or a named field in an array, an append read through an array's `length`, and a key named `__proto__` *(checked, E-58 shape and edge runs and probes)*.

Section 4 has the counts.

**The traps, in one list.**
- **T1** A log reader on a field misses whole-row writes ("under"). **T2** v5 states no rule for when a field link runs; the prototypes run it on sibling writes. **T3** `-N` has no single meaning, not even at a row.
- **T4** No plain way to replace or empty a room. **T5** A row version refuses field guards on sibling writes. **T6** The record form skips field writes.
- **T7** At depth 2 a diff entry does not say its room. **T8** Shapes: under a string, a number or `null`; array holes, named fields and `length`; `__proto__`. **T9** `ttl` and `while` on a field write. **T10** `c.recs()` is not the log. **T11** On every copy but the leader, a link on an object value runs again after a whole-row write that left it equal.

**The picks.**
- **P1** One rule for the **state forms** (`get`, a link's value and its callback, a loop turn, `past(pos).value`): data's rule, written into API 3.10. "Changed" means a new object, and a link skips a value the same as the one it last gave.
- **P2** The **log forms** (`changes()`, a count `-N`, stepping through `past`) **stop at the row**. A lens below a row has none of them, and the type error names the row's lens. `-N` counts commits with a record at or under the lens: a key count, not "the unit a callback sees". This closes API.md question 19.
- **P3** Keep the root refused, with a type message that names the way. Add `room.set(rows)` and `room.remove()`: one batch the leader expands. They are the only ways to write a room.
- **P4** The record form with rows (`derive(…, { rows: true })`) in the first build, for filters on row content, and a dev warning when `fn` reads `e.value` on a field record. P-16 and P-17 stay as written. This flips TRANSFORMS.md question 8.
- **P5** The version stays per row, said plainly. On a field lens, `if: { equals }`, `absent` and `present` test the field, and `set(fn)` on a field uses them.
- **P6** One shape rule at the leader: a missing parent is `absent-path`, as today; a string, number or `null` parent, a hole, or a named step on an array is `bad-shape` (new); a key `__proto__` is `bad-key`, at `at()` too.
- **P7** Small ones: no `ttl` or `while` on a field write; `partition` on every diff entry; cut a depth-2 commit to the link's rows; build `c.recs()` from the log's bytes; append a row's `op.merge` as one field record per merged key.

**Picks that change an approved or decided text** (for the owner): P2 changes the wording of [CONNECT.md](CONNECT.md) pick I8, which says "a room, a row in it, or a field"; P4 flips TRANSFORMS.md question 8; P5 changes API.md 3.7, where `set(fn)` needs "no new rule at the leader": the leader would now compare a field's value. CONNECT and TRANSFORMS are approved in general. P3, P6 and P7 conflict with no decision; P6 keeps DESIGN-V5.md 4.3's `absent-path`.

---

## 1. How it worked before

| Version | Writes | A reader of a part | Holes |
|---|---|---|---|
| fero 1.x (2017, `master`) | any depth, the root too (objects only); the key is one dotted string | none: every reader filtered the one change stream itself | a key with a dot could not be named; a root write was filed under a partition of its own, `''`, not ordered with the rows *(checked, `master:partitions.js:19-21`; ordering reasoned)* |
| data v2 (`data@2.0.0`, under fero v2 and v3) | any depth and the root, by assignment; operators at any path | per-path subscribers, records relative to the subscriber | threw under a `null` parent and on a remove under a missing parent; sent unchanged values again to subscribers below a write above them *(checked, E-58 [probes/data-v2.mjs](experiments/E58-any-path/probes/data-v2.mjs) on the published package; [results/probes.txt](experiments/E58-any-path/results/probes.txt))* |
| fero v2 and v3 | any depth; the record is data v2's | per process as data v2; over the wire, filter views over rows | each full path was its own last-writer-wins cell, so a row write and a field write never met, and two copies could show different rows for ever; no root write *(checked, [V4-18](../DECISIONS.md); `1d94ad6:resource/index.ts` `setPath`)* |
| data v4 (63fea66: what v5 folds with) | any depth inside a live row, and whole rows. A root `update` throws; a deep write cannot invent a row | data's rule, exact at any depth but three edges (T8) | a phantom `undefined` on a row add; a new equal object fires; a path read goes through strings *(checked, data:api/index.ts:164-224, 250-252; data:kernel/node.ts:470-476)* |
| fero v4 (this repo's code) | any depth inside a row; the substrate makes a missing row `{}`; a root write throws before it commits | a method's child streams through data's rule | mixed depths converge only through V4-18's ancestor index, sweeps and repairs; an array row can still differ by arrival order *(checked, [api/substrate.ts](../../api/substrate.ts):135-140; [STATUS.md](../../STATUS.md):66)* |

- **The row was always special.** It was the partition in every fero version, and `data` v4 made it the engine's unit too *(checked, the rows above)*.
- **"Any level, read any part" held in one process**, best in data v2 and most precisely in data v4. Replicated, it held across depths only from V4-18 on (fero v4's fix that orders a row write and a field write to one row through an index of each path's ancestors), and never at the root *(reasoned from the rows above)*.
- **One leader per partition removes that machinery.** A row write and a field write to one row go into one order, and every copy folds that order, so copies cannot disagree as v2 and v3 could *(reasoned from V5-1)*. E-58 runs one order by construction, so it cannot show this either way. Its planted v2-style merge broke the server's own state in 1,000 of 1,000 seeds, which shows only that its checks see such a merge *(checked)*.
- So v5's row rules are not new in kind. The question is which of them leak.

---

## 2. The v5 matrix

"The same" means as `data` v4 does it today. The state forms (`get`, a link's value, `past(pos).value`) are folds, and a fold is exact at every level: 0 wrong states in 240,000 commits *(checked, E-58 part 1)*. So the differences are in **when** a reader is told and **what** a log entry carries.

| Write | Allowed in v5? | A link at or below it: when it runs | The log at or below it | `e.value`, the record form | `if:` on a field lens |
|---|---|---|---|---|---|
| **W1** the whole resource | **refused, and must be** (API.md:271): partitions share no order (T4) | — | — | — | — |
| **W2** a room | **refused today, by choice** (API.md:271). P3: `room.set(rows)`, `room.remove()` | under P3, plain row records: 0 wrong in E-58 *(checked)* | the same | per row | — |
| **W3** a row: set, add, remove | yes | **unstated** (T2). data's rule: only on a change; a remove carries the value before | **"under" misses it** on a lens below the row (T1) | the row; `undefined` for a remove (API.md:646) | `version` moves though the field stayed the same (T5) |
| **W4** a field or nested field | yes, in a live row. `absent-row` on a missing row, as `data`. `absent-path` on a missing parent, **where `data` fills it in** (T8) | at or below: the same. **Beside:** the prototypes run it; data's rule never (T2) | the same | **`undefined`**: a filter on `e.value` misses it (T6) | a sibling's write moves the row version (T5) |
| **W5** a field remove | yes, commit only (API.md 3.5). One that finds nothing: `data` commits nothing; v5 is **silent** | lenses below get a remove with the value before *(checked)* | the same | `undefined` | as W4 |
| **W6** an array element | an index inside: yes. **Past the end, or a named field (`length` too): silent** (T8). A remove: `sparse-hole`, as `data` | an append changes `length` with no record (T8) | the same | as W4 | as W4 |
| **W7** a type change | at its own level, a plain write: the same. **Under a primitive: silent** (T8) | a lens through a string reads a character, and misses its going (T8) | the same | as W3, W4 | — |
| **W8** an op | a row op on a missing row creates it; a field op there is `absent-row` (API.md:1657). The leader appends a plain value | the same | the same | which record `op.merge` appends: **silent** (T11) | as W4 |
| **W9** a `batch` | one partition, all or none: must (API.md 3.6) | one entry per row in `c.diff`, since `data` merges them (data:kernel/node.ts:621-660) | the records as written; `c.recs()` gives the merged row (T10) | per record | — |
| **W10** a row moved between rooms | a saga, never one write: must | **readers see half** (T4) | each partition in its own order | — | — |

---

## 3. Where v5 treats the row or the partition as special

| # | The rule | Why v5 has it | Must? | Leaks to a user? |
|---|---|---|---|---|
| 1 | The first key is the partition; `depth` is fixed at founding (API.md 3.2) | routing by a hash, nothing to learn | routing: must. `depth`: a priced choice | once: a list kept inside one row cannot be split later *(reasoned)*; a write to a row that holds 1,000 entries copies it, 0.43 ms (LENS.md:71) |
| 2 | No write at the root | it spans partitions | **must** | no: `data` refuses it too. The type error should name the way (P3) |
| 3 | No write at a room | "a write needs a row" (API.md:271) | **no**: a room is one partition | yes: T4 |
| 4 | `batch` in one partition; no order across | one leader per partition | **must** | a move between rooms is a saga; readers see half (W10) |
| 5 | One version per row; `if:` judged per row | the leader orders a partition; `data` changes rows | the row version: must. A field version: a choice | yes: T5 |
| 6 | `ttl`, lease, `touch`, `while` per row | expiry removes a row by a record | **must** | yes: they compile on a field write (T9) |
| 7 | `c.diff`: one entry per row | `data` gives a reader one change per row per commit (its SCHEDULE clause 8) | **must** (data's) | mildly: T7 |
| 8 | `e.value` only for a whole-row write (API.md:646) | the log keeps records as written; a row needs a fold | **no** | yes: T6 |
| 9 | Early answer stages only for a plain whole-row write (API.md 3.5) | a field write can be refused `absent-row`, and more under P6 | **must**, by V5-11 ruling 6: a write that can be refused takes no early stage | mildly: a field writer cannot await `received` |
| 10 | `-N`, versions and `past` inside one partition (CONNECT.md:39); with P2, the log forms stop at the row | one order per partition | the partition: must. The row: a choice (P2) | no: the types refuse them wider and lower |
| 11 | The wire sends whole partitions in the first build (API.md:125) | work below a partition waits | for now | cost, not results: a field link at depth 2 downloads its room |
| 12 | Snapshots, compaction and tombstones per row | resume by "rows newer than mine plus tombstones" (CONNECT.md 4) | no; sound | no: a field remove is a row update, so a resume sends the row without the field *(reasoned)* |
| 13 | Size limits per row: a record 1 MB, a row 64 MB (API.md:1708) | a record must fit one replication round of the leader's log | records: must | a room has no limit of its own; P3's room write is one entry |
| 14 | Operators only on the root and a room (LENS.md:77) | `data`'s operators run over rows | **must** (data's) | a list inside a row has no live view |

Rules 2, 4 and 10 are the partition, and they break nothing inside a partition. Rules 3, 5, 8 and the silent shapes are the ones a user trips on.

---

## 4. Traps and special cases

**T1-T3. The read rules below a row.**
- *What holds in any mix.* A write above a lens has no record under the lens. So "under" misses every change that a whole-row write makes to a field *(reasoned)*.
- *Evidence.* `changes()` reads records "under the lens" (API.md:641; still API.md question 19). `-N` is "the unit a callback on the same lens sees" (CONNECT.md:60, 215), but the server counts back by reading keys (CONNECT.md:217). A link's commit is "cut down to the rows the link reads" (CONNECT.md:176): row words for a field lens. No page says when a field link runs. E-55's link runs on every commit to its row, though its comment says "and, below the row, its leaf" (E-55 [lens.mjs](experiments/E55-lens-prototype/proto/lens.mjs):438-442), and E-56's `connect` is built on it *(checked)*. That is the prototype's choice, not v5's words.
- *In E-58's mix.* "Under" missed 79,368 (74.0 %) and 33,497 (78.2 %) of the changes below a row. E-55's link ran a field link 2.60 and 2.32 times per change, 104,247 and 34,747 times for a write beside it. data's rule missed 0, and its records rebuilt every value. Taking the records at, above or below a lens ("on the path"; E-58 calls it "near", which is not the `near` hint V5-12 removed) missed 0, and a reader that folds only its lens from them kept the right value after all 240,000 commits *(checked, part 1)*.
- *`-N`, even at a row.* A count by key does not land where a callback's count does. At `-5`, on lenses at or above a row, the key count and data's callback land on different commits in 27.6 % and 29.8 % of (seed, lens) pairs; data's callback itself differs from "the value changed" in 26.3 % and 20.1 % (a new equal object fires). Below a row the key count differs in 78.4 % and 64.3 % "on the path", 95.5 % and 72.6 % "under" *(checked, E-58 summary)*. So CONNECT.md:215's "the unit a callback sees" is already off at a row.
- *Options for the log forms.* (a) "Under", as written: wrong below a row. (b) "On the path": exact, but a record above a field carries a whole row. The reader must read its part from `e.rec.value` at the path below the record's key, and apply a record below the lens to the value it kept: it always folds. One more rule word, and a run-time rule the types cannot show. (c) **Stop at the row**: `changes()`, a count `-N` and stepping through `past` exist on the root, a room and a row, not below. Nothing in the log is ever above a row (a room write expands into row records, P3), so "under" is exact everywhere it is allowed *(reasoned; E-58: "under" missed 0 at the root, a room and a row)*. A field's changes come from `connect`; code that wants a field's log reads its row's log and folds its field, as in (b).
- *Pick (P1, P2): data's rule for the state forms; (c) for the log forms.* `-N` is "the N-th last commit with a record at or under this lens", and the page says it is not the callback's unit. API.md question 19 closes: a lens below a row has no log. `past(pos).value` stays on every lens; it is a state form.
- *Cost.* data's rule costs −2.6 to +8.0 ns a link a commit at 10 links and +6.7 to +11.2 ns at 100, over E-55's rule; it calls the user's function 0.59 times a commit instead of 10, and 5 instead of 100 *(measured, E-58 T2: number fields; object fields run more, T11)*.
- *Against (c).* A field lens loses a verb the other lenses have: one stated special case, though the types show it. Like (b), it changes CONNECT.md pick I8's wording ("or a field" goes). `-5` on a row can replay commits that left the row the same.

**T4. Writes at the root or at a room.**
- *What holds in any mix.* A write across partitions lands one partition at a time, so a reader that watches two rows can see one changed and the other not *(reasoned)*. E-58 part 3 shows it: a two-row callback saw a half-done state in all 20,000 root replaces and all 20,000 moves between rooms. That 100 % follows from how the run is built (the two rows always change in separate commits). The measured part: a loop that wakes every 1 to 4 commits (a made-up interval) saw a half-done state in 63.1 % of replaces and 39.1 % of moves, and a whole-resource callback saw 5.31 a replace. A room replaced as one batch: 0 *(checked, E-58 part 3)*.
- *Today* a room is emptied by per-row removes after a read, a `batch` that needs the keys, or `fero.erase`, an admin act (API.md:1512).
- *Options.* (a) Refuse both, as today. (b) Refuse the root; let a room take `set(rows)` and `remove()`, one batch the leader expands from the rows it holds. (c) Also take a root write, as a saga run partition by partition.
- *Pick (P3): (b).* The gain is that **the leader knows the keys**: no race with a writer that adds a row between your read and your removes, no need to hold the room to learn its keys, all or none, one log entry, one link call. The root's refusal gets a type message that names the way: write each row or room, or `fero.drop(name)` to empty the resource (section 8). `room.set` and `room.remove` are the only ways to write a room: assignment (`chat.data.room1 = rows`, `delete chat.data.room1`), `f.set([room], rows)` and a `batch` item at a room key stay refused `bad-path`, since one careless line would replace or empty a room. A row given as `undefined` is refused, by the types and by the leader (`unencodable`).
- *Speed is not the argument.* E-58 T1 times `data`'s fold only: one batch against the same rows as separate local commits, 2.3 to 5.9 times less work *(measured, T1)*. In v5, writes made together already leave in one frame and share disk syncs (API.md:132), and a `batch` that names the keys costs what the room write costs *(reasoned)*.
- *Against (b).* A new write level: "a write needs a row" becomes "a write needs a partition or less". One room write can be a big log entry, and needs a size rule. `room.remove()` leaves one tombstone per row. Rows sent again whole run every link on an object field in them, on every copy but the leader (T11), unless the leader skips rows the same as the ones it holds: a deep compare per row *(reasoned)*. A row named `set` or `remove` in a room is then reached with `at()` only, as a row named `get` is today *(reasoned)*. *Against (c):* every reader sees it half done, and a saga over two partitions takes 6 to 7 commits in a row (PATHS.md 3.7), about 2P + 2 over P partitions *(reasoned from that table)*.

**T5. Versions and `if:` per row, against per path.**
- *Evidence.* Guarded field writes, the guard read 1 to 6 commits before the write *(checked, E-58 part 5: a model of the leader's guard, not a run on `data`; the sibling shares are made up)*:

| sibling writes | guarded writes | row version refused | refused only because a sibling changed: of the guarded writes (of the refusals) | a field version refused | `if: { equals }` refused | `equals` passed after a change and back |
|---|---|---|---|---|---|---|
| 20 % | 118,637 | 84,986 | 9,162: 7.7 % (10.8 %) | 75,824 | 60,278 | 15,546 |
| 50 % | 118,554 | 85,089 | 27,566: 23.3 % (32.4 %) | 57,523 | 45,338 | 12,185 |
| 80 % | 119,097 | 85,424 | 54,021: 45.4 % (63.2 %) | 31,403 | 24,313 | 7,090 |

- *Options.* (a) One version per row, said plainly. (b) A version per field path, moved by writes at, above or below it: it refused exactly the true conflicts, but needs a version per ancestor per write, on top of the per-row store that is already owed (CONNECT.md:239) *(reasoned)*. (c) `if: { equals }` on the field.
- *Pick (P5): (a) with (c).* `if: { version }` is the row's. On a field lens, `if: { equals }` compares that field, and `absent` and `present` test the field. `set(fn)` on a field sends `if: { equals: now }`, or `if: { absent: true }` when it read `undefined`: an `equals: undefined` would drop out of the JSON and leave the write unguarded *(reasoned)*.
- *Against.* `equals` lets a write through after a change and back: safe for `set(fn)`, which reads only the field, not for code that also read other fields *(reasoned)*. It carries the old value in every guarded request: a few bytes for a number, the whole value for an object or a list, where a version is a few bytes *(reasoned)*. For a big field, `set(fn)` on the row is the cheaper guard; a hash of the value is an option (section 6). It changes API.md 3.7, where `set(fn)` needed "no new rule at the leader": the leader now compares a field's value at a path.

**T6. The record form skips field writes.**
- *Evidence.* `e.value` is set only for a whole-row write (API.md:646); P-16, P-17 and `derive` test `if (e.value)` (API.md:2178, 2192; TRANSFORMS.md:209, 432). The pages already say to write each fact whole, once (API.md:703, 2181; TRANSFORMS.md:209, 432), but nothing checks it. Where field writes happen, a filter on the record alone keeps the wrong set. In E-58's mix (200,000 records, 117,305 of them field-only) it never saw 28 % and 42 % of the rows entering the filter (11,549 of 41,096 for `stock > 0`; 12,385 of 29,761 for a two-field filter), nor 40 % and 50 % of those leaving it, and its final set was wrong in 582 and 584 of 1,000 seeds. Folding the row was exact; so was keeping only the filtered fields per key *(checked, E-58 part 4)*. A field record is "the commonest write" ([PATHS.md](PATHS.md):21).
- *Options.* (a) `derive(…, { rows: true })` in the first build: `fn` also gets the row after the record and before it (TRANSFORMS.md 3.4 plans it for later). (b) Keep the filtered fields per key: exact and small, but fero cannot see which fields a function reads, so the user must name them. (c) A dev warning when `fn` reads `e.value` on a field record. A plain `changes()` loop keeps API.md:646's way, holding the partition and reading its handle, and gets the same warning.
- *Pick (P4): (a) for filters on row content, and (c) for all.* P-16 and P-17 stay on `e.value`: they are facts written whole, once, and get only the warning.
- *Against.* It flips TRANSFORMS.md question 8 and adds first-build work. A deriver with rows holds its share of the source, about 330 B a row, and folds 0.63 to 1.5 µs a record *(measured, as cited at TRANSFORMS.md:209)*.

**T7. What `c.diff` means on a field lens.**
- Entries stay per row: `data`'s unit (section 3, rule 7). With data's rule a field link runs only when its field changed, and its diff holds its own row; `prev` is the row before, so an undo reads `c.diff[0].prev?.stock` *(reasoned)*. Two gaps. At depth 2 an entry does not say its room (API.md:1291), so on a whole-resource link `m1` in `room1` and in `room2` look the same. And E-55 handed a row or field link a commit that held other rows of its room 52,493 times *(checked, E-58 part 1)*, while CONNECT.md:176 says the commit is cut.
- *Pick (P7).* Every diff entry gets `partition`, at every depth, as a log entry has (API.md:646); at depth 1 it is the row's own key. The build cuts a depth-2 commit to the link's rows.
- *Against.* An undo on a field picks the field out of `prev`. A `c.prev` holding the lens's own value before would be one more word *(reasoned)*.

**T8. Type changes, shapes, and three holes in data's rule.**
- *Type changes.* At a write's own level, object to primitive and back is a plain write, and data's rule gives the readers below a remove or an update *(checked, E-58 part 1: type flips among the writes, 0 wrong)*. A write **under** a primitive is the trap.
- *Shapes.* A field write on a string row made junk in all 304 made alone and in 53 of 87 batches; on a number row it made a clean object. Holes and named fields on arrays replicated as field records, and broke a client only after a whole row holding them crossed as JSON: 191 and 157 times on the log's records. A remove at a hole threw on the client 3 times per depth *(checked, E-58 shape runs)*.
- *Three holes in data's rule* *(checked, E-58 shape and edge runs; [probes/data-edges.mjs](experiments/E58-any-path/probes/data-edges.mjs))*. Each is a change with no record at, above or below the lens:
  1. **Through a string.** A lens on `list.1` while `list` is `'abc'` reads a character; when a write under the string makes it an object, the character goes. data's reader missed 34 such changes.
  2. **An array's `length`.** An append at the end changes it: missed 80 and 35 times. A write to `length` cuts the list: a lens on an element missed it 259 and 67 times.
  3. **A key `__proto__`.** A field write there gives the row a hidden prototype (data:kernel/node.ts:292). A lens on `p` read the new value with no record 242 and 125 times, and lost it at the row's next ordinary write, again with no record, 141 and 86 times; a client that joins later reads `undefined` from its JSON picture. Nothing outside the row changes: `data` copies on write.
- *Fix and pick (P6).* One rule at the leader, beside `absent-row`, with plain codes:
  - a parent field that is missing: `absent-path`, as today (DESIGN-V5.md:589);
  - a parent (or the row) that is a string, a number or `null`, an index past an array's end, or a step on an array that is not an index (a named field, `length`): **`bad-shape`**, new. DESIGN-V5.md:1134 already refuses named fields on arrays;
  - a key `__proto__` at any step: `bad-key`, at `at()` and at the leader (API.md:1736 refuses only keys that are not strings).
  - A lens that steps into an array by name is refused `bad-path` when read; the types already offer only index steps there (API.md:1156).
  Then each hole needs a write v5 refuses, so data's rule is exact on every write v5 takes *(reasoned)*.
- *Against.* It refuses what `data` and v4 take: 13,420 and 14,386 field writes under a missing parent in E-58's mix, about 1 in 9 commits there *(checked)*. Code from `data` or v4 that relied on the fill-in must write the parent whole. The reason to refuse is H-192 (DESIGN-V5.md:895): a write under a removed field must not bring it back silently. Under one leader that is about intent, not about copies agreeing *(reasoned)*. One new code.
- *A field lens on a client.* The first build sends whole partitions (API.md:125). A client that held 2 of the partitions, fed the log's records as written, kept every lens exact: 0 failures, 0 records refused by `data` *(checked, E-58 part 2)*. At depth 2 a field link downloads its room: a cost, not a wrong answer.

**T9. `ttl` on a field.** API.md:270 says a ttl and a lease belong to a row, but the field write's options (API.md:1205-1213) and a field `batch` item (API.md:1133-1135) carry `ttl` and `while`. *Pick (P7):* take them off the field forms (section 8) and refuse them at the leader. *Against:* none found; an expiring field is a row's job.

**T10. `c.recs()` is not the log.** Two field writes to one row in one commit become one whole-row record in `c.recs()`, since `data` merges per row; `changes()` gives the two field records *(checked, data:kernel/node.ts:621-660; E-58 road 2)*. Both kept every client state exact, once the shapes were valid *(checked)*. *Pick (P7):* build `c.recs()` from the log's bytes, which [LAYERS.md](LAYERS.md):652 wants for speed anyway. *Against:* `recs()` then holds field records; a forwarder that wants one record per row must merge.

**T11. An object value's link runs again on every copy but the leader.**
- *Evidence.* data's rule compares the lens's value before and after by reference (data:api/index.ts:216). A record that crossed the wire is a new object. So on a client, and on a copy that is not the leader, a link on an object or list value runs again for any whole-row record that left it the same. On a client fed through `data`'s lane, 100 `op.merge({ b })` sent as whole rows ran a link on the unchanged `r0.a` 100 times; sent as one field record per merged key, 0 times *(checked, E-58 probe F)*. In E-58's mix, below a row, the client's reader ran for a new equal object 3,454 and 1,220 times, against 2,916 and 1,115 on the server; with `op.merge` sent as field records, 2,550 and 1,068 on both *(checked, E-58 merge runs)*. T2 wrote number fields only, so its 0.59 calls a commit is for numbers.
- *Options.* (a) Say it: "changed" means a new object. (b) Append `op.merge` on a row that exists as one field record per merged key; on a missing row, the whole row. (c) A link compares an object value deeply before it calls: a cost per write above it, not measured.
- *Pick (P1, P7): (a) and (b);* (c) stays open (section 6). E-58's merge runs kept every check at 0 failures *(checked)*.
- *Against (b).* A merge of k fields is k records, each smaller than the row *(reasoned)*. A log reader sees field records for a merge, so a filter on content needs rows (T6).

**Removal and tombstones.** A row remove reaches every link below as a remove with the value before; a field remove reaches the links below the same way *(checked, E-58 part 1: 0 wrong values-before)*. A remove that finds nothing commits nothing in `data`; v5 should say it answers as done *(reasoned)*. An array element is refused `sparse-hole`, as before. A row add sends a phantom `undefined` to a link whose part the new row lacks: 14,886 and 6,475 times *(checked)*. The link should skip a value equal to the last one it gave, by `Object.is` *(reasoned)*. Tombstones stay per row; `room.remove()` writes one per row.

---

## 5. What changes if the picks are taken

**API.md.**
- 3.4: "a write needs a row" becomes "a write needs a partition or less". The root is refused with a message that names the way; a room takes `set(rows)` and `remove()` as one batch, and no other spelling (P3). The shape rule (P6). `ttl` and `while` on rows only (P7).
- 3.7: `if: { version }` is the row's; on a field lens `equals`, `absent` and `present` test the field; `set(fn)` on a field uses them (P5). A row's `op.merge` appends field records (P7).
- 3.10 (CONNECT.md's read surface): one paragraph. The state forms use data's rule, "changed" means a new object, and a link skips a value equal to the last (P1). The log forms stop at the row, and `-N` is a key count (P2). Question 19 closes.
- 3.11: the record form with rows, and the warning (P4). P-16 and P-17 keep `e.value` and gain the warning.
- Section 6 (the declarations): the lines in this page's section 8. Section 8 (the codes): `bad-shape` new; `bad-key` adds `__proto__`; `bad-path` adds a room written another way, a log read below a row, and a lens into an array by name; a remove that finds nothing answers as done.

**LAYERS.md.** L2: the shape rule; the room batch expanded at the leader, with a size rule; `op.merge` as field records. L3: counting `-N` by key, at a row or wider. L4: data's rule on every link, and skipping a value equal to the last one. L5: `derive` with rows folds its share.

**CONNECT.md and TRANSFORMS.md.** CONNECT.md:60 and 215: `-5` counts the commits with a record at or under a room or a row; "the unit a callback sees" goes. TRANSFORMS.md question 8 flips to "rows in the first build".

**data** (read only here; reports for its owner). (1) A row add should not send `undefined` to a path the row lacks (data:api/index.ts:198-201). (2) A path read below a string should give `undefined`, not a character (data:kernel/node.ts:220-227). (3) Clause 10c cleans a parent that is not an object, but not the row itself: a string row spreads into junk (data:kernel/node.ts:277). (4) A reader on an array's `length` gets nothing when an element is added at the end, nor a reader on an element when `length` is written (data:api/index.ts:219). (5) A write at the key `__proto__` sets the copy's prototype instead of a field (data:kernel/node.ts:292). fero needs none of the five if its leader refuses those shapes first *(reasoned)*.

---

## 6. Not known yet

| Not known | Why it matters | What would settle it |
|---|---|---|
| E-58's leader is a stand-in in one process: no Raft, no loss, no reordering | the rules are checked; a build's own link and log reader are not | run E-58's oracle against the first build's link and log reader |
| the shares come from a made-up mix | the zeros, the holes and the planted bugs hold in any mix; the shares (writes above or beside a lens, missing parents, sibling writes) do not | count write levels in E-22's patterns (the 22 app patterns' runs), or in a real app's log |
| the cost of counting `-N` by key on a real log | a cold partition beside a hot one can mean many keys read (CONNECT.md:217) | a bench on E-19's slot layout (the bench of slot-shaped positions) |
| the size rule for a room write, and the cost of skipping rows that did not change | one entry for a large room; a deep compare per row | E-35's big-record run (big records on the shared journal) with a 10,000-row room |
| the cost of `equals` at the leader, and its size on the wire | a deep compare per guarded field write, and the old value in each request | a bench beside E-56's version store; a hash as the guard |
| a deep compare in a link for object values (T11, c) | it would stop links that run again for nothing on clients | T2 again, with object fields |
| the record form with rows, built | first-build work and memory | build it on E-57 B5's mark model (the model of the record form's marks); rerun E-58 part 4 on it |
| E-58's edge and merge runs and its probes are new since its review | they carry T8, T11 and section 1's data v2 row | a second review |

---

## 7. Questions for the owner

1. **Write data's rule into API 3.10 as the one rule for the state forms?** **Pick: yes.** It missed nothing at any level in E-58. *Against:* "changed" means a new object, so on every copy but the leader a link on an object value runs again after a whole-row write (T11); +7 to +11 ns a link a commit at 100 links.
2. **Stop the log forms (`changes()`, `-N`, stepping through `past`) at the row, and drop "the unit a callback sees"?** **Pick: yes.** "Under" misses every change a whole-row write makes to a field; at a row or wider it is exact, and no new word is needed. *Against:* a field lens loses `changes()`; the other way, records "on the path", keeps it, but each entry above the field carries a row, and the reader must fold. Both change CONNECT.md pick I8's wording.
3. **Add `room.set(rows)` and `room.remove()` as the only room writes, and keep the root refused?** **Pick: yes.** The leader knows the keys, and one batch showed 0 half-done states. *Against:* a new write level, big entries that need a size rule, a tombstone per row, and rows sent again whole wake links on every copy but the leader.
4. **Bring the record form with rows into the first build, with a dev warning, and leave P-16 and P-17 as written?** **Pick: yes.** It flips TRANSFORMS.md question 8: without it a filter on content left the final set wrong in 58 % of E-58's seeds. *Against:* more first-build work; the deriver holds about 330 B a row of its share and folds 0.63 to 1.5 µs a record.
5. **Keep one version per row, and make `equals`, `absent` and `present` the field guards, also inside `set(fn)`?** **Pick: yes.** The row version refused 8 % to 45 % of guarded field writes only because a sibling changed, in E-58's mix. *Against:* `equals` passes after a change and back, it carries the old value, and it changes API.md 3.7's "no new rule at the leader".
6. **One shape rule at the leader (`absent-path`, `bad-shape`, `bad-key`), not `data`'s fill-in?** **Pick: yes.** It closes five silent shapes and the three holes in data's rule. *Against:* it refuses writes `data` takes, about 1 in 9 commits in E-58's mix; code ported from `data` or v4 must write parents whole; one new code.
7. **The small ones: no `ttl` on a field, `partition` on every diff entry, commits cut at depth 2, `c.recs()` from the log's bytes, `op.merge` as field records?** **Pick: yes.** *Against:* `c.recs()` then shows field records, and a merge of k fields is k records.

---

## 8. How the page is checked

- **E-58.** Every number marked E-58 is from [E-58's results](experiments/E58-any-path/results/summary.md); the others name their page. For the first version of this page, three runs were made again (part 1 at depth 1, part 3, part 4: 1,000 seeds each) and gave the same lines, all 354, 20 and 34 counters equal; two planted bugs, "under" and "a log reader takes a beside record", each failed 100 of 100 seeds. For this revision, part 1 ran again at both depths with the client's new counts (all 354 and 359 earlier counters equal), the new edge and merge runs ran, two planted bugs in merge mode failed 1,000 of 1,000 seeds each, and the probes ran *(checked)*.
- **Sources.** Every line reference was read on 2026-11-20 in this tree and in `data` at 63fea66.
- **The types.** Each ` ```ts ` block whose first line is `// file: <name>` goes into a fresh folder and must type-check with tsc. Then, in a copy where each `@ts-expect-error` is a plain comment, each line it marked must fail at its own line, and nothing else may (the strip proof). The pattern is CONNECT.md section 11's. `fero.d.ts` declares only the lines this page changes, on CONNECT.md's shapes.

```ts
// file: fero.d.ts — the lines this page changes, as declarations. Self-contained; a sketch to type-check, nothing is built.
//   room.set(rows), room.remove()   NEW: a room (a partition at depth 2) replaced or emptied as one batch
//   f.data.set, f.data.remove       still refused, now with a message that names the way
//   a field write                   no ttl and no while: they belong to a row. if: { equals } and absent compare the field
//   changes() and a count back      stop at the row: a lens below a row has neither (P2)
//   a diff entry                    NEW: its partition, at every depth, as a log entry has
//   derive(…, { rows: true })       in the first build: fn also gets the row after the record, and before it
declare module 'fero' {
  export type Key = string
  export type Depth = 1 | 2
  export type Kind = 'root' | 'part' | 'row' | 'field'
  export type Version = string & { readonly __fero: 'version' }
  export type Cursor = string & { readonly __fero: 'cursor' }
  export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
  /** The rows of a room or a resource, as read: a missing key reads undefined. */
  export type Rows<Row> = { readonly [key: string]: Row | undefined }
  /** The rows given to room.set: every value a row, never undefined. */
  export type NewRows<Row> = { readonly [key: string]: Row }
  /** A compile error that names the line to write instead. */
  export interface Steer<Msg extends string> { readonly 'fero: write this instead': Msg }
  export interface Op { readonly __op: 'incr' | 'merge' }
  export const op: { incr(n: number): Op; merge(fields: Record<string, unknown>): Op }
  export interface Ack { readonly version: Version; readonly value?: unknown }
  export interface Judged<A = Ack> extends PromiseLike<A> {}
  /** `version` is always the ROW's version. On a field lens, `equals`, `absent` and `present` test that field. */
  export interface Cond { absent?: true; present?: true; version?: Version; equals?: unknown }
  export interface RowOpts { if?: Cond; once?: string; ttl?: Duration; while?: 'session'; timeout?: Duration; from?: undefined }
  type OnRow = 'a ttl and a lease belong to a row: give them on the row lens, f.data.k.set(row, { ttl })'
  export interface FieldOpts { if?: Cond; once?: string; timeout?: Duration; from?: undefined; readonly ttl?: Steer<OnRow>; readonly while?: Steer<OnRow> }
  /** A marked write (API.md 3.11): the write and "source record e is applied" land in one log entry; it counts once. */
  export interface MarkOpts { from: Entry<any>; if?: Cond; once?: undefined }
  type NoRoot = 'the root spans partitions, which share no order: write each row or room, or empty it all with fero.drop(name)'
  type RowLog = 'the log stops at the row: read the row lens changes() and pick the field, or follow the value with connect'

  // ── the lens: a property read is a step, a call is a verb ──
  type Child<K extends Kind, D extends Depth> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
  type Tree<Row, D extends Depth> = D extends 2 ? Record<Key, Rows<Row>> : Rows<Row>
  type Val<T, Row, K extends Kind, D extends Depth> = K extends 'row' | 'field' ? T | undefined : K extends 'part' ? Rows<Row> : Tree<Row, D>
  export type Lens<T, Row, K extends Kind, D extends Depth> = Reads<Val<T, Row, K, D>, Row, D>
    & (K extends 'root' ? RootLog : K extends 'field' ? FieldLog : PartLog)
    & (K extends 'root' ? RootWrites : K extends 'part' ? PartWrites<Row> : K extends 'row' ? RowWrites<T> : FieldWrites<T>)
    & Steps<T, Row, K, D>
  type Steps<T, Row, K extends Kind, D extends Depth> = K extends 'root' | 'part'
    ? { readonly [key: string]: Lens<K extends 'root' ? (D extends 2 ? Rows<Row> : Row) : Row, Row, Child<K, D>, D> }
    : T extends readonly (infer E)[] ? { readonly [i: number]: Lens<E, Row, 'field', D> }
    : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], Row, 'field', D> } : {}
  export interface RootWrites { readonly set: Steer<NoRoot>; readonly remove: Steer<NoRoot> }
  export interface PartWrites<Row> {
    /** Replace the room: each row of `rows` set whole, every other row of the room removed. One batch the leader
     *  expands from the rows it holds: one log entry, all or none, commit only. Readers get plain row records.
     *  The only spelling: assignment, delete, f.set([room], …) and a batch item at a room key stay bad-path. */
    set(rows: NewRows<Row>, opts?: { once?: string; timeout?: Duration }): Judged
    /** Empty the room: every row removed, as one batch. */
    remove(opts?: { once?: string; timeout?: Duration }): Judged
  }
  export interface RowWrites<T> {
    set(value: T | Op, opts?: RowOpts | MarkOpts): Judged
    /** Read, decide, write, guarded by the row's version. */
    set(fn: (now: T | undefined) => T | undefined, opts?: Omit<RowOpts, 'if'>): Judged<Ack | undefined>
    remove(opts?: RowOpts | MarkOpts): Judged
    touch(opts?: { ttl?: Duration }): Judged
  }
  export interface FieldWrites<T> {
    set(value: T | Op, opts?: FieldOpts | MarkOpts): Judged
    /** Read, decide, write, guarded by this field: if: { equals: now }, or if: { absent: true } when now is undefined.
     *  A write to a sibling field does not make it try again. */
    set(fn: (now: T | undefined) => T | undefined, opts?: Omit<FieldOpts, 'if'>): Judged<Ack | undefined>
    remove(opts?: FieldOpts | MarkOpts): Judged
  }

  // ── reads: the words that change are in the comments; the shapes stay CONNECT.md's ──
  export interface Reads<V, Row, D extends Depth> {
    get(): Promise<V>
    /** fn runs on the picture, then on each commit that changed V (data's rule; "changed" is by reference, so an
     *  object value runs again after a write above it that crossed the wire). Never for a write beside the lens. */
    connect(fn: (value: V, c: Commit<Row>) => void): { readonly disconnect: () => void }
  }
  /** A count back is a negative literal; a number typed `number` or a positive one is refused (CONNECT.md's rule). */
  type Back<P> = P extends number
    ? (number extends P ? Steer<'a count back is a literal such as -5'> : `${P}` extends `-${string}` ? P : Steer<'a count back is negative: -5'>)
    : P
  /** The same check on the option: a count in `from` must be a negative literal. */
  type BackOpt<F> = [Extract<F, number>] extends [never] ? {} : { readonly from?: Back<F> }
  export interface RootLog {
    /** The log of every partition: a place only. */
    changes(opts?: { from?: Cursor | Date }): AsyncIterable<Entry<any>>
  }
  export interface PartLog {
    /** The log, on a room or a row: every record at or under this lens (none is ever above it). -5 counts back the
     *  commits that hold one: a key count, not the commits a callback on this lens runs for. */
    changes<const F extends Cursor | Date | Version | number = Cursor>(opts?: { from?: F } & BackOpt<F>): AsyncIterable<Entry<any>>
  }
  export interface FieldLog { readonly changes: Steer<RowLog> }
  export interface Commit<Row> { readonly diff: readonly Change<Row>[] }
  export interface Change<Row> {
    readonly type: 'add' | 'update' | 'remove'; readonly key: Key
    /** The partition this row is in: its room at depth 2, the row's own key at depth 1. */
    readonly partition: Key
    readonly row: Row | undefined; readonly prev: Row | undefined; readonly version: Version
  }
  export interface Entry<Row> {
    readonly rec: { readonly type: 0 | 1 | 2; readonly key: readonly (string | number)[]; readonly value?: unknown }
    /** What the record wrote, when it wrote a whole row. Not the row now. */
    readonly value?: Row
    readonly partition: Key
    readonly version: Version
  }

  // ── the resource ──
  export interface Resource<Row, D extends Depth = 1> {
    readonly name: string
    readonly data: Lens<Tree<Row, D>, Row, 'root', D>
    /** Several changes to ONE partition: one log entry, all or none. A field item takes no ttl. */
    batch(writes: readonly BatchWrite<Row>[]): Judged<Ack[]>
  }
  export type BatchWrite<Row> =
    | { key: readonly [Key, string | number, ...(string | number)[]]; value?: unknown; remove?: true; if?: Cond; readonly ttl?: Steer<OnRow> }
    | { key: readonly [Key]; value?: Row | Op; remove?: true; if?: Cond; ttl?: Duration }
  export function fero<Row, D extends Depth = 1>(name: string, opts?: { server?: true; depth?: D }): Promise<Resource<Row, D>>
  export namespace fero { function drop(name: string): Promise<void> }
  type Stop = Promise<{ readonly disconnect: () => void }>
  /** The record form. With { rows: true } the deriver folds its share of the source, so fn also gets the row. */
  export function derive<S>(source: Resource<S, any>, target: Resource<any, any>, fn: (e: Entry<S>) => void): Stop
  export function derive<S>(source: Resource<S, any>, target: Resource<any, any>,
    fn: (e: Entry<S>, r: { readonly row: S | undefined; readonly prev: S | undefined }) => void, opts: { rows: true }): Stop
}
```

```ts
// file: ok.ts — the new lines, as an app writes them. Each compiles; none runs
import { fero, op, derive } from 'fero'
type Item = { stock: number; price: number; tags: string[] }
type Msg = { text: string; at: number }
type Order = { user: string; cents: number; paid: boolean }
const shop = await fero<Item>('shop', { server: true })
const chat = await fero<Msg, 2>('chat', { server: true, depth: 2 })
const orders = await fero<Order>('orders'), totals = await fero<number>('totals', { server: true })

await chat.data.room1.set({ m1: { text: 'hi', at: 1 }, m2: { text: 'yo', at: 2 } })   // NEW: replace a room, one batch
await chat.data.room2.remove()                                                        // NEW: empty a room, one batch
await shop.data.w.set({ stock: 4, price: 9, tags: [] }, { ttl: '1h' })                // a ttl on a row, as before
await shop.data.w.stock.set(3, { if: { equals: 4 } })                                 // a field guard: this field only
await shop.data.w.stock.set((n) => (n ?? 0) - 1, { once: 'sale-7' })                  // set(fn) on a field: guarded by the field
await shop.batch([{ key: ['w'], value: op.merge({ price: 10 }), ttl: '1h' }, { key: ['w', 'stock'], value: 2 }])
shop.data.w.stock.connect((stock) => console.log(stock))                              // runs when stock changed, never for w.price
for await (const e of shop.data.w.changes({ from: -5 })) console.log(e.rec.key)       // the row's log: its field records too
chat.data.connect((rooms, c) => { for (const d of c.diff) console.log(d.partition, d.key, rooms[d.partition]) })  // NEW: d.partition
await derive(orders, totals, (e, { row, prev }) => {                                   // the record form with rows
  if (row?.paid && !prev?.paid) totals.data[row.user].set(op.incr(row.cents), { from: e })  // counts once: a field write too
}, { rows: true })
```

```ts
// file: wrong.ts — the wrong uses this page refuses. Each line under a @ts-expect-error must fail there, for the reason given
import { fero, derive } from 'fero'
type Item = { stock: number; price: number }
type Msg = { text: string; at: number }
const shop = await fero<Item>('shop', { server: true })
const chat = await fero<Msg, 2>('chat', { server: true, depth: 2 })
// @ts-expect-error 1: the root spans partitions, so no write there; the type's text names the way
shop.data.set({ w: { stock: 1, price: 2 } })
// @ts-expect-error 2: nor a remove of everything
chat.data.remove()
// @ts-expect-error 3: a ttl belongs to a row, not to a field
shop.data.w.stock.set(4, { ttl: '1m' })
// @ts-expect-error 4: so does a session lifetime
shop.data.w.stock.set(4, { while: 'session' })
// @ts-expect-error 5: a field item of a batch takes no ttl either
shop.batch([{ key: ['w', 'stock'], value: 4, ttl: '1m' }])
// @ts-expect-error 6: a field has no touch
shop.data.w.stock.touch()
// @ts-expect-error 7: a room is replaced by rows, not by one row
chat.data.room1.set({ text: 'hi', at: 1 })
// @ts-expect-error 8: a room write takes no ttl
chat.data.room1.set({}, { ttl: '1m' })
// @ts-expect-error 9: every value given to a room is a row: no undefined
chat.data.room1.set({ m1: undefined })
// @ts-expect-error 10: the row before and after come only with { rows: true }
derive(shop, shop, (e, { row }) => console.log(e.version, row))
// @ts-expect-error 11: the log stops at the row: a field has no changes(); the type's text names the row's lens
shop.data.w.stock.changes()
// @ts-expect-error 12: a count back names commits of one partition, so not on the root
shop.data.changes({ from: -5 })
// @ts-expect-error 13: a count back is negative
shop.data.w.changes({ from: 5 })
// @ts-expect-error 14: set(fn) brings its own guard: no if
shop.data.w.stock.set((n) => (n ?? 0) + 1, { if: { equals: 1 } })
```

```js check
// ANYPATH.md checker: every ```ts block of this page whose first line is "// file: <name>" goes into a fresh folder
// and must type-check. Then, in a copy where each @ts-expect-error is a plain comment, each line it marks must
// fail, and nothing else may (the strip proof). Self-contained: tsc on PATH is all it needs. Adapted from CONNECT.md's.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const blocks = [...readFileSync(process.argv[1], 'utf8').matchAll(/^```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^```$/gm)]
  .map(([, body, name]) => [name, body])
const want = ['fero.d.ts', 'ok.ts', 'wrong.ts']
const lost = want.filter((w) => !blocks.some(([name]) => name === w))
if (lost.length) { console.log('missing blocks:', lost); process.exit(1) }
const root = mkdtempSync(join(tmpdir(), 'fero-anypath-'))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022', 'dom'] }
const put = (dir, strip) => {
  const marked = []
  mkdirSync(dir)
  for (const [name, body] of blocks) {
    const lines = body.split('\n')
    if (strip) lines.forEach((l, i) => {
      if (l.includes('// @ts-expect-error')) { marked.push(`${name}:${i + 2}`); lines[i] = l.replace('@ts-expect-error', '(must fail below)') }
    })
    writeFileSync(join(dir, name), lines.join('\n'))
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: blocks.map(([name]) => name) }))
  return marked
}
put(join(root, 'page'), false)
execFileSync('tsc', ['-p', join(root, 'page', 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${blocks.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
const marked = put(join(root, 'stripped'), true)
let out = ''
try { execFileSync('tsc', ['-p', join(root, 'stripped', 'tsconfig.json')], { encoding: 'utf8' }) } catch (e) { out = e.stdout }
const errors = out.split('\n').filter((l) => /^\S+\(\d+,\d+\): error/.test(l))
const at = errors.map((l) => l.replace(/^(\S+?)\((\d+),\d+\).*$/, (_, f, n) => `${f.split('/').pop()}:${n}`))
for (const l of errors) console.log('  ' + l.split('/').pop().slice(0, 150))
const missed = marked.filter((m) => !at.includes(m)), stray = at.filter((a) => !marked.includes(a))
console.log(`stripped: ${marked.length} marked lines, ${marked.length - missed.length} fail at their own line, ${stray.length} errors elsewhere`)
if (!marked.length || missed.length || stray.length) { console.log({ missed, stray }); process.exit(1) }
```

Run from the repo root, with tsc on `PATH`:

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/ANYPATH.md)" docs/v5-space/ANYPATH.md
```

**Result, run here on 2026-11-20** (Node v22.22.0, TypeScript 6.0.2): `ok: 3 blocks type-check (tsc Version 6.0.2)`, then `stripped: 14 marked lines, 14 fail at their own line, 0 errors elsewhere`. Each stripped line fails for the reason its comment gives:

| wrong.ts line (item) | The wrong use | tsc |
|---|---|---|
| 8, 10 (1, 2) | a write or a remove at the root | TS2349: not callable; the type's text says the root spans partitions and names `fero.drop` |
| 12, 14 (3, 4) | `ttl` or `while` on a field write | TS2769: no overload matches; the type's text says a ttl and a lease belong to a row |
| 16 (5) | `ttl` on a field item of a `batch` | TS2322 against the union of items; without `ttl` the same item compiles (ok.ts) |
| 18 (6) | `touch` on a field | TS2339: no `touch` |
| 20, 22, 24 (7, 8, 9) | a room set to one row; a room write with `ttl`; a room row given as `undefined` | TS2322: a string is not a `Msg`; TS2353: no `ttl` there; TS2322: `undefined` is not a `Msg` |
| 26 (10) | the row and its `prev` without `{ rows: true }` | TS2345: "target signature provides too few arguments"; TS7006 and TS7031 on the same line, as its parameters lose their types |
| 28 (11) | `changes()` on a field | TS2349: not callable; the type's text says the log stops at the row and names the row's lens |
| 30, 32 (12, 13) | `-5` on the root; a positive count on a row | TS2322: the root takes a cursor or a time; TS2322: the type's text says a count back is negative |
| 34 (14) | `set(fn)` given its own `if` | TS2769: no overload matches, since `set(fn)` brings its own guard; TS7006 on the same line |

- **What the types cannot say** *(reasoned)*. That a link runs only when its value changed: a run-time rule, in the comments only. That a room write fits the size rule. That a field write's parent is an object, that an array step is an index, and that no key is `__proto__`: the leader checks them (P6), since a row's shape at run time is not its type.
- **Not checked here: that any of it runs.** What ran is E-58, on `data`'s engine and E-55's prototype store.
